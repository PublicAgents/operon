import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCapture } from "./exec.js";

/**
 * The generic secret layer of the presleep gate: gitleaks pattern and
 * entropy rules catch secrets nobody put on the denylist. Design points
 * that matter more than the invocation:
 *
 * - The config comes from the IMAGE (--config), never the scanned repo:
 *   the repo is agent-writable, so a repo-supplied config would let the
 *   agent exempt its own leaks. Same reason --gitleaks-ignore-path points
 *   at the config's directory (the flag defaults to the scanned dir) and
 *   --ignore-gitleaks-allow disables inline gitleaks:allow comments.
 * - Findings are reported by rule id, file, and line only. The report's
 *   Secret field never leaves this module: a scanner that re-prints what
 *   it found is a second leak.
 * - A scanner error (as opposed to findings) throws, and the caller fails
 *   closed: an unscanned push is an unscannable one.
 */

const FINDINGS_EXIT_CODE = 9;

export interface GitleaksFinding {
  ruleId: string;
  file: string;
  startLine: number;
}

export interface GitleaksOptions {
  binary?: string;
  configPath?: string;
  timeoutMs?: number;
}

export async function runGitleaks(
  dir: string,
  options: GitleaksOptions = {}
): Promise<GitleaksFinding[]> {
  const binary = options.binary ?? "gitleaks";
  const configPath = options.configPath ?? "/opt/operon/gitleaks.toml";
  const reportPath = join(tmpdir(), `gitleaks-${crypto.randomUUID()}.json`);

  try {
    const { exitCode } = await runCapture(
      binary,
      [
        "dir",
        dir,
        "--config",
        configPath,
        "--gitleaks-ignore-path",
        dirname(configPath),
        "--ignore-gitleaks-allow",
        "--no-banner",
        "--report-format",
        "json",
        "--report-path",
        reportPath,
        "--exit-code",
        String(FINDINGS_EXIT_CODE)
      ],
      { allowedExitCodes: [FINDINGS_EXIT_CODE], timeoutMs: options.timeoutMs ?? 5 * 60 * 1000 }
    );
    if (exitCode === 0) return [];
    return parseReport(await readFile(reportPath, "utf8"));
  } finally {
    await rm(reportPath, { force: true });
  }
}

/**
 * Run gitleaks over an in-memory file set (a temp dir is materialized and
 * removed): the presleep gate hands it the agent-introduced changes only,
 * not the whole tree, so unchanged history and chassis-written files
 * cannot re-trip the gate. Files whose content could not be read are the
 * unscannable failure's job, not this one's.
 */
export async function runGitleaksOnFiles(
  files: Array<{ path: string; content: string | null }>,
  options: GitleaksOptions = {}
): Promise<GitleaksFinding[]> {
  const scannable = files.filter(
    (file): file is { path: string; content: string } => typeof file.content === "string"
  );
  if (scannable.length === 0) return [];
  const dir = await mkdtemp(join(tmpdir(), "operon-presleep-"));
  try {
    for (const file of scannable) {
      const target = join(dir, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content);
    }
    // Report repo-relative paths, not the temp dir's.
    return (await runGitleaks(dir, options)).map(finding => ({
      ...finding,
      file: finding.file.startsWith(`${dir}/`) ? finding.file.slice(dir.length + 1) : finding.file
    }));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function parseReport(reportJson: string): GitleaksFinding[] {
  const entries = JSON.parse(reportJson) as Array<Record<string, unknown>>;
  return entries.map(entry => ({
    ruleId: typeof entry.RuleID === "string" ? entry.RuleID : "unknown-rule",
    file: typeof entry.File === "string" ? entry.File : "unknown-file",
    startLine: typeof entry.StartLine === "number" ? entry.StartLine : 0
  }));
}
