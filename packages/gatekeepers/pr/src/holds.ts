/**
 * The pr Gatekeeper's decision storage (spec 0012 §6, §8): merges held
 * for the operator, the intent rows that make a merge or a close
 * accountable across a lost response, and the terminal records that
 * keep a rejected head from holding again.
 *
 * Pure over a minimal storage interface so the lifecycle is tested
 * without a Durable Object runtime; PrHolds (holds-do.ts) is the DO
 * that hands it ctx.storage. Every method is one serialized turn when
 * run inside the DO, which is what makes the claim atomic.
 */

export interface KeyValueStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list<T>(prefix: string): Promise<Map<string, T>>;
}

export interface HeldMerge {
  id: string;
  queuedAt: string;
  agentId: string;
  repo: string;
  number: number;
  /** The author's words: rendered as untrusted text everywhere. */
  title: string;
  author: string;
  headSha: string;
  /** The paths outside the grant's auto globs, the reason it is held. */
  outside: string[];
  /** Roster ids whose approvals qualified. */
  approvedBy: string[];
  claimed?: boolean;
  claimedAt?: string;
  /** Minted by the claim; the intent begun for this hold must present it (the fence against a stale approval). */
  claimToken?: string;
}

export type MergeIntentState = "pending" | "unknown" | "merged" | "superseded" | "failed";

export interface MergeIntent {
  id: string;
  repo: string;
  number: number;
  headSha: string;
  agentId: string;
  mode: "auto" | "operator";
  heldId?: string;
  at: string;
  state: MergeIntentState;
  mergeSha?: string;
  detail?: string;
  resolvedAt?: string;
  /** When the outcome became unknown (a lost response): reconciliation waits a grace after it. */
  unknownAt?: string;
}

export interface CloseIntent {
  id: string;
  repo: string;
  number: number;
  agentId: string;
  reason: string;
  at: string;
  steps: { commented?: boolean; closed?: boolean };
  state: "pending" | "closed" | "failed";
  /** Set while a door is working the intent; a crashed door leaves it, so it ages out. */
  workingSince?: string;
  /** Minted per begin or resume; every step and the resolve must present it, so a superseded executor's writes refuse. */
  workToken?: string;
  detail?: string;
  resolvedAt?: string;
}

export type TerminalOutcome = "merged" | "rejected" | "superseded" | "failed";

/** What became of one head of one pull request; keyed by (repo, number, headSha). */
export interface TerminalRecord {
  repo: string;
  number: number;
  headSha: string;
  outcome: TerminalOutcome;
  at: string;
  /** Who decided: a roster id for a merge, "operator" for a rejection. */
  by: string;
  heldId?: string;
  mergeSha?: string;
  reason?: string;
}

/** A claim younger than this is an approval in flight (spend's bound). */
export const CLAIM_AGE_MS = 5 * 60 * 1000;
/** A pending intent older than this belongs to a door that crashed mid-flight, not one still working. */
export const INTENT_STALE_MS = 5 * 60 * 1000;
/**
 * After a request the client gave up on, the server may still be
 * finishing it: GitHub's API answers or times out a request within ten
 * seconds of receiving it. Reconciliation therefore waits this grace
 * (six times that) after the client's abort before reading GitHub as
 * the truth, so no merge request can still be in flight when a
 * reconciliation says "not merged" and a rejection is recorded on it.
 */
export const UNKNOWN_GRACE_MS = 60 * 1000;

/**
 * Whether an open intent may be reconciled now, or must still be
 * waited for. An unknown one: the grace after it became unknown. A
 * pending one (a crashed executor): its request was aborted at the
 * stale bound at the latest, so the stale bound plus the grace.
 */
export function reconcilable(intent: MergeIntent, now: string): boolean {
  const t = Date.parse(now);
  if (intent.state === "pending") return t - Date.parse(intent.at) >= INTENT_STALE_MS + UNKNOWN_GRACE_MS;
  if (intent.state === "unknown") return t - Date.parse(intent.unknownAt ?? intent.at) >= UNKNOWN_GRACE_MS;
  return false;
}
/** Terminal records outlive their usefulness after this. */
export const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const heldKey = (id: string) => `held:${id}`;
const intentKey = (id: string) => `intent:${id}`;
const closeKey = (id: string) => `close:${id}`;
const terminalKey = (repo: string, number: number, headSha: string) => `term:${repo}#${number}@${headSha}`;

export class HoldStore {
  constructor(
    private readonly storage: KeyValueStorage,
    private readonly newId: () => string = () => crypto.randomUUID()
  ) {}

  // ---- holds -----------------------------------------------------------

  /**
   * Hold a merge for the operator, deduplicated on (repo, number,
   * headSha), claimed rows included: a decision in flight is still THE
   * hold for this head, and reporting it beats minting a twin.
   */
  async hold(
    merge: Omit<HeldMerge, "id" | "queuedAt" | "claimed" | "claimedAt">,
    at: string
  ): Promise<{ held: HeldMerge; deduped: boolean }> {
    for (const existing of await this.listHeld()) {
      if (existing.repo === merge.repo && existing.number === merge.number && existing.headSha === merge.headSha) {
        return { held: existing, deduped: true };
      }
    }
    const held: HeldMerge = { id: this.newId(), queuedAt: at, ...merge };
    await this.storage.put(heldKey(held.id), held);
    return { held, deduped: false };
  }

  async getHeld(id: string): Promise<HeldMerge | undefined> {
    return this.storage.get<HeldMerge>(heldKey(id));
  }

  /** Only the first caller gets the hold; a second concurrent approval gets nothing. */
  async claimHeld(id: string, at: string): Promise<HeldMerge | undefined> {
    const held = await this.storage.get<HeldMerge>(heldKey(id));
    if (!held || held.claimed) return undefined;
    const claimed = { ...held, claimed: true, claimedAt: at, claimToken: this.newId() };
    await this.storage.put(heldKey(id), claimed);
    return claimed;
  }

  async unclaimHeld(id: string): Promise<void> {
    const held = await this.storage.get<HeldMerge>(heldKey(id));
    if (held) await this.storage.put(heldKey(id), { ...held, claimed: false, claimedAt: undefined });
  }

  async deleteHeld(id: string): Promise<void> {
    await this.storage.delete(heldKey(id));
  }

  async listHeld(): Promise<HeldMerge[]> {
    const entries = await this.storage.list<HeldMerge>("held:");
    return [...entries.values()].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  }

  /**
   * Whether a rejection may proceed now (spec 0012 §8, spend's rule): a
   * young claim is an approval executing, so the answer is
   * approval_in_flight; a stale claim is a crashed approval and the
   * caller must read GitHub before overriding it.
   */
  async rejectVerdict(
    id: string,
    at: string
  ): Promise<{ status: "not_found" } | { status: "approval_in_flight" } | { status: "stale_claim"; held: HeldMerge } | { status: "clear"; held: HeldMerge }> {
    const held = await this.storage.get<HeldMerge>(heldKey(id));
    if (!held) return { status: "not_found" };
    if (held.claimed && held.claimedAt !== undefined) {
      const ageMs = Date.parse(at) - Date.parse(held.claimedAt);
      if (Number.isFinite(ageMs) && ageMs < CLAIM_AGE_MS) return { status: "approval_in_flight" };
      return { status: "stale_claim", held };
    }
    return { status: "clear", held };
  }

  // ---- merge intents ---------------------------------------------------

  /** The pending or unknown merge intent for a pull request, if one exists. */
  async openMergeIntent(repo: string, number: number): Promise<MergeIntent | undefined> {
    for (const intent of (await this.storage.list<MergeIntent>("intent:")).values()) {
      if (intent.repo === repo && intent.number === number && (intent.state === "pending" || intent.state === "unknown")) {
        return intent;
      }
    }
    return undefined;
  }

  /** Every merge intent that is pending or unknown, across pull requests. */
  async listOpenMergeIntents(): Promise<MergeIntent[]> {
    const out: MergeIntent[] = [];
    for (const intent of (await this.storage.list<MergeIntent>("intent:")).values()) {
      if (intent.state === "pending" || intent.state === "unknown") out.push(intent);
    }
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }

  /**
   * Begin a merge intent ATOMICALLY: the check for an open intent and
   * the write are one serialized turn, so two overlapping merge calls
   * for one pull request cannot both start an irreversible act. The
   * loser gets the open intent back and decides what to do with it.
   */
  async beginMerge(
    input: Omit<MergeIntent, "id" | "state"> & { claimToken?: string }
  ): Promise<
    | { created: true; intent: MergeIntent }
    | { created: false; reason: "open_intent"; intent: MergeIntent }
    | { created: false; reason: "hold_gone" }
  > {
    const { claimToken, ...fields } = input;
    // The fence: an operator's approval begins its intent only while
    // its hold still exists and still carries the claim it took. A
    // rejection that overrode a stale claim deleted the hold (with the
    // terminal record, in one turn), so the slow approval stops here
    // and never reaches GitHub.
    if (fields.heldId !== undefined) {
      const held = await this.storage.get<HeldMerge>(heldKey(fields.heldId));
      if (!held || !held.claimed || held.claimToken !== claimToken) return { created: false, reason: "hold_gone" };
    }
    const open = await this.openMergeIntent(fields.repo, fields.number);
    if (open) return { created: false, reason: "open_intent", intent: open };
    const intent: MergeIntent = { id: this.newId(), state: "pending", ...fields };
    await this.storage.put(intentKey(intent.id), intent);
    return { created: true, intent };
  }

  /**
   * Reject in ONE turn: the check for an intent in flight, the terminal
   * record and the hold's deletion together. beginMerge is one turn
   * too, so the two cannot interleave: either the approval's intent
   * exists when the rejection looks (approval_in_flight), or the hold
   * is gone when the approval begins (hold_gone). No awaited network
   * read sits between the check and the write.
   */
  async rejectAndRecord(
    held: HeldMerge,
    record: TerminalRecord,
    at: string
  ): Promise<
    | { status: "rejected" }
    | { status: "approval_in_flight" | "unresolved"; intent: MergeIntent }
    | { status: "already_merged"; terminal: TerminalRecord }
  > {
    // No rejection ever lands over an OPEN intent: a young pending one is
    // an act in flight, and an older or unknown one must be reconciled
    // (by the caller, with a credential) before this turn runs again.
    const open = await this.openMergeIntent(held.repo, held.number);
    if (open) {
      const inFlight = open.state === "pending" && Date.parse(at) - Date.parse(open.at) < INTENT_STALE_MS;
      return { status: inFlight ? "approval_in_flight" : "unresolved", intent: open };
    }
    // A head that already merged (its intent settled while this
    // rejection was being decided) is never overwritten with rejected.
    const done = await this.terminal(held.repo, held.number, held.headSha);
    if (done && (done.outcome === "merged" || done.outcome === "superseded")) {
      await this.deleteHeld(held.id);
      return { status: "already_merged", terminal: done };
    }
    await this.recordTerminal(record);
    await this.deleteHeld(held.id);
    return { status: "rejected" };
  }

  async resolveMerge(
    id: string,
    result: { state: "merged"; mergeSha: string } | { state: "superseded" | "failed" | "unknown"; detail?: string },
    at: string
  ): Promise<MergeIntent | undefined> {
    const intent = await this.storage.get<MergeIntent>(intentKey(id));
    if (!intent) return undefined;
    const resolved: MergeIntent = {
      ...intent,
      state: result.state,
      ...(result.state === "merged" ? { mergeSha: result.mergeSha } : {}),
      ...("detail" in result && result.detail !== undefined ? { detail: result.detail } : {}),
      ...(result.state === "unknown" ? { unknownAt: intent.unknownAt ?? at } : { resolvedAt: at })
    };
    await this.storage.put(intentKey(id), resolved);
    return resolved;
  }

  /**
   * Settle a merge intent in ONE serialized turn: its terminal state,
   * the terminal record for its head, and what becomes of the hold it
   * came from (deleted when the head merged or was overtaken, unclaimed
   * when the attempt provably did not merge). One turn, so a failure
   * between the writes cannot leave the intent terminal and the hold
   * stranded: either all of it lands or the intent stays open and the
   * next reconciliation does it again.
   */
  async settleMerge(
    id: string,
    result: { state: "merged"; mergeSha: string } | { state: "superseded" | "failed"; detail?: string },
    at: string,
    options: { terminal?: TerminalRecord; hold?: "delete" | "unclaim" } = {}
  ): Promise<MergeIntent | undefined> {
    const intent = await this.storage.get<MergeIntent>(intentKey(id));
    if (!intent) return undefined;
    // Single winner: an intent settles once. Two reconciliations of the
    // same intent cannot both write the terminal record and both ledger
    // it; the second finds it settled and gets nothing back.
    if (intent.state !== "pending" && intent.state !== "unknown") return undefined;
    if (options.terminal) await this.recordTerminal(options.terminal);
    if (options.hold === "delete") {
      // The head is over: EVERY hold for it goes, the one this intent
      // came from and any other (an agent's own merge call can settle
      // a head the operator was still deciding).
      for (const held of await this.listHeld()) {
        if (held.repo === intent.repo && held.number === intent.number && held.headSha === intent.headSha) {
          await this.deleteHeld(held.id);
        }
      }
      if (intent.heldId !== undefined) await this.deleteHeld(intent.heldId);
    } else if (options.hold === "unclaim" && intent.heldId !== undefined) {
      await this.unclaimHeld(intent.heldId);
    }
    return this.resolveMerge(id, result, at);
  }

  // ---- close intents ---------------------------------------------------

  async openCloseIntent(repo: string, number: number): Promise<CloseIntent | undefined> {
    for (const intent of (await this.storage.list<CloseIntent>("close:")).values()) {
      if (intent.repo === repo && intent.number === number && intent.state === "pending") return intent;
    }
    return undefined;
  }

  /**
   * Begin or resume a close ATOMICALLY. A pending intent another door
   * is working right now (workingSince younger than the stale bound)
   * answers busy; an older one is resumed by the caller. Both the
   * lookup and the write happen in one serialized turn.
   */
  async beginClose(
    input: Omit<CloseIntent, "id" | "state" | "steps" | "workingSince">
  ): Promise<{ status: "created" | "resumed" | "busy"; intent: CloseIntent }> {
    const open = await this.openCloseIntent(input.repo, input.number);
    if (open) {
      const age = open.workingSince === undefined ? Infinity : Date.parse(input.at) - Date.parse(open.workingSince);
      if (Number.isFinite(age) && age < INTENT_STALE_MS) return { status: "busy", intent: open };
      // A resume mints a new work token: the executor that went stale
      // may still be alive, and its next step or resolve refuses.
      const resumed = { ...open, workingSince: input.at, workToken: this.newId() };
      await this.storage.put(closeKey(open.id), resumed);
      return { status: "resumed", intent: resumed };
    }
    const intent: CloseIntent = { id: this.newId(), state: "pending", steps: {}, workingSince: input.at, workToken: this.newId(), ...input };
    await this.storage.put(closeKey(intent.id), intent);
    return { status: "created", intent };
  }

  /** The door is done with a still-pending close intent (a lost response): release it for a retry. */
  async releaseClose(id: string, workToken?: string): Promise<void> {
    const intent = await this.storage.get<CloseIntent>(closeKey(id));
    if (intent && intent.state === "pending" && (workToken === undefined || intent.workToken === workToken)) {
      const released = { ...intent };
      delete released.workingSince;
      await this.storage.put(closeKey(id), released);
    }
  }

  /** Record a step; refused (false) when the token is not the current executor's. */
  async closeStep(id: string, step: "commented" | "closed", workToken?: string): Promise<boolean> {
    const intent = await this.storage.get<CloseIntent>(closeKey(id));
    if (!intent || intent.state !== "pending") return false;
    if (workToken !== undefined && intent.workToken !== workToken) return false;
    await this.storage.put(closeKey(id), { ...intent, steps: { ...intent.steps, [step]: true } });
    return true;
  }

  async resolveClose(id: string, state: "closed" | "failed", at: string, detail?: string, workToken?: string): Promise<boolean> {
    const intent = await this.storage.get<CloseIntent>(closeKey(id));
    if (!intent || intent.state !== "pending") return false;
    if (workToken !== undefined && intent.workToken !== workToken) return false;
    await this.storage.put(closeKey(id), {
      ...intent,
      state,
      resolvedAt: at,
      ...(detail !== undefined ? { detail } : {})
    });
    return true;
  }

  // ---- terminal records ------------------------------------------------

  async terminal(repo: string, number: number, headSha: string): Promise<TerminalRecord | undefined> {
    return this.storage.get<TerminalRecord>(terminalKey(repo, number, headSha));
  }

  /** Record what became of a head, pruning records older than the retention. */
  async recordTerminal(record: TerminalRecord): Promise<void> {
    await this.storage.put(terminalKey(record.repo, record.number, record.headSha), record);
    const cutoff = Date.parse(record.at) - TERMINAL_RETENTION_MS;
    for (const [key, existing] of await this.storage.list<TerminalRecord>("term:")) {
      if (Date.parse(existing.at) < cutoff) await this.storage.delete(key);
    }
  }

  async listTerminals(): Promise<TerminalRecord[]> {
    const entries = await this.storage.list<TerminalRecord>("term:");
    return [...entries.values()].sort((a, b) => b.at.localeCompare(a.at));
  }
}

/** An in-memory storage for tests and for the porch-less paths. */
export function memoryStorage(): KeyValueStorage {
  const map = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return map.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T) {
      map.set(key, structuredClone(value));
    },
    async delete(key: string) {
      map.delete(key);
    },
    async list<T>(prefix: string) {
      const out = new Map<string, T>();
      for (const [key, value] of map) if (key.startsWith(prefix)) out.set(key, structuredClone(value) as T);
      return out;
    }
  };
}
