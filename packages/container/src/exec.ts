import { spawn } from "node:child_process";

/**
 * Minimal process helpers. Sessions stream to the wake log (stdout) live;
 * capture is for short commands whose output we parse. Both throw named
 * errors that carry stderr, because a discarded error body costs three
 * debugging sessions (the manual, several times over).
 */

export class CommandError extends Error {
  override name = "CommandError";
  constructor(
    command: string,
    readonly exitCode: number | null,
    readonly stderr: string,
    readonly stdout = ""
  ) {
    // Some tools (Claude Code's -p mode included) report their error on
    // stdout; a diagnostic that only carries stderr renders as an empty
    // message exactly when it matters most.
    const detail = (stderr.trim() || stdout.trim()).slice(0, 500);
    super(`command_failed: ${command} exited ${exitCode ?? "by signal"}: ${detail}`);
  }
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Exit codes besides 0 that resolve instead of throwing (e.g. a scanner's findings code). */
  allowedExitCodes?: number[];
  /** Run the child as this uid/gid (privilege drop; requires root). */
  uid?: number;
  gid?: number;
}

export function runCapture(
  command: string,
  args: string[],
  options: RunOptions = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeoutMs,
      uid: options.uid,
      gid: options.gid
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => (stdout += chunk));
    child.stderr.on("data", chunk => (stderr += chunk));
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0 || (code !== null && options.allowedExitCodes?.includes(code))) {
        resolve({ stdout, stderr, exitCode: code });
      } else reject(new CommandError(command, code, stderr, stdout));
    });
  });
}

/** Run with output streaming to this process's stdio; resolves with the exit code. */
export function runStreaming(
  command: string,
  args: string[],
  options: RunOptions = {}
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "inherit", "inherit"],
      timeout: options.timeoutMs,
      uid: options.uid,
      gid: options.gid
    });
    child.on("error", reject);
    child.on("close", code => resolve(code ?? 1));
  });
}
