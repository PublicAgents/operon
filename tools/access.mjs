/**
 * The operator plane's Cloudflare Access application, owned by the
 * tools (spec 0009 §3). Bootstrap and deploy both call ensureOpsAccess:
 * read what the account holds, compare with what the manifest implies,
 * fix only what drifted, and say what was done. Never prints a secret:
 * a service token's secret goes straight into the repository's GitHub
 * Actions secrets through `gh`, or the token is deleted again.
 */
import { spawnSync } from "node:child_process";

const API = "https://api.cloudflare.com/client/v4";

/** What the manifest implies the Access application should be. */
export function desiredOpsAccess(manifest) {
  return {
    appName: `operon ${manifest.project} ops`,
    domain: `ops.${manifest.roster.zone}`,
    sessionDuration: "24h",
    allowPolicyName: "operator",
    operatorEmail: manifest.operatorEmail,
    serviceAuthPolicyName: "ci service token",
    serviceTokenName: `operon-${manifest.project}-ci`
  };
}

async function api(apiToken, method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiToken}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const detail = (payload.errors ?? []).map(error => error.message).join("; ") || `${response.status}`;
    const error = new Error(`${method} ${path}: ${detail}`);
    error.status = response.status;
    throw error;
  }
  return payload.result;
}

/**
 * Ensure the application, its policies and (when asked) its CI service
 * token exist as the manifest implies. Returns { teamDomain, aud, lines,
 * needs }: lines are what was found or done, needs what only the
 * operator can do.
 */
export async function ensureOpsAccess(manifest, { apiToken, accountId, createServiceToken, ghRepo }) {
  const want = desiredOpsAccess(manifest);
  const lines = [];
  const needs = [];
  const call = (method, path, body) => api(apiToken, method, path, body);

  // The Zero Trust organization names the team domain the plane verifies
  // against. The manifest carries it once bootstrap has run, and reading
  // it from there spares the CI token a third permission (Organizations,
  // Identity Providers, and Groups: Read); the organization is read only
  // when the manifest does not yet say.
  let teamDomain = manifest.access?.teamDomain;
  if (!teamDomain) {
    const organization = await call("GET", `/accounts/${accountId}/access/organizations`);
    const authDomain = organization?.auth_domain;
    if (!authDomain) {
      needs.push("no Zero Trust organization on this account: create one (Zero Trust → Settings) and re-run");
      return { teamDomain: undefined, aud: undefined, lines, needs };
    }
    teamDomain = `https://${authDomain}`;
  }

  // The application, by domain.
  const apps = await call("GET", `/accounts/${accountId}/access/apps`);
  let app = (apps ?? []).find(candidate => candidate.domain === want.domain);
  if (!app) {
    app = await call("POST", `/accounts/${accountId}/access/apps`, {
      name: want.appName,
      domain: want.domain,
      type: "self_hosted",
      session_duration: want.sessionDuration,
      app_launcher_visible: false
    });
    lines.push(`+ Access application ${want.domain}`);
  } else {
    lines.push(`✓ Access application ${want.domain}`);
  }
  const appId = app.id ?? app.uid;

  // Policies on the application: the operator's email, and the CI token.
  const policies = await call("GET", `/accounts/${accountId}/access/apps/${appId}/policies`);
  const byName = new Map((policies ?? []).map(policy => [policy.name, policy]));

  if (want.operatorEmail) {
    const allow = byName.get(want.allowPolicyName);
    const wantInclude = [{ email: { email: want.operatorEmail } }];
    if (!allow) {
      await call("POST", `/accounts/${accountId}/access/apps/${appId}/policies`, {
        name: want.allowPolicyName,
        decision: "allow",
        include: wantInclude,
        precedence: 1
      });
      lines.push(`+ policy "${want.allowPolicyName}": allow ${want.operatorEmail}`);
    } else if (JSON.stringify(allow.include) !== JSON.stringify(wantInclude) || allow.decision !== "allow") {
      await call("PUT", `/accounts/${accountId}/access/apps/${appId}/policies/${allow.id}`, {
        name: want.allowPolicyName,
        decision: "allow",
        include: wantInclude,
        precedence: allow.precedence ?? 1
      });
      lines.push(`~ policy "${want.allowPolicyName}": now allows ${want.operatorEmail} only`);
    } else {
      lines.push(`✓ policy "${want.allowPolicyName}": allow ${want.operatorEmail}`);
    }
  } else {
    needs.push("the manifest has no operatorEmail: no one can sign in to the plane until it names one");
  }

  // The CI service token, by name.
  const tokens = await call("GET", `/accounts/${accountId}/access/service_tokens`);
  let token = (tokens ?? []).find(candidate => candidate.name === want.serviceTokenName);
  if (!token) {
    if (!createServiceToken) {
      needs.push(
        `no service token named ${want.serviceTokenName}: run bootstrap (it creates one and stores it in the ` +
          `repository's GitHub secrets CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET)`
      );
    } else {
      const created = await call("POST", `/accounts/${accountId}/access/service_tokens`, {
        name: want.serviceTokenName,
        duration: "8760h"
      });
      const stored = ghRepo
        ? storeGithubSecrets(ghRepo, {
            CF_ACCESS_CLIENT_ID: created.client_id,
            CF_ACCESS_CLIENT_SECRET: created.client_secret
          })
        : { ok: false, reason: "no GitHub repository to store them in (not a git checkout with an origin)" };
      if (stored.ok) {
        lines.push(`+ service token ${want.serviceTokenName}, id and secret stored as GitHub secrets on ${ghRepo}`);
        token = created;
      } else {
        // Never print it, never leave it dangling: a token nobody holds is
        // a credential nobody can rotate or revoke on purpose.
        await call("DELETE", `/accounts/${accountId}/access/service_tokens/${created.id}`).catch(() => undefined);
        needs.push(
          `could not store the service token's secret (${stored.reason}); the token was deleted again. ` +
            `Make one by hand (Zero Trust → Access → Service auth) and set CF_ACCESS_CLIENT_ID / ` +
            `CF_ACCESS_CLIENT_SECRET as GitHub Actions secrets.`
        );
      }
    }
  } else {
    lines.push(`✓ service token ${want.serviceTokenName}`);
  }

  if (token) {
    const serviceAuth = byName.get(want.serviceAuthPolicyName);
    const wantInclude = [{ service_token: { token_id: token.id } }];
    if (!serviceAuth) {
      await call("POST", `/accounts/${accountId}/access/apps/${appId}/policies`, {
        name: want.serviceAuthPolicyName,
        decision: "non_identity",
        include: wantInclude,
        precedence: 2
      });
      lines.push(`+ policy "${want.serviceAuthPolicyName}": service auth for ${want.serviceTokenName}`);
    } else if (JSON.stringify(serviceAuth.include) !== JSON.stringify(wantInclude)) {
      await call("PUT", `/accounts/${accountId}/access/apps/${appId}/policies/${serviceAuth.id}`, {
        name: want.serviceAuthPolicyName,
        decision: "non_identity",
        include: wantInclude,
        precedence: serviceAuth.precedence ?? 2
      });
      lines.push(`~ policy "${want.serviceAuthPolicyName}": now the token ${want.serviceTokenName}`);
    } else {
      lines.push(`✓ policy "${want.serviceAuthPolicyName}": service auth for ${want.serviceTokenName}`);
    }
  }

  return { teamDomain, aud: app.aud, lines, needs };
}

/** Write secrets into a repository's Actions secrets through gh; values never touch argv. */
function storeGithubSecrets(repo, secrets) {
  for (const [name, value] of Object.entries(secrets)) {
    const result = spawnSync("gh", ["secret", "set", name, "--repo", repo], {
      input: value,
      encoding: "utf8"
    });
    if (result.status !== 0) return { ok: false, reason: `gh secret set ${name}: ${result.stderr.trim().slice(0, 160)}` };
  }
  return { ok: true };
}

/** owner/repo of the checkout's origin, or undefined. */
export function githubRepoOf(cwd) {
  const result = spawnSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8" });
  if (result.status !== 0) return undefined;
  const match = /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?\s*$/.exec(result.stdout.trim());
  return match ? match[1] : undefined;
}
