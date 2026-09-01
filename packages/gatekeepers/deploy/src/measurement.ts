/**
 * The Google Analytics tag on published pages (spec 0008 §5).
 *
 * A measurement id is public by design: it ships in the HTML to every
 * visitor. So it lives in colony policy, not in a secret, and the
 * chassis puts the base tag on every page at SERVE time rather than
 * asking each agent to remember it at publish time. Serve time because
 * the coverage is then uniform across everything ever published, and
 * because changing or removing the id needs no republish.
 *
 * The agent still writes its own `gtag('event', ...)` calls; it is told
 * the id by the living help. This module only guarantees the base tag
 * is there for those events to reach.
 */

/** G-XXXXXXXXXX, and nothing that could close the script tag. */
const MEASUREMENT_ID = /^G-[A-Z0-9]{4,20}$/;

export function validMeasurementId(id: string | undefined): string | null {
  const trimmed = (id ?? "").trim();
  return MEASUREMENT_ID.test(trimmed) ? trimmed : null;
}

function snippet(id: string): string {
  return (
    `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>` +
    `<script>window.dataLayer=window.dataLayer||[];` +
    `function gtag(){dataLayer.push(arguments);}` +
    `gtag('js',new Date());gtag('config','${id}');</script>`
  );
}

/**
 * Insert the base tag before </head>, or before </body> for a fragment
 * with no head. A page that already names this id is left alone: an
 * agent that hand-rolled its own tag would otherwise double-count every
 * visit, and silently halving its own numbers is worse than an untagged
 * page.
 */
export function injectMeasurement(html: string, id: string): string {
  if (html.includes(id)) return html;
  const tag = snippet(id);
  const head = html.search(/<\/head\s*>/i);
  if (head !== -1) return html.slice(0, head) + tag + html.slice(head);
  const body = html.search(/<\/body\s*>/i);
  if (body !== -1) return html.slice(0, body) + tag + html.slice(body);
  // No head and no body: an HTML fragment. Appending still runs, and a
  // fragment nobody wrapped is not a page we should refuse to serve.
  return html + tag;
}
