import { describe, expect, it } from "bun:test";

import { adrPathsOf } from "../../src/merge/adr-path";

describe("adrPathsOf", () => {
  it("names every path under docs/decisions/, any depth, type and letter case, sorted", () => {
    expect(
      adrPathsOf([
        "src/a.ts",
        "docs/decisions/sub/z.txt",
        "docs/decisions/0001-a.md",
        "Docs/Decisions/0002-b.md",
        "docs/decisions",
      ]),
    ).toEqual([
      "Docs/Decisions/0002-b.md",
      "docs/decisions",
      "docs/decisions/0001-a.md",
      "docs/decisions/sub/z.txt",
    ]);
  });

  it("leaves lookalikes and the rest of docs alone", () => {
    expect(
      adrPathsOf([
        "docs/decisions-old/a.md",
        "docs/vision.md",
        "x/docs/decisions/a.md",
        "docs/research/a.md",
      ]),
    ).toEqual([]);
  });
});
