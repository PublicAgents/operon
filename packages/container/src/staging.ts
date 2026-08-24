import { runCapture } from "./exec.js";
import type { ChangedFile } from "./presleep.js";

/**
 * Stage everything, then collect the exact content git will push, per
 * staged path, for the presleep sweep.
 *
 * Content comes from the INDEX (`git show :<path>`), not the working tree:
 * the index blob is what the commit publishes. This matters for symlinks
 * (git stores the link's target string as the blob; reading the resolved
 * file would scan the wrong bytes and a secret embedded in the target
 * string would ship unscanned) and for anything that changes between
 * staging and reading. Paths come NUL-separated from git itself, so
 * renames and special characters resolve correctly.
 *
 * A blob over the size cap, or one git cannot produce, is returned with
 * null content, which the verifier treats as unscannable and blocks the
 * push. Staged deletions publish no content and count only for the
 * journal check.
 */

const MAX_SCANNED_FILE_BYTES = 4 * 1024 * 1024;

function splitZ(output: string): string[] {
  return output.split("\0").filter(entry => entry.length > 0);
}

export async function stageAndCollect(
  dir: string,
  env?: Record<string, string>
): Promise<ChangedFile[]> {
  const git = async (args: string[]) =>
    (await runCapture("git", args, { cwd: dir, env })).stdout;

  await git(["add", "-A"]);
  const staged = splitZ(await git(["diff", "--cached", "--name-only", "-z"]));
  const deleted = new Set(
    splitZ(await git(["diff", "--cached", "--name-only", "--diff-filter=D", "-z"]))
  );

  const files: ChangedFile[] = [];
  for (const path of staged) {
    if (deleted.has(path)) {
      files.push({ path, content: "" });
      continue;
    }
    try {
      const content = await git(["show", `:${path}`]);
      files.push({
        path,
        content: Buffer.byteLength(content, "utf8") > MAX_SCANNED_FILE_BYTES ? null : content
      });
    } catch {
      files.push({ path, content: null });
    }
  }
  return files;
}
