// The Desk (`1`, 0009, DIPO-132, DIPO-308, DIPO-459): what waits on the maintainer, read from
// `office.desk` and shown in the engine's order (spec.md, Desk; screens/14, 01, 11, 16).
//
// At 100 columns or wider it is a list (46 columns) and a preview of the focused item
// (`desk-preview.ts`), split by a faint rule: the bold `NEEDS YOU` heading with its count, then one
// dim header per kind in the order the engine's items come in (the engine orders them by
// `KNOWN_DESK_KINDS`, the setup kinds first, so grouping keeps its order; the TUI never re-sorts),
// a blank row between groups. A row is the focus column (`▌`), the kind's glyph, the title and the
// age; its second, dim row is the reason and `blocks N`. Verbs live in the preview and the footer,
// never on a row. Above the list the Since band says what changed since the maintainer last looked
// (`office.digest`), until any key dismisses it. Below 100 columns the Desk is the list alone, each
// row keeping its second row, and Enter opens the preview full screen.
//
// An action started on a row shows on it while it is on its way (`◌ accepting…`) and its result in
// place until the desk is read again (`✓ accepted · draft-31`, or `✗ accept failed: …` with
// `^R retry`), so focus never jumps. An empty Desk says `✓ Nothing needs you.` and what the team is
// doing.
//
// No event carries the desk, so `useDesk` reads `office.desk` again after every office event that
// can change it and after the store read the office again (a stream reset or a switch), at most
// once a second. The TUI never orders, filters or derives a desk item itself.

import type { OfficeStore } from "@dipsaus-orchestrator/client";
import {
  type Clock,
  DESK_LOADING_KIND,
  type DeskItem,
  type EngineError,
  type Event,
  NEXT_UP_AUTO_START_LINE,
  type OfficeId,
  type TimerHandle,
} from "@dipsaus-orchestrator/contract";
import { Box } from "ink";
import { useEffect, useRef, useState } from "react";

import type { ActionState } from "./actions";
import type { Role } from "./colour";
import type { DigestResult } from "./digest";
import { age, truncate } from "./format";
import type { Display } from "./options";
import {
  fitLine,
  lineWidth,
  seg,
  selected,
  type Seg,
  type SegLine,
  SegRow,
  spread,
} from "./segments";
import { clockTime, glyphs } from "./views";

/** An accepted idea queued in the lane: its title and the backlog PR it waits on, as words. */
export interface QueuedAccept {
  readonly title: string;
  readonly waits: string;
}

/**
 * The line of an accepted idea the lane queued and has not filed (DIPO-481); it stays until the
 * engine's snapshot has no open change left.
 */
export function queuedLine(queued: QueuedAccept, width: number, ascii: boolean): SegLine {
  const g = glyphs(ascii);
  const head = `${g.pending} queued: `;
  const room = Math.max(1, width - head.length - queued.waits.length - 8);
  return [
    seg(head, "dim"),
    seg(truncate(queued.title, room, g.ellipsis)),
    seg(` ${g.dot} waits for ${queued.waits}`, "dim"),
  ];
}

/** The narrowest terminal that splits the Desk into a list and a preview (spec.md, Widths). */
export const DESK_SPLIT_COLUMNS = 100;

/** The list's width beside the preview. */
export const DESK_LIST_COLUMNS = 46;

/** The desk reads `office.desk` at most this often. */
export const DESK_READ_INTERVAL_MS = 1_000;

/** Said by an empty desk (screens/12-states.txt, mock 16). */
export const EMPTY_DESK = "Nothing needs you.";

/** The office events after which the desk may have changed (DIPO-308). */
export const DESK_EVENTS: ReadonlySet<string> = new Set([
  "story.parked",
  "gate.reached",
  "gate.decided",
  "question.asked",
  "question.closed",
  "test.started",
  "test.recorded",
  "test.ended",
  "note.closed",
  "idea.passed",
  "idea.answered",
  "story.pr",
  "work.phase",
]);

/**
 * The `engine.notice` codes of the office's starts paused and its lift (0020, DIPO-359), and of a
 * story newly offered as next up (0010, DIPO-440), and of a start that did not go on, whose reason
 * its NEXT UP item shows (DIPO-488).
 */
export const DESK_NOTICES: ReadonlySet<string> = new Set([
  "office.startsPaused",
  "office.startsResumed",
  "run.nextUp",
  "setup.failed",
  "run.startAborted",
]);

/**
 * True when `event` can change the desk: a desk event, the office's starts paused or lifted, or a
 * story leaving Parked.
 */
export function changesDesk(event: Event): boolean {
  if (DESK_EVENTS.has(event.type)) return true;
  if (event.type === "engine.notice") {
    const code = (event.data as { code?: unknown }).code;
    return typeof code === "string" && DESK_NOTICES.has(code);
  }
  if (event.type !== "story.state") return false;
  const data = event.data as { from?: unknown; to?: unknown };
  return data.from === "Parked" && data.to !== "Parked";
}

export type DeskOutcome =
  | { readonly ok: true; readonly result: readonly DeskItem[] }
  | { readonly ok: false; readonly error: EngineError };

export type ReadDesk = (office: OfficeId) => Promise<DeskOutcome>;

/** What the desk view shows: the last items read, or why none could be. */
export interface DeskState {
  readonly items: readonly DeskItem[] | null;
  readonly error: EngineError | null;
}

/**
 * Reads `office.desk` while `active`: once when it starts, then after each desk-changing event of
 * the office and after each snapshot the store applies, at most once per `DESK_READ_INTERVAL_MS`.
 * A read answered for another office than the open one is dropped.
 */
export function useDesk(options: {
  readonly store: OfficeStore;
  readonly clock: Clock;
  readonly readDesk: ReadDesk;
  readonly office: OfficeId | null;
  readonly active: boolean;
  readonly snapshots: number;
}): DeskState {
  const { store, clock, readDesk, office, active, snapshots } = options;
  const [state, setState] = useState<DeskState>({ items: null, error: null });
  // The pacing: a read starts a quiet interval; a change in it reads once more at its end.
  const pacing = useRef<{ timer: TimerHandle | null; again: boolean }>({
    timer: null,
    again: false,
  });

  useEffect(() => {
    setState({ items: null, error: null });
  }, [office]);

  useEffect(() => {
    if (!active || office === null) return;
    let stopped = false;
    const pace = pacing.current;
    const read = () => {
      pace.again = false;
      pace.timer = clock.setTimeout(() => {
        pace.timer = null;
        if (!stopped && pace.again) read();
      }, DESK_READ_INTERVAL_MS);
      void readDesk(office).then((outcome) => {
        if (stopped || store.state.office !== office) return;
        setState(
          outcome.ok
            ? { items: outcome.result, error: null }
            : (previous) => ({ items: previous.items, error: outcome.error }),
        );
      });
    };
    const request = () => {
      if (pace.timer === null) read();
      else pace.again = true;
    };
    request();
    const stop = store.onOfficeEvent((event) => {
      if (changesDesk(event)) request();
    });
    return () => {
      stopped = true;
      stop();
      if (pace.timer !== null) clock.clearTimeout(pace.timer);
      pace.timer = null;
      pace.again = false;
    };
  }, [store, clock, readDesk, office, active, snapshots]);

  return state;
}

/** The identity of a desk row, so the selection follows it when the desk is read again. */
export function deskRowId(item: DeskItem): string {
  return [
    item.kind,
    item.key ?? "",
    item.question ?? "",
    item.gate ?? "",
    item.note?.id ?? "",
    item.idea?.id ?? "",
    item.pr?.number ?? "",
  ].join(":");
}

/** The kind of a desk item for a story the maintainer parked (0020). */
export const PARKED_BY_YOU = "PARKED BY YOU";

/** One group of the list: a kind and its items, in the engine's order. */
export interface DeskGroup {
  readonly kind: string;
  readonly items: readonly DeskItem[];
}

/**
 * The desk's items by kind, each kind where its first item comes in the engine's order, so the
 * order the engine gives (`KNOWN_DESK_KINDS`) stays; `all` is the order focus moves in.
 */
export function deskGroups(items: readonly DeskItem[]): {
  readonly groups: readonly DeskGroup[];
  readonly all: readonly DeskItem[];
} {
  const groups: { kind: string; items: DeskItem[] }[] = [];
  for (const item of items) {
    const group = groups.find((candidate) => candidate.kind === item.kind);
    if (group === undefined) groups.push({ kind: item.kind, items: [item] });
    else group.items.push(item);
  }
  return { groups, all: groups.flatMap((group) => group.items) };
}

/** The items that need the maintainer, for the heading's count: not the ones they parked. */
export function needsYou(items: readonly DeskItem[]): number {
  return items.filter((item) => item.kind !== PARKED_BY_YOU && item.kind !== DESK_LOADING_KIND)
    .length;
}

/** A group's header (spec.md, Group names): PROFILE is `SETUP`, proposals are from your AI team. */
export function groupName(kind: string, narrow: boolean): string {
  if (kind === "PROFILE") return "SETUP";
  if (kind === "PROPOSED STORY") return narrow ? "PROPOSALS" : "PROPOSALS · from your AI team";
  return kind;
}

/** The selected row: by its id, else the first row of the same story, else the same index. */
export function selectedRow(
  rows: readonly DeskItem[],
  selection: { readonly id: string | null; readonly key: string | null; readonly index: number },
): number {
  if (rows.length === 0) return -1;
  const byId = rows.findIndex((item) => deskRowId(item) === selection.id);
  if (byId !== -1) return byId;
  const byKey = selection.key === null ? -1 : rows.findIndex((item) => item.key === selection.key);
  if (byKey !== -1) return byKey;
  return Math.max(0, Math.min(rows.length - 1, selection.index));
}

/** `review-blocked` for a park; empty for an item that is no park. */
export function parkWords(item: DeskItem): string {
  return item.reason ?? "";
}

/**
 * The kind's glyph and its role (spec.md, Kind glyphs): `!` paused, `?` question, `○` a waiting
 * gate, `✗` a park or a setup issue, `◆` a proposal, `→` next up. Each reads without colour.
 */
export function kindGlyph(
  item: DeskItem,
  ascii: boolean,
): { readonly glyph: string; readonly role: Role } {
  const g = glyphs(ascii);
  switch (item.kind) {
    case "STARTS PAUSED":
      return { glyph: "!", role: "acc" };
    case "QUESTION":
      return { glyph: "?", role: "acc" };
    case "PARKED":
      return item.reason === "ambiguous-spec"
        ? { glyph: "?", role: "acc" }
        : { glyph: g.failed, role: "err" };
    case "PROFILE":
    case "PARK NOT WRITTEN":
      return { glyph: g.failed, role: "err" };
    case "PROPOSED STORY":
    case "DECISION NOTE":
      return { glyph: ascii ? "#" : "◆", role: "acc" };
    case "NEXT UP":
      return { glyph: ascii ? ">" : "→", role: "ok" };
    case PARKED_BY_YOU:
      return { glyph: g.idle, role: "dim" };
    case DESK_LOADING_KIND:
      return { glyph: g.pending, role: "dim" };
    default:
      return { glyph: g.idle, role: "acc" };
  }
}

/** What a row's facts are, from the item and the store's story titles. */
export interface RowFacts {
  readonly title: string;
  /** The dim second row; "" for none. */
  readonly second: string;
}

/** A row's title and second row (spec.md, Row): the story with its title, then the reason and blocks. */
export function rowFacts(item: DeskItem, storyTitle: string | null, dot: string): RowFacts {
  const story = item.story === undefined ? null : String(item.story);
  const join = (...parts: string[]) => parts.filter((part) => part !== "").join(` ${dot} `);
  // Refined stories wait for the maintainer, so they are not counted as blocked (DIPO-484).
  const refined = item.refined?.length ?? 0;
  const blocks = join(
    item.blocks.length === 0 ? "" : `blocks ${item.blocks.length}`,
    refined === 0 ? "" : `${refined} Refined, not Ready yet`,
  );
  if (item.kind === "PROFILE")
    return { title: item.detail, second: "blocks every story in this office" };
  if (item.idea !== undefined) {
    const source = item.idea.story.sourceStory ?? story ?? "";
    return { title: item.idea.title, second: join(item.idea.origin, source, blocks) };
  }
  if (item.note !== undefined) return { title: item.note.title, second: join(story ?? "", blocks) };
  if (item.kind === "PARKED" || item.kind === PARKED_BY_YOU) {
    return {
      title: story === null ? item.detail : `${story} ${storyTitle ?? item.detail}`,
      second: join(item.reason ?? "", blocks),
    };
  }
  if (story === null) return { title: item.detail, second: blocks };
  if (storyTitle === null) return { title: `${story} ${item.detail}`, second: blocks };
  return { title: `${story} ${storyTitle}`, second: join(item.detail, blocks) };
}

/** The present and past of a verb on a pending row: `accepting…`, `accepted`. */
const VERB_FORMS: Readonly<Record<string, readonly [string, string]>> = {
  accept: ["accepting", "accepted"],
  dismiss: ["dismissing", "dismissed"],
  approve: ["approving", "approved"],
  reject: ["rejecting", "rejected"],
  answer: ["answering", "answered"],
  resume: ["starting again", "started again"],
  start: ["starting", "started"],
  decline: ["declining", "declined"],
  test: ["starting the test", "test started"],
  discard: ["discarding", "discarded"],
  drop: ["dropping", "dropped"],
  park: ["parking", "parked"],
};

function verbForms(verb: string): readonly [string, string] {
  return VERB_FORMS[verb] ?? [verb, `${verb} done`];
}

/** What a list draws: its rows and which of them belong to the focused item. */
export interface ListContext {
  readonly width: number;
  readonly selected: number;
  readonly now: number;
  readonly ascii: boolean;
  /** Below 100 columns: no heading, short group names (screens/16-narrow.txt). */
  readonly narrow: boolean;
  /** A story's title by id, from the office snapshot. */
  readonly title: (story: string) => string | null;
  /** The action on its way or just answered, for the row it was started on. */
  readonly action: ActionState | null;
}

/** The pending or answered lines of the row an action was started on (spec.md, Pending and retry). */
function actionRows(action: ActionState, width: number, ascii: boolean): SegLine[] {
  const g = glyphs(ascii);
  const done = verbForms(action.verb)[1];
  if (action.status === "failed") {
    const error = action.error;
    const retry = error?.retryable === true;
    return [
      [
        seg("  "),
        seg(`${g.failed} `, "err"),
        seg(`${action.verb} failed: ${error?.code ?? "error"}`),
      ],
      [
        seg("    "),
        seg(truncate(error?.message ?? "", Math.max(0, width - 16), g.ellipsis), "dim"),
        ...(retry ? [seg(` ${g.dot} `, "dim"), seg("^R", "acc"), seg(" retry", "dim")] : []),
      ],
    ];
  }
  if (action.status !== "done") return [];
  const words = action.unchanged === true ? "already so; nothing changed" : done;
  return [
    [
      seg("  "),
      seg(`${g.met} `, "ok"),
      seg(action.note === undefined ? words : `${words} ${g.dot} ${action.note}`),
    ],
  ];
}

/** The list's rows and the range of the focused item's rows in them. */
export function listLines(
  groups: readonly DeskGroup[],
  ctx: ListContext,
): { readonly lines: SegLine[]; readonly focus: readonly [number, number] } {
  const g = glyphs(ctx.ascii);
  const lines: SegLine[] = [];
  let focus: [number, number] = [0, 0];
  if (!ctx.narrow) {
    const count = needsYou(groups.flatMap((group) => group.items));
    lines.push(spread([seg("NEEDS YOU", "hi", true)], [seg(`${count}  `, "acc")], ctx.width), []);
  }
  let index = 0;
  groups.forEach((group, n) => {
    if (n > 0) lines.push([]);
    lines.push([seg(groupName(group.kind, ctx.narrow), "dim")]);
    if (group.items.some((item) => item.autoStart !== undefined)) {
      lines.push([seg(truncate(NEXT_UP_AUTO_START_LINE, ctx.width, g.ellipsis), "dim")]);
    }
    for (const item of group.items) {
      const focused = index === ctx.selected;
      const from = lines.length;
      const facts = rowFacts(
        item,
        item.story === undefined ? null : ctx.title(String(item.story)),
        g.dot,
      );
      const action = ctx.action?.row === deskRowId(item) ? ctx.action : null;
      const pending =
        action !== null && (action.status === "sending" || action.status === "syncing");
      const { glyph, role } = pending
        ? { glyph: g.pending, role: "dim" as const }
        : kindGlyph(item, ctx.ascii);
      const right: Seg = pending
        ? seg(`${verbForms(action.verb)[0]}${g.ellipsis}  `, "dim")
        : seg(`${age(ctx.now - Date.parse(item.since))}  `, "dim");
      const room = Math.max(1, ctx.width - 4 - right.text.length - 1);
      const first: SegLine = [
        seg(focused ? `${g.bar} ` : "  ", "acc"),
        seg(`${glyph} `, role),
        seg(truncate(facts.title, room, g.ellipsis), pending ? "dim" : focused ? "hi" : undefined),
      ];
      const row = spread(first, [right], ctx.width);
      lines.push(focused ? selected(fitLine(row, ctx.width)) : row);
      if (facts.second !== "") {
        const second: SegLine = [
          seg(`    ${truncate(facts.second, ctx.width - 5, g.ellipsis)}`, "dim"),
        ];
        lines.push(focused ? selected(fitLine(second, ctx.width)) : second);
      }
      if (action !== null) lines.push(...actionRows(action, ctx.width, ctx.ascii));
      if (focused) focus = [from, lines.length - 1];
      index += 1;
    }
  });
  return { lines, focus };
}

/**
 * The Since band (spec.md, The frame): `Since 09:41 · 1 merged · 2 new proposals · $4.10 spent`
 * with `any key to dismiss` at the right; null when nothing it counts changed.
 */
export function sinceBand(digest: DigestResult, width: number, ascii: boolean): SegLine | null {
  const { dot } = glyphs(ascii);
  const merged = digest.counts["done"] ?? 0;
  const proposals = digest.counts["proposals"] ?? 0;
  const spent = digest.spent ?? 0;
  if (merged === 0 && proposals === 0 && spent === 0) return null;
  const parts: Seg[] = [seg(`Since ${clockTime(Date.parse(digest.since))}`, "dim")];
  const add = (text: string, role: Role) => parts.push(seg(` ${dot} `, "dim"), seg(text, role));
  if (merged > 0) add(`${merged} merged`, "fg");
  if (proposals > 0) add(`${proposals} new proposal${proposals === 1 ? "" : "s"}`, "dim");
  if (spent > 0) add(`$${spent.toFixed(2)} spent`, "dim");
  return spread(parts, [seg("any key to dismiss", "dim")], width);
}

/** The empty Desk (screens/12-states.txt, mock 16): reassure, say what the team does, offer the Floor. */
export function emptyLines(running: number, inReview: number, ascii: boolean): SegLine[] {
  return [
    [],
    [],
    [seg("    "), seg(glyphs(ascii).met, "ok"), seg(" "), seg(EMPTY_DESK, "hi")],
    [],
    [seg(`      The team is on it: ${running} running, ${inReview} in review.`)],
    [],
    [seg("      "), seg("2", "acc"), seg(" watch the floor")],
  ];
}

/** The rows of a preview at `height`, from `scroll` down; past its end, the last rows show (DIPO-483). */
export function previewRows(lines: readonly SegLine[], height: number, scroll: number): SegLine[] {
  const room = Math.max(1, height);
  const start = Math.max(0, Math.min(scroll, lines.length - room));
  return lines.slice(start, start + room);
}

/** The rows of a pane at `height`, scrolled so the focused range shows. */
export function windowed(
  lines: readonly SegLine[],
  height: number,
  focus: readonly [number, number],
): SegLine[] {
  const room = Math.max(1, height);
  const start = Math.max(0, Math.min(focus[1] - room + 1, focus[0]));
  return lines.slice(start, start + room);
}

export function Desk(props: {
  readonly desk: DeskState;
  /** The focused row in `deskGroups(...).all`, -1 for none. */
  readonly selected: number;
  readonly columns: number;
  readonly height: number;
  readonly now: number;
  readonly display: Display;
  readonly title: (story: string) => string | null;
  /** The focused item's preview at the pane's width (`desk-preview.ts`). */
  readonly preview: (width: number) => readonly SegLine[];
  /** Below 100 columns, Enter opened the preview full screen. */
  readonly previewOpen: boolean;
  /** The first preview row shown; PgUp and PgDn move it (DIPO-483). */
  readonly previewScroll: number;
  /** The Since band's digest, while it shows. */
  readonly since: DigestResult | null;
  readonly action: ActionState | null;
  /**
   * The accepted idea the lane has queued and not filed (DIPO-481): its title and where it waits,
   * until the snapshot says filed. Null when none.
   */
  readonly queued: QueuedAccept | null;
  /** The office's running and in-review counts, for the empty Desk. */
  readonly team: { readonly running: number; readonly inReview: number };
}) {
  const { desk, columns, display } = props;
  const g = glyphs(display.ascii);
  const width = columns - 1;
  const rows = (lines: readonly SegLine[]) => (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <SegRow key={i} line={line} display={display} />
      ))}
    </Box>
  );
  if (desk.items === null) {
    const status =
      desk.error === null
        ? `reading the desk${g.ellipsis}`
        : `desk: ${desk.error.code}: ${desk.error.message}`;
    return rows([[seg(status, "dim")]]);
  }
  const { groups, all } = deskGroups(desk.items);
  const error: SegLine[] =
    desk.error === null ? [] : [[seg(`desk: ${desk.error.code}: ${desk.error.message}`, "err")]];
  const queuedRows: SegLine[] =
    props.queued === null ? [] : [queuedLine(props.queued, width, display.ascii)];
  if (all.length === 0) {
    return rows([
      ...error,
      ...queuedRows,
      ...emptyLines(props.team.running, props.team.inReview, display.ascii),
    ]);
  }
  const narrow = columns < DESK_SPLIT_COLUMNS;
  if (narrow && props.previewOpen)
    return rows([
      ...error,
      ...previewRows(props.preview(width), props.height - error.length, props.previewScroll),
    ]);
  const band = narrow || props.since === null ? null : sinceBand(props.since, width, display.ascii);
  const top: SegLine[] = [...error, ...queuedRows];
  if (band !== null) top.push(band, [seg((display.ascii ? "-" : "─").repeat(width), "faint")]);
  const height = Math.max(1, props.height - top.length);
  const list = listLines(groups, {
    width: narrow ? width : DESK_LIST_COLUMNS,
    selected: props.selected,
    now: props.now,
    ascii: display.ascii,
    narrow,
    title: props.title,
    action: props.action,
  });
  const shown = windowed(list.lines, height, list.focus);
  if (narrow) return rows([...top, ...shown]);
  const paneWidth = width - DESK_LIST_COLUMNS - 3;
  const preview = previewRows(props.preview(paneWidth), height, props.previewScroll);
  const rule = seg(display.ascii ? "|" : "│", "faint");
  const body: SegLine[] = [];
  for (let i = 0; i < height; i++) {
    const left = fitLine(shown[i] ?? [], DESK_LIST_COLUMNS);
    const right = preview[i] ?? [];
    body.push(lineWidth(right) === 0 ? [...left, rule] : [...left, rule, seg("  "), ...right]);
  }
  return rows([...top, ...body]);
}
