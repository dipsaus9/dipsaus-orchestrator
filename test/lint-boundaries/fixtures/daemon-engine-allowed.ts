// Fixture: what the daemon may import from the engine (0004, DIPO-318): `createEngine`, types, in
// any form, and the platform entry.
import { createEngine, type Engine } from "@dipsaus-orchestrator/engine";
import type { EngineDeps } from "@dipsaus-orchestrator/engine";
import { systemSpawn, type HeldLock } from "@dipsaus-orchestrator/engine/platform";

export type { Logger } from "@dipsaus-orchestrator/engine";
export { type WorkerPort } from "@dipsaus-orchestrator/engine";
export type EngineEntry = typeof import("@dipsaus-orchestrator/engine");
export const lazy = () => import("@dipsaus-orchestrator/engine/platform");
export const leaked: [typeof createEngine, typeof systemSpawn] = [createEngine, systemSpawn];
export type Used = [Engine, EngineDeps, HeldLock];
