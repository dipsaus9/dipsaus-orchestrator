// The text pieces the TUI and `dipo watch` share from the client (DIPO-320): the percentage, the
// health words, the story reference and the output-range codec.

import { describe, expect, it } from "bun:test";

import type { OutputMarker } from "@dipsaus-orchestrator/contract";

import {
  byteLength,
  healthLabel,
  healthMeaning,
  outputPieces,
  percent,
  storyRef,
  textFrom,
} from "../../src/index";

describe("percent", () => {
  it("shows one decimal under 10% and whole numbers from there", () => {
    expect([0, 0.005, 0.042, 0.0999, 0.1, 0.52, 1, 1.234].map(percent)).toEqual([
      "0.0%",
      "0.5%",
      "4.2%",
      "10.0%",
      "10%",
      "52%",
      "100%",
      "123%",
    ]);
  });
});

describe("health words", () => {
  it("label each health state with its glyph and say what it means", () => {
    expect(["busy", "quiet", "stuck", "looping", "lost"].map(healthLabel)).toEqual([
      "busy >",
      "quiet .",
      "stuck ~",
      "looping @",
      "LOST !!",
    ]);
    expect(healthMeaning("busy")).toBe("the worker is producing output");
    expect(healthLabel("new")).toBe("new");
    expect(healthMeaning("new")).toBe("new");
  });
});

describe("storyRef", () => {
  it("reads a story id in any case and a story key as is", () => {
    expect(storyRef("dipo-7") as string | null).toBe("DIPO-7");
    expect(storyRef("DIPO-7.1") as string | null).toBe("DIPO-7.1");
    expect(storyRef("sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C3F") as string | null).toBe(
      "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C3F",
    );
    expect(storyRef("not a story")).toBeNull();
  });
});

/** A flagged phase marker over `text` at byte `from`. */
function marker(from: number, text: string): OutputMarker {
  return {
    from,
    to: from + byteLength(text),
    kind: "phase",
    value: "verify",
    at: "2026-10-14T09:05:07.000Z",
  };
}

describe("the output-range codec", () => {
  it("counts bytes, not characters, and reads a range from a byte offset", () => {
    expect(byteLength("héllo")).toBe(6);
    expect(textFrom({ from: 10, text: "héllo\n" }, 13)).toBe("llo\n");
    expect(textFrom({ from: 10, text: "abc" }, 4)).toBe("abc");
  });

  it("cuts a range at its flagged markers and leaves the markers' own bytes out", () => {
    const line = "[dipo] phase verify\n";
    const text = `before\n${line}after\n`;
    const flag = marker(100 + byteLength("before\n"), line);
    expect(outputPieces(text, 100, [flag])).toEqual(["before\n", flag, "after\n"]);
    // A marker outside the range, or none, leaves the text whole.
    expect(outputPieces(text, 100, [marker(500, line)])).toEqual([text]);
    expect(outputPieces("", 100, [])).toEqual([]);
    // A range that is only the marker gives only the marker.
    expect(outputPieces(line, 40, [marker(40, line)])).toEqual([marker(40, line)]);
  });
});
