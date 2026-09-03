/**
 * The harness adapter contract (chassis spec 4.1, spec 0010). An adapter
 * knows how to invoke one headless CLI coding agent and what to stage in
 * its home so that the session sees exactly what the chassis hands it:
 * everything else in the wake lifecycle is harness-independent.
 */

import type { MergedMcpConfig } from "../mcp-config.js";
import type { UsageAccumulator, WakeUsage } from "../usage.js";

export interface CommandSpec {
  command: string;
  args: string[];
  /** Extra environment beyond the minimal base; the credential lands here. */
  env: Record<string, string>;
}

/** A file the entrypoint writes into the mind's home before the session. */
export interface StagedFile {
  /** Absolute path, under the mind's home. */
  path: string;
  content: string;
  /** Unix mode; secrets and settings are 0o600. */
  mode: number;
}

export interface StageInput {
  /** The mind's home directory; every staged file lives under it. */
  home: string;
  /** The mind credential, for harnesses that sign in from a file rather than a variable. */
  credential: string;
  /** The wake's merged MCP config (spec 0008 §4), absent when the wake has no servers. */
  mcp?: MergedMcpConfig;
  /** The chassis hooks (pull hook, journal guard) as shell commands. */
  hooks: { pullHook: string; journalGuard: string };
  /**
   * Where the harness exports its telemetry (spec 0011 §4): the porch's
   * OTLP relay, a loopback base URL the harness appends /v1/<signal>
   * to. Absent when the chronicle is not wired, and then no exporter
   * is configured at all.
   */
  telemetry?: { endpoint: string };
}

export interface StagedHarness {
  files: StagedFile[];
  /** Chassis-invariant flags appended to the session (never operator policy). */
  args: string[];
  /** Environment the probe and the session both need (e.g. where the home is). */
  env: Record<string, string>;
  /** What was staged, one line each, for the wake log. */
  lines: string[];
}

export interface HarnessAdapter {
  id: string;
  /**
   * Variables that must NOT be present when this harness runs; each entry
   * names a way the harness would silently switch auth or endpoint.
   */
  forbiddenEnv: string[];
  /**
   * The off switches for everything attached to the provider account
   * (spec 0010 §2): on every probe and session environment.
   */
  lockdownEnv: Record<string, string>;
  /**
   * The file a login credential is staged to, relative to the mind's
   * home, for harnesses that refresh it in place (spec 0010 §5); absent
   * when the credential is a variable and nothing rotates.
   */
  credentialFile?(credential: string): string | undefined;
  /** The files, flags, and environment that make the home the chassis's (spec 0010 §3, §4). Pure. */
  stage(input: StageInput): StagedHarness;
  /**
   * Every literal inside the credential that must never leave the
   * container: the credential itself, and for a file credential each
   * token in it.
   */
  secretsIn(credential: string): string[];
  /** What the wake spent, folded from the stream as it passes (spec 0011 §2). */
  usageAccumulator(): UsageAccumulator;
  /** The same over lines already in hand (tests, replays). */
  usageFrom(lines: string[]): WakeUsage | undefined;
  /** A cheap invocation whose stdout names the model that actually answered. */
  probe(model: string, credential: string): CommandSpec;
  /** The wake session itself. */
  session(
    prompt: string,
    model: string,
    credential: string,
    fallbackModel?: string
  ): CommandSpec;
}

export class EnvNotCleanError extends Error {
  override name = "EnvNotCleanError";
  constructor(adapterId: string, variable: string) {
    super(
      `env_not_clean: ${variable} is set; the ${adapterId} harness would silently prefer it over the injected credential. Unset it in the image and the wake environment.`
    );
  }
}

export class AdapterNotImplementedError extends Error {
  override name = "AdapterNotImplementedError";
  constructor(adapterId: string) {
    super(
      `adapter_not_implemented: "${adapterId}" is specified but not implemented yet; see the chassis spec's harness adapter order`
    );
  }
}

export class CredentialShapeError extends Error {
  override name = "CredentialShapeError";
  constructor(adapterId: string, detail: string) {
    super(`mind_credential_malformed: the ${adapterId} credential ${detail}`);
  }
}

export function assertEnvClean(
  adapter: HarnessAdapter,
  env: Record<string, string | undefined>
): void {
  for (const variable of adapter.forbiddenEnv) {
    if (env[variable] !== undefined) throw new EnvNotCleanError(adapter.id, variable);
  }
}

/**
 * The chassis hooks in the shape both harnesses read (Claude Code's,
 * which Codex adopted: the same stdin fields, the same stdout envelopes).
 * matchAll is the "every tool" matcher where the harness wants one
 * spelled out, or undefined where an absent matcher means every tool.
 */
export function chassisHooks(hooks: StageInput["hooks"], matchAll: string | undefined): unknown {
  return {
    PostToolUse: [
      {
        ...(matchAll !== undefined ? { matcher: matchAll } : {}),
        hooks: [{ type: "command", command: hooks.pullHook, timeout: 15 }]
      }
    ],
    Stop: [{ hooks: [{ type: "command", command: hooks.journalGuard, timeout: 10 }] }]
  };
}
