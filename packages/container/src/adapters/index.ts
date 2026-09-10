import { claudeCode } from "./claude-code.js";
import { codex } from "./codex.js";
import { grok } from "./grok.js";
import type { HarnessAdapter } from "./types.js";

export const adapters: Record<string, HarnessAdapter> = {
  [claudeCode.id]: claudeCode,
  [codex.id]: codex,
  [grok.id]: grok
};

export class UnknownHarnessError extends Error {
  override name = "UnknownHarnessError";
  constructor(harness: string) {
    super(
      `unknown_harness: "${harness}" has no adapter; known: ${Object.keys(adapters).join(", ")}`
    );
  }
}

export function getAdapter(harness: string): HarnessAdapter {
  const adapter = adapters[harness];
  if (!adapter) throw new UnknownHarnessError(harness);
  return adapter;
}

export {
  assertEnvClean,
  EnvNotCleanError,
  AdapterNotImplementedError,
  CredentialShapeError,
  type HarnessAdapter,
  type CommandSpec,
  type StageInput,
  type StagedHarness,
  type StagedFile
} from "./types.js";
export { claudeCode } from "./claude-code.js";
export { codex } from "./codex.js";
export { grok } from "./grok.js";
