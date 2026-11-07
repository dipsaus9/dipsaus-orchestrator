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

  it("reads the proposal keys and the edit keys of the planning view", () => {
    const session = { ...ctx.planning, session: true, proposals: true };
    expect(texts("planning", { ...ctx, planning: session })).toContain("[Ctrl-Y] confirm");
    expect(texts("planning", { ...ctx, planning: { ...session, editing: 2 } })).toEqual([
      "[Ctrl-S] save proposal 2",
      "[Enter] new line",
      "[Esc] cancel the edit",
    ]);
  });

  it("offers Ctrl-G set Ready with proposals, and only the Ready keys while readying (DIPO-451)", () => {
    const session = { ...ctx.planning, session: true, proposals: true };
    expect(texts("planning", { ...ctx, planning: session })).toEqual([
      "[Ctrl-S] send",
      "[Enter] new line",
      "[Ctrl-E] end session",
      "[Ctrl-Y] confirm",
      "[Ctrl-R] edit",
      "[Ctrl-G] set Ready",
      "[Ctrl-D] decline",
      "[Up/Down] proposal",
      "[Esc] back",
    ]);
    expect(texts("planning", { ...ctx, planning: { ...session, readying: true } })).toEqual([
      "[Ctrl-S] set the stories left Ready",
      "[Esc] cancel",
    ]);
    expect(
      texts("planning", { ...ctx, planning: { ...session, readying: true, sending: true } }),
    ).toEqual(["[Ctrl-S] set the stories left Ready", "[Esc] cancel", "sending"]);
  });

  it("gives the question dialog its keys over the input's, with sending (DIPO-455)", () => {
    const session = { ...ctx.planning, session: true, proposals: true };
    const choosing = { ...session, dialog: { typing: false, complete: false } };
    expect(texts("planning", { ...ctx, planning: choosing })).toEqual([
      "[Ctrl-S] send (when all answered)",
      "[Enter] pick",
      "[Up/Down] option",
      "[Left/Right] question",
      "[Ctrl-N] write a message instead",
    ]);
    const complete = { ...session, sending: true, dialog: { typing: false, complete: true } };
    expect(texts("planning", { ...ctx, planning: complete })).toContain(
      "[Ctrl-S] send the answers",
    );
    expect(texts("planning", { ...ctx, planning: complete }).at(-1)).toBe("sending");
    const typing = { ...session, dialog: { typing: true, complete: false } };
    expect(texts("planning", { ...ctx, planning: typing })).toEqual([
      "[Enter] take the answer",
      "[Esc] back to the options",
    ]);
  });

  it("gives the retro view scroll, back and quit (DIPO-453)", () => {
    expect(texts("retro")).toEqual(["[j/k] scroll", "[Esc] back", "[q] quit"]);
  });

  it("fits the width by dropping the lowest priority and keeps quit", () => {
    const hints = footerHints("queue", ctx);
    const line = fitHints(hints, 30);
    expect(line.length).toBeLessThanOrEqual(30);
    expect(line).toContain("[q] quit");
    expect(fitHints(hints, 10)).toBe("[q] quit");
  });
});
