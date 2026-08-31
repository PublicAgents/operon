import { describe, expect, it } from "vitest";
import { validateManifest } from "./manifest.js";
import { renderWorkers, DEPLOY_ORDER, D1_PLACEHOLDER } from "./templates.js";

/**
 * The golden test: fed the livevariant colony's manifest, the templates
 * must reproduce the hand-written workers/ directory this package
 * retires, fact for load-bearing fact. When this spec and the live
 * colony disagree, the MIGRATION is wrong, not the colony.
 */

const LIVEVARIANT = validateManifest({
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
});

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
    expect(rendered[rendered.length - 1].key).toBe("gatekeeper-ops");
  });

  it("ships the asks Gatekeeper: its own worker, DO, route, and operator-mail binding", () => {
    const asks = byKey["gatekeeper-asks"];
    expect(asks.name).toBe("operon-gatekeeper-asks");
    expect(asks.routes).toEqual([{ pattern: "asks-gk.livevariant.ai", custom_domain: true }]);
    expect(asks.durable_objects.bindings).toEqual([
      { name: "ASKS", class_name: "AskBox" },
      { name: "LEDGER", class_name: "Ledger" }
    ]);
    expect(asks.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["AskBox", "Ledger"] }]);
    // Asks hold no send credential: mail goes through the email
    // Gatekeeper's binding-only operator entrypoint.
    expect(asks.services).toEqual([
      { binding: "EMAIL_OPERATOR", service: "operon-gatekeeper-email", entrypoint: "OperatorMail" }
    ]);
    // Deployed before the scheduler, which carries its door URL.
    expect(rendered.findIndex(w => w.key === "gatekeeper-asks")).toBeLessThan(
      rendered.findIndex(w => w.key === "scheduler")
    );
    expect(byKey["scheduler"].vars.ASKS_URL).toBe("https://asks-gk.livevariant.ai");
  });

  it("keeps the legacy worker names byte-for-byte (renames would orphan DO state)", () => {
    expect(byKey["gatekeeper-spend"].name).toBe("operon-gatekeeper-spend");
    expect(byKey["scheduler"].name).toBe("operon-scheduler");
    expect(byKey["gatekeeper-ops"].name).toBe("operon-gatekeeper-ops");
  });

  it("derives routes from the zone, including the till's apex plus agent hosts", () => {
    expect(byKey["gatekeeper-email"].routes).toEqual([
      { pattern: "email-gk.livevariant.ai", custom_domain: true }
    ]);
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
    expect(ops.vars).toEqual({
      ACCESS_TEAM_DOMAIN: "https://floral-shape-360c.cloudflareaccess.com",
      ACCESS_AUD: "885307dbdffd16d85609cecf4cb88f6119ce65a041540315ae9ad26b13d69025",
      CF_ACCOUNT_ID: "85c7962b4a17a841ef0689e0e7c2a050",
      WORKER_NAME_PREFIX: "operon-"
    });
  });

  it("derives the scheduler's crons from the roster and its URLs from the zone", () => {
    const scheduler = byKey["scheduler"];
    expect(scheduler.triggers).toEqual({ crons: ["0 6,12,18 * * *"] });
    expect(scheduler.vars.NOTIFY_URL).toBe("https://tg.livevariant.ai/notify");
    expect(scheduler.vars.PERSIST_URL).toBe("https://gh-gk.livevariant.ai/commit");
    expect(scheduler.vars.TILL_URL).toBe("https://livevariant.ai");
    expect(scheduler.vars.PR_REPOS).toContain("livevariant/operon");
    expect(scheduler.vars.HARNESS_EXTRA_ARGS).toBe(
      JSON.stringify(["--permission-mode", "bypassPermissions", "--output-format", "stream-json", "--verbose"])
    );
    expect(scheduler.containers[0]).toMatchObject({
      class_name: "WakeContainer",
      image: `${CHASSIS}/packages/container/Dockerfile`,
      max_instances: 4
    });
    expect(scheduler.services).toHaveLength(12);
  });

  it("merges policy over chassis defaults and derives NOTIFY_URL and EMAIL_DOMAIN", () => {
    expect(byKey["gatekeeper-spend"].vars).toMatchObject({
      SPEND_MAX_TX: "0.10",
      SPEND_HOLD_MAX: "250.00",
      SPEND_CHAIN_ID: "4217",
      NOTIFY_URL: "https://tg.livevariant.ai/notify"
    });
    expect(byKey["gatekeeper-email"].vars).toEqual({
      EMAIL_DOMAIN: "livevariant.ai",
      OPERATOR_EMAIL: "michael@krens.nl",
      NOTIFY_URL: "https://tg.livevariant.ai/notify"
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
