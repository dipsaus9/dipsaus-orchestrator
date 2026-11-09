// The Pipeline (DIPO-460): each phase state as the ux-spec draws it, the marks inside a phase, the
// failed form, an unknown phase from a newer engine, and the ASCII twins.

import { describe, expect, it } from "bun:test";

import { pipelineSpans } from "./pipeline";
import { spansText } from "./spans";

const text = (spec: Parameters<typeof pipelineSpans>[0]) => spansText(pipelineSpans(spec));
const roles = (spec: Parameters<typeof pipelineSpans>[0]) =>
  pipelineSpans(spec).map((span) => [span.role, span.text]);

describe("pipeline", () => {
  it("draws finished phases in ok, the current one in acc and the rest dotted in faint", () => {
    expect(roles({ phase: "review", ascii: false })).toEqual([
      ["ok", "setup ━━ build ━━ "],
      ["acc", "● review"],
      ["faint", " ┄┄ test ┄┄ merge"],
    ]);
  });

  it("draws every phase as the current one, with nothing finished before setup or dotted after merge", () => {
    expect(text({ phase: "setup", ascii: false })).toBe(
      "● setup ┄┄ build ┄┄ review ┄┄ test ┄┄ merge",
    );
    expect(text({ phase: "build", ascii: false })).toBe(
      "setup ━━ ● build ┄┄ review ┄┄ test ┄┄ merge",
    );
    expect(text({ phase: "review", ascii: false })).toBe(
      "setup ━━ build ━━ ● review ┄┄ test ┄┄ merge",
    );
    expect(text({ phase: "test", ascii: false })).toBe(
      "setup ━━ build ━━ review ━━ ● test ┄┄ merge",
    );
    expect(roles({ phase: "merge", ascii: false })).toEqual([
      ["ok", "setup ━━ build ━━ review ━━ test ━━ "],
      ["acc", "● merge"],
    ]);
  });

  it("puts verify and CI as marks inside a phase, never as phases", () => {
    expect(
      text({ phase: "merge", ascii: false, marks: { build: "met", review: "met", test: "met" } }),
    ).toBe("setup ━━ build ✓ ━━ review ✓ ━━ test ✓ ━━ ● merge");
    expect(text({ phase: "test", ascii: false, marks: { build: "met", review: "met" } })).toBe(
      "setup ━━ build ✓ ━━ review ✓ ━━ ● test ┄┄ merge",
    );
    expect(text({ phase: "build", ascii: false })).not.toMatch(/verify|ci/i);
  });

  it("draws the failed phase in err with the failing check, the rest dotted", () => {
    const spec = { phase: "build", ascii: false, failed: { phase: "build", check: "verify" } };
    expect(roles(spec)).toEqual([
      ["ok", "setup ━━ "],
      ["err", "✗ build · verify"],
      ["faint", " ┄┄ review ┄┄ test ┄┄ merge"],
    ]);
  });

  it("shows a phase the engine added later after the dotted phases, without guessing its place", () => {
    expect(roles({ phase: "deploy", ascii: false })).toEqual([
      ["faint", "┄┄ setup ┄┄ build ┄┄ review ┄┄ test ┄┄ merge"],
      ["dim", " deploy"],
    ]);
  });

  it("has an ASCII twin for every glyph", () => {
    expect(text({ phase: "review", ascii: true, marks: { build: "met" } })).toBe(
      "setup == build + == * review .. test .. merge",
    );
    expect(text({ phase: "build", ascii: true, failed: { phase: "build", check: "verify" } })).toBe(
      "setup == x build - verify .. review .. test .. merge",
    );
    expect(text({ phase: "merge", ascii: true })).toMatch(/^[\x20-\x7e]+$/);
  });
});
