/**
 * The console's whole data layer: the tool registry's REST surface,
 * same-origin, cookie-authenticated by Cloudflare Access. One path
 * derivation (mirrors ops-tools toolPath), one custom header (the CSRF
 * fence), one 401 behavior (reload, which re-runs the Access flow).
 */

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    super(
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : `request failed (${status})`
    );
    this.status = status;
    this.body = body;
  }
}

/** A future /t/<tenant> prefix is this one constant. */
export const BASE = "";

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
    body: JSON.stringify(input ?? {})
  });
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
  model: string;
  hosts: string[];
  web: boolean;
  disabled: boolean;
  currentWake?: { wakeId: string; startedAt: string; trigger: string };
}

export interface WakeRecordRow {
  wakeId: string;
  agentId: string;
  trigger: string;
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
