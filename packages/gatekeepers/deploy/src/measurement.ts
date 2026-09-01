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

/**
 * The tag, guarded at RUNTIME rather than by inspecting the page.
 *
 * Whether a page already measures itself cannot be decided from its
 * source: an id can arrive through a template literal, a variable, or
 * another script entirely, and each attempt to detect it by reading the
 * HTML traded one wrong answer for another (serve an untagged page, or
 * double-count every visit). The page's own state answers it exactly:
 * the standard GA snippet pushes ["config", id] into window.dataLayer
 * synchronously, so a tag that looks there knows what actually
 * happened, whatever the source looked like.
 *
 * So this always goes in, and decides in the browser. Idempotent twice
 * over: it also marks the window, so two copies of itself do nothing.
 */
function snippet(id: string): string {
  return (
    `<script>(function(){` +
    `if(window.__operonGa)return;window.__operonGa=1;` +
    `var d=window.dataLayer=window.dataLayer||[];` +
    // A page that already configured this id measures itself; adding a
    // second loader would report every visit twice.
    `for(var i=0;i<d.length;i++){var a=d[i];` +
    `if(a&&a[0]==='config'&&a[1]==='${id}')return;}` +
    `function gtag(){d.push(arguments);}` +
    `gtag('js',new Date());gtag('config','${id}');` +
    `var s=document.createElement('script');s.async=1;` +
    `s.src='https://www.googletagmanager.com/gtag/js?id=${id}';` +
    `document.head.appendChild(s);` +
    `})();</script>`
  );
}

/**
 * The tag, as HTML. Only the id varies, and it is validated against a
 * strict pattern before it reaches here, so nothing in it can close the
 * script element.
 */
export function measurementSnippet(id: string): string {
  return snippet(id);
}

/**
 * Insert the tag at the end of one HTML response.
 *
 * HTMLRewriter rather than string surgery because it streams instead of
 * buffering the body, and because it knows where a document actually
 * ends: a body-only page and a bare fragment both get measured, not
 * only pages carrying a literal </head>. There is no detection pass
 * here at all any more; the snippet decides for itself once the page is
 * running, which is the only place the question has a true answer.
 */
export function injectMeasurementResponse(response: Response, id: string): Response {
  let inserted = false;
  return new HTMLRewriter()
    .on("body", {
      element(element) {
        element.onEndTag(end => {
          if (inserted) return;
          inserted = true;
          end.before(snippet(id), { html: true });
        });
      }
    })
    .onDocument({
      end(end) {
        // No body element at all (a fragment, or a head-only document).
        if (inserted) return;
        inserted = true;
        end.append(snippet(id), { html: true });
      }
    })
    .transform(response);
}
