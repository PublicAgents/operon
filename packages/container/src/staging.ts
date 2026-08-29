import { runCapture } from "./exec.js";
import type { ChangedFile } from "./presleep.js";

/**
 * Determine what the wake changed, reading exactly what a commit would
 * publish. Stage everything, then read the staged set from git's own
 * NUL-separated path list (correct for renames and special characters),
 * reading each blob in full from the INDEX (`git show :<path>`), not the
 * working tree, so symlinks are scanned as their target-string blob and
 * nothing is a truncated proxy.
 *
 * Runs as the MIND uid, unprivileged and unauthenticated: a mind-planted
 * clean filter or hook triggered by `git add`/`git show` executes as the
 * mind itself, which is no escalation, so no hardened-flag gymnastics or
 * root git are needed here.
 */

const MAX_SCANNED_FILE_BYTES = 4 * 1024 * 1024;

export interface StagedChanges {
  /** Added or modified files, with their full content for scanning + commit. */
  changed: ChangedFile[];
  /** Paths deleted this wake. */
  deleted: string[];
}

export interface StageOptions {
  env?: Record<string, string>;
  uid?: number;
  gid?: number;
  /**
   * The commit the wake STARTED from. Diffing the staged index against
   * this, not HEAD, keeps a mind's own local `git commit` from hiding
   * its work: with a HEAD diff a self-committed wake stages nothing,
   * presleep sees an untouched journal, and "nothing to persist"
   * silently discards the wake (wakes 23 and 24 died exactly there).
   */
  baseSha?: string;
}

function splitZ(output: string): string[] {
  return output.split("\0").filter(entry => entry.length > 0);
}

export async function stageAndCollect(
  dir: string,
  options: StageOptions = {}
): Promise<StagedChanges> {
  const run = (args: string[]) =>
    runCapture("git", args, { cwd: dir, env: options.env, uid: options.uid, gid: options.gid });
  const git = async (args: string[]) => (await run(args)).stdout;

  await git(["add", "-A"]);
  const base = options.baseSha ?? "HEAD";
  const staged = splitZ(await git(["diff", "--cached", "--name-only", "-z", base]));
  const deleted = new Set(
    splitZ(await git(["diff", "--cached", "--name-only", "--diff-filter=D", "-z", base]))
  );

  const changed: ChangedFile[] = [];
  for (const path of staged) {
    if (deleted.has(path)) continue;
    try {
      const content = await git(["show", `:${path}`]);
      changed.push({
        path,
        content: Buffer.byteLength(content, "utf8") > MAX_SCANNED_FILE_BYTES ? null : content
      });
    } catch {
      changed.push({ path, content: null });
    }
  }
  return { changed, deleted: [...deleted] };
}
