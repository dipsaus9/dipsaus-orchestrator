// What the TUI makes of the chain the engine sent (DIPO-460): the UP NEXT sentence, the CHAIN
// picture and the marks after a dependency. Everything is a join of what was sent: the engine's
// test (engine/test/overview/chain.test.ts) holds the graph, this one holds the words.

import { describe, expect, it } from "bun:test";
import type { ChainNode, ChainRow, StoryId, StoryKey } from "@dipsaus-orchestrator/contract";

import {
  type Chain,
  chainMark,
  chainPictureSpans,
  needsSpans,
  refinedLines,
  refinedText,
  shortId,
  upNextSpans,
} from "./chain";
import { spansText } from "./spans";

const id = (n: number) => `DIPO-${n}` as StoryId;
const level = (...ns: number[]) => ns.map(id);
const node = (n: number, state: ChainNode["state"], unblocks: number[] = []): ChainNode => ({
  story: id(n),
  key: `sto_${n}` as StoryKey,
  state,
  unblocks: level(...unblocks),
});

const rows: ChainRow[] = [
  { levels: [level(447), level(448, 449), level(450), level(451)], parked: id(447) },
  { levels: [level(452), level(453)] },
];
const chain: Chain = {
  rows,
  nodes: [node(447, "parked", [448, 449]), node(452, "moving", [453]), node(449, "waiting")],
};

describe("shortId", () => {
  it("keeps the number after the last hyphen", () => {
    expect(shortId("DIPO-447")).toBe("447");
    expect(shortId("MY-APP-9")).toBe("9");
    expect(shortId("447")).toBe("447");
  });
});

describe("upNextSpans", () => {
  it("joins the engine's levels into the ux-spec's sentence, the first story in acc", () => {
    const spans = upNextSpans(chain, "→");
    expect(spansText(spans ?? [])).toBe(
      "When DIPO-447 merges → 448, 449 start in parallel, then 450 → 451, 452 → 453",
    );
    expect(spans?.filter((span) => span.role === "acc").map((span) => span.text)).toEqual([
      "DIPO-447",
    ]);
  });

  it("says `starts` for one story and has no `then` when nothing follows", () => {
    const one: Chain = { rows: [{ levels: [level(1), level(2)] }], nodes: [] };
    expect(spansText(upNextSpans(one, "→") ?? [])).toBe("When DIPO-1 merges → 2 starts");
  });

  it("draws pieces with several first stories as plain arrows, and nothing without a piece", () => {
    const many: Chain = { rows: [{ levels: [level(1, 2), level(3)] }], nodes: [] };
    expect(spansText(upNextSpans(many, "->") ?? [])).toBe("1, 2 -> 3");
    expect(upNextSpans({ rows: [], nodes: [] }, "→")).toBeNull();
  });
});

describe("the CHAIN picture", () => {
  it("marks a parked first story with ✗ in err and aligns the pieces' arrows", () => {
    const [first, second] = rows;
    const one = chainPictureSpans(first!, chain, "→", "·", false);
    expect(spansText(one)).toBe("447✗ → 448 · 449 → 450 → 451");
    expect(one[0]).toEqual({ text: "447✗", role: "err" });
    const two = chainPictureSpans(second!, chain, "→", "·", false);
    expect(spansText(two)).toBe("452  → 453");
    expect(two[0]).toEqual({ text: "452 ", role: "ok" });
  });

  it("uses the ascii twins", () => {
    expect(spansText(chainPictureSpans(rows[0]!, chain, "->", "-", true))).toBe(
      "447x -> 448 - 449 -> 450 -> 451",
    );
  });
});

describe("needs marks", () => {
  it("shows ✗ for a parked dependency, → for one that moves, and a bare number for one that waits", () => {
    expect(spansText(needsSpans([id(447)], chain, false))).toBe("447✗");
    expect(spansText(needsSpans([id(452)], chain, false))).toBe("452→");
    expect(spansText(needsSpans([id(449)], chain, false))).toBe("449");
    expect(spansText(needsSpans([id(449), id(447)], chain, false))).toBe("449, 447✗");
    expect(spansText(needsSpans([id(447)], chain, true))).toBe("447x");
  });

  it("treats a dependency the engine sent no node for as waiting", () => {
    expect(chainMark(undefined, false)).toBe("");
    expect(spansText(needsSpans([id(999)], chain, false))).toBe("999");
  });
});

describe("a Refined dependency (DIPO-484)", () => {
  const refinedChain: Chain = {
    rows: [{ levels: [level(470), level(471)] }, ...rows],
    nodes: [
      { ...node(470, "refined", [471]), reason: "no test plan" },
      node(448, "waiting"),
      ...chain.nodes,
    ],
  };

  it("reads Refined, not Ready yet with its first gate failure, not blocked", () => {
    expect(refinedText(refinedChain.nodes[0])).toBe("Refined, not Ready yet: no test plan");
    expect(refinedText(node(470, "refined"))).toBe("Refined, not Ready yet");
    expect(refinedText(node(448, "waiting"))).toBeNull();
    expect(refinedLines(level(470, 448), refinedChain)).toEqual([
      "DIPO-470 Refined, not Ready yet: no test plan",
    ]);
  });

  it("marks the dependency in the needs column and the picture, and a waiting one stays bare", () => {
    expect(spansText(needsSpans([id(470)], refinedChain, false))).toBe("470◌ Refined");
    expect(spansText(needsSpans([id(470)], refinedChain, true))).toBe("470o Refined");
    expect(spansText(needsSpans([id(448)], refinedChain, false))).toBe("448");
    const [piece] = refinedChain.rows;
    const picture = chainPictureSpans(piece as ChainRow, refinedChain, "→", "·", false);
    expect(spansText(picture)).toBe("470◌ → 471");
    expect(picture[0]?.role).toBe("acc");
  });

  it("says in the UP NEXT sentence that the maintainer's Ready is what it waits for", () => {
    const text = spansText(upNextSpans(refinedChain, "→") ?? []);
    expect(text).toContain("DIPO-470 Refined, not Ready yet: no test plan");
    expect(upNextSpans(chain, "→")?.some((span) => span.text.includes("Refined"))).toBe(false);
  });
});
