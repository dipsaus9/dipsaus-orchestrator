// The shared cleaner of text from outside dipo (DIPO-313). The door's former tests live here.

import { describe, expect, it } from "bun:test";

import { cleanText, SEQUENCE_SAMPLES } from "./clean-text";

const ESC = "\u001b";
const RLO = String.fromCodePoint(0x202e);
const LRI = String.fromCodePoint(0x2066);
const PDI = String.fromCodePoint(0x2069);
const ZWSP = String.fromCodePoint(0x200b);
const BOM = String.fromCodePoint(0xfeff);
const TAG_A = String.fromCodePoint(0xe0041);
const LINE_SEPARATOR = String.fromCodePoint(0x2028);

describe("cleanText", () => {
  it("removes each sequence class whole", () => {
    for (const [name, sample] of Object.entries(SEQUENCE_SAMPLES)) {
      expect([name, cleanText(`a${sample}b`)]).toEqual([name, "ab"]);
    }
  });

  it("removes C0 and C1 controls but keeps tab and line breaks", () => {
    expect(cleanText("a\u0007b\u0000c\u007fd\u0085e\tf\ng\r\nh\ri")).toBe("abcde\tf\ng\nh\ni");
  });

  it("removes bidi overrides and isolates, hidden characters and tag characters", () => {
    const text = `Fix ${RLO}gnp.exe${LRI}x${PDI} ${ZWSP}${BOM}a${TAG_A}b${LINE_SEPARATOR}c`;
    expect(cleanText(text)).toBe("Fix gnp.exex ab\nc");
    expect(cleanText(String.fromCharCode(0xd800))).toBe(String.fromCodePoint(0xfffd));
  });

  it("removes an escape with the whole astral character after it, never half of one", () => {
    const text = cleanText(`${ESC}${String.fromCodePoint(0x1f600)}after`);
    expect(text).toBe("after");
    expect(text.isWellFormed()).toBe(true);
    expect(cleanText(`a${ESC}`).isWellFormed()).toBe(true);
  });

  it("removes variation selectors, joiners, fillers and the other invisible characters", () => {
    for (const point of [
      0xe0100, 0xe01ef, 0xfe00, 0xfe0f, 0x180e, 0x00ad, 0x034f, 0x115f, 0x1160, 0x3164, 0x200c,
      0x200d,
    ]) {
      expect([point, cleanText(`a${String.fromCodePoint(point)}b`)]).toEqual([point, "ab"]);
    }
  });

  it("keeps ordinary text, tabs, accents and emoji, and is idempotent", () => {
    const text = "Café\tnaïve 👍🏽 日本語\nnext line";
    expect(cleanText(text)).toBe(text);
    const dirty = `${ESC}[1mBold${ESC}[0m ${RLO}x${ESC}P1;2q${ESC}\\ ok`;
    expect(cleanText(cleanText(dirty))).toBe(cleanText(dirty));
    expect(cleanText(dirty)).toBe("Bold x ok");
  });
});
