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
  it("collects staged blob content, symlink target strings, and deletions", async () => {
    const dir = await initRepo();
    try {
      await writeFile(join(dir, "JOURNAL.md"), "## Wake 1\n");
      // The blob git pushes for a symlink is its TARGET STRING; a secret
      // embedded there must reach the verifier even though the resolved
      // path does not exist.
      await symlink("../secret-super-secret-token-path", join(dir, "leaky-link"));
      await rm(join(dir, "base.md"));

      const files = await stageAndCollect(dir);
      const byPath = new Map(files.map(f => [f.path, f.content]));

      expect(byPath.get("JOURNAL.md")).toBe("## Wake 1\n");
      expect(byPath.get("leaky-link")).toContain("super-secret-token");
      expect(byPath.get("base.md")).toBe("");

      const result = verifyPresleep(files, ["super-secret-token"]);
      expect(result.blockPush).toBe(true);
      expect(result.failures.some(f => f.detail.includes("leaky-link"))).toBe(true);
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

      const files = await stageAndCollect(dir);
      const paths = files.map(f => f.path);
      expect(paths).toContain("spaced name (v2).md");
      const renamed = files.find(f => f.path === "spaced name (v2).md");
      expect(renamed?.content).toBe("base\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty set when nothing changed", async () => {
    const dir = await initRepo();
    try {
      expect(await stageAndCollect(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
