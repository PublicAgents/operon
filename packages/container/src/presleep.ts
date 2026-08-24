/**
 * The presleep gate: mechanical checks that run after the mind session and
 * before state is pushed. Pure functions over the changed-file set so the
 * rules are testable without git or a container.
 *
 * A failed check never silently passes: the entrypoint maps failures to
 * distinct exit codes and a notify message. secret_found additionally
 * blocks the push entirely.
 */

export interface ChangedFile {
  path: string;
  content: string;
}

export interface PresleepFailure {
  code: "journal_untouched" | "secret_found";
  detail: string;
}

export interface PresleepResult {
  ok: boolean;
  failures: PresleepFailure[];
  /** True when pushing would publish a secret; the push must not happen. */
  blockPush: boolean;
}

export const JOURNAL_PATH = "JOURNAL.md";

/** Mask a denylist literal so reports never re-print the secret they found. */
export function maskSecret(literal: string): string {
  if (literal.length <= 4) return "****";
  return `${literal.slice(0, 3)}…(${literal.length} chars)`;
}

export function verifyPresleep(
  changedFiles: ChangedFile[],
  denylist: string[],
  journalPath = JOURNAL_PATH
): PresleepResult {
  const failures: PresleepFailure[] = [];

  if (!changedFiles.some(file => file.path === journalPath)) {
    failures.push({
      code: "journal_untouched",
      detail: `${journalPath} was not modified this wake; a wake that leaves no journal entry did not happen, as far as the record is concerned`
    });
  }

  for (const file of changedFiles) {
    for (const literal of denylist) {
      if (literal.length > 0 && file.content.includes(literal)) {
        failures.push({
          code: "secret_found",
          detail: `${file.path} contains denylisted literal ${maskSecret(literal)}`
        });
      }
    }
  }

  const blockPush = failures.some(failure => failure.code === "secret_found");
  return { ok: failures.length === 0, failures, blockPush };
}
