import { describe, expect, it } from "vitest";
import { CredentialWatch } from "./credential-watch.js";

const login = (refresh: string, access = "a1") =>
  JSON.stringify({ tokens: { access_token: access, refresh_token: refresh, account_id: "acct" } });
const secretsIn = (credential: string) => {
  const parsed = JSON.parse(credential) as { tokens: Record<string, string> };
  return [credential, parsed.tokens.access_token, parsed.tokens.refresh_token];
};

function watch(reads: (string | null)[]) {
  const denylist = [login("r1"), "a1", "r1"];
  const lines: string[] = [];
  const queue = [...reads];
  const w = new CredentialWatch({
    read: async () => (queue.length > 0 ? (queue.shift() as string | null) : reads[reads.length - 1]),
    seed: login("r1"),
    secretsIn,
    denylist,
    log: line => lines.push(line)
  });
  return { w, denylist, lines };
}

describe("CredentialWatch (spec 0010 §5)", () => {
  it("adds nothing while the file still holds the seed", async () => {
    const { w, denylist, lines } = watch([login("r1")]);
    expect(await w.refresh()).toBe(0);
    expect(denylist).toHaveLength(3);
    expect(lines).toEqual([]);
    expect(w.rewritten).toBe(false);
  });

  it("denylists every literal of a rewritten login once, and again on a second rewrite", async () => {
    const { w, denylist, lines } = watch([login("r2", "a2"), login("r2", "a2"), login("r3", "a3")]);
    expect(await w.refresh()).toBe(3);
    expect(denylist).toContain("a2");
    expect(denylist).toContain("r2");
    expect(w.rewritten).toBe(true);
    expect(await w.refresh()).toBe(0);
    expect(await w.refresh()).toBe(3);
    expect(denylist).toContain("r3");
    expect(lines).toHaveLength(2);
  });

  it("shares one read between concurrent callers and treats an unreadable file as no news", async () => {
    let reads = 0;
    const denylist: string[] = [];
    const w = new CredentialWatch({
      read: async () => {
        reads += 1;
        return login("r9", "a9");
      },
      seed: login("r1"),
      secretsIn,
      denylist,
      log: () => undefined
    });
    const [a, b] = await Promise.all([w.refresh(), w.refresh()]);
    expect(reads).toBe(1);
    // One read, one result, handed to both callers.
    expect(a).toBe(3);
    expect(b).toBe(3);
    const unreadable = new CredentialWatch({
      read: async () => null,
      seed: "seed",
      secretsIn,
      denylist,
      log: () => undefined
    });
    expect(await unreadable.refresh()).toBe(0);
  });

  it("falls back to the whole file when the adapter cannot read its shape", async () => {
    const denylist: string[] = [];
    const w = new CredentialWatch({
      read: async () => "garbage",
      seed: "seed",
      secretsIn: () => {
        throw new Error("malformed");
      },
      denylist,
      log: () => undefined
    });
    expect(await w.refresh()).toBe(1);
    expect(denylist).toEqual(["garbage"]);
  });
});
