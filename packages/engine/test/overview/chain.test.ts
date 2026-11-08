// The dependency chain (DIPO-460): `chainOf` turns the waiting stories into levels and the state
// every dependency has, so a client shows `needs 447✗`, `needs 452→` or a bare `needs 449`
// without deriving anything.

import { describe, expect, it } from "bun:test";

import {
  type QueueColumn,
  StoryId,
  StoryKey,
  type StoryView,
} from "@dipsaus-orchestrator/contract";

import { chainOf } from "../../src/overview/chain";

const id = (n: number) => StoryId.parse(`DIPO-${n}`);

function story(n: number, column: QueueColumn, waitingOn: number[] = []): StoryView {
  return {
    key: StoryKey.parse(`sto_01J9ZK5Q8W3V4X6Y7Z${String(n).padStart(8, "0")}`),
    story: StoryId.parse(`DIPO-${n}`),
    provisional: false,
    title: `Story ${n}`,
    lifecycle: "Ready",
    column,
    ...(waitingOn.length === 0 ? {} : { waitingOn: waitingOn.map(id) }),
  } as StoryView;
}

describe("chainOf", () => {
  const stories = [
    story(447, "desk"),
    story(448, "waiting", [447]),
    story(449, "waiting", [447]),
    story(450, "waiting", [449]),
    story(451, "waiting", [450]),
    story(452, "ready"),
    story(453, "waiting", [452]),
    story(460, "ready"),
  ];

  it("sends the pieces as levels, the parked piece first, with the parked story named", () => {
    const { rows } = chainOf(stories);
    expect(rows).toEqual([
      {
        levels: [[id(447)], [id(448), id(449)], [id(450)], [id(451)]],
        parked: id(447),
      },
      { levels: [[id(452)], [id(453)]] },
    ]);
  });

  it("gives each story its state and the stories that wait on it, none for a lone Ready story", () => {
    const { nodes } = chainOf(stories);
    const of = (name: string) => nodes.find((node) => node.story === name);
    expect(of("DIPO-447")).toMatchObject({ state: "parked", unblocks: [id(448), id(449)] });
    expect(of("DIPO-452")).toMatchObject({ state: "moving", unblocks: [id(453)] });
    // A bare `needs 449`: the dependency is itself waiting.
    expect(of("DIPO-449")).toMatchObject({ state: "waiting", unblocks: [id(450)] });
    expect(of("DIPO-451")).toMatchObject({ state: "waiting", unblocks: [] });
    expect(of("DIPO-460")).toBeUndefined();
  });

  it("sends nothing when no story waits", () => {
    expect(chainOf([story(1, "ready"), story(2, "running")])).toEqual({ rows: [], nodes: [] });
  });

  it("does not loop on a dependency cycle", () => {
    const { rows } = chainOf([story(1, "waiting", [2]), story(2, "waiting", [1])]);
    expect(rows).toHaveLength(1);
  });
});
