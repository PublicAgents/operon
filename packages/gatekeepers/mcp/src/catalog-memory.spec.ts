import { describe, expect, it } from "vitest";
import { CatalogMemory } from "./catalog-memory.js";

describe("CatalogMemory", () => {
  it("treats a revision as new until it is noted, then again only when it changes", () => {
    const memory = new CatalogMemory();
    expect(memory.isNew("promoter", "livevariant", "aaaa")).toBe(true);
    // Asking does not note: a failed append must leave it new.
    expect(memory.isNew("promoter", "livevariant", "aaaa")).toBe(true);
    memory.note("promoter", "livevariant", "aaaa");
    expect(memory.isNew("promoter", "livevariant", "aaaa")).toBe(false);
    expect(memory.isNew("promoter", "livevariant", "bbbb")).toBe(true);
    memory.note("promoter", "livevariant", "bbbb");
    expect(memory.isNew("promoter", "livevariant", "aaaa")).toBe(true);
  });

  it("keeps agents and servers apart", () => {
    const memory = new CatalogMemory();
    memory.note("promoter", "livevariant", "aaaa");
    expect(memory.isNew("other", "livevariant", "aaaa")).toBe(true);
    expect(memory.isNew("promoter", "linear", "aaaa")).toBe(true);
  });
});
