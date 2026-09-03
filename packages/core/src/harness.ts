/**
 * The harnesses the chassis can run (spec 0010 §4). The container's
 * adapter table is the implementation; this list is the roster's
 * vocabulary, so a roster naming a harness nobody implements is refused
 * at check time rather than discovered as a failed wake. The container's
 * adapters.spec pins the two lists to each other.
 */
export const KNOWN_HARNESSES = ["claude-code", "codex"] as const;

export type Harness = (typeof KNOWN_HARNESSES)[number];

export function isHarness(value: unknown): value is Harness {
  return typeof value === "string" && (KNOWN_HARNESSES as readonly string[]).includes(value);
}

/**
 * Which mind a wake runs: the harness and the model pinned to it. The
 * agent's roster entry names its primary; `harnesses:` names the
 * alternates the same agent may wake on (spec 0010 §4).
 */
export interface MindPin {
  harness: Harness;
  model: string;
  fallbackModel?: string;
}
