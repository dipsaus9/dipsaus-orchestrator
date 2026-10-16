export const packageName = "@dipsaus-orchestrator/tui";

export { checkInk, INK_SELF_CHECK_NAME } from "./self-check";
export { isRawModeSupported, NO_TTY_MESSAGE, runTui } from "./run";
export type { TuiDeps, TuiSession, TuiStreams } from "./run";
export { markerRule } from "./output";
