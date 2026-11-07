// `office.retro` (DIPO-453): the numbers are counted in `records/retro.ts`, so a planning session
// can be given the same lines.

import { officeRetro } from "@dipsaus-orchestrator/contract";

import type { FeatureRegistry, ReadContext } from "../commands/registry";
import { retro } from "../records/retro";

/** Registers `office.retro`; `overview/feature.ts` calls it. */
export function registerRetro(registry: FeatureRegistry): void {
  registry.addRead({
    definition: officeRetro,
    handle: (ctx: ReadContext) => {
      if (ctx.office === undefined) throw new Error("office.retro runs with its office");
      return retro(ctx.office);
    },
  });
}
