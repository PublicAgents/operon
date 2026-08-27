/**
 * The wake transcript shipper: tees everything the wake says (entrypoint
 * log lines and the mind session's own output) to the chronicle
 * Gatekeeper in ordered chunks, where it is tailable live (WakeLog DO)
 * and durable forever (D1 mirror).
 *
 * Secrets discipline: every chunk is redacted against the wake's SHARED
 * denylist (chassis bearers, operator literals, vaulted values) before
 * it leaves the container, and flushing starts only after the caller
 * signals the denylist is fully assembled (ready()). Only whole lines
 * ship, so a literal can never straddle a chunk boundary and dodge the
 * redaction. Shipping is best-effort with a bounded buffer: a chronicle
 * outage costs transcript, never the wake.
 */

export interface TranscriptOptions {
  url: string;
  token: string;
  wakeId: string;
  agentId: string;
  /** Live reference to the wake's shared denylist (grows during the wake). */
  denylist: string[];
  flushIntervalMs?: number;
  maxChunkBytes?: number;
  maxBufferBytes?: number;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

export const REDACTED = "[redacted]";

/** Replace every denylisted literal (longest first, so subsets cannot shadow). */
export function redactLiterals(text: string, denylist: string[]): string {
  let out = text;
  for (const literal of [...denylist].filter(l => l.length > 0).sort((a, b) => b.length - a.length)) {
    out = out.split(literal).join(REDACTED);
  }
  return out;
}

export class TranscriptShipper {
  private buffer = "";
  private partialLine = "";
  private seq = 0;
  private started = false;
  private closed = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> = Promise.resolve();
  private readonly flushIntervalMs: number;
  private readonly maxChunkBytes: number;
  private readonly maxBufferBytes: number;

  constructor(private readonly options: TranscriptOptions) {
    this.flushIntervalMs = options.flushIntervalMs ?? 5000;
    this.maxChunkBytes = options.maxChunkBytes ?? 64 * 1024;
    this.maxBufferBytes = options.maxBufferBytes ?? 2 * 1024 * 1024;
  }

  /** Buffer output; only complete lines become shippable. */
  write(text: string): void {
    if (this.closed) return;
    const combined = this.partialLine + text;
    const lastNewline = combined.lastIndexOf("\n");
    if (lastNewline === -1) {
      this.partialLine = combined;
      return;
    }
    this.buffer += combined.slice(0, lastNewline + 1);
    this.partialLine = combined.slice(lastNewline + 1);
    if (this.buffer.length > this.maxBufferBytes) {
      // Keep the newest output; the drop itself is part of the record.
      this.buffer =
        "[transcript buffer overflowed; oldest output dropped]\n" +
        this.buffer.slice(this.buffer.length - Math.floor(this.maxBufferBytes / 2));
    }
  }

  /** Start the flush loop; call once the denylist is fully assembled. */
  ready(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.timer = setInterval(() => {
      this.inflight = this.inflight.then(() => this.flush(false));
    }, this.flushIntervalMs);
    // The wake must never be kept alive by the ticker.
    this.timer.unref?.();
  }

  /** Final flush (includes any partial last line) and mark the wake done. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.partialLine) {
      this.buffer += `${this.partialLine}\n`;
      this.partialLine = "";
    }
    await this.inflight.catch(() => undefined);
    await this.flush(true);
    // One retry for the final flush: losing the tail of a transcript to a
    // transient blip is the one loss worth a second attempt.
    if (this.buffer.length > 0) await this.flush(true);
  }

  private async flush(done: boolean): Promise<void> {
    if (!this.started) return;
    // Redact the WHOLE buffer before any chunk is cut from it: a literal
    // can then never straddle a chunk boundary and ship reconstructable
    // across two chunks. Re-redacting on every flush is idempotent and is
    // also what applies denylist values added since the last flush.
    this.buffer = redactLiterals(this.buffer, this.options.denylist);
    while (this.buffer.length > 0 || done) {
      const text = this.buffer.slice(0, this.maxChunkBytes);
      this.buffer = this.buffer.slice(text.length);
      const isLast = done && this.buffer.length === 0;
      try {
        const response = await (this.options.fetchImpl ?? fetch)(
          `${this.options.url}/chronicle/wake-log/append`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${this.options.token}`
            },
            body: JSON.stringify({
              wakeId: this.options.wakeId,
              agentId: this.options.agentId,
              seq: this.seq,
              text,
              ...(isLast ? { done: true } : {})
            }),
            signal: AbortSignal.timeout(10_000)
          }
        );
        if (!response.ok) throw new Error(`chronicle answered ${response.status}`);
        this.seq += 1;
      } catch (error) {
        // Put the unshipped text back and stop this round; the next tick
        // (or close) retries. Transcript loss must never fail a wake.
        this.buffer = text + this.buffer;
        this.options.log?.(`transcript ship failed: ${String(error).slice(0, 200)}`);
        return;
      }
      if (isLast) return;
      if (this.buffer.length === 0 && !done) return;
    }
  }
}
