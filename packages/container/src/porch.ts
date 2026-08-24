import { createServer, type IncomingMessage, type Server } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { runGitleaks } from "./gitleaks.js";
import { scanForSecrets, type ChangedFile } from "./presleep.js";
import type { WakeConfig } from "./config.js";

/**
 * The porch: a loopback-only HTTP server the entrypoint runs for the
 * duration of the mind session. It is how a wake reaches the Gatekeepers
 * without any credential entering the session environment: the entrypoint
 * holds the internal bearers, the session holds only the porch's localhost
 * address (OPERON_PORCH, not a secret), and the `operon` CLI is a thin
 * client.
 *
 * The porch does NO git and holds NO GitHub credential. Every door submits
 * DATA to a Gatekeeper Worker that owns the credential and does the write:
 *  - notify: message the operator through the telegram Gatekeeper.
 *  - publish: a directory of static files to one assigned host, swept here
 *    (denylist variants + gitleaks) before it leaves the container, then
 *    re-gated by the publish Gatekeeper.
 *  - pr: a directory of file additions/updates for an allowlisted repo,
 *    swept the same way, sent to the PR Gatekeeper, which creates the
 *    commit and pull request through the GitHub API. The machine
 *    credential never enters this container, so there is no in-container
 *    git-with-a-token surface to attack.
 */

export const PORCH_PORT = 41414;

const MAX_FILES = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
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
  /** The auto-denylist the presleep gate uses; the publish/PR sweep shares it. */
  denylist: string[];
  /** Overrides the image's gitleaks config path (tests run outside the image). */
  gitleaksConfig?: string;
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
    pr: Boolean(config.prUrl && config.prToken && config.prRepos.length > 0),
    email: Boolean(config.emailUrl && config.emailToken),
    hosts: config.hosts,
    prRepos: config.prRepos
  };
}

interface CollectedFile {
  path: string;
  bytes: Buffer;
}

async function collectDir(root: string): Promise<CollectedFile[]> {
  const out: CollectedFile[] = [];
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
    const boundPort = typeof address === "object" && address !== null ? address.port : port;
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
      if (request.method === "POST" && url.pathname === "/notify") return await this.notify(body);
      if (request.method === "POST" && url.pathname === "/publish") return await this.publish(body);
      if (request.method === "POST" && url.pathname === "/pr") return await this.pr(body);
      if (request.method === "POST" && url.pathname === "/email") return await this.email(body);
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

  /** Read a state-repo subdirectory into a swept, size-checked file set. */
  private async collectSwept(
    dirInput: unknown,
    defaultDir: string
  ): Promise<{ files: CollectedFile[]; error?: JsonResult }> {
    const dir = typeof dirInput === "string" && dirInput.length > 0 ? dirInput : defaultDir;
    if (dir.includes("..") || dir.startsWith("/")) {
      return { files: [], error: fail(400, "invalid_dir") };
    }
    const root = join(this.context.stateDir, dir);
    try {
      if (!(await stat(root)).isDirectory()) return { files: [], error: fail(400, "not_a_directory", dir) };
    } catch {
      return { files: [], error: fail(404, "dir_not_found", dir) };
    }

    const files = await collectDir(root);
    if (files.length === 0) return { files: [], error: fail(400, "empty_dir", dir) };
    if (files.length > MAX_FILES) return { files: [], error: fail(413, "too_many_files", String(files.length)) };
    const total = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
    if (total > MAX_TOTAL_BYTES) return { files: [], error: fail(413, "payload_too_large", `${total} bytes`) };
    const oversize = files.find(file => file.bytes.byteLength > MAX_FILE_BYTES);
    if (oversize) return { files: [], error: fail(413, "file_too_large", oversize.path) };

    // Sweep before anything leaves the container: same rules as the
    // presleep gate, plus gitleaks over the directory.
    const scanInput: ChangedFile[] = files.map(file => ({
      path: file.path,
      content: file.bytes.toString("utf8")
    }));
    const secretFailures = scanForSecrets(scanInput, this.context.denylist);
    if (secretFailures.length > 0) {
      return { files: [], error: fail(422, "blocked_by_sweep", secretFailures.map(f => f.detail).join("; ")) };
    }
    try {
      const findings = await runGitleaks(root, { configPath: this.context.gitleaksConfig });
      if (findings.length > 0) {
        return {
          files: [],
          error: fail(
            422,
            "blocked_by_gitleaks",
            findings.map(f => `${f.ruleId} in ${f.file}:${f.startLine}`).join("; ")
          )
        };
      }
    } catch (error) {
      return { files: [], error: fail(503, "sweep_unavailable", String(error).slice(0, 200)) };
    }
    return { files };
  }

  private async publish(body: Record<string, unknown>): Promise<JsonResult> {
    const { config, log } = this.context;
    if (!config.publishUrl || !config.publishToken) return fail(503, "publish_not_wired");

    const host = body.host;
    if (typeof host !== "string" || !config.hosts.includes(host)) {
      return fail(403, "host_not_assigned", `assigned hosts: ${config.hosts.join(", ")}`);
    }
    const { files, error } = await this.collectSwept(body.dir, "site");
    if (error) return error;

    log(`publishing ${files.length} file(s) to host ${host}`);
    const response = await fetch(config.publishUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.publishToken}` },
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

  private async pr(body: Record<string, unknown>): Promise<JsonResult> {
    const { config, log } = this.context;
    if (!config.prUrl || !config.prToken || config.prRepos.length === 0) {
      return fail(503, "pr_not_wired");
    }
    const repo = body.repo;
    if (typeof repo !== "string" || !config.prRepos.includes(repo)) {
      return fail(403, "repo_not_allowlisted", `allowed: ${config.prRepos.join(", ")}`);
    }
    const title = body.title;
    const prBody = body.body;
    if (typeof title !== "string" || title.length === 0) return fail(400, "missing_title");
    if (typeof prBody !== "string" || prBody.length === 0) return fail(400, "missing_body");

    const { files, error } = await this.collectSwept(body.dir, "pr");
    if (error) return error;

    log(`submitting PR to ${repo}: ${files.length} file(s)`);
    const response = await fetch(config.prUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.prToken}` },
      body: JSON.stringify({
        agentId: config.agentId,
        repo,
        title,
        body: prBody,
        files: files.map(file => ({ path: file.path, contentBase64: file.bytes.toString("base64") }))
      })
    });
    const resultText = (await response.text()).slice(0, 800);
    if (!response.ok) return fail(502, "pr_rejected", `${response.status}: ${resultText}`);
    return ok({ repo, gatekeeper: JSON.parse(resultText) });
  }

  private async email(body: Record<string, unknown>): Promise<JsonResult> {
    const { config, log } = this.context;
    if (!config.emailUrl || !config.emailToken) return fail(503, "email_not_wired");
    const { to, subject, text } = body;
    if (typeof to !== "string" || !to.includes("@")) return fail(400, "invalid_to");
    if (typeof subject !== "string" || subject.length === 0) return fail(400, "missing_subject");
    if (typeof text !== "string" || text.length === 0) return fail(400, "missing_text");

    log(`sending email to ${to}`);
    const response = await fetch(`${config.emailUrl}/gatekeeper/email/send`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.emailToken}` },
      body: JSON.stringify({ agentId: config.agentId, to, subject, text })
    });
    const resultText = (await response.text()).slice(0, 500);
    if (!response.ok) return fail(502, "email_rejected", `${response.status}: ${resultText}`);
    return ok({ gatekeeper: JSON.parse(resultText) });
  }
}

const MAX_BODY_BYTES = 12 * 1024 * 1024;

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflowed = false;
    request.on("data", chunk => {
      if (overflowed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        overflowed = true;
        request.destroy();
        reject(new Error("body_too_large"));
        return;
      }
      chunks.push(chunk as Buffer);
    });
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        const parsed: unknown = text.length ? JSON.parse(text) : {};
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) resolve({});
        else resolve(parsed as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
    request.on("error", reject);
  });
}
