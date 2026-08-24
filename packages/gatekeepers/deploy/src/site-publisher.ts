import { DurableObject } from "cloudflare:workers";
import { decodeBase64, type PublishFile } from "./gates.js";

/**
 * Single writer per host. KV has no transactions, so two overlapping
 * publishes for one host could interleave their writes, deletions, and
 * manifest swaps into a mixture of generations. Routing every publish for
 * a host through this Durable Object (id = host) serializes them: Durable
 * Objects process one request at a time per id, so a publish completes its
 * whole write-delete-manifest sequence before the next begins.
 */

interface Env {
  SITE_STORE: KVNamespace;
}

function fileKey(host: string, path: string): string {
  return `f:${host}:${path}`;
}

function manifestKey(host: string): string {
  return `m:${host}`;
}

export interface PublishOutcome {
  files: number;
  removed: number;
}

export class SitePublisher extends DurableObject<Env> {
  async publishFiles(host: string, files: PublishFile[]): Promise<PublishOutcome> {
    const newPaths = new Set(files.map(file => file.path));
    for (const file of files) {
      await this.env.SITE_STORE.put(
        fileKey(host, file.path),
        decodeBase64(file.contentBase64),
        { metadata: { contentType: file.contentType } }
      );
    }
    const previous = await this.env.SITE_STORE.get<string[]>(manifestKey(host), "json");
    let removed = 0;
    for (const stale of previous ?? []) {
      if (!newPaths.has(stale)) {
        await this.env.SITE_STORE.delete(fileKey(host, stale));
        removed++;
      }
    }
    await this.env.SITE_STORE.put(manifestKey(host), JSON.stringify([...newPaths]));
    return { files: files.length, removed };
  }
}
