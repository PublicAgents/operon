import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { capabilities, contentTypeFor, Porch } from "./porch.js";
import type { WakeConfig } from "./config.js";
import { DEFAULT_EGRESS_ROUTES } from "./egress-proxy.js";

const hasGitleaks = (() => {
  try {
    execFileSync("gitleaks", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function config(overrides: Partial<WakeConfig> = {}): WakeConfig {
  return {
    wakeId: "w1",
    agentId: "growth",
    trigger: "manual",
    stateRepo: "org/growth-state",
    harness: "claude-code",
    model: "m",
    githubToken: "gh",
    mindCredential: "mind",
    secretDenylist: [],
    harnessExtraArgs: [],
    maxWakeMinutes: 120,
    hosts: ["@"],
    prRepos: [],
    mcpServers: [],
    egressProxy: DEFAULT_EGRESS_ROUTES,
    egressBlocklist: [],
    ...overrides
  };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function startStub(
  handler: (body: string) => { status: number; body: string }
): Promise<{ url: string; requests: string[] }> {
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    let data = "";
    request.on("data", chunk => (data += chunk));
    request.on("end", () => {
      requests.push(data);
      const result = handler(data);
      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(result.body);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise(resolve => server.close(() => resolve())));
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no address");
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

async function startPorch(
  wakeConfig: WakeConfig,
  denylist: string[] = [],
  pullFresh?: () => Promise<void>,
  drainAnnouncements?: () => { mail: number; dms: number; channel: boolean; asks: string[] }
) {
  const stateDir = await mkdtemp(join(tmpdir(), "porch-state-"));
  cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
  const porch = new Porch({
    config: wakeConfig,
    stateDir,
    denylist,
    gitleaksConfig: fileURLToPath(new URL("../gitleaks.toml", import.meta.url)),
    log: () => undefined,
    ...(pullFresh ? { pullFresh } : {}),
    ...(drainAnnouncements ? { drainAnnouncements } : {})
  });
  const url = await porch.start(0);
  cleanups.push(() => porch.close());
  return { porch, url, stateDir };
}

describe("capabilities", () => {
  it("reflects exactly what is wired", () => {
    expect(capabilities(config())).toMatchObject({
      notify: false,
      publish: false,
      pr: false,
      hosts: ["@"]
    });
    expect(
      capabilities(
        config({
          notifyUrl: "http://x",
          notifyToken: "t",
          publishUrl: "http://y",
          publishToken: "p",
          prUrl: "http://z",
          prToken: "b",
          prRepos: ["a/b"]
        })
      )
    ).toMatchObject({ notify: true, publish: true, pr: true, github: true, prRepos: ["a/b"] });
  });
});

describe("the browser boundary", () => {
  it("refuses requests without the porch header and never approves preflights", async () => {
    const { url } = await startPorch(config());
    // What a browser page's cross-origin fetch would actually send first:
    const preflight = await fetch(`${url}/notify`, { method: "OPTIONS" });
    expect(preflight.status).toBe(403);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    // And a simple (headerless) request is refused outright.
    const bare = await fetch(`${url}/notify`, { method: "POST", body: "{}" });
    expect(bare.status).toBe(403);
    expect(((await bare.json()) as { error: string }).error).toBe("porch_header_missing");
  });
});

describe("porch doors", () => {
  it("answers *_not_wired for doors without wiring", async () => {
    const { url } = await startPorch(config());
    const notify = await fetch(`${url}/notify`, {
      method: "POST",
      headers: { "x-operon-porch": "1" },
      body: JSON.stringify({ text: "hi" })
    });
    expect(notify.status).toBe(503);
    expect(((await notify.json()) as { error: string }).error).toBe("notify_not_wired");
    const publish = await fetch(`${url}/publish`, {
      method: "POST",
      headers: { "x-operon-porch": "1" },
      body: JSON.stringify({ host: "@" })
    });
    expect(((await publish.json()) as { error: string }).error).toBe("publish_not_wired");
    const pr = await fetch(`${url}/github/pr`, { method: "POST", headers: { "x-operon-porch": "1" }, body: "{}" });
    expect(((await pr.json()) as { error: string }).error).toBe("pr_not_wired");
    const thread = await fetch(`${url}/github/thread`, {
      method: "POST",
      headers: { "x-operon-porch": "1" },
      body: JSON.stringify({ repo: "a/b", number: 1 })
    });
    expect(((await thread.json()) as { error: string }).error).toBe("thread_not_wired");
  });

  it.skipIf(!hasGitleaks)(
    "gitleaks examines only added lines of an existing upstream file; the denylist sees everything",
    async () => {
      // Upstream contains someone else's entry that trips a generic
      // gitleaks pattern (a token-shaped string), the operon#11 case. The
      // stub answers upstream-file lookups; PR submissions get an ok.
      const foreign = 'other entry token ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 text';
      const stub = await startStub(body => {
        if (body.includes('"path"')) {
          const upstream = `# list\n${foreign}\nend`;
          return {
            status: 200,
            body: JSON.stringify({
              ok: true,
              exists: true,
              contentBase64: Buffer.from(upstream, "utf8").toString("base64")
            })
          };
        }
        return { status: 200, body: '{"ok":true,"url":"https://github.com/x/pull/1"}' };
      });
      const { url, stateDir } = await startPorch(
        config({ prUrl: `${stub.url}/gatekeeper/pr`, prToken: "t", prRepos: ["a/b"] }),
        ["super-secret-token"]
      );
      await mkdir(join(stateDir, "pr"));

      // A clean one-line addition beside the foreign token-shaped entry
      // passes: gitleaks only examines the added line.
      await writeFile(
        join(stateDir, "pr", "README.md"),
        `# list\n${foreign}\n- clean new entry\nend`
      );
      const ok = await fetch(`${url}/github/pr`, {
        method: "POST",
        headers: { "x-operon-porch": "1" },
        body: JSON.stringify({ repo: "a/b", title: "add entry", body: "adds one line" })
      });
      expect(ok.status).toBe(200);

      // An added line that itself trips gitleaks is still blocked.
      await writeFile(
        join(stateDir, "pr", "README.md"),
        `# list\n${foreign}\n- new token ghp_Zz9dEfGhIjKlMnOpQrStUvWxYz9876543210 x\nend`
      );
      const leaked = await fetch(`${url}/github/pr`, {
        method: "POST",
        headers: { "x-operon-porch": "1" },
        body: JSON.stringify({ repo: "a/b", title: "add entry", body: "adds one line" })
      });
      expect(leaked.status).toBe(422);
      expect(((await leaked.json()) as { error: string }).error).toBe("blocked_by_gitleaks");

      // The denylist scan still sees the FULL file: a denylisted secret
      // split between an unchanged upstream line and an added completion
      // is caught even though neither reduced line alone contains it.
      await writeFile(
        join(stateDir, "pr", "README.md"),
        `# list\n${foreign}\n- entry super-secr\net-token completes\nend`
      );
      const split = await fetch(`${url}/github/pr`, {
        method: "POST",
        headers: { "x-operon-porch": "1" },
        body: JSON.stringify({ repo: "a/b", title: "add entry", body: "adds one line" })
      });
      expect(split.status).toBe(422);
      expect(((await split.json()) as { error: string }).error).toBe("blocked_by_sweep");
    }
  );

  it("sweeps short outbound text fields, not only bodies and files", async () => {
    const { url } = await startPorch(
      config({ prUrl: "http://never-reached", prToken: "t", prRepos: ["a/b"] }),
      ["super-secret-token"]
    );
    const blocked = await fetch(`${url}/github/update`, {
      method: "POST",
      headers: { "x-operon-porch": "1" },
      body: JSON.stringify({ repo: "a/b", number: 1, title: "deploy super-secret-token" })
    });
    expect(blocked.status).toBe(422);
    expect(((await blocked.json()) as { error: string }).error).toBe("blocked_by_sweep");
    const message = await fetch(`${url}/github/push`, {
      method: "POST",
      headers: { "x-operon-porch": "1" },
      body: JSON.stringify({ repo: "a/b", number: 1, message: "carry super-secret-token", dir: "pr" })
    });
    expect(((await message.json()) as { error: string }).error).toBe("blocked_by_sweep");
  });

  it("sweeps the email recipient, subject, and body", async () => {
    const { url } = await startPorch(
      config({ emailUrl: "http://never-reached", emailToken: "t" }),
      ["super-secret-token"]
    );
    const viaRecipient = await fetch(`${url}/email`, {
      method: "POST",
      headers: { "x-operon-porch": "1" },
      body: JSON.stringify({ to: "super-secret-token@x.com", subject: "hi", text: "hello" })
    });
    expect(viaRecipient.status).toBe(422);
    expect(((await viaRecipient.json()) as { error: string }).error).toBe("blocked_by_sweep");
  });

  it("till doors answer not_wired without config and forward with the bearer", async () => {
    const { url } = await startPorch(config());
    const closed = await fetch(`${url}/till/sales`, { method: "POST", headers: { "x-operon-porch": "1" }, body: "{}" });
    expect(((await closed.json()) as { error: string }).error).toBe("till_not_wired");

    const stub = await startStub(() => ({ status: 200, body: '{"ok":true,"offers":[],"sales":[]}' }));
    const { url: wired } = await startPorch(
      config({ tillUrl: stub.url, tillToken: "agent-own-bearer" })
    );
    const sales = await fetch(`${wired}/till/sales`, { method: "POST", headers: { "x-operon-porch": "1" }, body: "{}" });
    expect(sales.status).toBe(200);
    expect(stub.requests).toHaveLength(1);
  });

  it("forwards notify with the agent prefix and the bearer", async () => {
    const stub = await startStub(() => ({ status: 200, body: "{}" }));
    const { url } = await startPorch(
      config({ notifyUrl: `${stub.url}/notify`, notifyToken: "nt" })
    );
    const response = await fetch(`${url}/notify`, {
      method: "POST",
      headers: { "x-operon-porch": "1" },
      body: JSON.stringify({ text: "hello operator" })
    });
    expect(response.status).toBe(200);
    expect(stub.requests[0]).toContain("[growth] hello operator");
  });

  it("refuses publishing to an unassigned host before reading anything", async () => {
    const { url } = await startPorch(
      config({ publishUrl: "http://unused", publishToken: "p", hosts: ["@"] })
    );
    const response = await fetch(`${url}/publish`, {
      method: "POST",
      headers: { "x-operon-porch": "1" },
      body: JSON.stringify({ host: "other" })
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toBe("host_not_assigned");
  });

  it.skipIf(!hasGitleaks)(
    "sweeps the payload and blocks a denylisted literal before upload",
    async () => {
      const stub = await startStub(() => ({ status: 200, body: '{"ok":true}' }));
      const { url, stateDir } = await startPorch(
        config({ publishUrl: `${stub.url}/gk`, publishToken: "p", hosts: ["@"] }),
        ["super-secret-token"]
      );
      await mkdir(join(stateDir, "site"));
      await writeFile(
        join(stateDir, "site", "index.html"),
        "<p>autonomous agent page with super-secret-token</p>"
      );
      const blocked = await fetch(`${url}/publish`, {
        method: "POST",
        headers: { "x-operon-porch": "1" },
        body: JSON.stringify({ host: "@" })
      });
      expect(blocked.status).toBe(422);
      expect(stub.requests).toHaveLength(0);

      await writeFile(join(stateDir, "site", "index.html"), "<p>autonomous agent page</p>");
      const clean = await fetch(`${url}/publish`, {
        method: "POST",
        headers: { "x-operon-porch": "1" },
        body: JSON.stringify({ host: "@" })
      });
      expect(clean.status).toBe(200);
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0]).toContain('"agentId":"growth"');
      expect(stub.requests[0]).toContain('"path":"index.html"');
    }
  );

  it("refuses PR targets the agent was not granted", async () => {
    const { url } = await startPorch(
      config({ prUrl: "http://unused", prToken: "b", prRepos: ["org/allowed"] })
    );
    const response = await fetch(`${url}/github/pr`, {
      method: "POST",
      headers: { "x-operon-porch": "1" },
      body: JSON.stringify({ repo: "org/other", title: "t", body: "b" })
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toBe("repo_not_granted");
  });

  it("prefers the per-agent grant over the fleet list, and refuses outside it", async () => {
    // The fleet list still names org/allowed; this agent's own grant
    // does not, so the grant is what binds (spec 0008 §3).
    const { url } = await startPorch(
      config({
        prUrl: "http://unused",
        prToken: "b",
        prRepos: ["org/allowed"],
        githubGrants: { pr: ["org/mine"], write: [], review: [], merge: [] }
      })
    );
    const refused = await fetch(`${url}/github/pr`, {
      method: "POST",
      headers: { "x-operon-porch": "1" },
      body: JSON.stringify({ repo: "org/allowed", title: "t", body: "b" })
    });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { detail: string }).detail).toContain("org/mine");
  });

  it("an explicit empty grant means nothing, not the fleet list", async () => {
    // The Gatekeeper reads github.pr: [] as "granted nothing"; the
    // container must agree, or it admits what the Gatekeeper refuses.
    const { url } = await startPorch(
      config({
        prUrl: "http://unused",
        prToken: "b",
        prRepos: ["org/allowed"],
        githubGrants: { pr: [], write: [], review: [], merge: [] }
      })
    );
    const response = await fetch(`${url}/github/pr`, {
      method: "POST",
      headers: { "x-operon-porch": "1" },
      body: JSON.stringify({ repo: "org/allowed", title: "t", body: "b" })
    });
    expect(((await response.json()) as { error: string }).error).toBe("pr_not_wired");
  });

  it("pre-checks the review and merge grants and forwards what passes (spec 0012 §9)", async () => {
    const stub = await startStub(() => ({ status: 200, body: '{"ok":true,"status":"reviewed"}' }));
    const { url } = await startPorch(
      config({
        prUrl: `${stub.url}/gatekeeper/pr`,
        prToken: "b",
        githubGrants: { pr: [], write: [], review: ["org/registry"], merge: ["org/registry"] }
      })
    );
    const post = (door: string, body: Record<string, unknown>) =>
      fetch(`${url}/github/${door}`, { method: "POST", headers: { "x-operon-porch": "1" }, body: JSON.stringify(body) });

    const notReviewable = await post("review", { repo: "org/other", number: 3, verdict: "approve" });
    expect(notReviewable.status).toBe(403);
    expect(((await notReviewable.json()) as { error: string }).error).toBe("review_not_granted");
    const badVerdict = await post("review", { repo: "org/registry", number: 3, verdict: "lgtm" });
    expect(((await badVerdict.json()) as { error: string }).error).toBe("invalid_verdict");
    const notMergeable = await post("merge", { repo: "org/other", number: 3 });
    expect(((await notMergeable.json()) as { error: string }).error).toBe("merge_not_granted");
    const noReason = await post("close", { repo: "org/registry", number: 3, reason: " " });
    expect(((await noReason.json()) as { error: string }).error).toBe("missing_reason");
    const noBody = await post("review", { repo: "org/registry", number: 3, verdict: "request_changes" });
    expect(((await noBody.json()) as { error: string }).error).toBe("missing_body");
    const twoBodies = await post("review", { repo: "org/registry", number: 3, verdict: "comment", body: "a", bodyFile: "b.md" });
    expect(((await twoBodies.json()) as { error: string }).error).toBe("ambiguous_body");
    expect(stub.requests).toHaveLength(0);

    const approved = await post("review", { repo: "org/registry", number: 3, verdict: "approve" });
    expect(approved.status).toBe(200);
    expect(JSON.parse(stub.requests[0])).toEqual({ agentId: "growth", repo: "org/registry", number: 3, verdict: "approve" });
    await post("merge", { repo: "org/registry", number: 3 });
    expect(JSON.parse(stub.requests[1])).toEqual({ agentId: "growth", repo: "org/registry", number: 3 });
    await post("close", { repo: "org/registry", number: 3, reason: "spam" });
    expect(JSON.parse(stub.requests[2])).toEqual({ agentId: "growth", repo: "org/registry", number: 3, reason: "spam" });
  });

  it("refuses a branch commit to a repo with no write grant, without a round trip", async () => {
    const { url } = await startPorch(
      config({
        persistUrl: "http://unused/commit",
        persistToken: "b",
        githubGrants: { pr: ["org/mine"], write: ["org/mine"], review: [], merge: [] }
      })
    );
    const response = await fetch(`${url}/github/branch`, {
      method: "POST",
      headers: { "x-operon-porch": "1" },
      body: JSON.stringify({ repo: "org/other", branch: "wip", message: "m" })
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string; detail: string };
    expect(body.error).toBe("write_not_granted");
    expect(body.detail).toContain("org/mine");
  });

  it.skipIf(!hasGitleaks)(
    "sweeps a PR payload and forwards it to the PR Gatekeeper as data",
    async () => {
      const stub = await startStub(() => ({
        status: 200,
        body: JSON.stringify({ ok: true, url: "https://github.com/org/allowed/pull/1" })
      }));
      const { url, stateDir } = await startPorch(
        config({ prUrl: `${stub.url}/gk`, prToken: "b", prRepos: ["org/allowed"] }),
        ["super-secret-token"]
      );
      await mkdir(join(stateDir, "pr"));
      await writeFile(join(stateDir, "pr", "server.json"), '{"leak":"super-secret-token"}');
      const blocked = await fetch(`${url}/github/pr`, {
        method: "POST",
        headers: { "x-operon-porch": "1" },
        body: JSON.stringify({ repo: "org/allowed", title: "add", body: "please" })
      });
      expect(blocked.status).toBe(422);
      // The door may look up upstream file versions (repo+path only) to
      // scope the sweep, but no PR payload may have left the container.
      expect(stub.requests.filter(request => request.includes('"files"'))).toHaveLength(0);

      await writeFile(join(stateDir, "pr", "server.json"), '{"name":"clean"}');
      const good = await fetch(`${url}/github/pr`, {
        method: "POST",
        headers: { "x-operon-porch": "1" },
        body: JSON.stringify({ repo: "org/allowed", title: "add", body: "please" })
      });
      expect(good.status).toBe(200);
      // Among the requests (upstream lookups + submission), exactly one is
      // the PR payload, carrying data and never a github credential.
      const submissions = stub.requests.filter(request => request.includes('"files"'));
      expect(submissions).toHaveLength(1);
      expect(submissions[0]).toContain('"repo":"org/allowed"');
      expect(submissions[0]).toContain('"path":"server.json"');
      expect(submissions[0]).not.toContain("super-secret-token");
    }
  );
});

describe("contentTypeFor", () => {
  it("maps known extensions and defaults to octet-stream", () => {
    expect(contentTypeFor("a/index.html")).toContain("text/html");
    expect(contentTypeFor("x.css")).toContain("text/css");
    expect(contentTypeFor("x.bin")).toBe("application/octet-stream");
  });
});

describe("the living help and the mid-wake pull", () => {
  it("serves the skills guide rendered from this wake's real wiring", async () => {
    const { url } = await startPorch(config({ notifyUrl: "http://t", notifyToken: "n" }));
    const response = await fetch(`${url}/help`, { headers: { "x-operon-porch": "1" } });
    const body = (await response.json()) as { ok: boolean; help: string };
    expect(body.ok).toBe(true);
    // Task-first guidance including the mid-wake pull...
    expect(body.help).toContain("operon pull");
    expect(body.help).toContain("one pull away, not one wake away");
    // ...and honest live/not-wired marks: notify is wired, vault is not.
    expect(body.help).toMatch(/operon notify[\s\S]{0,120}message the operator(?![\s\S]{0,40}NOT WIRED)/);
    expect(body.help).toMatch(/operon vault set[^\n]*NOT WIRED/);
  });

  it("answers pull_not_wired when the entrypoint wired no refresher", async () => {
    const { url } = await startPorch(config());
    const response = await fetch(`${url}/pull`, {
      method: "POST",
      headers: { "x-operon-porch": "1", "content-type": "application/json" },
      body: "{}"
    });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toBe("pull_not_wired");
  });

  it("shares the run and announces each delivery exactly once, to a live caller", async () => {
    // The entrypoint contract in miniature: runs deposit freshness into a
    // buffer; the drain hands it to exactly one caller. Overlapping pulls
    // share one run (calls stays 1), one of them drains the counts, the
    // other truthfully hears nothing new; a later pull with an empty
    // buffer also hears nothing new.
    let calls = 0;
    const buffer = { mail: 0, dms: 0, channel: false, asks: [] as string[] };
    let shared: Promise<void> | null = null;
    const { url } = await startPorch(
      config(),
      [],
      () => {
        if (!shared) {
          shared = (async () => {
            calls += 1;
            buffer.mail += 1;
          })();
        }
        return shared;
      },
      () => {
        const out = { ...buffer, asks: [...buffer.asks] };
        buffer.mail = 0;
        buffer.dms = 0;
        buffer.channel = false;
        buffer.asks = [];
        return out;
      }
    );
    const request = () =>
      fetch(`${url}/pull`, {
        method: "POST",
        headers: { "x-operon-porch": "1", "content-type": "application/json" },
        body: "{}"
      }).then(response => response.json() as Promise<Record<string, unknown>>);
    const bodies = await Promise.all([request(), request()]);
    expect(calls).toBe(1);
    const mails = bodies.map(body => body.mail).sort();
    expect(mails).toEqual([0, 1]);
    for (const body of bodies) expect(body).toMatchObject({ ok: true });
  });
});

describe("the ask door", () => {
  it("sweeps every field the operator will read, before it leaves", async () => {
    const stub = await startStub(() => ({ status: 200, body: '{"ok":true}' }));
    const { url } = await startPorch(
      config({ asksUrl: stub.url, asksToken: "ask-bearer" }),
      ["hunter2"]
    );
    const post = (path: string, body: unknown) =>
      fetch(`${url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-operon-porch": "1" },
        body: JSON.stringify(body)
      });

    const leakyBody = await post("/ask/create", {
      kind: "decision",
      title: "may I",
      body: "the key is hunter2",
      links: []
    });
    expect(leakyBody.status).toBe(422);
    const leakyTitle = await post("/ask/create", {
      kind: "decision",
      title: "hunter2 in the title",
      body: "safe",
      links: []
    });
    expect(leakyTitle.status).toBe(422);
    const leakyLink = await post("/ask/create", {
      kind: "decision",
      title: "safe",
      body: "safe",
      links: ["https://example.com/?token=hunter2"]
    });
    expect(leakyLink.status).toBe(422);
    const leakyReply = await post("/ask/reply", { askId: "a1", text: "it was hunter2" });
    expect(leakyReply.status).toBe(422);
    const leakyReason = await post("/ask/retract", { askId: "a1", text: "hunter2" });
    expect(leakyReason.status).toBe(422);
    // Nothing swept-out ever reached the Gatekeeper.
    expect(stub.requests).toEqual([]);

    const clean = await post("/ask/create", {
      kind: "decision",
      title: "may I pay the invoice",
      body: "it is 20 USD and due friday",
      links: ["https://example.com/invoice"]
    });
    expect(clean.status).toBe(200);
    expect(JSON.parse(stub.requests[0])).toEqual({
      kind: "decision",
      title: "may I pay the invoice",
      body: "it is 20 USD and due friday",
      links: ["https://example.com/invoice"]
    });
  });

  it("passes the Gatekeeper's own refusal through, cap and all", async () => {
    const stub = await startStub(() => ({
      status: 429,
      body: JSON.stringify({
        ok: false,
        error: "asks_wake_cap",
        detail: "10 of 10 asks already filed this wake; consolidate the rest into one"
      })
    }));
    const { url } = await startPorch(config({ asksUrl: stub.url, asksToken: "ask-bearer" }));
    const response = await fetch(`${url}/ask/create`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-operon-porch": "1" },
      body: JSON.stringify({ kind: "question", title: "one more", body: "please", links: [] })
    });
    expect(response.status).toBe(429);
    const body = (await response.json()) as { gatekeeper: { error: string; detail: string } };
    // The mind must see WHICH bound it hit and how many it has filed,
    // or it cannot consolidate; a flattened porch error would hide it.
    expect(body.gatekeeper.error).toBe("asks_wake_cap");
    expect(body.gatekeeper.detail).toContain("10 of 10");
  });

  it("answers ask_not_wired when the door is closed", async () => {
    const { url } = await startPorch(config());
    const response = await fetch(`${url}/ask/list`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-operon-porch": "1" },
      body: "{}"
    });
    expect(response.status).toBe(503);
    expect((await response.json()) as { error: string }).toMatchObject({ error: "ask_not_wired" });
  });
});

describe("the telemetry relay (spec 0011 §4)", () => {
  it("forwards an OTLP payload to the chronicle door with the chronicle bearer, redacted", async () => {
    const stub = await startStub(() => ({ status: 200, body: "{}" }));
    const { url } = await startPorch(
      config({ chronicleUrl: stub.url, chronicleToken: "chronicle-bearer" }),
      ["hunter2"]
    );
    const payload = JSON.stringify({
      resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: { stringValue: "token hunter2 seen" } }] }] }]
    });
    const response = await fetch(`${url}/otel/v1/logs`, {
      method: "POST",
      headers: { "x-operon-porch": "1", "content-type": "application/json" },
      body: payload
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]).toContain("[redacted]");
    expect(stub.requests[0]).not.toContain("hunter2");
  });

  it("refuses without a chronicle door, without the porch header, and for a non-JSON body", async () => {
    const unwired = await startPorch(config());
    const none = await fetch(`${unwired.url}/otel/v1/traces`, { method: "POST", headers: { "x-operon-porch": "1" }, body: "{}" });
    expect(((await none.json()) as { error: string }).error).toBe("otel_not_wired");
    const stub = await startStub(() => ({ status: 200, body: "{}" }));
    const { url } = await startPorch(config({ chronicleUrl: stub.url, chronicleToken: "t" }));
    const noHeader = await fetch(`${url}/otel/v1/traces`, { method: "POST", body: "{}" });
    expect(noHeader.status).toBe(403);
    const notJson = await fetch(`${url}/otel/v1/metrics`, { method: "POST", headers: { "x-operon-porch": "1" }, body: "protobuf" });
    expect(((await notJson.json()) as { error: string }).error).toBe("otel_not_json");
    expect(stub.requests).toHaveLength(0);
  });
});
