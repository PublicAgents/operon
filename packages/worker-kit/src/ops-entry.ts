import { WorkerEntrypoint } from "cloudflare:workers";

/**
 * A binding-only operator surface (spec 0003 step 3). Extending this and
 * binding to it by `entrypoint` makes the operator operations reachable
 * ONLY over a private service binding, never a public route: the binding
 * IS the authorization (adding one requires account-level deploy access),
 * so no bearer token exists to leak. The public `fetch` export keeps the
 * agent/container endpoints; the operator endpoints live here.
 */
export abstract class OpsEntrypoint<E = unknown> extends WorkerEntrypoint<E> {
  /** Handle an operator request; no bearer check (the binding is the auth). */
  protected abstract handle(request: Request): Promise<Response>;
  override fetch(request: Request): Promise<Response> {
    return this.handle(request);
  }
}
