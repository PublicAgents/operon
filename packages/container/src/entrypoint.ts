import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readWakeConfig, type WakeConfig } from "./config.js";
import { assertEnvClean, getAdapter, type HarnessAdapter } from "./adapters/index.js";
import { CommandError, runCapture, runStreaming } from "./exec.js";
import { runGitleaksOnFiles } from "./gitleaks.js";
import { sanitizeInboxFiles, sanitizeTranscript, type InboundMessage } from "./inbox.js";
import { excludeChassisWritten, verifyPresleep, type PresleepFailure } from "./presleep.js";
import { stageAndCollect, type StagedChanges } from "./staging.js";
import { Porch } from "./porch.js";
import { gitCredentialEnv, githubRepoUrl, hardenedGitFlags } from "./git-cred.js";

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
 * The privilege split: the entrypoint (and its porch) run as root and hold
 * the tokens; the mind session runs as the unprivileged "mind" user (fixed
 * uid in the Dockerfile). Same-uid isolation is not isolation: a same-uid
 * session could read the supervisor's /proc environment and argv. Outside
 * the image (local dev, tests) there is no root and no mind user, so the
 * split degrades to same-uid with a logged warning.
 */
const MIND_UID = 1001;
const MIND_GID = 1001;

function canDropPrivileges(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

function mindSpawnIds(): { uid?: number; gid?: number } {
  if (canDropPrivileges()) return { uid: MIND_UID, gid: MIND_GID };
  return {};
}

async function chownToMind(path: string): Promise<void> {
  if (!canDropPrivileges()) return;
  await runCapture("chown", ["-R", `${MIND_UID}:${MIND_GID}`, path]);
}

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
    "Your doors to the world are the operon CLI: run operon --help to see which are live this wake. " +
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

function mindHome(): string {
  return canDropPrivileges() ? "/home/mind" : (process.env.HOME ?? "/tmp");
}

/**
 * Pull any inbound email the agent received since last wake and drop each
 * message into inbox/ as a file the mind reads with the rest of its repo.
 * "Inbound content is data": these are plain records, never instructions.
 * Best-effort: an email door not wired, or a pull failure, must not fail
 * the wake.
 */
/**
 * Pull inbound email and write it to inbox/, returning the pulled ids so
 * the caller can ACK them only AFTER the wake's state (including these
 * files) is durably persisted. Acking at boot would lose messages if the
 * wake then fails or persistence is blocked.
 */
async function pullInbox(
  config: WakeConfig,
  chassisWritten: Map<string, string>,
  denylist: string[]
): Promise<string[]> {
  if (!config.emailUrl || !config.emailToken) return [];
  try {
    const response = await fetch(`${config.emailUrl}/gatekeeper/email/pull`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.emailToken}` },
      body: JSON.stringify({ agentId: config.agentId })
    });
    if (!response.ok) {
      log(`inbox pull failed: ${response.status}`);
      return [];
    }
    const { messages } = (await response.json()) as { messages: InboundMessage[] };
    if (!messages || messages.length === 0) return [];

    // Inbound mail is scanned and sanitized BEFORE it exists in the tree
    // (operon#24): a credential in a notification footer must cost the
    // mail a line, never the agent its persistence. If the scanner itself
    // cannot run, delivery is withheld this wake and the unacked mail
    // re-delivers next time.
    let files: { name: string; content: string }[];
    try {
      const result = await sanitizeInboxFiles(messages, denylist);
      files = result.files;
      for (const name of result.sanitized) {
        log(`inbox: sanitized ${name} at delivery (matched the secret scanner)`);
      }
    } catch (error) {
      log(`inbox delivery withheld, scanner unavailable: ${String(error).slice(0, 200)}`);
      return [];
    }

    const dir = join(STATE_DIR, "inbox");
    await mkdir(dir, { recursive: true });
    for (const file of files) {
      await writeFile(join(dir, file.name), file.content);
      chassisWritten.set(`inbox/${file.name}`, file.content);
    }
    await chownToMind(dir);
    log(`pulled ${messages.length} inbound email(s) into inbox/`);
    return messages.map(m => m.id);
  } catch (error) {
    log(`inbox pull error: ${String(error).slice(0, 200)}`);
    return [];
  }
}

/**
 * Ack pulled inbox messages: only called after the wake's state is durably
 * persisted, so the DO forgets a message only once it is committed to the
 * state repo. An interrupted or blocked wake re-delivers them next time
 * (writing the same inbox file again is idempotent).
 */
async function ackInbox(config: WakeConfig, ids: string[]): Promise<void> {
  if (!config.emailUrl || !config.emailToken || ids.length === 0) return;
  await fetch(`${config.emailUrl}/gatekeeper/email/ack`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.emailToken}` },
    body: JSON.stringify({ agentId: config.agentId, ids })
  }).catch(() => undefined);
}

/**
 * Pull the operator-channel transcript (Telegram /tell, broadcasts, and the
 * agent's own recent notifies) into operator/channel.md. Operator entries
 * are authenticated instructions, unlike inbox/ mail. The cursor advances
 * only via ackChannel after the wake's state persists, so [NEW] marks
 * survive a dead wake. Best-effort: a pull failure must not fail the wake.
 */
async function pullOperatorChannel(
  config: WakeConfig,
  chassisWritten: Map<string, string>,
  denylist: string[]
): Promise<number | null> {
  if (!config.notifyUrl || !config.notifyToken) return null;
  const base = config.notifyUrl.replace(/\/notify$/, "");
  try {
    const response = await fetch(`${base}/channel/pull`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.notifyToken}` },
      body: JSON.stringify({ agentId: config.agentId })
    });
    if (!response.ok) {
      log(`channel pull failed: ${response.status}`);
      return null;
    }
    const transcript = (await response.json()) as {
      entries: Array<{ id: number; at: string; from: string; agentId: string; text: string }>;
      newOperatorIds: number[];
      upTo: number;
    };
    if (!transcript.entries || transcript.entries.length === 0) return null;
    const newSet = new Set(transcript.newOperatorIds);
    const lines = transcript.entries.map(entry => {
      const who =
        entry.from === "operator"
          ? entry.agentId === "*"
            ? "OPERATOR (to all agents)"
            : "OPERATOR"
          : entry.agentId;
      const marker = newSet.has(entry.id) ? " [NEW]" : "";
      // The [#id] is the handle for `operon channel original <id>`: the
      // stored, unredacted entry, for when the write-time scan below
      // withheld a line of this transcript.
      return `- [#${entry.id}] ${entry.at} ${who}${marker}:\n  ${entry.text.replace(/\n/g, "\n  ")}`;
    });
    const composed =
      `# Operator channel\n\n` +
      `The recent conversation between you (${config.agentId}) and the operator ` +
      `over Telegram. Operator entries are authenticated instructions from your ` +
      `operator; entries marked [NEW] arrived since your last completed wake and ` +
      `may need action or an answer (reply with the operon notify command).\n\n` +
      `${lines.join("\n")}\n`;
    // Same scanners as inbound mail, for the same reason: this file is
    // chassis-written and presleep-excluded, so it must be provably clean
    // at write time (an operator can paste a credential into Telegram as
    // easily as a mail footer carries one). Scanner unavailable =
    // transcript skipped this wake (fail closed); the cursor does not
    // advance, so nothing is lost.
    let transcriptText: string;
    try {
      const sanitizedResult = await sanitizeTranscript(composed, denylist);
      transcriptText = sanitizedResult.content;
      if (sanitizedResult.sanitized) {
        log("operator channel: transcript sanitized at write (matched the secret scanner)");
      }
    } catch (error) {
      log(`operator channel skipped, scanner unavailable: ${String(error).slice(0, 200)}`);
      return null;
    }
    const dir = join(STATE_DIR, "operator");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "channel.md"), transcriptText);
    chassisWritten.set("operator/channel.md", transcriptText);
    await chownToMind(dir);
    log(`operator channel: ${transcript.entries.length} entries, ${newSet.size} new`);
    return transcript.upTo;
  } catch (error) {
    log(`channel pull error: ${String(error).slice(0, 200)}`);
    return null;
  }
}

/** Advance the channel cursor; only after the wake's state is persisted. */
async function ackChannel(config: WakeConfig, upTo: number | null): Promise<void> {
  if (!config.notifyUrl || !config.notifyToken || upTo === null) return;
  const base = config.notifyUrl.replace(/\/notify$/, "");
  await fetch(`${base}/channel/ack`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.notifyToken}` },
    body: JSON.stringify({ agentId: config.agentId, upTo })
  }).catch(() => undefined);
}

async function cloneState(config: WakeConfig): Promise<void> {
  await mkdir(WORKDIR, { recursive: true });
  // The ONE authenticated git op: a clone into an empty directory, run as
  // ROOT with a SHORT-LIVED READ-ONLY token in the git child's env (never
  // argv, never .git/config, and root's env is unreadable by the mind).
  // Safe precisely because the directory is empty at clone time: there is
  // no mind-controlled config, hook, or filter to abuse. Nothing is pushed
  // with this token; persistence goes through the Gatekeeper.
  await runCapture(
    "git",
    [...hardenedGitFlags(), "clone", githubRepoUrl(config.stateRepo), STATE_DIR],
    { env: gitCredentialEnv(sessionBaseEnv(), config.githubToken), timeoutMs: 5 * 60 * 1000 }
  );
  // Identity for any commits the mind chooses to make locally; harmless to
  // set as root on the fresh clone before it is handed over.
  await runCapture("git", [...hardenedGitFlags(), "config", "user.name", config.agentId], {
    cwd: STATE_DIR
  });
  await runCapture(
    "git",
    [...hardenedGitFlags(), "config", "user.email", `${config.agentId}@operon.invalid`],
    { cwd: STATE_DIR }
  );
  await chownToMind(WORKDIR);
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

/**
 * Every secret the container itself holds, auto-added to the sweep: the
 * operator's list covers what the operator knows about, this covers what
 * the wake was given. Neither should ever appear in state or a publish.
 */
function autoDenylist(config: WakeConfig): string[] {
  return [
    ...config.secretDenylist,
    config.mindCredential,
    config.githubToken,
    ...(config.notifyToken ? [config.notifyToken] : []),
    ...(config.publishToken ? [config.publishToken] : []),
    ...(config.persistToken ? [config.persistToken] : []),
    ...(config.prToken ? [config.prToken] : []),
    ...(config.emailToken ? [config.emailToken] : []),
    ...(config.tillToken ? [config.tillToken] : []),
    ...(config.spendToken ? [config.spendToken] : []),
    ...(config.vaultToken ? [config.vaultToken] : [])
  ];
}

/**
 * Pull every vaulted value for this agent into the wake's denylist: what
 * makes "a vaulted secret can never land in the repo or leave through a
 * door" mechanical. Values live only in this process's memory (the mind
 * retrieves one through the porch when it needs to USE it). If the vault
 * is wired but unreachable, the caller closes the vault doors for the
 * wake: values that cannot join the sweep must not be retrievable either.
 */
async function pullVaultValues(config: WakeConfig): Promise<{ values: string[]; ok: boolean }> {
  if (!config.vaultUrl || !config.vaultToken) return { values: [], ok: true };
  try {
    const response = await fetch(`${config.vaultUrl}/gatekeeper/vault/all`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.vaultToken}` },
      body: "{}"
    });
    if (!response.ok) throw new Error(`vault answered ${response.status}`);
    const { secrets } = (await response.json()) as {
      secrets: Array<{ label: string; value: string }>;
    };
    return { values: (secrets ?? []).map(secret => secret.value), ok: true };
  } catch (error) {
    log(`vault pull failed: ${String(error).slice(0, 200)}`);
    return { values: [], ok: false };
  }
}

async function runSession(
  adapter: HarnessAdapter,
  config: WakeConfig,
  model: string,
  degraded: boolean,
  porchUrl: string
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
  // when the mind ran long. OPERON_PORCH is a loopback address, not a
  // credential: the session's env still contains only its own mind
  // credential; every other token stays behind the porch.
  const ids = mindSpawnIds();
  if (!("uid" in ids)) {
    log("WARNING: not running as root; the session shares the supervisor's uid (dev mode only)");
  }
  return runStreaming(spec.command, [...spec.args, ...config.harnessExtraArgs], {
    cwd: STATE_DIR,
    env: {
      ...sessionBaseEnv(),
      ...spec.env,
      OPERON_PORCH: porchUrl,
      ...("uid" in ids ? { HOME: "/home/mind" } : {})
    },
    timeoutMs: budgetMinutes * 60_000,
    ...ids
  });
}

/**
 * Persist the wake's changes by handing the file DATA to the github
 * Gatekeeper, which commits them to the state repo via the Git Data API.
 * No push token and no credentialed git run in this container.
 */
async function persistState(
  config: WakeConfig,
  changes: StagedChanges
): Promise<void> {
  if (!config.persistUrl || !config.persistToken) {
    throw new Error("persist_not_wired: OPERON_PERSIST_URL/TOKEN missing");
  }
  const files = changes.changed
    .filter((file): file is { path: string; content: string } => typeof file.content === "string")
    .map(file => ({ path: file.path, contentBase64: Buffer.from(file.content, "utf8").toString("base64") }));
  if (files.length === 0 && changes.deleted.length === 0) {
    log("nothing to persist");
    return;
  }
  const response = await fetch(config.persistUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.persistToken}` },
    body: JSON.stringify({
      agentId: config.agentId,
      message: `wake ${config.wakeId}`,
      files,
      deletions: changes.deleted
    })
  });
  if (!response.ok) {
    throw new Error(`persist_failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
  log("state persisted through the github Gatekeeper");
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
  // Files the CHASSIS writes into the tree this wake, by path and exact
  // content: the presleep gitleaks pass excludes any staged file still
  // byte-identical to what the chassis wrote (operon#24), so delivered
  // mail and transcripts can never cost the agent its persistence. A file
  // the mind MODIFIES stops matching and is judged in full.
  const chassisWritten = new Map<string, string>();

  // ONE denylist array for the whole wake, shared by reference: the
  // delivery scan, the porch's outbound sweeps, and the presleep gate all
  // see the same list, and a value vaulted DURING the session (the porch
  // pushes it) is swept from that moment on.
  const vault = await pullVaultValues(config);
  if (!vault.ok) {
    log("vault unreachable: vault doors closed this wake, vaulted values missing from the sweep");
    config.vaultUrl = undefined;
    config.vaultToken = undefined;
  }
  const denylist = [...autoDenylist(config), ...vault.values];

  const pulledInboxIds = await pullInbox(config, chassisWritten, denylist);
  const channelUpTo = await pullOperatorChannel(config, chassisWritten, denylist);

  const verified = await verifyModel(adapter, config);
  const probedModel = verified.degraded
    ? `${verified.answer} (DEGRADED: pinned ${config.model} unavailable)`
    : verified.answer;

  // The porch opens before the session and closes after it: the wake's
  // doors exist exactly while a mind is awake to use them.
  const porch = new Porch({
    config,
    stateDir: STATE_DIR,
    denylist,
    log
  });
  const porchUrl = await porch.start();
  log(`${label}: porch open at ${porchUrl}`);

  log(`${label}: session starting (model ${verified.model})`);
  let sessionExit: number;
  try {
    sessionExit = await runSession(adapter, config, verified.model, verified.degraded, porchUrl);
  } finally {
    await porch.close();
  }
  log(`${label}: session exited ${sessionExit}`);

  // Change detection runs as the mind uid: a filter it triggers executes
  // unprivileged, so this needs no root and no clean mirror.
  const changes = await stageAndCollect(STATE_DIR, {
    env: { ...sessionBaseEnv(), HOME: mindHome() },
    ...mindSpawnIds()
  });
  const verification = verifyPresleep(changes.changed, denylist);

  // Generic layer: gitleaks catches secrets nobody listed, judged over the
  // AGENT-introduced changes only (chassis-delivered files were scanned at
  // delivery; unchanged history was scanned when it was pushed). A scanner
  // error fails closed as unscannable: an unscanned push must not happen.
  let gitleaksFailures: PresleepFailure[];
  try {
    const agentIntroduced = excludeChassisWritten(changes.changed, chassisWritten);
    gitleaksFailures = (await runGitleaksOnFiles(agentIntroduced)).map(finding => ({
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
      `${label}: PERSIST WITHHELD, presleep blocked it (${verification.failures
        .map(f => f.code)
        .join(", ")}). Model ${probedModel}. Investigate the container log; nothing was persisted.`
    );
    return 2;
  }

  await persistState(config, changes);
  // Inbox and channel are acked only now, after the state is durably
  // persisted: a wake that failed or was blocked re-delivers both.
  await ackInbox(config, pulledInboxIds);
  await ackChannel(config, channelUpTo);

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
