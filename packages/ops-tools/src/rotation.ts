/**
 * The rotation table: every INTERNAL bearer group of the chassis, as
 * data. One group shares ONE fresh value across every worker/secret
 * pair listed. Imported by the secret_rotate_group tool, the
 * rotate-tokens CLI (via tools/rotate-groups.mjs, a thin re-export),
 * and the coverage spec that fails CI when a Gatekeeper accepts a
 * bearer this table does not rotate.
 */

export type RotationPair = readonly [workerDir: string, secretName: string];

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
