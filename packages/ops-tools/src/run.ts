import { z } from "zod";
import {
  ToolInputError,
  type ToolContext,
  type ToolDefinition
} from "./types.js";

/**
 * One execution path for every surface (REST and MCP both call this),
 * carrying the audit doctrine from spec 0003: a DECISION writes its
 * intent row first and is refused when that write fails (an
 * unattributed decision must be impossible); the outcome row and read
 * rows are best-effort.
 */

export interface ToolAudit {
  /** Durable intent row. Throwing refuses the decision. */
  intent(tool: string, summary: string): Promise<void>;
  /** Best-effort outcome/read row; must not throw. */
  finish(tool: string, decision: boolean, ok: boolean, status: number): Promise<void>;
}

export class AuditUnavailableError extends Error {
  constructor(cause?: unknown) {
    // The refusal names what the audit ledger said: a paused fleet
    // whose resume was refused must be diagnosable from the answer.
    const said = cause instanceof Error ? cause.message : cause === undefined ? "" : String(cause);
    super(`decision refused: it could not be attributed (audit unavailable${said ? `: ${said.slice(0, 200)}` : ""})`);
    this.name = "AuditUnavailableError";
  }
}

/** Keys whose values never reach an audit row, on any tool. */
const AUDIT_REDACTED_KEYS = new Set(["value", "secret", "token", "password"]);

export function auditSummary(input: unknown): string {
  if (input === null || typeof input !== "object") return String(input ?? "");
  const redacted: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
    redacted[key] = AUDIT_REDACTED_KEYS.has(key) ? "[redacted]" : val;
  }
  return JSON.stringify(redacted).slice(0, 500);
}

function statusOf(error: unknown): number {
  if (error instanceof ToolInputError) return error.status;
  if (error instanceof Error && error.name === "ToolUnavailableError") return 503;
  return 500;
}

export async function runTool(
  tool: ToolDefinition,
  rawInput: unknown,
  context: ToolContext,
  audit: ToolAudit
): Promise<unknown> {
  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    throw new ToolInputError(
      `invalid input: ${z.prettifyError(parsed.error).slice(0, 500)}`
    );
  }
  if (tool.decision) {
    try {
      await audit.intent(tool.name, auditSummary(parsed.data));
    } catch (error) {
      throw new AuditUnavailableError(error);
    }
  }
  try {
    const value = await tool.handler(parsed.data, context);
    await audit.finish(tool.name, tool.decision, true, 200);
    return value;
  } catch (error) {
    await audit.finish(tool.name, tool.decision, false, statusOf(error));
    throw error;
  }
}
