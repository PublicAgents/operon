import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import { handleWebUpgrade } from "./web-relay.js";

function fakeRequest(pathname: string, headers: Record<string, string>): IncomingMessage {
  return { url: pathname, headers } as unknown as IncomingMessage;
}

/** Capture what the relay wrote to the client socket before destroying it. */
function collectingSocket() {
  const socket = new PassThrough();
  let written = "";
  socket.on("data", chunk => {
    written += chunk.toString();
  });
  return { socket, read: () => written };
}

describe("web relay upgrade handling", () => {
  const wired = { webUrl: "http://web.operon.internal", webToken: "nonce-123" };

  it("declines non-web paths so the caller can 404 them", () => {
    const { socket } = collectingSocket();
    const took = handleWebUpgrade(
      fakeRequest("/notify", { "x-operon-porch": "1" }),
      socket,
      Buffer.alloc(0),
      wired
    );
    expect(took).toBe(false);
  });

  it("refuses a web upgrade without the porch header (CSRF fence)", () => {
    const { socket, read } = collectingSocket();
    const took = handleWebUpgrade(
      fakeRequest("/web/session/research", {}),
      socket,
      Buffer.alloc(0),
      wired
    );
    expect(took).toBe(true);
    expect(read()).toContain("403");
    expect(read()).toContain("porch_header_missing");
  });

  it("refuses when the web door is not wired", () => {
    const { socket, read } = collectingSocket();
    const took = handleWebUpgrade(
      fakeRequest("/web/session/research", { "x-operon-porch": "1" }),
      socket,
      Buffer.alloc(0),
      {}
    );
    expect(took).toBe(true);
    expect(read()).toContain("503");
    expect(read()).toContain("web_not_wired");
  });

  it("rejects a malformed session name as a non-web path", () => {
    const { socket } = collectingSocket();
    const took = handleWebUpgrade(
      fakeRequest("/web/session/Bad_Name", { "x-operon-porch": "1" }),
      socket,
      Buffer.alloc(0),
      wired
    );
    expect(took).toBe(false);
  });
});
