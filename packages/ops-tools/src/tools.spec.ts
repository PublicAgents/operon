import { describe, expect, it } from "vitest";
import { LEDGERS, TOOLS, toolByName } from "./tools.js";
import {
  ToolInputError,
  ToolUnavailableError,
  toolPath,
  type OpsMethod,
  type ToolContext
} from "./types.js";

interface Call {
  kind: "ops" | "scheduler" | "audit";
  binding?: string;
  method?: OpsMethod;
  path?: string;
  body?: unknown;
  query?: Record<string, string | undefined>;
}

function fakeContext(overrides: Partial<ToolContext> = {}): { context: ToolContext; calls: Call[] } {
  const calls: Call[] = [];
  const context: ToolContext = {
    operator: "op@example.test",
    project: "example",
    async ops(binding, method, path, options) {
      calls.push({ kind: "ops", binding, method, path, body: options?.body, query: options?.query });
      return { ok: true };
    },
    async scheduler(method, path) {
      calls.push({ kind: "scheduler", method, path });
      return { ok: true };
    },
    async auditRecent(limitArg) {
      calls.push({ kind: "audit", path: String(limitArg) });
      return [];
    },
    ...overrides
  };
  return { context, calls };
}

describe("the registry", () => {
  it("has unique snake_case names and distinct REST paths", () => {
    const names = TOOLS.map(tool => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    const paths = TOOLS.map(tool => toolPath(tool.name));
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("never marks a decision read-only", () => {
    for (const tool of TOOLS) {
      if (tool.decision) expect(tool.readOnly).toBe(false);
    }
  });

  it("covers every ledger and the whole legacy operator surface", () => {
    for (const name of [
      "agents_list", "wakes_list", "wake_log", "wake", "agent_disable", "agent_enable",
      "chronicle_events", "chronicle_messages", "chronicle_wakes", "notifications",
      "ledger_recent", "audit_recent", "channel_send", "channel_transcript",
      "till_offers", "spend_outbox", "spend_held", "spend_approve", "spend_reject", "spend_reconcile",
      "email_outbox", "email_held", "email_approve", "email_reject",
      "web_sessions", "web_live_view", "web_screenshot", "web_session_delete",
      "secret_list", "secret_set", "secret_rotate_group",
      "ask_list", "ask_read", "ask_decide", "ask_reply"
    ]) {
      expect(toolByName(name), name).toBeDefined();
    }
    expect(Object.keys(LEDGERS).sort()).toEqual(
      ["asks", "deploy", "email", "github", "pr", "spend", "telegram", "till", "vault", "web", "x"]
    );
  });
});

describe("handlers", () => {
  it("forwards a channel send verbatim to the telegram Ops entrypoint", async () => {
    const { context, calls } = fakeContext();
    const tool = toolByName("channel_send")!;
    const input = tool.input.parse({ agentId: "promoter", text: "hello" });
    await tool.handler(input, context);
    expect(calls).toEqual([
      {
        kind: "ops", binding: "TELEGRAM", method: "POST", path: "/channel/send",
        body: { agentId: "promoter", text: "hello" }, query: undefined
      }
    ]);
  });

  it("accepts the broadcast target", () => {
    const tool = toolByName("channel_send")!;
    expect(tool.input.safeParse({ agentId: "*", text: "all hands" }).success).toBe(true);
    expect(tool.input.safeParse({ agentId: "Not Valid", text: "x" }).success).toBe(false);
  });

  it("rejects an unknown ledger with a named error", async () => {
    const { context } = fakeContext();
    const tool = toolByName("ledger_recent")!;
    expect(tool.input.safeParse({ gatekeeper: "nope" }).success).toBe(false);
    await expect(tool.handler({ gatekeeper: "nope" }, context)).rejects.toBeInstanceOf(ToolInputError);
  });

  it("builds the wake-log query from after", async () => {
    const { context, calls } = fakeContext();
    const tool = toolByName("wake_log")!;
    await tool.handler({ wakeId: "abcd1234-ef", after: 7 }, context);
    expect(calls[0]).toMatchObject({ path: "/chronicle/wake-log/abcd1234-ef", query: { after: "7" } });
  });

  it("pins notifications to kind notify", async () => {
    const { context, calls } = fakeContext();
    await toolByName("notifications")!.handler({}, context);
    expect(calls[0]).toMatchObject({ path: "/chronicle/messages", query: { kind: "notify" } });
  });

  it("fails secret tools closed when the API token is unconfigured", async () => {
    const { context } = fakeContext();
    await expect(
      toolByName("secret_list")!.handler({ worker: "scheduler" }, context)
    ).rejects.toBeInstanceOf(ToolUnavailableError);
  });

  it("delegates rotation to the serialized host port and returns no value", async () => {
    const calls: { group: string; pairs: (readonly [string, string])[] }[] = [];
    const { context } = fakeContext({
      secrets: {
        async list() { return []; },
        async put() { /* rotation never uses put directly */ },
        async rotateGroup(group, pairs) {
          calls.push({ group, pairs: [...pairs] });
          return { written: pairs.map(([dir, name]) => `${dir}/${name}`), failed: [] };
        }
      },
      async scheduler() { return { agents: [{ id: "promoter" }] }; }
    });
    const result = (await toolByName("secret_rotate_group")!.handler(
      { group: "till-promoter" }, context
    )) as { ok: boolean; written: string[] };
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      {
        group: "till-promoter",
        pairs: [
          ["gatekeeper-till", "TILL_TOKEN_PROMOTER"],
          ["scheduler", "TILL_TOKEN_PROMOTER"]
        ]
      }
    ]);
    expect(result.written).toEqual([
      "gatekeeper-till/TILL_TOKEN_PROMOTER",
      "scheduler/TILL_TOKEN_PROMOTER"
    ]);
  });

  it("reports both lists when the serialized rotation is incomplete", async () => {
    const { context } = fakeContext({
      secrets: {
        async list() { return []; },
        async put() { /* rotation never uses put directly */ },
        async rotateGroup() {
          return {
            written: ["scheduler/TILL_TOKEN_PROMOTER"],
            failed: ["gatekeeper-till/TILL_TOKEN_PROMOTER (cloudflare api 502)"]
          };
        }
      },
      async scheduler() { return { agents: [{ id: "promoter" }] }; }
    });
    const failure = await toolByName("secret_rotate_group")!
      .handler({ group: "till-promoter" }, context)
      .then(() => null, (error: unknown) => error as ToolInputError);
    expect(failure).toBeInstanceOf(ToolInputError);
    expect(failure!.message).toMatch(/INCOMPLETE/);
    expect(failure!.payload).toMatchObject({
      error: "rotation_incomplete",
      written: ["scheduler/TILL_TOKEN_PROMOTER"],
      failed: [expect.stringContaining("gatekeeper-till/TILL_TOKEN_PROMOTER")]
    });
  });

  it("names the known groups when the group is unknown", async () => {
    const { context } = fakeContext({
      secrets: {
        async list() { return []; },
        async put() { /* never reached in this test */ },
        async rotateGroup() { return { written: [], failed: [] }; }
      },
      async scheduler() { return { agents: [] }; }
    });
    await expect(
      toolByName("secret_rotate_group")!.handler({ group: "bogus" }, context)
    ).rejects.toThrow(/unknown rotation group: bogus.*notify/s);
  });
});
