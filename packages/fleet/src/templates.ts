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

/**
 * Deploy order: leaves first, then scheduler, telegram, ops LAST (spec
 * 0003). A Worker must exist before another binds it, so a binding pair
 * that points both ways cannot be created from nothing in one pass. Two
 * such cycles exist (scheduler <-> telegram, scheduler <-> asks) and
 * this order is the STEADY-STATE one: the second side of each cycle
 * resolves against the Worker already in the account. Bootstrapping a
 * brand new colony needs the deploy run twice, which is what the
 * bootstrap step of spec 0006 will own.
 */
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
  // Before the scheduler, which binds it for the agent's ask door.
  "gatekeeper-asks",
  // Before the scheduler, which binds every MCP server Worker.
  "gatekeeper-mcp",
  "gatekeeper-google-analytics",
  "scheduler",
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
// The codex policy (spec 0010 §5): the container is the sandbox, as
// bypassPermissions says for Claude Code; the JSONL stream is the
// transcript.
const HARNESS_EXTRA_ARGS_CODEX_DEFAULT = JSON.stringify(["--dangerously-bypass-approvals-and-sandbox", "--json"]);

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
  scheduler: {
    HARNESS_EXTRA_ARGS: HARNESS_EXTRA_ARGS_DEFAULT,
    HARNESS_EXTRA_ARGS_CODEX: HARNESS_EXTRA_ARGS_CODEX_DEFAULT
  }
};

/**
 * Which [binding, worker] pairs the manifest's MCP servers need (spec
 * 0008 §4): a bespoke Worker gets its own MCP_<NAME>, and every remote
 * server shares the generic proxy. Derived from the manifest, so the
 * umbilical's binding names and the scheduler's cannot drift apart.
 */
export function mcpBindings(manifest: FleetManifest): Array<[string, string]> {
  const bindings = new Map<string, string>();
  for (const def of Object.values(manifest.roster.mcp ?? {})) {
    if (def.type === "gatekeeper") {
      const suffix = def.worker.replace(/^gatekeeper-/, "").toUpperCase().replace(/-/g, "_");
      bindings.set(`MCP_${suffix}`, def.worker);
    } else {
      bindings.set("MCP_GK", "gatekeeper-mcp");
    }
  }
  return [...bindings];
}

function policyVars(manifest: FleetManifest, worker: string): Record<string, string> {
  return { ...(POLICY_DEFAULTS[worker] ?? {}), ...(manifest.policy[worker] ?? {}) };
}

/**
 * What the control plane binds to, per project: every gatekeeper's Ops
 * entrypoint and the scheduler's control surface (spec 0005 §2, 0006 §9).
 */
const OPS_BINDINGS: ReadonlyArray<readonly [binding: string, worker: string, entrypoint?: string]> = [
  ["CHRONICLE_GK", "gatekeeper-chronicle", "Ops"],
  ["EMAIL", "gatekeeper-email", "Ops"],
  ["SPEND", "gatekeeper-spend", "Ops"],
  ["VAULT", "gatekeeper-vault", "Ops"],
  ["X", "gatekeeper-x", "Ops"],
  ["TILL", "gatekeeper-till", "Ops"],
  ["DEPLOY", "gatekeeper-deploy", "Ops"],
  ["GITHUB", "gatekeeper-github", "Ops"],
  ["PR", "gatekeeper-pr", "Ops"],
  ["TELEGRAM", "gatekeeper-telegram", "Ops"],
  ["BROWSER", "gatekeeper-browser", "Ops"],
  ["ASKS", "gatekeeper-asks", "Ops"],
  ["SCHEDULER", "scheduler"]
];

/** "second-project" -> SECOND_PROJECT, the binding infix (mirrors the ops worker). */
function projectVar(project: string): string {
  return project.toUpperCase().replace(/-/g, "_");
}

export function renderWorkers(manifest: FleetManifest, options: RenderOptions): RenderedWorker[] {
  const { chassisDir } = options;
  const prefix = manifest.workerPrefix;
  const zone = manifest.roster.zone;
  const name = (worker: string) => `${prefix}-${worker}`;
  const gkHost = (sub: string) => `${sub}.${zone}`;

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
        durable_objects: { bindings: [ledger] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["Ledger"] }]
      }
    },
    {
      key: "gatekeeper-pr",
      config: {
        ...common("gatekeeper-pr"),
        ...chronicleD1,
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
        send_email: [{ name: "EMAIL" }],
        services: [service("TELEGRAM", "gatekeeper-telegram", "TelegramGateway")],
        durable_objects: { bindings: [{ name: "MAILBOX", class_name: "Mailbox" }, ledger] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["Mailbox", "Ledger"] }],
        vars: {
          EMAIL_DOMAIN: zone,
          ...policyVars(manifest, "email"),
          ...(manifest.operatorEmail !== undefined ? { OPERATOR_EMAIL: manifest.operatorEmail } : {})
        }
      }
    },
    {
      key: "gatekeeper-spend",
      config: {
        ...common("gatekeeper-spend"),
        compatibility_flags: ["nodejs_compat"],
        ...chronicleD1,
        services: [service("TELEGRAM", "gatekeeper-telegram", "TelegramGateway")],
        durable_objects: { bindings: [{ name: "SPEND", class_name: "SpendLedger" }, ledger] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["SpendLedger", "Ledger"] }],
        vars: policyVars(manifest, "spend")
      }
    },
    {
      key: "gatekeeper-vault",
      config: {
        ...common("gatekeeper-vault"),
        ...chronicleD1,
        durable_objects: { bindings: [{ name: "VAULT", class_name: "VaultBox" }, ledger] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["VaultBox", "Ledger"] }],
        services: [service("TELEGRAM", "gatekeeper-telegram", "TelegramGateway")]
      }
    },
    {
      key: "gatekeeper-chronicle",
      config: {
        ...common("gatekeeper-chronicle"),
        ...chronicleD1,
        durable_objects: { bindings: [{ name: "WAKE_LOG", class_name: "WakeLog" }] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["WakeLog"] }]
      }
    },
    {
      key: "gatekeeper-x",
      config: {
        ...common("gatekeeper-x"),
        ...chronicleD1,
        durable_objects: { bindings: [{ name: "POSTER", class_name: "PosterBox" }, ledger] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["PosterBox", "Ledger"] }],
        services: [service("TELEGRAM", "gatekeeper-telegram", "TelegramGateway")],
        vars: policyVars(manifest, "x")
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
        // The decision queue reaches the operator by mail through the
        // email Gatekeeper's binding-only operator path, so asks never
        // hold a send credential of their own.
        services: [service("TELEGRAM", "gatekeeper-telegram", "TelegramGateway"), 
          service("EMAIL_OPERATOR", "gatekeeper-email", "OperatorMail"),
          // The quota's honest source: the scheduler owns the wake lock.
          service("SCHEDULER_WAKE", "scheduler", "WakeQuery")
        ],
        durable_objects: {
          bindings: [{ name: "ASKS", class_name: "AskBox" }, ledger]
        },
        migrations: [{ tag: "v1", new_sqlite_classes: ["AskBox", "Ledger"] }],
        vars: policyVars(manifest, "asks")
      }
    },
    {
      key: "gatekeeper-mcp",
      config: {
        ...common("gatekeeper-mcp"),
        ...chronicleD1,
        // The runtime refuses private and loopback addresses after DNS,
        // which a hostname blocklist cannot do (spec 0008 §5).
        compatibility_flags: ["global_fetch_strictly_public"],
        // No route: reached only through the umbilical.
        durable_objects: { bindings: [ledger] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["Ledger"] }],
        vars: policyVars(manifest, "mcp")
      }
    },
    {
      key: "gatekeeper-google-analytics",
      config: {
        ...common("gatekeeper-google-analytics"),
        ...chronicleD1,
        // No route: reached only through the umbilical, so the service
        // binding is the authorization (spec 0008 §5).
        durable_objects: { bindings: [ledger] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["Ledger"] }],
        vars: policyVars(manifest, "google-analytics")
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
            instance_type: { vcpu: 1, memory_mib: 3072, disk_mb: 4000 },
            // One step, not the platform's gradual [10, 100] default:
            // every deploy drains first (spec 0006 §5), so the instances
            // being replaced are idle, and a staged rollout only
            // lengthens the window in which a freshly started wake is
            // signalled to exit. The deploy driver holds the pause until
            // this rollout reports completed.
            rollout_step_percentage: 100
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
          // The scheduler's own alerts ride TELEGRAM (the notify entrypoint);
          // the container's doors on the three public Workers ride their
          // Door entrypoints (spec 0009), never the public default export.
          service("TELEGRAM", "gatekeeper-telegram", "TelegramGateway"),
          service("TELEGRAM_DOOR", "gatekeeper-telegram", "Door"),
          service("EMAIL", "gatekeeper-email"),
          service("DEPLOY_DOOR", "gatekeeper-deploy", "Door"),
          service("GITHUB", "gatekeeper-github"),
          service("PR", "gatekeeper-pr"),
          service("CHRONICLE", "gatekeeper-chronicle"),
          service("TILL_DOOR", "gatekeeper-till", "Door"),
          service("SPEND", "gatekeeper-spend"),
          service("VAULT", "gatekeeper-vault"),
          service("X", "gatekeeper-x"),
          service("BROWSER", "gatekeeper-browser"),
          // ASKS_GK, not ASKS: the asks Gatekeeper's own Durable Object
          // binding already owns that name inside its Worker, and a
          // reader moving between the two should not have to wonder.
          service("ASKS_GK", "gatekeeper-asks"),
          ...mcpBindings(manifest).map(([binding, worker]) => service(binding, worker))
        ],
        // No door URLs (spec 0009): every door is a virtual host through
        // the umbilical, and the Gatekeepers behind them have no hostname.
        vars: {
          ...policyVars(manifest, "scheduler"),
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
          // The host project, under bare names.
          ...OPS_BINDINGS.map(([binding, worker, entrypoint]) => service(binding, worker, entrypoint)),
          // Every enrolled project (spec 0006 §9), under <PROJECT>__<BINDING>,
          // bound to THAT project's workers by its own prefix.
          ...manifest.control.enrolled.flatMap(enrolled =>
            OPS_BINDINGS.map(([binding, worker, entrypoint]) => ({
              binding: `${projectVar(enrolled.project)}__${binding}`,
              service: `${enrolled.workerPrefix}-${worker}`,
              ...(entrypoint !== undefined ? { entrypoint } : {})
            }))
          )
        ],
        vars: {
          // Absent until bootstrap makes the Access application (spec 0009
          // §3); the plane fails closed (access_unconfigured) meanwhile.
          ...(manifest.access ? { ACCESS_TEAM_DOMAIN: manifest.access.teamDomain, ACCESS_AUD: manifest.access.aud } : {}),
          CF_ACCOUNT_ID: manifest.accountId,
          WORKER_NAME_PREFIX: `${prefix}-`,
          HOST_PROJECT: manifest.project,
          HOST_ZONE: zone,
          DEFAULT_PROJECT: manifest.control.defaultProject,
          PROJECTS: JSON.stringify(manifest.control.enrolled)
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
