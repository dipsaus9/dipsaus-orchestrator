// The dependency chain (DIPO-460): the engine reads the graph of the waiting stories and sends it
// as levels, so the Floor's UP NEXT sentence, the Queue's CHAIN picture, its "everything below N"
// line and the state behind a `needs N` are never derived in a client (0001, 0009).

import {
  type ChainNode,
  type ChainRow,
  type ChainState,
  officeChain,
  StoryId,
  type StoryView,
} from "@dipsaus-orchestrator/contract";
import type { z } from "zod";

import type { FeatureRegistry, ReadContext } from "../commands/registry";
import { activeStoryViews } from "../views/story";

/** The state a story has as a dependency: Ready, running and in review stories move by themselves. */
function stateOf(view: StoryView | undefined): ChainState {
  if (view === undefined) return "waiting";
  if (view.column === "desk") return "parked";
  return view.column === "ready" || view.column === "running" || view.column === "review"
    ? "moving"
    : "waiting";
}

/** The number in a story id, for ordering: `DIPO-447` is 447; an id without one sorts last. */
function numberOf(id: string): number {
  const found = /(\d+)$/.exec(id);
  return found === null ? Number.MAX_SAFE_INTEGER : Number(found[1]);
}

function byNumber(a: string, b: string): number {
  return numberOf(a) - numberOf(b) || a.localeCompare(b);
}

/**
 * The chain of `stories`: every story with a dependency that is not Done joins one row with the
 * stories it waits on, rows being the connected pieces of that graph.
 */
export function chainOf(stories: readonly StoryView[]): z.output<typeof officeChain.result> {
  const byId = new Map(stories.map((view) => [String(view.story), view]));
  const waiting = stories.filter(
    (view) => view.column === "waiting" && (view.waitingOn ?? []).length > 0,
  );
  const needs = new Map<string, string[]>(
    waiting.map((view) => [String(view.story), (view.waitingOn ?? []).map(String)]),
  );
  // The pieces: union of each waiting story with what it waits on.
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const up = parent.get(id) ?? id;
    if (up === id) return id;
    const root = find(up);
    parent.set(id, root);
    return root;
  };
  for (const [id, deps] of needs) {
    for (const dep of deps) parent.set(find(dep), find(id));
  }
  const members = new Map<string, Set<string>>();
  for (const [id, deps] of needs) {
    for (const member of [id, ...deps]) {
      const root = find(member);
      members.set(root, (members.get(root) ?? new Set()).add(member));
    }
  }
  // A level is one more than the deepest story the story waits on; a cycle counts as level 0.
  const depth = (id: string, seen: ReadonlySet<string>): number => {
    const deps = needs.get(id)?.filter((dep) => !seen.has(dep)) ?? [];
    if (deps.length === 0) return 0;
    return 1 + Math.max(...deps.map((dep) => depth(dep, new Set([...seen, id]))));
  };
  const rows: ChainRow[] = [...members.values()].map((ids) => {
    const levels: StoryId[][] = [];
    for (const id of [...ids].toSorted(byNumber)) {
      const level = depth(id, new Set());
      (levels[level] ??= []).push(StoryId.parse(id));
    }
    const parked = levels.flat().find((id) => stateOf(byId.get(id)) === "parked");
    return { levels, ...(parked === undefined ? {} : { parked }) };
  });
  rows.sort(
    (a, b) =>
      Number(b.parked !== undefined) - Number(a.parked !== undefined) ||
      byNumber(String(a.levels[0]?.[0]), String(b.levels[0]?.[0])),
  );
  // A story the index has no view of is in a row but has no node: it counts as waiting.
  const nodes = rows.flatMap((row) =>
    row.levels.flat().flatMap((id): ChainNode[] => {
      const view = byId.get(id);
      if (view === undefined) return [];
      return [
        {
          story: view.story,
          key: view.key,
          state: stateOf(view),
          unblocks: waiting
            .filter((other) => needs.get(String(other.story))?.includes(id))
            .map((other) => other.story)
            .toSorted(byNumber),
        },
      ];
    }),
  );
  return { rows, nodes };
}

/** Registers `office.chain`; `overview/feature.ts` calls it. */
export function registerChain(registry: FeatureRegistry): void {
  registry.addRead({
    definition: officeChain,
    handle: (ctx: ReadContext) => {
      if (ctx.office === undefined) throw new Error("office.chain runs with its office");
      return chainOf(activeStoryViews(ctx.office));
    },
  });
}
