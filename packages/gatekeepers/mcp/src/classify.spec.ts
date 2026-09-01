import { describe, expect, it } from "vitest";
import { classify, inPortalScope, isRead, ownerOf } from "./classify.js";

const server = "linear";

describe("classify (the trust boundary)", () => {
  const read = { name: "search_issues", annotations: { readOnlyHint: true } };
  const write = { name: "create_issue", annotations: { readOnlyHint: false } };
  const unannotated = { name: "do_something" };

  it("treats an unannotated tool as a write: unknown is not safe", () => {
    expect(isRead(unannotated)).toBe(false);
    // Most servers publish no annotations at all, so this is the
    // common case, not the exotic one.
    expect(isRead({ name: "x", annotations: { readOnlyHint: "true" } })).toBe(false);
    expect(isRead({ name: "x", annotations: { readOnlyHint: 1 } })).toBe(false);
    expect(isRead(read)).toBe(true);
  });

  it("lets a vetted upstream's read through on its own annotation", () => {
    expect(classify(read, { trust: "vetted", pinned: [], server })).toEqual({
      allowed: true,
      mode: "read"
    });
  });

  it("does not take a byo upstream's word for anything", () => {
    const verdict = classify(read, { trust: "byo", pinned: [], server });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.detail).toContain("not administrator-vetted");
  });

  it("requires an operator pin for every write, vetted or not", () => {
    for (const trust of ["byo", "vetted"] as const) {
      expect(classify(write, { trust, pinned: [], server }).allowed).toBe(false);
      expect(classify(write, { trust, pinned: ["create_issue"], server })).toEqual({
        allowed: true,
        mode: "pinned"
      });
    }
  });

  it("names the manifest key that would grant a refused tool", () => {
    const verdict = classify(unannotated, { trust: "vetted", pinned: [], server });
    if (verdict.allowed) throw new Error("expected a refusal");
    expect(verdict.code).toBe("mcp_tool_needs_grant");
    expect(verdict.detail).toContain("mcp.linear.tools");
  });

  it("never grants portal_* tools, pinned or not", () => {
    // They change which upstreams a session reaches, which is the
    // manifest's decision and not a tool call's.
    for (const trust of ["byo", "vetted"] as const) {
      const verdict = classify(
        { name: "portal_toggle_servers", annotations: { readOnlyHint: true } },
        { trust, pinned: ["portal_toggle_servers"], server }
      );
      expect(verdict.allowed).toBe(false);
    }
  });
});

describe("portal scoping by name prefix", () => {
  it("gives a tool to the LONGEST matching server id", () => {
    // The ambiguity that makes naive prefix matching wrong: without
    // longest-match, foo_bar_create rides a grant for foo.
    expect(ownerOf("foo_bar_create", ["foo", "foo_bar"])).toBe("foo_bar");
    expect(ownerOf("foo_create", ["foo", "foo_bar"])).toBe("foo");
    expect(ownerOf("other_create", ["foo", "foo_bar"])).toBeNull();
  });

  it("keeps a grant to one upstream even when ids overlap", () => {
    expect(inPortalScope("foo_bar_create", "foo", ["foo", "foo_bar"])).toBe(false);
    expect(inPortalScope("foo_bar_create", "foo_bar", ["foo", "foo_bar"])).toBe(true);
    expect(inPortalScope("foo_create", "foo", ["foo", "foo_bar"])).toBe(true);
  });
});
