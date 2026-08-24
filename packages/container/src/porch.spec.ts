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
    reposDir: join(stateDir, "repos"),
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
          prToken: "pat",
          prRepos: ["a/b"]
        })
      )
    ).toMatchObject({ notify: true, publish: true, pr: true, prRepos: ["a/b"] });
  });
});

describe("porch doors", () => {
  it("answers *_not_wired for doors without wiring", async () => {
    const { url } = await startPorch(config());
    const notify = await fetch(`${url}/notify`, {
      method: "POST",
      body: JSON.stringify({ text: "hi" })
    });
    expect(notify.status).toBe(503);
    expect(((await notify.json()) as { error: string }).error).toBe("notify_not_wired");
    const publish = await fetch(`${url}/publish`, {
      method: "POST",
      body: JSON.stringify({ host: "@" })
    });
    expect(((await publish.json()) as { error: string }).error).toBe("publish_not_wired");
    const pr = await fetch(`${url}/pr`, { method: "POST", body: "{}" });
    expect(((await pr.json()) as { error: string }).error).toBe("pr_not_wired");
  });

  it("forwards notify with the agent prefix and the bearer", async () => {
    const stub = await startStub(() => ({ status: 200, body: "{}" }));
    const { url } = await startPorch(
      config({ notifyUrl: `${stub.url}/notify`, notifyToken: "nt" })
    );
    const response = await fetch(`${url}/notify`, {
      method: "POST",
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
        body: JSON.stringify({ host: "@" })
      });
      expect(blocked.status).toBe(422);
      expect(stub.requests).toHaveLength(0);

      await writeFile(join(stateDir, "site", "index.html"), "<p>autonomous agent page</p>");
      const clean = await fetch(`${url}/publish`, {
        method: "POST",
        body: JSON.stringify({ host: "@" })
      });
      expect(clean.status).toBe(200);
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0]).toContain('"agentId":"growth"');
      expect(stub.requests[0]).toContain('"path":"index.html"');
    }
  );

  it("refuses PR targets off the allowlist", async () => {
    const { url } = await startPorch(config({ prToken: "pat", prRepos: ["org/allowed"] }));
    const response = await fetch(`${url}/clone`, {
      method: "POST",
      body: JSON.stringify({ repo: "org/other" })
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toBe("repo_not_allowlisted");
  });
});

describe("contentTypeFor", () => {
  it("maps known extensions and defaults to octet-stream", () => {
    expect(contentTypeFor("a/index.html")).toContain("text/html");
    expect(contentTypeFor("x.css")).toContain("text/css");
    expect(contentTypeFor("x.bin")).toBe("application/octet-stream");
  });
});
