import { describe, expect, it, vi } from "vitest";
import { notifyOperator, type OperatorAction } from "./notify.js";

const actions: OperatorAction[] = [{ label: "approve", kind: "email_approve", agentId: "a", id: "1" }];

describe("notifyOperator button-gating", () => {
  it("carries actions over the service binding", async () => {
    const notify = vi.fn(async () => ({ delivered: true, recorded: true }));
    await notifyOperator({ TELEGRAM: { notify } }, "held", { actions, agentId: "a" });
    expect(notify).toHaveBeenCalledWith({ text: "held", actions, agentId: "a" });
  });

  it("has no public path: without the binding nothing is sent anywhere (spec 0009)", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await notifyOperator({}, "held", { actions });
    // A worker without the binding cannot reach the operator by any
    // other route: there is no URL to fall back to, so no forged or
    // button-stripped copy can leave either.
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("swallows a binding failure rather than falling back to a public path", async () => {
    const notify = vi.fn(async () => {
      throw new Error("binding down");
    });
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(notifyOperator({ TELEGRAM: { notify } }, "x")).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
