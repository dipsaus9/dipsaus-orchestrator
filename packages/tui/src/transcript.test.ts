// The planning conversation as rows (DIPO-486): folds through the Run stream's rows, hidden blocks,
// the question view, wrapping at the column width and markdown in the roles of roles.json.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { PlanningQuestionBlock } from "@dipsaus-orchestrator/contract";

import { markdownRows, wrapSpans } from "./markdown";
import type { Display } from "./options";
import { dialogRows, freshDialog, type DialogState } from "./question-dialog";
import { spansText } from "./spans";
import { foldCount, transcriptRows, visibleLines, type TranscriptOptions } from "./transcript";

const ROLES_JSON = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "docs",
  "design",
  "tui-v2",
  "roles.json",
);
const ROLE_NAMES = Object.keys(
  (JSON.parse(readFileSync(ROLES_JSON, "utf8")) as { roles: object }).roles,
);

const options = (extra: Partial<TranscriptOptions> = {}): TranscriptOptions => ({
  dot: "·",
  ellipsis: "…",
  rule: "─",
  bar: "▌",
  bullet: "●",
  open: new Set(),
  focus: null,
  ...extra,
});
const display: Display = { color: true, ascii: false } as Display;
const text = (rows: readonly { spans: readonly { text: string }[] }[]) =>
  rows.map((row) => spansText(row.spans));

const TARGET = `packages/engine/src/${"deep/".repeat(12)}export.ts`;
const ANSWER = [
  "[thinking] 1.0s ~300 tokens",
  "[thinking] 2.0s ~500 tokens",
  `[tool] Read ${TARGET}`,
  "Here is the plan.",
  "",
].join("\n");

describe("the planning conversation", () => {
  it("folds thinking and tool lines to one line each, and opens one on demand (#1)", () => {
    expect(foldCount(ANSWER)).toBe(2);
    const shut = transcriptRows(ANSWER, 80, options({ focus: 1 }));
    expect(text(shut)).toHaveLength(3);
    expect(text(shut)[0]).toContain("2 thoughts · 0.8k tokens");
    expect(text(shut)[1]).toMatch(/^▌ .*read /);
    expect(text(shut)[1]).toContain("⏎ full");
    expect(text(shut)[2]).toBe("Here is the plan.");
    expect(shut.map((row) => row.fold)).toEqual([0, 1, undefined]);
    const opened = transcriptRows(ANSWER, 80, options({ open: new Set([1]) }));
    expect(text(opened).length).toBeGreaterThan(3);
    expect(text(opened).join(" ")).not.toContain("⏎ full");
    expect(text(opened).join("").replaceAll(" ", "")).toContain(TARGET);
  });

  it("never shows a question or proposal block as text, closed, open or being written (#2)", () => {
    const blocks = [
      'Which one?\n```dipo-questions\n{"questions":[1]}\n```\nAfter.\n',
      'Which one?\n```dipo-proposal\n{"kind":"story"}\n```\nAfter.\n',
      'Which one?\n```dipo-questions\n{"questions":[1',
      "Which one?\n``` dipo-pro",
    ];
    for (const block of blocks) {
      const shown = text(transcriptRows(block, 80, options())).join("\n");
      expect(shown).toContain("Which one?");
      expect(shown).not.toMatch(/dipo-|questions|kind|```/);
    }
    expect(visibleLines("```js\ncode\n```\n```dipo-questions\n{}\n```\n")).toEqual([
      "```js",
      "code",
      "```",
    ]);
  });

  const block: PlanningQuestionBlock = {
    n: 1,
    at: "2026-10-14T10:04:00.000Z",
    questions: [
      {
        header: "Scope",
        question: "Should the export cover archived stories as well as the active ones?",
        purpose: "It decides whether the CSV needs a status column for every row.",
        options: [
          {
            label: "No",
            description: "Only active stories, which keeps the file small and the columns few.",
            recommended: true,
          },
          { label: "Yes", description: "Archived stories too." },
        ],
      },
      {
        header: "Format",
        question: "Which separator?",
        purpose: "The importers differ.",
        options: [{ label: "Comma", description: "Standard." }],
      },
    ],
  } as PlanningQuestionBlock;

  it("sets the question apart, lists the options with the recommended one marked, and shows the choices (#3)", () => {
    let state: DialogState = freshDialog(block);
    const before = dialogRows(block, state, 100, display);
    const lines = before.map(spansText);
    expect(lines[1]).toMatch(/^\? Should the export/);
    expect(before[1]?.[1]).toMatchObject({ role: "hi", bold: true });
    expect(lines.find((l) => l.includes("1. No"))).toContain("(recommended)");
    expect(lines.some((l) => l.includes("2. Yes"))).toBe(true);
    expect(lines.filter((l) => l.includes("not answered"))).toHaveLength(2);
    expect(lines.join("\n")).not.toContain("✓");

    // A choice shows at once, and changes before sending.
    state = { ...state, answers: [{ option: 0 }, null] };
    let after = dialogRows(block, state, 100, display).map(spansText);
    expect(after.find((l) => l.includes("1. No"))).toContain("✓");
    expect(after.find((l) => l.includes("Scope:"))).toContain("No ✓");
    state = { ...state, answers: [{ option: 1 }, null] };
    after = dialogRows(block, state, 100, display).map(spansText);
    expect(after.find((l) => l.includes("2. Yes"))).toContain("✓");
    expect(after.find((l) => l.includes("Scope:"))).toContain("Yes ✓");
  });

  it("wraps every line at the column width at word boundaries, at 80 and 112 columns (#4)", () => {
    const long = `${"word ".repeat(40)}${"x".repeat(30)}`;
    const answer = [
      `# ${long}`,
      `- ${long}`,
      long,
      `[tool] Read ${TARGET}`,
      "```",
      long,
      "```",
    ].join("\n");
    for (const columns of [80, 112]) {
      const width = columns - 2;
      const rows = text(transcriptRows(answer, width, options()));
      const dialog = dialogRows(
        {
          ...block,
          questions: [
            {
              ...block.questions[0]!,
              question: long,
              options: [{ label: long, description: long }],
            },
          ],
        } as PlanningQuestionBlock,
        { ...freshDialog(block), answers: [{ free: long }] },
        columns,
        display,
      ).map(spansText);
      for (const row of [...rows, ...dialog]) expect(row.length).toBeLessThanOrEqual(width);
    }
    // A break falls at a space: no word of the text is split, except the one longer than a row.
    const rows = wrapSpans([{ text: "alpha beta gamma delta" }], 11).map(spansText);
    expect(rows).toEqual(["alpha beta", "gamma delta"]);
    expect(wrapSpans([{ text: "ab cdefghijkl" }], 5).map(spansText)).toEqual([
      "ab",
      "cdefg",
      "hijkl",
    ]);
  });

  it("renders markdown with the colour roles of roles.json and no other (#5)", () => {
    const rows = markdownRows(
      [
        "# Title",
        "",
        "Some **bold** and `code` words.",
        "- first item",
        "2. second item",
        "```ts",
        "const a = 1;",
        "```",
      ],
      60,
      { bullet: "●" },
    );
    expect(rows.map(spansText)).toEqual([
      "Title",
      "",
      "Some bold and code words.",
      "● first item",
      "2. second item",
      "  const a = 1;",
    ]);
    expect(rows[0]?.[0]).toMatchObject({ role: "hi", bold: true });
    expect(rows[2]?.find((s) => s.text === "bold")).toMatchObject({ role: "hi", bold: true });
    expect(rows[2]?.find((s) => s.text === "code")).toMatchObject({ role: "acc" });
    expect(rows[3]?.[0]).toMatchObject({ role: "acc" });
    expect(rows[5]?.[0]).toMatchObject({ role: "dim" });
    const used = new Set(
      rows.flat().flatMap((span) => (span.role === undefined ? [] : [span.role])),
    );
    for (const role of used) expect(ROLE_NAMES).toContain(role);
  });
});
