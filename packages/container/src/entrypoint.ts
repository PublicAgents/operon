import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readWakeConfig, type WakeConfig } from "./config.js";
import { assertEnvClean, getAdapter, type HarnessAdapter } from "./adapters/index.js";
import { CommandError, runCapture, runStreaming } from "./exec.js";
import { verifyPresleep, type ChangedFile } from "./presleep.js";

/**
 * One wake, start to finish. Every failure path still notifies: silence is
 * the one prohibited outcome (chassis spec 5.2).
 *
 * Exit codes: 0 clean; 1 wake failed (session error or journal untouched);
 * 2 presleep found a secret and the push was withheld.
 */

const WORKDIR = "/tmp/operon-wake";
const STATE_DIR = join(WORKDIR, "state");
const MAX_SCANNED_FILE_BYTES = 512 * 1024;

const WAKE_PROMPT =
  "Read CHARTER.md and the rest of this repository: it is your memory, and this is one wake of your life. " +
  "Act as you see fit, then record what you did and decided by appending to JOURNAL.md before you finish. " +
  "When your journal entry is written, stop.";

function log(message: string): void {
  console.log(`[operon] ${new Date().toISOString()} ${message}`);
}

/** Minimal child env: the mind session sees its credential and nothing else of ours. */
function sessionBaseEnv(): Record<string, string> {
  const passthrough = ["PATH", "HOME", "TERM", "LANG"];
  const env: Record<string, string> = {};
  for (const name of passthrough) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

async function git(args: string[], env?: Record<string, string>): Promise<string> {
  const { stdout } = await runCapture("git", args, {
    cwd: STATE_DIR,
    env: { ...sessionBaseEnv(), ...env }
  });
  return stdout;
}

async function cloneState(config: WakeConfig): Promise<void> {
  await mkdir(WORKDIR, { recursive: true });
  const url = `https://x-access-token:${config.githubToken}@github.com/${config.stateRepo}.git`;
  await runCapture("git", ["clone", url, STATE_DIR], { env: sessionBaseEnv() });
  await git(["config", "user.name", config.agentId]);
  await git(["config", "user.email", `${config.agentId}@operon.invalid`]);
}

async function verifyModel(adapter: HarnessAdapter, config: WakeConfig): Promise<string> {
  const spec = adapter.probe(config.model, config.mindCredential);
  try {
    const { stdout } = await runCapture(spec.command, spec.args, {
      cwd: STATE_DIR,
      env: { ...sessionBaseEnv(), ...spec.env },
      timeoutMs: 5 * 60 * 1000
    });
    const answer = stdout.trim().slice(0, 200);
    log(`model probe answered: ${answer}`);
    return answer;
  } catch (error) {
    throw new Error(`model_probe_failed: ${String(error)}`, { cause: error });
  }
}

async function runSession(adapter: HarnessAdapter, config: WakeConfig): Promise<number> {
  const spec = adapter.session(
    WAKE_PROMPT,
    config.model,
    config.mindCredential,
    config.fallbackModel
  );
  return runStreaming(spec.command, [...spec.args, ...config.harnessExtraArgs], {
    cwd: STATE_DIR,
    env: { ...sessionBaseEnv(), ...spec.env }
  });
}

async function changedFiles(): Promise<ChangedFile[]> {
  const status = await git(["status", "--porcelain"]);
  const paths = status
    .split("\n")
    .map(line => line.slice(3).trim())
    .filter(path => path.length > 0);
  const files: ChangedFile[] = [];
  for (const path of paths) {
    try {
      const buffer = await readFile(join(STATE_DIR, path));
      files.push({
        path,
        content: buffer.subarray(0, MAX_SCANNED_FILE_BYTES).toString("utf8")
      });
    } catch {
      // Deleted files have no content to scan; the path itself still counts
      // for the journal check via its presence in the change set.
      files.push({ path, content: "" });
    }
  }
  return files;
}

async function pushState(config: WakeConfig): Promise<void> {
  await git(["add", "-A"]);
  const staged = await git(["status", "--porcelain"]);
  if (staged.trim().length === 0) {
    log("no changes to push");
    return;
  }
  await git(["commit", "-m", `wake ${config.wakeId}`]);
  await git(["push", "origin", "HEAD"]);
  log("state pushed");
}

async function notify(config: WakeConfig, text: string): Promise<void> {
  if (!config.notifyUrl || !config.notifyToken) return;
  try {
    const response = await fetch(config.notifyUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.notifyToken}`
      },
      body: JSON.stringify({ text })
    });
    if (!response.ok) log(`notify failed: ${response.status}`);
  } catch (error) {
    log(`notify failed: ${String(error)}`);
  }
}

async function main(): Promise<number> {
  const config = readWakeConfig(process.env);
  const label = `[${config.agentId}] wake ${config.wakeId} (${config.trigger})`;
  const adapter = getAdapter(config.harness);
  assertEnvClean(adapter, process.env);

  log(`${label}: cloning ${config.stateRepo}`);
  await cloneState(config);

  const probedModel = await verifyModel(adapter, config);

  log(`${label}: session starting (model ${config.model})`);
  const sessionExit = await runSession(adapter, config);
  log(`${label}: session exited ${sessionExit}`);

  const verification = verifyPresleep(await changedFiles(), config.secretDenylist);
  for (const failure of verification.failures) {
    log(`presleep ${failure.code}: ${failure.detail}`);
  }

  if (verification.blockPush) {
    await notify(
      config,
      `${label}: PUSH WITHHELD, presleep found a denylisted secret in changed files. Model ${probedModel}. Investigate the container log.`
    );
    return 2;
  }

  await pushState(config);

  const failed = sessionExit !== 0 || !verification.ok;
  const summary = failed
    ? `${label}: finished with problems (session exit ${sessionExit}${
        verification.ok ? "" : `; ${verification.failures.map(f => f.code).join(", ")}`
      }). Model ${probedModel}.`
    : `${label}: completed. Model ${probedModel}.`;
  await notify(config, summary);
  return failed ? 1 : 0;
}

main()
  .then(code => process.exit(code))
  .catch(async error => {
    const detail = error instanceof CommandError ? error.message : String(error);
    log(`wake failed: ${detail}`);
    // Best-effort notify even when config itself failed to parse.
    try {
      const config = readWakeConfig(process.env);
      await notify(config, `[${config.agentId}] wake ${config.wakeId} crashed: ${detail.slice(0, 500)}`);
    } catch {
      // Config unreadable; the scheduler's monitor() rejection still records the failure.
    }
    process.exit(1);
  });
