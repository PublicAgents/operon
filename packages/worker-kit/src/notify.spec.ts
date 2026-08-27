import { describe, expect, it, vi } from "vitest";
import { notifyOperator } from "./notify.js";

const actions = [{ label: "Approve", kind: "email_approve", agentId: "a", id: "1" }];

describe("notifyOperator button-gating", () => {
  it("carries actions over the service binding", async () => {
    const notify = vi.fn(async () => ({ delivered: true }));
    await notifyOperator({ TELEGRAM: { notify } }, "held", { actions, agentId: "a" });
    expect(notify).toHaveBeenCalledWith({ text: "held", actions, agentId: "a" });
  });

  it("DROPS actions on the public fallback path (forgery yields no buttons)", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await notifyOperator(
      { NOTIFY_URL: "https://tg/notify", NOTIFY_TOKEN: "t" },
      "held",
      { actions, agentId: "a" }
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toEqual({ text: "held", agentId: "a" });
    expect(body.actions).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("falls back to the public path when the binding throws", async () => {
    const notify = vi.fn(async () => {
      throw new Error("binding down");
    });
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await notifyOperator({ TELEGRAM: { notify }, NOTIFY_URL: "https://tg/notify", NOTIFY_TOKEN: "t" }, "x");
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("no-ops when nothing is wired", async () => {
    await expect(notifyOperator({}, "x", { actions })).resolves.toBeUndefined();
  });
});
