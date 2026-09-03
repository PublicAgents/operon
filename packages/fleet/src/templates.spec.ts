import { describe, expect, it } from "vitest";
import { validateManifest } from "./manifest.js";
import { renderWorkers, mcpBindings, DEPLOY_ORDER, D1_PLACEHOLDER } from "./templates.js";

/**
 * The golden test: fed the livevariant colony's manifest, the templates
 * must reproduce the hand-written workers/ directory this package
 * retires, fact for load-bearing fact. When this spec and the live
 * colony disagree, the MIGRATION is wrong, not the colony.
 */

const RAW = {
  project: "livevariant",
  accountId: "85c7962b4a17a841ef0689e0e7c2a050",
  workerPrefix: "operon",
  operatorEmail: "michael@krens.nl",
  access: {
    teamDomain: "https://floral-shape-360c.cloudflareaccess.com",
    aud: "885307dbdffd16d85609cecf4cb88f6119ce65a041540315ae9ad26b13d69025"
  },
  resources: { d1Name: "operon-chronicle", siteStoreKvId: "af5f7f9897c6487db5f487ccad85a7aa" },
  policy: {
    spend: {
      SPEND_MAX_TX: "0.10",
      SPEND_DAILY_CAP: "1.00",
      SPEND_HOLD_MAX: "250.00",
      SPEND_ALLOWANCE_DAYS: "7",
      SPEND_TESTNET: "false",
      SPEND_CHAIN_ID: "4217",
      SPEND_CURRENCIES: "0x20c0000000000000000000000000000000000000=6"
    },
    till: {
      TILL_MAX_PRICE: "1.00",
      TILL_MAX_OFFERS: "20",
      TILL_TESTNET: "false",
      TILL_CURRENCIES: "0x20c0000000000000000000000000000000000000"
    },
    x: { X_DISCLOSURE_ATTESTED: "true", X_DAILY_CAP: "4" },
    pr: {
      PR_REPOS: "livevariant/livevariant,livevariant/operon,livevariant/colony,punkpeye/awesome-mcp-servers"
    }
  },
  zone: "livevariant.ai",
  agents: [
    {
      id: "promoter",
      stateRepo: "livevariant/promoter-state",
      cadence: "0 6,12,18 * * *",
      harness: "claude-code",
      model: "claude-fable-5",
      fallbackModel: "claude-opus-5",
      hosts: ["@", "prior"],
      web: true,
      enabled: true
    }
  ]
};
const LIVEVARIANT = validateManifest(RAW);

const CHASSIS = "../../operon";
const rendered = renderWorkers(LIVEVARIANT, {
  chassisDir: CHASSIS,
  d1DatabaseId: "2dade210-aa9f-463d-903c-b4e4a29ee337",
  siteStoreKvId: "af5f7f9897c6487db5f487ccad85a7aa"
});
const byKey = Object.fromEntries(rendered.map(worker => [worker.key, worker.config])) as Record<
  string,
  Record<string, any>
>;

describe("renderWorkers reproduces the livevariant colony", () => {
  it("renders every worker in the chassis deploy order (ops last)", () => {
    expect(rendered.map(worker => worker.key)).toEqual([...DEPLOY_ORDER]);
    // A Worker must exist before another binds it: everything the
    // scheduler binds by service is deployed before the scheduler,
    // except the two cycles the order comment names.
    const order = (key: string) => DEPLOY_ORDER.indexOf(key as (typeof DEPLOY_ORDER)[number]);
    expect(order("gatekeeper-asks")).toBeLessThan(order("scheduler"));
    expect(order("gatekeeper-email")).toBeLessThan(order("gatekeeper-asks"));
    expect(rendered[rendered.length - 1].key).toBe("gatekeeper-ops");
  });

  it("ships the asks Gatekeeper: its own worker, DO, route, and operator-mail binding", () => {
    const asks = byKey["gatekeeper-asks"];
    expect(asks.name).toBe("operon-gatekeeper-asks");
    expect(asks.routes).toBeUndefined();
    expect(asks.durable_objects.bindings).toEqual([
      { name: "ASKS", class_name: "AskBox" },
      { name: "LEDGER", class_name: "Ledger" }
    ]);
    expect(asks.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["AskBox", "Ledger"] }]);
    // Asks hold no send credential: mail goes through the email
    // Gatekeeper's binding-only operator entrypoint.
    expect(asks.services).toEqual([
      { binding: "TELEGRAM", service: "operon-gatekeeper-telegram", entrypoint: "TelegramGateway" },
      { binding: "EMAIL_OPERATOR", service: "operon-gatekeeper-email", entrypoint: "OperatorMail" },
      { binding: "SCHEDULER_WAKE", service: "operon-scheduler", entrypoint: "WakeQuery" }
    ]);
    // Deployed BEFORE the scheduler, which binds it for the agent's ask
    // door. The reverse edge (its own SCHEDULER_WAKE binding) is the
    // cycle the deploy order deliberately resolves against the Worker
    // already in the account.
    expect(rendered.findIndex(w => w.key === "gatekeeper-asks")).toBeLessThan(
      rendered.findIndex(w => w.key === "scheduler")
    );
    expect(byKey["scheduler"].vars.ASKS_URL).toBeUndefined();
  });

  it("keeps the legacy worker names byte-for-byte (renames would orphan DO state)", () => {
    expect(byKey["gatekeeper-spend"].name).toBe("operon-gatekeeper-spend");
    expect(byKey["scheduler"].name).toBe("operon-scheduler");
    expect(byKey["gatekeeper-ops"].name).toBe("operon-gatekeeper-ops");
  });

  it("derives routes from the zone, including the till's apex plus agent hosts", () => {
    expect(byKey["gatekeeper-email"].routes).toBeUndefined();
    expect(byKey["gatekeeper-till"].routes).toEqual([
      { pattern: "livevariant.ai", custom_domain: true },
      { pattern: "prior.livevariant.ai", custom_domain: true }
    ]);
    expect(byKey["gatekeeper-telegram"].routes).toEqual([
      { pattern: "tg.livevariant.ai", custom_domain: true }
    ]);
    expect(byKey["gatekeeper-ops"].routes).toEqual([{ pattern: "ops.livevariant.ai", custom_domain: true }]);
    expect(byKey["gatekeeper-browser"].routes).toBeUndefined();
    expect(byKey["gatekeeper-deploy"].routes).toBeUndefined();
  });

  it("carries the exact migration tag history (v2 tags included)", () => {
    expect(byKey["gatekeeper-ops"].migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["Ledger"] },
      { tag: "v2", new_sqlite_classes: ["RotationGate"] }
    ]);
    expect(byKey["gatekeeper-telegram"].migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["Ledger"] },
      { tag: "v2", new_sqlite_classes: ["Channel"] }
    ]);
    expect(byKey["gatekeeper-spend"].migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["SpendLedger", "Ledger"] }
    ]);
    expect(byKey["gatekeeper-till"].migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["TillCatalog", "Ledger"] },
      { tag: "v2", new_sqlite_classes: ["TillStore"] }
    ]);
    expect(byKey["scheduler"].migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["WakeContainer"] },
      { tag: "v2", new_sqlite_classes: ["FleetControl"] }
    ]);
  });

  it("wires the ops gateway's full binding set with Ops entrypoints and the assets block", () => {
    const ops = byKey["gatekeeper-ops"];
    expect(ops.assets).toEqual({
      directory: `${CHASSIS}/packages/console/dist`,
      binding: "ASSETS",
      not_found_handling: "single-page-application",
      run_worker_first: true
    });
    expect(ops.services).toContainEqual({
      binding: "SPEND",
      service: "operon-gatekeeper-spend",
      entrypoint: "Ops"
    });
    expect(ops.services).toContainEqual({ binding: "SCHEDULER", service: "operon-scheduler" });
    expect(ops.services).toContainEqual({
      binding: "ASKS",
      service: "operon-gatekeeper-asks",
      entrypoint: "Ops"
    });
    expect(ops.services).toHaveLength(13);
    expect(byKey["gatekeeper-github"].routes).toBeUndefined();
    expect(byKey["gatekeeper-x"].routes).toBeUndefined();
    expect(byKey["gatekeeper-asks"].routes).toBeUndefined();
    expect(ops.vars).toEqual({
      ACCESS_TEAM_DOMAIN: "https://floral-shape-360c.cloudflareaccess.com",
      ACCESS_AUD: "885307dbdffd16d85609cecf4cb88f6119ce65a041540315ae9ad26b13d69025",
      CF_ACCOUNT_ID: "85c7962b4a17a841ef0689e0e7c2a050",
      WORKER_NAME_PREFIX: "operon-",
      HOST_PROJECT: "livevariant",
      HOST_ZONE: "livevariant.ai",
      DEFAULT_PROJECT: "livevariant",
      PROJECTS: "[]"
    });
  });

  it("binds the control plane to every enrolled project under <PROJECT>__<BINDING> (spec 0006 §9)", () => {
    const manifest = validateManifest({
      ...RAW,
      control: { default: "second-one", projects: [{ project: "second-one", zone: "second.example" }] }
    });
    const ops = Object.fromEntries(
      renderWorkers(manifest, { chassisDir: CHASSIS }).map(worker => [worker.key, worker.config])
    )["gatekeeper-ops"] as Record<string, unknown> & { services: unknown[]; vars: Record<string, unknown> };
    // The host keeps its bare names; the enrolled project gets the same
    // set under its infix, bound to its own workers by its prefix.
    expect(ops.services).toHaveLength(26);
    expect(ops.services).toContainEqual({
      binding: "SECOND_ONE__EMAIL",
      service: "operon-second-one-gatekeeper-email",
      entrypoint: "Ops"
    });
    expect(ops.services).toContainEqual({
      binding: "SECOND_ONE__SCHEDULER",
      service: "operon-second-one-scheduler"
    });
    expect(ops.services).toContainEqual({ binding: "SCHEDULER", service: "operon-scheduler" });
    expect(ops.vars.DEFAULT_PROJECT).toBe("second-one");
    expect(JSON.parse(ops.vars.PROJECTS as string)).toEqual([
      { project: "second-one", zone: "second.example", workerPrefix: "operon-second-one" }
    ]);
  });

  it("derives the scheduler's crons from the roster, and carries no door URLs (spec 0009)", () => {
    const scheduler = byKey["scheduler"];
    expect(scheduler.triggers).toEqual({ crons: ["0 6,12,18 * * *"] });
    expect(scheduler.vars.NOTIFY_URL).toBeUndefined();
    expect(scheduler.vars.PERSIST_URL).toBeUndefined();
    expect(scheduler.vars.PR_REPOS).toContain("livevariant/operon");
    expect(scheduler.vars.HARNESS_EXTRA_ARGS).toBe(
      JSON.stringify(["--permission-mode", "bypassPermissions", "--output-format", "stream-json", "--verbose"])
    );
    // The outbound proxy table renders from the manifest's egress block:
    // absent by default, placeholders and all (never a credential) when set.
    expect(scheduler.vars.EGRESS_PROXY).toBeUndefined();
    const proxies = { general: { address: "http://general.proxy.example:7777", credential: "PROXY_GENERAL" } };
    const proxy = { "*": "general", "*.registry.example": "direct" };
    const withEgress = renderWorkers(validateManifest({ ...RAW, egress: { proxies, proxy } }), {
      chassisDir: CHASSIS,
      d1DatabaseId: "2dade210-aa9f-463d-903c-b4e4a29ee337",
      siteStoreKvId: "af5f7f9897c6487db5f487ccad85a7aa"
    }).find(worker => worker.key === "scheduler")?.config as Record<string, any>;
    expect(JSON.parse(withEgress.vars.EGRESS_PROXY as string)).toEqual({ proxies, routes: proxy });
    expect(withEgress.vars.EGRESS_BLOCKLIST).toBeUndefined();
  });

  it("renders one egress blocklist to both the browser door and the scheduler", () => {
    const blocklist = ["tracker.example", "*.ads.example"];
    const workers = renderWorkers(validateManifest({ ...RAW, egress: { blocklist } }), {
      chassisDir: CHASSIS,
      d1DatabaseId: "2dade210-aa9f-463d-903c-b4e4a29ee337",
      siteStoreKvId: "af5f7f9897c6487db5f487ccad85a7aa"
    });
    const config = (key: string) => workers.find(worker => worker.key === key)?.config as Record<string, any>;
    expect(config("gatekeeper-browser").vars.WEB_ORIGIN_DENYLIST).toBe("tracker.example,*.ads.example");
    expect(JSON.parse(config("scheduler").vars.EGRESS_BLOCKLIST as string)).toEqual(blocklist);
    // Without a blocklist the browser var is rendered empty and the scheduler has none.
    expect(byKey["gatekeeper-browser"].vars.WEB_ORIGIN_DENYLIST).toBe("");
    expect(byKey["scheduler"].vars.EGRESS_BLOCKLIST).toBeUndefined();
  });

  it("renders the scheduler's container and its Gatekeeper bindings", () => {
    const scheduler = byKey["scheduler"];
    expect(scheduler.containers[0]).toMatchObject({
      class_name: "WakeContainer",
      image: `${CHASSIS}/packages/container/Dockerfile`,
      max_instances: 4,
      // A single step: the fleet is drained before the image rolls, and
      // the driver waits for this rollout, so gradual steps would only
      // hold the pause longer.
      rollout_step_percentage: 100
    });
    // The asks Gatekeeper is bound as ASKS_GK: the umbilical routes the
    // agent's ask door through it, and the name stays clear of the DO
    // binding the asks Worker itself calls ASKS.
    expect(scheduler.services).toContainEqual({
      binding: "ASKS_GK",
      service: "operon-gatekeeper-asks"
    });
    expect(scheduler.services).toHaveLength(14);
  });

  it("merges policy over chassis defaults and derives EMAIL_DOMAIN", () => {
    expect(byKey["gatekeeper-spend"].vars).toMatchObject({
      SPEND_MAX_TX: "0.10",
      SPEND_HOLD_MAX: "250.00",
      SPEND_CHAIN_ID: "4217"
    });
    expect(byKey["gatekeeper-spend"].vars.NOTIFY_URL).toBeUndefined();
    expect(byKey["gatekeeper-email"].vars).toEqual({
      EMAIL_DOMAIN: "livevariant.ai",
      OPERATOR_EMAIL: "michael@krens.nl"
    });
    expect(byKey["gatekeeper-browser"].vars).toEqual({
      CF_ACCOUNT_ID: "85c7962b4a17a841ef0689e0e7c2a050",
      WEB_MAX_CONCURRENT: "3",
      WEB_ORIGIN_DENYLIST: ""
    });
  });

  it("threads the D1 identity everywhere it belongs and nowhere else", () => {
    for (const key of Object.keys(byKey)) {
      const d1 = byKey[key].d1_databases;
      if (key === "gatekeeper-browser") {
        expect(d1).toBeUndefined();
      } else if (key === "scheduler") {
        // The wake_finished mirror binding: CHRONICLE_DB, no migrations
        // dir (the chronicle gatekeeper owns schema migrations).
        expect(d1).toEqual([
          {
            binding: "CHRONICLE_DB",
            database_name: "operon-chronicle",
            database_id: "2dade210-aa9f-463d-903c-b4e4a29ee337"
          }
        ]);
      } else {
        expect(d1).toEqual([
          {
            binding: "CHRONICLE",
            database_name: "operon-chronicle",
            database_id: "2dade210-aa9f-463d-903c-b4e4a29ee337",
            migrations_dir: `${CHASSIS}/packages/chronicle/migrations`
          }
        ]);
      }
    }
  });

  it("marks unresolved resource ids with the placeholder so deploy can refuse them", () => {
    const unresolved = renderWorkers(LIVEVARIANT, { chassisDir: CHASSIS });
    const deploy = unresolved.find(worker => worker.key === "gatekeeper-deploy");
    expect((deploy?.config.kv_namespaces as { id: string }[])[0].id).toBe(D1_PLACEHOLDER);
  });
});

describe("MCP server bindings (spec 0008 §4)", () => {
  // A validated manifest plus MCP defs, assembled the way the fleet
  // does: parseRoster owns the roster half, so reuse LIVEVARIANT's.
  const withMcp = validateManifest({
    project: "livevariant",
    accountId: "85c7962b4a17a841ef0689e0e7c2a050",
    workerPrefix: "operon",
    access: {
      teamDomain: "https://floral-shape-360c.cloudflareaccess.com",
      aud: "885307dbdffd16d85609cecf4cb88f6119ce65a041540315ae9ad26b13d69025"
    },
    resources: { d1Name: "operon-chronicle" },
    zone: LIVEVARIANT.roster.zone,
    mcp: {
      "google-analytics": { type: "gatekeeper", worker: "gatekeeper-google-analytics" },
      linear: { type: "portal", server: "linear" },
      plain: { type: "http", url: "https://mcp.example.com/mcp", auth: "none" }
    },
    agents: LIVEVARIANT.roster.agents.map(agent => ({
      ...agent,
      mcp: ["google-analytics", "linear"]
    }))
  });

  it("binds a bespoke server to its own Worker and every remote to the proxy", () => {
    expect(mcpBindings(withMcp)).toEqual([
      ["MCP_GOOGLE_ANALYTICS", "gatekeeper-google-analytics"],
      ["MCP_GK", "gatekeeper-mcp"]
    ]);
  });

  it("binds nothing when the colony declares no servers", () => {
    expect(mcpBindings(LIVEVARIANT)).toEqual([]);
  });

  it("gives the scheduler those bindings, so a granted host resolves", () => {
    const withServers = renderWorkers(withMcp, { chassisDir: CHASSIS });
    const scheduler = withServers.find(worker => worker.key === "scheduler")!.config as {
      services: Array<{ binding: string; service: string }>;
    };
    // resolveDoor picks these names; they are derived from the same
    // manifest, so the router and the deployment cannot disagree.
    expect(scheduler.services).toContainEqual({
      binding: "MCP_GOOGLE_ANALYTICS",
      service: "operon-gatekeeper-google-analytics"
    });
    expect(scheduler.services).toContainEqual({
      binding: "MCP_GK",
      service: "operon-gatekeeper-mcp"
    });
    const order = (key: string) => DEPLOY_ORDER.indexOf(key as (typeof DEPLOY_ORDER)[number]);
    expect(order("gatekeeper-google-analytics")).toBeLessThan(order("scheduler"));
  });

  it("ships the analytics Worker with no public route: the binding is the auth", () => {
    const withServers = renderWorkers(withMcp, { chassisDir: CHASSIS });
    const ga = withServers.find(worker => worker.key === "gatekeeper-google-analytics")!.config as {
      routes?: unknown;
      vars: Record<string, string>;
    };
    expect(ga.routes).toBeUndefined();
    expect(ga.vars).toEqual({});
  });
});

describe("private by construction (spec 0009)", () => {
  it("renders no hostname for a Gatekeeper the public never needs to reach", () => {
    for (const key of [
      "gatekeeper-github",
      "gatekeeper-pr",
      "gatekeeper-email",
      "gatekeeper-spend",
      "gatekeeper-vault",
      "gatekeeper-chronicle",
      "gatekeeper-x",
      "gatekeeper-asks"
    ]) {
      expect(byKey[key].routes, key).toBeUndefined();
    }
    // The three public surfaces keep theirs.
    expect(byKey["gatekeeper-telegram"].routes).toEqual([{ pattern: "tg.livevariant.ai", custom_domain: true }]);
    expect(byKey["gatekeeper-ops"].routes).toEqual([{ pattern: "ops.livevariant.ai", custom_domain: true }]);
    expect(byKey["gatekeeper-till"].routes?.length).toBeGreaterThan(0);
  });

  it("reaches the public Workers' doors through Door entrypoints, and carries no door URLs", () => {
    const scheduler = byKey["scheduler"];
    expect(scheduler.services).toContainEqual({ binding: "TELEGRAM_DOOR", service: "operon-gatekeeper-telegram", entrypoint: "Door" });
    expect(scheduler.services).toContainEqual({ binding: "DEPLOY_DOOR", service: "operon-gatekeeper-deploy", entrypoint: "Door" });
    expect(scheduler.services).toContainEqual({ binding: "TILL_DOOR", service: "operon-gatekeeper-till", entrypoint: "Door" });
    for (const name of Object.keys(scheduler.vars)) expect(name, name).not.toMatch(/_URL$/);
    for (const key of ["gatekeeper-email", "gatekeeper-spend", "gatekeeper-vault", "gatekeeper-x", "gatekeeper-asks"]) {
      expect(byKey[key].vars?.NOTIFY_URL, key).toBeUndefined();
    }
    // Every worker that alerts the operator holds the binding.
    for (const key of ["gatekeeper-vault", "gatekeeper-x", "gatekeeper-email", "gatekeeper-spend", "gatekeeper-asks"]) {
      expect(byKey[key].services, key).toContainEqual({ binding: "TELEGRAM", service: "operon-gatekeeper-telegram", entrypoint: "TelegramGateway" });
    }
  });

  it("renders the plane without Access vars until bootstrap fills the block", () => {
    const { access: _access, ...withoutAccess } = RAW as Record<string, unknown> & { access: unknown };
    const manifest = validateManifest(withoutAccess);
    expect(manifest.access).toBeUndefined();
    const ops = Object.fromEntries(
      renderWorkers(manifest, { chassisDir: CHASSIS }).map(worker => [worker.key, worker.config])
    )["gatekeeper-ops"] as { vars: Record<string, unknown> };
    expect(ops.vars.ACCESS_AUD).toBeUndefined();
    expect(ops.vars.ACCESS_TEAM_DOMAIN).toBeUndefined();
  });
});
