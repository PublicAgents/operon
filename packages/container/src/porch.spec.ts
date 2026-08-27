import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { capabilities, contentTypeFor, Porch } from "./porch.js";
import type { WakeConfig } from "./config.js";

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

async function startPorch(wakeConfig: WakeConfig, denylist: string[] = []) {
  const stateDir = await mkdtemp(join(tmpdir(), "porch-state-"));
  cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
  const porch = new Porch({
    config: wakeConfig,
    stateDir,
    denylist,
    gitleaksConfig: fileURLToPath(new URL("../gitleaks.toml", import.meta.url)),
    log: () => undefined
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

  it("refuses PR targets off the allowlist", async () => {
    const { url } = await startPorch(
      config({ prUrl: "http://unused", prToken: "b", prRepos: ["org/allowed"] })
    );
    const response = await fetch(`${url}/github/pr`, {
      method: "POST",
      headers: { "x-operon-porch": "1" },
      body: JSON.stringify({ repo: "org/other", title: "t", body: "b" })
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toBe("repo_not_allowlisted");
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
