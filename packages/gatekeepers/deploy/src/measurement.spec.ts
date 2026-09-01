import { describe, expect, it } from "vitest";
import { measurementSnippet, validMeasurementId } from "./measurement.js";

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

describe("measurementSnippet", () => {
  const id = "G-ABC1234567";

  it("configures exactly the given id and loads gtag for it", () => {
    const tag = measurementSnippet(id);
    expect(tag).toContain(`gtag('config','${id}')`);
    expect(tag).toContain(`googletagmanager.com/gtag/js?id=${id}`);
  });

  it("does nothing when the page already configured that id", () => {
    // The guard the whole design rests on: whether a page measures
    // itself is decided from window.dataLayer at runtime, which is true
    // however the page's own tag was written.
    expect(measurementSnippet(id)).toContain("a[0]==='config'");
    expect(measurementSnippet(id)).toContain(`a[1]==='${id}'`);
  });

  it("does nothing twice, so a second copy of itself is harmless", () => {
    expect(measurementSnippet(id)).toContain("if(window.__operonGa)return");
  });

  it("only ever renders a validated id, so it cannot be broken out of", () => {
    expect(validMeasurementId("G-A'</script><script>evil()//")).toBeNull();
    expect(measurementSnippet(id)).not.toContain("evil");
  });
});
