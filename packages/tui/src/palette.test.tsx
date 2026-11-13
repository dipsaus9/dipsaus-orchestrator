// The command palette and the keys overlay (DIPO-463 test plan): the fuzzy match, the order of the
// groups, the reasons of the rows that are off, the keys overlay holding the same keys as the
// footer registry, and the palette in the TUI: stopping a run asks first and the privacy
// confirmation stays.

import { afterEach, describe, expect, it } from "bun:test";

import { DeskItem } from "@dipsaus-orchestrator/contract";

import { helpKeys } from "./help";
import { leavesOverlay } from "./home";
import { NAV_KEYS, rowKeys } from "./keys";
import { filterRows, fuzzyMatch, NO_FOCUS, type PaletteFocus, paletteRows } from "./palette";
import { mount } from "../test/support/setup";

const mounted: { unmount(): Promise<void> }[] = [];

afterEach(async () => {
  for (const ui of mounted.splice(0)) await ui.unmount();
});

const mergeFocus: PaletteFocus = {
  ...NO_FOCUS,
  view: "desk",
  kind: "MERGE",
  label: "DIPO-446",
  story: "DIPO-446",
  commands: new Set(["gate.approve", "gate.reject", "test.start"]),
  typed: ["dipo approve DIPO-446 --note"],
};

describe("the palette's fuzzy match", () => {
  it("matches a subsequence without case and returns where", () => {
    expect(fuzzyMatch("pa", "Park run")).toEqual([0, 1]);
    expect(fuzzyMatch("pk", "Park run")).toEqual([0, 3]);
    expect(fuzzyMatch("PRU", "Park run")).toEqual([0, 2, 6]);
    expect(fuzzyMatch("zz", "Park run")).toBeNull();
    expect(fuzzyMatch("", "Park run")).toEqual([]);
  });

  it("takes the tightest match, not the first", () => {
    // `pa` is at the start of "Park", but "Expand" holds it as one run of two letters too; in
    // "a p…" the first p and the a after it are far apart, the later pair is not.
    expect(fuzzyMatch("pa", "Spread, pa")).toEqual([8, 9]);
  });
});

describe("the palette's rows", () => {
  it("lists the item's actions first, then settings, then navigation, each with its key", () => {
    const rows = paletteRows(mergeFocus, false);
    const groups = rows.map((row) => row.group);
    expect(groups).toEqual([...groups].toSorted((a, b) => order(a) - order(b)));
    expect(new Set(groups)).toEqual(new Set(["on", "settings", "goto"]));
    const approve = rows.find((row) => row.label === "Approve");
    expect(approve).toMatchObject({ group: "on", key: "y", disabled: null });
    expect(rows.find((row) => row.label === "Go to queue")).toMatchObject({ key: "3" });
    expect(rows.find((row) => row.group === "settings")?.label).toContain("Privacy");
  });

  it("keeps an action the item does not offer, with its reason", () => {
    const rows = paletteRows(mergeFocus, false);
    expect(rows.find((row) => row.label === "Start again")).toMatchObject({
      key: "r",
      disabled: "not parked",
    });
    expect(rows.find((row) => row.label === "Stop run")).toMatchObject({
      key: null,
      disabled: "no run is going",
    });
    const running = paletteRows({ ...mergeFocus, running: true }, false);
    expect(running.find((row) => row.label === "Stop run")?.disabled).toBeNull();
    for (const row of paletteRows(mergeFocus, true).filter((r) => r.group === "on")) {
      expect(row.disabled).toBe("offline");
    }
  });

  it("lists the detail's own keys: z expands the stream, c copies the id", () => {
    const rows = paletteRows({ ...NO_FOCUS, view: "detail", commands: new Set() }, false);
    expect(rows.find((row) => row.label === "Expand stream to full screen")).toMatchObject({
      group: "on",
      key: "z",
      disabled: null,
      run: { kind: "key", key: "z" },
    });
    expect(rows.find((row) => row.label === "Copy id")).toMatchObject({
      key: "c",
      run: { kind: "key", key: "c" },
    });
  });

  it("filters inside the groups and keeps their order", () => {
    const rows = paletteRows(mergeFocus, false);
    const shown = filterRows(rows, "pa");
    expect(shown.map((entry) => entry.row.group)).toEqual(
      shown.map((entry) => entry.row.group).toSorted((a, b) => order(a) - order(b)),
    );
    expect(shown.some((entry) => entry.row.label === "Park")).toBe(true);
    expect(shown.some((entry) => entry.row.label === "Go to queue")).toBe(false);
    expect(filterRows(rows, "").length).toBe(rows.length);
    expect(filterRows(rows, "qqqq")).toEqual([]);
  });
});

describe("the navigation keys", () => {
  it("are exactly the keys that leave an overlay for a room: 1 to 6 and O", () => {
    const keys = NAV_KEYS.map((nav) => nav.key);
    expect(keys.toSorted()).toEqual(["1", "2", "3", "4", "5", "6", "O"]);
    for (const key of keys) expect(leavesOverlay(key)).toBe(true);
    for (const key of ["7", "o", "p", "P", ":", "?"]) expect(leavesOverlay(key)).toBe(false);
  });
});

function order(group: string): number {
  return group === "on" ? 0 : group === "settings" ? 1 : 2;
}

describe("the keys overlay", () => {
  it("lists the same keys as the footer registry gives the item", () => {
    const item = DeskItem.parse({
      kind: "MERGE",
      story: "DIPO-446",
      key: "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C12",
      gate: "gat_01J9ZK5Q8W3V4X6Y7Z8A9B0G12",
      detail: "reviewer passed",
      since: "2026-10-14T10:00:00.000Z",
      blocks: [],
      actions: [
        { command: "gate.approve", cli: "dipo approve DIPO-446" },
        { command: "gate.reject", cli: "dipo reject DIPO-446" },
        { command: "test.start", cli: "dipo test DIPO-446" },
      ],
    });
    const registry = rowKeys(item).bound.map((entry) => entry.binding.key);
    const focus: PaletteFocus = {
      ...mergeFocus,
      commands: new Set(item.actions.map((action) => action.command)),
    };
    const keys = helpKeys(focus, false, "");
    const offered = keys.item.filter((entry) => entry.off === null).map((entry) => entry.key);
    // Every key the footer prints for the row is in the overlay, as an offered key.
    for (const key of registry) expect(offered).toContain(key);
    // And the overlay offers nothing the registry does not give the row, but `i` for an idea.
    expect(offered.filter((key) => !registry.includes(key))).toEqual(["i"]);
    expect(keys.item.find((entry) => entry.key === "r")?.off).toBe("not parked");
    expect(keys.typed).toEqual(["dipo approve DIPO-446 --note"]);
    expect(keys.global.map((entry) => entry.key)).toEqual(
      expect.arrayContaining(["1–4", "5", "O", ": ctrl-k", "?", "q q"]),
    );
  });

  it("filters by what is typed", () => {
    const keys = helpKeys(mergeFocus, false, "appr");
    expect(keys.item.map((entry) => entry.label)).toEqual(["Approve"]);
    expect(keys.move).toEqual([]);
  });
});

async function open() {
  const view = await mount({ columns: 120, rows: 30 });
  mounted.push(view.ui);
  await view.ui.waitFor("daemon live");
  return view;
}

describe("the palette in the TUI", () => {
  it("opens with : or Ctrl-K over the focused row and closes with Esc", async () => {
    const { ui } = await open();
    await ui.press(":");
    let frame = await ui.waitFor("GO TO");
    expect(frame).toContain("SETTINGS");
    expect(frame).toContain("Privacy: what dipo stores");
    expect(frame).toContain("⏎ run   ↑↓ choose   esc close");
    await ui.press("escape");
    await ui.waitFor(": commands");
    await ui.press("?");
    frame = await ui.waitFor("ANYWHERE");
    expect(frame).toContain("type to search");
    expect(frame).toContain("Lowercase acts on this item. Capitals spend or destroy.");
    await ui.press("escape");
    await ui.waitFor(": commands");
  });

  it("stops a run only from the palette, and asks first", async () => {
    const { ui, session } = await open();
    await ui.press(":");
    const frame = await ui.waitFor("Stop run");
    expect(frame).not.toContain("no run is going");
    await ui.press("stop");
    await ui.press("enter");
    await ui.waitFor("Stop the run of");
    // No: nothing is sent.
    await ui.press("n");
    await Bun.sleep(50);
    expect(session.commands.filter((command) => command.name === "story.park")).toEqual([]);
    await ui.press(":");
    await ui.waitFor("Stop run");
    await ui.press("stop");
    await ui.press("enter");
    await ui.waitFor("Stop the run of");
    await ui.press("y");
    await ui.waitFor("stop note for");
    await ui.press("not needed now");
    await ui.press("enter");
    const limit = performance.now() + 2_000;
    while (!session.commands.some((command) => command.name === "story.park")) {
      if (performance.now() > limit) throw new Error("no story.park was sent");
      await Bun.sleep(10);
    }
    expect(session.commands.find((command) => command.name === "story.park")?.args).toMatchObject({
      note: "not needed now",
    });
  });

  it("opens the plan with P and the retro with the palette", async () => {
    const { ui } = await open();
    await ui.press("5");
    await ui.waitFor("esc back");
    await ui.press("escape");
    await ui.waitFor(": commands");
    await ui.press(":");
    await ui.press("retro");
    await ui.press("enter");
    await ui.waitFor("↑↓ scroll");
  });
});
