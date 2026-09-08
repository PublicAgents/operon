import { DOORS, isDoor, type DoorBaseline } from "./doors.js";
import { KNOWN_HARNESSES, isHarness, type Harness } from "./harness.js";
/**
 * The roster is the deployment's list of tenants. It arrives as JSON (the
 * deployment repo's roster.jsonc with comments stripped, or a plain JSON
 * string in a Worker var) and is validated loudly: a roster that fails
 * validation names the agent and field that failed, because a silently
 * skipped agent is an agent that never wakes again.
 */

export interface RosterAgent {
  /** The doors baseline (spec 0006 §7); a door absent here is open. */
  doors?: DoorBaseline;
  /** Stable slug, [a-z0-9-]; the agent's self-chosen name is cosmetic on top. */
  id: string;
  /** Private state repository, "owner/repo". */
  stateRepo: string;
  /** Cron expression; must also be registered as a trigger in the deployment. */
  cadence: string;
  /** The primary harness this agent wakes on (spec 0001 §4.1). */
  harness: Harness;
  /** Pinned model for the mind on the primary harness. */
  model: string;
  /** Model to fall back to; a degraded wake beats a missed wake. */
  fallbackModel?: string;
  /**
   * The other harnesses this same agent may be woken on (spec 0010 §4),
   * each with its own model pin: a manual wake names one of them and
   * the agent runs there with the same memory, doors, and grants. The
   * primary is not repeated here; its pin is `model`/`fallbackModel`.
   */
  harnesses?: Partial<Record<Harness, HarnessPin>>;
  /**
   * Hard wall for one wake, minutes (default 120). A wake past it is
   * stopped and its unpushed work is lost, so size generously: this is a
   * hung-session backstop, not a productivity budget. Keep it under the
   * agent's cadence gap.
   */
  maxWakeMinutes?: number;
  /** Zone hosts this agent may publish to: "@" for the apex, otherwise subdomain labels. */
  hosts: string[];
  /**
   * The web door (spec 0004): a real browser, opt-in per agent. It is
   * opt-in because it changes the container's shape: a web-capable
   * agent launches with the deny-by-default `allowedHosts` egress fence
   * in force for the whole wake, so an extracted browser credential has
   * no direct path out. Default false: non-web agents launch exactly as
   * before.
   */
  web?: boolean;
  /**
   * The local browser (spec 0004 §9): Chrome inside the container,
   * driven through the Playwright MCP server, for UNAUTHENTICATED
   * browsing through the session's own egress. Nothing persists
   * between wakes. ON by default; `false` opts an agent out.
   */
  localBrowser?: boolean;
  enabled: boolean;
  /** Names of colony-level mcp servers granted to this agent (spec 0008). */
  mcp?: string[];
  /** Per-agent GitHub grants (spec 0008 §6). */
  github?: GithubGrants;
}

/** A model pin for one alternate harness (spec 0010 §4). */
export interface HarnessPin {
  model: string;
  fallbackModel?: string;
}

export interface Roster {
  /** The registry this colony's agents keep themselves in (spec 0013); absent means none. */
  registry?: RegistryPin;
  /** The colony zone, e.g. "example-colony.com". */
  zone: string;
  agents: RosterAgent[];
  /** Colony-level MCP server definitions (spec 0008 §3); agents reference them by name. */
  mcp?: Record<string, McpServerDef>;
}

/**
 * One MCP server an agent may be granted (spec 0008). The four shapes
 * share a doctrine: a credential lives in a Worker or in Cloudflare
 * One, never in the container, and a stdio definition has no place to
 * put one at all.
 */
/**
 * A monthly ceiling for a paid upstream, shared by every agent that
 * holds the grant (spec 0014 §2): the operator's price per tool call
 * in USD, and the tools that cost nothing. With a budget present, a
 * tool that is neither priced nor free is refused before the network.
 */
export interface McpBudget {
  monthlyUsd: number;
  perCall: Record<string, number>;
  free?: string[];
}

export type McpSignatureScheme = "hmac-sha256-hex" | "hmac-sha256-base64" | "ed25519-hex";
export const MCP_SIGNATURE_SCHEMES: readonly McpSignatureScheme[] = ["hmac-sha256-hex", "hmac-sha256-base64", "ed25519-hex"];

/**
 * The provider's webhook contract (spec 0014 §3), stated by the
 * operator: which tools create runs, the create argument that takes
 * the registration and its shape (a JSON template; `{url}` and
 * `{events}` are the only substitutions), the events, where the run id
 * sits in the create result and in a callback, the provider's
 * delivery id when it has one, and how the signature is made.
 */
export interface McpWebhook {
  createTools: string[];
  argument: string;
  registration: unknown;
  events: string[];
  runIdPath: string;
  callbackRunIdPath: string;
  callbackEventPath: string;
  callbackIdPath?: string;
  signature: { header: string; scheme: McpSignatureScheme; timestampHeader?: string };
}

export type McpServerDef =
  | {
      /** A bespoke operon Worker speaking MCP (e.g. gatekeeper-google-analytics). */
      type: "gatekeeper";
      worker: string;
    }
  | {
      /** An upstream behind the deployment's Cloudflare MCP portal. */
      type: "portal";
      server: string;
      /** Write pins; reads pass via the vetted tier. */
      tools?: string[];
      /** A fleet-wide budget for a paid upstream (spec 0014 §2). */
      budget?: McpBudget;
      /** The provider's webhook contract for asynchronous answers (spec 0014 §3). */
      webhook?: McpWebhook;
    }
  | {
      /** A plain remote server; bearer secret (MCP_<NAME>_TOKEN) lives on gatekeeper-mcp. */
      type: "http";
      url: string;
      auth: "none" | "bearer";
      /** byo tier: ONLY pinned tools are callable. */
      tools?: string[];
      budget?: McpBudget;
      webhook?: McpWebhook;
    }
  | {
      /** In-container, credential-less by construction: no env field exists. */
      type: "stdio";
      command: string;
      args: string[];
    };

/**
 * A merge grant (spec 0012 §3): the repo, the path globs a PR may
 * touch to merge without the operator (absent or empty: every merge
 * is held), and the check runs that must be green by name (absent:
 * every run present must be green and at least one must exist).
 */
/**
 * The registry every agent of this colony is told to keep itself in
 * (spec 0013): a public site and the public repository its entries
 * are changed through. Absent means no registry duty.
 */
export interface RegistryPin {
  site: string;
  repo: string;
}

/**
 * The registry repo an agent may open pull requests against by default
 * (spec 0013 §2): every agent, EXCEPT one that adjudicates there. An
 * adjudicator never authors on the registry, not even its own entry;
 * a pr grant would let a reviewer file entries with only the
 * self-approval check between them and a merge.
 */
export function registryPrRepo(
  roster: Pick<Roster, "registry">,
  agent: Pick<RosterAgent, "github">
): string | undefined {
  if (!roster.registry) return undefined;
  const repo = roster.registry.repo;
  const adjudicates =
    (agent.github?.review ?? []).some(granted => sameRepo(granted, repo)) ||
    (agent.github?.merge ?? []).some(grant => sameRepo(grant.repo, repo));
  return adjudicates ? undefined : repo;
}

/**
 * GitHub repository names are case-insensitive: two spellings of one
 * repo are one repo, wherever a grant is compared with another or with
 * a request.
 */
export function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** `repos` plus `repo`, unless a spelling of it is already there. */
export function withRepo(repos: readonly string[], repo: string | undefined): string[] {
  return repo && !repos.some(r => sameRepo(r, repo)) ? [...repos, repo] : [...repos];
}

export interface MergeGrant {
  repo: string;
  auto?: string[];
  checks?: string[];
}

/** Per-agent GitHub grants (spec 0008 §6, spec 0012 §3). Absent lists grant nothing. */
export interface GithubGrants {
  /** Repos this agent may open fork PRs / issues against and watch. */
  pr?: string[];
  /** Repos where the agent may commit to NON-default branches via the App. */
  write?: string[];
  /** Repos on which this agent may post pull-request reviews. */
  review?: string[];
  /** Repos on which this agent may merge and close pull requests. */
  merge?: MergeGrant[];
}

/**
 * The repos an agent may read and discuss through the pr Gatekeeper
 * (spec 0012 §3): the union of its pr, review and merge repos. A
 * reviewer with no pr grant still reads the pull requests it
 * adjudicates. `write` is deliberately absent: it is the App's branch
 * door on the github Gatekeeper, carries no account identity, and
 * never made a repo readable here.
 */
export function reachableGithubRepos(grants: GithubGrants | undefined): string[] {
  if (!grants) return [];
  const out = new Set<string>();
  for (const repo of grants.pr ?? []) out.add(repo);
  for (const repo of grants.review ?? []) out.add(repo);
  for (const grant of grants.merge ?? []) out.add(grant.repo);
  return [...out];
}

export class RosterError extends Error {
  override name = "RosterError";
}

const AGENT_ID = /^[a-z0-9][a-z0-9-]*$/;
const STATE_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HOST = /^(@|[a-z0-9]([a-z0-9-]*[a-z0-9])?)$/;
const ZONE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function fail(path: string, problem: string): never {
  throw new RosterError(`roster: ${path} ${problem}`);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(path, "must be a non-empty string");
  }
  return value;
}

const AGENT_KEYS = new Set([
  "id",
  "stateRepo",
  "cadence",
  "harness",
  "model",
  "fallbackModel",
  "maxWakeMinutes",
  "hosts",
  "web",
  "localBrowser",
  "enabled",
  "mcp",
  "github",
  "doors",
  "harnesses"
]);

const HARNESS_PIN_KEYS = new Set(["model", "fallbackModel"]);

/**
 * The alternate harnesses of one agent (spec 0010 §4): known harnesses
 * only, each with a model, never the primary again (two pins for one
 * harness would leave the wake to guess which is meant).
 */
function parseHarnesses(value: unknown, primary: Harness, path: string): Partial<Record<Harness, HarnessPin>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be a mapping of harness id to { model, fallbackModel? }");
  }
  const pins: Partial<Record<Harness, HarnessPin>> = {};
  for (const [harness, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isHarness(harness)) {
      fail(`${path}.${harness}`, `is not a harness (known: ${KNOWN_HARNESSES.join(", ")})`);
    }
    if (harness === primary) {
      fail(`${path}.${harness}`, "is the primary harness; its model is agents[].model");
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      fail(`${path}.${harness}`, "must be an object { model, fallbackModel? }");
    }
    const pin = raw as Record<string, unknown>;
    for (const key of Object.keys(pin)) {
      if (!HARNESS_PIN_KEYS.has(key)) {
        fail(`${path}.${harness}.${key}`, `is not a harness pin field (known: ${[...HARNESS_PIN_KEYS].join(", ")})`);
      }
    }
    const model = requireString(pin.model, `${path}.${harness}.model`);
    const fallbackModel =
      pin.fallbackModel === undefined
        ? undefined
        : requireString(pin.fallbackModel, `${path}.${harness}.fallbackModel`);
    pins[harness] = { model, ...(fallbackModel ? { fallbackModel } : {}) };
  }
  return pins;
}

/** MCP server names are slugs, and so are portal server ids (underscores allowed there). */
const MCP_NAME = /^[a-z0-9][a-z0-9-]*$/;
const PORTAL_SERVER = /^[a-z0-9][a-z0-9_-]*$/;

function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  return value.map((entry, i) => requireString(entry, `${path}[${i}]`));
}

/** The keys allowed per def type: an unknown key refuses, it never vanishes. */
const MCP_DEF_KEYS: Record<string, Set<string>> = {
  gatekeeper: new Set(["type", "worker"]),
  portal: new Set(["type", "server", "tools", "budget", "webhook"]),
  http: new Set(["type", "url", "auth", "tools", "budget", "webhook"]),
  stdio: new Set(["type", "command", "args"])
};

function parseMcpDef(name: string, value: unknown): McpServerDef {
  const path = `mcp.${name}`;
  if (!MCP_NAME.test(name)) fail(path, `"${name}" is not a valid server name (slug)`);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  const raw = value as Record<string, unknown>;
  const type = requireString(raw.type, `${path}.type`);
  const known = MCP_DEF_KEYS[type];
  if (!known) fail(`${path}.type`, `must be one of ${Object.keys(MCP_DEF_KEYS).join(", ")}`);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      // Named for the one likely mistake: stdio is credential-less by
      // construction, so env has no place to exist (spec 0008 §4).
      if (type === "stdio" && key === "env") {
        fail(`${path}.env`, "stdio_env_unsupported: stdio servers carry no env; a value that needs one belongs behind a gatekeeper or the portal");
      }
      fail(`${path}.${key}`, `is not a ${type} server field (known: ${[...known].join(", ")})`);
    }
  }
  const tools =
    raw.tools === undefined
      ? undefined
      : requireStringArray(raw.tools, `${path}.tools`).map(tool => {
          if (tool.length === 0) fail(`${path}.tools`, "must not contain empty names");
          if (tool.startsWith("portal_")) {
            fail(`${path}.tools`, `"${tool}" is never grantable: portal_* tools change which servers a session reaches`);
          }
          return tool;
        });
  switch (type) {
    case "gatekeeper": {
      const worker = requireString(raw.worker, `${path}.worker`);
      if (!/^gatekeeper-[a-z0-9-]+$/.test(worker)) {
        fail(`${path}.worker`, `"${worker}" is not a gatekeeper worker key`);
      }
      return { type, worker };
    }
    case "portal": {
      const server = requireString(raw.server, `${path}.server`);
      if (!PORTAL_SERVER.test(server)) fail(`${path}.server`, `"${server}" is not a server id`);
      return { type, server, ...(tools ? { tools } : {}), ...parseMetering(path, raw, tools) };
    }
    case "http": {
      const url = requireString(raw.url, `${path}.url`);
      if (!/^https:\/\//.test(url)) fail(`${path}.url`, "must be an https:// URL");
      const auth = requireString(raw.auth, `${path}.auth`);
      if (auth !== "none" && auth !== "bearer") fail(`${path}.auth`, 'must be "none" or "bearer"');
      return { type, url, auth, ...(tools ? { tools } : {}), ...parseMetering(path, raw, tools) };
    }
    default: {
      const command = requireString(raw.command, `${path}.command`);
      const args = requireStringArray(raw.args, `${path}.args`);
      // The pin rule, mechanically: an unpinned or range-pinned package
      // is whatever the registry serves that morning. Some arg must name
      // an EXACT version (npm's pkg@1.2.3 or pip's pkg==1.2.3), and no
      // arg may carry a range or a floating tag.
      // Full three-part versions on both ecosystems: pip's ==1.2 is
      // exact per PEP 440 but ==1.2.* floats, and a rule a reviewer
      // must squint at is a rule that rots; demand the unambiguous form.
      const EXACT_PIN = /(@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?|==\d+\.\d+\.\d+(?:[.!+-][0-9A-Za-z.]+)?)$/;
      const FLOATING = /@(?:latest$|next$|[\^~><=*])/;
      for (const arg of args) {
        if (FLOATING.test(arg) || ((arg.includes("@") || arg.includes("==")) && arg.includes("*"))) {
          fail(`${path}.args`, `"${arg}" is a range or floating tag; name an exact version`);
        }
      }
      if (!args.some(arg => EXACT_PIN.test(arg))) {
        fail(`${path}.args`, `no exact version pin found; name one in full (pkg@1.2.3 or pkg==1.2.3)`);
      }
      return { type: "stdio", command, args };
    }
  }
}

const BUDGET_KEYS = new Set(["monthlyUsd", "perCall", "free"]);
const WEBHOOK_KEYS = new Set([
  "createTools",
  "argument",
  "registration",
  "events",
  "runIdPath",
  "callbackRunIdPath",
  "callbackEventPath",
  "callbackIdPath",
  "signature"
]);
const SIGNATURE_KEYS = new Set(["header", "scheme", "timestampHeader"]);
const DOTTED_PATH = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
const TOOL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

function refuseUnknownKeys(raw: Record<string, unknown>, known: Set<string>, path: string, what: string): void {
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) fail(`${path}.${key}`, `is not a ${what} field (known: ${[...known].join(", ")})`);
  }
}

/** The budget and webhook blocks of a remote server (spec 0014 §2, §3), each optional. */
function parseMetering(
  path: string,
  raw: Record<string, unknown>,
  tools: string[] | undefined
): { budget?: McpBudget; webhook?: McpWebhook } {
  const out: { budget?: McpBudget; webhook?: McpWebhook } = {};
  if (raw.budget !== undefined) out.budget = parseBudget(`${path}.budget`, raw.budget);
  if (raw.webhook !== undefined) out.webhook = parseWebhook(`${path}.webhook`, raw.webhook, tools);
  return out;
}

function parseBudget(path: string, value: unknown): McpBudget {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "must be an object");
  const raw = value as Record<string, unknown>;
  refuseUnknownKeys(raw, BUDGET_KEYS, path, "budget");
  const monthlyUsd = raw.monthlyUsd;
  if (typeof monthlyUsd !== "number" || !Number.isFinite(monthlyUsd) || monthlyUsd <= 0) {
    fail(`${path}.monthlyUsd`, "must be a positive number of USD");
  }
  if (typeof raw.perCall !== "object" || raw.perCall === null || Array.isArray(raw.perCall)) {
    fail(`${path}.perCall`, "must be an object of tool name to USD per call");
  }
  // A null-prototype map and own-property checks: a tool named
  // "constructor" or "__proto__" is a tool name, not a prototype key.
  const perCall: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [tool, price] of Object.entries(raw.perCall as Record<string, unknown>)) {
    if (!TOOL_NAME.test(tool)) fail(`${path}.perCall`, `"${tool}" is not a tool name`);
    if (typeof price !== "number" || !Number.isFinite(price) || price < 0) {
      fail(`${path}.perCall.${tool}`, "must be a non-negative number of USD");
    }
    perCall[tool] = price;
  }
  const free = raw.free === undefined ? undefined : requireStringArray(raw.free, `${path}.free`);
  for (const tool of free ?? []) {
    if (!TOOL_NAME.test(tool)) fail(`${path}.free`, `"${tool}" is not a tool name`);
    if (Object.hasOwn(perCall, tool)) fail(`${path}.free`, `"${tool}" is priced in perCall; a tool is priced or free, not both`);
  }
  return { monthlyUsd, perCall, ...(free ? { free } : {}) };
}

/** Whether a JSON template carries a string that IS the placeholder (the whole value, its own JSON type). */
function templateHasField(value: unknown, placeholder: string): boolean {
  if (typeof value === "string") return value === placeholder;
  if (Array.isArray(value)) return value.some(item => templateHasField(item, placeholder));
  if (typeof value === "object" && value !== null) {
    return Object.values(value as Record<string, unknown>).some(item => templateHasField(item, placeholder));
  }
  return false;
}

function parseWebhook(path: string, value: unknown, tools: string[] | undefined): McpWebhook {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "must be an object");
  const raw = value as Record<string, unknown>;
  refuseUnknownKeys(raw, WEBHOOK_KEYS, path, "webhook");
  const createTools = requireStringArray(raw.createTools, `${path}.createTools`);
  if (createTools.length === 0) fail(`${path}.createTools`, "must name at least one tool");
  for (const tool of createTools) {
    if (tool.length === 0) fail(`${path}.createTools`, "must not contain empty names");
    if (tools && !tools.includes(tool)) fail(`${path}.createTools`, `"${tool}" is not one of this server's tools`);
  }
  const argument = requireString(raw.argument, `${path}.argument`);
  if (argument.length === 0) fail(`${path}.argument`, "must name the create call's argument");
  if (raw.registration === undefined) fail(`${path}.registration`, "is required: the provider's registration shape");
  // The callback URL is a whole field of the registration, never a
  // fragment inside a longer string: the provider reads it as a URL.
  if (!templateHasField(raw.registration, "{url}")) {
    fail(`${path}.registration`, 'must carry a field whose value is exactly "{url}", or the provider never learns the callback');
  }
  const events = requireStringArray(raw.events, `${path}.events`);
  if (events.length === 0) fail(`${path}.events`, "must name at least one event");
  const pathField = (key: string, required: boolean): string | undefined => {
    if (raw[key] === undefined) {
      if (required) fail(`${path}.${key}`, "is required");
      return undefined;
    }
    const text = requireString(raw[key], `${path}.${key}`);
    if (!DOTTED_PATH.test(text)) fail(`${path}.${key}`, `"${text}" is not a dotted path`);
    return text;
  };
  const runIdPath = pathField("runIdPath", true) as string;
  const callbackRunIdPath = pathField("callbackRunIdPath", true) as string;
  const callbackEventPath = pathField("callbackEventPath", true) as string;
  const callbackIdPath = pathField("callbackIdPath", false);
  if (typeof raw.signature !== "object" || raw.signature === null || Array.isArray(raw.signature)) {
    fail(`${path}.signature`, "must be an object {header, scheme, timestampHeader?}");
  }
  const sig = raw.signature as Record<string, unknown>;
  refuseUnknownKeys(sig, SIGNATURE_KEYS, `${path}.signature`, "signature");
  const header = requireString(sig.header, `${path}.signature.header`);
  if (header.length === 0) fail(`${path}.signature.header`, "must name the signature header");
  const scheme = requireString(sig.scheme, `${path}.signature.scheme`);
  if (!(MCP_SIGNATURE_SCHEMES as readonly string[]).includes(scheme)) {
    fail(`${path}.signature.scheme`, `mcp_webhook_scheme_unknown: "${scheme}" (known: ${MCP_SIGNATURE_SCHEMES.join(", ")})`);
  }
  const timestampHeader = sig.timestampHeader === undefined ? undefined : requireString(sig.timestampHeader, `${path}.signature.timestampHeader`);
  return {
    createTools,
    argument,
    registration: raw.registration,
    events,
    runIdPath,
    callbackRunIdPath,
    callbackEventPath,
    ...(callbackIdPath ? { callbackIdPath } : {}),
    signature: { header, scheme: scheme as McpSignatureScheme, ...(timestampHeader ? { timestampHeader } : {}) }
  };
}

/**
 * MCP server names the chassis stages itself: the web door's browser
 * (spec 0004 §3) and the local browser (spec 0004 §9). A colony server
 * under one of these would be refused at wake start, after the
 * container was already up; refusing it here keeps the failure at
 * check time, by name.
 */
export const RESERVED_MCP_NAMES = ["browser", "playwright"] as const;

function parseMcpDefs(value: unknown): Record<string, McpServerDef> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("mcp", "must be an object of server definitions");
  }
  const defs: Record<string, McpServerDef> = {};
  for (const [name, def] of Object.entries(value as Record<string, unknown>)) {
    if ((RESERVED_MCP_NAMES as readonly string[]).includes(name)) {
      fail(`mcp.${name}`, `is a chassis server name (reserved: ${RESERVED_MCP_NAMES.join(", ")})`);
    }
    defs[name] = parseMcpDef(name, def);
  }
  // Portal prefix grammars are ambiguous when one server id prefixes
  // another (spec 0008 §5): refuse at validation, not at call time.
  const portalIds = Object.values(defs)
    .filter(def => def.type === "portal")
    .map(def => (def as { server: string }).server);
  for (const a of portalIds) {
    for (const b of portalIds) {
      if (a !== b && b.startsWith(`${a}_`)) {
        fail("mcp", `portal_server_ambiguous: server id "${a}" prefixes "${b}"`);
      }
    }
  }
  return defs;
}

const GITHUB_GRANT_KEYS = new Set(["pr", "write", "review", "merge"]);
const MERGE_GRANT_KEYS = new Set(["repo", "auto", "checks"]);
/** A path glob: the safe path charset plus `*`; no leading slash, no `..` (checked apart). */
const AUTO_GLOB = /^[A-Za-z0-9_.*/-]+$/;

function parseMergeGrant(value: unknown, path: string): MergeGrant {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be an object {repo, auto?, checks?}");
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!MERGE_GRANT_KEYS.has(key)) {
      fail(`${path}.${key}`, `is not a merge grant field (known: ${[...MERGE_GRANT_KEYS].join(", ")})`);
    }
  }
  const repo = requireString(raw.repo, `${path}.repo`);
  if (!STATE_REPO.test(repo)) fail(`${path}.repo`, `"${repo}" is not "owner/repo"`);
  const grant: MergeGrant = { repo };
  if (raw.auto !== undefined) {
    grant.auto = requireStringArray(raw.auto, `${path}.auto`).map((glob, i) => {
      if (!AUTO_GLOB.test(glob) || glob.startsWith("/") || glob.split("/").includes("..")) {
        fail(`${path}.auto[${i}]`, `"${glob}" is not a path glob (letters, digits, . _ - / *; no leading /, no ..)`);
      }
      return glob;
    });
  }
  if (raw.checks !== undefined) {
    grant.checks = requireStringArray(raw.checks, `${path}.checks`).map((name, i) => {
      if (name.length === 0) fail(`${path}.checks[${i}]`, "must be a non-empty check name");
      return name;
    });
  }
  return grant;
}

function parseGithubGrants(value: unknown, path: string): GithubGrants {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!GITHUB_GRANT_KEYS.has(key)) {
      fail(`${path}.${key}`, `is not a github grant (known: ${[...GITHUB_GRANT_KEYS].join(", ")})`);
    }
  }
  const repos = (key: "pr" | "write" | "review"): string[] | undefined => {
    if (raw[key] === undefined) return undefined;
    return requireStringArray(raw[key], `${path}.${key}`).map((repo, i) => {
      if (!STATE_REPO.test(repo)) fail(`${path}.${key}[${i}]`, `"${repo}" is not "owner/repo"`);
      return repo;
    });
  };
  const pr = repos("pr");
  const write = repos("write");
  const review = repos("review");
  let merge: MergeGrant[] | undefined;
  if (raw.merge !== undefined) {
    if (!Array.isArray(raw.merge)) fail(`${path}.merge`, "must be an array of {repo, auto?, checks?}");
    merge = raw.merge.map((entry, i) => parseMergeGrant(entry, `${path}.merge[${i}]`));
    const seen = new Set<string>();
    for (const grant of merge) {
      if (seen.has(grant.repo)) fail(`${path}.merge`, `names "${grant.repo}" twice`);
      seen.add(grant.repo);
    }
  }
  return {
    ...(pr ? { pr } : {}),
    ...(write ? { write } : {}),
    ...(review ? { review } : {}),
    ...(merge ? { merge } : {})
  };
}

function parseAgent(value: unknown, index: number): RosterAgent {
  const path = `agents[${index}]`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  const raw = value as Record<string, unknown>;

  // Unknown keys refuse rather than vanish: a misspelled field is a
  // grant or a policy the operator BELIEVES is in force, and silently
  // dropping it is how "this agent may not X" quietly becomes "may X".
  for (const key of Object.keys(raw)) {
    if (!AGENT_KEYS.has(key)) {
      fail(`${path}.${key}`, `is not a roster field (known: ${[...AGENT_KEYS].join(", ")})`);
    }
  }

  const id = requireString(raw.id, `${path}.id`);
  if (!AGENT_ID.test(id)) fail(`${path}.id`, `"${id}" is not a valid slug`);

  const stateRepo = requireString(raw.stateRepo, `${path}.stateRepo`);
  if (!STATE_REPO.test(stateRepo)) {
    fail(`${path}.stateRepo`, `"${stateRepo}" is not "owner/repo"`);
  }

  const cadence = requireString(raw.cadence, `${path}.cadence`);
  const harness = requireString(raw.harness, `${path}.harness`);
  if (!isHarness(harness)) {
    fail(`${path}.harness`, `"${harness}" is not a harness (known: ${KNOWN_HARNESSES.join(", ")})`);
  }
  const model = requireString(raw.model, `${path}.model`);

  let fallbackModel: string | undefined;
  if (raw.fallbackModel !== undefined) {
    fallbackModel = requireString(raw.fallbackModel, `${path}.fallbackModel`);
  }

  let maxWakeMinutes: number | undefined;
  if (raw.maxWakeMinutes !== undefined) {
    if (
      typeof raw.maxWakeMinutes !== "number" ||
      !Number.isInteger(raw.maxWakeMinutes) ||
      raw.maxWakeMinutes < 1
    ) {
      fail(`${path}.maxWakeMinutes`, "must be a positive integer (minutes)");
    }
    maxWakeMinutes = raw.maxWakeMinutes;
  }

  if (!Array.isArray(raw.hosts) || raw.hosts.length === 0) {
    fail(`${path}.hosts`, "must be a non-empty array");
  }
  const hosts = raw.hosts.map((host, hostIndex) => {
    const value = requireString(host, `${path}.hosts[${hostIndex}]`);
    if (!HOST.test(value)) {
      fail(`${path}.hosts[${hostIndex}]`, `"${value}" is not "@" or a subdomain label`);
    }
    return value;
  });

  if (typeof raw.enabled !== "boolean") {
    fail(`${path}.enabled`, "must be a boolean");
  }

  if (raw.web !== undefined && typeof raw.web !== "boolean") {
    fail(`${path}.web`, "must be a boolean when present");
  }
  if (raw.localBrowser !== undefined && typeof raw.localBrowser !== "boolean") {
    fail(`${path}.localBrowser`, "must be a boolean when present");
  }

  let mcp: string[] | undefined;
  if (raw.mcp !== undefined) {
    mcp = requireStringArray(raw.mcp, `${path}.mcp`);
  }

  let github: GithubGrants | undefined;
  if (raw.github !== undefined) {
    github = parseGithubGrants(raw.github, `${path}.github`);
  }

  let harnesses: Partial<Record<Harness, HarnessPin>> | undefined;
  if (raw.harnesses !== undefined) {
    harnesses = parseHarnesses(raw.harnesses, harness, `${path}.harnesses`);
  }

  // The doors baseline (spec 0006 §7): named doors only, booleans only,
  // so a typo cannot silently leave a door open or closed.
  let doors: DoorBaseline | undefined;
  if (raw.doors !== undefined) {
    if (typeof raw.doors !== "object" || raw.doors === null || Array.isArray(raw.doors)) {
      fail(`${path}.doors`, "must be a mapping of door name to boolean");
    }
    doors = {};
    for (const [door, value] of Object.entries(raw.doors as Record<string, unknown>)) {
      if (!isDoor(door)) fail(`${path}.doors.${door}`, `is not a door (known: ${DOORS.join(", ")})`);
      if (typeof value !== "boolean") fail(`${path}.doors.${door}`, "must be a boolean");
      doors[door] = value;
    }
  }

  return {
    id,
    stateRepo,
    cadence,
    harness,
    model,
    fallbackModel,
    maxWakeMinutes,
    hosts,
    ...(raw.web === true ? { web: true } : {}),
    ...(raw.localBrowser === false ? { localBrowser: false } : {}),
    enabled: raw.enabled,
    ...(mcp ? { mcp } : {}),
    ...(github ? { github } : {}),
    ...(doors ? { doors } : {}),
    ...(harnesses ? { harnesses } : {})
  };
}

export function parseRoster(json: string): Roster {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new RosterError(`roster: not valid JSON (${(error as Error).message})`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("root", "must be an object");
  }
  const raw = value as Record<string, unknown>;

  const zone = requireString(raw.zone, "zone");
  if (!ZONE.test(zone)) fail("zone", `"${zone}" is not a registrable domain`);

  if (!Array.isArray(raw.agents)) fail("agents", "must be an array");
  const agents = raw.agents.map(parseAgent);

  const seen = new Set<string>();
  for (const agent of agents) {
    if (seen.has(agent.id)) fail(`agents`, `duplicate agent id "${agent.id}"`);
    seen.add(agent.id);
  }

  const mcp = raw.mcp === undefined ? undefined : parseMcpDefs(raw.mcp);
  // An agent's grant list may only name defined servers: a dangling
  // name is a capability the operator believes exists.
  for (const [index, agent] of agents.entries()) {
    for (const name of agent.mcp ?? []) {
      if (!mcp || !(name in mcp)) {
        fail(`agents[${index}].mcp`, `"${name}" names no server in the mcp: section`);
      }
    }
  }

  const registry = parseRegistry(raw.registry);
  // An adjudicator gets no DEFAULT authoring grant on the registry
  // (spec 0013 §2). An explicit github.pr listing beside its review or
  // merge grant is the operator's decision and stands: the doors keep
  // the verbs apart at the act (author_is_merger, self_approval), and a
  // merger that reads the registry's checks and files an issue about
  // them needs exactly that grant.
  return { zone, agents, ...(mcp ? { mcp } : {}), ...(registry ? { registry } : {}) };
}

const REGISTRY_KEYS = new Set(["site", "repo"]);

/**
 * The reference registry (spec 0013 §2): every agent on the chassis is
 * told to keep an entry there unless the colony says `registry: false`.
 * Its SKILL.md went live on 2026-09-08; this default shipped after.
 */
export const DEFAULT_REGISTRY: Readonly<RegistryPin> = Object.freeze({
  site: "https://public-agents.com",
  repo: "PublicAgents/public-agents"
});

/** Absence means the reference registry; `registry: false` means none; an object names one. */
function parseRegistry(value: unknown): RegistryPin | undefined {
  if (value === undefined) return { ...DEFAULT_REGISTRY };
  if (value === false) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("registry", "must be false or an object {site, repo}");
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!REGISTRY_KEYS.has(key)) fail(`registry.${key}`, `is not a registry field (known: ${[...REGISTRY_KEYS].join(", ")})`);
  }
  const site = requireString(raw.site, "registry.site");
  if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?\/?$/i.test(site)) fail("registry.site", `"${site}" must be an https origin`);
  const repo = requireString(raw.repo, "registry.repo");
  if (!STATE_REPO.test(repo)) fail("registry.repo", `"${repo}" is not "owner/repo"`);
  return { site: site.replace(/\/$/, ""), repo };
}

export function findAgent(roster: Roster, agentId: string): RosterAgent | undefined {
  return roster.agents.find(agent => agent.id === agentId);
}
