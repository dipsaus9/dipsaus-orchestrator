// The story reader's text (DIPO-462): every criterion, finding and quote wraps at the 84-column
// measure and nothing is cut; the newest review round is open and the earlier ones fold to one
// line.

import { describe, expect, it } from "bun:test";

import { Verdict } from "@dipsaus-orchestrator/contract";

import { lineText } from "./segments";
import { nextOpen, READER_MEASURE, reviewLines } from "./story-card";

const LONG = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
const QUOTE = `const value = ${"x".repeat(150)};`;

function round(n: number, commit: string) {
  return {
    gate: "gat_01J9ZK5Q8W3V4X6Y7Z8A9B0R01",
    kind: "review",
    decision: "approved",
    by: "rule",
    at: "2026-10-14T09:00:00.000Z",
    review: {
      round: n,
      commit,
      codeTreeKey: `tree${n}`,
      verdict: "approved",
      criteria: [{ n: 1, status: "met", evidence: LONG }],
      findings: [
        {
          severity: "advisory",
          kind: "maintainability",
          file: "src/a.ts",
          line: 3,
          text: LONG,
          quote: QUOTE,
        },
      ],
      summary: "s",
      model: "m",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
        turns: 1,
        elapsedMs: 1,
      },
    },
  };
}

const verdicts = Verdict.array().parse([round(1, "aaaaaaa1111"), round(2, "bbbbbbb2222")]);
const text = (open: readonly number[]) =>
  reviewLines(verdicts, open, false).map((line) => lineText(line));

describe("the story reader's Reviews section", () => {
  it("wraps long findings, criteria and quotes at 84 columns and truncates nothing", () => {
    const rows = text([]);
    expect(Math.max(...rows.map((row) => row.length))).toBeLessThanOrEqual(READER_MEASURE);
    // Every word of the long text is still there after the wrap.
    const joined = rows.join(" ").replace(/\s+/g, " ");
    for (let i = 0; i < 30; i++) expect(joined).toContain(`word${i}`);
    expect(rows.join("").replace(/[^x]/g, "").length).toBe(150);
  });

  it("opens the newest round and folds the earlier ones to one line", () => {
    const rows = text([]);
    expect(rows[0]).toStartWith("ROUND 2 · bbbbbbb");
    const folded = rows.filter((row) => row.startsWith("▸ ROUND 1"));
    expect(folded).toHaveLength(1);
    expect(folded[0]).toContain("1/1 met · 1 advisory");
    expect(rows.filter((row) => row.includes("ROUND 1"))).toHaveLength(1);
  });

  it("opens an earlier round on request, and folds them again", () => {
    expect(nextOpen(verdicts, [])).toEqual([1]);
    const open = text([1]);
    expect(open.filter((row) => row.includes("ROUND 1"))).toHaveLength(1);
    expect(open.some((row) => row.startsWith("▾ ROUND 1"))).toBe(true);
    expect(open.filter((row) => row.startsWith("!"))).toHaveLength(2);
    expect(nextOpen(verdicts, [1])).toEqual([]);
  });
});
