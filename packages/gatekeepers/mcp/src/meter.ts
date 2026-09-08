/**
 * The meter behind a budgeted upstream (spec 0014 §2): one per server,
 * shared by every agent that holds the grant. Pure logic over a
 * key-value storage so it is tested without the Durable Object; the
 * DO in meter-do.ts hands it its storage and makes every method one
 * serialized turn, which is what keeps two agents from both taking
 * the last cent.
 *
 * Accounting: the month's cap is spread over its remaining days. At
 * the first call of each UTC day the day's allotment is fixed from
 * the spend BEFORE that day, so the day's own calls never shrink its
 * share. A call reserves its price before the upstream is called and
 * settles after; the Gatekeeper never refunds (an ambiguous call is
 * billed), and a reservation nobody settled by the upstream deadline
 * is settled as spent by the next turn, once. `refund` exists for a
 * caller that KNOWS nothing was sent, and no caller in the chassis
 * claims to.
 */

export interface KeyValueStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list<T>(prefix: string): Promise<Map<string, T>>;
}

export interface Reservation {
  id: string;
  tool: string;
  agentId: string;
  usd: number;
  at: string;
}

export interface MeterState {
  /** "YYYY-MM" (UTC) the figures belong to. */
  month: string;
  /** Settled and reserved spend of the month's earlier days. */
  spentBeforeTodayUsd: number;
  /** "YYYY-MM-DD" (UTC) the day figures belong to. */
  day: string;
  /** Fixed at the day's first call from the spend before it. */
  allotmentTodayUsd: number;
  /** Settled and reserved spend of today. */
  spentTodayUsd: number;
  reservations: Record<string, Reservation>;
}

export interface Remaining {
  month: string;
  monthlyUsd: number;
  spentMonthUsd: number;
  day: string;
  allotmentTodayUsd: number;
  spentTodayUsd: number;
  remainingTodayUsd: number;
  /** When today's allotment rolls over: the next UTC midnight. */
  resetsAt: string;
}

export type ReserveOutcome =
  | { ok: true; reservation: Reservation; remaining: Remaining }
  | { ok: false; code: "mcp_budget_exhausted"; detail: string; remaining: Remaining };

/** A reservation older than this with no settle or refund is settled as spent (the upstream deadline). */
export const RESERVATION_STALE_MS = 5 * 60 * 1000;

const STATE_KEY = "state";

function monthOf(at: string): string {
  return at.slice(0, 7);
}
function dayOf(at: string): string {
  return at.slice(0, 10);
}
function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function daysLeftIncludingToday(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate() - d + 1;
}
function nextMidnight(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString();
}
/** Cents-exact arithmetic on USD, so a month of small prices sums to the cap. */
function round(usd: number): number {
  return Math.round(usd * 1_000_000) / 1_000_000;
}

export class MeterStore {
  constructor(private readonly storage: KeyValueStorage) {}

  private async load(): Promise<MeterState | undefined> {
    return this.storage.get<MeterState>(STATE_KEY);
  }
  private async save(state: MeterState): Promise<void> {
    await this.storage.put(STATE_KEY, state);
  }

  /**
   * The state as of `at`, rolled forward: a new month starts the
   * figures over, a new day folds yesterday into the month and fixes
   * today's allotment. Stale reservations are settled as spent first,
   * and reported, so the caller can ledger them.
   */
  private roll(state: MeterState | undefined, monthlyUsd: number, at: string): { state: MeterState; staleSettled: Reservation[] } {
    const month = monthOf(at);
    const day = dayOf(at);
    let next: MeterState = state ?? {
      month,
      spentBeforeTodayUsd: 0,
      day,
      allotmentTodayUsd: 0,
      spentTodayUsd: 0,
      reservations: {}
    };
    const staleSettled: Reservation[] = [];
    // Stale reservations count as spent exactly once: they stay in
    // spentToday (they were added at reserve time) and leave the map.
    const atMs = Date.parse(at);
    for (const reservation of Object.values(next.reservations)) {
      if (atMs - Date.parse(reservation.at) > RESERVATION_STALE_MS) {
        staleSettled.push(reservation);
        const { [reservation.id]: _gone, ...rest } = next.reservations;
        next = { ...next, reservations: rest };
      }
    }
    // Reservations still open at a roll (younger than the stale bound)
    // move with the day: their price leaves the folded figure and
    // starts the new day's spend, so a later settle or refund finds
    // its price where the counters say it is.
    const openUsd = round(Object.values(next.reservations).reduce((sum, r) => sum + r.usd, 0));
    if (next.month !== month) {
      // A new month starts over; only the open reservations carry.
      next = { ...next, month, spentBeforeTodayUsd: 0, day, allotmentTodayUsd: 0, spentTodayUsd: openUsd };
      next.allotmentTodayUsd = round(monthlyUsd / daysLeftIncludingToday(day));
    } else if (next.day !== day) {
      const spentBefore = round(Math.max(0, next.spentBeforeTodayUsd + next.spentTodayUsd - openUsd));
      next = { ...next, spentBeforeTodayUsd: spentBefore, day, spentTodayUsd: openUsd };
      next.allotmentTodayUsd = round(Math.max(0, monthlyUsd - spentBefore) / daysLeftIncludingToday(day));
    } else if (state === undefined) {
      next.allotmentTodayUsd = round(monthlyUsd / daysLeftIncludingToday(day));
    }
    return { state: next, staleSettled };
  }

  private describe(state: MeterState, monthlyUsd: number): Remaining {
    const spentMonthUsd = round(state.spentBeforeTodayUsd + state.spentTodayUsd);
    return {
      month: state.month,
      monthlyUsd,
      spentMonthUsd,
      day: state.day,
      allotmentTodayUsd: state.allotmentTodayUsd,
      spentTodayUsd: state.spentTodayUsd,
      remainingTodayUsd: round(Math.max(0, state.allotmentTodayUsd - state.spentTodayUsd)),
      resetsAt: nextMidnight(state.day)
    };
  }

  /** The figures as of now; rolls the day and settles stale reservations as a side effect. */
  async remaining(monthlyUsd: number, at: string): Promise<{ remaining: Remaining; staleSettled: Reservation[] }> {
    const { state, staleSettled } = this.roll(await this.load(), monthlyUsd, at);
    await this.save(state);
    return { remaining: this.describe(state, monthlyUsd), staleSettled };
  }

  /** Reserve a call's price against today's allotment, or refuse by name. */
  async reserve(
    input: { id: string; tool: string; agentId: string; usd: number; monthlyUsd: number },
    at: string
  ): Promise<ReserveOutcome & { staleSettled: Reservation[] }> {
    const { state, staleSettled } = this.roll(await this.load(), input.monthlyUsd, at);
    const usd = round(input.usd);
    if (round(state.spentTodayUsd + usd) > state.allotmentTodayUsd) {
      await this.save(state);
      const remaining = this.describe(state, input.monthlyUsd);
      return {
        ok: false,
        code: "mcp_budget_exhausted",
        detail:
          `${input.tool} costs $${usd.toFixed(4)}; $${remaining.remainingTodayUsd.toFixed(4)} of today's ` +
          `$${remaining.allotmentTodayUsd.toFixed(4)} remains; the day rolls at ${remaining.resetsAt}`,
        remaining,
        staleSettled
      };
    }
    const reservation: Reservation = { id: input.id, tool: input.tool, agentId: input.agentId, usd, at };
    const next: MeterState = {
      ...state,
      spentTodayUsd: round(state.spentTodayUsd + usd),
      reservations: { ...state.reservations, [reservation.id]: reservation }
    };
    await this.save(next);
    return { ok: true, reservation, remaining: this.describe(next, input.monthlyUsd), staleSettled };
  }

  /** The upstream answered (however): the reservation stands as spent. */
  async settle(id: string): Promise<boolean> {
    const state = await this.load();
    if (!state || !(id in state.reservations)) return false;
    const { [id]: _gone, ...rest } = state.reservations;
    await this.save({ ...state, reservations: rest });
    return true;
  }

  /** The provider provably received nothing: the price goes back to today. */
  async refund(id: string): Promise<boolean> {
    const state = await this.load();
    if (!state || !(id in state.reservations)) return false;
    const { [id]: gone, ...rest } = state.reservations;
    await this.save({ ...state, spentTodayUsd: round(Math.max(0, state.spentTodayUsd - gone.usd)), reservations: rest });
    return true;
  }

  /**
   * The operator read the vendor's dashboard: the month starts over
   * from this figure. Reservations still open (a call between reserve
   * and settle) are kept and counted as today's spend, so a call in
   * flight is never erased by a reset.
   */
  async reset(spentMonthUsd: number, monthlyUsd: number, at: string): Promise<Remaining> {
    const { state: rolled } = this.roll(await this.load(), monthlyUsd, at);
    const month = monthOf(at);
    const day = dayOf(at);
    const spentBefore = round(Math.max(0, spentMonthUsd));
    const openUsd = round(Object.values(rolled.reservations).reduce((sum, r) => sum + r.usd, 0));
    const state: MeterState = {
      month,
      spentBeforeTodayUsd: spentBefore,
      day,
      allotmentTodayUsd: round(Math.max(0, monthlyUsd - spentBefore) / daysLeftIncludingToday(day)),
      spentTodayUsd: openUsd,
      reservations: rolled.reservations
    };
    await this.save(state);
    return this.describe(state, monthlyUsd);
  }
}

export { daysInMonth };
