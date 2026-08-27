/**
 * The rotation table: every INTERNAL bearer group of the chassis, as
 * data, importable by the rotate tool AND by the coverage spec
 * (packages/scheduler/src/rotate-coverage.spec.ts) that fails CI when a
 * Gatekeeper accepts a bearer this table does not rotate.
 */
export function groupsFor(roster) {
  const agentVar = agentId => agentId.toUpperCase().replace(/-/g, "_");
  /** name -> [workerDir, secretName][]; every group shares ONE fresh value. */
  const GROUPS = {
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
  for (const agent of roster.agents) {
    const suffix = agentVar(agent.id);
    GROUPS[`till-${agent.id}`] = [
      ["gatekeeper-till", `TILL_TOKEN_${suffix}`],
      ["scheduler", `TILL_TOKEN_${suffix}`]
    ];
    GROUPS[`spend-${agent.id}`] = [
      ["gatekeeper-spend", `SPEND_TOKEN_${suffix}`],
      ["scheduler", `SPEND_TOKEN_${suffix}`]
    ];
    GROUPS[`vault-${agent.id}`] = [
      ["gatekeeper-vault", `VAULT_TOKEN_${suffix}`],
      ["scheduler", `VAULT_TOKEN_${suffix}`]
    ];
    GROUPS[`x-${agent.id}`] = [
      ["gatekeeper-x", `X_TOKEN_${suffix}`],
      ["scheduler", `X_TOKEN_${suffix}`]
    ];
  }
  return GROUPS;
}
