// Running the providers for one story (0014 section 9): the default provider always runs first;
// an optional backend fills the rest of the `context` budget. A backend that is not `ready` after
// one `prepare` is skipped, and the pack's provenance says why; the run continues on the default.

import { itemCostOf } from "./default-provider";
import type { ContextPack, ContextProvider, ContextRequest, Workspace } from "./types";

export interface GatherContextOptions {
  readonly workspace: Workspace;
  readonly defaultProvider: ContextProvider;
  readonly backend?: ContextProvider;
  readonly request: ContextRequest;
  /** The `context` section budget in characters. */
  readonly budget: number;
}

export async function gatherContext(options: GatherContextOptions): Promise<ContextPack> {
  const { workspace, backend, request, budget } = options;
  const base = await options.defaultProvider.gather(request, budget);
  if (backend === undefined) return base;
  const note = (text: string): ContextPack => ({
    ...base,
    provenance: { ...base.provenance, notes: [...base.provenance.notes, text] },
  });
  let status = await backend.status(workspace);
  if (status.state !== "ready" && backend.prepare !== undefined) {
    await backend.prepare(workspace);
    status = await backend.status(workspace);
  }
  if (status.state !== "ready") {
    const why = status.reasons.length > 0 ? `: ${status.reasons.join("; ")}` : "";
    return note(`backend ${backend.id} skipped, ${status.state}${why}`);
  }
  const room = budget - base.usedChars;
  if (room <= 0) return note(`backend ${backend.id} skipped, no context budget left`);
  const extra = await backend.gather(request, room);
  const seen = new Set(base.items.map((item) => item.path));
  const items = [...base.items];
  let used = base.usedChars;
  let truncated = base.truncated || extra.truncated;
  for (const item of extra.items) {
    if (seen.has(item.path)) continue;
    const cost = itemCostOf(item);
    if (used + cost > budget) {
      truncated = true;
      continue;
    }
    items.push(item);
    used += cost;
  }
  return {
    ...base,
    items,
    usedChars: used,
    truncated,
    provenance: {
      ...base.provenance,
      staleFiles: [
        ...new Set([...base.provenance.staleFiles, ...extra.provenance.staleFiles]),
      ].toSorted(),
      notes: [
        ...base.provenance.notes,
        `backend ${extra.provenance.provider} ${extra.provenance.version}, ${extra.provenance.indexState}`,
        ...extra.provenance.notes,
      ],
    },
  };
}
