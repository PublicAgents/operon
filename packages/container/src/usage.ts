/**
 * What a wake spent, read from the harness's own stream (spec 0011 §2):
 * Claude Code's final `result` event, Codex's `turn.completed` events
 * summed. Pure parsers over the lines the entrypoint retained; a line
 * that is not the shape expected is skipped, never guessed at.
 */

export interface WakeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** USD when the harness reports one. */
  costUsd?: number;
  turns?: number;
  durationMs?: number;
  /** The model the harness reports having used, when it says. */
  model?: string;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** A line worth retaining for usage: cheap test, no parse. */
export function isUsageLine(line: string): boolean {
  return line.startsWith("{") && line.includes('"usage"');
}

/**
 * Claude Code stream-json: the LAST `result` event carries the session's
 * totals (`usage`, `total_cost_usd`, `num_turns`, `duration_ms`) and a
 * per-model breakdown (`modelUsage`), whose first key is the model.
 */
export function claudeUsageFrom(lines: string[]): WakeUsage | undefined {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const event = parseLine(lines[i]);
    if (!event || event.type !== "result") continue;
    const usage = (event.usage ?? {}) as Record<string, unknown>;
    const models = Object.keys((event.modelUsage as Record<string, unknown> | undefined) ?? {});
    return {
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
      cacheReadTokens: num(usage.cache_read_input_tokens),
      cacheWriteTokens: num(usage.cache_creation_input_tokens),
      ...(typeof event.total_cost_usd === "number" ? { costUsd: event.total_cost_usd } : {}),
      ...(typeof event.num_turns === "number" ? { turns: event.num_turns } : {}),
      ...(typeof event.duration_ms === "number" ? { durationMs: event.duration_ms } : {}),
      ...(models.length > 0 ? { model: models[0] } : {})
    };
  }
  return undefined;
}

/**
 * Codex exec JSONL: every `turn.completed` carries that turn's
 * `usage` (`input_tokens`, `cached_input_tokens`, `output_tokens`);
 * the wake is their sum. Cached input is reported inside input_tokens
 * by Codex, so it is recorded as cache reads and not added twice.
 */
export function codexUsageFrom(lines: string[]): WakeUsage | undefined {
  let turns = 0;
  const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const line of lines) {
    const event = parseLine(line);
    if (!event || event.type !== "turn.completed") continue;
    const usage = (event.usage ?? {}) as Record<string, unknown>;
    turns += 1;
    total.inputTokens += num(usage.input_tokens);
    total.outputTokens += num(usage.output_tokens);
    total.cacheReadTokens += num(usage.cached_input_tokens);
  }
  return turns > 0 ? { ...total, turns } : undefined;
}

/** The summary's phrasing, shared by the notify and the log. */
export function describeUsage(usage: WakeUsage | undefined): string {
  if (!usage) return "usage unknown";
  const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n));
  const parts = [`${k(usage.inputTokens)} in`, `${k(usage.outputTokens)} out`];
  if (usage.cacheReadTokens > 0) parts.push(`${k(usage.cacheReadTokens)} cached`);
  if (usage.costUsd !== undefined) parts.push(`$${usage.costUsd.toFixed(2)}`);
  if (usage.turns !== undefined) parts.push(`${usage.turns} turns`);
  return parts.join(", ");
}
