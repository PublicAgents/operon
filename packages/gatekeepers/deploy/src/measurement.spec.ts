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

  it("loads gtag and configures exactly the given id", () => {
    const tag = measurementSnippet(id);
    expect(tag).toContain(`googletagmanager.com/gtag/js?id=${id}`);
    expect(tag).toContain(`gtag('config','${id}')`);
  });

  it("only ever renders a validated id, so it cannot be broken out of", () => {
    // validMeasurementId is the fence, and the serving path calls it
    // before this: an id that could close the script tag never arrives.
    expect(validMeasurementId("G-A'</script><script>evil()//")).toBeNull();
    expect(measurementSnippet(id)).not.toContain("evil");
  });
});
