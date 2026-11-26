// The mouse reports (DIPO-515): press, release and wheel in SGR form, joined across reads, and the
// hit test of a report on the Desk's map.

import { describe, expect, it } from "bun:test";

import { type DeskHitMap, deskHit, MouseParser } from "./mouse";

const ESC = "\u001b";

describe("MouseParser", () => {
  it("turns press, release and wheel reports into events with their x and y", () => {
    const parser = new MouseParser();
    expect(parser.feed(`${ESC}[<0;12;5M`)).toEqual([{ kind: "press", x: 12, y: 5 }]);
    expect(parser.feed(`${ESC}[<0;12;5m`)).toEqual([{ kind: "release", x: 12, y: 5 }]);
    expect(parser.feed(`${ESC}[<64;3;4M${ESC}[<65;3;4M`)).toEqual([
      { kind: "wheelUp", x: 3, y: 4 },
      { kind: "wheelDown", x: 3, y: 4 },
    ]);
  });

  it("joins a report split across two reads, at any cut", () => {
    const report = `${ESC}[<0;120;33M`;
    for (let cut = 1; cut < report.length; cut++) {
      const parser = new MouseParser();
      expect(parser.feed(report.slice(0, cut))).toEqual([]);
      expect(parser.feed(report.slice(cut))).toEqual([{ kind: "press", x: 120, y: 33 }]);
    }
  });

  it("ignores other buttons and other text, and does not keep a tail that is not a report", () => {
    const parser = new MouseParser();
    expect(parser.feed(`${ESC}[<2;1;1M${ESC}[<1;1;1M${ESC}[<35;1;1M`)).toEqual([]);
    expect(parser.feed(`jk${ESC}[A`)).toEqual([]);
    expect(parser.feed(`${ESC}`)).toEqual([]);
    // The lone Esc is not joined to a later key that is not a report.
    expect(parser.feed(`x${ESC}[<0;1;1M`)).toEqual([{ kind: "press", x: 1, y: 1 }]);
  });

  it("reads a click with a modifier as its button, and a wheel release as nothing", () => {
    const parser = new MouseParser();
    expect(parser.feed(`${ESC}[<4;2;2M`)).toEqual([{ kind: "press", x: 2, y: 2 }]);
    expect(parser.feed(`${ESC}[<64;2;2m`)).toEqual([]);
  });
});

describe("deskHit", () => {
  const map: DeskHitMap = {
    listRows: [null, 0, 0, null, 1],
    listWidth: 46,
    previewX: 49,
    previewMax: 4,
    buttons: [{ row: 2, from: 49, to: 60, key: "y" }],
  };

  it("finds the list row, the button and what lies outside them", () => {
    expect(deskHit(map, 4, { kind: "press", x: 3, y: 5 })).toEqual({ area: "list", item: 0 });
    expect(deskHit(map, 4, { kind: "press", x: 3, y: 4 })).toEqual({ area: "list", item: null });
    expect(deskHit(map, 4, { kind: "press", x: 50, y: 6 })).toEqual({
      area: "preview",
      button: "y",
    });
    expect(deskHit(map, 4, { kind: "press", x: 61, y: 6 })).toEqual({
      area: "preview",
      button: null,
    });
    expect(deskHit(map, 4, { kind: "press", x: 48, y: 6 })).toBeNull();
    expect(deskHit(map, 4, { kind: "press", x: 3, y: 2 })).toBeNull();
  });
});
