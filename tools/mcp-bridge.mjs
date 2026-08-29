#!/usr/bin/env node
/**
 * Stdio-to-gateway MCP bridge: connect an MCP client (Claude Code) to
 * the ops gateway's /mcp endpoint using the operator's own BROWSER
 * Access session, no service token needed (spec 0003 §6: interactive
 * tooling rides `cloudflared access token`; service tokens are for
 * unattended automation).
 *
 *   cloudflared access login https://ops.<zone>     # once, browser SSO
 *   claude mcp add operon --scope user -- \
 *     node <chassis>/tools/mcp-bridge.mjs https://ops.<zone>
 *
 * Each stdin line is one JSON-RPC message, forwarded to /mcp with a
 * short-lived Access JWT (refreshed silently through cloudflared when
 * it expires); each response is written back as one line. The gateway
 * is stateless per request, so there is no session to keep. The bridge
 * holds no secret of its own; the JWT is minted by cloudflared from
 * the operator's existing SSO session.
 */
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";

// Normalized to the ORIGIN: a trailing slash or stray path in the
// configured value would otherwise produce //mcp and miss the
// gateway's exact route.
const configured = process.argv[2] ?? process.env.OPERON_OPS_URL ?? "";
let ops;
try {
  const parsed = new URL(configured);
  if (parsed.protocol !== "https:") throw new Error("https required");
  ops = parsed.origin;
} catch {
  console.error("usage: mcp-bridge.mjs https://ops.<zone> (or set OPERON_OPS_URL)");
  process.exit(2);
}

function accessToken() {
  return execFileSync("cloudflared", ["access", "token", "--app", ops], {
    encoding: "utf8"
  }).trim();
}

let token;
try {
  token = accessToken();
} catch {
  console.error(`no Access session for ${ops}. Run: cloudflared access login ${ops}`);
  process.exit(2);
}

async function forward(line) {
  const post = () =>
    fetch(`${ops}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "cf-access-jwt-assertion": token
      },
      body: line
    });
  let response = await post();
  // A bridge session outlasts the short-lived JWT: refresh once on an
  // auth failure (cloudflared refreshes silently from the SSO session).
  if (response.status === 401 || response.status === 403) {
    token = accessToken();
    response = await post();
  }
  // Notifications are accepted with no body; only responses go back.
  if (response.status === 202) return;
  const text = (await response.text()).trim();
  if (!text) return;
  if (!response.ok && !text.startsWith("{")) {
    // A non-JSON error (e.g. an HTML edge page) must not corrupt the
    // stdio stream; report it out of band and let the client time out.
    console.error(`gateway answered ${response.status}: ${text.slice(0, 200)}`);
    return;
  }
  process.stdout.write(text.replace(/\n/g, " ") + "\n");
}

// Strictly in order: MCP clients expect responses to arrive in a
// sensible sequence, and the gateway is fast enough that pipelining
// buys nothing worth the reordering risk.
let queue = Promise.resolve();
const lines = createInterface({ input: process.stdin, terminal: false });
lines.on("line", line => {
  const trimmed = line.trim();
  if (!trimmed) return;
  queue = queue.then(() =>
    forward(trimmed).catch(error => {
      console.error(`forward failed: ${error instanceof Error ? error.message : String(error)}`);
    })
  );
});
lines.on("close", () => {
  void queue.then(() => process.exit(0));
});
