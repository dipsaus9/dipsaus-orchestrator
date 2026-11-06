// The footer's hints come from the key registry (DIPO-457): by view, with `when`, fitted to the
// width with `[q] quit` kept.

import { describe, expect, it } from "bun:test";

import { fitHints } from "./footer";
import { FOOTER_KEYS, footerHints, type FooterContext, type FooterView } from "./keys";

const ctx: FooterContext = {
  offline: false,
  office: true,
  hasRow: true,
  planningOpen: false,
  planning: { session: false, sending: false, confirmingEnd: false },
};

const texts = (view: FooterView, c: FooterContext = ctx) =>
  footerHints(view, c).map(([text]) => text);

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

  it("reads the hints of a view and its conditions from the registry", () => {
    expect(texts("desk")).toEqual([
      "[Enter] detail",
      "[j/k] move",
      "[1] overview",
      "[2] queue",
      "[4] checklist",
      "[o] offices",
      "[q] quit",
    ]);
    expect(texts("desk", { ...ctx, hasRow: false, planningOpen: true })).toEqual([
      "[1] overview",
      "[2] queue",
      "[4] checklist",
      "[5] planning",
      "[o] offices",
      "[q] quit",
    ]);
    expect(texts("desk", { ...ctx, offline: true }).at(-1)).toBe(
      "[q] quit (offline: actions disabled)",
    );
  });

  it("reads the planning keys from the session state", () => {
    expect(texts("planning")).toContain("[Tab] kind");
    expect(texts("planning", { ...ctx, planning: { ...ctx.planning, session: true } })).toContain(
      "[Ctrl-S] send",
    );
    expect(
      texts("planning", { ...ctx, planning: { ...ctx.planning, confirmingEnd: true } }),
    ).toEqual(["[y] end the session", "[any other key] keep it"]);
  });

  it("fits the width by dropping the lowest priority and keeps quit", () => {
    const hints = footerHints("queue", ctx);
    const line = fitHints(hints, 30);
    expect(line.length).toBeLessThanOrEqual(30);
    expect(line).toContain("[q] quit");
    expect(fitHints(hints, 10)).toBe("[q] quit");
  });
});
