// The Frame's rows around the body (DIPO-510): the ticker takes one row per wrapped line.

import { describe, expect, it } from "bun:test";

import { frameRows } from "./frame";

describe("frameRows", () => {
  it("counts the ticker's rows, one to three, and the rooms band", () => {
    expect(frameRows(false, 0)).toBe(4);
    expect(frameRows(false, 1)).toBe(5);
    expect(frameRows(false, 2)).toBe(6);
    expect(frameRows(false, 3)).toBe(7);
    expect(frameRows(true, 3)).toBe(8);
  });
});
