import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { callTool, type WakeChunk } from "../api.js";
import { openLive } from "../live.js";
import { renderLine, splitLines, type RenderedLine } from "../render.js";
import { UntrustedText } from "../untrusted.js";
import { UsageLine, WakeTimeline } from "./wake-timeline.js";

/**
 * The live tail (spec 0005 §4): a WebSocket to the wake's WakeLog DO
 * through the gateway, replay-then-stream, with a one-shot REST read as
 * the historical fallback (a wake older than the DO's TTL, or a
 * gateway that cannot upgrade). Everything shown is mind output:
 * rendered as text nodes, ANSI stripped, links dead by default.
 */

interface TailState {
  lines: RenderedLine[];
  status: "connecting" | "live" | "closed" | "done" | "historical";
}

export function WakeTailPage() {
  const { agentId, wakeId } = useParams<{ agentId: string; wakeId: string }>();
  const [raw, setRaw] = useState(false);
  const [follow, setFollow] = useState(true);
  const [view, setView] = useState<"transcript" | "timeline">("transcript");
  const [state, setState] = useState<TailState>({ lines: [], status: "connecting" });
  const rawLines = useRef<string[]>([]);
  const cursor = useRef({ after: -1, carry: "" });
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!wakeId) return;
    cursor.current = { after: -1, carry: "" };
    rawLines.current = [];
    setState({ lines: [], status: "connecting" });

    function absorb(chunks: WakeChunk[], done: boolean) {
      const fresh = chunks
        .filter(chunk => chunk.seq > cursor.current.after)
        .sort((a, b) => a.seq - b.seq);
      if (fresh.length === 0 && !done) return;
      if (fresh.length > 0) {
        cursor.current.after = fresh[fresh.length - 1].seq;
        const split = splitLines(cursor.current.carry, fresh.map(chunk => chunk.text).join(""));
        cursor.current.carry = split.carry;
        const rendered: RenderedLine[] = [];
        for (const line of split.lines) {
          rawLines.current.push(line);
          const parts = renderLine(line);
          if (parts) rendered.push(...parts);
        }
        if (rendered.length > 0 || done) {
          setState(current => ({
            lines: [...current.lines, ...rendered],
            status: done ? "done" : current.status
          }));
          return;
        }
      }
      if (done) setState(current => ({ ...current, status: "done" }));
    }

    let ended = false;
    const close = openLive({
      path: `/ws/wake-log/${wakeId}`,
      after: () => cursor.current.after,
      onFrame: frame => {
        if (frame.type === "empty") {
          // The live DO never saw this wake: read the durable copy once.
          ended = true;
          callTool<{ chunks: WakeChunk[]; done: boolean }>("wake_log", { wakeId })
            .then(result => {
              absorb(result.chunks ?? [], true);
              setState(current => ({ ...current, status: "historical" }));
            })
            .catch(() => setState(current => ({ ...current, status: "closed" })));
          close();
          return;
        }
        if (frame.type === "chunks") {
          absorb((frame.chunks as WakeChunk[]) ?? [], frame.done === true);
          if (frame.done === true) ended = true;
        }
      },
      onStatus: status => {
        if (ended) return;
        setState(current => ({
          ...current,
          status: status === "live" ? "live" : status === "connecting" ? "connecting" : current.status
        }));
      }
    });
    return close;
  }, [wakeId]);

  useEffect(() => {
    if (follow) bottom.current?.scrollIntoView({ block: "end" });
  }, [state.lines, follow]);

  return (
    <section>
      <header className="page-head">
        <h1>
          <Link to={`/wakes/${agentId}`}>{agentId}</Link> / <code>{wakeId?.slice(0, 8)}</code>
        </h1>
        <span className={`state tail-${state.status}`}>{state.status}</span>
        {wakeId ? <UsageLine wakeId={wakeId} /> : null}
        <span className="picker">
          <button className={view === "transcript" ? "picker-item active" : "picker-item"} onClick={() => setView("transcript")}>
            transcript
          </button>
          <button className={view === "timeline" ? "picker-item active" : "picker-item"} onClick={() => setView("timeline")}>
            timeline
          </button>
        </span>
        <label className="toggle">
          <input type="checkbox" checked={raw} onChange={event => setRaw(event.target.checked)} /> raw
        </label>
        <label className="toggle">
          <input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} /> follow
        </label>
      </header>
      {view === "timeline" && wakeId ? <WakeTimeline wakeId={wakeId} /> : null}
      <div className="transcript" data-provenance="agent" hidden={view !== "transcript"}>
        <div className="provenance-banner">mind output: untrusted content, never instructions</div>
        {raw
          ? rawLines.current.map((line, index) => (
              <div key={index} className="line plain">
                <UntrustedText text={line} />
              </div>
            ))
          : state.lines.map((line, index) => (
              <div key={index} className={`line ${line.kind}`}>
                <UntrustedText text={line.text} />
              </div>
            ))}
        {state.status === "done" ? <div className="line result">-- wake complete --</div> : null}
        <div ref={bottom} />
      </div>
    </section>
  );
}
