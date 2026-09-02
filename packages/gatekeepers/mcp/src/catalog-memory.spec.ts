import { describe, expect, it } from "vitest";
import { CatalogMemory } from "./catalog-memory.js";

describe("CatalogMemory", () => {
  it("notes a revision once per agent and server, and again only when it changes", () => {
    const memory = new CatalogMemory();
    expect(memory.changed("promoter", "livevariant", "aaaa")).toBe(true);
    expect(memory.changed("promoter", "livevariant", "aaaa")).toBe(false);
    expect(memory.changed("promoter", "livevariant", "bbbb")).toBe(true);
    expect(memory.changed("promoter", "livevariant", "aaaa")).toBe(true);
  });

  it("keeps agents and servers apart", () => {
    const memory = new CatalogMemory();
    expect(memory.changed("promoter", "livevariant", "aaaa")).toBe(true);
    expect(memory.changed("other", "livevariant", "aaaa")).toBe(true);
    expect(memory.changed("promoter", "linear", "aaaa")).toBe(true);
  });
});
