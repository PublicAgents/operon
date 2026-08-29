/**
 * The journal guard: a Claude Code Stop hook that refuses the mind's
 * first attempt to stop while JOURNAL.md is untouched. The wake prompt
 * already pleads "ALWAYS write your JOURNAL.md entry before you stop";
 * wake 23 proved a plea is not a mechanism (six minutes of excellent
 * negotiation, session exit 0, journal_untouched). Blocking the stop
 * once, with the reason in front of the model, converts the doctrine
 * into a gate the mind cannot absent-mindedly walk past.
 *
 * Loop safety: a Stop hook that always blocked would trap the session,
 * so the guard yields when stop_hook_active says it already blocked
 * once (the harness sets it on re-entry). One firm reminder, then the
 * mind's decision stands; presleep still records an unjournaled wake
 * as failed.
 */

import { stat, readFile } from "node:fs/promises";

export const BASELINE_FILE = "/tmp/operon-journal-baseline.json";
export const JOURNAL_PATH = "/tmp/operon-wake/state/JOURNAL.md";

export interface JournalBaseline {
  mtimeMs: number;
  size: number;
}

export interface JournalNow {
  mtimeMs: number;
  size: number;
}

/**
 * Pure decision: block exactly once, and only when the journal provably
 * has not changed since the wake began. Missing information (no
 * baseline recorded, journal unreadable) never blocks: a guard that can
 * fail closed here would trap sessions on chassis bugs, and presleep
 * remains the real enforcement.
 */
export function journalGuardDecision(
  baseline: JournalBaseline | null,
  now: JournalNow | null,
  stopHookActive: boolean
): { block: boolean; reason?: string } {
  if (stopHookActive) return { block: false };
  if (baseline === null || now === null) return { block: false };
  const untouched = now.mtimeMs === baseline.mtimeMs && now.size === baseline.size;
  if (!untouched) return { block: false };
  return {
    block: true,
    reason:
      "Your JOURNAL.md has not been touched this wake. An unjournaled wake " +
      "did not happen as far as your memory is concerned: append this wake's " +
      "entry to JOURNAL.md now (what you did, what is pending, what the next " +
      "wake must know), then stop. If you truly already recorded everything " +
      "somewhere durable and mean to stop without a journal entry, stop again " +
      "and this guard will yield."
  };
}

async function readBaseline(): Promise<JournalBaseline | null> {
  try {
    const parsed = JSON.parse(await readFile(BASELINE_FILE, "utf8")) as JournalBaseline;
    return typeof parsed.mtimeMs === "number" && typeof parsed.size === "number" ? parsed : null;
  } catch {
    return null;
  }
}

async function statJournal(): Promise<JournalNow | null> {
  try {
    const s = await stat(JOURNAL_PATH);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  let stopHookActive = false;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      stop_hook_active?: boolean;
    };
    stopHookActive = input.stop_hook_active === true;
  } catch {
    /* no input is fine; treat as a first stop */
  }
  const decision = journalGuardDecision(await readBaseline(), await statJournal(), stopHookActive);
  if (decision.block) {
    console.log(JSON.stringify({ decision: "block", reason: decision.reason }));
  }
}

if (process.argv[1]?.endsWith("journal-guard.js")) {
  main()
    .then(() => process.exit(0))
    .catch(() => process.exit(0));
}
