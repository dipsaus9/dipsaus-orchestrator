// The live-question rule (DIPO-279, 0021 section 11): live only while a TUI is connected at the
// moment of the question, otherwise park. The permission wait's own replay tests are in
// `test/questions/permissions.test.ts` and `test/questions/park-answers.test.ts`.

import { describe, expect, it } from "bun:test";

import { ABSENT, type Presence, questionRoute } from "../../src/records/live-question";

/** A presence whose TUI the test opens and closes, counting each read. */
function fakePresence(tui: boolean): Presence & { tui: boolean; reads: number } {
  const presence = {
    tui,
    reads: 0,
    tuiConnected: () => {
      presence.reads += 1;
      return presence.tui;
    },
  };
  return presence;
}

describe("questionRoute", () => {
  it("is live while a TUI is connected", () => {
    expect(questionRoute(fakePresence(true))).toBe("live");
  });

  it("parks without a connected TUI", () => {
    expect(questionRoute(fakePresence(false))).toBe("park");
    expect(questionRoute(ABSENT)).toBe("park");
  });

  it("parks when the source does not allow a live question, whatever the TUI", () => {
    const presence = fakePresence(true);
    expect(questionRoute(presence, false)).toBe("park");
    expect(questionRoute(presence, true)).toBe("live");
  });

  it("reads the TUI at the moment of each question, with no window around it", () => {
    const presence = fakePresence(true);
    expect(questionRoute(presence)).toBe("live");
    presence.tui = false;
    expect(questionRoute(presence)).toBe("park");
    presence.tui = true;
    expect(questionRoute(presence)).toBe("live");
    expect(presence.reads).toBe(3);
  });
});
