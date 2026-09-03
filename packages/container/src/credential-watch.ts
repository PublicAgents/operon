/**
 * A file credential the harness may rewrite mid-session (spec 0010 §5):
 * Codex rotates its login in place on a rejected token. The rotated
 * tokens must be on the wake's denylist BEFORE anything that scans
 * against it runs, not after the session: the transcript ships every
 * few seconds and the porch sweeps every outbound door while the mind
 * is still awake. So the watch is consulted at those points (before a
 * transcript flush, before a porch request, before presleep) and merges
 * whatever the file holds now into the shared list. Reading a 4 KB
 * file is cheaper than the scan that follows it.
 */

export interface CredentialWatchOptions {
  /** Read the staged file back; null when it cannot be read. */
  read(): Promise<string | null>;
  /** What the file held when the chassis staged it. */
  seed: string;
  /** Every literal inside a credential that must never leave the container. */
  secretsIn(credential: string): string[];
  /** The wake's shared denylist, grown in place. */
  denylist: string[];
  log(message: string): void;
}

export class CredentialWatch {
  private last: string;
  private inflight: Promise<number> | null = null;
  /** True once the file has ever differed from the seed. */
  rewritten = false;

  constructor(private readonly options: CredentialWatchOptions) {
    this.last = options.seed;
  }

  /**
   * Merge the file's current literals into the denylist; returns how
   * many were new. Concurrent callers share one read. Never throws: a
   * watch that cannot read denylists nothing new and says so.
   */
  refresh(): Promise<number> {
    if (!this.inflight) {
      this.inflight = this.refreshOnce().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async refreshOnce(): Promise<number> {
    const current = await this.options.read();
    if (current === null || current === this.last) return 0;
    this.last = current;
    this.rewritten = true;
    let literals: string[];
    try {
      literals = this.options.secretsIn(current);
    } catch {
      // Not a shape the adapter recognizes: the whole file is the literal.
      literals = [current];
    }
    let added = 0;
    for (const literal of literals) {
      if (literal.length > 0 && !this.options.denylist.includes(literal)) {
        this.options.denylist.push(literal);
        added += 1;
      }
    }
    this.options.log(`mind credential: rewritten in-container; ${added} new literal(s) denylisted`);
    return added;
  }
}
