import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// The rotation table is a chassis TOOL, deliberately outside the package
// graph (it ships uncompiled and runs from a colony checkout); this spec
// is its only in-graph consumer, existing precisely to bind the two.
/* eslint-disable @nx/enforce-module-boundaries */
// @ts-expect-error untyped chassis tool module (plain .mjs by design)
import { groupsFor } from "../../../tools/rotate-groups.mjs";
/* eslint-enable @nx/enforce-module-boundaries */

/**
 * The rotation table cannot drift from reality: this spec SCANS every
 * Gatekeeper's source for the bearers it ACCEPTS (requireBearer /
 * requireAnyBearer on env names, and per-agent `PREFIX_TOKEN_${...}`
 * template lookups) and fails when tools/rotate-groups.mjs does not
 * rotate one of them onto that worker. Adding a Gatekeeper or a bearer
 * without teaching the rotation tool is a red build, not a stale 401
 * after the operator's next rotation (the exact failure Greptile caught
 * on the X Gatekeeper).
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GATEKEEPERS_DIR = join(ROOT, "packages", "gatekeepers");

/**
 * Accepted bearers this tool deliberately does NOT rotate, each with the
 * reason. Removing an entry without covering it turns the build red.
 */
const EXEMPT_STATIC: Record<string, string> = {
  TELEGRAM_WEBHOOK_SECRET:
    "half of the pair lives at Telegram (setWebhook); rotating it is a separate, external dance"
};
const EXEMPT_AGENT_PREFIXES: Record<string, string> = {
  X_ACCESS_TOKEN_: "the agent's own X account credential, minted by the operator's PIN flow",
  X_ACCESS_SECRET_: "the agent's own X account credential, minted by the operator's PIN flow",
  WAKE_TRIGGER_TOKEN_:
    "per PROJECT, not per agent: the control plane's copy of an ENROLLED project's scheduler " +
    "bearer (spec 0006 §9), which that project rotates in its own wake-trigger group; the host " +
    "sets it once at enrollment (bootstrap names it)"
};

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourcesUnder(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

function acceptedBearers(packageDir: string): { statics: Set<string>; agentPrefixes: Set<string> } {
  const statics = new Set<string>();
  const agentPrefixes = new Set<string>();
  for (const file of sourcesUnder(join(packageDir, "src"))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/requireBearer\(request, env\.([A-Z][A-Z0-9_]*)/g)) {
      statics.add(match[1]);
    }
    for (const match of source.matchAll(/requireAnyBearer\(request, \[([^\]]*)\]/g)) {
      for (const inner of match[1].matchAll(/env\.([A-Z][A-Z0-9_]*)/g)) statics.add(inner[1]);
    }
    // Per-agent bearers are looked up as env[`PREFIX_TOKEN_${...}`] via a
    // token-var helper; the template prefix is the fingerprint.
    for (const match of source.matchAll(/`([A-Z][A-Z0-9_]*_(?:TOKEN|SECRET)_)\$\{/g)) {
      agentPrefixes.add(match[1]);
    }
  }
  return { statics, agentPrefixes };
}

describe("rotate-tokens covers every bearer every Gatekeeper accepts", () => {
  const roster = { zone: "example.test", agents: [{ id: "probe-agent" }] };
  const groups = groupsFor(roster) as Record<string, Array<[string, string]>>;
  const covered = new Set<string>();
  for (const entries of Object.values(groups)) {
    for (const [workerDir, secretName] of entries) covered.add(`${workerDir}:${secretName}`);
  }

  const gatekeepers = readdirSync(GATEKEEPERS_DIR).filter(entry =>
    statSync(join(GATEKEEPERS_DIR, entry)).isDirectory()
  );

  it.each(gatekeepers)("gatekeeper-%s", name => {
    const { statics, agentPrefixes } = acceptedBearers(join(GATEKEEPERS_DIR, name));
    const worker = `gatekeeper-${name}`;
    for (const bearer of statics) {
      if (EXEMPT_STATIC[bearer]) continue;
      expect(
        covered.has(`${worker}:${bearer}`),
        `${worker} accepts ${bearer} but tools/rotate-groups.mjs never rotates it there ` +
          `(add it to a group, or document an exemption in this spec)`
      ).toBe(true);
    }
    for (const prefix of agentPrefixes) {
      if (EXEMPT_AGENT_PREFIXES[prefix]) continue;
      expect(
        covered.has(`${worker}:${prefix}PROBE_AGENT`),
        `${worker} looks up per-agent bearer ${prefix}<AGENT> but the rotation table has no ` +
          `per-agent group for it (add one in groupsFor, or document an exemption)`
      ).toBe(true);
    }
  });

  it("every rotation target names a real worker", () => {
    for (const entries of Object.values(groups)) {
      for (const [workerDir] of entries) {
        if (workerDir === "scheduler") continue;
        expect(
          gatekeepers.includes(workerDir.replace(/^gatekeeper-/, "")),
          `rotation table names unknown worker "${workerDir}"`
        ).toBe(true);
      }
    }
  });
});
