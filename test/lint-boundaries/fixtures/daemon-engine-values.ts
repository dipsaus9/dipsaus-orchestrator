// Fixture: the daemon imports from the engine only `createEngine`, types and the platform entry
// (0004, DIPO-318), so every other form of an import of the engine entry is reported: a value next
// to `createEngine`, a side effect, a namespace, a default, a value re-export, `export *`,
// `import x = require`, a dynamic import, `require` and `import.meta.require`. A relative path into
// the engine package is reported in every form, a type-only import included. The paths resolve
// from daemon/src/.
import "@dipsaus-orchestrator/engine";
import { createEngine, openStateDatabase } from "@dipsaus-orchestrator/engine";
import * as engine from "@dipsaus-orchestrator/engine";
import engineDefault from "@dipsaus-orchestrator/engine";
import entry = require("@dipsaus-orchestrator/engine");
import { engineSurface as deepSurface } from "../../engine/src/create/surface";
import type { Engine as DeepEngine } from "../../engine/src/create/deps";

export { engineSurface } from "@dipsaus-orchestrator/engine";
export * from "@dipsaus-orchestrator/engine";
export const lazy = () => import("@dipsaus-orchestrator/engine");
export const required: unknown = require("@dipsaus-orchestrator/engine");
export const metaRequired: unknown = import.meta.require("@dipsaus-orchestrator/engine");
export const leaked: unknown[] = [
  createEngine,
  openStateDatabase,
  engine,
  engineDefault,
  entry,
  deepSurface,
];
export type Deep = DeepEngine;
