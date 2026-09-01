/**
 * Every outbound request this Worker makes (spec 0008 §5).
 *
 * The Worker sets `global_fetch_strictly_public`, so the runtime
 * refuses private and loopback addresses AFTER DNS, which is the part a
 * hostname blocklist cannot do. What is left for us is the part the
 * runtime does not know about: an upstream that answers with a redirect
 * is asking us to send the SAME request, credential included, somewhere
 * else. So redirects are followed by hand, one hop at a time, and the
 * Authorization header is dropped the moment the origin changes.
 */

export class UpstreamError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

const MAX_REDIRECTS = 3;
/** A catalog or tool result larger than this is refused, not truncated. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

function sameOrigin(a: string, b: string): boolean {
  return new URL(a).origin === new URL(b).origin;
}

export interface GuardedFetchOptions {
  fetch?: typeof fetch;
  maxBytes?: number;
}

/**
 * fetch with the redirect chain checked per hop and the response body
 * bounded. Returns the final Response with its body already read into
 * text, because a streamed body cannot be bounded after the fact.
 */
export async function guardedFetch(
  input: string,
  init: RequestInit,
  options: GuardedFetchOptions = {}
): Promise<{ status: number; headers: Headers; text: string }> {
  const doFetch = options.fetch ?? fetch;
  const maxBytes = options.maxBytes ?? MAX_BODY_BYTES;
  const hasBody = init.body !== undefined && init.body !== null;
  let url = input;
  let headers = new Headers(init.headers);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await doFetch(url, { ...init, headers, redirect: "manual" });
    const location = response.headers.get("location");
    const redirected = response.status >= 300 && response.status < 400 && location;
    if (!redirected) {
      const text = await readBounded(response, maxBytes);
      return { status: response.status, headers: response.headers, text };
    }
    const next = new URL(location, url).toString();
    if (!sameOrigin(next, url)) {
      // A cross-origin hop must not carry the request. Stripping the
      // credential is not enough: for an MCP call the BODY is the
      // secret-adjacent part, carrying the tool name and its arguments,
      // and 301/302/303 would replay it (or, followed as fetch would,
      // silently turn a tool call into a GET). There is no legitimate
      // reason for an MCP endpoint to bounce a call to another origin,
      // so refuse rather than guess which of those is meant.
      if (hasBody) {
        throw new UpstreamError(
          "mcp_upstream_unreachable",
          "upstream redirected a request body to another origin"
        );
      }
      headers = new Headers(headers);
      headers.delete("authorization");
      headers.delete("cf-access-client-id");
      headers.delete("cf-access-client-secret");
    }
    url = next;
  }
  throw new UpstreamError("mcp_upstream_unreachable", "too many redirects");
}

/**
 * Read the body while counting bytes, and stop the moment the bound is
 * crossed. Checking after `text()` would mean an upstream that omits or
 * lies about content-length gets the whole thing buffered first, which
 * is the memory exhaustion the bound exists to prevent.
 */
async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    throw new UpstreamError("mcp_upstream_unreachable", `upstream body exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        // Cancel rather than drain: the rest of an oversized body is
        // bandwidth we have already decided not to accept.
        await reader.cancel().catch(() => undefined);
        throw new UpstreamError(
          "mcp_upstream_unreachable",
          `upstream body exceeds ${maxBytes} bytes`
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}
