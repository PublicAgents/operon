#!/usr/bin/env node
/**
 * Tail a wake's transcript from the chronicle, live or historical:
 *
 *   npm run tail-wake                 # follow the newest wake (from the colony root)
 *   npm run tail-wake -- <wakeId>     # a specific wake (also historical)
 *   npm run tail-wake -- --raw        # unrendered transcript (raw JSONL)
 *
 * Auth: the Cloudflare Access session on the ops gateway (spec 0003).
 * The chronicle's operator reads are binding-only now, reached only
 * through ops.<zone>; this fetches a short-lived Access JWT with
 * `cloudflared access token` and sends it. Run `cloudflared access
 * login https://ops.<zone>` once first. While a wake runs this reads the
 * live WakeLog DO; afterwards the same URL serves the durable D1 copy.
 * Sessions stream JSONL events
 * (HARNESS_EXTRA_ARGS sets --output-format stream-json); this renders
 * them readably and passes chassis [operon] lines through untouched.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Chassis tooling, colony data: the ops gateway URL comes from the
// colony checkout this runs in (the ops worker's own route), or the
// OPERON_OPS_URL override. Reads proxy through it, Access-gated.
function opsUrl() {
  if (process.env.OPERON_OPS_URL) return process.env.OPERON_OPS_URL;
  const configPath = join(process.cwd(), "workers", "gatekeeper-ops", "wrangler.jsonc");
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const pattern = JSON.parse(raw).routes?.[0]?.pattern;
    if (pattern) return `https://${pattern}`;
  }
  console.error("no ops URL: run from a colony root or set OPERON_OPS_URL");
  process.exit(2);
}

const GK = opsUrl();
const args = process.argv.slice(2);
const raw = args.includes("--raw");
const wakeArg = args.find(arg => !arg.startsWith("--"));

// A short-lived Access JWT for the ops gateway; the login is a one-time
// browser SSO (`cloudflared access login <ops>`), then this refreshes
// silently. Sent as the header the ops gateway's in-Worker verifier reads.
function accessToken() {
  return execFileSync("cloudflared", ["access", "token", "--app", GK], {
    encoding: "utf8"
  }).trim();
}

// Startup is the only fatal path (no session at all is operator error);
// a mid-tail refresh failure throws instead, so the polling loop's
// retry window absorbs a transient cloudflared failure.
let token;
try {
  token = accessToken();
} catch {
  console.error(`no Access session for ${GK}. Run: cloudflared access login ${GK}`);
  process.exit(2);
}

async function api(path) {
  let response = await fetch(`${GK}${path}`, {
    headers: { "cf-access-jwt-assertion": token }
  });
  // A live tail can outlast the short-lived JWT: on an auth failure,
  // refresh it once (cloudflared refreshes silently) and retry.
  if (response.status === 401 || response.status === 403) {
    token = accessToken();
    response = await fetch(`${GK}${path}`, {
      headers: { "cf-access-jwt-assertion": token }
    });
  }
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return response.json();
}

const trim = (value, max = 200) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

/** Render one transcript line: harness JSONL becomes readable, rest passes through. */
function render(line) {
  if (raw || !line.startsWith("{")) return line;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return line;
  }
  switch (event.type) {
    case "rate_limit_event":
      return null; // harness bookkeeping, not wake activity
    case "system":
      return event.subtype === "init" ? `· session ready (model ${event.model ?? "?"})` : null;
    case "assistant": {
      const parts = [];
      for (const block of event.message?.content ?? []) {
        if (block.type === "text" && block.text.trim()) parts.push(block.text);
        if (block.type === "tool_use") parts.push(`⏺ ${block.name}(${trim(block.input, 160)})`);
      }
      return parts.length ? parts.join("\n") : null;
    }
    case "user": {
      const parts = [];
      for (const block of event.message?.content ?? []) {
        if (block.type === "tool_result") {
          const body = Array.isArray(block.content)
            ? block.content.map(inner => inner.text ?? "").join(" ")
            : block.content;
          parts.push(`  ↳ ${trim(body ?? "", 200)}`);
        }
      }
      return parts.length ? parts.join("\n") : null;
    }
    case "result":
      return `== session result: ${event.subtype ?? "?"}${
        event.num_turns ? ` (${event.num_turns} turns)` : ""
      } ==`;
    default:
      return trim(line, 300);
  }
}

const wakeId =
  wakeArg ??
  (await (async () => {
    const { wakes } = await api("/chronicle/wakes?limit=1");
    return wakes[0]?.wakeId;
  })());
if (!wakeId) {
  console.log("no wake recorded yet (one appears within ~5s of a wake starting)");
  process.exit(0);
}

console.log(`tailing wake ${wakeId} (ctrl-c to stop)\n`);
let after = -1;
let carry = "";
let quietPolls = 0;
let pollFailures = 0;
for (;;) {
  // A live tail must survive transient failures (a gateway 5xx, a
  // momentary Access-verifier outage answering 401, a dropped
  // connection): the cursor makes every poll idempotent, so failures
  // just wait for the next poll. Only a long unbroken failure streak
  // (~2 min) gives up.
  let result;
  try {
    result = await api(`/chronicle/wake-log/${wakeId}?after=${after}`);
    pollFailures = 0;
  } catch (error) {
    pollFailures += 1;
    if (pollFailures >= 40) {
      console.error(`[tail-wake] giving up after ${pollFailures} consecutive failed polls: ${error.message}`);
      process.exit(1);
    }
    if (pollFailures % 10 === 1) {
      console.error(`[tail-wake] poll failed (${error.message}); retrying`);
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
    continue;
  }
  const chunks = result.chunks ?? [];
  if (chunks.length > 0) {
    after = Math.max(...chunks.map(chunk => chunk.seq));
    // Chunk boundaries are byte-aligned, not line-aligned: carry the
    // partial last line so JSONL events split across chunks still parse.
    const text = carry + chunks.map(chunk => chunk.text).join("");
    const lines = text.split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) {
      const rendered = render(line);
      if (rendered !== null && rendered !== "") console.log(rendered);
    }
  }
  const done = result.done === true || chunks.some(chunk => chunk.done === 1 || chunk.done === true);
  if (done) {
    if (carry) console.log(render(carry) ?? carry);
    console.log("\n-- wake complete --");
    break;
  }
  // Historical read (the live DO has expired or never finished): when the
  // durable copy has nothing more, the transcript simply ends, e.g. a
  // wake whose container died before the final flush.
  if (result.source === "chronicle" && chunks.length === 0 && after >= 0) {
    if (carry) console.log(render(carry) ?? carry);
    console.log("\n-- transcript ends (wake never marked done) --");
    break;
  }
  // A live session can be quiet for minutes during a long tool run, so
  // silence never auto-exits; it just gets called out periodically (a
  // wake killed before its done marker looks exactly like this).
  quietPolls = chunks.length === 0 ? quietPolls + 1 : 0;
  if (quietPolls > 0 && quietPolls % 100 === 0) {
    console.log(`[tail-wake] no output for ${(quietPolls * 3) / 60} min; still connected (ctrl-c to stop)`);
  }
  await new Promise(resolve => setTimeout(resolve, 3000));
}
