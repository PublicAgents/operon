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
    readonly stderr: string
  ) {
    super(`command_failed: ${command} exited ${exitCode ?? "by signal"}: ${stderr.slice(0, 500)}`);
  }
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export function runCapture(
  command: string,
  args: string[],
  options: RunOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeoutMs
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => (stdout += chunk));
    child.stderr.on("data", chunk => (stderr += chunk));
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new CommandError(command, code, stderr));
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
      timeout: options.timeoutMs
    });
    child.on("error", reject);
    child.on("close", code => resolve(code ?? 1));
  });
}
