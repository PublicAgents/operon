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
    // message exactly when it matters most. The error line is usually
    // the LAST one (a banner and its warnings come first), so a long
    // output keeps its head and its tail, never only its head.
    super(`command_failed: ${command} exited ${exitCode ?? "by signal"}: ${headAndTail(stderr.trim() || stdout.trim())}`);
  }
}

/** The first and last lines of a long output, the middle elided. */
export function headAndTail(text: string, head = 200, tail = 500): string {
  if (text.length <= head + tail + 20) return text;
  return `${text.slice(0, head)}\n[... ${text.length - head - tail} chars elided ...]\n${text.slice(-tail)}`;
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

export interface StreamOptions extends RunOptions {
  /** Tee of everything the child writes (both streams), for the transcript. */
  onOutput?: (chunk: string) => void;
}

/** Run with output streaming to this process's stdio; resolves with the exit code. */
export function runStreaming(
  command: string,
  args: string[],
  options: StreamOptions = {}
): Promise<number> {
  return new Promise((resolve, reject) => {
    const tee = options.onOutput;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      // With a tee the streams pipe through us, still written verbatim to
      // this process's stdio, so the container log is unchanged.
      stdio: ["ignore", tee ? "pipe" : "inherit", tee ? "pipe" : "inherit"],
      timeout: options.timeoutMs,
      uid: options.uid,
      gid: options.gid
    });
    if (tee) {
      child.stdout?.on("data", (chunk: Buffer) => {
        process.stdout.write(chunk);
        tee(chunk.toString("utf8"));
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        process.stderr.write(chunk);
        tee(chunk.toString("utf8"));
      });
    }
    child.on("error", reject);
    child.on("close", code => resolve(code ?? 1));
  });
}
