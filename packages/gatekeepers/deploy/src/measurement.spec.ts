import { describe, expect, it } from "vitest";
import { injectMeasurement, validMeasurementId } from "./measurement.js";

describe("validMeasurementId", () => {
  it("accepts a GA4 measurement id and refuses anything else", () => {
    expect(validMeasurementId("G-ABC1234567")).toBe("G-ABC1234567");
    expect(validMeasurementId("  G-ABCD1234  ")).toBe("G-ABCD1234");
    expect(validMeasurementId(undefined)).toBeNull();
    expect(validMeasurementId("")).toBeNull();
    expect(validMeasurementId("UA-12345-1")).toBeNull();
    // Nothing that could close the script tag it lands in.
    expect(validMeasurementId("G-A'</script><script>evil()//")).toBeNull();
  });
});

describe("injectMeasurement", () => {
  const id = "G-ABC1234567";

  it("puts the base tag just before </head>", () => {
    const html = injectMeasurement("<html><head><title>x</title></head><body>hi</body></html>", id);
    expect(html).toContain(`gtag/js?id=${id}`);
    expect(html.indexOf("gtag/js")).toBeLessThan(html.indexOf("</head>"));
    expect(html).toContain("</head><body>hi</body>");
  });

  it("falls back to </body> for a page with no head", () => {
    const html = injectMeasurement("<body>hi</body>", id);
    expect(html.indexOf("gtag/js")).toBeLessThan(html.indexOf("</body>"));
  });

  it("appends to a fragment rather than refusing to serve it", () => {
    expect(injectMeasurement("<p>hi</p>", id)).toContain("gtag/js");
  });

  it("leaves a page that already LOADS the tag alone", () => {
    // An agent that hand-rolled its own tag would otherwise
    // double-count every visit, silently halving its own numbers.
    const loader = `<html><head><script src="https://www.googletagmanager.com/gtag/js?id=${id}"></script></head><body></body></html>`;
    expect(injectMeasurement(loader, id)).toBe(loader);
    const config = `<html><head><script>gtag('config', '${id}');</script></head><body></body></html>`;
    expect(injectMeasurement(config, id)).toBe(config);
  });

  it("still tags a page that only MENTIONS the id", () => {
    // Prose, a comment, or a dataLayer push is not a loader; treating
    // one as a loader would serve that page untagged forever.
    const mentions = `<html><head><!-- analytics ${id} pending --></head><body>our id is ${id}</body></html>`;
    expect(injectMeasurement(mentions, id)).toContain("gtag/js?id=");
  });

  it("is case-insensitive about the closing tag", () => {
    expect(injectMeasurement("<HTML><HEAD></HEAD></HTML>", id)).toContain("gtag/js");
    expect(injectMeasurement("<html><head></HEAD ></html>", id)).toContain("gtag/js");
  });
});
