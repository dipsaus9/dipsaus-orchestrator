// The contract between clients and the engine (0005): zod schemas and the rules both sides share,
// such as the runtime layout; no I/O.

export const packageName = "@dipsaus-orchestrator/contract";

export * from "./catalog";
export * from "./clean-text";
export * from "./config";
export * from "./config-keys";
export * from "./definition";
export * from "./envelope";
export * from "./errors";
export * from "./fieldblock";
export * from "./ids";
export * from "./office";
export * from "./profile";
export * from "./git-hardening";
export * from "./repository";
export * from "./runtime-layout";
export * from "./software";
export * from "./work";

export type {
  ChildExit,
  ChildProcess,
  ChildStdin,
  Clock,
  IdPrefix,
  IdSource,
  Signal,
  Spawn,
  SpawnOptions,
  SpawnOutputFile,
  TimerHandle,
} from "./runtime";
