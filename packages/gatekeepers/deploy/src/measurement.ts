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
 * The base tag, as HTML. Only the id varies, and it is validated
 * against a strict pattern before it reaches here, so nothing in it can
 * close the script element.
 */
export function measurementSnippet(id: string): string {
  return snippet(id);
}

/**
 * Insert the base tag into one HTML response unless the page already
 * loads it.
 *
 * This asks HTMLRewriter rather than a regex because the question is
 * genuinely about HTML STRUCTURE: an id named in a comment, in prose,
 * or inside a string is not a tag, and each round of regex refinement
 * here traded one wrong answer for another. A parser answers it
 * exactly, and streams instead of buffering the body.
 *
 * Double-counting is the failure this avoids. A page that already loads
 * gtag for this id and gets a second loader reports every visit twice,
 * silently halving whatever the operator reads; an untagged page is
 * visibly missing instead.
 */
export function injectMeasurementResponse(response: Response, id: string): Response {
  let alreadyLoaded = false;
  return new HTMLRewriter()
    .on("script", {
      element(element) {
        const src = element.getAttribute("src") ?? "";
        if (src.includes("googletagmanager.com/gtag/js") && src.includes(`id=${id}`)) {
          alreadyLoaded = true;
        }
      },
      text(chunk) {
        // An inline config call for this id counts as loaded: the page
        // is already measuring itself.
        const names = chunk.text.includes(`'${id}'`) || chunk.text.includes(`"${id}"`);
        if (names && /gtag\s*\(\s*['"]config['"]/.test(chunk.text)) alreadyLoaded = true;
      }
    })
    .on("head", {
      element(element) {
        element.onEndTag(end => {
          if (!alreadyLoaded) end.before(snippet(id), { html: true });
        });
      }
    })
    .transform(response);
}
