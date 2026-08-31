import { useState } from "react";
import { ApiError, callTool } from "../api.js";
import { useTool } from "../hooks.js";
import { ConfirmButton, Empty, ErrorNote, LoadingGate, TimeStamp } from "../ui.js";
import { ExternalUrl, UntrustedText } from "../untrusted.js";

/**
 * The decision queue (spec 0007). Everything an agent asks of the
 * operator lives here with its thread and its state.
 *
 * The rendering boundary matters more here than anywhere else in the
 * console (spec 0005 §8): an ask is untrusted mind output that is
 * explicitly asking a human to decide something, which makes it the
 * highest-value place in the system for an injected instruction to be
 * read as the operator's own idea. So agent text renders as text
 * nodes, hard-marked, with links dead behind the interstitial, and no
 * decision control is ever parameterized by it: the buttons act on
 * the ask's id and its state, never on anything the agent wrote.
 */

type AskState = "open" | "acknowledged" | "allowed" | "declined" | "closed" | "retracted";

interface ThreadEntry {
  seq: number;
  at: string;
  author: "agent" | "operator";
  kind: "message" | "state_change";
  state?: AskState;
  text?: string;
}

interface Ask {
  id: string;
  agentId: string;
  title: string;
  body: string;
  kind: "decision" | "request" | "question";
  links: string[];
  state: AskState;
  createdAt: string;
  updatedAt: string;
  thread: ThreadEntry[];
}

/** Open first, then the ones the operator took, then the settled. */
const STATE_ORDER: AskState[] = ["open", "acknowledged", "allowed", "declined", "closed", "retracted"];

/**
 * What the ask says it needs, offered first. Every action stays
 * available on every ask: the agent's framing is sometimes wrong, and
 * the operator is the authority on what an ask actually is.
 */
const SUGGESTED: Record<Ask["kind"], AskState[]> = {
  decision: ["allowed", "declined", "acknowledged"],
  request: ["acknowledged", "allowed", "declined"],
  question: ["acknowledged", "allowed", "declined"]
};

const LABEL: Record<AskState, string> = {
  open: "open",
  acknowledged: "on it",
  allowed: "allow",
  declined: "decline",
  closed: "close",
  retracted: "retracted"
};

/**
 * A refused decision, said in operator terms. The 409 body also carries
 * a thread tail; it is deliberately not rendered here, because this
 * notice sits next to the decision buttons and only gatekeeper facts
 * belong that close to them. The refreshed card below shows the thread.
 */
function conflictMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return "the decision did not go through; try again";
  const body = error.body as { error?: unknown; state?: unknown } | null;
  const state = typeof body?.state === "string" ? body.state : undefined;
  if (body?.error === "ask_terminal") return `this ask is already ${state ?? "settled"}; it cannot move`;
  if (body?.error === "ask_state_moved") {
    return `the ask moved to ${state ?? "another state"} while you were reading it; nothing was overwritten`;
  }
  return error.message;
}

function Thread({ entries }: { entries: ThreadEntry[] }) {
  if (entries.length === 0) return <p className="sub">no replies yet</p>;
  return (
    <ol className="ask-thread">
      {entries.map(entry => (
        <li key={entry.seq} className={entry.author === "operator" ? "from-operator" : "from-agent"}>
          <span className="tag">{entry.author}</span>
          <TimeStamp at={entry.at} />
          {entry.kind === "state_change" ? <span className="tag">{entry.state}</span> : null}
          {entry.text !== undefined ? (
            entry.author === "agent" ? (
              <UntrustedText text={entry.text} />
            ) : (
              <span className="operator-text">{entry.text}</span>
            )
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function AskCard({ ask, refresh }: { ask: Ask; refresh: () => void }) {
  const [reply, setReply] = useState("");
  const [note, setNote] = useState("");
  const [conflict, setConflict] = useState<string | null>(null);
  const settled = ask.state === "closed" || ask.state === "retracted";

  async function decide(decision: AskState) {
    setConflict(null);
    try {
      // expectedState is what THIS view rendered: if the ask moved
      // since (the agent retracted it, another tab decided), the
      // gatekeeper refuses rather than overwriting, and the refusal
      // is shown instead of silently winning.
      await callTool("ask_decide", {
        askId: ask.id,
        expectedState: ask.state,
        decision,
        ...(note.trim().length > 0 ? { text: note.trim() } : {})
      });
      setNote("");
      refresh();
    } catch (error) {
      setConflict(conflictMessage(error));
      refresh();
    }
  }

  return (
    <div className="held-card">
      <div className="held-facts">
        <span className="tag">{ask.agentId}</span>
        <span className="tag">{ask.kind}</span>
        <span className="tag">{ask.state}</span>
        <strong>
          <UntrustedText text={ask.title} />
        </strong>
        <span>
          asked <TimeStamp at={ask.createdAt} /> · ask {ask.id}
        </span>
      </div>
      <div className="ask-body">
        <UntrustedText text={ask.body} />
      </div>
      {ask.links.length > 0 ? (
        <p className="sub">
          {ask.links.map(link => (
            <ExternalUrl key={link} url={link} />
          ))}
        </p>
      ) : null}
      <Thread entries={ask.thread} />
      {conflict ? <ErrorNote error={conflict} /> : null}
      {settled ? (
        <p className="sub">settled; replies still land in the thread</p>
      ) : (
        <>
          <label className="ask-note">
            <span className="sub">a note, recorded with the decision (optional)</span>
            <textarea
              value={note}
              onChange={event => setNote(event.target.value)}
              rows={2}
              placeholder="why"
            />
          </label>
          <div className="held-actions">
            {SUGGESTED[ask.kind]
              .filter(decision => decision !== ask.state)
              .map(decision => (
                <ConfirmButton
                  key={decision}
                  label={LABEL[decision]}
                  danger={decision === "declined"}
                  detail={
                    <span className="confirm-note">
                      mark ask {ask.id} as {decision}
                    </span>
                  }
                  onConfirm={() => decide(decision)}
                />
              ))}
            <ConfirmButton
              label="close"
              detail={<span className="confirm-note">close ask {ask.id}</span>}
              onConfirm={() => decide("closed")}
            />
          </div>
        </>
      )}
      <div className="ask-reply">
        <textarea
          value={reply}
          onChange={event => setReply(event.target.value)}
          rows={2}
          placeholder="reply in this thread"
        />
        <button
          disabled={reply.trim().length === 0}
          onClick={async () => {
            setConflict(null);
            try {
              await callTool("ask_reply", { askId: ask.id, text: reply.trim() });
              setReply("");
            } catch (error) {
              setConflict(conflictMessage(error));
            }
            refresh();
          }}
        >
          reply
        </button>
      </div>
    </div>
  );
}

export function AsksPage() {
  const [showSettled, setShowSettled] = useState(false);
  const asks = useTool<{ asks: Ask[] }>("ask_list", {}, { pollMs: 20_000 });
  const rows = (asks.data?.asks ?? [])
    .filter(ask => showSettled || (ask.state !== "closed" && ask.state !== "retracted"))
    .sort(
      (left, right) =>
        STATE_ORDER.indexOf(left.state) - STATE_ORDER.indexOf(right.state) ||
        (left.createdAt < right.createdAt ? 1 : -1)
    );
  const waiting = (asks.data?.asks ?? []).filter(ask => ask.state === "open").length;
  return (
    <section>
      <header className="page-head">
        <h1>Asks</h1>
        <span className="sub">
          {waiting} waiting on you; every action is available on every ask, whatever it asked for
        </span>
        <button onClick={() => setShowSettled(value => !value)}>
          {showSettled ? "hide settled" : "show settled"}
        </button>
        <button onClick={() => asks.refresh()}>refresh</button>
      </header>
      <ErrorNote error={asks.error} />
      <LoadingGate loading={asks.loading} hasData={asks.data !== undefined}>
        {rows.length === 0 && !asks.loading ? <Empty>nothing is waiting on you</Empty> : null}
        {rows.map(ask => (
          <AskCard key={ask.id} ask={ask} refresh={asks.refresh} />
        ))}
      </LoadingGate>
    </section>
  );
}
