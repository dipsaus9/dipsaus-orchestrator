// Fixture: a package that may not import the engine is refused in every runtime form too, a
// dynamic import, `require` and `import.meta.require` (0004, DIPO-318).
export const lazy = () => import("@dipsaus-orchestrator/engine");
export const required: unknown = require("@dipsaus-orchestrator/engine");
export const metaRequired: unknown = import.meta.require("@dipsaus-orchestrator/engine");
