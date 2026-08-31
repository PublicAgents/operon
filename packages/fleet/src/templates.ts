import { distinctCadences } from "@operon/core";
import type { FleetManifest } from "./manifest.js";

/**
 * The chassis-owned wrangler templates (spec 0006 §2): worker topology,
 * service bindings, Durable Object classes and MIGRATION TAGS,
 * compatibility settings, and assets blocks are code history and ship
 * with the pin. Rendering fills in the project's identity, zone, policy
 * values, and resource ids. Migration tags in particular must only ever
 * be APPENDED here, in the same reviewed diff as the DO change they
 * describe; a project cannot forget one because a project never sees
 * one.
 */

export interface RenderOptions {
  /** Path from the rendered-config directory to the chassis checkout, e.g. "../../operon". */
  chassisDir: string;
  /** D1 database id; when absent the config carries a placeholder the deploy driver must resolve. */
  d1DatabaseId?: string;
  /** Site-store KV namespace id; same placeholder rule. */
  siteStoreKvId?: string;
}

export interface RenderedWorker {
  /** Stable worker key: "gatekeeper-email", "scheduler", ... */
  key: string;
  /** The wrangler config file name inside the build directory. */
  filename: string;
  config: Record<string, unknown>;
}

export const D1_PLACEHOLDER = "UNRESOLVED-RESOLVE-AT-DEPLOY";

/** Deploy order: leaves first, then scheduler, telegram, ops LAST (spec 0003). */
export const DEPLOY_ORDER = [
  "gatekeeper-github",
  "gatekeeper-pr",
  "gatekeeper-deploy",
  "gatekeeper-email",
  "gatekeeper-spend",
  "gatekeeper-vault",
  "gatekeeper-chronicle",
  "gatekeeper-x",
  "gatekeeper-till",
  "gatekeeper-browser",
  "scheduler",
  "gatekeeper-asks",
  "gatekeeper-telegram",
  "gatekeeper-ops"
] as const;

const HARNESS_EXTRA_ARGS_DEFAULT = JSON.stringify([
  "--permission-mode",
  "bypassPermissions",
  "--output-format",
  "stream-json",
  "--verbose"
]);

/** Chassis defaults for every policy var the manifest may override. */
const POLICY_DEFAULTS: Record<string, Record<string, string>> = {
  spend: {
    SPEND_MAX_TX: "0.10",
    SPEND_DAILY_CAP: "1.00",
    SPEND_TESTNET: "true",
    SPEND_ALLOWANCE_DAYS: "7"
  },
  till: { TILL_MAX_PRICE: "1.00", TILL_MAX_OFFERS: "20", TILL_TESTNET: "true" },
  x: { X_DAILY_CAP: "4" },
  email: {},
  pr: {},
  deploy: { DISCLOSURE_MARKER: "autonomous agent" },
  browser: { WEB_MAX_CONCURRENT: "3", WEB_ORIGIN_DENYLIST: "" },
  scheduler: { HARNESS_EXTRA_ARGS: HARNESS_EXTRA_ARGS_DEFAULT }
};

function policyVars(manifest: FleetManifest, worker: string): Record<string, string> {
  return { ...(POLICY_DEFAULTS[worker] ?? {}), ...(manifest.policy[worker] ?? {}) };
}

export function renderWorkers(manifest: FleetManifest, options: RenderOptions): RenderedWorker[] {
  const { chassisDir } = options;
  const prefix = manifest.workerPrefix;
  const zone = manifest.roster.zone;
  const name = (worker: string) => `${prefix}-${worker}`;
  const gkHost = (sub: string) => `${sub}.${zone}`;
  const notifyUrl = `https://${gkHost("tg")}/notify`;

  const common = (worker: string) => ({
    $schema: `${chassisDir}/../node_modules/wrangler/config-schema.json`,
    name: name(worker),
    main: `${chassisDir}/packages/${worker === "scheduler" ? "scheduler" : `gatekeepers/${worker.replace("gatekeeper-", "")}`}/src/index.ts`,
    compatibility_date: "2026-08-01",
    account_id: manifest.accountId,
    workers_dev: false,
    observability: { enabled: true }
  });

  const chronicleD1 = {
    d1_databases: [
      {
        binding: "CHRONICLE",
        database_name: manifest.resources.d1Name,
        database_id: options.d1DatabaseId ?? D1_PLACEHOLDER,
        migrations_dir: `${chassisDir}/packages/chronicle/migrations`
      }
    ]
  };

  const route = (pattern: string) => ({ pattern, custom_domain: true });
  const ledger = { name: "LEDGER", class_name: "Ledger" };
  const service = (binding: string, worker: string, entrypoint?: string) => ({
    binding,
    service: name(worker),
    ...(entrypoint !== undefined ? { entrypoint } : {})
  });

  // Till serves the zone apex plus every host any agent is assigned.
  const tillRoutes = [
    route(zone),
    ...[...new Set(manifest.roster.agents.flatMap(agent => agent.hosts))]
      .filter(host => host !== "@")
      .map(host => route(`${host}.${zone}`))
  ];

  const workers: RenderedWorker[] = [
    {
      key: "gatekeeper-github",
      config: {
        ...common("gatekeeper-github"),
        ...chronicleD1,
        routes: [route(gkHost("gh-gk"))],
        durable_objects: { bindings: [ledger] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["Ledger"] }]
      }
    },
    {
      key: "gatekeeper-pr",
      config: {
        ...common("gatekeeper-pr"),
        ...chronicleD1,
        routes: [route(gkHost("pr-gk"))],
        durable_objects: { bindings: [ledger] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["Ledger"] }],
        vars: policyVars(manifest, "pr")
      }
    },
    {
      key: "gatekeeper-deploy",
      config: {
        ...common("gatekeeper-deploy"),
        ...chronicleD1,
        durable_objects: {
          bindings: [ledger, { name: "SITE_PUBLISHER", class_name: "SitePublisher" }]
        },
        migrations: [{ tag: "v1", new_sqlite_classes: ["Ledger", "SitePublisher"] }],
        kv_namespaces: [{ binding: "SITE_STORE", id: options.siteStoreKvId ?? D1_PLACEHOLDER }],
        vars: policyVars(manifest, "deploy")
      }
    },
    {
      key: "gatekeeper-email",
      config: {
        ...common("gatekeeper-email"),
        ...chronicleD1,
        routes: [route(gkHost("email-gk"))],
        send_email: [{ name: "EMAIL" }],
        services: [service("TELEGRAM", "gatekeeper-telegram")],
        durable_objects: { bindings: [{ name: "MAILBOX", class_name: "Mailbox" }, ledger] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["Mailbox", "Ledger"] }],
        vars: {
          EMAIL_DOMAIN: zone,
          ...policyVars(manifest, "email"),
          ...(manifest.operatorEmail !== undefined ? { OPERATOR_EMAIL: manifest.operatorEmail } : {}),
          NOTIFY_URL: notifyUrl
        }
      }
    },
    {
      key: "gatekeeper-spend",
      config: {
        ...common("gatekeeper-spend"),
        compatibility_flags: ["nodejs_compat"],
        ...chronicleD1,
        routes: [route(gkHost("spend-gk"))],
        services: [service("TELEGRAM", "gatekeeper-telegram")],
        durable_objects: { bindings: [{ name: "SPEND", class_name: "SpendLedger" }, ledger] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["SpendLedger", "Ledger"] }],
        vars: { ...policyVars(manifest, "spend"), NOTIFY_URL: notifyUrl }
      }
    },
    {
      key: "gatekeeper-vault",
      config: {
        ...common("gatekeeper-vault"),
        ...chronicleD1,
        routes: [route(gkHost("vault-gk"))],
        durable_objects: { bindings: [{ name: "VAULT", class_name: "VaultBox" }, ledger] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["VaultBox", "Ledger"] }],
        vars: { NOTIFY_URL: notifyUrl }
      }
    },
    {
      key: "gatekeeper-chronicle",
      config: {
        ...common("gatekeeper-chronicle"),
        ...chronicleD1,
        routes: [route(gkHost("chronicle-gk"))],
        durable_objects: { bindings: [{ name: "WAKE_LOG", class_name: "WakeLog" }] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["WakeLog"] }]
      }
    },
    {
      key: "gatekeeper-x",
      config: {
        ...common("gatekeeper-x"),
        ...chronicleD1,
        routes: [route(gkHost("x-gk"))],
        durable_objects: { bindings: [{ name: "POSTER", class_name: "PosterBox" }, ledger] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["PosterBox", "Ledger"] }],
        vars: { ...policyVars(manifest, "x"), NOTIFY_URL: notifyUrl }
      }
    },
    {
      key: "gatekeeper-till",
      config: {
        ...common("gatekeeper-till"),
        compatibility_flags: ["nodejs_compat"],
        ...chronicleD1,
        routes: tillRoutes,
        services: [service("DEPLOY", "gatekeeper-deploy")],
        durable_objects: {
          bindings: [
            { name: "CATALOG", class_name: "TillCatalog" },
            ledger,
            { name: "TILL_STORE", class_name: "TillStore" }
          ]
        },
        migrations: [
          { tag: "v1", new_sqlite_classes: ["TillCatalog", "Ledger"] },
          { tag: "v2", new_sqlite_classes: ["TillStore"] }
        ],
        vars: policyVars(manifest, "till")
      }
    },
    {
      key: "gatekeeper-browser",
      config: {
        ...common("gatekeeper-browser"),
        durable_objects: {
          bindings: [
            { name: "WEB_SESSION", class_name: "WebSession" },
            { name: "WEB_METER", class_name: "WebMeter" },
            ledger
          ]
        },
        migrations: [{ tag: "v1", new_sqlite_classes: ["WebSession", "WebMeter", "Ledger"] }],
        vars: { CF_ACCOUNT_ID: manifest.accountId, ...policyVars(manifest, "browser") }
      }
    },
    {
      key: "gatekeeper-asks",
      config: {
        ...common("gatekeeper-asks"),
        ...chronicleD1,
        routes: [route(gkHost("asks-gk"))],
        // The decision queue reaches the operator by mail through the
        // email Gatekeeper's binding-only operator path, so asks never
        // hold a send credential of their own.
        services: [
          service("EMAIL_OPERATOR", "gatekeeper-email", "OperatorMail"),
          // The quota's honest source: the scheduler owns the wake lock.
          service("SCHEDULER_WAKE", "scheduler", "WakeQuery")
        ],
        durable_objects: {
          bindings: [{ name: "ASKS", class_name: "AskBox" }, ledger]
        },
        migrations: [{ tag: "v1", new_sqlite_classes: ["AskBox", "Ledger"] }],
        vars: { ...policyVars(manifest, "asks"), NOTIFY_URL: notifyUrl }
      }
    },
    {
      key: "scheduler",
      config: {
        ...common("scheduler"),
        compatibility_flags: ["enable_ctx_exports"],
        triggers: { crons: distinctCadences(manifest.roster) },
        containers: [
          {
            class_name: "WakeContainer",
            image: `${chassisDir}/packages/container/Dockerfile`,
            max_instances: manifest.containers.maxInstances,
            instance_type: { vcpu: 1, memory_mib: 3072, disk_mb: 4000 }
          }
        ],
        durable_objects: {
          bindings: [
            { name: "WAKE_CONTAINER", class_name: "WakeContainer" },
            { name: "FLEET_CONTROL", class_name: "FleetControl" }
          ]
        },
        migrations: [
          { tag: "v1", new_sqlite_classes: ["WakeContainer"] },
          { tag: "v2", new_sqlite_classes: ["FleetControl"] }
        ],
        // The wake_finished mirror writes chronicle rows directly; the
        // binding is named CHRONICLE_DB because CHRONICLE is the
        // chronicle gatekeeper's service binding above.
        d1_databases: [
          {
            binding: "CHRONICLE_DB",
            database_name: manifest.resources.d1Name,
            database_id: options.d1DatabaseId ?? D1_PLACEHOLDER
          }
        ],
        services: [
          service("GITHUB_GATEKEEPER", "gatekeeper-github"),
          service("TELEGRAM", "gatekeeper-telegram"),
          service("EMAIL", "gatekeeper-email"),
          service("DEPLOY", "gatekeeper-deploy"),
          service("GITHUB", "gatekeeper-github"),
          service("PR", "gatekeeper-pr"),
          service("CHRONICLE", "gatekeeper-chronicle"),
          service("TILL", "gatekeeper-till"),
          service("SPEND", "gatekeeper-spend"),
          service("VAULT", "gatekeeper-vault"),
          service("X", "gatekeeper-x"),
          service("BROWSER", "gatekeeper-browser")
        ],
        vars: {
          ...policyVars(manifest, "scheduler"),
          NOTIFY_URL: notifyUrl,
          PUBLISH_URL: `https://${zone}/gatekeeper/publish`,
          PERSIST_URL: `https://${gkHost("gh-gk")}/commit`,
          PR_URL: `https://${gkHost("pr-gk")}/gatekeeper/pr`,
          EMAIL_URL: `https://${gkHost("email-gk")}`,
          TILL_URL: `https://${zone}`,
          SPEND_URL: `https://${gkHost("spend-gk")}`,
          VAULT_URL: `https://${gkHost("vault-gk")}`,
          CHRONICLE_URL: `https://${gkHost("chronicle-gk")}`,
          X_URL: `https://${gkHost("x-gk")}`,
          ASKS_URL: `https://${gkHost("asks-gk")}`,
          ...(manifest.policy.pr?.PR_REPOS !== undefined ? { PR_REPOS: manifest.policy.pr.PR_REPOS } : {})
        }
      }
    },
    {
      key: "gatekeeper-telegram",
      config: {
        ...common("gatekeeper-telegram"),
        ...chronicleD1,
        routes: [route(gkHost("tg"))],
        durable_objects: { bindings: [ledger, { name: "CHANNEL", class_name: "Channel" }] },
        migrations: [
          { tag: "v1", new_sqlite_classes: ["Ledger"] },
          { tag: "v2", new_sqlite_classes: ["Channel"] }
        ],
        services: [
          service("SCHEDULER", "scheduler"),
          service("EMAIL", "gatekeeper-email", "Ops"),
          service("SPEND", "gatekeeper-spend", "Ops")
        ]
      }
    },
    {
      key: "gatekeeper-ops",
      config: {
        ...common("gatekeeper-ops"),
        ...chronicleD1,
        routes: [route(gkHost("ops"))],
        assets: {
          directory: `${chassisDir}/packages/console/dist`,
          binding: "ASSETS",
          not_found_handling: "single-page-application",
          run_worker_first: true
        },
        durable_objects: {
          bindings: [
            { name: "AUDIT", class_name: "Ledger" },
            { name: "ROTATION", class_name: "RotationGate" }
          ]
        },
        migrations: [
          { tag: "v1", new_sqlite_classes: ["Ledger"] },
          { tag: "v2", new_sqlite_classes: ["RotationGate"] }
        ],
        services: [
          service("CHRONICLE_GK", "gatekeeper-chronicle", "Ops"),
          service("EMAIL", "gatekeeper-email", "Ops"),
          service("SPEND", "gatekeeper-spend", "Ops"),
          service("VAULT", "gatekeeper-vault", "Ops"),
          service("X", "gatekeeper-x", "Ops"),
          service("TILL", "gatekeeper-till", "Ops"),
          service("DEPLOY", "gatekeeper-deploy", "Ops"),
          service("GITHUB", "gatekeeper-github", "Ops"),
          service("PR", "gatekeeper-pr", "Ops"),
          service("TELEGRAM", "gatekeeper-telegram", "Ops"),
          service("BROWSER", "gatekeeper-browser", "Ops"),
          service("ASKS", "gatekeeper-asks", "Ops"),
          service("SCHEDULER", "scheduler")
        ],
        vars: {
          ACCESS_TEAM_DOMAIN: manifest.access.teamDomain,
          ACCESS_AUD: manifest.access.aud,
          CF_ACCOUNT_ID: manifest.accountId,
          WORKER_NAME_PREFIX: `${prefix}-`
        }
      }
    }
  ].map(worker => ({ ...worker, filename: `${worker.key}.json` }));

  const byKey = new Map(workers.map(worker => [worker.key, worker]));
  return DEPLOY_ORDER.map(key => {
    const worker = byKey.get(key);
    if (!worker) throw new Error(`template missing for ${key}`);
    return worker;
  });
}
