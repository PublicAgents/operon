import { useState, type ReactNode } from "react";

export function ErrorNote({ error }: { error?: string }) {
  if (!error) return null;
  return <div className="error-note">{error}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function TimeStamp({ at }: { at?: string }) {
  if (!at) return <span className="time">–</span>;
  const date = new Date(at);
  const deltaMs = Date.now() - date.getTime();
  const minutes = Math.round(deltaMs / 60_000);
  const rel =
    minutes < 1
      ? "just now"
      : minutes < 60
        ? `${minutes}m ago`
        : minutes < 60 * 48
          ? `${Math.round(minutes / 60)}h ago`
          : `${Math.round(minutes / 60 / 24)}d ago`;
  return (
    <span className="time" title={at}>
      {rel}
    </span>
  );
}

/**
 * A decision button (spec 0005 §8): always an explicit confirm step;
 * with confirmName set, the operator must type the target's name (the
 * secret/delete tier). The dialog body is the caller's, and callers
 * render only gatekeeper facts in it, never message text.
 */
export function ConfirmButton({
  label,
  danger,
  confirmName,
  detail,
  onConfirm
}: {
  label: string;
  danger?: boolean;
  /** Require typing this exact string to arm the confirm. */
  confirmName?: string;
  detail?: ReactNode;
  onConfirm: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
  const armed = !confirmName || typed === confirmName;

  if (!open) {
    return (
      <button className={danger ? "danger" : ""} onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  }
  return (
    <span className="confirm-inline">
      {detail}
      {confirmName ? (
        <input
          autoFocus
          placeholder={`type "${confirmName}"`}
          value={typed}
          onChange={event => setTyped(event.target.value)}
        />
      ) : null}
      <button
        className={danger ? "danger" : ""}
        disabled={!armed || busy}
        onClick={async () => {
          setBusy(true);
          setFailure(undefined);
          try {
            await onConfirm();
            setOpen(false);
            setTyped("");
          } catch (error) {
            setFailure(error instanceof Error ? error.message : String(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "…" : `confirm ${label}`}
      </button>
      <button
        onClick={() => {
          setOpen(false);
          setTyped("");
          setFailure(undefined);
        }}
      >
        cancel
      </button>
      {failure ? <span className="error-note inline">{failure}</span> : null}
    </span>
  );
}
