// The contract between clients and the engine (0005): zod schemas only, no I/O.

export const packageName = "@dipsaus-orchestrator/contract";

export * from "./catalog";
export * from "./definition";
export * from "./envelope";
export * from "./errors";
export * from "./ids";
export * from "./software";
export * from "./version";

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
  TimerHandle,
} from "./runtime";
