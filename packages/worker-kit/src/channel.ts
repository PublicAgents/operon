/**
 * The operator channel: a per-colony conversation log between the operator
 * (over the authenticated Telegram chat) and the agents. Plain operator
 * messages broadcast to every agent (target "*"); /tell targets one agent.
 * Agent notifies are recorded too, so a wake receives the RECENT TRANSCRIPT
 * in both directions: when the operator answers something an agent said
 * three wakes ago, the agent sees what it had said alongside the answer.
 *
 * Pure logic here; storage lives in the Channel Durable Object.
 */

export interface ChannelEntry {
  /** Monotonic id; ordering and ack cursor. */
  id: number;
  at: string;
  from: "operator" | "agent";
  /** Operator entries: "*" broadcasts, otherwise an agent id. Agent entries: the sender. */
  agentId: string;
  text: string;
}

/** How many transcript entries a wake receives regardless of cursor. */
export const CONTEXT_WINDOW = 30;
/** How many entries the channel retains before pruning acked ones. */
export const RETENTION = 400;
/**
 * Absolute bound on channel size. Below it, only entries every known agent
 * has acked are pruned, so a long-idle agent cannot silently lose unread
 * operator instructions; at the bound, oldest entries go regardless (the
 * DO must stay bounded) and the drop is logged loudly, never silent.
 */
export const HARD_RETENTION = 2000;

/**
 * Which entries may be deleted. Normal pruning removes oldest entries
 * beyond RETENTION only when acked by every known cursor (no cursors yet
 * means nothing was ever delivered, so nothing is safely prunable). If the
 * log still exceeds HARD_RETENTION, the overflow is dropped oldest-first
 * regardless; the caller logs that unacked entries were lost.
 */
/**
 * The cursor set pruning must respect: every protected agent counts, a
 * missing cursor counting as 0 (an agent that never completed a wake has
 * read nothing). Stored cursors for agents no longer in the roster are
 * dropped. An UNKNOWN protection set (no roster available) returns [0]:
 * fail safe, nothing prunes below the hard bound.
 */
export function effectiveCursors(
  stored: Map<string, number>,
  protectAgents: string[] | undefined
): number[] {
  if (!protectAgents) return [0];
  if (protectAgents.length === 0) return [0];
  return protectAgents.map(agentId => stored.get(agentId) ?? 0);
}

export function prunableIds(
  entries: ChannelEntry[],
  cursors: number[]
): { ids: number[]; droppedUnacked: number } {
  if (entries.length <= RETENTION) return { ids: [], droppedUnacked: 0 };
  const sorted = [...entries].sort((a, b) => a.id - b.id);
  const excess = sorted.slice(0, entries.length - RETENTION);
  const minAcked = cursors.length > 0 ? Math.min(...cursors) : 0;
  const acked = excess.filter(entry => entry.id <= minAcked).map(entry => entry.id);

  const remaining = entries.length - acked.length;
  if (remaining <= HARD_RETENTION) return { ids: acked, droppedUnacked: 0 };
  const ackedSet = new Set(acked);
  const forced = sorted
    .filter(entry => !ackedSet.has(entry.id))
    .slice(0, remaining - HARD_RETENTION)
    .map(entry => entry.id);
  return { ids: [...acked, ...forced], droppedUnacked: forced.length };
}

/** Is this entry part of the given agent's conversation? */
export function concernsAgent(entry: ChannelEntry, agentId: string): boolean {
  if (entry.from === "agent") return entry.agentId === agentId;
  return entry.agentId === "*" || entry.agentId === agentId;
}

export interface AgentTranscript {
  /** The last CONTEXT_WINDOW entries of this agent's conversation, oldest first. */
  entries: ChannelEntry[];
  /** Operator entries with id > cursor: not yet delivered to a persisted wake. */
  newOperatorIds: number[];
  /** Ack this id after the wake's state is durably persisted. */
  upTo: number;
}

export function transcriptFor(
  all: ChannelEntry[],
  agentId: string,
  cursor: number
): AgentTranscript {
  const relevant = all.filter(entry => concernsAgent(entry, agentId));
  const newOperator = relevant.filter(
    entry => entry.from === "operator" && entry.id > cursor
  );
  // The context window trims OLD conversation only. Every not-yet-acked
  // operator message is always delivered, however many accumulated between
  // wakes: acking a message the wake never saw would lose an instruction.
  const window = relevant.slice(-CONTEXT_WINDOW);
  const byId = new Map<number, ChannelEntry>();
  for (const entry of [...window, ...newOperator]) byId.set(entry.id, entry);
  const entries = [...byId.values()].sort((a, b) => a.id - b.id);
  const upTo = entries.length > 0 ? entries[entries.length - 1].id : cursor;
  return { entries, newOperatorIds: newOperator.map(entry => entry.id), upTo };
}
