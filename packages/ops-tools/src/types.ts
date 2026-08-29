import type { z } from "zod";

/**
 * The operator tool contract (spec 0005 §2): a tool is data plus a
 * handler taking an explicit ToolContext. It knows nothing about HTTP,
 * MCP, or React, which is what lets the REST API, the MCP server, the
 * OpenAPI document, and the SKILL all be generated from one list and
 * never answer the same question differently.
 */

export type OpsMethod = "GET" | "POST";

/**
 * A caller mistake: bad arguments, an unknown target, a refused
 * decision. The message is safe to show the caller (and, over MCP, the
 * model, so it can correct its own arguments). Never used for secrets
 * or internals.
 */
export class ToolInputError extends Error {
  readonly status: number;
  /** An optional structured body (e.g. the downstream JSON error) for REST. */
  readonly payload?: unknown;
  constructor(message: string, status = 400, payload?: unknown) {
    super(message);
    this.name = "ToolInputError";
    this.status = status;
    this.payload = payload;
  }
}

/**
 * A deployment gap, not a caller mistake: an unwired binding, missing
 * configuration. Maps to 503; fail closed and loudly.
 */
export class ToolUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolUnavailableError";
  }
}

/**
 * Worker-secret writes via the Cloudflare API (spec 0005 §6). Workers
 * are addressed by their DIRECTORY name (scheduler, gatekeeper-till);
 * the host maps directories to deployed script names exactly once.
 */
export interface SecretsPort {
  /** Secret NAMES on a worker; values are unreadable by construction. */
  list(worker: string): Promise<string[]>;
  /** Write one secret. The value never comes back and is never logged. */
  put(worker: string, name: string, value: string): Promise<void>;
}

/**
 * The entire dependency surface of a handler. Nothing ambient: what is
 * not here, a tool cannot reach, and a test constructs this in memory.
 */
export interface ToolContext {
  /** The verified Access identity (email, sub, or service token name). */
  operator: string;
  /**
   * Call a Gatekeeper's binding-only Ops entrypoint. Returns the parsed
   * JSON body; throws ToolInputError carrying the downstream status and
   * error text on a non-2xx answer, ToolUnavailableError when the
   * binding is not wired.
   */
  ops(
    binding: string,
    method: OpsMethod,
    path: string,
    options?: { body?: unknown; query?: Record<string, string | undefined> }
  ): Promise<unknown>;
  /**
   * Call the scheduler's public control surface (the host attaches the
   * wake-trigger bearer). Same error semantics as ops().
   */
  scheduler(method: OpsMethod, path: string): Promise<unknown>;
  /** The gateway's own operator audit ledger, most recent first. */
  auditRecent(limit: number): Promise<unknown>;
  /** Absent when CLOUDFLARE_API_TOKEN is not configured. */
  secrets?: SecretsPort;
}

export interface ToolDefinition {
  /** Snake_case, stable: the MCP tool name and the REST path stem. */
  name: string;
  title: string;
  /**
   * What the tool does and what the caller should know. Fields carrying
   * agent-authored text must say they are untrusted data.
   */
  description: string;
  input: z.ZodType;
  /** True for pure reads (MCP readOnlyHint; no intent audit row). */
  readOnly: boolean;
  /**
   * True for state-changing operator decisions: the host writes the
   * audit intent row BEFORE the handler runs and refuses on audit
   * failure (spec 0003).
   */
  decision: boolean;
  handler(input: unknown, context: ToolContext): Promise<unknown>;
}

/** build_test -> /api/v1/build-test: one derivation, used everywhere. */
export function toolPath(name: string): string {
  return `/api/v1/${name.replace(/_/g, "-")}`;
}
