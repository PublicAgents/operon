import { createServer, type IncomingMessage, type Server } from "node:http";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { runCapture } from "./exec.js";
import { cleanPushToGithub, gitCredentialEnv, githubRepoUrl, hardenedGitFlags } from "./git-cred.js";
import { runGitleaks } from "./gitleaks.js";
import { scanForSecrets, type ChangedFile } from "./presleep.js";
import type { WakeConfig } from "./config.js";

/**
 * The porch: a loopback-only HTTP server the entrypoint runs for the
 * duration of the mind session. It is how a wake reaches the Gatekeepers
 * without any credential entering the session environment: the entrypoint
 * holds the tokens, the session holds only the porch's localhost address
 * (OPERON_PORCH, not a secret), and the `operon` CLI is a thin client.
 *
 * Doors, each present only when its wiring exists:
 *  - notify: message the operator through the telegram Gatekeeper.
 *  - publish: submit a directory of static files for one assigned host;
 *    swept here (denylist variants + gitleaks) BEFORE anything leaves the
 *    container, then re-checked by the publish Gatekeeper.
 *  - clone/pr: fork-based pull requests through the machine user. Every
 *    credentialed git operation is hardened (see git-cred.ts): the token
 *    exists only in the git child's environment, never on argv, on disk,
 *    or in the session env; hooks and repo-config execution vectors are
 *    disabled; targets are allowlisted by deployment config.
 */

export const PORCH_PORT = 41414;

const MAX_PUBLISH_FILES = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  return (dot >= 0 && CONTENT_TYPES[path.slice(dot)]) || "application/octet-stream";
}

export interface PorchContext {
  config: WakeConfig;
  stateDir: string;
  /** Where mind-editable PR clones live (mind-owned). */
  reposDir: string;
  /** Root-only (0700) base for clean-push mirrors; the mind cannot enter it. */
  mirrorsDir: string;
  /** The auto-denylist the presleep gate uses; the publish sweep shares it. */
  denylist: string[];
  /** Overrides the image's gitleaks config path (tests run outside the image). */
  gitleaksConfig?: string;
  /** Hands ownership of a path to the session user (no-op outside the image). */
  chownForSession(path: string): Promise<void>;
  log(message: string): void;
}

interface JsonResult {
  status: number;
  body: Record<string, unknown>;
}

function ok(body: Record<string, unknown> = {}): JsonResult {
  return { status: 200, body: { ok: true, ...body } };
}

function fail(status: number, error: string, detail?: string): JsonResult {
  return { status, body: { ok: false, error, ...(detail ? { detail } : {}) } };
}

export function capabilities(config: WakeConfig): Record<string, unknown> {
  return {
    notify: Boolean(config.notifyUrl && config.notifyToken),
    publish: Boolean(config.publishUrl && config.publishToken),
    pr: Boolean(config.prToken && config.prRepos.length > 0),
    hosts: config.hosts,
    prRepos: config.prRepos
  };
}

async function collectDir(root: string): Promise<{ path: string; bytes: Buffer }[]> {
  const out: { path: string; bytes: Buffer }[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push({ path: relative(root, full), bytes: await readFile(full) });
    }
  }
  await walk(root);
  return out;
}

export class Porch {
  private server: Server | null = null;
  private machineUser: string | null = null;

  constructor(private readonly context: PorchContext) {}

  async start(port = PORCH_PORT): Promise<string> {
    this.server = createServer((request, response) => {
      void this.route(request).then(result => {
        response.writeHead(result.status, { "content-type": "application/json" });
        response.end(JSON.stringify(result.body));
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(port, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    const boundPort =
      typeof address === "object" && address !== null ? address.port : port;
    return `http://127.0.0.1:${boundPort}`;
  }

  async close(): Promise<void> {
    await new Promise<void>(resolve => this.server?.close(() => resolve()));
  }

  private async route(request: IncomingMessage): Promise<JsonResult> {
    const url = new URL(request.url ?? "/", "http://porch");
    try {
      if (request.method === "GET" && url.pathname === "/capabilities") {
        return ok(capabilities(this.context.config));
      }
      const body = request.method === "POST" ? await readBody(request) : {};
      if (request.method === "POST" && url.pathname === "/notify") {
        return await this.notify(body);
      }
      if (request.method === "POST" && url.pathname === "/publish") {
        return await this.publish(body);
      }
      if (request.method === "POST" && url.pathname === "/clone") {
        return await this.clone(body);
      }
      if (request.method === "POST" && url.pathname === "/pr") {
        return await this.pullRequest(body);
      }
      return fail(404, "unknown_door", url.pathname);
    } catch (error) {
      this.context.log(`porch error on ${url.pathname}: ${String(error).slice(0, 300)}`);
      return fail(500, "porch_error", String(error).slice(0, 300));
    }
  }

  private async notify(body: Record<string, unknown>): Promise<JsonResult> {
    const { config } = this.context;
    if (!config.notifyUrl || !config.notifyToken) return fail(503, "notify_not_wired");
    const text = body.text;
    if (typeof text !== "string" || text.length === 0) return fail(400, "empty_text");
    const response = await fetch(config.notifyUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.notifyToken}`
      },
      body: JSON.stringify({ text: `[${config.agentId}] ${text}`.slice(0, 4000) })
    });
    if (!response.ok) {
      return fail(502, "notify_rejected", `${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    return ok();
  }

  private async publish(body: Record<string, unknown>): Promise<JsonResult> {
    const { config, stateDir, denylist, log } = this.context;
    if (!config.publishUrl || !config.publishToken) return fail(503, "publish_not_wired");

    const host = body.host;
    if (typeof host !== "string" || !config.hosts.includes(host)) {
      return fail(403, "host_not_assigned", `assigned hosts: ${config.hosts.join(", ")}`);
    }
    const dir = typeof body.dir === "string" && body.dir.length > 0 ? body.dir : "site";
    if (dir.includes("..") || dir.startsWith("/")) return fail(400, "invalid_dir");
    const root = join(stateDir, dir);
    try {
      if (!(await stat(root)).isDirectory()) return fail(400, "not_a_directory", dir);
    } catch {
      return fail(404, "dir_not_found", dir);
    }

    const files = await collectDir(root);
    if (files.length === 0) return fail(400, "empty_dir", dir);
    if (files.length > MAX_PUBLISH_FILES) return fail(413, "too_many_files", String(files.length));
    const total = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
    if (total > MAX_TOTAL_BYTES) return fail(413, "payload_too_large", `${total} bytes`);
    const oversize = files.find(file => file.bytes.byteLength > MAX_FILE_BYTES);
    if (oversize) return fail(413, "file_too_large", oversize.path);

    // Sweep before anything leaves the container: the same denylist rules
    // as the presleep gate, plus gitleaks over the directory.
    const scanInput: ChangedFile[] = files.map(file => ({
      path: file.path,
      content: file.bytes.toString("utf8")
    }));
    const secretFailures = scanForSecrets(scanInput, denylist);
    if (secretFailures.length > 0) {
      return fail(422, "publish_blocked_by_sweep", secretFailures.map(f => f.detail).join("; "));
    }
    try {
      const findings = await runGitleaks(root, {
        configPath: this.context.gitleaksConfig
      });
      if (findings.length > 0) {
        return fail(
          422,
          "publish_blocked_by_gitleaks",
          findings.map(f => `${f.ruleId} in ${f.file}:${f.startLine}`).join("; ")
        );
      }
    } catch (error) {
      return fail(503, "sweep_unavailable", String(error).slice(0, 200));
    }

    log(`publishing ${files.length} file(s) (${total} bytes) from ${dir} to host ${host}`);
    const response = await fetch(config.publishUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.publishToken}`
      },
      body: JSON.stringify({
        agentId: config.agentId,
        host,
        files: files.map(file => ({
          path: file.path,
          contentType: contentTypeFor(file.path),
          contentBase64: file.bytes.toString("base64")
        }))
      })
    });
    const resultText = (await response.text()).slice(0, 500);
    if (!response.ok) return fail(502, "publish_rejected", `${response.status}: ${resultText}`);
    return ok({ host, files: files.length, gatekeeper: resultText });
  }

  private async github(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.context.config.prToken}`,
        accept: "application/vnd.github+json",
        "user-agent": "operon-porch",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {})
      }
    });
  }

  private async whoami(): Promise<string> {
    if (this.machineUser) return this.machineUser;
    const response = await this.github("/user");
    if (!response.ok) throw new Error(`github_user_failed: ${response.status}`);
    const { login } = (await response.json()) as { login: string };
    this.machineUser = login;
    return login;
  }

  private repoDir(repo: string): string {
    return join(this.context.reposDir, repo.split("/")[1]);
  }

  private allowRepo(repo: unknown): string | JsonResult {
    if (typeof repo !== "string" || !this.context.config.prRepos.includes(repo)) {
      return fail(403, "repo_not_allowlisted", `allowed: ${this.context.config.prRepos.join(", ")}`);
    }
    return repo;
  }

  private async clone(body: Record<string, unknown>): Promise<JsonResult> {
    const { config } = this.context;
    if (!config.prToken || config.prRepos.length === 0) return fail(503, "pr_not_wired");
    const repo = this.allowRepo(body.repo);
    if (typeof repo !== "string") return repo;

    const dir = this.repoDir(repo);
    // Hardened invocation: the token travels only in the git child's env
    // (never argv, never .git/config), hooks and config-exec vectors are
    // disabled, and the finished clone is handed to the session user.
    await runCapture(
      "git",
      [...hardenedGitFlags(), "clone", githubRepoUrl(repo), dir],
      {
        env: gitCredentialEnv({ PATH: process.env.PATH ?? "" }, this.context.config.prToken ?? ""),
        timeoutMs: 5 * 60 * 1000
      }
    );
    const user = await this.whoami();
    await runCapture("git", [...hardenedGitFlags(), "-C", dir, "config", "user.name", user], {
      env: gitCredentialEnv({ PATH: process.env.PATH ?? "" }, "")
    });
    await runCapture("git", [...hardenedGitFlags(), "-C", dir, "config", "user.email", `${user}@users.noreply.github.com`], {
      env: gitCredentialEnv({ PATH: process.env.PATH ?? "" }, "")
    });
    await this.context.chownForSession(dir);
    return ok({ path: dir, repo });
  }

  private async pullRequest(body: Record<string, unknown>): Promise<JsonResult> {
    const { config } = this.context;
    if (!config.prToken || config.prRepos.length === 0) return fail(503, "pr_not_wired");
    const repo = this.allowRepo(body.repo);
    if (typeof repo !== "string") return repo;
    const { title, body: prBody } = body as { title?: unknown; body?: unknown };
    if (typeof title !== "string" || title.length === 0) return fail(400, "missing_title");
    if (typeof prBody !== "string" || prBody.length === 0) return fail(400, "missing_body");

    const dir = this.repoDir(repo);
    try {
      await stat(dir);
    } catch {
      return fail(409, "not_cloned", `clone ${repo} first`);
    }
    const branch = (
      await runCapture("git", [...hardenedGitFlags(), "-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], {
        env: gitCredentialEnv({ PATH: process.env.PATH ?? "" }, "")
      })
    ).stdout.trim();
    if (branch === "main" || branch === "master" || branch === "HEAD") {
      return fail(400, "not_on_a_branch", "create and commit to a feature branch first");
    }
    const dirty = (
      await runCapture("git", [...hardenedGitFlags(), "-C", dir, "status", "--porcelain"], {
        env: gitCredentialEnv({ PATH: process.env.PATH ?? "" }, "")
      })
    ).stdout.trim();
    if (dirty.length > 0) return fail(409, "uncommitted_changes", "commit your changes first");

    const user = await this.whoami();
    const [, name] = repo.split("/");

    // Ensure the machine user's fork exists (idempotent), then wait for it.
    await this.github(`/repos/${repo}/forks`, { method: "POST", body: JSON.stringify({}) });
    let forkReady = false;
    for (let i = 0; i < 10 && !forkReady; i++) {
      const check = await this.github(`/repos/${user}/${name}`);
      forkReady = check.ok;
      if (!forkReady) await new Promise(resolve => setTimeout(resolve, 2000));
    }
    if (!forkReady) return fail(502, "fork_unavailable", `${user}/${name} did not appear`);

    // Push from a clean root-owned mirror, never from the mind-writable
    // clone: a mind that added url.insteadOf + a scoped credential helper
    // to the clone's config would otherwise get that helper run as root
    // with the token in its environment (see cleanPushToGithub).
    await cleanPushToGithub({
      sourceDir: dir,
      // Under the root-only mirrors dir, never beside the mind-owned clone:
      // the mind cannot replace a mirror it cannot even traverse to.
      mirrorDir: join(this.context.mirrorsDir, `pr-${name}-${crypto.randomUUID()}`),
      repo: `${user}/${name}`,
      branch,
      token: this.context.config.prToken ?? "",
      run: (args, env) => runCapture("git", args, { env, timeoutMs: 5 * 60 * 1000 }),
      rm: target => rm(target, { recursive: true, force: true })
    });

    const upstream = await this.github(`/repos/${repo}`);
    const { default_branch } = (await upstream.json()) as { default_branch: string };
    const created = await this.github(`/repos/${repo}/pulls`, {
      method: "POST",
      body: JSON.stringify({
        title,
        body: prBody,
        head: `${user}:${branch}`,
        base: default_branch
      })
    });
    const result = (await created.json()) as { html_url?: string; message?: string; errors?: unknown };
    if (!created.ok) {
      return fail(502, "pr_rejected", `${created.status}: ${result.message ?? ""} ${JSON.stringify(result.errors ?? "")}`.slice(0, 300));
    }
    this.context.log(`opened PR: ${result.html_url}`);
    return ok({ url: result.html_url, branch, base: default_branch });
  }
}

const MAX_BODY_BYTES = 1024 * 1024;

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    let overflowed = false;
    request.on("data", chunk => {
      if (overflowed) return;
      data += chunk;
      if (data.length > MAX_BODY_BYTES) {
        overflowed = true;
        data = "";
        request.destroy();
        reject(new Error("body_too_large"));
      }
    });
    request.on("end", () => {
      try {
        const parsed: unknown = data.length ? JSON.parse(data) : {};
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          resolve({});
        } else resolve(parsed as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
    request.on("error", reject);
  });
}
