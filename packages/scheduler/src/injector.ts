import { WorkerEntrypoint } from "cloudflare:workers";
import { HARNESS_CREDENTIAL_INJECTION } from "@operon/core";
import { injectHeaders, mindCredentialVar } from "./inject-headers.js";

/**
 * The egress credential injector (spec 0003 phase 2): attached to the
 * wake container's outbound HTTPS for the harness's API hosts via
 * ctx.container.interceptOutboundHttps. Runs in the Workers runtime on
 * the same machine, OUTSIDE the container sandbox, holding the real mind
 * credential from the scheduler env; the container only ever sees the
 * placeholder. Requests to any other host never reach this.
 */
export class MindCredentialInjector extends WorkerEntrypoint<Record<string, unknown>> {
  override async fetch(request: Request): Promise<Response> {
    const host = new URL(request.url).hostname;
    const credentials: Record<string, string | undefined> = {};
    for (const harness of Object.keys(HARNESS_CREDENTIAL_INJECTION)) {
      const value = this.env[mindCredentialVar(harness)];
      if (typeof value === "string" && value.length > 0) credentials[harness] = value;
    }
    const headers = injectHeaders(new Headers(request.headers), host, credentials);
    return fetch(new Request(request, { headers }));
  }
}

export { injectHeaders } from "./inject-headers.js";
