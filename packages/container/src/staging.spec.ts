import { describe, expect, it } from "vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCapture } from "./exec.js";
import { stageAndCollect } from "./staging.js";
import { verifyPresleep } from "./presleep.js";

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "operon-staging-"));
  const git = (...args: string[]) => runCapture("git", args, { cwd: dir });
  await git("init", "-q");
  await git("config", "user.name", "test");
  await git("config", "user.email", "test@operon.invalid");
  await writeFile(join(dir, "base.md"), "base\n");
  await git("add", "-A");
  await git("commit", "-q", "-m", "base");
  return dir;
}

describe("stageAndCollect (real git)", () => {
  it("collects staged blob content and symlink target strings; reports deletions separately", async () => {
    const dir = await initRepo();
    try {
      await writeFile(join(dir, "JOURNAL.md"), "## Wake 1\n");
      // git pushes a symlink's TARGET STRING as its blob; a secret there
      // must reach the verifier.
      await symlink("../secret-super-secret-token-path", join(dir, "leaky-link"));
      await rm(join(dir, "base.md"));

      const { changed, deleted } = await stageAndCollect(dir);
      const byPath = new Map(changed.map(f => [f.path, f.content]));

      expect(byPath.get("JOURNAL.md")).toBe("## Wake 1\n");
      expect(byPath.get("leaky-link")).toContain("super-secret-token");
      expect(deleted).toEqual(["base.md"]);
      // Deleted files are not in the changed set.
      expect(byPath.has("base.md")).toBe(false);

      const result = verifyPresleep(changed, ["super-secret-token"]);
      expect(result.blockPush).toBe(true);
      expect(result.failures.some(f => f.detail.includes("leaky-link"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("still sees the wake's work when the mind committed it locally (baseSha diff)", async () => {
    const dir = await initRepo();
    try {
      const git = (...args: string[]) => runCapture("git", args, { cwd: dir });
      const baseSha = (await git("rev-parse", "HEAD")).stdout.trim();
      // The mind writes its journal AND commits it itself, as wake 24 did.
      await writeFile(join(dir, "JOURNAL.md"), "## Wake 24 (wake fc9dcf85)\n");
      await git("add", "-A");
      await git("commit", "-q", "-m", "wake 24");

      // A HEAD diff would stage nothing and the wake would be discarded.
      const headDiff = await stageAndCollect(dir);
      expect(headDiff.changed).toEqual([]);

      const { changed } = await stageAndCollect(dir, { baseSha });
      const byPath = new Map(changed.map(f => [f.path, f.content]));
      expect(byPath.get("JOURNAL.md")).toBe("## Wake 24 (wake fc9dcf85)\n");
      expect(verifyPresleep(changed, []).ok).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("handles renames and paths with special characters via -z paths", async () => {
    const dir = await initRepo();
    try {
      const git = (...args: string[]) => runCapture("git", args, { cwd: dir });
      await git("mv", "base.md", "spaced name (v2).md");
      await writeFile(join(dir, "JOURNAL.md"), "## Wake 1\n");

      const { changed } = await stageAndCollect(dir);
      const renamed = changed.find(f => f.path === "spaced name (v2).md");
      expect(renamed?.content).toBe("base\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty set when nothing changed", async () => {
    const dir = await initRepo();
    try {
      expect(await stageAndCollect(dir)).toEqual({ changed: [], deleted: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
