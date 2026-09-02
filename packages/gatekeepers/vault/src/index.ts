import { findAgent, parseRoster, type RosterAgent } from "@operon/core";
import { errorResponse, json, readJson, requireBearer, Ledger, OpsEntrypoint,
  notifyOperator as sendOperatorNotify,
  type TelegramGatewayBinding
} from "@operon/worker-kit";
import { validLabel, valueProblem, vaultTokenVar } from "./policy.js";
import { VaultBox } from "./vault-do.js";

export { Ledger, VaultBox };

/** The operator's binding-only view of the vault ledger (spec 0003 step 3). */
export class Ops extends OpsEntrypoint<Env> {
  protected async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/gatekeeper/vault/ledger") return json(await ledger(this.env).recent());
    return errorResponse(404, "not_found");
  }
}
export * from "./policy.js";

/**
 * The vault Gatekeeper: an agent's own secret store, so a secret can
 * survive between wakes without ever living in the state repo (hard rule
 * 7). The agent hands over {label, value} during one wake and asks for
 * the value by label in a later one; the wake supervisor pulls every
 * value at boot and folds them into the secret sweep's denylist, which is
 * what makes "a vaulted secret can never land in the repo or leave
 * through a door" mechanical rather than aspirational.
 *
 * Identity derives from WHICH per-agent bearer matched (the spend
 * Gatekeeper's pattern): an agent can only ever see its own vault.
 * Labels are ledgered; values never appear in a ledger, a log, or a
 * notify.
 */

interface Env {
  ROSTER: string;
  /** The telegram Gatekeeper over a service binding (spec 0009). */
  TELEGRAM?: TelegramGatewayBinding;
  /** Secrets. */
  NOTIFY_TOKEN?: string;
  /** Per-agent bearers as VAULT_TOKEN_<AGENTID>. */
  [name: string]: unknown;
  VAULT: DurableObjectNamespace<VaultBox>;
  LEDGER: DurableObjectNamespace<Ledger>;
}

function ledger(env: Env) {
  return env.LEDGER.get(env.LEDGER.idFromName("vault"));
}

function vaultBox(env: Env, agentId: string) {
  return env.VAULT.get(env.VAULT.idFromName(agentId));
}

function agentFromBearer(request: Request, env: Env): RosterAgent | null {
  const roster = parseRoster(env.ROSTER);
  for (const agent of roster.agents) {
    const expected = env[vaultTokenVar(agent.id)];
    if (typeof expected === "string" && expected.length > 0) {
      if (requireBearer(request, expected) === null) return findAgent(roster, agent.id) ?? null;
    }
  }
  return null;
}

/** Operator alerts ride the TELEGRAM binding (spec 0009); the public path is gone. */
async function notifyOperator(env: Env, text: string): Promise<void> {
  await sendOperatorNotify(env, text);
}

async function record(env: Env, event: string, data: Record<string, unknown>): Promise<void> {
  try {
    await ledger(env).append(event, data);
  } catch (error) {
    console.error("vault ledger append failed", error);
  }
}

async function handleSet(request: Request, env: Env, agent: RosterAgent): Promise<Response> {
  const body = await readJson<{ label?: unknown; value?: unknown }>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  const { label, value } = body.value;
  if (!validLabel(label)) return errorResponse(400, "invalid_label");
  const problem = valueProblem(value);
  if (problem) return errorResponse(400, `invalid_value_${problem}`);

  const result = await vaultBox(env, agent.id).set(label, value as string, new Date().toISOString());
  if (!result.ok) return errorResponse(409, result.problem);
  await record(env, "vault_set", { agentId: agent.id, label, created: result.created });
  if (result.created) {
    await notifyOperator(env, `[${agent.id}] vaulted a new secret under label "${label}"`);
  }
  return json({ ok: true, label, created: result.created });
}

async function handleGet(request: Request, env: Env, agent: RosterAgent): Promise<Response> {
  const body = await readJson<{ label?: unknown }>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  const { label } = body.value;
  if (!validLabel(label)) return errorResponse(400, "invalid_label");
  const value = await vaultBox(env, agent.id).get(label);
  if (value === null) return errorResponse(404, "label_not_found", label);
  await record(env, "vault_get", { agentId: agent.id, label });
  return json({ ok: true, label, value });
}

async function handleList(env: Env, agent: RosterAgent): Promise<Response> {
  return json({ ok: true, secrets: await vaultBox(env, agent.id).list() });
}

async function handleDelete(request: Request, env: Env, agent: RosterAgent): Promise<Response> {
  const body = await readJson<{ label?: unknown }>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  const { label } = body.value;
  if (!validLabel(label)) return errorResponse(400, "invalid_label");
  const deleted = await vaultBox(env, agent.id).delete(label);
  if (!deleted) return errorResponse(404, "label_not_found", label);
  await record(env, "vault_delete", { agentId: agent.id, label });
  await notifyOperator(env, `[${agent.id}] deleted vaulted secret "${label}"`);
  return json({ ok: true, label });
}

/**
 * Every value for one agent: the wake supervisor's denylist pull, made
 * with the same per-agent bearer. Ledgered by count only.
 */
async function handleAll(env: Env, agent: RosterAgent): Promise<Response> {
  const secrets = await vaultBox(env, agent.id).all();
  await record(env, "vault_all", { agentId: agent.id, count: secrets.length });
  return json({ ok: true, secrets });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "POST") return errorResponse(404, "not_found");
    const agent = agentFromBearer(request, env);
    if (!agent) return errorResponse(401, "unauthorized");
    if (url.pathname === "/gatekeeper/vault/set") return handleSet(request, env, agent);
    if (url.pathname === "/gatekeeper/vault/get") return handleGet(request, env, agent);
    if (url.pathname === "/gatekeeper/vault/list") return handleList(env, agent);
    if (url.pathname === "/gatekeeper/vault/delete") return handleDelete(request, env, agent);
    if (url.pathname === "/gatekeeper/vault/all") return handleAll(env, agent);
    return errorResponse(404, "not_found");
  }
} satisfies ExportedHandler<Env>;
