export { ENV, readWakeConfig, ConfigError, type WakeConfig } from "./config.js";
export {
  adapters,
  getAdapter,
  assertEnvClean,
  claudeCode,
  codex,
  EnvNotCleanError,
  AdapterNotImplementedError,
  UnknownHarnessError,
  type HarnessAdapter,
  type CommandSpec
} from "./adapters/index.js";
export {
  verifyPresleep,
  maskSecret,
  JOURNAL_PATH,
  type ChangedFile,
  type PresleepResult,
  type PresleepFailure
} from "./presleep.js";
export { runCapture, runStreaming, CommandError } from "./exec.js";
export { stageAndCollect } from "./staging.js";
export {
  runGitleaks,
  parseReport,
  type GitleaksFinding,
  type GitleaksOptions
} from "./gitleaks.js";
