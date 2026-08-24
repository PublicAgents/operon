import { describe, expect, it } from "vitest";
import {
  DAILY_SEND_CAP,
  decideSend,
  disclosureFooter,
  fromName,
  normalizeAddress
} from "./policy.js";

describe("decideSend", () => {
  const base = { to: "a@x.com", correspondents: new Set<string>(), sentToday: 0, approved: false };

  it("holds first contact to a stranger", () => {
    expect(decideSend(base)).toEqual({ action: "hold", reason: "first_contact" });
  });

  it("sends to a known correspondent", () => {
    expect(decideSend({ ...base, correspondents: new Set(["a@x.com"]) })).toEqual({
      action: "send"
    });
  });

  it("sends a held first-contact once approved", () => {
    expect(decideSend({ ...base, approved: true })).toEqual({ action: "send" });
  });

  it("rejects once the daily cap is reached, even to correspondents", () => {
    expect(
      decideSend({ ...base, correspondents: new Set(["a@x.com"]), sentToday: DAILY_SEND_CAP })
    ).toEqual({ action: "reject", reason: "rate_limited" });
  });

  it("matches correspondents case-insensitively", () => {
    expect(
      decideSend({ ...base, to: "A@X.com", correspondents: new Set(["a@x.com"]) }).action
    ).toBe("send");
  });
});

describe("disclosure", () => {
  it("always states it is an AI agent and software-sent", () => {
    const footer = disclosureFooter("Prior", "prior@agents.livevariant.ai", "https://prior.livevariant.ai");
    expect(footer).toMatch(/autonomous AI agent/);
    expect(footer).toMatch(/sent by software, not a person/);
    expect(footer).toContain("prior@agents.livevariant.ai");
  });

  it("from name signals non-human", () => {
    expect(fromName("Prior")).toBe("Prior (AI agent)");
  });
});

describe("normalizeAddress", () => {
  it("trims and lowercases", () => {
    expect(normalizeAddress("  Foo@Bar.COM ")).toBe("foo@bar.com");
  });
});
