/**
 * Live subscriptions (spec 0005 §4): a same-origin WebSocket to the
 * gateway's /ws routes (the Access cookie rides the upgrade), with
 * reconnect and backoff. Frames are JSON; callers dedupe by seq/id, so
 * a reconnect's replay overlap is harmless.
 */

export interface LiveOptions {
  /** Path under the ops host, e.g. /ws/channel. */
  path: string;
  /** Sent as {after} once the socket opens (and on every reconnect). */
  after: () => number;
  onFrame: (frame: Record<string, unknown>) => void;
  onStatus?: (status: "connecting" | "live" | "closed") => void;
}

export function openLive(options: LiveOptions): () => void {
  let socket: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function connect() {
    if (closed) return;
    options.onStatus?.("connecting");
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${protocol}//${location.host}${options.path}`);
    socket.addEventListener("open", () => {
      attempt = 0;
      options.onStatus?.("live");
      socket?.send(JSON.stringify({ after: options.after() }));
    });
    socket.addEventListener("message", event => {
      try {
        const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
        options.onFrame(frame);
      } catch {
        // A malformed frame is dropped; the cursor protocol re-syncs.
      }
    });
    socket.addEventListener("close", () => {
      options.onStatus?.("closed");
      if (closed) return;
      attempt += 1;
      timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)));
    });
    socket.addEventListener("error", () => {
      socket?.close();
    });
  }

  connect();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    socket?.close();
  };
}
