/**
 * The harness adapter contract (chassis spec 4.1). An adapter knows how to
 * invoke one headless CLI coding agent; everything else in the wake
 * lifecycle is harness-independent.
 */

export interface CommandSpec {
  command: string;
  args: string[];
  /** Extra environment beyond the minimal base; the credential lands here. */
  env: Record<string, string>;
}

export interface HarnessAdapter {
  id: string;
  /**
   * Variables that must NOT be present when this harness runs; each entry
   * names a way the harness would silently switch auth or endpoint.
   */
  forbiddenEnv: string[];
  /** The variable this harness reads its credential from. */
  credentialEnv: string;
  /** A cheap invocation whose stdout names the model that actually answered. */
  probe(model: string, credential: string): CommandSpec;
  /** The wake session itself. */
  session(
    prompt: string,
    model: string,
    credential: string,
    fallbackModel?: string
  ): CommandSpec;
}

export class EnvNotCleanError extends Error {
  override name = "EnvNotCleanError";
  constructor(adapterId: string, variable: string) {
    super(
      `env_not_clean: ${variable} is set; the ${adapterId} harness would silently prefer it over the injected credential. Unset it in the image and the wake environment.`
    );
  }
}

export class AdapterNotImplementedError extends Error {
  override name = "AdapterNotImplementedError";
  constructor(adapterId: string) {
    super(
      `adapter_not_implemented: "${adapterId}" is specified but not implemented yet; see the chassis spec's harness adapter order`
    );
  }
}

export function assertEnvClean(
  adapter: HarnessAdapter,
  env: Record<string, string | undefined>
): void {
  for (const variable of adapter.forbiddenEnv) {
    if (env[variable] !== undefined) throw new EnvNotCleanError(adapter.id, variable);
  }
}
