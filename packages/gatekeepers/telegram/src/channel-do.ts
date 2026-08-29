import { DurableObject } from "cloudflare:workers";
import { recordMessage } from "@operon/chronicle";
import {
  effectiveCursors,
  prunableIds,
  transcriptFor,
  type AgentTranscript,
  type ChannelEntry
} from "./channel.js";

/**
 * One Channel Durable Object per colony: the operator-conversation log and
 * each agent's delivery cursor. Serialized by the DO, so ids are strictly
 * monotonic and pulls never race appends.
 */
export class Channel extends DurableObject {
  /**
   * protectAgents is the roster's agent list: agents whose unread backlog
   * pruning must respect even before their first ack. undefined (roster
   * unavailable to the caller) fails safe: nothing prunes below the hard
   * bound.
   */
  async append(
    entry: Omit<ChannelEntry, "id">,
    protectAgents?: string[]
  ): Promise<ChannelEntry> {
    const nextId = ((await this.ctx.storage.get<number>("nextId")) ?? 1);
    const stored: ChannelEntry = { id: nextId, ...entry };
    await this.ctx.storage.put(`e:${String(nextId).padStart(10, "0")}`, stored);
    await this.ctx.storage.put("nextId", nextId + 1);
    // Chronicle mirror: the channel prunes (it is a window, not an
    // archive); the mirror is where history stops being lost. Best-effort.
    const chronicle = (this.env as { CHRONICLE?: D1Database }).CHRONICLE;
    if (chronicle) {
      this.ctx.waitUntil(
        recordMessage(chronicle, {
          at: stored.at,
          kind: stored.from === "operator" ? "channel_operator" : "channel_agent",
          agentId: stored.agentId,
          sender: stored.from,
          body: stored.text,
          refId: String(stored.id)
        })
      );
    }
    // Prune cursor-aware: only entries every known agent has acked are
    // dropped at the normal retention (a long-idle agent must not lose
    // unread instructions), with a hard bound as the logged backstop. The
    // channel is a recent-context window, not an archive (the ledger and
    // the agents' own journals are the archive).
    const entries = [...(await this.ctx.storage.list<ChannelEntry>({ prefix: "e:" })).values()];
    const cursorsByAgent = new Map(
      [...(await this.ctx.storage.list<number>({ prefix: "cursor:" })).entries()].map(
        ([key, value]) => [key.slice("cursor:".length), value] as const
      )
    );
    const { ids, droppedUnacked } = prunableIds(
      entries,
      effectiveCursors(cursorsByAgent, protectAgents)
    );
    if (ids.length > 0) {
      if (droppedUnacked > 0) {
        console.error(
          `channel hard retention: dropping ${droppedUnacked} entries never delivered to some agent`
        );
      }
      await this.ctx.storage.delete(ids.map(id => `e:${String(id).padStart(10, "0")}`));
    }
    // Live push (spec 0005 §4): the console's channel view and
    // notification badge subscribe over WebSocket; every entry (operator
    // and agent alike) is broadcast as it lands. Subscribers dedupe by id.
    const frame = JSON.stringify({ type: "entry", entry: stored });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(frame);
      } catch {
        // A dying subscriber must not fail the append.
      }
    }
    return stored;
  }

  /**
   * WebSocket subscription (spec 0005 §4), hibernation API. The client
   * sends {"after": id} once open; the DO replays newer entries, then
   * streams appends live.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("upgrade required", { status: 426 });
    }
    const offered = (request.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .some(entry => entry.trim() === "operon-ws");
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      // Echo the real subprotocol when offered (WHATWG clients validate).
      ...(offered ? { headers: { "sec-websocket-protocol": "operon-ws" } } : {})
    });
  }

  override async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    let after = 0;
    try {
      const parsed = JSON.parse(String(message)) as { after?: number };
      if (typeof parsed.after === "number" && Number.isInteger(parsed.after)) {
        after = parsed.after;
      }
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "malformed_subscribe" }));
      return;
    }
    const entries = [...(await this.ctx.storage.list<ChannelEntry>({ prefix: "e:" })).values()]
      .filter(entry => entry.id > after);
    ws.send(JSON.stringify({ type: "entries", entries }));
  }

  override async webSocketClose(): Promise<void> {
    // Hibernation tracks the socket set; nothing to clean.
  }

  override async webSocketError(): Promise<void> {
    // Best-effort subscriptions; an errored socket drops out of the set.
  }

  /**
   * The agent's recent transcript plus which operator entries are new since
   * its last acked wake. Does NOT advance the cursor: the wake acks after
   * its state persists, so a dead wake re-receives the same [NEW] marks.
   */
  async pullFor(agentId: string): Promise<AgentTranscript> {
    const entries = [...(await this.ctx.storage.list<ChannelEntry>({ prefix: "e:" })).values()];
    const cursor = (await this.ctx.storage.get<number>(`cursor:${agentId}`)) ?? 0;
    return transcriptFor(entries, agentId, cursor);
  }

  /** One stored entry by id; null once pruned (the channel is a window, not an archive). */
  async entry(id: number): Promise<ChannelEntry | null> {
    return (await this.ctx.storage.get<ChannelEntry>(`e:${String(id).padStart(10, "0")}`)) ?? null;
  }

  async ack(agentId: string, upTo: number): Promise<void> {
    const cursor = (await this.ctx.storage.get<number>(`cursor:${agentId}`)) ?? 0;
    if (upTo > cursor) await this.ctx.storage.put(`cursor:${agentId}`, upTo);
  }
}
