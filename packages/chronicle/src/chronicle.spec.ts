import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import {
  queryEvents,
  queryMessages,
  queryWakeLog,
  queryWakes,
  recordEvent,
  recordMessage,
  recordWakeLogChunk
} from "./index.js";

/**
 * The chronicle contract against REAL D1 (wrangler's local simulator),
 * applying the exact committed migrations wrangler applies in the colony
 * deploy: the schema, the migrations, and the helpers are proven against
 * each other (the livevariant accounts pattern).
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

let proxy: Awaited<ReturnType<typeof getPlatformProxy>>;
let d1: D1Database;

async function applyMigrations(db: D1Database) {
  const dir = join(root, "migrations");
  const files = readdirSync(dir)
    .filter(f => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(dir, file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) await db.prepare(trimmed).run();
    }
  }
}

beforeAll(async () => {
  proxy = await getPlatformProxy({
    configPath: join(root, "wrangler.jsonc"),
    persist: false
  });
  d1 = (proxy.env as { CHRONICLE: D1Database }).CHRONICLE;
  await applyMigrations(d1);
});

afterAll(async () => {
  await proxy.dispose();
});

describe("events", () => {
  it("mirrors and filters by gatekeeper, kind, agent, and time", async () => {
    await recordEvent(d1, {
      at: "2026-08-27T10:00:00.000Z",
      gatekeeper: "spend",
      kind: "paid",
      agentId: "promoter",
      detail: { amount: "20000" }
    });
    await recordEvent(d1, {
      at: "2026-08-27T11:00:00.000Z",
      gatekeeper: "email",
      kind: "email_sent",
      agentId: "promoter",
      detail: { to: "x@example.com" }
    });
    const spend = await queryEvents(d1, { gatekeeper: "spend" });
    expect(spend).toHaveLength(1);
    expect(spend[0].kind).toBe("paid");
    expect(spend[0].detail).toEqual({ amount: "20000" });
    expect(await queryEvents(d1, { agentId: "promoter" })).toHaveLength(2);
    expect(await queryEvents(d1, { since: "2026-08-27T10:30:00.000Z" })).toHaveLength(1);
  });

  it("write helpers never throw without a binding", async () => {
    await expect(
      recordEvent(undefined, { at: "x", gatekeeper: "g", kind: "k", detail: {} })
    ).resolves.toBeUndefined();
  });
});

describe("messages", () => {
  it("stores full bodies and searches them case-insensitively", async () => {
    await recordMessage(d1, {
      at: "2026-08-27T09:00:00.000Z",
      kind: "email_in",
      agentId: "promoter",
      sender: "someone@example.com",
      subject: "Partnership",
      body: "We would love to Collaborate on this.",
      refId: "m1"
    });
    await recordMessage(d1, {
      at: "2026-08-27T09:05:00.000Z",
      kind: "channel_operator",
      agentId: "promoter",
      sender: "operator",
      body: "check the deploy",
      refId: "42"
    });
    const hits = await queryMessages(d1, { contains: "collaborate" });
    expect(hits).toHaveLength(1);
    expect(hits[0].refId).toBe("m1");
    expect(await queryMessages(d1, { kind: "channel_operator" })).toHaveLength(1);
  });
});

describe("wake log", () => {
  it("stores ordered chunks, tails after a seq, and lists wakes", async () => {
    for (let seq = 0; seq < 3; seq++) {
      await recordWakeLogChunk(d1, {
        wakeId: "wake-abc",
        agentId: "promoter",
        seq,
        at: `2026-08-27T12:0${seq}:00.000Z`,
        text: `chunk ${seq}\n`,
        done: seq === 2
      });
    }
    const tail = await queryWakeLog(d1, "wake-abc", 0);
    expect(tail.map(chunk => chunk.seq)).toEqual([1, 2]);
    const wakes = await queryWakes(d1, "promoter");
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ wakeId: "wake-abc", chunks: 3, done: 1 });
  });
});
