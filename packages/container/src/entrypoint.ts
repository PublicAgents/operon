import { existsSync } from "node:fs";
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { webMcpConfigJson } from "./web-mcp.js";
import { join } from "node:path";
import { readWakeConfig, type WakeConfig } from "./config.js";
import { assertEnvClean, getAdapter, type HarnessAdapter } from "./adapters/index.js";
import { CommandError, runCapture, runStreaming } from "./exec.js";
import { runGitleaksOnFiles } from "./gitleaks.js";
import { sanitizeInboxFiles, sanitizeTranscript, type InboundMessage } from "./inbox.js";
import { excludeChassisWritten, verifyPresleep, type PresleepFailure } from "./presleep.js";
import { stageAndCollect, type StagedChanges } from "./staging.js";
import { TranscriptShipper } from "./transcript.js";
import { Porch } from "./porch.js";
import type { AskLimits } from "./skills.js";
import { countNewAsks, type AskDelivered } from "./asks-delivery.js";
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

/**
 * The stamp a journal entry must carry to count as THIS wake's entry:
 * the journal guard checks for it verbatim, so the prompt and the
 * guard must agree on the exact string.
 */
export function wakeStamp(wakeId: string): string {
  return `wake ${wakeId.slice(0, 8)}`;
}

function wakePrompt(budgetMinutes: number, stamp: string): string {
  return (
    "Read CHARTER.md and the rest of this repository: it is your memory, and this is one wake of your life. " +
    `You have about ${budgetMinutes} minutes in this session; pace your work so you append your journal entry to JOURNAL.md before the time is up, because an unjournaled wake did not happen as far as your memory is concerned. ` +
    `Include the exact text "${stamp}" in that entry's markdown heading line (a line starting with #): it is this wake's stamp, and the chassis verifies it before letting the session end. ` +
    "Your doors to the world are the operon CLI: run operon --help FIRST, every wake, because the guide is rendered live by the chassis and changes as your doors do; what it says supersedes anything your notes remember about the CLI. " +
    "New input does not only arrive at wake start: operon pull fetches email, DMs, and operator messages that arrive MID-WAKE (a verification link or an operator answer is one pull away, not one wake away). " +
    "A wake is a SINGLE uninterrupted turn: you cannot sleep and resume, and there is no later continuation of THIS session. If you background a wait or a sleep intending to come back, the session simply ends while you are away and everything after it is lost. So never defer your journal entry to after a sleep or a timer: if something is not ready yet (a rate limit, a cooldown, a scheduled time), record where it stands in your journal and leave it for a FUTURE wake to pick up. ALWAYS write your JOURNAL.md entry before you stop, sleep, or wait on anything. " +
    "Act as you see fit, and when your journal entry is written, stop."
  );
}

/**
 * Everything the entrypoint says is teed into the wake transcript once a
 * shipper exists (set in main); the container's own stdout is unchanged.
 */
let transcriptTee: ((text: string) => void) | null = null;
let activeShipper: TranscriptShipper | null = null;

function log(message: string): void {
  const line = `[operon] ${new Date().toISOString()} ${message}`;
  console.log(line);
  transcriptTee?.(`${line}\n`);
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
  // Node uses its own CA bundle, not the system store, so the egress
  // audit's TLS interception (spec 0004 section 8) is only trusted by the
  // mind's node processes when this points at the platform CA. Set only
  // when the CA is actually present (below); harmless otherwise.
  if (process.env.NODE_EXTRA_CA_CERTS) env.NODE_EXTRA_CA_CERTS = process.env.NODE_EXTRA_CA_CERTS;
  return env;
}

/** The CA the container platform uses to intercept (and audit) egress. */
const CONTAINERS_CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

/**
 * Trust the platform's egress-interception CA so HTTPS keeps working while
 * every request is audited (spec 0004 section 8). The cert is placed by
 * the platform at container start, so this runs at startup, not build:
 * added to the system store for curl/git, and exposed via
 * NODE_EXTRA_CA_CERTS for node. Best-effort: if the CA is absent (no
 * interception configured) the container runs exactly as before.
 */
async function trustEgressCa(): Promise<void> {
  if (!existsSync(CONTAINERS_CA)) return;
  try {
    await mkdir("/usr/local/share/ca-certificates", { recursive: true });
    await copyFile(CONTAINERS_CA, "/usr/local/share/ca-certificates/cloudflare-containers-ca.crt");
    // NODE_EXTRA_CA_CERTS trusts the CA for node directly (no rebuild of a
    // store needed); set it unconditionally so node clients are covered.
    process.env.NODE_EXTRA_CA_CERTS = CONTAINERS_CA;
    // The system store (curl, git) needs update-ca-certificates to
    // succeed; only claim it is trusted for those clients if it did.
    try {
      await runCapture("update-ca-certificates", [], {});
      log("egress audit: interception CA trusted (system store + node)");
    } catch (error) {
      log(
        "egress audit: node trusts the interception CA, but update-ca-certificates " +
          `failed, so curl/git may not: ${String(error).slice(0, 160)}`
      );
    }
  } catch (error) {
    log(`egress audit: could not trust the interception CA: ${String(error).slice(0, 200)}`);
  }
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
 * Pull inbound X DMs into inbox/ beside the mail, same doctrine
 * throughout: data not instructions, sanitized at delivery, acked only
 * after the wake's state persists so nothing is lost to a dead wake.
 * Best-effort: no X doors, or a pull failure, must not fail the wake.
 */
async function pullXDms(
  config: WakeConfig,
  chassisWritten: Map<string, string>,
  denylist: string[]
): Promise<string | null> {
  if (!config.xUrl || !config.xToken) return null;
  try {
    const response = await fetch(`${config.xUrl}/gatekeeper/x/dm/pull`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.xToken}` },
      body: "{}"
    });
    if (!response.ok) {
      log(`x dm pull failed: ${response.status}`);
      return null;
    }
    const { messages, upTo } = (await response.json()) as {
      messages: InboundMessage[];
      upTo: string | null;
    };
    if (!messages || messages.length === 0) return null;

    let files: { name: string; content: string }[];
    try {
      const result = await sanitizeInboxFiles(messages, denylist);
      files = result.files;
      for (const name of result.sanitized) {
        log(`x dm: sanitized ${name} at delivery (matched the secret scanner)`);
      }
    } catch (error) {
      log(`x dm delivery withheld, scanner unavailable: ${String(error).slice(0, 200)}`);
      return null;
    }
    const dir = join(STATE_DIR, "inbox");
    await mkdir(dir, { recursive: true });
    for (const file of files) {
      await writeFile(join(dir, file.name), file.content);
      chassisWritten.set(`inbox/${file.name}`, file.content);
    }
    await chownToMind(dir);
    log(`pulled ${messages.length} X DM(s) into inbox/`);
    return upTo;
  } catch (error) {
    log(`x dm pull error: ${String(error).slice(0, 200)}`);
    return null;
  }
}

/** Advance the DM cursor; only after the wake's state is persisted. */
async function ackXDms(config: WakeConfig, upTo: string | null): Promise<void> {
  if (!config.xUrl || !config.xToken || upTo === null) return;
  await fetch(`${config.xUrl}/gatekeeper/x/dm/ack`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.xToken}` },
    body: JSON.stringify({ upTo })
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

/**
 * Pull the operator's activity on this agent's asks (spec 0007 §6) into
 * operator/asks.md. Pointed, not a bulk dump: the ask id, its title, its
 * state, and the operator's own words, so the wake knows what to act on
 * and can read the rest with `operon ask list`.
 *
 * Delivery is AT-LEAST-ONCE: this returns the delivery token naming
 * exactly what it was handed, and the token is acked only after the
 * wake's state is persisted. A dead wake therefore re-delivers an
 * answer rather than swallowing it. Best effort throughout: a door that
 * is down must not fail the wake.
 */
async function pullAsks(
  config: WakeConfig,
  chassisWritten: Map<string, string>,
  denylist: string[]
): Promise<{ deliveryId: string | null; delivered: AskDelivered[]; limits?: AskLimits }> {
  if (!config.asksUrl || !config.asksToken) return { deliveryId: null, delivered: [] };
  try {
    const response = await fetch(`${config.asksUrl}/gatekeeper/asks/unread`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.asksToken}` },
      body: "{}"
    });
    if (!response.ok) {
      log(`asks pull failed: ${response.status}`);
      return { deliveryId: null, delivered: [] };
    }
    const delivery = (await response.json()) as {
      deliveryId: string;
      unread: Array<{
        id: string;
        title: string;
        state: string;
        entries: Array<{ seq: number; at: string; kind: string; state?: string; text?: string }>;
      }>;
      limits?: AskLimits;
    };
    const rows = delivery.unread ?? [];
    if (rows.length === 0) return { deliveryId: null, delivered: [], limits: delivery.limits };
    const sections = rows.map(row => {
      const lines = row.entries.map(entry =>
        entry.kind === "state_change"
          ? `  - ${entry.at} OPERATOR marked it ${entry.state}${entry.text ? `:\n    ${entry.text.replace(/\n/g, "\n    ")}` : ""}`
          : `  - ${entry.at} OPERATOR:\n    ${(entry.text ?? "").replace(/\n/g, "\n    ")}`
      );
      return `## ${row.id} (${row.state}): ${row.title}\n\n${lines.join("\n")}`;
    });
    const composed =
      `# Answers on your asks\n\n` +
      `Your operator acted on ${rows.length} of your asks since you last read ` +
      `them. These are authenticated instructions from your operator, like ` +
      `operator/channel.md. Act on them, then close or reply with ` +
      `\`operon ask close <id>\` / \`operon ask reply <id>\`; ` +
      `\`operon ask list\` shows each ask's full thread.\n\n` +
      `${sections.join("\n\n")}\n`;
    // Same write-time scan as mail and the channel transcript, for the
    // same reason: this file is chassis-written and presleep-excluded,
    // so it must be provably clean when written. Scanner unavailable =
    // skipped, and the token is not acked, so nothing is lost.
    let text: string;
    try {
      const sanitized = await sanitizeTranscript(composed, denylist);
      text = sanitized.content;
      if (sanitized.sanitized) log("asks: delivery sanitized at write (matched the secret scanner)");
    } catch (error) {
      log(`asks delivery skipped, scanner unavailable: ${String(error).slice(0, 200)}`);
      return { deliveryId: null, delivered: [], limits: delivery.limits };
    }
    const dir = join(STATE_DIR, "operator");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "asks.md"), text);
    chassisWritten.set("operator/asks.md", text);
    await chownToMind(dir);
    log(`asks: ${rows.length} with new operator activity`);
    return {
      deliveryId: delivery.deliveryId,
      delivered: rows.map(row => ({
        id: row.id,
        throughSeq: row.entries[row.entries.length - 1]?.seq ?? 0
      })),
      limits: delivery.limits
    };
  } catch (error) {
    log(`asks pull error: ${String(error).slice(0, 200)}`);
    return { deliveryId: null, delivered: [] };
  }
}

/** Ack an asks delivery by its token; only after the state is persisted. */
async function ackAsks(config: WakeConfig, deliveryId: string | null): Promise<void> {
  if (!config.asksUrl || !config.asksToken || deliveryId === null) return;
  await fetch(`${config.asksUrl}/gatekeeper/asks/ack`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.asksToken}` },
    body: JSON.stringify({ deliveryId })
  }).catch(() => undefined);
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

async function cloneState(config: WakeConfig): Promise<string> {
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
  // The wake-start commit: presleep staging diffs against THIS, not HEAD,
  // so a mind that commits locally cannot hide its work from persistence.
  // Read BEFORE the chown below: after it the repo belongs to the mind
  // uid and a root git refuses it as dubious ownership (exit 128).
  const { stdout } = await runCapture("git", [...hardenedGitFlags(), "rev-parse", "HEAD"], {
    cwd: STATE_DIR
  });
  await chownToMind(WORKDIR);
  return stdout.trim();
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
    ...(config.vaultToken ? [config.vaultToken] : []),
    ...(config.chronicleToken ? [config.chronicleToken] : []),
    ...(config.xToken ? [config.xToken] : [])
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
    wakePrompt(budgetMinutes, wakeStamp(config.wakeId)),
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
  // The web door (spec 0004): when it is wired, the harness gets the
  // standard browser MCP server pointed at the porch relay, so the mind
  // browses with its own ecosystem's tools and every frame still passes
  // the relay's policy. No credential is written: the endpoint is
  // loopback and the nonce stays with the porch.
  if (config.webUrl && config.webToken) {
    try {
      await writeFile(join(STATE_DIR, ".mcp.json"), webMcpConfigJson(porchUrl), "utf8");
      log("web door: browser MCP staged (.mcp.json)");
    } catch (error) {
      log(`web door: could not stage browser MCP: ${String(error).slice(0, 200)}`);
    }
  }

  // Mid-wake input awareness for claude-code minds: a PostToolUse hook
  // (pull-hook.ts) whose stdout the harness injects into the running
  // session, so new mail, DMs, and operator messages reach the mind
  // WHILE it works instead of only when it thinks to pull. Written to
  // the mind's user settings; a state repo's own project settings are a
  // different scope and still load. Best-effort: a wake without the
  // hook is the old behavior, not a failure.
  if (adapter.id === "claude-code") {
    try {
      // The journal guard's baseline: JOURNAL.md as the session begins,
      // so the Stop hook can tell an appended entry (wake-start content
      // preserved, new bytes around it) from an untouched journal or a
      // rewrite masquerading as one (wake 23 stopped cleanly with its
      // journal unwritten).
      await writeFile("/tmp/operon-journal-stamp", wakeStamp(config.wakeId), "utf8");
      try {
        await copyFile(join(STATE_DIR, "JOURNAL.md"), "/tmp/operon-journal-baseline.md");
      } catch {
        // No journal file yet (a brand-new agent): the guard yields on
        // a missing baseline, and presleep still judges the wake.
      }
      const settingsDir = join(mindHome(), ".claude");
      await mkdir(settingsDir, { recursive: true });
      await writeFile(
        join(settingsDir, "settings.json"),
        JSON.stringify(
          {
            hooks: {
              PostToolUse: [
                {
                  matcher: "*",
                  hooks: [
                    { type: "command", command: "node /opt/operon/pull-hook.js", timeout: 15 }
                  ]
                }
              ],
              Stop: [
                {
                  hooks: [
                    { type: "command", command: "node /opt/operon/journal-guard.js", timeout: 10 }
                  ]
                }
              ]
            }
          },
          null,
          2
        ),
        "utf8"
      );
      await chownToMind(settingsDir);
      log("mid-wake input notifier staged (PostToolUse hook); journal guard staged (Stop hook)");
    } catch (error) {
      log(`could not stage the input notifier hook: ${String(error).slice(0, 200)}`);
    }
  }

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
      // The pull hook tells the mind how much of its budget remains and
      // warns when the journal deadline nears (the prompt's promise made
      // checkable mid-wake). Epoch ms; not a credential.
      OPERON_SESSION_DEADLINE: String(Date.now() + budgetMinutes * 60_000),
      ...("uid" in ids ? { HOME: "/home/mind" } : {})
    },
    timeoutMs: budgetMinutes * 60_000,
    onOutput: text => transcriptTee?.(text),
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
  // Before any network use, trust the egress-audit interception CA so the
  // clone, npm, and the mind's own requests keep working under audit.
  await trustEgressCa();
  const adapter = getAdapter(config.harness);
  assertEnvClean(adapter, process.env);

  log(`${label}: cloning ${config.stateRepo}`);
  const baseSha = await cloneState(config);
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

  // The wake transcript: everything said from here on (entrypoint lines
  // and the session's own output) ships to the chronicle in redacted
  // chunks, tailable live and mirrored durably. Created only after the
  // denylist is assembled, because the denylist IS the redaction.
  if (config.chronicleUrl && config.chronicleToken) {
    activeShipper = new TranscriptShipper({
      url: config.chronicleUrl,
      token: config.chronicleToken,
      wakeId: config.wakeId,
      agentId: config.agentId,
      denylist,
      log: message => console.log(`[operon] ${message}`)
    });
    transcriptTee = text => activeShipper?.write(text);
    activeShipper.ready();
    log(`${label}: transcript shipping to the chronicle`);
  }

  // Delivery bookkeeping shared between the wake-start pulls and any
  // mid-wake `operon pull` (the porch's pullFresh below): acks always
  // happen once, after persist, over everything delivered this wake.
  const ackState = {
    inboxIds: new Set<string>(),
    dmUpTo: null as string | null,
    channelUpTo: null as number | null,
    // The LATEST asks delivery token. Each delivery names every unread
    // entry at the time it was handed out, so a later token covers an
    // earlier one and acking the latest is exactly right; acking an
    // older one after it would move nothing backwards either.
    asksDelivery: null as string | null
  };
  for (const id of await pullInbox(config, chassisWritten, denylist)) {
    ackState.inboxIds.add(id);
  }
  ackState.dmUpTo = await pullXDms(config, chassisWritten, denylist);
  ackState.channelUpTo = await pullOperatorChannel(config, chassisWritten, denylist);
  const asksAtStart = await pullAsks(config, chassisWritten, denylist);
  if (asksAtStart.deliveryId) ackState.asksDelivery = asksAtStart.deliveryId;
  // What the mind has already been shown (see asks-delivery.ts). Seeded
  // with the wake-start delivery, which is not news that arrived "while
  // you worked".
  const shownAsks = new Map<string, number>();
  countNewAsks(asksAtStart.delivered, shownAsks);

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
    log,
    // This colony's real ask ceilings, straight from the Gatekeeper that
    // enforces them, so `operon --help` states numbers rather than
    // guesses at them (undefined when that door is closed).
    askLimits: asksAtStart.limits,
    // Mid-wake input refresh (operon pull): the same pulls and the same
    // ack bookkeeping as wake start. Unacked messages re-deliver (the
    // door forgets nothing until the post-persist ack), so re-writing an
    // inbox file is idempotent and only genuinely NEW ids count.
    // Concurrent pulls SHARE one run; its freshness lands in the
    // unannounced buffer and is DRAINED at response time by the porch,
    // only for a caller that is still connected. One delivery is
    // announced exactly once, to whoever can actually hear it: not
    // twice to overlapping callers, and not into the void when the
    // initiator (say, the hook hitting its timeout) aborted.
    pullFresh() {
      if (!inFlightPull) {
        inFlightPull = doPullFresh().finally(() => {
          inFlightPull = null;
        });
      }
      return inFlightPull;
    },
    drainAnnouncements() {
      const out = { ...unannounced };
      unannounced.mail = 0;
      unannounced.dms = 0;
      unannounced.channel = false;
      unannounced.asks = 0;
      return out;
    },
    recreditAnnouncements(counts) {
      unannounced.mail += counts.mail;
      unannounced.dms += counts.dms;
      unannounced.channel = unannounced.channel || counts.channel;
      unannounced.asks += counts.asks;
    }
  });
  let inFlightPull: Promise<void> | null = null;
  const unannounced = { mail: 0, dms: 0, channel: false, asks: 0 };
  async function doPullFresh(): Promise<void> {
    const before = ackState.inboxIds.size;
    for (const id of await pullInbox(config, chassisWritten, denylist)) {
      ackState.inboxIds.add(id);
    }
    unannounced.mail += ackState.inboxIds.size - before;
    const dmBefore = ackState.dmUpTo;
    const dmUpTo = await pullXDms(config, chassisWritten, denylist);
    if (dmUpTo !== null) {
      ackState.dmUpTo = dmUpTo;
      if (dmUpTo !== dmBefore) unannounced.dms += 1;
    }
    const channelUpTo = await pullOperatorChannel(config, chassisWritten, denylist);
    if (
      channelUpTo !== null &&
      (ackState.channelUpTo === null || channelUpTo > ackState.channelUpTo)
    ) {
      ackState.channelUpTo = channelUpTo;
      unannounced.channel = true;
    }
    const asks = await pullAsks(config, chassisWritten, denylist);
    if (asks.deliveryId) ackState.asksDelivery = asks.deliveryId;
    unannounced.asks += countNewAsks(asks.delivered, shownAsks);
  }
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
    ...mindSpawnIds(),
    baseSha
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
  await ackInbox(config, [...ackState.inboxIds]);
  await ackXDms(config, ackState.dmUpTo);
  await ackChannel(config, ackState.channelUpTo);
  await ackAsks(config, ackState.asksDelivery);

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
  .then(async code => {
    await activeShipper?.close();
    process.exit(code);
  })
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
    await activeShipper?.close().catch(() => undefined);
    process.exit(1);
  });
