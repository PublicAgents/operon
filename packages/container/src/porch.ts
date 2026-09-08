import type { McpBudgetView } from "./mcp-budget.js";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { handleWebUpgrade } from "./web-relay.js";
import { mkdir as mkdirFs, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { join, relative } from "node:path";
import { runGitleaks } from "./gitleaks.js";
import { linesNotIn, scanForSecrets, type ChangedFile } from "./presleep.js";
import type { WakeConfig } from "./config.js";
import { renderSkills, type AskLimits } from "./skills.js";
import { redactLiterals } from "./transcript.js";

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
  /**
   * Grow the denylist with anything that appeared since the wake began
   * (a credential the harness rotated, spec 0010 §5); awaited before
   * every door request, so the sweep below never runs against a stale
   * list. Never throws.
   */
  refreshDenylist?(): Promise<void>;
  /** Overrides the image's gitleaks config path (tests run outside the image). */
  gitleaksConfig?: string;
  log(message: string): void;
  /**
   * Mid-wake input refresh (operon pull): the entrypoint's closure over
   * the same pull + ack bookkeeping the wake start uses, so nothing is
   * lost or double-acked. Freshness lands in the entrypoint's
   * unannounced buffer; drainAnnouncements hands it to exactly one
   * still-connected caller. Absent in tests that wire no doors.
   */
  pullFresh?(): Promise<void>;
  drainAnnouncements?(): Announcements;
  /** Put a drained-but-undelivered announcement back for the next pull. */
  recreditAnnouncements?(counts: Announcements): void;
  /** This colony's ask ceilings, for the living guide (spec 0007 §3). */
  askLimits?: AskLimits;
  /**
   * The budgets of this wake's metered MCP servers (spec 0014 §2):
   * what was read at wake start, and a fresh read on demand.
   */
  mcpBudgets?: { current(): McpBudgetView[]; refresh(): Promise<McpBudgetView[]> };
}

/** What one pull found: counts the mind can act on, not a status dump. */
export interface Announcements {
  mail: number;
  dms: number;
  channel: boolean;
  /** Ids of asks the operator acted on, deduplicated while buffered. */
  asks: string[];
}

interface JsonResult {
  status: number;
  body: Record<string, unknown>;
  /**
   * Called when the response provably never reached the client (socket
   * closed before the write finished): the /pull branch re-credits its
   * drained announcement so a delivery cannot vanish into a dead
   * connection.
   */
  undeliverable?: () => void;
}

function ok(body: Record<string, unknown> = {}): JsonResult {
  return { status: 200, body: { ok: true, ...body } };
}

/** A Gatekeeper body, passed through when it parses and quoted when it does not. */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text.slice(0, 300) };
  }
}

function fail(status: number, error: string, detail?: string): JsonResult {
  return { status, body: { ok: false, error, ...(detail ? { detail } : {}) } };
}

/**
 * The repos this wake may open PRs and issues against: its per-agent
 * grant when the scheduler sent one, else the fleet-wide list (spec
 * 0008 §3). The Gatekeeper decides authoritatively; this is the
 * container-side pre-check, so a refusal costs no round trip and every
 * door tells the mind the same thing.
 */
export function prRepos(config: WakeConfig): string[] {
  return config.githubGrants ? config.githubGrants.pr : config.prRepos;
}

export function capabilities(config: WakeConfig, extra: { mcpBudgets?: McpBudgetView[] } = {}): Record<string, unknown> {
  return {
    notify: Boolean(config.notifyUrl && config.notifyToken),
    publish: Boolean(config.publishUrl && config.publishToken),
    github: Boolean(config.prUrl && config.prToken),
    pr: Boolean(config.prUrl && config.prToken && prRepos(config).length > 0),
    email: Boolean(config.emailUrl && config.emailToken),
    till: Boolean(config.tillUrl && config.tillToken),
    pay: Boolean(config.spendUrl && config.spendToken),
    vault: Boolean(config.vaultUrl && config.vaultToken),
    ask: Boolean(config.asksUrl && config.asksToken),
    x: Boolean(config.xUrl && config.xToken),
    web: Boolean(config.webUrl && config.webToken),
    localBrowser: config.localBrowser,
    hosts: config.hosts,
    prRepos: prRepos(config),
    githubWrite: config.githubGrants?.write ?? [],
    githubReview: config.githubGrants?.review ?? [],
    githubMerge: config.githubGrants?.merge ?? [],
    registry: config.registry ?? null,
    mcp: config.mcpServers.map(server => server.name),
    mcpBudgets: extra.mcpBudgets ?? [],
    disabledDoors: config.disabledDoors
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
      // Dot-entries are the agent's own housekeeping, never a page,
      // with ONE exception: /.well-known at the site's root is what the
      // web reads to know who a site is (spec 0013 §3: the registry's
      // ownership file, an agent card), and dropping it would make every
      // site anonymous. Deeper dot-directories stay housekeeping.
      if (entry.name.startsWith(".") && !(dir === root && entry.name === ".well-known")) continue;
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
        if (result.undeliverable) {
          const failed = result.undeliverable;
          response.on("close", () => {
            if (!response.writableFinished) failed();
          });
        }
        try {
          response.writeHead(result.status, { "content-type": "application/json" });
          response.end(JSON.stringify(result.body));
        } catch {
          result.undeliverable?.();
        }
      });
    });
    // The web door is a long-lived CDP WebSocket, not a request; relay
    // it over the umbilical the same way, splicing the sockets.
    this.server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const took = handleWebUpgrade(request, socket, head, {
        webUrl: this.context.config.webUrl,
        webToken: this.context.config.webToken,
        wakeId: this.context.config.wakeId
      });
      if (!took) {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
      }
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
      // The browser boundary: a custom header makes every cross-origin
      // request non-simple, so page JS in any browser the mind runs must
      // preflight, and the porch never approves a preflight. Door calls
      // therefore come only from real HTTP clients (the operon CLI), not
      // from a webpage CSRF-ing the loopback.
      if (request.method === "OPTIONS") {
        return fail(403, "no_preflight", "the porch never approves cross-origin callers");
      }
      if (request.headers["x-operon-porch"] !== "1") {
        return fail(403, "porch_header_missing", "send x-operon-porch: 1 (the operon CLI does)");
      }
      await this.context.refreshDenylist?.();
      // The telemetry relay (spec 0011 §4): the harness's OTLP exporters
      // post here, the porch attaches the chronicle bearer outside the
      // session and forwards through the umbilical. Redacted against
      // the shared denylist like the transcript; the payload's own
      // identity claims are ignored downstream (the router names the wake).
      const otel = /^\/otel\/v1\/(traces|metrics|logs)$/.exec(url.pathname);
      if (otel && request.method === "POST") return await this.relayTelemetry(request, otel[1]);
      if (request.method === "GET" && url.pathname === "/capabilities") {
        return ok(capabilities(this.context.config, { mcpBudgets: this.context.mcpBudgets?.current() }));
      }
      // The remaining figures of every metered server, read fresh
      // (spec 0014 §2): `operon mcp budget`, so a mind plans a wake
      // against a number rather than a surprise.
      if (url.pathname === "/mcp/budget" && (request.method === "GET" || request.method === "POST")) {
        if (!this.context.mcpBudgets) return ok({ budgets: [] });
        return ok({ budgets: await this.context.mcpBudgets.refresh() });
      }
      // The living guide (skills.ts): rendered fresh from THIS wake's
      // config, so `operon --help` can never describe a different
      // chassis than the one answering.
      if (request.method === "GET" && url.pathname === "/help") {
        return ok({
          help: renderSkills(
            this.context.config,
            capabilities(this.context.config, { mcpBudgets: this.context.mcpBudgets?.current() }),
            this.context.askLimits
          )
        });
      }
      if (request.method === "POST" && url.pathname === "/pull") {
        if (!this.context.pullFresh || !this.context.drainAnnouncements) {
          return fail(503, "pull_not_wired");
        }
        await this.context.pullFresh();
        // A caller that already vanished (the hook past its timeout,
        // say) drains nothing; and if the socket dies between drain and
        // flush, the undeliverable callback below re-credits the counts,
        // so a delivery can never vanish into a dead connection: the
        // buffer simply waits for the next pull.
        if (request.destroyed) return fail(499, "caller_gone");
        const pulled = this.context.drainAnnouncements();
        const fresh = Boolean(
          pulled.mail || pulled.dms || pulled.channel || pulled.asks.length
        );
        const recredit = this.context.recreditAnnouncements;
        return {
          ...ok({
            mail: pulled.mail,
            dms: pulled.dms,
            channel: pulled.channel,
            // The wire says how MANY asks moved; the ids are internal
            // bookkeeping, and the notice never carries what was said.
            asks: pulled.asks.length,
            note: fresh
              ? pulled.asks.length > 0
                ? "new input landed in inbox/ and operator/ (your operator acted on an ask: see operator/asks.md)"
                : "new input landed in inbox/ and operator/channel.md"
              : "nothing new since the last delivery"
          }),
          ...(fresh && recredit ? { undeliverable: () => recredit(pulled) } : {})
        };
      }
      const body = request.method === "POST" ? await readBody(request) : {};
      if (request.method === "POST" && url.pathname === "/notify") return await this.notify(body);
      if (request.method === "POST" && url.pathname === "/publish") return await this.publish(body);
      if (request.method === "POST" && url.pathname === "/github/pr") return await this.pr(body);
      if (request.method === "POST" && url.pathname === "/github/issue") return await this.issue(body);
      if (request.method === "POST" && url.pathname === "/github/status") return await this.status();
      if (request.method === "POST" && url.pathname === "/github/thread") return await this.thread(body);
      if (request.method === "POST" && url.pathname === "/github/comment") return await this.comment(body);
      if (request.method === "POST" && url.pathname === "/github/update") return await this.update(body);
      if (request.method === "POST" && url.pathname === "/github/push") return await this.push(body);
      if (request.method === "POST" && url.pathname === "/github/branch") return await this.branch(body);
      if (request.method === "POST" && url.pathname === "/github/review") return await this.review(body);
      if (request.method === "POST" && url.pathname === "/github/merge") return await this.merge(body);
      if (request.method === "POST" && url.pathname === "/github/close") return await this.closePullRequest(body);
      if (request.method === "POST" && url.pathname === "/email") return await this.email(body);
      if (request.method === "POST" && url.pathname === "/email/original") return await this.emailOriginal(body);
      if (request.method === "POST" && url.pathname === "/till/offer") return await this.tillOffer(body);
      if (request.method === "POST" && url.pathname === "/till/retire") return await this.tillRetire(body);
      if (request.method === "POST" && url.pathname === "/till/sales") return await this.tillSales();
      if (request.method === "POST" && url.pathname === "/pay") return await this.pay(body);
      if (request.method === "POST" && url.pathname === "/pay/proposals") return await this.payProposals();
      if (request.method === "POST" && url.pathname === "/channel/original") return await this.channelOriginal(body);
      if (request.method === "POST" && url.pathname === "/vault/set") return await this.vaultSet(body);
      if (request.method === "POST" && url.pathname === "/vault/get") return await this.vaultCall("get", body);
      if (request.method === "POST" && url.pathname === "/vault/list") return await this.vaultCall("list", {});
      if (request.method === "POST" && url.pathname === "/vault/delete") return await this.vaultCall("delete", body);
      if (request.method === "POST" && url.pathname === "/x/post") return await this.xPost(body);
      if (request.method === "POST" && url.pathname === "/x/posts") return await this.xCall("posts", {});
      if (request.method === "POST" && url.pathname === "/x/me") return await this.xCall("me", {});
      if (request.method === "POST" && url.pathname === "/web/sessions") return await this.webSessions();
      if (request.method === "POST" && url.pathname === "/web/close") return await this.webClose(body);
      if (request.method === "POST" && url.pathname === "/web/password") return await this.webPassword(body);
      if (request.method === "POST" && url.pathname === "/x/dm") return await this.xDm(body);
      if (request.method === "POST" && url.pathname === "/ask/create") return await this.askCreate(body);
      if (request.method === "POST" && url.pathname === "/ask/list") return await this.asksCall("list", {});
      if (request.method === "POST" && url.pathname === "/ask/reply") return await this.askReply(body);
      if (request.method === "POST" && url.pathname === "/ask/retract") {
        return await this.askTransition("retract", body);
      }
      if (request.method === "POST" && url.pathname === "/ask/close") {
        return await this.askTransition("close", body);
      }
      return fail(404, "unknown_door", url.pathname);
    } catch (error) {
      this.context.log(`porch error on ${url.pathname}: ${String(error).slice(0, 300)}`);
      return fail(500, "porch_error", String(error).slice(0, 300));
    }
  }

  /** Forward one OTLP/HTTP JSON payload to the chronicle door (spec 0011 §4). */
  private async relayTelemetry(request: IncomingMessage, signal: string): Promise<JsonResult> {
    const { config, denylist } = this.context;
    if (!config.chronicleUrl || !config.chronicleToken) return fail(503, "otel_not_wired", "no chronicle door this wake");
    let raw: string;
    try {
      raw = await readRawBody(request, MAX_OTLP_BYTES);
    } catch (error) {
      return fail(413, "otel_body_too_large", String(error).slice(0, 120));
    }
    if (!raw.trim().startsWith("{")) return fail(400, "otel_not_json", "OTLP/HTTP with the JSON encoding only");
    try {
      const response = await fetch(`${config.chronicleUrl}/v1/${signal}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.chronicleToken}` },
        body: redactLiterals(raw, denylist)
      });
      if (!response.ok) return fail(502, "otel_relay_refused", `chronicle answered ${response.status}`);
      // An OTLP client expects the export response shape: an empty
      // object is "everything accepted".
      return { status: 200, body: {} };
    } catch (error) {
      return fail(502, "otel_relay_failed", String(error).slice(0, 160));
    }
  }

  private async notify(body: Record<string, unknown>): Promise<JsonResult> {
    const { config } = this.context;
    if (!config.notifyUrl || !config.notifyToken) return fail(503, "notify_not_wired");
    const text = body.text;
    if (typeof text !== "string" || text.length === 0) return fail(400, "empty_text");
    // Notify text leaves the container (Telegram, and the channel record):
    // it is swept like every other outbound field, so a denylisted or
    // vaulted value can no more exfiltrate through a notify than a PR title.
    const blocked = this.sweepFields({ text });
    if (blocked) return blocked;
    const response = await fetch(config.notifyUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.notifyToken}`
      },
      body: JSON.stringify({
        agentId: config.agentId,
        text: `[${config.agentId}] ${text}`.slice(0, 4000)
      })
    });
    if (!response.ok) {
      return fail(502, "notify_rejected", `${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    return ok();
  }

  /**
   * Read a state-repo subdirectory into a swept, size-checked file set.
   * reduceForGitleaks, when given, maps each file to the content GITLEAKS
   * examines (e.g. only the lines added relative to the upstream version,
   * operon#11): its generic patterns are what false-positive on other
   * people's upstream text. The DENYLIST scan always runs on the FULL
   * submitted content: it detects split-secret assembly, so dropping
   * unchanged lines would let an added fragment complete a secret whose
   * other half already sits upstream, and the full file is what ships.
   */
  private async collectSwept(
    dirInput: unknown,
    defaultDir: string,
    reduceForGitleaks?: (path: string, text: string) => Promise<string>
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

    // Sweep before anything leaves the container. The denylist scan runs
    // over the FULL contents (split-secret assembly must see everything the
    // payload ships); gitleaks runs over the reduced contents when a
    // reducer is given.
    const fullInput: ChangedFile[] = files.map(file => ({
      path: file.path,
      content: file.bytes.toString("utf8")
    }));
    const secretFailures = scanForSecrets(fullInput, this.context.denylist);
    if (secretFailures.length > 0) {
      return { files: [], error: fail(422, "blocked_by_sweep", secretFailures.map(f => f.detail).join("; ")) };
    }
    let gitleaksRoot = root;
    let sweepDir: string | undefined;
    try {
      if (reduceForGitleaks) {
        sweepDir = await mkdtemp(join(tmpdir(), "operon-sweep-"));
        for (const entry of fullInput) {
          const target = join(sweepDir, entry.path);
          await mkdirFs(dirname(target), { recursive: true });
          await writeFile(target, await reduceForGitleaks(entry.path, entry.content ?? ""));
        }
        gitleaksRoot = sweepDir;
      }
      const findings = await runGitleaks(gitleaksRoot, { configPath: this.context.gitleaksConfig });
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
    } finally {
      if (sweepDir) await rm(sweepDir, { recursive: true, force: true }).catch(() => undefined);
    }
    return { files };
  }

  /**
   * The upstream version of a file in an allowlisted repo, via the github
   * Gatekeeper (which holds the credential). null = unavailable, and the
   * caller must fail CLOSED to a full-file sweep.
   */
  private async upstreamFile(repo: string, path: string): Promise<{ exists: boolean; text?: string } | null> {
    const { config } = this.context;
    if (!config.prUrl || !config.prToken) return null;
    try {
      const base = config.prUrl.replace(/\/gatekeeper\/pr$/, "");
      const response = await fetch(`${base}/gatekeeper/upstream-file`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.prToken}` },
        body: JSON.stringify({ agentId: config.agentId, repo, path })
      });
      if (!response.ok) return null;
      const result = (await response.json()) as { exists?: boolean; contentBase64?: string };
      if (!result.exists) return { exists: false };
      if (typeof result.contentBase64 !== "string") return null;
      return { exists: true, text: Buffer.from(result.contentBase64, "base64").toString("utf8") };
    } catch {
      return null;
    }
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
    if (!config.prUrl || !config.prToken || prRepos(config).length === 0) {
      return fail(503, "pr_not_wired");
    }
    const repo = body.repo;
    if (typeof repo !== "string" || !prRepos(config).includes(repo)) {
      return fail(403, "repo_not_granted", `granted: ${prRepos(config).join(", ")}`);
    }
    const title = body.title;
    const prBody = body.body;
    if (typeof title !== "string" || title.length === 0) return fail(400, "missing_title");
    if (typeof prBody !== "string" || prBody.length === 0) return fail(400, "missing_body");
    const blocked = this.sweepFields({ title, body: prBody });
    if (blocked) return blocked;

    // Submodule bumps: gitlink pointers, validated here and re-validated
    // by the Gatekeeper. A sha carries nothing sweepable.
    const submodules: Array<{ path: string; sha: string }> = [];
    if (body.submodules !== undefined) {
      if (!Array.isArray(body.submodules)) return fail(400, "invalid_submodules");
      for (const link of body.submodules as Array<{ path?: unknown; sha?: unknown }>) {
        if (
          typeof link?.path !== "string" ||
          link.path.includes("..") ||
          link.path.startsWith("/") ||
          typeof link?.sha !== "string" ||
          !/^[0-9a-f]{40}$/.test(link.sha)
        ) {
          return fail(400, "invalid_submodule");
        }
        submodules.push({ path: link.path, sha: link.sha });
      }
    }

    // For files that already exist upstream, GITLEAKS examines only the
    // agent's ADDED lines: its generic patterns are what false-positive on
    // other people's upstream text (operon#11). The denylist scan still
    // sees the full file. New files, and any file whose upstream copy
    // cannot be fetched, are examined in full (fail closed).
    // A bump-only PR (submodules, no dir given) skips file collection.
    let files: CollectedFile[] = [];
    if (submodules.length === 0 || body.dir !== undefined) {
      const collected = await this.collectSwept(body.dir, "pr", async (path, text) => {
        const upstream = await this.upstreamFile(repo, path);
        if (upstream?.exists && upstream.text !== undefined) return linesNotIn(text, upstream.text);
        return text;
      });
      if (collected.error) return collected.error;
      files = collected.files;
    }

    log(`submitting PR to ${repo}: ${files.length} file(s), ${submodules.length} submodule bump(s)`);
    const response = await fetch(config.prUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.prToken}` },
      body: JSON.stringify({
        agentId: config.agentId,
        repo,
        title,
        body: prBody,
        files: files.map(file => ({ path: file.path, contentBase64: file.bytes.toString("base64") })),
        ...(submodules.length > 0 ? { submodules } : {})
      })
    });
    const resultText = (await response.text()).slice(0, 800);
    if (!response.ok) return fail(502, "pr_rejected", `${response.status}: ${resultText}`);
    return ok({ repo, gatekeeper: JSON.parse(resultText) });
  }

  private async issue(body: Record<string, unknown>): Promise<JsonResult> {
    const { config, stateDir, denylist, log } = this.context;
    if (!config.prUrl || !config.prToken || prRepos(config).length === 0) {
      return fail(503, "issue_not_wired");
    }
    const { repo, title, bodyFile } = body;
    if (typeof repo !== "string" || !prRepos(config).includes(repo)) {
      return fail(403, "repo_not_granted", `granted: ${prRepos(config).join(", ")}`);
    }
    if (typeof title !== "string" || title.length === 0) return fail(400, "missing_title");
    {
      const blocked = this.sweepFields({ title });
      if (blocked) return blocked;
    }
    if (typeof bodyFile !== "string" || bodyFile.includes("..") || bodyFile.startsWith("/")) {
      return fail(400, "invalid_body_file");
    }
    let issueBody: string;
    try {
      issueBody = await readFile(join(stateDir, bodyFile), "utf8");
    } catch {
      return fail(404, "body_file_not_found", bodyFile);
    }
    // Sweep the body like any outbound content.
    const secretFailures = scanForSecrets([{ path: bodyFile, content: issueBody }], denylist);
    if (secretFailures.length > 0) {
      return fail(422, "blocked_by_sweep", secretFailures.map(f => f.detail).join("; "));
    }

    log(`opening issue on ${repo}`);
    const response = await fetch(`${config.prUrl.replace(/\/gatekeeper\/pr$/, "")}/gatekeeper/issue`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.prToken}` },
      body: JSON.stringify({ agentId: config.agentId, repo, title, body: issueBody })
    });
    const resultText = (await response.text()).slice(0, 500);
    if (!response.ok) return fail(502, "issue_rejected", `${response.status}: ${resultText}`);
    return ok({ repo, gatekeeper: JSON.parse(resultText) });
  }

  /** POST a payload to the github Gatekeeper's /gatekeeper/<door>. */
  private async githubGatekeeper(
    door: string,
    payload: Record<string, unknown>,
    maxResponse = 20000
  ): Promise<JsonResult> {
    const { config } = this.context;
    if (!config.prUrl || !config.prToken) return fail(503, `${door}_not_wired`);
    const base = config.prUrl.replace(/\/gatekeeper\/pr$/, "");
    const response = await fetch(`${base}/gatekeeper/${door}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.prToken}` },
      body: JSON.stringify({ agentId: config.agentId, ...payload })
    });
    const resultText = (await response.text()).slice(0, maxResponse);
    if (!response.ok) return fail(502, `${door}_rejected`, `${response.status}: ${resultText.slice(0, 400)}`);
    return ok({ gatekeeper: JSON.parse(resultText) });
  }

  private async status(): Promise<JsonResult> {
    return this.githubGatekeeper("status", {}, 60000);
  }

  private async thread(body: Record<string, unknown>): Promise<JsonResult> {
    const { repo, number } = body;
    if (typeof repo !== "string" || typeof number !== "number") return fail(400, "invalid_request");
    return this.githubGatekeeper("thread", { repo, number }, 200000);
  }

  /**
   * Sweep short outbound text fields (titles, messages, subjects). Anything
   * that leaves the container is swept, not only bodies and file payloads:
   * a denylisted credential hidden in a PR title or a commit message would
   * otherwise exfiltrate just as well.
   */
  private sweepFields(fields: Record<string, unknown>): JsonResult | null {
    const input: ChangedFile[] = Object.entries(fields)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
      .map(([label, content]) => ({ path: label, content }));
    if (input.length === 0) return null;
    const failures = scanForSecrets(input, this.context.denylist);
    if (failures.length > 0) {
      return fail(422, "blocked_by_sweep", failures.map(f => f.detail).join("; "));
    }
    return null;
  }

  /** Resolve a comment/update body from inline text or a state-repo file, swept. */
  private async sweptText(
    inline: unknown,
    fromFile: unknown,
    label: string
  ): Promise<{ text?: string; error?: JsonResult }> {
    let text: string | undefined;
    if (typeof inline === "string" && inline.length > 0) text = inline;
    else if (typeof fromFile === "string" && fromFile.length > 0) {
      if (fromFile.includes("..") || fromFile.startsWith("/")) {
        return { error: fail(400, "invalid_body_file") };
      }
      try {
        text = await readFile(join(this.context.stateDir, fromFile), "utf8");
      } catch {
        return { error: fail(404, "body_file_not_found", fromFile) };
      }
    }
    if (!text) return { error: fail(400, `missing_${label}`) };
    const failures = scanForSecrets([{ path: label, content: text }], this.context.denylist);
    if (failures.length > 0) {
      return { error: fail(422, "blocked_by_sweep", failures.map(f => f.detail).join("; ")) };
    }
    return { text };
  }

  private async comment(body: Record<string, unknown>): Promise<JsonResult> {
    const { repo, number, replyTo } = body;
    if (typeof repo !== "string" || typeof number !== "number") return fail(400, "invalid_request");
    const { text, error } = await this.sweptText(body.body, body.bodyFile, "comment");
    if (error) return error;
    this.context.log(`commenting on ${repo}#${number}`);
    return this.githubGatekeeper("comment", {
      repo,
      number,
      body: text,
      ...(typeof replyTo === "number" ? { replyTo } : {})
    });
  }

  private async update(body: Record<string, unknown>): Promise<JsonResult> {
    const { repo, number, title, state } = body;
    if (typeof repo !== "string" || typeof number !== "number") return fail(400, "invalid_request");
    if (state !== undefined && state !== "open" && state !== "closed") return fail(400, "invalid_state");
    if (typeof title === "string" && title) {
      const blocked = this.sweepFields({ title });
      if (blocked) return blocked;
    }
    const payload: Record<string, unknown> = { repo, number };
    if (typeof title === "string" && title) payload.title = title;
    if (state) payload.state = state;
    if (body.bodyFile !== undefined || typeof body.body === "string") {
      const { text, error } = await this.sweptText(body.body, body.bodyFile, "body");
      if (error) return error;
      payload.body = text;
    }
    if (!payload.title && !payload.body && !payload.state) return fail(400, "empty_patch");
    this.context.log(`updating ${repo}#${number}`);
    return this.githubGatekeeper("update", payload);
  }

  /**
   * The adjudication doors (spec 0012 §9). The grants are pre-checked
   * here so a refusal costs no round trip and every door says the same
   * thing; the Gatekeeper decides authoritatively, reading GitHub
   * itself. The rule to the mind is in the living help: never approve
   * your own pull request; merge only what qualifies; held means the
   * operator decides; close is for spam, with a reason on the record.
   */
  private async review(body: Record<string, unknown>): Promise<JsonResult> {
    const { config } = this.context;
    const { repo, number, verdict } = body;
    if (typeof repo !== "string" || typeof number !== "number") return fail(400, "invalid_request");
    if (verdict !== "approve" && verdict !== "request_changes" && verdict !== "comment") {
      return fail(400, "invalid_verdict", "one of approve, request_changes, comment");
    }
    const reviewable = config.githubGrants?.review ?? [];
    if (!reviewable.includes(repo)) {
      return fail(403, "review_not_granted", `granted: ${reviewable.join(", ") || "nothing"}`);
    }
    const payload: Record<string, unknown> = { repo, number, verdict };
    const hasBody = body.bodyFile !== undefined || typeof body.body === "string";
    if (body.bodyFile !== undefined && typeof body.body === "string") {
      return fail(400, "ambiguous_body", "one of body or bodyFile, not both");
    }
    // The Gatekeeper's rule (spec 0012 §5): request_changes and comment
    // carry a body. Refused here by the same name, before any round trip.
    if (verdict !== "approve" && !hasBody) return fail(400, "missing_body", `${verdict} needs a body`);
    if (hasBody) {
      const { text, error } = await this.sweptText(body.body, body.bodyFile, "body");
      if (error) return error;
      // Blank text is no body either, inline or from the file.
      if (text === undefined || text.trim().length === 0) return fail(400, "missing_body", `${verdict} needs a body`);
      payload.body = text;
    }
    this.context.log(`reviewing ${repo}#${number}: ${verdict}`);
    return this.githubGatekeeper("review", payload);
  }

  private mergeGranted(repo: string): JsonResult | null {
    const mergeable = this.context.config.githubGrants?.merge ?? [];
    if (!mergeable.includes(repo)) {
      return fail(403, "merge_not_granted", `granted: ${mergeable.join(", ") || "nothing"}`);
    }
    return null;
  }

  private async merge(body: Record<string, unknown>): Promise<JsonResult> {
    const { repo, number } = body;
    if (typeof repo !== "string" || typeof number !== "number") return fail(400, "invalid_request");
    const refused = this.mergeGranted(repo);
    if (refused) return refused;
    this.context.log(`requesting merge of ${repo}#${number}`);
    return this.githubGatekeeper("merge", { repo, number }, 60000);
  }

  private async closePullRequest(body: Record<string, unknown>): Promise<JsonResult> {
    const { repo, number, reason } = body;
    if (typeof repo !== "string" || typeof number !== "number") return fail(400, "invalid_request");
    if (typeof reason !== "string" || reason.trim().length === 0) return fail(400, "missing_reason");
    const refused = this.mergeGranted(repo);
    if (refused) return refused;
    {
      const blocked = this.sweepFields({ reason });
      if (blocked) return blocked;
    }
    this.context.log(`closing ${repo}#${number}`);
    return this.githubGatekeeper("close", { repo, number, reason });
  }

  private async push(body: Record<string, unknown>): Promise<JsonResult> {
    const { log } = this.context;
    const { repo, number, message } = body;
    if (typeof repo !== "string" || typeof number !== "number") return fail(400, "invalid_request");
    if (typeof message !== "string" || message.length === 0) return fail(400, "missing_message");
    {
      const blocked = this.sweepFields({ message });
      if (blocked) return blocked;
    }
    const { files, error } = await this.collectSwept(body.dir, "pr");
    if (error) return error;
    log(`pushing ${files.length} file(s) to ${repo}#${number}`);
    return this.githubGatekeeper("push", {
      repo,
      number,
      message,
      files: files.map(file => ({ path: file.path, contentBase64: file.bytes.toString("base64") }))
    });
  }

  /**
   * Commit to a branch of a repo this agent holds a write grant on
   * (spec 0008 §6). The grant is pre-checked here so a refusal costs no
   * round trip, and enforced again at the Gatekeeper, which mints a
   * token that can only reach that one repo.
   */
  private async branch(body: Record<string, unknown>): Promise<JsonResult> {
    const { config, log } = this.context;
    if (!config.persistUrl || !config.persistToken) return fail(503, "branch_not_wired");
    const { repo, branch, message } = body;
    if (typeof repo !== "string" || typeof branch !== "string") return fail(400, "invalid_request");
    if (typeof message !== "string" || message.length === 0) return fail(400, "missing_message");
    const writable = config.githubGrants?.write ?? [];
    if (!writable.includes(repo)) {
      return fail(403, "write_not_granted", `granted: ${writable.join(", ") || "nothing"}`);
    }
    {
      const blocked = this.sweepFields({ message, branch });
      if (blocked) return blocked;
    }
    const { files, error } = await this.collectSwept(body.dir, "pr");
    if (error) return error;
    log(`committing ${files.length} file(s) to ${repo}@${branch}`);
    // The branch door lives on the github Gatekeeper (the App's Worker),
    // which is where /commit already goes: same bearer, same base URL.
    const base = config.persistUrl.replace(/\/commit$/, "");
    const response = await fetch(`${base}/branch`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.persistToken}` },
      body: JSON.stringify({
        agentId: config.agentId,
        repo,
        branch,
        message,
        files: files.map(file => ({ path: file.path, contentBase64: file.bytes.toString("base64") }))
      })
    });
    const resultText = (await response.text()).slice(0, 5000);
    if (!response.ok) {
      return { status: response.status, body: { ok: false, error: "branch_rejected", gatekeeper: safeJson(resultText) } };
    }
    return ok({ gatekeeper: JSON.parse(resultText) });
  }

  /** POST a payload to the till Gatekeeper with this agent's OWN bearer. */
  private async tillCall(door: string, payload: Record<string, unknown>): Promise<JsonResult> {
    const { config } = this.context;
    if (!config.tillUrl || !config.tillToken) return fail(503, "till_not_wired");
    const response = await fetch(`${config.tillUrl}/gatekeeper/till/${door}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.tillToken}` },
      body: JSON.stringify(payload)
    });
    const resultText = (await response.text()).slice(0, 5000);
    if (!response.ok) return fail(502, `till_${door}_rejected`, `${response.status}: ${resultText.slice(0, 300)}`);
    return ok({ gatekeeper: JSON.parse(resultText) });
  }

  private async tillOffer(body: Record<string, unknown>): Promise<JsonResult> {
    const { host, path, price, currency, description } = body;
    if (
      typeof host !== "string" ||
      typeof path !== "string" ||
      typeof price !== "string" ||
      typeof currency !== "string" ||
      typeof description !== "string"
    ) {
      return fail(400, "invalid_request");
    }
    const blocked = this.sweepFields({ description });
    if (blocked) return blocked;
    this.context.log(`till: offering ${host}${path} at ${price}`);
    return this.tillCall("offer", { host, path, price, currency, description });
  }

  private async tillRetire(body: Record<string, unknown>): Promise<JsonResult> {
    const { host, path } = body;
    if (typeof host !== "string" || typeof path !== "string") return fail(400, "invalid_request");
    return this.tillCall("retire", { host, path });
  }

  private async tillSales(): Promise<JsonResult> {
    return this.tillCall("sales", {});
  }

  /** POST to the asks Gatekeeper with this agent's OWN bearer. */
  private async asksCall(door: string, payload: Record<string, unknown>): Promise<JsonResult> {
    const { config } = this.context;
    if (!config.asksUrl || !config.asksToken) return fail(503, "ask_not_wired");
    const response = await fetch(`${config.asksUrl}/gatekeeper/asks/${door}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.asksToken}` },
      body: JSON.stringify(payload)
    });
    const resultText = (await response.text()).slice(0, 200_000);
    if (!response.ok) {
      // The Gatekeeper's refusals are the interesting ones here (a cap
      // reached, an ask that moved), so its body is passed through
      // rather than flattened into a porch error string.
      return {
        status: response.status,
        body: { ok: false, error: `ask_${door}_rejected`, gatekeeper: safeJson(resultText) }
      };
    }
    return ok({ gatekeeper: JSON.parse(resultText) });
  }

  /**
   * Open an ask: the agent's formal request for operator attention
   * (spec 0007). Everything the operator will read is swept first, in
   * the same place every outbound field is swept. An ask is the one
   * door whose whole purpose is to put agent text in front of a human
   * who is about to decide something, so a leaked credential here would
   * be read attentively rather than skimmed.
   */
  private async askCreate(body: Record<string, unknown>): Promise<JsonResult> {
    const { title, kind } = body;
    const text = body.body;
    const links = Array.isArray(body.links) ? body.links.filter(l => typeof l === "string") : [];
    if (typeof title !== "string" || typeof text !== "string" || typeof kind !== "string") {
      return fail(400, "invalid_request");
    }
    const blocked = this.sweepFields({ title, body: text, links: links.join(" ") });
    if (blocked) return blocked;
    this.context.log(`ask: opening a ${kind}`);
    return this.asksCall("create", { title, body: text, kind, links });
  }

  private async askReply(body: Record<string, unknown>): Promise<JsonResult> {
    const { askId, text } = body;
    if (typeof askId !== "string" || typeof text !== "string") return fail(400, "invalid_request");
    const blocked = this.sweepFields({ text });
    if (blocked) return blocked;
    return this.asksCall("reply", { askId, text });
  }

  private async askTransition(
    door: "retract" | "close",
    body: Record<string, unknown>
  ): Promise<JsonResult> {
    const { askId, text } = body;
    if (typeof askId !== "string") return fail(400, "invalid_request");
    if (text !== undefined && typeof text !== "string") return fail(400, "invalid_request");
    if (typeof text === "string") {
      const blocked = this.sweepFields({ text });
      if (blocked) return blocked;
    }
    return this.asksCall(door, { askId, ...(text !== undefined ? { text } : {}) });
  }

  /**
   * The agent's own pending holds and unspent allowances (spec 0002
   * §2.2): cross-wake spend state without asking the operator.
   */
  private async payProposals(): Promise<JsonResult> {
    const { config } = this.context;
    if (!config.spendUrl || !config.spendToken) return fail(503, "pay_not_wired");
    const response = await fetch(`${config.spendUrl}/gatekeeper/spend/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.spendToken}` },
      body: "{}"
    });
    const resultText = (await response.text()).slice(0, 100_000);
    if (!response.ok) return fail(502, "proposals_rejected", `${response.status}: ${resultText.slice(0, 300)}`);
    return ok({ gatekeeper: JSON.parse(resultText) });
  }

  private async pay(body: Record<string, unknown>): Promise<JsonResult> {
    const { config, log } = this.context;
    if (!config.spendUrl || !config.spendToken) return fail(503, "pay_not_wired");
    const { url, maxAmount, reason } = body;
    if (typeof url !== "string" || !url.startsWith("https://")) return fail(400, "invalid_url");
    if (typeof maxAmount !== "string" || !/^\d+(\.\d+)?$/.test(maxAmount)) {
      return fail(400, "invalid_max_amount");
    }
    if (typeof reason !== "string" || reason.length === 0) return fail(400, "missing_reason");
    const blocked = this.sweepFields({ reason });
    if (blocked) return blocked;
    log(`pay: ${url} up to ${maxAmount}`);
    const response = await fetch(`${config.spendUrl}/gatekeeper/spend/pay`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.spendToken}` },
      body: JSON.stringify({ url, maxAmount, reason })
    });
    const resultText = (await response.text()).slice(0, 8 * 1024 * 1024);
    if (!response.ok) return fail(502, "pay_rejected", `${response.status}: ${resultText.slice(0, 400)}`);
    return ok({ gatekeeper: JSON.parse(resultText) });
  }

  /**
   * The stored, unredacted original of one operator-channel entry (the
   * [#id] on a transcript header line): the write-time scan may withhold
   * a transcript line, but the message remains the agent's conversation
   * to read. Same posture as email originals.
   */
  private async channelOriginal(body: Record<string, unknown>): Promise<JsonResult> {
    const { config } = this.context;
    if (!config.notifyUrl || !config.notifyToken) return fail(503, "notify_not_wired");
    const { id } = body;
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return fail(400, "invalid_id");
    const base = config.notifyUrl.replace(/\/notify$/, "");
    const response = await fetch(`${base}/channel/original`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.notifyToken}` },
      body: JSON.stringify({ agentId: config.agentId, id })
    });
    const resultText = (await response.text()).slice(0, 20000);
    if (!response.ok) {
      return fail(502, "channel_original_rejected", `${response.status}: ${resultText.slice(0, 300)}`);
    }
    return ok({ gatekeeper: JSON.parse(resultText) });
  }

  /**
   * The web door's request-shaped operations (the CDP relay itself is a
   * WebSocket, handled by web-relay.ts). Same umbilical hop as every
   * other door: the porch holds the nonce, the mind never sees it.
   */
  private async webCall(path: string, payload: Record<string, unknown>): Promise<JsonResult> {
    const { config } = this.context;
    if (!config.webUrl || !config.webToken) return fail(503, "web_not_wired");
    const response = await fetch(`${config.webUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.webToken}` },
      body: JSON.stringify(payload)
    });
    const text = (await response.text()).slice(0, 10000);
    if (!response.ok) return fail(502, "web_rejected", `${response.status}: ${text.slice(0, 300)}`);
    try {
      return ok({ gatekeeper: JSON.parse(text) });
    } catch {
      return fail(502, "web_rejected", "non-JSON answer");
    }
  }

  /** The agent's own sessions: names, domains, live/saved. Never values. */
  private async webSessions(): Promise<JsonResult> {
    return this.webCall("/gatekeeper/web/sessions/list", {});
  }

  /** End a live session; the saved identity is kept for the next wake. */
  private async webClose(body: Record<string, unknown>): Promise<JsonResult> {
    const name = typeof body.name === "string" ? body.name : "";
    if (!name) return fail(400, "name_required");
    return this.webCall("/gatekeeper/web/close", { name });
  }

  /**
   * Mint a password DOOR-SIDE. The value is generated in the Gatekeeper
   * and stored there; the mind receives only a placeholder to type, and
   * the relay substitutes the real value on a bound origin.
   */
  private async webPassword(body: Record<string, unknown>): Promise<JsonResult> {
    const name = typeof body.name === "string" ? body.name : "";
    const domains = Array.isArray(body.domains) ? body.domains.filter(d => typeof d === "string") : [];
    if (!name || domains.length === 0) return fail(400, "name_and_domains_required");
    return this.webCall("/gatekeeper/web/credential", { name, domains });
  }

  /** POST a payload to the X Gatekeeper with this agent's OWN bearer. */
  private async xCall(door: string, payload: Record<string, unknown>): Promise<JsonResult> {
    const { config } = this.context;
    if (!config.xUrl || !config.xToken) return fail(503, "x_not_wired");
    const response = await fetch(`${config.xUrl}/gatekeeper/x/${door}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.xToken}` },
      body: JSON.stringify(payload)
    });
    const resultText = (await response.text()).slice(0, 10000);
    if (!response.ok) return fail(502, `x_${door}_rejected`, `${response.status}: ${resultText.slice(0, 300)}`);
    return ok({ gatekeeper: JSON.parse(resultText) });
  }

  /** DM a correspondent (reply-only, enforced by the Gatekeeper); swept. */
  private async xDm(body: Record<string, unknown>): Promise<JsonResult> {
    const { to, text } = body;
    if (typeof to !== "string" || to.length === 0) return fail(400, "missing_to");
    if (typeof text !== "string" || text.length === 0) return fail(400, "missing_text");
    const blocked = this.sweepFields({ to, text });
    if (blocked) return blocked;
    this.context.log(`x: DM to ${to} (${text.length} chars)`);
    return this.xCall("dm", { to, text });
  }

  /** Post to the agent's own X account: outbound text, swept like all of it. */
  private async xPost(body: Record<string, unknown>): Promise<JsonResult> {
    const { text } = body;
    if (typeof text !== "string" || text.length === 0) return fail(400, "missing_text");
    const blocked = this.sweepFields({ text });
    if (blocked) return blocked;
    this.context.log(`x: posting (${text.length} chars)`);
    return this.xCall("post", { text });
  }

  /** POST a payload to the vault Gatekeeper with this agent's OWN bearer. */
  private async vaultCall(door: string, payload: Record<string, unknown>): Promise<JsonResult> {
    const { config } = this.context;
    if (!config.vaultUrl || !config.vaultToken) return fail(503, "vault_not_wired");
    if ("label" in payload && typeof payload.label !== "string") return fail(400, "invalid_label");
    const response = await fetch(`${config.vaultUrl}/gatekeeper/vault/${door}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.vaultToken}` },
      body: JSON.stringify(payload)
    });
    const resultText = (await response.text()).slice(0, 20000);
    if (!response.ok) {
      return fail(502, `vault_${door}_rejected`, `${response.status}: ${resultText.slice(0, 300)}`);
    }
    return ok({ gatekeeper: JSON.parse(resultText) });
  }

  /**
   * Store a secret. The moment the vault confirms, the value joins the
   * wake's shared denylist (pushed into the live array), so from here on
   * it can neither persist to the state repo nor leave through any door.
   * The label is outbound text and swept; the value is the SUBJECT of the
   * door, not an exfiltration path, and is never logged.
   */
  private async vaultSet(body: Record<string, unknown>): Promise<JsonResult> {
    const { label, value } = body;
    if (typeof label !== "string" || label.length === 0) return fail(400, "invalid_label");
    if (typeof value !== "string" || value.length === 0) return fail(400, "invalid_value");
    const blocked = this.sweepFields({ label });
    if (blocked) return blocked;
    const result = await this.vaultCall("set", { label, value });
    if (result.body.ok === true && !this.context.denylist.includes(value)) {
      this.context.denylist.push(value);
      this.context.log(`vault: stored "${label}"; its value joined the sweep`);
    }
    return result;
  }

  private async email(body: Record<string, unknown>): Promise<JsonResult> {
    const { config, log } = this.context;
    if (!config.emailUrl || !config.emailToken) return fail(503, "email_not_wired");
    const { to, subject, text } = body;
    if (typeof to !== "string" || !to.includes("@")) return fail(400, "invalid_to");
    if (typeof subject !== "string" || subject.length === 0) return fail(400, "missing_subject");
    if (typeof text !== "string" || text.length === 0) return fail(400, "missing_text");
    // The recipient is outbound text too: a denylisted secret smuggled into
    // the address (its local part reaches the external mail service) must
    // block exactly like one in the subject or body.
    const blocked = this.sweepFields({ to, subject, text });
    if (blocked) return blocked;

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

  /**
   * The stored, unredacted original of one inbound message: delivery may
   * have withheld a line (operon#24), but a verification or sign-up link
   * in it is still the agent's mail to read. Inbound data stays data; and
   * anything the mind does with the content is swept on the way out like
   * everything else.
   */
  private async emailOriginal(body: Record<string, unknown>): Promise<JsonResult> {
    const { config } = this.context;
    if (!config.emailUrl || !config.emailToken) return fail(503, "email_not_wired");
    const { id } = body;
    if (typeof id !== "string" || id.length < 8) return fail(400, "invalid_id");
    const response = await fetch(`${config.emailUrl}/gatekeeper/email/original`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.emailToken}` },
      body: JSON.stringify({ agentId: config.agentId, id })
    });
    const resultText = (await response.text()).slice(0, 200000);
    if (!response.ok) {
      return fail(502, "email_original_rejected", `${response.status}: ${resultText.slice(0, 300)}`);
    }
    return ok({ gatekeeper: JSON.parse(resultText) });
  }
}

const MAX_BODY_BYTES = 12 * 1024 * 1024;
/** One OTLP export request; the harnesses batch every few seconds, so this is generous. */
const MAX_OTLP_BYTES = 4 * 1024 * 1024;

/** The body as text, bounded; unlike readBody it does not parse (OTLP is forwarded verbatim). */
function readRawBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflowed = false;
    request.on("data", chunk => {
      if (overflowed) return;
      size += chunk.length;
      if (size > maxBytes) {
        overflowed = true;
        request.destroy();
        reject(new Error("body_too_large"));
        return;
      }
      chunks.push(chunk as Buffer);
    });
    request.on("end", () => {
      if (!overflowed) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });
}

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
