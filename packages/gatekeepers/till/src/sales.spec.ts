import { describe, expect, it } from "vitest";
import { salesView } from "./sales.js";

describe("what till sales shows an agent (#80)", () => {
  it("keeps the receipts and surfaces the replay refusals, only the agent's own", () => {
    const rows = [
      { at: "t4", kind: "receipt", detail: { agentId: "prior", path: "/data/a.json" } },
      { at: "t3", kind: "replay_refused", detail: { agentId: "prior", host: "prior.example", path: "/data/a.json" } },
      { at: "t2", kind: "replay_refused", detail: { agentId: "other", host: "other.example", path: "/x" } },
      { at: "t1", kind: "offer_set", detail: { agentId: "prior", path: "/data/a.json" } },
      { at: "t0", kind: "serve_unconfigured", detail: { host: "prior.example", path: "/data/a.json" } }
    ];
    const view = salesView(rows, "prior");
    expect(view.sales.map(row => row.at)).toEqual(["t4"]);
    expect(view.refusals.map(row => row.at)).toEqual(["t3"]);
  });
});
