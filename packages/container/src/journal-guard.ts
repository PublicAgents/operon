/**
 * The journal guard: a Claude Code Stop hook that refuses the mind's
 * first attempt to stop while JOURNAL.md carries no appended entry for
 * this wake. The wake prompt already pleads "ALWAYS write your
 * JOURNAL.md entry before you stop"; wake 23 proved a plea is not a
 * mechanism (six minutes of excellent negotiation, session exit 0,
 * journal_untouched). Blocking the stop once, with the reason in front
 * of the model, converts the doctrine into a gate the mind cannot
 * absent-mindedly walk past.
 *
 * "Appended" is checked structurally, not by parsing entries: the
 * journal is append-only doctrine (spec 0001), so a journaled wake
 * means the wake-start content is still present verbatim and new bytes
 * exist around it. Untouched journals block; so do rewrites and
 * truncations that discard the wake-start content, because bytes
 * merely moving is not an entry. A mind that edited history while also
 * appending gets one false reminder and its second stop stands.
 *
 * Loop safety: a Stop hook that always blocked would trap the session,
 * so the guard yields when stop_hook_active says it already blocked
 * once (the harness sets it on re-entry). One firm reminder, then the
 * mind's decision stands; presleep still records an unjournaled wake
 * as failed.
 */

import { readFile } from "node:fs/promises";

export const BASELINE_FILE = "/tmp/operon-journal-baseline.md";
export const JOURNAL_PATH = "/tmp/operon-wake/state/JOURNAL.md";

/**
 * Pure decision over wake-start and current journal content. Blocks
 * exactly once, and only when no appended entry can exist: the journal
 * is byte-identical to wake start, or the wake-start content is gone
 * (rewritten or truncated instead of appended to). Missing information
 * (no baseline recorded, journal unreadable) never blocks: a guard
 * that can fail closed there would trap sessions on chassis bugs, and
 * presleep remains the real enforcement.
 */
export function journalGuardDecision(
  baseline: string | null,
  now: string | null,
  stopHookActive: boolean
): { block: boolean; reason?: string } {
  if (stopHookActive) return { block: false };
  if (baseline === null || now === null) return { block: false };
  if (now === baseline) {
    return {
      block: true,
      reason:
        "Your JOURNAL.md has not been touched this wake. An unjournaled wake " +
        "did not happen as far as your memory is concerned: append this wake's " +
        "entry to JOURNAL.md now (what you did, what is pending, what the next " +
        "wake must know), then stop. If you truly mean to stop without a " +
        "journal entry, stop again and this guard will yield."
    };
  }
  if (!now.includes(baseline)) {
    return {
      block: true,
      reason:
        "JOURNAL.md changed this wake, but its wake-start content is no longer " +
        "present: the journal is append-only, and a rewrite or truncation is " +
        "not a wake entry. Restore the prior entries and APPEND this wake's " +
        "entry, then stop. If you already appended your entry and deliberately " +
        "edited earlier text too, stop again and this guard will yield."
    };
  }
  return { block: false };
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
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
  const decision = journalGuardDecision(
    await readOrNull(BASELINE_FILE),
    await readOrNull(JOURNAL_PATH),
    stopHookActive
  );
  if (decision.block) {
    console.log(JSON.stringify({ decision: "block", reason: decision.reason }));
  }
}

if (process.argv[1]?.endsWith("journal-guard.js")) {
  main()
    .then(() => process.exit(0))
    .catch(() => process.exit(0));
}
