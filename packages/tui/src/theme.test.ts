import { describe, expect, it } from "bun:test";

import { classicalEnv, detectTone, toneFromColorFgBg, toneFromOsc11 } from "./theme";

describe("theme detection", () => {
  it("reads the OSC 11 reply first", () => {
    expect(toneFromOsc11("\u001b]11;rgb:ffff/ffff/ffff\u0007")).toBe("light");
    expect(toneFromOsc11("\u001b]11;rgb:1c1c/1b1b/1919\u001b\\")).toBe("dark");
    expect(toneFromOsc11("nonsense")).toBeNull();
    expect(detectTone("\u001b]11;rgb:ffff/ffff/ffff\u0007", { COLORFGBG: "15;0" })).toBe("light");
  });

  it("falls back to COLORFGBG, then dark", () => {
    expect(toneFromColorFgBg("0;15")).toBe("light");
    expect(toneFromColorFgBg("15;default;0")).toBe("dark");
    expect(detectTone(null, { COLORFGBG: "0;15" })).toBe("light");
    expect(detectTone(null, {})).toBe("dark");
    expect(detectTone("nonsense", { COLORFGBG: "x" })).toBe("dark");
  });

  it("opts in to Classical only by name", () => {
    expect(classicalEnv({ DIPO_TUI_THEME: "classical" })).toBe(true);
    expect(classicalEnv({})).toBe(false);
  });
});
