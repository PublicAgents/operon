/**
 * The rotation table: every INTERNAL bearer group of the chassis, as
 * data. One group shares ONE fresh value across every worker/secret
 * pair listed. Imported by the secret_rotate_group tool, the
 * rotate-tokens CLI (via tools/rotate-groups.mjs, a thin re-export),
 * and the coverage spec that fails CI when a Gatekeeper accepts a
 * bearer this table does not rotate.
 */

export type RotationPair = readonly [workerDir: string, secretName: string];

// WebCrypto and timers exist in both hosts (Workers, Node 24); declared
// minimally since this package compiles against bare es2022.
declare const crypto: { getRandomValues<T extends ArrayBufferView>(array: T): T };
declare function setTimeout(handler: () => void, timeoutMs?: number): unknown;

function agentVar(agentId: string): string {
  return agentId.toUpperCase().replace(/-/g, "_");
}

export function rotationGroups(agentIds: readonly string[]): Record<string, RotationPair[]> {
  const groups: Record<string, RotationPair[]> = {
    // telegram accepts; scheduler and the notifying gatekeepers present.
    notify: [
      ["gatekeeper-telegram", "NOTIFY_TOKEN"],
      ["gatekeeper-ops", "NOTIFY_TOKEN"],
      ["scheduler", "NOTIFY_TOKEN"],
      ["gatekeeper-email", "NOTIFY_TOKEN"],
      ["gatekeeper-spend", "NOTIFY_TOKEN"],
      ["gatekeeper-vault", "NOTIFY_TOKEN"],
      ["gatekeeper-x", "NOTIFY_TOKEN"]
    ],
    publish: [
      ["gatekeeper-deploy", "PUBLISH_TOKEN"],
      ["scheduler", "PUBLISH_TOKEN"]
    ],
    "github-token-mint": [
      ["gatekeeper-github", "TOKEN_SERVICE_TOKEN"],
      ["scheduler", "GITHUB_TOKEN_SERVICE_TOKEN"]
    ],
    persist: [
      ["gatekeeper-github", "COMMIT_SERVICE_TOKEN"],
      ["scheduler", "PERSIST_TOKEN"]
    ],
    pr: [
      ["gatekeeper-pr", "PR_SERVICE_TOKEN"],
      ["scheduler", "PR_TOKEN"]
    ],
    email: [
      ["gatekeeper-email", "EMAIL_SERVICE_TOKEN"],
      ["scheduler", "EMAIL_TOKEN"],
      ["gatekeeper-ops", "EMAIL_SERVICE_TOKEN"]
    ],
    "wake-trigger": [
      ["scheduler", "WAKE_TRIGGER_TOKEN"],
      ["gatekeeper-telegram", "WAKE_TRIGGER_TOKEN"],
      ["gatekeeper-ops", "WAKE_TRIGGER_TOKEN"]
    ],
    chronicle: [
      ["gatekeeper-chronicle", "CHRONICLE_SERVICE_TOKEN"],
      ["scheduler", "CHRONICLE_TOKEN"]
    ]
  };

  // Per-agent bearers, from the roster (spec 0002 §3): the money doors,
  // the vault, and the X posting door.
  for (const agentId of agentIds) {
    const suffix = agentVar(agentId);
    groups[`till-${agentId}`] = [
      ["gatekeeper-till", `TILL_TOKEN_${suffix}`],
      ["scheduler", `TILL_TOKEN_${suffix}`]
    ];
    groups[`spend-${agentId}`] = [
      ["gatekeeper-spend", `SPEND_TOKEN_${suffix}`],
      ["scheduler", `SPEND_TOKEN_${suffix}`]
    ];
    groups[`vault-${agentId}`] = [
      ["gatekeeper-vault", `VAULT_TOKEN_${suffix}`],
      ["scheduler", `VAULT_TOKEN_${suffix}`]
    ];
    groups[`x-${agentId}`] = [
      ["gatekeeper-x", `X_TOKEN_${suffix}`],
      ["scheduler", `X_TOKEN_${suffix}`]
    ];
  }
  return groups;
}

/**
 * Worker directory (colony workers/<dir>) to deployed script name. The
 * colony convention is a uniform operon- prefix; a differently named
 * colony overrides via the gateway's WORKER_NAME_PREFIX var.
 */
export function workerNameForDir(dir: string, prefix = "operon-"): string {
  return `${prefix}${dir}`;
}

export interface RotationOutcome {
  written: string[];
  /** member plus the final error, after retries were exhausted. */
  failed: string[];
}

/**
 * Apply ONE fresh value to every member of a group. A half-rotated
 * group is a broken bearer, so: every member is attempted (one refusal
 * must not strand the rest on the old value), and a failing member is
 * retried with the SAME value (a fresh value per attempt could keep a
 * group split forever under alternating transient failures). The
 * caller must serialize invocations per group (the gateway runs this
 * inside a per-group Durable Object): two concurrent rotations with
 * two values interleaving over the same members would split the group
 * with both reporting success.
 */
export async function executeRotation(
  pairs: readonly RotationPair[],
  value: string,
  put: (workerDir: string, secretName: string, value: string) => Promise<void>,
  backoffMs = 250
): Promise<RotationOutcome> {
  const written: string[] = [];
  const failed: string[] = [];
  for (const [dir, name] of pairs) {
    let lastError: unknown;
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      if (attempt > 0) {
        await new Promise<void>(resolve => setTimeout(() => resolve(), backoffMs * attempt));
      }
      try {
        await put(dir, name, value);
        ok = true;
      } catch (error) {
        lastError = error;
      }
    }
    if (ok) {
      written.push(`${dir}/${name}`);
    } else {
      failed.push(
        `${dir}/${name} (${lastError instanceof Error ? lastError.message : String(lastError)})`
      );
    }
  }
  return { written, failed };
}

/** One fresh 256-bit bearer, hex. Never shown to any caller. */
export function freshBearer(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
