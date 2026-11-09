// "Since you last looked" on the Desk (0009, DIPO-459): the TUI keeps the time it last switched away
// from each office and sends it as `since` with every `office.digest` read; an office it has not
// shown yet counts from the time it opens. The engine keeps no last-seen time (0001). The Desk's
// Since band prints the read's merged count, new proposals and spend, and any key dismisses it.

import { afterEach, describe, expect, it } from "bun:test";

import { DeskItem } from "@dipsaus-orchestrator/contract";

import { sinceBand } from "./desk";
import { OFFICES } from "../test/support/fake-session";
import { lineText } from "./segments";
import { mount } from "../test/support/setup";
import { clockTime } from "./views";

const mounted: { unmount(): Promise<void> }[] = [];
const SINCE = "2026-10-14T08:30:00.000Z";
const MINUTE = 60_000;

afterEach(async () => {
  for (const ui of mounted.splice(0)) await ui.unmount();
});

function lines(frame: string): string[] {
  return frame.split("\n").map((line) => line.trimEnd());
}

/** The `since` of each `office.digest` read so far, by office, in order. */
function digestReads(reads: readonly { name: string; args: unknown }[]) {
  return reads
    .filter((read) => read.name === "office.digest")
    .map((read) => read.args as { office: string; since?: string });
}

/** Waits until the TUI sent `count` digest reads. */
async function readsReach(reads: readonly { name: string; args: unknown }[], count: number) {
  for (let i = 0; i < 200 && digestReads(reads).length < count; i += 1) await Bun.sleep(10);
  expect(digestReads(reads)).toHaveLength(count);
}

const ITEM = DeskItem.parse({
  kind: "QUESTION",
  story: "DIPO-19",
  detail: '"Is a 404 on an empty office ok?"',
  since: "2026-10-14T10:00:00.000Z",
  blocks: [],
  actions: [],
});

describe("the Since band", () => {
  it("sends the time it last left the office as since and shows the band above the Desk", async () => {
    const view = await mount({ columns: 112, rows: 30 });
    mounted.push(view.ui);
    view.session.desk = [ITEM];
    view.session.digest = {
      since: SINCE,
      counts: { done: 1, parked: 1, parkedByYou: 1, questions: 1, merges: 0, proposals: 2 },
      lines: ["DIPO-12 done", "DIPO-26 parked: needs-permission"],
      spent: 4.1,
    };
    await view.ui.waitFor("daemon live");
    await readsReach(view.session.reads, 1);
    const opened = view.clock.now();
    view.clock.advance(5 * MINUTE);
    const leftDipsaus = view.clock.now();
    await view.store.switchTo(OFFICES.couchcade);
    await view.ui.waitFor(" couchcade ");
    await readsReach(view.session.reads, 2);
    view.clock.advance(7 * MINUTE); // time spent in couchcade: not part of the dipsaus digest
    await view.store.switchTo(OFFICES.dipsaus);
    await view.ui.waitFor("▌ ● DIPO-21");
    await readsReach(view.session.reads, 3);
    // The Floor has no since line any more (screens/02-floor.txt): the band is the Desk's.
    expect(view.ui.frame()).not.toContain("since you left");
    await view.ui.press("1");
    const frame = await view.ui.waitFor("any key to dismiss");
    const shown = lines(frame);
<<<<<<< c36baa2a4c6f2d9b574dcc92eab6648ae5e59eda
    const band = shown.findIndex((line) => line.startsWith("Since "));
    expect(shown[band]).toMatch(
      new RegExp(
        `^Since ${clockTime(Date.parse(SINCE))} · 1 merged · 2 new proposals · \\$4\\.10 spent +any key to dismiss$`,
      ),
=======
    const rule = shown.findIndex((line) => /^─+$/.test(line));
    expect(shown[rule + 1]).toBe(
      `since you left (${clockTime(Date.parse(SINCE))}): 2 done · 1 parked · 1 parked by you · 1 question`,
>>>>>>> ebd192c460fc493872823267d782eeb07cc5316a
    );
    expect(shown[band + 1]).toMatch(/^─+$/);
    expect(shown[band + 2]).toMatch(/^NEEDS YOU +1 {2}│/);
    // Any key dismisses it, and does nothing else: the focus stays.
    await view.ui.press("j");
    expect(view.ui.frame()).not.toContain("any key to dismiss");
    expect(view.ui.frame()).toContain("DIPO-19");

    // First sight of each office counts from when it opened; coming back counts from leaving.
    const reads = digestReads(view.session.reads);
    expect(reads).toEqual([
      { office: OFFICES.dipsaus, since: new Date(opened).toISOString() },
      { office: OFFICES.couchcade, since: new Date(leftDipsaus).toISOString() },
      { office: OFFICES.dipsaus, since: new Date(leftDipsaus).toISOString() },
    ]);
  });

  it("shows nothing when nothing it counts changed, and leaves out the parts that did not", () => {
    expect(
      sinceBand({ since: SINCE, counts: { done: 0, parked: 3 }, lines: [] }, 112, false),
    ).toBeNull();
    const band = sinceBand(
      { since: SINCE, counts: { done: 2, proposals: 0 }, lines: [] },
      60,
      false,
    );
    expect(band === null ? null : lineText(band)).toBe(
      `Since ${clockTime(Date.parse(SINCE))} · 2 merged${" ".repeat(20)}any key to dismiss`,
    );
    // `1 merged` is in fg, the rest dim (spec.md, Since band).
    expect(band?.find((piece) => piece.text === "2 merged")?.role).toBe("fg");
  });
});
