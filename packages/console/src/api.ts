/**
 * The console's whole data layer: the tool registry's REST surface,
 * same-origin, cookie-authenticated by Cloudflare Access. One path
 * derivation (mirrors ops-tools toolPath), one custom header (the CSRF
 * fence), one 401 behavior (reload, which re-runs the Access flow).
 */

export function apiErrorMessage(status: number, body: unknown): string {
  if (typeof body !== "object" || body === null || !("error" in body)) return `request failed (${status})`;
  const { error, detail } = body as { error: unknown; detail?: unknown };
  const name = String(error);
  return typeof detail === "string" && detail.length > 0 && detail !== name ? `${name}: ${detail.slice(0, 300)}` : name;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    // The name AND the detail: a refusal such as send_failed says why
    // in its detail, and a badge that hides it sends the operator to
    // the logs for a sentence the answer already carried.
    super(apiErrorMessage(status, body));
    this.status = status;
    this.body = body;
  }
}

/** A future /t/<tenant> prefix is this one constant. */
export const BASE = "";

/**
 * The selected project (spec 0006 §9): one console serves the fleet,
 * and every call carries the selection so unqualified names resolve
 * against it. Remembered per browser; absent means the plane's
 * default project.
 */
const PROJECT_KEY = "operon.project";

export function selectedProject(): string | undefined {
  try {
    return localStorage.getItem(PROJECT_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function selectProject(project: string | undefined): void {
  try {
    if (project) localStorage.setItem(PROJECT_KEY, project);
    else localStorage.removeItem(PROJECT_KEY);
  } catch {
    // Storage refused (private mode): the selection lives for this page only.
  }
}

/** The input with the selection applied, unless the call names a project itself. */
function withSelectedProject(input: unknown): unknown {
  const project = selectedProject();
  if (!project) return input ?? {};
  if (input !== null && typeof input === "object" && "project" in (input as object)) return input;
  return { ...((input as Record<string, unknown> | null) ?? {}), project };
}

/** The live-route path with the selection applied (the ws routes read ?project=). */
export function withProjectQuery(path: string): string {
  const project = selectedProject();
  if (!project) return path;
  return `${path}${path.includes("?") ? "&" : "?"}project=${encodeURIComponent(project)}`;
}

export function toolPath(name: string): string {
  return `${BASE}/api/v1/${name.replace(/_/g, "-")}`;
}

export async function callTool<T = unknown>(name: string, input: unknown = {}): Promise<T> {
  const response = await fetch(toolPath(name), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-operon-console": "1"
    },
    body: JSON.stringify(withSelectedProject(input))
  });
  if (response.status === 404) {
    // A remembered project that is no longer enrolled: forget it, so
    // the next load lands on the plane's default instead of a wall of
    // unknown_project refusals.
    const body = (await response.clone().json().catch(() => null)) as { error?: string } | null;
    if (body?.error === "unknown_project" && selectedProject()) {
      selectProject(undefined);
      location.reload();
    }
  }
  if (response.status === 401) {
    // The Access session expired: reloading re-runs the Access flow.
    location.reload();
    throw new ApiError(401, { error: "access_expired" });
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = { error: `unparseable response (${response.status})` };
  }
  if (!response.ok) throw new ApiError(response.status, body);
  return body as T;
}

export async function whoami(): Promise<{ email: string; sub: string; commonName: string }> {
  const response = await fetch(`${BASE}/whoami`);
  if (response.status === 401) location.reload();
  const body = (await response.json()) as {
    identity?: { email?: string; sub?: string; commonName?: string };
  };
  return {
    email: body.identity?.email ?? "",
    sub: body.identity?.sub ?? "",
    commonName: body.identity?.commonName ?? ""
  };
}

// ---- result shapes the console relies on ------------------------------

export interface AgentRow {
  id: string;
  enabled: boolean;
  cadence: string;
  harness: string;
  /** Every harness this agent may wake on, primary first (spec 0010 §4). */
  harnesses?: string[];
  model: string;
  hosts: string[];
  web: boolean;
  disabled: boolean;
  currentWake?: { wakeId: string; startedAt: string; trigger: string; harness?: string };
}

/** One wake's usage row (spec 0011), or null when none was recorded. */
export interface WakeUsageRow {
  wakeId: string;
  agentId: string;
  harness: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  turns: number | null;
  durationMs: number | null;
  recordedAt: string;
}

export interface TraceSpanRow {
  id: number;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startMs: number;
  endMs: number;
  status: "ok" | "error" | "unset";
  attributes: Record<string, unknown>;
}

export interface TraceEventRow {
  id: number;
  atMs: number;
  name: string;
  severity: string | null;
  body: string | null;
  attributes: Record<string, unknown>;
}

export interface WakeRecordRow {
  wakeId: string;
  agentId: string;
  trigger: string;
  /** The harness the wake ran on (spec 0010 §4); absent on older records. */
  harness?: string;
  startedAt: string;
  endedAt?: string;
  status: "running" | "completed" | "failed";
  reason?: string;
}

export interface WakeChunk {
  seq: number;
  at: string;
  text: string;
  done: boolean | number;
}

export interface ChannelEntry {
  id: number;
  at: string;
  from: "operator" | "agent";
  agentId: string;
  text: string;
}

export interface EventRow {
  id: number;
  at: string;
  gatekeeper: string;
  kind: string;
  agent_id: string | null;
  /** A JSON object from the chronicle, not a string. */
  detail: Record<string, unknown> | null;
}

export interface MessageRow {
  id: number;
  at: string;
  kind: string;
  agent_id: string;
  sender: string | null;
  recipient: string | null;
  subject: string | null;
  body: string;
  ref_id: string | null;
}

export interface LedgerRow {
  at: string;
  kind: string;
  detail: Record<string, unknown>;
}
