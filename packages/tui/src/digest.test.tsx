// "Since you left" on the overview (0009): the TUI keeps the time it last switched away from each
// office and sends it as `since` with every `office.digest` read; an office it has not shown yet
// counts from the time it opens. The engine keeps no last-seen time (0001).

import { afterEach, describe, expect, it } from "bun:test";

import { digestLine } from "./digest";
import { OFFICES } from "../test/support/fake-session";
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

describe("the since-you-left line", () => {
  it("sends the time it last left the office as since and shows the line under the count line", async () => {
    const view = await mount({ columns: 120, rows: 30 });
    mounted.push(view.ui);
    view.session.digest = {
      since: SINCE,
      counts: { done: 2, parked: 1, parkedByYou: 1, questions: 1, merges: 0, proposals: 0 },
      lines: ["DIPO-12 done", "DIPO-14 done", "DIPO-26 parked: needs-permission"],
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
    await view.ui.waitFor("3 running");
    await readsReach(view.session.reads, 3);
    const frame = await view.ui.waitFor("since you left");
    const shown = lines(frame);
    const count = shown.findIndex((line) => /^ \d+ running · /.test(line));
    expect(shown[count + 1]).toBe(
      ` since you left (${clockTime(Date.parse(SINCE))}): 2 done · 1 parked · 1 parked by you · 1 question`,
    );

    // First sight of each office counts from when it opened; coming back counts from leaving.
    const reads = digestReads(view.session.reads);
    expect(reads).toEqual([
      { office: OFFICES.dipsaus, since: new Date(opened).toISOString() },
      { office: OFFICES.couchcade, since: new Date(leftDipsaus).toISOString() },
      { office: OFFICES.dipsaus, since: new Date(leftDipsaus).toISOString() },
    ]);
  });

  it("says nothing changed when every count is zero", () => {
    expect(digestLine({ since: SINCE, counts: { done: 0, parked: 0 }, lines: [] }, "·")).toBe(
      `since you left (${clockTime(Date.parse(SINCE))}): nothing changed`,
    );
  });
});
