// Size classes and truncation (DIPO-46 AC #2 and #7; 0014 section 4).

import { describe, expect, it } from "bun:test";

import {
  CONTEXT_BUDGETS,
  formatCount,
  INPUTS_BUDGETS,
  sizeClassOf,
  sizeClassOfWorkspace,
  truncateHead,
  truncationMarker,
} from "../../src/context";
import { lines, memoryWorkspace } from "./helpers";

describe("size class", () => {
  it("is S under 150, M under 500, L under 5,000 and XL above", () => {
    expect(sizeClassOf(0)).toBe("S");
    expect(sizeClassOf(149)).toBe("S");
    expect(sizeClassOf(150)).toBe("M");
    expect(sizeClassOf(499)).toBe("M");
    expect(sizeClassOf(500)).toBe("L");
    expect(sizeClassOf(4_999)).toBe("L");
    expect(sizeClassOf(5_000)).toBe("XL");
    expect(sizeClassOf(120_000)).toBe("XL");
  });

  it("counts tracked files only", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 150; i += 1) files[`f${i}.ts`] = "";
    expect(await sizeClassOfWorkspace(memoryWorkspace(files))).toBe("M");
    expect(await sizeClassOfWorkspace(memoryWorkspace(files, ["f0.ts"]))).toBe("S");
  });

  it("has the 0014 budgets", () => {
    expect(CONTEXT_BUDGETS).toEqual({ S: 12_000, M: 18_000, L: 24_000, XL: 32_000 });
    expect(INPUTS_BUDGETS).toEqual({ S: 8_000, M: 12_000, L: 16_000, XL: 20_000 });
  });
});

describe("truncation", () => {
  it("writes the 0014 marker", () => {
    expect(formatCount(18_240)).toBe("18,240");
    expect(formatCount(1_234_567)).toBe("1,234,567");
    expect(formatCount(999)).toBe("999");
    expect(truncationMarker(4_000, 18_240, "docs/spec.md", 112)).toBe(
      "[dipo: truncated, showing 4,000 of 18,240 characters. The rest is in docs/spec.md from line 112; read it only if the shown part is not enough.]",
    );
  });

  it("leaves text within the limit alone", () => {
    const text = lines(10);
    expect(truncateHead(text, text.length, "a.ts")).toEqual({
      text,
      truncated: false,
      shown: text.length,
      total: text.length,
      lines: 10,
    });
  });

  it("cuts on a line boundary, keeps the head and names the next line", () => {
    const text = lines(100);
    const cut = truncateHead(text, 1_000, "src/big.ts");
    expect(cut.truncated).toBe(true);
    expect(cut.text.length).toBeLessThanOrEqual(1_000);
    const head = text.slice(0, cut.shown);
    expect(head.endsWith("\n")).toBe(true);
    expect(cut.shown).toBe(cut.lines * 40);
    expect(cut.text).toBe(
      `${head}[dipo: truncated, showing ${formatCount(cut.shown)} of 4,000 characters. The rest is in src/big.ts from line ${cut.lines + 1}; read it only if the shown part is not enough.]`,
    );
  });

  it("puts the marker on its own line after a last line without a newline", () => {
    const text = `${"a".repeat(30)}\n${"b".repeat(5_000)}`;
    const cut = truncateHead(text, 400, "x.txt");
    expect(cut.text.startsWith(`${"a".repeat(30)}\n[dipo: truncated, showing 31 of 5,031`)).toBe(
      true,
    );
    expect(cut.text).toContain("from line 2;");
  });

  it("shows only the marker when the first line is longer than the room", () => {
    const cut = truncateHead("z".repeat(10_000), 500, "min.js");
    expect(cut.shown).toBe(0);
    expect(cut.text).toBe(truncationMarker(0, 10_000, "min.js", 1));
  });

  it("gives the same bytes on every run", () => {
    const text = lines(500, 37);
    expect(truncateHead(text, 4_000, "a.ts")).toEqual(truncateHead(text, 4_000, "a.ts"));
  });
});
