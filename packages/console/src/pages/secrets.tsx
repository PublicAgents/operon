import { useState } from "react";
import { callTool, type AgentRow } from "../api.js";
import { useTool } from "../hooks.js";
import { ConfirmButton, Empty, ErrorNote, LoadingGate } from "../ui.js";

/**
 * Worker secrets (spec 0005 §6): names only, values write-only. Every
 * write is a typed-name confirm; a secret write creates a new worker
 * version (platform behavior), and the value never appears in any
 * response, ledger, or log.
 */

const WORKERS = [
  "scheduler",
  "gatekeeper-ops",
  "gatekeeper-telegram",
  "gatekeeper-chronicle",
  "gatekeeper-github",
  "gatekeeper-pr",
  "gatekeeper-deploy",
  "gatekeeper-email",
  "gatekeeper-spend",
  "gatekeeper-till",
  "gatekeeper-vault",
  "gatekeeper-x",
  "gatekeeper-browser"
];

const STATIC_GROUPS = [
  "notify",
  "publish",
  "github-token-mint",
  "persist",
  "pr",
  "email",
  "wake-trigger",
  "chronicle"
];

function SetSecret({ worker, onDone }: { worker: string; onDone: () => void }) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  return (
    <div className="secret-set">
      <input
        placeholder="SECRET_NAME"
        value={name}
        onChange={event => setName(event.target.value.toUpperCase())}
      />
      <input
        type="password"
        autoComplete="off"
        placeholder="value (write-only)"
        value={value}
        onChange={event => setValue(event.target.value)}
      />
      <ConfirmButton
        label="set secret"
        danger
        confirmName={name || "SECRET_NAME"}
        detail={
          <span className="confirm-note">
            writes {name || "?"} on {worker} and creates a new worker version
          </span>
        }
        onConfirm={async () => {
          await callTool("secret_set", { worker, name, value });
          setName("");
          setValue("");
          onDone();
        }}
      />
    </div>
  );
}

export function SecretsPage() {
  const [worker, setWorker] = useState("scheduler");
  const names = useTool<{ secrets: string[] }>("secret_list", { worker });
  const agents = useTool<{ agents: AgentRow[] }>("agents_list", {});
  const groups = [
    ...STATIC_GROUPS,
    ...(agents.data?.agents ?? []).flatMap(agent =>
      ["till", "spend", "vault", "x"].map(door => `${door}-${agent.id}`)
    )
  ];
  const [group, setGroup] = useState(STATIC_GROUPS[0]);
  const [rotated, setRotated] = useState<string | undefined>();
  return (
    <section>
      <header className="page-head">
        <h1>Secrets</h1>
        <select value={worker} onChange={event => setWorker(event.target.value)}>
          {WORKERS.map(name => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <button onClick={names.refresh}>refresh</button>
      </header>
      <ErrorNote error={names.error} />
      <div className="approval-block">
        <h2>names on {worker} (values are unreadable by construction)</h2>
        <LoadingGate loading={names.loading} hasData={names.data !== undefined}>
        {(names.data?.secrets ?? []).length === 0 && !names.loading ? (
          <Empty>none listed (or secrets are not configured on the gateway)</Empty>
        ) : null}
        <div className="secret-names">
          {(names.data?.secrets ?? []).map(name => (
            <code key={name}>{name}</code>
          ))}
        </div>
        </LoadingGate>
        <SetSecret worker={worker} onDone={names.refresh} />
      </div>
      <div className="approval-block">
        <h2>rotate an internal bearer group</h2>
        <p className="sub">
          one fresh value, generated on the gateway and never shown, written to every worker in the
          group
        </p>
        <select value={group} onChange={event => setGroup(event.target.value)}>
          {groups.map(name => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <ConfirmButton
          label="rotate"
          danger
          confirmName={group}
          detail={<span className="confirm-note">rotates every member of {group} to one new value</span>}
          onConfirm={async () => {
            const result = (await callTool("secret_rotate_group", { group })) as {
              written?: string[];
            };
            setRotated(`rotated ${group}: ${(result.written ?? []).join(", ")}`);
          }}
        />
        {rotated ? <div className="ok-note">{rotated}</div> : null}
      </div>
    </section>
  );
}
