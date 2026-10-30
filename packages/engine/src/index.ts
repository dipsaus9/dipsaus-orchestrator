// The engine entry (0004, 0005, DIPO-318): `createEngine`, the engine's surface and the types of its
// ports. The daemon imports from here only `createEngine` and types, and its process pieces from
// the platform entry (`@dipsaus-orchestrator/engine/platform`); `dipo/daemon-engine-imports` checks
// it.

export const packageName = "@dipsaus-orchestrator/engine";

// The one factory and the engine it gives (0005).
export { createEngine } from "./create/create-engine";
export type { DaemonFacts, Engine, EngineDeps, EnginePaths } from "./create/deps";
export type { EngineSurface, OfficePage, Subscribed } from "./create/surface";
export type { DrainCaps, DrainRequest, DrainResult } from "./create/drain";
export type { RecoveryContext, RecoveryStep } from "./create/recovery";

// The types of the engine's ports.
export type { FeatureModule, FeatureRegistry } from "./commands/registry";
export type { Logger, LogFields } from "./log/logger";
export type { ProcessProbe } from "./platform/process";
export type { CodeHost } from "./platform/host";
export type { StoryStore } from "./story-store/store";
export type { BoxPort } from "./box/port";
export type { StartForwarder } from "./box/forwarder";
export type { ListenHttp } from "./box/model-proxy";
export type { TestBoxesDeps } from "./box/test-box";
export type { HostStarter } from "./run/launch";
export type { Presence } from "./run/live-question";
export type { PreparedWorker, RunLaunchPaths, SessionFacts, WorkerPort } from "./workers/port";
export type { LaunchPlan, WorkerSpec } from "./workers/types";
