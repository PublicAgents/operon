/**
 * Which delivered asks are actually NEWS for the mind (spec 0007 §6).
 *
 * Ask delivery is at-least-once: a delivery repeats every operator entry
 * the agent has not acked, and the ack waits until the wake's state is
 * persisted. So the same answer legitimately arrives in every pull of a
 * wake, and counting rows would announce one operator decision over and
 * over. What separates a re-delivery from real activity is the sequence
 * number of the last operator entry in the row, which only moves when
 * the operator does something new.
 */

export interface AskDelivered {
  id: string;
  /** Sequence of the last operator entry this delivery carried. */
  throughSeq: number;
}

/**
 * Record a delivery as shown and answer WHICH asks were new. Ids rather
 * than a count, because the pending announcement is buffered until a
 * caller is there to hear it: two operator actions on the same ask
 * while nobody was listening are still one ask to mention, and a
 * counter could not tell that apart from two asks.
 *
 * Seeding with what landed at wake start (ignoring the result) is the
 * same operation: the mind has already been handed those, and they are
 * not news that arrived while it worked.
 */
export function newAsks(delivered: AskDelivered[], shown: Map<string, number>): string[] {
  const fresh: string[] = [];
  for (const row of delivered) {
    if (row.throughSeq <= (shown.get(row.id) ?? 0)) continue;
    shown.set(row.id, row.throughSeq);
    fresh.push(row.id);
  }
  return fresh;
}
