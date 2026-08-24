import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readWakeConfig, type WakeConfig } from "./config.js";
import { assertEnvClean, getAdapter, type HarnessAdapter } from "./adapters/index.js";
import { CommandError, runCapture, runStreaming } from "./exec.js";
import { runGitleaks } from "./gitleaks.js";
import { verifyPresleep, type PresleepFailure } from "./presleep.js";
import { stageAndCollect } from "./staging.js";

/**
 * One wake, start to finish. Every failure path still notifies: silence is
 * the one prohibited outcome (chassis spec 5.2).
 *
 * Exit codes: 0 clean; 1 wake failed (session error or journal untouched);
 * 2 presleep found a secret and the push was withheld.
 */

const WORKDIR = "/tmp/operon-wake";
const STATE_DIR = join(WORKDIR, "state");

const WAKE_PROMPT =
  "Read CHARTER.md and the rest of this repository: it is your memory, and this is one wake of your life. " +
  "Act as you see fit, then record what you did and decided by appending to JOURNAL.md before you finish. " +
  "When your journal entry is written, stop.";

function log(message: string): void {
  console.log(`[operon] ${new Date().toISOString()} ${message}`);
}

// As PID 1, node ignores SIGTERM by kernel default while children in the
// process group still receive it: a platform stop would kill the session
// silently under us. Logging the signal makes a platform-initiated stop
// distinguishable from a harness crash in the wake log; the session's
// nonzero exit then flows through the normal failure path and notify.
process.on("SIGTERM", () => {
  log("SIGTERM received: the platform is stopping this container");
});

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

async function commitAndPush(config: WakeConfig, hasStaged: boolean): Promise<void> {
  if (!hasStaged) {
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

  const staged = await stageAndCollect(STATE_DIR, sessionBaseEnv());
  // The container auto-denylists every secret it itself holds: the
  // operator's list covers what the operator knows about, this covers what
  // the wake was given. Neither should ever appear in state.
  const denylist = [
    ...config.secretDenylist,
    config.mindCredential,
    config.githubToken,
    ...(config.notifyToken ? [config.notifyToken] : [])
  ];
  const verification = verifyPresleep(staged, denylist);

  // Generic layer: gitleaks catches secrets nobody listed. A scanner error
  // fails closed as unscannable: an unscanned push must not happen.
  let gitleaksFailures: PresleepFailure[];
  try {
    gitleaksFailures = (await runGitleaks(STATE_DIR)).map(finding => ({
      code: "secret_found" as const,
      detail: `gitleaks ${finding.ruleId} in ${finding.file}:${finding.startLine}`
    }));
  } catch (error) {
    gitleaksFailures = [
      {
        code: "unscannable",
        detail: `gitleaks failed to run: ${String(error).slice(0, 300)}`
      }
    ];
  }
  verification.failures.push(...gitleaksFailures);
  if (gitleaksFailures.length > 0) {
    verification.ok = false;
    verification.blockPush = true;
  }

  for (const failure of verification.failures) {
    log(`presleep ${failure.code}: ${failure.detail}`);
  }

  if (verification.blockPush) {
    await notify(
      config,
      `${label}: PUSH WITHHELD, presleep blocked the push (${verification.failures
        .map(f => f.code)
        .join(", ")}). Model ${probedModel}. Investigate the container log; nothing was pushed.`
    );
    return 2;
  }

  await commitAndPush(config, staged.length > 0);

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
