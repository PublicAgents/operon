import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseReport, runGitleaks } from "./gitleaks.js";

// A pattern-valid but fake GitHub PAT, assembled at runtime so this repo
// never contains a token-shaped literal (push protection, and our own
// rules about what never enters a repo).
const FAKE_PAT = ["ghp", "_"].join("") + "x7F2kQ9mL4pR8sT1vW3yZ5bN6cD0eG2hJ4kM";

const CONFIG = fileURLToPath(new URL("../gitleaks.toml", import.meta.url));

const hasGitleaks = (() => {
  try {
    execFileSync("gitleaks", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("parseReport", () => {
  it("keeps rule, file, and line and drops everything else, including Secret", () => {
    const report = JSON.stringify([
      { RuleID: "github-pat", File: "JOURNAL.md", StartLine: 3, Secret: "the-secret" }
    ]);
    const findings = parseReport(report);
    expect(findings).toEqual([{ ruleId: "github-pat", file: "JOURNAL.md", startLine: 3 }]);
    expect(JSON.stringify(findings)).not.toContain("the-secret");
  });

  it("tolerates missing fields without inventing content", () => {
    expect(parseReport("[{}]")).toEqual([
      { ruleId: "unknown-rule", file: "unknown-file", startLine: 0 }
    ]);
  });
});

describe.skipIf(!hasGitleaks)("runGitleaks (integration, local gitleaks)", () => {
  it("flags a token-shaped secret, honors the .git allowlist, ignores repo escape hatches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "operon-gitleaks-"));
    try {
      await mkdir(join(dir, ".git"));
      // The leak the scan must catch, on a line the agent tried to exempt
      // inline; plus a repo-level ignore file that must not be honored.
      await writeFile(join(dir, "JOURNAL.md"), `token: ${FAKE_PAT} # gitleaks:allow\n`);
      await writeFile(join(dir, ".gitleaksignore"), "*\n");
      // The clone credential in .git/config must NOT block wakes.
      await writeFile(
        join(dir, ".git", "config"),
        `[remote "origin"]\n  url = https://x-access-token:${FAKE_PAT}@github.com/o/r.git\n`
      );

      const findings = await runGitleaks(dir, { configPath: CONFIG });
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.some(f => f.file.endsWith("JOURNAL.md"))).toBe(true);
      expect(findings.every(f => !f.file.includes(".git/"))).toBe(true);
      expect(JSON.stringify(findings)).not.toContain(FAKE_PAT);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns no findings on a clean directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "operon-gitleaks-clean-"));
    try {
      await writeFile(join(dir, "JOURNAL.md"), "## Wake 1\nquiet day, no tokens\n");
      expect(await runGitleaks(dir, { configPath: CONFIG })).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws (fails closed upstream) when the config path is invalid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "operon-gitleaks-badcfg-"));
    try {
      await writeFile(join(dir, "a.md"), "x\n");
      await expect(
        runGitleaks(dir, { configPath: join(dir, "missing.toml") })
      ).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
