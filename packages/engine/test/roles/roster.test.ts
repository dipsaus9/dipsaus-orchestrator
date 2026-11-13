// The roster the gate reads (DIPO-500, 0017): code is true for a code role only, and the kind rides along.

import { describe, expect, it } from "bun:test";

import { rosterOf } from "../../src/roles/base";
import type { Role } from "../../src/roles/parse";

const role = (name: string, kind: Role["kind"]): Role => ({
  name,
  purpose: "x",
  instructions: "y",
  kind,
});

describe("rosterOf", () => {
  it("marks design and docs roles as not code and carries each kind", () => {
    expect(
      rosterOf([role("developer", "code"), role("designer", "design"), role("writer", "docs")]),
    ).toEqual([
      { name: "developer", code: true, kind: "code" },
      { name: "designer", code: false, kind: "design" },
      { name: "writer", code: false, kind: "docs" },
    ]);
  });
});
