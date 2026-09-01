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
      // A cross-origin hop must not carry the credential. The request
      // may still be legitimate, so follow it stripped rather than
      // refusing: an upstream that needs auth there will say so.
      headers = new Headers(headers);
      headers.delete("authorization");
      headers.delete("cf-access-client-id");
      headers.delete("cf-access-client-secret");
    }
    // A 307/308 replays the body; anything else becomes a GET, which is
    // what fetch would do, and replaying a tool call cross-origin is
    // not something we do at all.
    if ((response.status === 307 || response.status === 308) && !sameOrigin(next, url)) {
      throw new UpstreamError(
        "mcp_upstream_unreachable",
        "upstream redirected a request body to another origin"
      );
    }
    url = next;
  }
  throw new UpstreamError("mcp_upstream_unreachable", "too many redirects");
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    throw new UpstreamError("mcp_upstream_unreachable", `upstream body exceeds ${maxBytes} bytes`);
  }
  const text = await response.text();
  // Bytes, not characters: a multibyte body can pass a length check it
  // should fail.
  if (new TextEncoder().encode(text).length > maxBytes) {
    throw new UpstreamError("mcp_upstream_unreachable", `upstream body exceeds ${maxBytes} bytes`);
  }
  return text;
}
