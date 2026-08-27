import { DurableObject } from "cloudflare:workers";
import { MAX_SECRETS } from "./policy.js";

/**
 * One VaultBox Durable Object per agent: the agent's labeled secrets.
 * Serialized by the DO, so the size cap cannot be raced past. Values are
 * returned only to the holder of the agent's own bearer (enforced by the
 * Worker); nothing here ever writes a value to a ledger or a log.
 */

export interface VaultEntry {
  label: string;
  value: string;
  createdAt: string;
  updatedAt: string;
}

export interface VaultListing {
  label: string;
  createdAt: string;
  updatedAt: string;
}

export class VaultBox extends DurableObject {
  /** Upsert; refuses only when a NEW label would exceed the cap. */
  async set(
    label: string,
    value: string,
    at: string
  ): Promise<{ ok: true; created: boolean } | { ok: false; problem: "vault_full" }> {
    const key = `secret:${label}`;
    const existing = await this.ctx.storage.get<VaultEntry>(key);
    if (!existing) {
      const count = (await this.ctx.storage.list({ prefix: "secret:" })).size;
      if (count >= MAX_SECRETS) return { ok: false, problem: "vault_full" };
    }
    await this.ctx.storage.put(key, {
      label,
      value,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at
    } satisfies VaultEntry);
    return { ok: true, created: !existing };
  }

  async get(label: string): Promise<string | null> {
    return (await this.ctx.storage.get<VaultEntry>(`secret:${label}`))?.value ?? null;
  }

  async list(): Promise<VaultListing[]> {
    const entries = await this.ctx.storage.list<VaultEntry>({ prefix: "secret:" });
    return [...entries.values()].map(({ label, createdAt, updatedAt }) => ({
      label,
      createdAt,
      updatedAt
    }));
  }

  async delete(label: string): Promise<boolean> {
    return this.ctx.storage.delete(`secret:${label}`);
  }

  /** Every value, for the wake supervisor's denylist assembly. */
  async all(): Promise<Array<{ label: string; value: string }>> {
    const entries = await this.ctx.storage.list<VaultEntry>({ prefix: "secret:" });
    return [...entries.values()].map(({ label, value }) => ({ label, value }));
  }
}
