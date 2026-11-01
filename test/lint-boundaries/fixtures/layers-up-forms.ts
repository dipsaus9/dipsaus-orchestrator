// Fixture: placed in gate/ (0004, DIPO-395), one layer below prompts/. Every form that loads a
// value from prompts/ is refused: static, `export ... from`, `export * from`, the barrel, a
// side-effect import, `import()`, `require`, `import.meta.require` and `import x = require()`.
// The type-only forms cross.
import { a } from "../prompts/a";
import { d } from "../prompts";
import "../prompts/side";
import h = require("../prompts/h");
import type { T } from "../prompts/t";

export { b } from "../prompts/b";
export * from "../prompts/c";
export type { U } from "../prompts/u";
export type * from "../prompts/v";

export const lazy = () => import("../prompts/e");
export const required: unknown = require("../prompts/f");
export const metaRequired: unknown = import.meta.require("../prompts/g");
export const used: unknown[] = [a, d, h];
export type Used = T | typeof import("../prompts/w");
