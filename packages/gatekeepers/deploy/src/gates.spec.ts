import { describe, expect, it } from "vitest";
import { parseRoster } from "@operon/core";
import { hostLabel, storagePath, validatePublish, type PublishRequest } from "./gates.js";

const roster = parseRoster(
  JSON.stringify({
    zone: "example-colony.com",
    agents: [
      {
        id: "growth",
        stateRepo: "org/growth-state",
        cadence: "0 6 * * *",
        harness: "claude-code",
        model: "claude-sonnet-5",
        hosts: ["@", "growth"],
        enabled: true
      }
    ]
  })
);

function html(content: string): string {
  return Buffer.from(content).toString("base64");
}

function request(overrides: Partial<PublishRequest> = {}): PublishRequest {
  return {
    agentId: "growth",
    host: "@",
    files: [
      {
        path: "index.html",
        contentType: "text/html; charset=utf-8",
        contentBase64: html("<p>run by an autonomous agent</p>")
      }
    ],
    ...overrides
  };
}

const MARKER = "autonomous agent";

describe("validatePublish", () => {
  it("accepts a disclosed page on an assigned host", () => {
    expect(validatePublish(roster, request(), MARKER, [])).toBeNull();
  });

  it("rejects unknown agents and unassigned hosts", () => {
    expect(validatePublish(roster, request({ agentId: "ghost" }), MARKER, [])?.code).toBe(
      "unknown_agent"
    );
    expect(validatePublish(roster, request({ host: "other" }), MARKER, [])?.code).toBe(
      "host_not_assigned"
    );
  });

  it("rejects HTML without the disclosure marker", () => {
    const bare = request({
      files: [
        { path: "index.html", contentType: "text/html", contentBase64: html("<p>hi</p>") }
      ]
    });
    expect(validatePublish(roster, bare, MARKER, [])?.code).toBe("missing_disclosure");
  });

  it("does not require the marker on non-HTML files", () => {
    const css = request({
      files: [{ path: "a.css", contentType: "text/css", contentBase64: html("body{}") }]
    });
    expect(validatePublish(roster, css, MARKER, [])).toBeNull();
  });

  it("rejects denylisted literals in any text file", () => {
    const leaky = request({
      files: [
        {
          path: "notes.txt",
          contentType: "text/plain",
          contentBase64: html("chat id 123456789")
        }
      ]
    });
    expect(validatePublish(roster, leaky, MARKER, ["123456789"])?.code).toBe(
      "denylisted_content"
    );
  });

  it("rejects traversal and absolute paths, duplicates, and bad base64", () => {
    expect(
      validatePublish(roster, request({ files: [{ path: "../x", contentType: "text/plain", contentBase64: html("x") }] }), MARKER, [])
        ?.code
    ).toBe("invalid_path");
    expect(
      validatePublish(roster, request({ files: [{ path: "/abs", contentType: "text/plain", contentBase64: html("x") }] }), MARKER, [])
        ?.code
    ).toBe("invalid_path");
    const duplicate = request();
    duplicate.files.push({ ...duplicate.files[0] });
    expect(validatePublish(roster, duplicate, MARKER, [])?.code).toBe("duplicate_path");
    expect(
      validatePublish(roster, request({ files: [{ path: "a.txt", contentType: "text/plain", contentBase64: "%%%" }] }), MARKER, [])
        ?.code
    ).toBe("invalid_base64");
  });

  it("rejects an empty publish", () => {
    expect(validatePublish(roster, request({ files: [] }), MARKER, [])?.code).toBe("no_files");
  });
});

describe("hostLabel", () => {
  it("maps apex, subdomains, and rejects foreign or nested hosts", () => {
    expect(hostLabel("example-colony.com", "example-colony.com")).toBe("@");
    expect(hostLabel("example-colony.com", "growth.example-colony.com")).toBe("growth");
    expect(hostLabel("example-colony.com", "a.b.example-colony.com")).toBeNull();
    expect(hostLabel("example-colony.com", "evil.com")).toBeNull();
  });
});

describe("storagePath", () => {
  it("maps request paths to stored paths", () => {
    expect(storagePath("/")).toBe("index.html");
    expect(storagePath("/about/")).toBe("about/index.html");
    expect(storagePath("/a.css")).toBe("a.css");
  });
});
