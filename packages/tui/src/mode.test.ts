// The mode reducer (DIPO-443): one test per mode change.

import { describe, expect, it } from "bun:test";

import { initialMode, inSwitcherMode, type Mode, modeReducer } from "./mode";

const HOME: Mode = { kind: "home" };
const SWITCHER: Mode = { kind: "switcher", index: 1 };
const PATH: Mode = { kind: "path", index: 1, text: "/tmp/ab" };

describe("modeReducer", () => {
  it("starts at home, or in the switcher", () => {
    expect(initialMode(false)).toEqual(HOME);
    expect(initialMode(true)).toEqual({ kind: "switcher", index: 0 });
  });

  it("home leaves any mode for home", () => {
    for (const mode of [HOME, SWITCHER, PATH]) {
      expect(modeReducer(mode, { type: "home" })).toEqual(HOME);
    }
    const confirm: Mode = { kind: "confirm-privacy", key: "storePrompts", value: true };
    expect(modeReducer(confirm, { type: "home" })).toEqual(HOME);
  });

  it("switcher opens with the given row, also from the path entry", () => {
    expect(modeReducer(HOME, { type: "switcher", index: 2 })).toEqual({
      kind: "switcher",
      index: 2,
    });
    expect(modeReducer(PATH, { type: "switcher", index: 1 })).toEqual(SWITCHER);
  });

  it("move steps the switcher selection and stays within the offices", () => {
    expect(modeReducer(SWITCHER, { type: "move", delta: 1, count: 3 })).toEqual({
      kind: "switcher",
      index: 2,
    });
    expect(modeReducer(SWITCHER, { type: "move", delta: 1, count: 2 })).toEqual(SWITCHER);
    expect(modeReducer(SWITCHER, { type: "move", delta: -5, count: 3 })).toEqual({
      kind: "switcher",
      index: 0,
    });
    expect(modeReducer(SWITCHER, { type: "move", delta: 1, count: 0 })).toEqual({
      kind: "switcher",
      index: 0,
    });
    expect(modeReducer(HOME, { type: "move", delta: 1, count: 3 })).toBe(HOME);
  });

  it("enter-path starts an empty path on the selected row, only from the switcher", () => {
    expect(modeReducer(SWITCHER, { type: "enter-path" })).toEqual({
      kind: "path",
      index: 1,
      text: "",
    });
    expect(modeReducer(HOME, { type: "enter-path" })).toBe(HOME);
  });

  it("type and erase edit the path, only while typing it", () => {
    expect(modeReducer(PATH, { type: "type", input: "c" })).toEqual({ ...PATH, text: "/tmp/abc" });
    expect(modeReducer(PATH, { type: "erase" })).toEqual({ ...PATH, text: "/tmp/a" });
    expect(modeReducer({ ...PATH, text: "" }, { type: "erase" })).toEqual({ ...PATH, text: "" });
    expect(modeReducer(SWITCHER, { type: "type", input: "c" })).toBe(SWITCHER);
    expect(modeReducer(HOME, { type: "erase" })).toBe(HOME);
  });

  it("confirm-privacy asks about the setting and the value", () => {
    expect(
      modeReducer(HOME, { type: "confirm-privacy", key: "storePrompts", value: false }),
    ).toEqual({ kind: "confirm-privacy", key: "storePrompts", value: false });
  });

  it("planning opens from home only and Esc goes home (DIPO-449)", () => {
    expect(modeReducer(HOME, { type: "planning" })).toEqual({ kind: "planning" });
    expect(modeReducer(SWITCHER, { type: "planning" })).toBe(SWITCHER);
    expect(modeReducer({ kind: "planning" }, { type: "home" })).toEqual(HOME);
  });

  it("inSwitcherMode is true for the switcher and the path entry only", () => {
    expect(inSwitcherMode(SWITCHER)).toBe(true);
    expect(inSwitcherMode(PATH)).toBe(true);
    expect(inSwitcherMode(HOME)).toBe(false);
    expect(inSwitcherMode({ kind: "confirm-privacy", key: "k", value: true })).toBe(false);
  });
});
