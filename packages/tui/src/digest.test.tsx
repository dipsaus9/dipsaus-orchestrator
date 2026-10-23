// "Since you left" on the overview (DIPO-308): with the `digest` capability the TUI reads
// `office.digest` without `since`, so the engine counts from when the office's last TUI client
// disconnected, and shows one line from it under the count line.

import { afterEach, describe, expect, it } from "bun:test";

import { digestLine } from "./digest";
import { OFFICES } from "./testing/fake-session";
import { mount } from "./testing/setup";
import { clockTime } from "./views";

const mounted: { unmount(): Promise<void> }[] = [];
const SINCE = "2026-10-14T08:30:00.000Z";

afterEach(async () => {
  for (const ui of mounted.splice(0)) await ui.unmount();
});

function lines(frame: string): string[] {
  return frame.split("\n").map((line) => line.trimEnd());
}

describe("the since-you-left line", () => {
  it("reads office.digest without since and shows its line under the count line", async () => {
    const view = await mount({ columns: 120, rows: 30, capabilities: ["digest"] });
    mounted.push(view.ui);
    view.session.digest = {
      since: SINCE,
      counts: { done: 2, parked: 1, held: 0, questions: 1, merges: 0, proposals: 0 },
      lines: ["DIPO-12 done", "DIPO-14 done", "DIPO-26 parked: needs-permission"],
    };
    // The store opened the office before the App mounted; switching back reads it again.
    await view.ui.waitFor("· live");
    await view.store.switchTo(OFFICES.couchcade);
    await view.ui.waitFor(" couchcade ");
    await view.store.switchTo(OFFICES.dipsaus);
    await view.ui.waitFor("3 running");
    const frame = await view.ui.waitFor("since you left");
    const shown = lines(frame);
    const count = shown.findIndex((line) => /^ \d+ running · /.test(line));
    expect(shown[count + 1]).toBe(
      ` since you left (${clockTime(Date.parse(SINCE))}): 2 done · 1 parked · 1 question`,
    );
    const reads = view.session.reads.filter((read) => read.name === "office.digest");
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) expect(read.args).not.toHaveProperty("since");
  });

  it("shows no line without the digest capability", async () => {
    const view = await mount({ columns: 120, rows: 30 });
    mounted.push(view.ui);
    view.session.digest = { since: SINCE, counts: { done: 1 }, lines: [] };
    await view.ui.waitFor("· live");
    expect(view.ui.frame()).not.toContain("since you left");
    expect(view.session.reads.some((read) => read.name === "office.digest")).toBe(false);
  });

  it("says nothing changed when every count is zero", () => {
    expect(digestLine({ since: SINCE, counts: { done: 0, parked: 0 }, lines: [] }, "·")).toBe(
      `since you left (${clockTime(Date.parse(SINCE))}): nothing changed`,
    );
  });
});
