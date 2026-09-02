import { z } from "zod";

/**
 * One enrolled project of the fleet (spec 0006 §9). The control plane
 * hosts one project (its own) and binds to the others' gatekeepers.
 */
export interface FleetProject {
  project: string;
  zone?: string;
  /** Worker script names are `<workerPrefix>-<dir>`. */
  workerPrefix?: string;
}

export interface FleetInfo {
  /** The project whose workers this plane is deployed beside. */
  host: string;
  /** Fills `project` when a call omits it. */
  defaultProject: string;
  /** The host first, then every enrolled project. */
  projects: FleetProject[];
}

/**
 * The `project` argument every tool takes (spec 0006 §9). Added to each
 * tool's schema by the registry in one place, resolved by the HOST to
 * a binding set before the handler runs, so no handler mentions it and
 * none can forget it.
 */
export const PROJECT_FIELD = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, "project names are lowercase slugs")
  .optional()
  .describe(
    "Which enrolled project to act on; the plane's default project when omitted. " +
      "Audit rows always record the resolved project."
  );

/** The schema with `project` added, when it is an object schema (every tool's is). */
export function withProject(schema: z.ZodType): z.ZodType {
  return schema instanceof z.ZodObject ? schema.extend({ project: PROJECT_FIELD }) : schema;
}

/** The project a raw input names, before validation, for the host to resolve. */
export function requestedProject(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const value = (input as { project?: unknown }).project;
  return typeof value === "string" ? value : undefined;
}

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
  /**
   * Rotate a whole group to one fresh value, SERIALIZED per group by
   * the host (the gateway runs it inside a per-group Durable Object):
   * two concurrent rotations interleaving two values over the same
   * members would split the group with both reporting success.
   */
  rotateGroup(
    group: string,
    pairs: readonly (readonly [workerDir: string, secretName: string])[]
  ): Promise<{ written: string[]; failed: string[]; resumed?: boolean }>;
}

/**
 * The entire dependency surface of a handler. Nothing ambient: what is
 * not here, a tool cannot reach, and a test constructs this in memory.
 */
export interface ToolContext {
  /** The verified Access identity (email, sub, or service token name). */
  operator: string;
  /** The project this context is bound to (resolved by the host, never "default"). */
  project: string;
  /** The fleet as the host knows it; absent means a single-project plane. */
  fleet?: FleetInfo;
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
  scheduler(method: OpsMethod, path: string, options?: { body?: unknown }): Promise<unknown>;
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
