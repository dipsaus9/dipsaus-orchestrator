// Fixture: a package that may not import the engine is refused in every form (0004, DIPO-318): a
// dynamic import, `require`, `import.meta.require`, a type-only import, a re-export,
// `import x = require` and `typeof import`.
import type { Engine } from "@dipsaus-orchestrator/engine";
import entry = require("@dipsaus-orchestrator/engine");

export { packageName } from "@dipsaus-orchestrator/engine";
export const lazy = () => import("@dipsaus-orchestrator/engine");
export const required: unknown = require("@dipsaus-orchestrator/engine");
export const metaRequired: unknown = import.meta.require("@dipsaus-orchestrator/engine");
export type EngineEntry = typeof import("@dipsaus-orchestrator/engine");
export type Used = [Engine, typeof entry];
