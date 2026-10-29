// Asserts the engine's coarse layers (0004, DIPO-318 AC #7): `dipo/engine-layers` refuses a value
// import from a higher layer (base < domain < composition, listed once in ENGINE_LAYERS in the
// plugin) into a lower one, in every runtime form, lets types cross, and reports a directory that
// is in no layer. The repository's own engine passes with no exception.

import { describe, expect, it } from "bun:test";

import { LINT_TIMEOUT_MS, lintTree } from "./lint-tree";

const RULE = "dipo(engine-layers)";
const ENGINE = "packages/engine/src";

describe("the engine's layers", () => {
  it(
    "refuses a value import up a layer, and a directory in no layer",
    () => {
      const { diagnostics } = lintTree([
        { fixture: "layers-up.ts", target: `${ENGINE}/platform/up.ts` },
        { fixture: "layers-down.ts", target: `${ENGINE}/unlisted/down.ts` },
      ]);
      const hits = (target: string) =>
        diagnostics.filter((d) => d.code === RULE && d.filename === target).length;
      // The domain import and the dynamic import of the composition root; not the type, not the
      // base-layer import.
      expect(hits(`${ENGINE}/platform/up.ts`)).toBe(2);
      expect(hits(`${ENGINE}/unlisted/down.ts`)).toBe(1);
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "lets the domain and the composition root import down and inside their layer",
    () => {
      const { diagnostics } = lintTree([
        { fixture: "layers-down.ts", target: `${ENGINE}/merge/down.ts` },
        { fixture: "layers-down.ts", target: `${ENGINE}/create/down.ts` },
      ]);
      expect(diagnostics.filter((d) => d.code === RULE)).toEqual([]);
    },
    LINT_TIMEOUT_MS,
  );
});
