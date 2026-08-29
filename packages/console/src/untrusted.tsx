import { useState } from "react";
import { coerceText, stripAnsi } from "./render.js";

/**
 * Rendering untrusted text (spec 0005 §8): agent and world authored
 * strings become TEXT NODES, never markup. URLs are never live links;
 * an explicit open affordance shows the full URL in a confirm step,
 * then opens a new tab with noopener. Provenance is visually marked by
 * the callers' styling; this module owns the mechanics.
 */

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/g;

export function ExternalUrl({ url }: { url: string }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <span className="ext-url">
        <span className="ext-url-text">{url}</span>{" "}
        <button className="ext-url-open" onClick={() => setConfirming(true)} title="Open this URL">
          open
        </button>
      </span>
    );
  }
  return (
    <span className="ext-url confirming">
      <span className="ext-url-text">{url}</span>{" "}
      <span className="ext-url-warn">leave the console?</span>{" "}
      <button
        className="danger"
        onClick={() => {
          window.open(url, "_blank", "noopener,noreferrer");
          setConfirming(false);
        }}
      >
        open tab
      </button>{" "}
      <button onClick={() => setConfirming(false)}>cancel</button>
    </span>
  );
}

export function UntrustedText({ text, className }: { text: unknown; className?: string }) {
  // Defensive at the boundary: chronicle detail fields arrive as JSON
  // objects, and a non-string here must degrade to readable text, never
  // crash the page (an uncaught render error blanks the whole console).
  const clean = stripAnsi(coerceText(text));
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (const match of clean.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    if (start > cursor) parts.push(clean.slice(cursor, start));
    parts.push(<ExternalUrl key={key++} url={match[0]} />);
    cursor = start + match[0].length;
  }
  if (cursor < clean.length) parts.push(clean.slice(cursor));
  return <span className={`untrusted ${className ?? ""}`}>{parts}</span>;
}
