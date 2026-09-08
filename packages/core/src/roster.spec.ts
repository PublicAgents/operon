import { describe, expect, it } from "vitest";
import { findAgent, parseRoster, RosterError, reachableGithubRepos, registryPrRepo, withRepo } from "./roster.js";

const valid = {
  zone: "example-colony.com",
  agents: [
    {
      id: "growth",
      stateRepo: "example-org/growth-state",
      cadence: "0 6,12,18 * * *",
      harness: "claude-code",
      model: "claude-sonnet-5",
      fallbackModel: "claude-haiku-4-5",
      hosts: ["@", "growth"],
      enabled: true
    }
  ]
};

describe("parseRoster", () => {
  it("parses a valid roster", () => {
    const roster = parseRoster(JSON.stringify(valid));
    expect(roster.zone).toBe("example-colony.com");
    expect(roster.agents).toHaveLength(1);
    expect(roster.agents[0].hosts).toEqual(["@", "growth"]);
  });

  it("rejects non-JSON with a named error", () => {
    expect(() => parseRoster("not json")).toThrowError(RosterError);
    expect(() => parseRoster("not json")).toThrowError(/not valid JSON/);
  });

  it("names the failing field", () => {
    const broken = structuredClone(valid);
    broken.agents[0].stateRepo = "no-slash";
    expect(() => parseRoster(JSON.stringify(broken))).toThrowError(
      /agents\[0\]\.stateRepo/
    );
  });

  it("rejects invalid agent ids", () => {
    const broken = structuredClone(valid);
    broken.agents[0].id = "Bad_Id";
    expect(() => parseRoster(JSON.stringify(broken))).toThrowError(/agents\[0\]\.id/);
  });

  it("rejects invalid hosts", () => {
    const broken = structuredClone(valid);
    broken.agents[0].hosts = ["sub.domain"];
    expect(() => parseRoster(JSON.stringify(broken))).toThrowError(/hosts\[0\]/);
  });

  it("rejects empty hosts", () => {
    const broken = structuredClone(valid);
    broken.agents[0].hosts = [];
    expect(() => parseRoster(JSON.stringify(broken))).toThrowError(/hosts/);
  });

  it("accepts and validates maxWakeMinutes", () => {
    const withWall = structuredClone(valid) as {
      agents: Array<Record<string, unknown>>;
    };
    withWall.agents[0].maxWakeMinutes = 90;
    expect(parseRoster(JSON.stringify(withWall)).agents[0].maxWakeMinutes).toBe(90);

    withWall.agents[0].maxWakeMinutes = 0;
    expect(() => parseRoster(JSON.stringify(withWall))).toThrowError(
      /maxWakeMinutes/
    );
    withWall.agents[0].maxWakeMinutes = "60";
    expect(() => parseRoster(JSON.stringify(withWall))).toThrowError(
      /maxWakeMinutes/
    );
  });

  it("rejects duplicate agent ids", () => {
    const broken = structuredClone(valid);
    broken.agents.push(structuredClone(broken.agents[0]));
    expect(() => parseRoster(JSON.stringify(broken))).toThrowError(/duplicate/);
  });

  it("rejects a missing enabled flag rather than defaulting it", () => {
    const broken = structuredClone(valid) as {
      agents: Array<Record<string, unknown>>;
    };
    delete broken.agents[0].enabled;
    expect(() => parseRoster(JSON.stringify(broken))).toThrowError(/enabled/);
  });
});

describe("findAgent", () => {
  it("finds by id", () => {
    const roster = parseRoster(JSON.stringify(valid));
    expect(findAgent(roster, "growth")?.stateRepo).toBe("example-org/growth-state");
    expect(findAgent(roster, "missing")).toBeUndefined();
  });
});

describe("metered remote servers (spec 0014)", () => {
  const search = {
    type: "http",
    url: "https://search.example/mcp",
    auth: "bearer",
    tools: ["web_search", "web_fetch"],
    budget: { monthlyUsd: 120, perCall: { web_search: 0.02, web_fetch: 0.01 } }
  };
  const tasks = {
    type: "http",
    url: "https://tasks.example/mcp",
    auth: "bearer",
    tools: ["createDeepResearch", "getStatus", "getResultMarkdown"],
    budget: { monthlyUsd: 80, perCall: { createDeepResearch: 2 }, free: ["getStatus", "getResultMarkdown"] },
    webhook: {
      createTools: ["createDeepResearch"],
      argument: "webhook",
      registration: { url: "{url}", event_types: "{events}" },
      events: ["task_run.status"],
      runIdPath: "run_id",
      callbackRunIdPath: "data.run_id",
      callbackEventPath: "type",
      callbackIdPath: "id",
      signature: { header: "X-Signature", scheme: "hmac-sha256-hex", timestampHeader: "X-Timestamp" }
    }
  };
  function withMcp(mcp: Record<string, unknown>): string {
    const roster = structuredClone(valid) as Record<string, unknown> & { agents: Array<Record<string, unknown>> };
    roster.mcp = mcp;
    roster.agents[0].mcp = Object.keys(mcp);
    return JSON.stringify(roster);
  }
  const mutate = (base: Record<string, unknown>, edit: (def: Record<string, unknown>) => void): string => {
    const def = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    edit(def);
    return withMcp({ s: def });
  };

  it("parses a budget and a webhook block on a remote server", () => {
    const parsed = parseRoster(withMcp({ search, tasks }));
    const defs = parsed.mcp as Record<string, { budget?: unknown; webhook?: unknown }>;
    expect(defs.search.budget).toEqual({ monthlyUsd: 120, perCall: { web_search: 0.02, web_fetch: 0.01 } });
    expect(defs.tasks.webhook).toMatchObject({ createTools: ["createDeepResearch"], callbackIdPath: "id" });
    expect(defs.tasks.budget).toMatchObject({ free: ["getStatus", "getResultMarkdown"] });
  });

  it("refuses a budget that cannot govern anything", () => {
    expect(() => parseRoster(mutate(search, d => ((d.budget as Record<string, unknown>).monthlyUsd = 0)))).toThrowError(/positive/);
    expect(() => parseRoster(mutate(search, d => ((d.budget as Record<string, unknown>).perCall = { web_search: -1 })))).toThrowError(/non-negative/);
    expect(() => parseRoster(mutate(search, d => ((d.budget as Record<string, unknown>).free = ["web_search"])))).toThrowError(/priced or free, not both/);
    expect(() => parseRoster(mutate(search, d => ((d.budget as Record<string, unknown>).weekly = 1)))).toThrowError(/not a budget field/);
  });

  it("refuses a webhook contract that cannot register, attribute or verify", () => {
    const wh = (edit: (w: Record<string, unknown>) => void) => mutate(tasks, d => edit(d.webhook as Record<string, unknown>));
    expect(() => parseRoster(wh(w => (w.createTools = ["nope"])))).toThrowError(/not one of this server's tools/);
    expect(() => parseRoster(wh(w => (w.registration = { url: "https://fixed.example" })))).toThrowError(/\{url\}/);
    expect(() => parseRoster(wh(w => (w.registration = { url: "prefix-{url}" })))).toThrowError(/exactly/);
    // Prototype names are tool names here, nothing more.
    const proto = mutate(search, d => ((d.budget as Record<string, unknown>).perCall = { constructor: 0.5, __proto__: 0.1 }));
    const parsedProto = parseRoster(proto).mcp as Record<string, { budget?: { perCall: Record<string, number> } }>;
    expect(Object.hasOwn(parsedProto.s.budget?.perCall ?? {}, "constructor")).toBe(true);
    expect(() => parseRoster(mutate(search, d => ((d.budget as Record<string, unknown>).free = ["constructor"])))).not.toThrow();
    expect(() => parseRoster(wh(w => (w.callbackRunIdPath = "data/run id")))).toThrowError(/dotted path/);
    expect(() => parseRoster(wh(w => ((w.signature as Record<string, unknown>).scheme = "md5")))).toThrowError(/mcp_webhook_scheme_unknown/);
    expect(() => parseRoster(wh(w => delete w.callbackEventPath))).toThrowError(/callbackEventPath/);
    expect(() => parseRoster(wh(w => (w.events = [])))).toThrowError(/at least one event/);
  });

  it("keeps budget and webhook off servers that cannot carry them", () => {
    expect(() =>
      parseRoster(withMcp({ local: { type: "stdio", command: "npx", args: ["-y", "some-mcp@1.2.3"], budget: { monthlyUsd: 1, perCall: {} } } }))
    ).toThrowError(/not a stdio server field/);
  });
});

describe("capability grants (spec 0008)", () => {
  const granted = () => {
    const roster = structuredClone(valid) as Record<string, unknown> & {
      agents: Array<Record<string, unknown>>;
    };
    roster.mcp = {
      "google-analytics": { type: "gatekeeper", worker: "gatekeeper-google-analytics" },
      linear: { type: "portal", server: "linear", tools: ["linear_create_issue"] },
      plain: { type: "http", url: "https://mcp.example.com/mcp", auth: "bearer" },
      somelocal: { type: "stdio", command: "npx", args: ["-y", "some-mcp@1.2.3"] }
    };
    roster.agents[0].mcp = ["google-analytics", "linear"];
    roster.agents[0].github = {
      pr: ["example-org/product"],
      write: ["example-org/product"]
    };
    return roster;
  };

  it("parses every def type and the per-agent grants", () => {
    const roster = parseRoster(JSON.stringify(granted()));
    expect(Object.keys(roster.mcp ?? {})).toHaveLength(4);
    expect(roster.agents[0].mcp).toEqual(["google-analytics", "linear"]);
    expect(roster.agents[0].github?.write).toEqual(["example-org/product"]);
  });

  it("refuses an agent grant naming no defined server", () => {
    const roster = granted();
    (roster.agents[0].mcp as string[]).push("ghost");
    expect(() => parseRoster(JSON.stringify(roster))).toThrowError(/names no server/);
  });

  it("refuses unknown keys in a def instead of dropping them", () => {
    const roster = granted();
    (roster.mcp as Record<string, Record<string, unknown>>).plain.headerSecret = "X";
    expect(() => parseRoster(JSON.stringify(roster))).toThrowError(/headerSecret/);
  });

  it("refuses env on stdio by name: credential-less by construction", () => {
    const roster = granted();
    (roster.mcp as Record<string, Record<string, unknown>>).somelocal.env = { A: "1" };
    expect(() => parseRoster(JSON.stringify(roster))).toThrowError(/stdio_env_unsupported/);
  });

  it("refuses unpinned, range-pinned, and floating stdio packages", () => {
    const withArgs = (args: string[]) => {
      const roster = granted();
      (roster.mcp as Record<string, Record<string, unknown>>).somelocal.args = args;
      return JSON.stringify(roster);
    };
    expect(() => parseRoster(withArgs(["-y", "some-mcp@latest"]))).toThrowError(/floating/);
    expect(() => parseRoster(withArgs(["-y", "some-mcp@^1.2.3"]))).toThrowError(/range/);
    expect(() => parseRoster(withArgs(["-y", "some-mcp@~1.2"]))).toThrowError(/range/);
    expect(() => parseRoster(withArgs(["-y", "some-mcp@next"]))).toThrowError(/floating/);
    // No version at all: nothing pinned anywhere refuses too.
    expect(() => parseRoster(withArgs(["-y", "some-mcp"]))).toThrowError(/no exact version pin/);
    // Partial and wildcard pip specs: ==1.2 is exact per PEP 440 but
    // ==1.2.* floats; the rule demands the unambiguous full form.
    expect(() => parseRoster(withArgs(["run", "analytics-mcp==1.2"]))).toThrowError(
      /no exact version pin/
    );
    expect(() => parseRoster(withArgs(["run", "analytics-mcp==1.2.*"]))).toThrowError(/range/);
    // Exact pins pass, npm and pip shaped, scoped packages included.
    expect(() => parseRoster(withArgs(["-y", "@scope/some-mcp@1.2.3"]))).not.toThrow();
    expect(() => parseRoster(withArgs(["run", "analytics-mcp==1.0.0"]))).not.toThrow();
  });

  it("never grants portal_* tools at any scope", () => {
    const roster = granted();
    (roster.mcp as Record<string, Record<string, unknown>>).linear.tools = ["portal_ls"];
    expect(() => parseRoster(JSON.stringify(roster))).toThrowError(/never grantable/);
  });

  it("refuses portal server ids that prefix one another", () => {
    // "foo" vs "foo_bar": foo_bar_create would ride a grant for foo.
    const roster = granted();
    (roster.mcp as Record<string, unknown>).foo = { type: "portal", server: "foo" };
    (roster.mcp as Record<string, unknown>).foobar = { type: "portal", server: "foo_bar" };
    expect(() => parseRoster(JSON.stringify(roster))).toThrowError(/portal_server_ambiguous/);
  });

  it("refuses malformed github grants and unknown grant keys", () => {
    const roster = granted();
    (roster.agents[0].github as Record<string, unknown>).write = ["not-a-repo"];
    expect(() => parseRoster(JSON.stringify(roster))).toThrowError(/owner\/repo/);
    const roster2 = granted();
    (roster2.agents[0].github as Record<string, unknown>).push = ["a/b"];
    expect(() => parseRoster(JSON.stringify(roster2))).toThrowError(/not a github grant/);
  });

  it("parses review and merge grants and lists the reachable repos", () => {
    const roster = granted();
    roster.agents[0].github = {
      review: ["example-org/registry"],
      merge: [{ repo: "example-org/registry", auto: ["registry/agents/**", "registry/jobs/**"], checks: ["validate"] }]
    };
    const parsed = parseRoster(JSON.stringify(roster));
    expect(parsed.agents[0].github?.review).toEqual(["example-org/registry"]);
    expect(parsed.agents[0].github?.merge).toEqual([
      { repo: "example-org/registry", auto: ["registry/agents/**", "registry/jobs/**"], checks: ["validate"] }
    ]);
    expect(reachableGithubRepos(parsed.agents[0].github)).toEqual(["example-org/registry"]);
    expect(reachableGithubRepos({ pr: ["a/b"], merge: [{ repo: "c/d" }] })).toEqual(["a/b", "c/d"]);
    expect(reachableGithubRepos(undefined)).toEqual([]);
  });

  it("refuses malformed merge grants by name", () => {
    const withMerge = (merge: unknown) => {
      const roster = granted();
      roster.agents[0].github = { merge };
      return JSON.stringify(roster);
    };
    expect(() => parseRoster(withMerge([{ repo: "example-org/registry", automatic: [] }]))).toThrowError(
      /not a merge grant field/
    );
    expect(() => parseRoster(withMerge([{ repo: "registry" }]))).toThrowError(/owner\/repo/);
    expect(() => parseRoster(withMerge([{ repo: "o/r", auto: ["/registry/**"] }]))).toThrowError(/not a path glob/);
    expect(() => parseRoster(withMerge([{ repo: "o/r", auto: ["registry/../site/**"] }]))).toThrowError(
      /not a path glob/
    );
    expect(() => parseRoster(withMerge([{ repo: "o/r", auto: ["registry/**", "a b"] }]))).toThrowError(
      /not a path glob/
    );
    expect(() => parseRoster(withMerge([{ repo: "o/r", checks: [""] }]))).toThrowError(/checks/);
    expect(() => parseRoster(withMerge([{ repo: "o/r" }, { repo: "o/r" }]))).toThrowError(/twice/);
    expect(() => parseRoster(withMerge({ repo: "o/r" }))).toThrowError(/must be an array/);
  });

  it("parses the registry pin and grants its repo to every agent but an adjudicator (spec 0013)", () => {
    const roster = granted();
    roster.registry = { site: "https://public-agents.com/", repo: "PublicAgents/public-agents" };
    roster.agents[0].github = { pr: ["example-org/product"] };
    const parsed = parseRoster(JSON.stringify(roster));
    expect(parsed.registry).toEqual({ site: "https://public-agents.com", repo: "PublicAgents/public-agents" });
    expect(registryPrRepo(parsed, parsed.agents[0])).toBe("PublicAgents/public-agents");
    expect(registryPrRepo(parsed, { github: undefined })).toBe("PublicAgents/public-agents");
    expect(registryPrRepo(parsed, { github: { review: ["PublicAgents/public-agents"] } })).toBeUndefined();
    expect(registryPrRepo(parsed, { github: { merge: [{ repo: "PublicAgents/public-agents" }] } })).toBeUndefined();
    // GitHub repo names are case-insensitive: a respelt grant still adjudicates.
    expect(registryPrRepo(parsed, { github: { review: ["publicagents/PUBLIC-AGENTS"] } })).toBeUndefined();
    expect(registryPrRepo(parsed, { github: { merge: [{ repo: "publicagents/public-agents" }] } })).toBeUndefined();
    expect(withRepo(["publicagents/public-agents"], "PublicAgents/public-agents")).toEqual(["publicagents/public-agents"]);
    expect(withRepo(["org/other"], "PublicAgents/public-agents")).toEqual(["org/other", "PublicAgents/public-agents"]);
    expect(registryPrRepo({ registry: undefined }, parsed.agents[0])).toBeUndefined();
    // Absence means the reference registry; false means none.
    const bare = granted();
    delete (bare as { registry?: unknown }).registry;
    expect(parseRoster(JSON.stringify(bare)).registry).toEqual({ site: "https://public-agents.com", repo: "PublicAgents/public-agents" });
    // An adjudicator gets no default grant, but an explicit listing beside its
    // adjudication grant is the operator's decision and parses; the doors keep
    // the verbs apart at the act.
    for (const github of [
      { pr: ["PublicAgents/public-agents"], review: ["PublicAgents/public-agents"] },
      { pr: ["publicagents/public-agents"], merge: [{ repo: "PublicAgents/public-agents" }] }
    ]) {
      const judge = JSON.parse(JSON.stringify(roster));
      judge.agents[0].github = github;
      const parsedJudge = parseRoster(JSON.stringify(judge));
      expect(registryPrRepo(parsedJudge, parsedJudge.agents[0])).toBeUndefined();
    }
    const off = granted();
    off.registry = false;
    expect(parseRoster(JSON.stringify(off)).registry).toBeUndefined();
    for (const bad of [
      { site: "http://public-agents.com", repo: "a/b" },
      { site: "https://public-agents.com", repo: "nope" },
      { site: "https://public-agents.com", repo: "a/b", extra: 1 },
      "https://public-agents.com"
    ]) {
      const broken = granted();
      broken.registry = bad;
      expect(() => parseRoster(JSON.stringify(broken)), JSON.stringify(bad)).toThrowError(/registry/);
    }
  });

  it("refuses an unknown agent field instead of dropping it", () => {
    const roster = granted();
    roster.agents[0].mpc = ["google-analytics"];
    expect(() => parseRoster(JSON.stringify(roster))).toThrowError(/mpc/);
  });

  it("refuses http urls that are not https", () => {
    const roster = granted();
    (roster.mcp as Record<string, Record<string, unknown>>).plain.url = "http://mcp.example.com";
    expect(() => parseRoster(JSON.stringify(roster))).toThrowError(/https/);
  });
});

describe("the doors baseline (spec 0006 §7)", () => {
  it("accepts named doors with booleans and refuses everything else by name", () => {
    const withDoors = (doors: unknown) =>
      parseRoster(
        JSON.stringify({
          zone: "demo.example",
          agents: [
            {
              id: "a",
              stateRepo: "o/r",
              cadence: "0 6 * * *",
              harness: "claude-code",
              model: "m",
              enabled: true,
              hosts: ["@"],
              doors
            }
          ]
        })
      );
    expect(withDoors({ x: false, pay: true }).agents[0].doors).toEqual({ x: false, pay: true });
    expect(() => withDoors({ persist: false })).toThrow(/is not a door/);
    expect(() => withDoors({ x: "no" })).toThrow(/must be a boolean/);
    expect(() => withDoors(["x"])).toThrow(/mapping/);
  });
});

describe("harnesses (spec 0010 §4)", () => {
  const withHarnesses = (harness: string, harnesses?: unknown) =>
    parseRoster(
      JSON.stringify({
        zone: "demo.example",
        agents: [
          {
            id: "a",
            stateRepo: "o/r",
            cadence: "0 6 * * *",
            harness,
            model: "m",
            enabled: true,
            hosts: ["@"],
            ...(harnesses !== undefined ? { harnesses } : {})
          }
        ]
      })
    );

  it("refuses a primary harness nobody implements, by name", () => {
    expect(() => withHarnesses("gemini")).toThrow(/agents\[0\]\.harness.*not a harness/);
  });

  it("accepts pinned alternates and refuses the primary, unknown harnesses, and unpinned models", () => {
    expect(withHarnesses("claude-code", { codex: { model: "gpt-5.5", fallbackModel: "gpt-5.5-mini" } }).agents[0].harnesses)
      .toEqual({ codex: { model: "gpt-5.5", fallbackModel: "gpt-5.5-mini" } });
    expect(withHarnesses("claude-code").agents[0].harnesses).toBeUndefined();
    expect(() => withHarnesses("claude-code", { "claude-code": { model: "x" } })).toThrow(/is the primary harness/);
    expect(() => withHarnesses("claude-code", { gemini: { model: "x" } })).toThrow(/is not a harness/);
    expect(() => withHarnesses("claude-code", { codex: {} })).toThrow(/harnesses\.codex\.model/);
    expect(() => withHarnesses("claude-code", { codex: { model: "x", image: "y" } })).toThrow(/not a harness pin field/);
    expect(() => withHarnesses("claude-code", ["codex"])).toThrow(/mapping/);
  });
});

describe("the local browser flag (spec 0004 §9)", () => {
  it("is on by default, boolean, and recorded only when an agent opts out", () => {
    const parse = (localBrowser?: unknown) =>
      parseRoster(
        JSON.stringify({
          zone: "demo.example",
          agents: [
            { id: "a", stateRepo: "o/r", cadence: "0 6 * * *", harness: "claude-code", model: "m", enabled: true, hosts: ["@"], ...(localBrowser !== undefined ? { localBrowser } : {}) }
          ]
        })
      ).agents[0];
    expect(parse().localBrowser).toBeUndefined();
    expect(parse(true).localBrowser).toBeUndefined();
    expect(parse(false).localBrowser).toBe(false);
    expect(() => parse("yes")).toThrow(/localBrowser.*boolean/);
  });
});

describe("chassis MCP server names (spec 0004 §3, §9)", () => {
  it("refuses a colony server named after a chassis-staged one, by name, at check time", () => {
    const withMcp = (name: string) =>
      parseRoster(
        JSON.stringify({
          zone: "demo.example",
          mcp: { [name]: { type: "http", url: "https://mcp.example.com/mcp", auth: "none" } },
          agents: [{ id: "a", stateRepo: "o/r", cadence: "0 6 * * *", harness: "claude-code", model: "m", enabled: true, hosts: ["@"] }]
        })
      );
    expect(() => withMcp("playwright")).toThrow(/mcp\.playwright.*chassis server name/);
    expect(() => withMcp("browser")).toThrow(/mcp\.browser.*reserved/);
    expect(Object.keys(withMcp("docs").mcp ?? {})).toEqual(["docs"]);
  });
});
