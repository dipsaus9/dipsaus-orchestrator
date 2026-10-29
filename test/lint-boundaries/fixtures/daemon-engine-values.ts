// Fixture: the daemon imports from the engine only `createEngine`, types and the platform entry
// (0004, DIPO-318), so every other form of an import of the engine entry is reported: a value next
// to `createEngine`, a namespace, a default, a value re-export, `export *`, `import x = require`,
// a dynamic import and `require`.
import { createEngine, openStateDatabase } from "@dipsaus-orchestrator/engine";
import * as engine from "@dipsaus-orchestrator/engine";
import engineDefault from "@dipsaus-orchestrator/engine";
import entry = require("@dipsaus-orchestrator/engine");

export { engineSurface } from "@dipsaus-orchestrator/engine";
export * from "@dipsaus-orchestrator/engine";
export const lazy = () => import("@dipsaus-orchestrator/engine");
export const required: unknown = require("@dipsaus-orchestrator/engine");
export const leaked: unknown[] = [createEngine, openStateDatabase, engine, engineDefault, entry];
