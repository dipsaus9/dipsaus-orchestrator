// The `dipo` field block and reserved labels (DIPO-29; 0010): the parser accepts zero or
// one block and fails R02 on a second block, an unclosed block, text after it or an unquoted number;
// the emitter is canonical and round-trips; the splice keeps every byte outside the block.

import { describe, expect, it } from "bun:test";

import type { FieldBlock } from "@dipsaus-orchestrator/contract";

import { labelEditArgs } from "../../src/backlog";
import {
  emitFieldBlock,
  FieldBlockError,
  parseFieldBlock,
  readLabels,
  spliceFieldBlock,
} from "../../src/story-store";

const STORY_LINE =
  "Story: As maintainer I want the export to report how many rows it wrote so that I can tell a short export from a full one.";

function errorOf(description: string): FieldBlockError {
  try {
    parseFieldBlock(description);
  } catch (error) {
    if (error instanceof FieldBlockError) return error;
    throw error;
  }
  throw new Error("expected a FieldBlockError");
}

describe("the block parser", () => {
  it("reads no block as empty fields", () => {
    expect(parseFieldBlock(`${STORY_LINE}\n\nFree context.`)).toEqual({
      fields: {},
      block: undefined,
    });
    expect(parseFieldBlock("").fields).toEqual({});
  });

  it("reads one block into typed fields", () => {
    const description = [
      STORY_LINE,
      "",
      "```dipo",
      'branch: "TASK-4/count-exported-rows"',
      "unknowns:",
      '  - q: "Which rows count?"',
      '    status: "resolved"',
      '    answer: "Written rows only."',
      "test_plan:",
      '  not_applicable: "A docs-only change."',
      'park: { reason: "on-hold", from: "Ready", note: "Waiting for Bun 1.4.3" }',
      "```",
    ].join("\n");
    expect(parseFieldBlock(description).fields).toEqual({
      branch: "TASK-4/count-exported-rows",
      unknowns: [{ q: "Which rows count?", status: "resolved", answer: "Written rows only." }],
      test_plan: { not_applicable: "A docs-only change." },
      park: { reason: "on-hold", from: "Ready", note: "Waiting for Bun 1.4.3" },
    });
  });

  it("allows blank lines after the block and an empty block", () => {
    expect(
      parseFieldBlock(`${STORY_LINE}\n\n\`\`\`dipo\nunknowns: []\n\`\`\`\n\n  \n`).fields,
    ).toEqual({ unknowns: [] });
    expect(parseFieldBlock(`${STORY_LINE}\n\`\`\`dipo\n\`\`\``).fields).toEqual({});
  });

  it("opens only on a line exactly ```dipo, a CRLF ending included", () => {
    expect(parseFieldBlock(`${STORY_LINE}\n \`\`\`dipo\nbranch: 5\n\`\`\``).block).toBeUndefined();
    expect(
      parseFieldBlock(`${STORY_LINE}\r\n\`\`\`dipo\r\nunknowns: []\r\n\`\`\`\r\n`).fields,
    ).toEqual({
      unknowns: [],
    });
  });

  it("fails R02 on a line that is ```dipo only after trimming other trailing whitespace", () => {
    for (const opener of ["```dipo ", "```dipo\t", "```dipo \r", "```dipo\r\r"]) {
      const error = errorOf(`${STORY_LINE}\n\n${opener}\nbranch: "TASK-1/old"\n\`\`\``);
      expect(error.rule).toBe("R02");
      expect(error.detail).toContain("trailing whitespace");
      expect(error.line).toBe(3);
    }
  });

  it("fails R02 on a second block", () => {
    const block = "```dipo\nunknowns: []\n```";
    const error = errorOf(`${STORY_LINE}\n\n${block}\n\n${block}`);
    expect(error.rule).toBe("R02");
    expect(error.message).toStartWith("structured fields are invalid: a second ```dipo block");
    expect(error.line).toBe(7);
  });

  it("fails R02 on an unclosed block", () => {
    const error = errorOf(`${STORY_LINE}\n\n\`\`\`dipo\nunknowns: []\n\`\`\` \n`);
    expect(error.rule).toBe("R02");
    expect(error.detail).toContain("not closed");
    expect(error.line).toBe(3);
  });

  it("fails R02 on text after the block", () => {
    const error = errorOf(`${STORY_LINE}\n\n\`\`\`dipo\nunknowns: []\n\`\`\`\n\nMore context.`);
    expect(error.rule).toBe("R02");
    expect(error.detail).toContain("text after");
    expect(error.line).toBe(7);
  });

  it("fails R02 on `answer: 5173` with the quote hint", () => {
    const error = errorOf(
      [
        STORY_LINE,
        "```dipo",
        "unknowns:",
        '  - q: "Which port?"',
        '    status: "resolved"',
        "    answer: 5173",
        "```",
      ].join("\n"),
    );
    expect(error.rule).toBe("R02");
    expect(error.message).toContain("unknowns.0.answer: expected a string: quote this value");
    expect(error.line).toBe(2);
  });

  it("fails R02 on unknown keys and invalid YAML", () => {
    expect(errorOf('```dipo\nbranch: "TASK-1/x"\nowner: "me"\n```').detail).toContain("owner");
    expect(errorOf("```dipo\nbranch: [\n```").detail).toStartWith("invalid YAML");
    expect(errorOf('```dipo\nbranch: "TASK-1/Bad Slug"\n```').detail).toContain("branch");
  });
});

const FULL: FieldBlock = {
  branch: "TASK-4/count-exported-rows",
  unknowns: [
    { q: "Which rows count?", status: "resolved", answer: "Written rows only." },
    { q: 'A "quoted" \\ back\nslash: #1', status: "open" },
  ],
  test_plan: {
    entries: [
      { kind: "automated", check: "(unit) one CSV row per story" },
      { kind: "manual", check: "Run the export", expect: "Every story shows: ü, 日本, \u2028, \t" },
    ],
  },
  park: { reason: "on-hold", from: "Ready", note: "  leading spaces, 5173" },
};

describe("the emitter", () => {
  it("writes fixed key order, double-quoted strings and two-space indent", () => {
    expect(emitFieldBlock(FULL)).toBe(
      [
        'branch: "TASK-4/count-exported-rows"',
        "unknowns:",
        '  - q: "Which rows count?"',
        '    status: "resolved"',
        '    answer: "Written rows only."',
        '  - q: "A \\"quoted\\" \\\\ back\\nslash: #1"',
        '    status: "open"',
        "test_plan:",
        "  entries:",
        '    - kind: "automated"',
        '      check: "(unit) one CSV row per story"',
        '    - kind: "manual"',
        '      check: "Run the export"',
        '      expect: "Every story shows: ü, 日本, \\u2028, \\t"',
        "park:",
        '  reason: "on-hold"',
        '  from: "Ready"',
        '  note: "  leading spaces, 5173"',
        "",
      ].join("\n"),
    );
  });

  it("orders keys canonically whatever the input order", () => {
    const shuffled = {
      park: { note: "n", from: "Ready", reason: "stopped" },
      test_plan: { not_applicable: "No code changes here." },
      unknowns: [],
      branch: "TASK-1/x",
    } as FieldBlock;
    expect(emitFieldBlock(shuffled)).toBe(
      [
        'branch: "TASK-1/x"',
        "unknowns: []",
        "test_plan:",
        '  not_applicable: "No code changes here."',
        "park:",
        '  reason: "stopped"',
        '  from: "Ready"',
        '  note: "n"',
        "",
      ].join("\n"),
    );
  });

  it("returns the same value when parsed after emit", () => {
    const values: FieldBlock[] = [
      {},
      FULL,
      { unknowns: [] },
      { test_plan: { entries: [] } },
      { test_plan: { not_applicable: "true" } },
      { branch: "DIPO-1.2/a" },
      { park: { reason: "needs-permission", from: "In Progress", note: "" } },
    ];
    for (const value of values) {
      const description = spliceFieldBlock(STORY_LINE, value);
      expect(parseFieldBlock(description).fields).toEqual(value);
    }
  });
});

describe("the splice", () => {
  const before = `\t${STORY_LINE}  \r\n\nContext with \`\`\`fences\`\`\` and trailing space \n`;
  const old =
    '```dipo\nbranch: "TASK-4/old"\npark: {reason: "stopped", from: "Ready", note: "x"}\n```';

  it("keeps every byte outside the block identical", () => {
    const after = "\n \n";
    const spliced = spliceFieldBlock(`${before}${old}${after}`, FULL);
    const content = emitFieldBlock(FULL);
    expect(spliced).toBe(`${before}\`\`\`dipo\n${content}\`\`\`${after}`);
    expect(spliced.startsWith(`${before}\`\`\`dipo\n`)).toBe(true);
    expect(spliced.endsWith(`\`\`\`${after}`)).toBe(true);
    expect(parseFieldBlock(spliced).fields).toEqual(FULL);
  });

  it("appends a block after a blank line when there is none, keeping the text as a prefix", () => {
    const value: FieldBlock = { unknowns: [] };
    expect(spliceFieldBlock(STORY_LINE, value)).toBe(
      `${STORY_LINE}\n\n\`\`\`dipo\nunknowns: []\n\`\`\``,
    );
    expect(spliceFieldBlock(`${STORY_LINE}\n`, value)).toBe(
      `${STORY_LINE}\n\n\`\`\`dipo\nunknowns: []\n\`\`\``,
    );
    expect(spliceFieldBlock("", value)).toBe("```dipo\nunknowns: []\n```");
    expect(spliceFieldBlock(STORY_LINE, {})).toBe(STORY_LINE);
  });

  it("refuses a description whose block structure is invalid", () => {
    expect(() => spliceFieldBlock(`${old}\n${old}`, {})).toThrow(FieldBlockError);
  });

  it("never appends a second block after a stale near-miss block", () => {
    const stale = `${STORY_LINE}\n\n\`\`\`dipo \nbranch: "TASK-4/old"\n\`\`\``;
    expect(() => spliceFieldBlock(stale, { unknowns: [] })).toThrow(FieldBlockError);
  });

  it("splices a CRLF block in place and keeps CRLF endings", () => {
    const head = `${STORY_LINE}\r\n\r\nContext.\r\n\r\n`;
    const tail = "\r\n";
    const crlf = `${head}\`\`\`dipo\r\nbranch: "TASK-4/old"\r\n\`\`\`${tail}`;
    const spliced = spliceFieldBlock(crlf, { branch: "TASK-4/new", unknowns: [] });
    expect(spliced).toBe(
      `${head}\`\`\`dipo\r\nbranch: "TASK-4/new"\r\nunknowns: []\r\n\`\`\`${tail}`,
    );
    expect(parseFieldBlock(spliced).fields).toEqual({ branch: "TASK-4/new", unknowns: [] });
  });

  it("appends with CRLF endings to a description that uses them", () => {
    expect(spliceFieldBlock(`${STORY_LINE}\r\n`, { unknowns: [] })).toBe(
      `${STORY_LINE}\r\n\r\n\`\`\`dipo\r\nunknowns: []\r\n\`\`\``,
    );
  });

  it("keeps NFD text outside the block byte for byte and reads NFD block text as NFC", () => {
    const nfd = "Story: the café export writes every röw.\n\nNähe.\n\n";
    const block = '```dipo\nunknowns:\n  - q: "Café?"\n    status: "open"\n```';
    const parsed = parseFieldBlock(`${nfd}${block}`).fields;
    expect(parsed).toEqual({ unknowns: [{ q: "Café?", status: "open" }] });
    const spliced = spliceFieldBlock(`${nfd}${block}`, { ...parsed, branch: "TASK-4/cafe" });
    expect(spliced.startsWith(`${nfd}\`\`\`dipo\n`)).toBe(true);
    expect(spliced).toContain("é export");
    expect(spliced).not.toBe(spliced.normalize("NFC"));
  });
});

describe("the reserved labels", () => {
  it("reads tier, role and the test-before-merge flag", () => {
    expect(
      readLabels(["tier:M", "role:developer", "test-before-merge", "docs", "area:CLI"]),
    ).toEqual({
      tiers: ["M"],
      roles: ["developer"],
      testBeforeMerge: true,
      other: ["docs", "area:CLI"],
      invalid: [],
    });
    expect(readLabels([])).toEqual({
      tiers: [],
      roles: [],
      testBeforeMerge: false,
      other: [],
      invalid: [],
    });
  });

  it("returns every tier and role so the gate can judge R16 and R17", () => {
    const labels = readLabels(["tier:S", "tier:L", "role:a", "role:b"]);
    expect(labels.tiers).toEqual(["S", "L"]);
    expect(labels.roles).toEqual(["a", "b"]);
  });

  it("reports labels outside the grammar and does not read them as reserved", () => {
    const labels = readLabels([
      "Tier:M",
      "tier:",
      "role:dev ops",
      "a:b:c",
      "tier:M_1",
      "ok-1:Ab-9",
      "",
    ]);
    expect(labels.invalid).toEqual(["Tier:M", "tier:", "role:dev ops", "a:b:c", "tier:M_1", ""]);
    expect(labels.other).toEqual(["ok-1:Ab-9"]);
    expect(labels.tiers).toEqual([]);
    expect(labels.roles).toEqual([]);
  });

  it("changes labels only with --add-label and --remove-label", () => {
    expect(labelEditArgs({ add: ["tier:M", "role:developer"], remove: ["tier:S"] })).toEqual([
      "--add-label",
      "tier:M",
      "--add-label",
      "role:developer",
      "--remove-label",
      "tier:S",
    ]);
    expect(labelEditArgs({})).toEqual([]);
    expect(() => labelEditArgs({ add: ["a,b"] })).toThrow("outside the grammar");
  });
});
