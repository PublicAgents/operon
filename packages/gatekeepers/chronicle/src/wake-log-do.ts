import { DurableObject } from "cloudflare:workers";

/**
 * One WakeLog Durable Object per wake (idFromName(wakeId)): the LIVE,
 * tailable copy of a wake's transcript. Chunks arrive in order from the
 * container; a tail reader polls with ?after=<seq> and receives only
 * what is new. The durable forever-copy is the chronicle D1 mirror; this
 * object self-expires (alarm) once the wake is long over, so per-wake
 * storage does not accrete.
 */

export interface WakeChunk {
  seq: number;
  at: string;
  text: string;
  done: boolean;
}

/** DO copies expire this long after the last append; D1 keeps history. */
const EXPIRE_MS = 7 * 24 * 60 * 60 * 1000;

/** True when the upgrade offered the operon-ws subprotocol. */
export function offersOperonWs(request: Request): boolean {
  return (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .some(entry => entry.trim() === "operon-ws");
}

export class WakeLog extends DurableObject {
  async append(agentId: string, chunk: WakeChunk): Promise<void> {
    await this.ctx.storage.put(`c:${String(chunk.seq).padStart(8, "0")}`, chunk);
    await this.ctx.storage.put("meta", { agentId, lastAt: chunk.at, done: chunk.done });
    await this.ctx.storage.setAlarm(Date.now() + EXPIRE_MS);
    // Live push (spec 0005 §4): every subscriber gets the chunk as it
    // lands; a done chunk ends the stream. Subscribers dedupe by seq, so
    // an overlap with their catch-up read is harmless.
    this.broadcast({ type: "chunks", chunks: [chunk], done: chunk.done });
    if (chunk.done) this.closeAll(1000, "wake done");
  }

  async read(afterSeq = -1): Promise<{ agentId?: string; done: boolean; chunks: WakeChunk[] }> {
    const meta = await this.ctx.storage.get<{ agentId: string; done: boolean }>("meta");
    const chunks = [...(await this.ctx.storage.list<WakeChunk>({ prefix: "c:" })).values()].filter(
      chunk => chunk.seq > afterSeq
    );
    return { agentId: meta?.agentId, done: meta?.done ?? false, chunks };
  }

  /**
   * WebSocket tail (spec 0005 §4), hibernation API so an idle tail costs
   * nothing. The client sends {"after": seq} once open; the DO replays
   * everything newer, then streams appends live; a finished wake gets a
   * done frame and a normal close.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("upgrade required", { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      // Echo the real subprotocol when a client offered one (the CLI
      // rides the token beside it; WHATWG clients validate the echo).
      ...(offersOperonWs(request)
        ? { headers: { "sec-websocket-protocol": "operon-ws" } }
        : {})
    });
  }

  override async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    let after = -1;
    try {
      const parsed = JSON.parse(String(message)) as { after?: number };
      if (typeof parsed.after === "number" && Number.isInteger(parsed.after)) {
        after = parsed.after;
      }
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "malformed_subscribe" }));
      return;
    }
    const current = await this.read(after);
    // A wake this DO never saw (expired, or a typo): close immediately
    // so the subscriber falls back to the durable D1 copy instead of
    // waiting forever on an empty object.
    if (current.agentId === undefined && current.chunks.length === 0) {
      ws.send(JSON.stringify({ type: "empty" }));
      ws.close(1000, "no live wake");
      return;
    }
    ws.send(
      JSON.stringify({
        type: "chunks",
        agentId: current.agentId,
        chunks: current.chunks,
        done: current.done
      })
    );
    if (current.done) ws.close(1000, "wake done");
  }

  override async webSocketClose(): Promise<void> {
    // Nothing to clean: hibernation tracks the socket set.
  }

  override async webSocketError(): Promise<void> {
    // Best-effort tails: an errored socket just drops out of the set.
  }

  private broadcast(frame: unknown): void {
    const text = JSON.stringify(frame);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {
        // A dying socket must not fail the append that feeds the rest.
      }
    }
  }

  private closeAll(code: number, reason: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(code, reason);
      } catch {
        // Already closing; nothing to do.
      }
    }
  }

  override async alarm(): Promise<void> {
    this.closeAll(1000, "wake log expired");
    await this.ctx.storage.deleteAll();
  }
}
