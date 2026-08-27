#!/usr/bin/env node
/**
 * Mint an AGENT's own X access token/secret with the PIN-based OAuth
 * 1.0a flow and put them straight into the x Gatekeeper's secrets,
 * never printed, never on argv:
 *
 *   node operon/tools/x-authorize.mjs promoter   (from the colony root)
 *
 * Why this exists: the developer app lives in the OPERATOR's workspace,
 * so the console's one-click token belongs to the operator's account.
 * This flow has the AGENT's logged-in browser approve the app instead,
 * so the minted token belongs to the agent's account while billing and
 * the app stay with the operator.
 *
 * Prompts for the app's API key/secret (hidden input), requests a
 * request token (oob), prints the authorize URL to open in a browser
 * logged in as the AGENT's X account, exchanges the PIN, then pipes the
 * access token and secret into `wrangler secret put`.
 */
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

// Chassis tooling, colony data: run from a COLONY checkout's root.
const ROOT = process.cwd();
if (!existsSync(join(ROOT, "workers", "gatekeeper-x", "wrangler.jsonc"))) {
  console.error("run this from a colony root (workers/gatekeeper-x/wrangler.jsonc not found)");
  process.exit(2);
}

const agentId = process.argv[2];
if (!agentId) {
  console.error("usage: node scripts/x-authorize.mjs <agentId>");
  process.exit(2);
}
const SUFFIX = agentId.toUpperCase().replace(/-/g, "_");

// The agent must exist in the roster: a typo would otherwise mint real
// credentials under secret names nothing reads, leaving the intended
// agent unconfigured with no error anywhere.
{
  const stripJsonc = text =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const roster = JSON.parse(stripJsonc(readFileSync(join(ROOT, "roster.jsonc"), "utf8")));
  if (!roster.agents.some(agent => agent.id === agentId)) {
    console.error(
      `unknown agent "${agentId}"; roster has: ${roster.agents.map(agent => agent.id).join(", ")}`
    );
    process.exit(2);
  }
}


function ask(question, { hidden = false } = {}) {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Mask the value: echo is suppressed by rewriting the line.
      const write = rl._writeToOutput.bind(rl);
      rl._writeToOutput = string =>
        write(string.includes(question) ? string : string.replace(/[^\r\n]/g, "*"));
    }
    rl.question(question, answer => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

const enc = value =>
  encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** One signed OAuth1 request against the token endpoints (form/query params in scope). */
async function oauthRequest(url, consumer, extraOauth = {}, tokenSecret = "") {
  const params = {
    oauth_consumer_key: consumer.key,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: "1.0",
    ...extraOauth
  };
  const base =
    "POST&" +
    enc(url) +
    "&" +
    enc(
      Object.entries(params)
        .map(([k, v]) => [enc(k), enc(v)])
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join("&")
    );
  const signature = createHmac("sha1", `${enc(consumer.secret)}&${enc(tokenSecret)}`)
    .update(base)
    .digest("base64");
  const header =
    "OAuth " +
    Object.entries({ ...params, oauth_signature: signature })
      .map(([k, v]) => `${enc(k)}="${enc(v)}"`)
      .join(", ");
  const response = await fetch(url, { method: "POST", headers: { authorization: header } });
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} answered ${response.status}: ${text.slice(0, 200)}`);
  return Object.fromEntries(new URLSearchParams(text));
}

const consumer = {
  key: await ask("App API key: ", { hidden: true }),
  secret: await ask("App API secret: ", { hidden: true })
};
if (!consumer.key || !consumer.secret) {
  console.error("both app keys are required");
  process.exit(2);
}

console.log("\nrequesting a token from X…");
const request = await oauthRequest("https://api.x.com/oauth/request_token", consumer, {
  oauth_callback: "oob"
});

console.log(
  `\n1. Open this URL in a browser where you are logged in as the AGENT's X account (${agentId}):\n\n` +
    `   https://api.x.com/oauth/authorize?oauth_token=${request.oauth_token}\n\n` +
    "2. Approve the app; X shows a PIN.\n"
);
const pin = await ask("PIN: ");

const access = await oauthRequest(
  "https://api.x.com/oauth/access_token",
  consumer,
  { oauth_token: request.oauth_token, oauth_verifier: pin },
  request.oauth_token_secret
);
if (!access.oauth_token || !access.oauth_token_secret) {
  console.error("X did not return an access token");
  process.exit(1);
}
console.log(`\nauthorized as @${access.screen_name ?? "?"}; storing secrets (values never shown)…`);

function put(secretName, value) {
  execFileSync(
    "npx",
    ["wrangler", "secret", "put", secretName, "-c", "workers/gatekeeper-x/wrangler.jsonc"],
    { cwd: ROOT, input: value, stdio: ["pipe", "inherit", "inherit"] }
  );
}
put(`X_ACCESS_TOKEN_${SUFFIX}`, access.oauth_token);
put(`X_ACCESS_SECRET_${SUFFIX}`, access.oauth_token_secret);

console.log(
  `\n✓ X_ACCESS_TOKEN_${SUFFIX} + X_ACCESS_SECRET_${SUFFIX} stored for @${access.screen_name ?? agentId}.` +
    "\nRemaining: X_API_KEY / X_API_SECRET (if not yet set), NOTIFY_TOKEN, OPERATOR_API_TOKEN," +
    "\nnpm run rotate:tokens -- --only x-" +
    agentId +
    ", and flip X_DISCLOSURE_ATTESTED once the account is labeled."
);
