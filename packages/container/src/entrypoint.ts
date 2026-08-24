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

/**
 * Minutes reserved between the session's end and the wake's hard wall, for
 * presleep verification, commit, push, and notify. The session budget is
 * the wall minus this, so a wake that runs long is stopped while its work
 * can still be verified and pushed, instead of dying at the wall with
 * everything unpushed.
 */
const WRAP_UP_MARGIN_MINUTES = 10;
const MIN_SESSION_MINUTES = 5;

function sessionBudgetMinutes(maxWakeMinutes: number): number {
  return Math.max(MIN_SESSION_MINUTES, maxWakeMinutes - WRAP_UP_MARGIN_MINUTES);
}

function wakePrompt(budgetMinutes: number): string {
  return (
    "Read CHARTER.md and the rest of this repository: it is your memory, and this is one wake of your life. " +
    `You have about ${budgetMinutes} minutes in this session; pace your work so you append your journal entry to JOURNAL.md before the time is up, because an unjournaled wake did not happen as far as your memory is concerned. ` +
    "Act as you see fit, and when your journal entry is written, stop."
  );
}

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

interface VerifiedModel {
  /** The model the session should actually run on. */
  model: string;
  /** What the probe reported. */
  answer: string;
  /** True when the pinned model failed and the fallback answered instead. */
  degraded: boolean;
}

async function probe(
  adapter: HarnessAdapter,
  model: string,
  credential: string
): Promise<string> {
  const spec = adapter.probe(model, credential);
  const { stdout } = await runCapture(spec.command, spec.args, {
    cwd: STATE_DIR,
    env: { ...sessionBaseEnv(), ...spec.env },
    timeoutMs: 5 * 60 * 1000
  });
  return stdout.trim().slice(0, 200);
}

/**
 * Verify the pinned model answers; if it does not and a fallback is
 * pinned, verify the fallback and run the wake degraded on it. A degraded
 * wake beats a missed wake, and the degradation is stamped into the log
 * and the end-of-wake summary rather than happening silently.
 */
async function verifyModel(
  adapter: HarnessAdapter,
  config: WakeConfig
): Promise<VerifiedModel> {
  try {
    const answer = await probe(adapter, config.model, config.mindCredential);
    log(`model probe answered: ${answer}`);
    return { model: config.model, answer, degraded: false };
  } catch (primaryError) {
    if (!config.fallbackModel) {
      throw new Error(`model_probe_failed: ${String(primaryError)}`, {
        cause: primaryError
      });
    }
    log(
      `pinned model ${config.model} failed to answer (${String(primaryError).slice(0, 300)}); probing fallback ${config.fallbackModel}`
    );
    try {
      const answer = await probe(adapter, config.fallbackModel, config.mindCredential);
      log(`fallback model probe answered: ${answer} (wake runs DEGRADED)`);
      return { model: config.fallbackModel, answer, degraded: true };
    } catch (fallbackError) {
      throw new Error(
        `model_probe_failed: pinned ${config.model}: ${String(primaryError).slice(0, 300)}; fallback ${config.fallbackModel}: ${String(fallbackError).slice(0, 300)}`,
        { cause: fallbackError }
      );
    }
  }
}

async function runSession(
  adapter: HarnessAdapter,
  config: WakeConfig,
  model: string,
  degraded: boolean
): Promise<number> {
  const budgetMinutes = sessionBudgetMinutes(config.maxWakeMinutes);
  const spec = adapter.session(
    wakePrompt(budgetMinutes),
    model,
    config.mindCredential,
    // When already running on the fallback there is nothing further to
    // fall back to; passing it again would be a lie in the flags.
    degraded ? undefined : config.fallbackModel
  );
  // The timeout enforces the budget the prompt promised: past it the
  // session receives SIGTERM while the entrypoint still has the wrap-up
  // margin to verify, push, and notify, so the wake's work survives even
  // when the mind ran long.
  return runStreaming(spec.command, [...spec.args, ...config.harnessExtraArgs], {
    cwd: STATE_DIR,
    env: { ...sessionBaseEnv(), ...spec.env },
    timeoutMs: budgetMinutes * 60_000
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

  const verified = await verifyModel(adapter, config);
  const probedModel = verified.degraded
    ? `${verified.answer} (DEGRADED: pinned ${config.model} unavailable)`
    : verified.answer;

  log(`${label}: session starting (model ${verified.model})`);
  const sessionExit = await runSession(adapter, config, verified.model, verified.degraded);
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
