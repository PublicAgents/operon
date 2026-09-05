import { parse as parseYaml } from "yaml";
import {
  EgressTableError,
  parseEgressBlocklist,
  parseEgressPolicy,
  parseRoster,
  type EgressProxyDef,
  type Roster
} from "@operon/core";

/**
 * The operon.yaml manifest (spec 0006 §1 and §2): everything
 * project-specific, and nothing else. Worker topology, bindings, DO
 * migrations, and compatibility settings are chassis knowledge and
 * live in the templates; the manifest carries identity, zone, policy
 * values, and resource identity. Validation here IS the upgrade
 * contract: a chassis bump that needs a new setting fails loudly at
 * `--check`, naming the key, before anything deploys.
 */

export class ManifestError extends Error {}

function fail(path: string, message: string): never {
  throw new ManifestError(`operon.yaml: ${path} ${message}`);
}

const PROJECT_NAME = /^[a-z][a-z0-9-]{1,40}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The per-worker policy vars the manifest may set. Everything else a
 * worker needs is either derived (NOTIFY_URL, the gatekeeper URLs) or
 * chassis-fixed; an unknown key here is far more likely a typo that
 * would otherwise be silently ignored, so unknown keys REFUSE.
 */
export const POLICY_VARS: Record<string, readonly string[]> = {
  spend: [
    "SPEND_MAX_TX",
    "SPEND_DAILY_CAP",
    "SPEND_HOLD_MAX",
    "SPEND_ALLOWANCE_DAYS",
    "SPEND_TESTNET",
    "SPEND_CHAIN_ID",
    "SPEND_CURRENCIES"
  ],
  till: ["TILL_MAX_PRICE", "TILL_MAX_OFFERS", "TILL_TESTNET", "TILL_CURRENCIES", "TILL_RPC_CHAIN_ID"],
  x: ["X_DISCLOSURE_ATTESTED", "X_DAILY_CAP"],
  email: ["EMAIL_DOMAIN"],
  pr: ["PR_REPOS"],
  deploy: ["DISCLOSURE_MARKER", "GA_MEASUREMENT_ID"],
  "google-analytics": ["GA_PROPERTY_ID"],
  mcp: ["MCP_PORTAL_URL"],
  browser: ["WEB_MAX_CONCURRENT"],
  scheduler: ["HARNESS_EXTRA_ARGS", "HARNESS_EXTRA_ARGS_CODEX"],
  asks: ["ASKS_MAX_PER_WAKE", "ASKS_MAX_PER_DAY"]
};

/** One project enrolled in the control plane this project hosts (spec 0006 §9). */
export interface EnrolledProject {
  project: string;
  zone: string;
  workerPrefix: string;
}

export interface FleetManifest {
  /** The project identity: seeds every account-level resource name. */
  project: string;
  /**
   * The control plane (spec 0006 §9): this project's ops worker binds to
   * every enrolled project's gatekeepers and scheduler, and fills an
   * omitted `project` argument with the default. Absent, the plane
   * serves this project alone.
   */
  control: { defaultProject: string; enrolled: EnrolledProject[] };
  accountId: string;
  /** Where the operator is reachable: asks and mail copies land here. */
  operatorEmail?: string;
  /** Worker name prefix; workers are `<prefix>-gatekeeper-*` and `<prefix>-scheduler`. */
  workerPrefix: string;
  /** The plane's Access application (spec 0009 §3): filled by bootstrap, absent until then. */
  access?: { teamDomain: string; aud: string };
  resources: {
    d1Name: string;
    /** Site-store KV id; when absent, resolved by title `<prefix>-site` at deploy. */
    siteStoreKvId?: string;
  };
  containers: { maxInstances: number };
  policy: Record<string, Record<string, string>>;
  /**
   * The mind session's egress policy (spec 0004 §5, §8). `proxies`
   * defines the upstream proxies by name (address, and the NAME of a
   * credential secret, never its value); `proxy` maps host patterns to
   * a proxy name or "direct", absent meaning everything direct;
   * `blocklist` is the hosts the session may not reach, ONE list for
   * the browser door and the container forwarder alike. Rendered into
   * the scheduler's EGRESS_PROXY and EGRESS_BLOCKLIST vars and the
   * browser Gatekeeper's WEB_ORIGIN_DENYLIST.
   */
  egress?: { proxies?: Record<string, EgressProxyDef>; proxy?: Record<string, string>; blocklist?: string[] };
  roster: Roster;
}

const EGRESS_KEYS = ["proxies", "proxy", "blocklist"] as const;

/**
 * The egress block. The proxies and the host map are checked with the
 * chassis grammar so a bad name, pattern or address, a route to an
 * undefined proxy, or a LITERAL credential fails here, by name, before
 * it can be rendered or committed. A key starting with `*` must be
 * quoted in YAML (an unquoted one is an alias), which the YAML parser
 * reports before this runs. Unknown keys refuse, as everywhere in this
 * validator: a misspelt policy must not pass as no policy.
 */
function validateEgress(raw: unknown): FleetManifest["egress"] {
  if (raw === undefined) return undefined;
  const record = requireRecord(raw, "egress");
  for (const key of Object.keys(record)) {
    if (!(EGRESS_KEYS as readonly string[]).includes(key)) {
      fail(`egress.${key}`, `is not a known key (known: ${EGRESS_KEYS.join(", ")})`);
    }
  }
  const egress: NonNullable<FleetManifest["egress"]> = {};
  if (record.proxies !== undefined || record.proxy !== undefined) {
    let policy;
    try {
      policy = parseEgressPolicy({
        ...(record.proxies !== undefined ? { proxies: record.proxies } : {}),
        ...(record.proxy !== undefined ? { routes: record.proxy } : {})
      });
    } catch (error) {
      if (error instanceof EgressTableError) fail("egress", error.message);
      throw error;
    }
    if (record.proxies !== undefined) egress.proxies = policy.proxies;
    if (record.proxy !== undefined) egress.proxy = policy.routes;
  }
  if (record.blocklist !== undefined) {
    try {
      egress.blocklist = parseEgressBlocklist(record.blocklist);
    } catch (error) {
      if (error instanceof EgressTableError) fail("egress.blocklist", error.message);
      throw error;
    }
  }
  return egress;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be a mapping");
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) fail(path, "must be a non-empty string");
  return value;
}

function validatePolicy(raw: unknown): Record<string, Record<string, string>> {
  if (raw === undefined) return {};
  const record = requireRecord(raw, "policy");
  const policy: Record<string, Record<string, string>> = {};
  for (const [worker, vars] of Object.entries(record)) {
    const allowed = POLICY_VARS[worker];
    if (!allowed) {
      fail(`policy.${worker}`, `is not a policy-bearing worker (known: ${Object.keys(POLICY_VARS).join(", ")})`);
    }
    const entries = requireRecord(vars, `policy.${worker}`);
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(entries)) {
      if (!allowed.includes(key)) {
        fail(`policy.${worker}.${key}`, `is not a known var for this worker (known: ${allowed.join(", ")})`);
      }
      if (typeof value !== "string") {
        fail(`policy.${worker}.${key}`, "must be a string (wrangler vars are strings; quote numbers)");
      }
      out[key] = value;
    }
    policy[worker] = out;
  }
  return policy;
}

export interface ValidateOptions {
  /**
   * The `.operon/projects/<name>/` directory name, in the multi-project
   * layout: it MUST equal the manifest's project field (spec 0006 §1),
   * so selection has exactly one identity.
   */
  directoryName?: string;
}

export function validateManifest(raw: unknown, options: ValidateOptions = {}): FleetManifest {
  const root = requireRecord(raw, "root");

  const project = requireString(root.project, "project");
  if (!PROJECT_NAME.test(project)) {
    fail("project", `"${project}" must match ${PROJECT_NAME} (lowercase, digits, hyphens)`);
  }
  if (options.directoryName !== undefined && options.directoryName !== project) {
    fail(
      "project",
      `"${project}" does not match its directory ".operon/projects/${options.directoryName}/": the directory name and the project field are one identity and must be equal`
    );
  }

  const accountId = requireString(root.accountId, "accountId");
  if (!HEX32.test(accountId)) fail("accountId", "must be the 32-hex Cloudflare account id");

  // The operator's own address: asks (spec 0007) and outbound mail
  // copies land here. Optional, because a colony can run headless,
  // but an asks Gatekeeper without it can only reach the console.
  let operatorEmail: string | undefined;
  if (root.operatorEmail !== undefined) {
    operatorEmail = requireString(root.operatorEmail, "operatorEmail");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(operatorEmail)) {
      fail("operatorEmail", `"${operatorEmail}" is not an email address`);
    }
  }

  const workerPrefix =
    root.workerPrefix === undefined ? `operon-${project}` : requireString(root.workerPrefix, "workerPrefix");
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(workerPrefix)) {
    fail("workerPrefix", `"${workerPrefix}" must be lowercase, digits, hyphens`);
  }

  let accessBlock: { teamDomain: string; aud: string } | undefined;
  if (root.access !== undefined) {
    const access = requireRecord(root.access, "access");
    const teamDomain = requireString(access.teamDomain, "access.teamDomain");
    if (!teamDomain.startsWith("https://")) fail("access.teamDomain", "must be an https URL");
    const aud = requireString(access.aud, "access.aud");
    if (!HEX64.test(aud)) fail("access.aud", "must be the 64-hex Access application AUD");
    accessBlock = { teamDomain, aud };
  }

  const resourcesRaw = root.resources === undefined ? {} : requireRecord(root.resources, "resources");
  const d1Name =
    resourcesRaw.d1Name === undefined ? `operon-${project}` : requireString(resourcesRaw.d1Name, "resources.d1Name");
  let siteStoreKvId: string | undefined;
  if (resourcesRaw.siteStoreKvId !== undefined) {
    siteStoreKvId = requireString(resourcesRaw.siteStoreKvId, "resources.siteStoreKvId");
    if (!HEX32.test(siteStoreKvId)) fail("resources.siteStoreKvId", "must be a 32-hex KV namespace id");
  }

  const containersRaw = root.containers === undefined ? {} : requireRecord(root.containers, "containers");
  const maxInstances = containersRaw.maxInstances === undefined ? 4 : containersRaw.maxInstances;
  if (typeof maxInstances !== "number" || !Number.isInteger(maxInstances) || maxInstances < 1 || maxInstances > 20) {
    fail("containers.maxInstances", "must be an integer between 1 and 20");
  }

  const policy = validatePolicy(root.policy);
  const egress = validateEgress(root.egress);

  // The control plane's enrollment (spec 0006 §9): which OTHER projects
  // this project's ops worker binds to, and the default. Bindings are
  // rendered from this list, so a typo here is a binding to nowhere;
  // shapes are checked as strictly as the project's own.
  const controlRaw = root.control === undefined ? {} : requireRecord(root.control, "control");
  const enrolled: EnrolledProject[] = [];
  if (controlRaw.projects !== undefined) {
    if (!Array.isArray(controlRaw.projects)) fail("control.projects", "must be a list");
    controlRaw.projects.forEach((entry, index) => {
      const path = `control.projects[${index}]`;
      const record = requireRecord(entry, path);
      const name = requireString(record.project, `${path}.project`);
      if (!PROJECT_NAME.test(name)) fail(`${path}.project`, `"${name}" must match ${PROJECT_NAME}`);
      if (name === project) fail(`${path}.project`, `"${name}" is this project; the host is enrolled implicitly`);
      if (enrolled.some(other => other.project === name)) fail(`${path}.project`, `"${name}" is listed twice`);
      const zone = requireString(record.zone, `${path}.zone`);
      const prefix =
        record.workerPrefix === undefined ? `operon-${name}` : requireString(record.workerPrefix, `${path}.workerPrefix`);
      if (!/^[a-z][a-z0-9-]{1,40}$/.test(prefix)) fail(`${path}.workerPrefix`, `"${prefix}" must be lowercase, digits, hyphens`);
      if (prefix === workerPrefix) fail(`${path}.workerPrefix`, `"${prefix}" is this project's own prefix`);
      // Bindings and secret writes are addressed by prefix: two projects
      // on one prefix would be one set of Workers under two names, and
      // the plane's per-project isolation would be a fiction.
      if (enrolled.some(other => other.workerPrefix === prefix)) {
        fail(`${path}.workerPrefix`, `"${prefix}" is already the prefix of another enrolled project`);
      }
      for (const key of Object.keys(record)) {
        if (!["project", "zone", "workerPrefix"].includes(key)) fail(`${path}.${key}`, "is not a known key");
      }
      enrolled.push({ project: name, zone, workerPrefix: prefix });
    });
  }
  const defaultProject =
    controlRaw.default === undefined ? project : requireString(controlRaw.default, "control.default");
  if (defaultProject !== project && !enrolled.some(entry => entry.project === defaultProject)) {
    fail("control.default", `"${defaultProject}" is neither this project nor an enrolled one`);
  }
  for (const key of Object.keys(controlRaw)) {
    if (!["default", "projects"].includes(key)) fail(`control.${key}`, "is not a known key");
  }

  // The roster portion is validated by the CHASSIS's own parser: one
  // validator, no drift between what deploy accepts and what the
  // scheduler will parse out of the ROSTER var.
  if (root.zone === undefined) fail("zone", "is required");
  if (root.agents === undefined) fail("agents", "is required");
  const roster = parseRoster(
    JSON.stringify({
      zone: root.zone,
      agents: root.agents,
      ...(root.mcp !== undefined ? { mcp: root.mcp } : {})
    })
  );

  // The per-agent github.pr grant and the fleet-wide PR_REPOS var are
  // two sources of the same truth; both at once is how allowlists rot
  // (spec 0008 §3). PR_REPOS remains the fallback for agents with no
  // github: block, for one release.
  if (policy.pr?.PR_REPOS !== undefined) {
    for (const agent of roster.agents) {
      if (agent.github !== undefined) {
        fail(
          "policy.pr.PR_REPOS",
          `conflicts with agents.${agent.id}.github; grant repos per agent OR fleet-wide, not both`
        );
      }
    }
  }

  // A merge grant with auto paths on a repo where no OTHER agent may
  // review is a policy that can never fire (spec 0012 §3): the operator
  // believes it is in force and it is dead. A grant with no auto paths
  // holds every merge for the operator and needs no reviewer.
  for (const agent of roster.agents) {
    for (const grant of agent.github?.merge ?? []) {
      if (!grant.auto?.length) continue;
      const reviewer = roster.agents.find(
        other => other.id !== agent.id && (other.github?.review ?? []).includes(grant.repo)
      );
      if (!reviewer) {
        fail(
          `agents.${agent.id}.github.merge`,
          `merge_without_reviewer: no other agent holds github.review on ${grant.repo}`
        );
      }
    }
  }

  return {
    project,
    control: { defaultProject, enrolled },
    accountId,
    ...(operatorEmail !== undefined ? { operatorEmail } : {}),
    workerPrefix,
    ...(accessBlock ? { access: accessBlock } : {}),
    resources: { d1Name, ...(siteStoreKvId !== undefined ? { siteStoreKvId } : {}) },
    containers: { maxInstances },
    policy,
    ...(egress !== undefined ? { egress } : {}),
    roster
  };
}

/** Parse and validate an operon.yaml text in one step. */
export function parseManifest(yamlText: string, options: ValidateOptions = {}): FleetManifest {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (error) {
    throw new ManifestError(`operon.yaml: not valid YAML (${(error as Error).message})`);
  }
  return validateManifest(raw, options);
}
