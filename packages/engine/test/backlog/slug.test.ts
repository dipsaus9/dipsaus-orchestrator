// The branch slug (DIPO-29; 0010 section 4): the five steps, `story` for an empty result, and
// `branchFor` matching R18.

import { describe, expect, it } from "bun:test";

import { FieldBlock } from "@dipsaus-orchestrator/contract";

import { branchFor, slug } from "../../src/backlog";

const FIFTY = "abcdefghij".repeat(5);

describe("slug", () => {
  const table: readonly (readonly [string, string])[] = [
    ["Read and write the dipo field block", "read-write-dipo-field-block"],
    ["Café crème für Ärzte", "cafe-creme-fur-arzte"],
    ["İstanbul ﬁle Ⅻ ①", "istanbul-file-xii-1"],
    ["The and of a", "the-and-of-a"],
    ["a", "a"],
    [FIFTY, FIFTY.slice(0, 40)],
    [`${FIFTY} next`, FIFTY.slice(0, 40)],
    ["", "story"],
    ["   ", "story"],
    ["!!! — ???", "story"],
    ["日本語のタイトル", "story"],
    ["Fix C++ & C# (v2.0) build", "fix-c-c-v2-0-build"],
    [
      "Read and write the dipo field block, reserved labels and branch slug",
      "read-write-dipo-field-block-reserved",
    ],
    ["one two three four five six seven eight nine", "one-two-three-four-five-six-seven-eight"],
    ["abcdefghijklmnopqrstuvwxyz0123456789abc de", "abcdefghijklmnopqrstuvwxyz0123456789abc"],
    ["abcdefghijklmnopqrstuvwxyz012345678 abcd", "abcdefghijklmnopqrstuvwxyz012345678-abcd"],
  ];

  for (const [title, expected] of table) {
    it(`slugs ${JSON.stringify(title)} as ${expected}`, () => {
      const result = slug(title);
      expect(result).toBe(expected);
      expect(result.length).toBeLessThanOrEqual(40);
    });
  }
});

const R18 = (id: string) => new RegExp(`^${id.replace(/\./g, "\\.")}/[a-z0-9]+(-[a-z0-9]+)*$`);

describe("branchFor", () => {
  it("joins the id and the slug and matches R18", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["DIPO-29", "Read and write the dipo field block, reserved labels and branch slug"],
      ["TASK-1.2", ""],
      ["DIPO-7", FIFTY],
      ["X-1", "Ünïcödé — only?"],
    ];
    for (const [id, title] of cases) {
      const branch = branchFor(id, title);
      expect(branch).toStartWith(`${id}/`);
      expect(branch).toMatch(R18(id));
      expect(FieldBlock.safeParse({ branch }).success).toBe(true);
    }
    expect(
      branchFor("DIPO-29", "Read and write the dipo field block, reserved labels and branch slug"),
    ).toBe("DIPO-29/read-write-dipo-field-block-reserved");
  });
});
