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
 * about HTML STRUCTURE: an id named in a comment, in prose, or inside a
 * string is not a tag, and each round of regex refinement here traded
 * one wrong answer for another. A parser answers it exactly, and
 * streams instead of buffering the body.
 *
 * The tag goes at the END of the document rather than in the head, for
 * a reason worth stating: whether the page already loads gtag is only
 * fully known once every script has been seen, and a page whose own tag
 * sits at the bottom of the body would otherwise get a second one
 * inserted above it. Late is a few milliseconds; double-counting is
 * silent and halves whatever the operator reads. The fallbacks below
 * also mean a body-only page or a bare fragment is measured, rather
 * than only pages that happen to carry a literal <head>.
 */
export function injectMeasurementResponse(response: Response, id: string): Response {
  let alreadyLoaded = false;
  let inserted = false;
  // HTMLRewriter delivers a script's text in CHUNKS, so a config call
  // can be split mid-statement; accumulate the element's text and judge
  // it once, at the end. And only a script the browser would RUN counts:
  // a JSON or template block containing the same characters is data.
  let executable = false;
  let scriptText = "";

  /** One insertion per document, and never when the page tags itself. */
  const insertOnce = (emit: () => void): void => {
    if (alreadyLoaded || inserted) return;
    inserted = true;
    emit();
  };
  return new HTMLRewriter()
    .on("script", {
      element(element) {
        scriptText = "";
        const type = (element.getAttribute("type") ?? "").toLowerCase().trim();
        executable = type === "" || type === "module" || /javascript|ecmascript/.test(type);
        const src = element.getAttribute("src") ?? "";
        if (
          executable &&
          src.includes("googletagmanager.com/gtag/js") &&
          src.includes(`id=${id}`)
        ) {
          alreadyLoaded = true;
        }
      },
      text(chunk) {
        if (!executable) return;
        scriptText += chunk.text;
        if (!chunk.lastInTextNode) return;
        // An inline config call for this id counts as loaded: the page
        // is already measuring itself.
        const names = scriptText.includes(`'${id}'`) || scriptText.includes(`"${id}"`);
        if (names && /gtag\s*\(\s*['"]config['"]/.test(scriptText)) alreadyLoaded = true;
        scriptText = "";
      }
    })
    .on("body", {
      element(element) {
        element.onEndTag(end => {
          insertOnce(() => end.before(snippet(id), { html: true }));
        });
      }
    })
    .onDocument({
      end(end) {
        // No body element at all (a fragment, or a head-only document):
        // appending still measures the page.
        insertOnce(() => end.append(snippet(id), { html: true }));
      }
    })
    .transform(response);
}
