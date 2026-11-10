// The footer's hints come from the key registry (DIPO-457, DIPO-458): by view, with `when`, as
// `key label` with the verbs left and the global keys right, fitted to the width with `q q quit`
// kept; offline only the reading keys stay, then `actions off while offline`.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { fitHints, footerLine } from "./footer";
import {
  FOOTER_KEYS,
  footerHints,
  type FooterContext,
  type FooterView,
  hintText,
  NAV_KEYS,
} from "./keys";

const ctx: FooterContext = {
  offline: false,
  office: true,
  hasRow: true,
  planningOpen: false,
  narrow: false,
  planning: {
    session: false,
    sending: false,
    confirmingEnd: false,
    editing: null,
    proposals: false,
    readying: false,
    dialog: null,
  },
};

const texts = (view: FooterView, c: FooterContext = ctx) => footerHints(view, c).map(hintText);
const line = (view: FooterView, width: number, c: FooterContext = ctx) =>
  footerLine(fitHints(footerHints(view, c), width), width);

const keys = (view: FooterView) => footerHints(view, ctx).map((hint) => hint.key);

describe("the footer registry", () => {
  it("gives every key an id, a key, a label and a priority", () => {
    const ids = new Set<string>();
    for (const entry of FOOTER_KEYS) {
      expect(ids.has(entry.id)).toBe(false);
      ids.add(entry.id);
      expect(entry.label).not.toBe("");
      expect(entry.priority).toBeGreaterThan(0);
    }
  });

  it("reads the hints of a view and its conditions from the registry, global keys at the right", () => {
    expect(texts("desk")).toEqual([
      "↑↓ move",
      "⏎ open story",
      "c copy id",
      ": commands",
      "? keys",
      "O offices",
      "q q quit",
    ]);
    // Below 100 columns ⏎ reads the focused item in full (DIPO-459).
    expect(texts("desk", { ...ctx, narrow: true })).toContain("⏎ read");
    expect(texts("desk", { ...ctx, hasRow: false, planningOpen: true })).toEqual([
      "5 plan",
      ": commands",
      "? keys",
      "O offices",
      "q q quit",
    ]);
    expect(line("queue", 100)).toMatch(
      /^↑↓ move   ⏎ story   r run   \. show done   c copy id +: commands   \? keys   O offices   q q quit$/,
    );
    expect(line("switcher", 100)).toMatch(/^↑↓ move   ⏎ open   a new path +esc back   q q quit$/);
    expect(line("switcher", 100)).toHaveLength(100);
  });

  it("keeps only the reading keys offline, then says actions are off", () => {
    expect(texts("desk", { ...ctx, offline: true })).toEqual([
      "↑↓ move",
      "⏎ open story",
      "q q quit",
    ]);
  });

  it("follows keymap.json changedFromToday: r run, p park, X drop, O offices, q q quit, y and n on a test", () => {
    expect(keys("queue")).toContain("r");
    expect(keys("queue")).not.toContain("u");
    expect(keys("desk")).toContain("O");
    expect(keys("desk")).not.toContain("o");
    expect(keys("checklist")).toEqual(["↑↓", "space", "y", "n", "esc", "q q"]);
    expect(keys("detail")).toContain("z");
    for (const view of ["desk", "overview", "queue", "detail", "card"] as const) {
      expect(keys(view)).toContain("c");
      expect(keys(view)).toContain("q q");
      // `p` is park now; privacy lives in the settings, and the digits are the rooms band's.
      expect(texts(view)).not.toContain("p privacy");
      expect(keys(view).some((key) => /^[1-6]$/.test(key))).toBe(false);
    }
  });

  it("reads the planning keys from the session state", () => {
    expect(texts("planning")).toContain("tab kind");
    expect(texts("planning")).toContain("⏎ start");
    expect(texts("planning", { ...ctx, planning: { ...ctx.planning, session: true } })).toContain(
      "⏎ send",
    );
    expect(
      texts("planning", { ...ctx, planning: { ...ctx.planning, confirmingEnd: true } }),
    ).toEqual(["y end the session", "any other key keep it"]);
  });

  it("reads the proposal keys and the edit keys of the planning view", () => {
    const session = { ...ctx.planning, session: true, proposals: true };
    expect(texts("planning", { ...ctx, planning: session })).toContain("ctrl-y confirm");
    expect(texts("planning", { ...ctx, planning: { ...session, editing: 2 } })).toEqual([
      "⏎ save proposal 2",
      "shift-⏎ new line",
      "esc cancel the edit",
    ]);
  });

  it("offers ctrl-g set Ready with proposals, and only the Ready keys while readying (DIPO-451)", () => {
    const session = { ...ctx.planning, session: true, proposals: true };
    expect(texts("planning", { ...ctx, planning: session })).toEqual([
      "⏎ send",
      "shift-⏎ new line",
      "/end end session",
      "ctrl-y confirm",
      "ctrl-r edit",
      "ctrl-g set Ready",
      "ctrl-d decline",
      "↑↓ proposal",
      "esc back",
    ]);
    expect(texts("planning", { ...ctx, planning: { ...session, readying: true } })).toEqual([
      "⏎ set the stories left Ready",
      "esc cancel",
    ]);
    expect(
      texts("planning", { ...ctx, planning: { ...session, readying: true, sending: true } }),
    ).toEqual(["⏎ set the stories left Ready", "esc cancel", "sending"]);
  });

  it("gives the question dialog its keys over the input's, with sending (DIPO-455)", () => {
    const session = { ...ctx.planning, session: true, proposals: true };
    const choosing = { ...session, dialog: { typing: false, complete: false } };
    expect(texts("planning", { ...ctx, planning: choosing })).toEqual([
      "ctrl-s send (when all answered)",
      "⏎ pick",
      "↑↓ option",
      "←→ question",
      "ctrl-n write a message instead",
    ]);
    const complete = { ...session, sending: true, dialog: { typing: false, complete: true } };
    expect(texts("planning", { ...ctx, planning: complete })).toContain("ctrl-s send the answers");
    expect(texts("planning", { ...ctx, planning: complete }).at(-1)).toBe("sending");
    const typing = { ...session, dialog: { typing: true, complete: false } };
    expect(texts("planning", { ...ctx, planning: typing })).toEqual([
      "⏎ take the answer",
      "esc back to the options",
    ]);
  });

  it("gives the retro view scroll, back and quit (DIPO-453)", () => {
    expect(texts("retro")).toEqual(["↑↓ scroll", "d discuss in a plan", "esc back", "q q quit"]);
  });

  it("fits the width by dropping the lowest priority and keeps quit", () => {
    const hints = footerHints("queue", ctx);
    const fitted = footerLine(fitHints(hints, 30), 30);
    expect(fitted.length).toBeLessThanOrEqual(30);
    expect(fitted).toContain("q q quit");
    expect(footerLine(fitHints(hints, 10), 10)).toBe("  q q quit");
  });
});

describe("the key table of DIPO-479", () => {
  const keymap = JSON.parse(
    readFileSync(new URL("../../../docs/design/tui-v2/keymap.json", import.meta.url), "utf8"),
  ) as { global: { id: string; key: string }[]; actions: { id: string; key: string }[] };
  const entries = new Map(
    [...keymap.global, ...keymap.actions].map((entry) => [entry.id, entry.key]),
  );

  it("reads the footer's keys from the registry: 5 plan, r run, d discuss, Enter send, /end", () => {
    expect(texts("desk", { ...ctx, planningOpen: true })).toContain("5 plan");
    expect(texts("queue")).toContain("r run");
    expect(texts("retro")).toContain("d discuss in a plan");
    const session = { ...ctx.planning, session: true };
    expect(texts("planning", { ...ctx, planning: session })).toEqual([
      "⏎ send",
      "shift-⏎ new line",
      "/end end session",
      "esc back",
    ]);
    expect(NAV_KEYS.find((nav) => nav.id === "planning")?.key).toBe("5");
  });

  it("is held by keymap.json", () => {
    expect(entries.get("plan")).toBe("5");
    expect(entries.get("runNow")).toBe("r");
    expect(entries.get("discussPlan")).toBe("d");
    expect(entries.get("planSend")).toBe("⏎");
    expect(entries.get("planNewLine")).toBe("shift-⏎");
    expect(entries.get("planEnd")).toBe("/end");
  });
});
