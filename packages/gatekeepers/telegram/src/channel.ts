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
/** How many entries the channel retains before pruning the oldest. */
export const RETENTION = 400;

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
