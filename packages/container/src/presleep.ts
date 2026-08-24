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
  /**
   * The file's full content, or null when it could not be fully read (too
   * large, or the read failed). null is treated as unscannable and blocks
   * the push: a file we cannot scan is a file we must not publish.
   */
  content: string | null;
}

export interface PresleepFailure {
  code: "journal_untouched" | "secret_found" | "unscannable";
  detail: string;
}

export interface PresleepResult {
  ok: boolean;
  failures: PresleepFailure[];
  /** True when pushing would publish a secret; the push must not happen. */
  blockPush: boolean;
}

export const JOURNAL_PATH = "JOURNAL.md";

/**
 * Variant expansion only applies to literals at least this long: encoding
 * and normalization checks on short strings would drown in false positives.
 */
const MIN_VARIANT_LENGTH = 8;

/** Mask a denylist literal so reports never re-print the secret they found. */
export function maskSecret(literal: string): string {
  if (literal.length <= 4) return "****";
  return `${literal.slice(0, 3)}…(${literal.length} chars)`;
}

function stripWhitespace(text: string): string {
  return text.replace(/\s+/g, "");
}

/**
 * How a denylisted literal appears in content, if it does. Beyond the raw
 * literal, this catches the cheap disguises: wrapped across lines
 * (whitespace-split) and the trivial encodings (base64, base64url, hex).
 * It deliberately claims no more than that: scanning is the mistake-catcher;
 * the structural defense against a deliberately exfiltrating mind is that
 * the credentials it can reach are short-lived and low-value.
 */
function matchForm(content: string, literal: string): string | null {
  if (content.includes(literal)) return "literal";
  if (literal.length < MIN_VARIANT_LENGTH) return null;

  if (stripWhitespace(content).includes(stripWhitespace(literal))) {
    return "whitespace-split";
  }

  const bytes = Buffer.from(literal, "utf8");
  const encoded: Array<[string, string]> = [
    ["base64", bytes.toString("base64")],
    ["base64url", bytes.toString("base64url")],
    ["hex", bytes.toString("hex")]
  ];
  for (const [form, needle] of encoded) {
    if (content.includes(needle) || content.toLowerCase().includes(needle.toLowerCase())) {
      return form;
    }
  }
  return null;
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

  const scannable: ChangedFile[] = [];
  for (const file of changedFiles) {
    if (file.content === null) {
      failures.push({
        code: "unscannable",
        detail: `${file.path} could not be fully read for scanning; the push is blocked rather than publish an unscanned change`
      });
      continue;
    }
    scannable.push(file);
  }

  const literals = denylist.filter(literal => literal.length > 0);
  for (const file of scannable) {
    for (const literal of literals) {
      const form = matchForm(file.content as string, literal);
      if (form) {
        failures.push({
          code: "secret_found",
          detail: `${file.path} contains denylisted literal ${maskSecret(literal)} (${form})`
        });
      }
    }
  }

  // Cross-file splits: a secret's halves in two files evade per-file
  // scanning, so the normalized concatenation of the whole change set is
  // scanned too (sorted by path for determinism).
  const corpus = stripWhitespace(
    [...scannable]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(file => file.content as string)
      .join("")
  );
  for (const literal of literals) {
    if (literal.length >= MIN_VARIANT_LENGTH && corpus.includes(stripWhitespace(literal))) {
      const alreadyFound = failures.some(
        failure =>
          failure.code === "secret_found" && failure.detail.includes(maskSecret(literal))
      );
      if (!alreadyFound) {
        failures.push({
          code: "secret_found",
          detail: `the combined change set contains denylisted literal ${maskSecret(literal)} split across files`
        });
      }
    }
  }

  // Anything that could publish a secret blocks the push: a confirmed
  // denylisted literal, or a change we could not scan at all.
  const blockPush = failures.some(
    failure => failure.code === "secret_found" || failure.code === "unscannable"
  );
  return { ok: failures.length === 0, failures, blockPush };
}
