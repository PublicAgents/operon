import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCapture } from "./exec.js";
import { githubRepoUrl, gitCredentialEnv, hardenedGitFlags } from "./git-cred.js";

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "operon-hooks-"));
  const env = gitCredentialEnv({ PATH: process.env.PATH ?? "" }, "");
  const git = (...args: string[]) => runCapture("git", args, { cwd: dir, env });
  await git("init", "-q");
  await git("config", "user.name", "t");
  await git("config", "user.email", "t@operon.invalid");
  return dir;
}

describe("hardenedGitFlags", () => {
  it("does not run a repo-planted pre-commit hook", async () => {
    const dir = await initRepo();
    try {
      const marker = join(dir, "HOOK_RAN");
      const hookDir = join(dir, ".git", "hooks");
      await mkdir(hookDir, { recursive: true });
      // A hook that, unhardened, would run arbitrary code at commit time.
      await writeFile(join(hookDir, "pre-commit"), `#!/bin/sh\ntouch "${marker}"\n`);
      await chmod(join(hookDir, "pre-commit"), 0o755);
      await writeFile(join(dir, "a.txt"), "x\n");

      const env = gitCredentialEnv({ PATH: process.env.PATH ?? "" }, "");
      await runCapture("git", [...hardenedGitFlags(), "add", "-A"], { cwd: dir, env });
      await runCapture("git", [...hardenedGitFlags(), "commit", "-m", "x"], { cwd: dir, env });

      // The hook must not have fired.
      await expect(
        runCapture("test", ["-f", marker], { allowedExitCodes: [1] }).then(r => r.exitCode)
      ).resolves.toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("scopes the credential helper to github https and refuses ssh/file transport", () => {
    const flags = hardenedGitFlags().join(" ");
    expect(flags).toContain("credential.https://github.com.helper=");
    expect(flags).toContain("protocol.ssh.allow=never");
    expect(flags).toContain("core.sshCommand=/bin/false");
    expect(flags).toContain("protocol.file.allow=never");
  });

  it("builds explicit trusted github URLs", () => {
    expect(githubRepoUrl("owner/repo")).toBe("https://github.com/owner/repo.git");
  });

  it("keeps the token off argv and out of config", () => {
    const flags = hardenedGitFlags();
    expect(flags.join(" ")).not.toContain("SECRET");
    // The helper reads the token from an env var, so the flag string is
    // a variable reference, never the value.
    expect(flags.some(f => f.includes("OPERON_GIT_ACCESS_TOKEN"))).toBe(true);
    const env = gitCredentialEnv({ PATH: "/usr/bin" }, "the-token");
    expect(env.OPERON_GIT_ACCESS_TOKEN).toBe("the-token");
  });
});

