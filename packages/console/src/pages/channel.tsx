import { useEffect, useMemo, useRef, useState } from "react";
import { callTool, type AgentRow, type ChannelEntry } from "../api.js";
import { COMMANDS, completions, parseCommand, usage } from "../commands.js";
import { useTool } from "../hooks.js";
import { openLive } from "../live.js";
import { ErrorNote } from "../ui.js";
import { UntrustedText } from "../untrusted.js";

/**
 * The operator channel (spec 0005 §5): the Telegram-equivalent surface.
 * Live over the Channel DO's WebSocket; plain text posts channel_send,
 * and the Telegram slash commands work here too (/wake, /tell,
 * /approve, /reject, /disable, /enable, /help) with a completion menu.
 * A leading slash never broadcasts. Agent entries are hard-marked
 * untrusted; delivery to an agent happens at its next wake pull.
 */

interface Notice {
  key: string;
  at: string;
  text: string;
  error: boolean;
}

type LogItem =
  | { type: "entry"; at: string; entry: ChannelEntry }
  | { type: "notice"; at: string; notice: Notice };

const HELP_TEXT = COMMANDS.map(spec => `${usage(spec)} : ${spec.description}`).join("\n");

export function ChannelPage() {
  const agents = useTool<{ agents: AgentRow[] }>("agents_list", {});
  const agentIds = useMemo(
    () => (agents.data?.agents ?? []).map(agent => agent.id),
    [agents.data]
  );
  const [target, setTarget] = useState("*");
  const [draft, setDraft] = useState("");
  const [entries, setEntries] = useState<ChannelEntry[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [status, setStatus] = useState("connecting");
  const [menuIndex, setMenuIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const lastId = useRef(0);
  const noticeSeq = useRef(0);
  const bottom = useRef<HTMLDivElement>(null);

  const suggestions = useMemo(() => completions(draft, agentIds), [draft, agentIds]);
  useEffect(() => setMenuIndex(0), [draft]);

  useEffect(() => {
    const close = openLive({
      path: "/ws/channel",
      after: () => lastId.current,
      onFrame: frame => {
        const incoming: ChannelEntry[] =
          frame.type === "entries"
            ? ((frame.entries as ChannelEntry[]) ?? [])
            : frame.type === "entry"
              ? [frame.entry as ChannelEntry]
              : [];
        const fresh = incoming.filter(entry => entry.id > lastId.current);
        if (fresh.length === 0) return;
        lastId.current = Math.max(...fresh.map(entry => entry.id));
        setEntries(current => [...current, ...fresh].slice(-500));
      },
      onStatus: setStatus
    });
    return close;
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [entries, notices]);

  function notice(text: string, error = false) {
    noticeSeq.current += 1;
    setNotices(current => [
      ...current.slice(-50),
      { key: `n${noticeSeq.current}`, at: new Date().toISOString(), text, error }
    ]);
  }

  const items: LogItem[] = useMemo(() => {
    const visible =
      target === "*"
        ? entries
        : entries.filter(entry => entry.agentId === target || entry.agentId === "*");
    return [
      ...visible.map(entry => ({ type: "entry", at: entry.at, entry }) as LogItem),
      ...notices.map(item => ({ type: "notice", at: item.at, notice: item }) as LogItem)
    ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }, [entries, notices, target]);

  function applySuggestion(index: number) {
    const chosen = suggestions[index];
    if (chosen) setDraft(chosen.replace);
  }

  async function run(text: string) {
    const command = parseCommand(text);
    switch (command.kind) {
      case "message":
        await callTool("channel_send", { agentId: target, text });
        return;
      case "help":
        notice(HELP_TEXT);
        return;
      case "invalid":
        notice(command.reason, true);
        return;
      case "tell":
        await callTool("channel_send", { agentId: command.agentId, text: command.text });
        return;
      case "wake": {
        const result = (await callTool("wake", { agentId: command.agentId })) as {
          status?: string;
          detail?: string;
        };
        notice(
          `/wake ${command.agentId}: ${result.status ?? "?"}${result.detail ? ` (${result.detail})` : ""}`,
          result.status !== "started"
        );
        return;
      }
      case "disable": {
        const result = (await callTool("agent_disable", { agentId: command.agentId })) as {
          killedWakeId?: string;
        };
        notice(
          `${command.agentId} DISABLED: all wakes refused until /enable ${command.agentId}` +
            (result.killedWakeId ? `; killed running wake ${result.killedWakeId.slice(0, 8)}` : "")
        );
        return;
      }
      case "enable":
        await callTool("agent_enable", { agentId: command.agentId });
        notice(`${command.agentId} enabled: cron and /wake work again`);
        return;
      case "approve":
      case "reject":
        await callTool(command.kind === "approve" ? "email_approve" : "email_reject", {
          agentId: command.agentId,
          heldId: command.heldId
        });
        notice(`${command.kind === "approve" ? "approved and sent" : "rejected"}: ${command.agentId} held ${command.heldId.slice(0, 8)}`);
        return;
    }
  }

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await run(text);
      setDraft("");
    } catch (error) {
      notice(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (suggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMenuIndex(index => (index + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMenuIndex(index => (index - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.metaKey && !event.ctrlKey)) {
        event.preventDefault();
        applySuggestion(menuIndex);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDraft(current => current + " ");
        return;
      }
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    }
  }

  return (
    <section className="channel">
      <header className="page-head">
        <h1>Channel</h1>
        <span className={`state tail-${status === "live" ? "live" : "connecting"}`}>{status}</span>
        <select value={target} onChange={event => setTarget(event.target.value)}>
          <option value="*">all agents (broadcast)</option>
          {agentIds.map(id => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </header>
      <div className="channel-log">
        {items.map(item =>
          item.type === "entry" ? (
            <div
              key={`e${item.entry.id}`}
              className={`bubble ${item.entry.from}`}
              data-provenance={item.entry.from}
            >
              <div className="bubble-head">
                {item.entry.from === "agent" ? (
                  <>
                    <span className="who agent-badge">{item.entry.agentId}</span>
                    <span className="untrusted-badge">untrusted</span>
                  </>
                ) : (
                  <span className="who">
                    operator → {item.entry.agentId === "*" ? "all" : item.entry.agentId}
                  </span>
                )}
                <span className="time" title={item.entry.at}>
                  {item.entry.at.slice(11, 16)}
                </span>
              </div>
              <UntrustedText text={item.entry.text} className={item.entry.from} />
            </div>
          ) : (
            <div
              key={item.notice.key}
              className={`bubble system ${item.notice.error ? "system-error" : ""}`}
            >
              <div className="bubble-head">
                <span className="who">console</span>
                <span className="time" title={item.notice.at}>
                  {item.notice.at.slice(11, 16)}
                </span>
              </div>
              <span className="system-text">{item.notice.text}</span>
            </div>
          )
        )}
        <div ref={bottom} />
      </div>
      <div className="composer">
        <div className="composer-input">
          {suggestions.length > 0 ? (
            <div className="command-menu">
              {suggestions.map((suggestion, index) => (
                <button
                  key={suggestion.label}
                  className={index === menuIndex ? "command-item active" : "command-item"}
                  onMouseEnter={() => setMenuIndex(index)}
                  onClick={() => applySuggestion(index)}
                >
                  <span className="command-label">{suggestion.label}</span>
                  <span className="command-detail">{suggestion.detail}</span>
                </button>
              ))}
            </div>
          ) : null}
          <textarea
            placeholder={
              (target === "*"
                ? "message all agents (delivered at each agent's next wake)"
                : `message ${target} (delivered at its next wake)`) + "; / for commands"
            }
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <button onClick={() => void send()} disabled={!draft.trim() || busy}>
          {busy ? "…" : "send"}
        </button>
      </div>
      <ErrorNote error={agents.error} />
    </section>
  );
}
