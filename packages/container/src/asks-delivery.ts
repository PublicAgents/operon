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
 * Record a delivery as shown and answer how much of it was new. Seeding
 * with what landed at wake start (and ignoring the count) is the same
 * operation: the mind has already been handed those, and they are not
 * news that arrived while it worked.
 */
export function countNewAsks(delivered: AskDelivered[], shown: Map<string, number>): number {
  let fresh = 0;
  for (const row of delivered) {
    if (row.throughSeq <= (shown.get(row.id) ?? 0)) continue;
    shown.set(row.id, row.throughSeq);
    fresh += 1;
  }
  return fresh;
}
