/**
 * The transport-neutral channel logic lives in worker-kit (spec 0005 §5:
 * Telegram is one optional transport over the channel, a UI/API is
 * another). This re-export keeps the package's existing import paths and
 * public surface unchanged.
 */
export {
  CONTEXT_WINDOW,
  HARD_RETENTION,
  RETENTION,
  concernsAgent,
  effectiveCursors,
  prunableIds,
  transcriptFor,
  type AgentTranscript,
  type ChannelEntry
} from "@operon/worker-kit";
