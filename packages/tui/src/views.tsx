// Presentational pieces of the TUI (0009, DIPO-458): the header, the rooms band and the Offices
// view. They render store state as the engine sent it; every state is a word plus a glyph (an
// ASCII twin under `--ascii`), colour is extra.
//
// The header is `dipo / <office>`, `+N elsewhere · O` when other offices need the maintainer, then
// at the right `● plan open` on the Desk while a planning session is open (DIPO-459), the daemon
// chip, spend today and the time. The daemon chip is the one place the
// connection and the daemon state show: `● daemon live`, `◌ daemon recovering`, `✗ offline since
// 13:40 · view frozen`, `✗ daemon stopped`.

import { type OfficeEntry, type OfficeStoreState, percent } from "@dipsaus-orchestrator/client";
import type { OfficeSummary } from "@dipsaus-orchestrator/contract";
import { Box, Text } from "ink";

import { Colored, type Role } from "./colour";
import type { Display } from "./options";

/** The glyphs of the TUI and their `--ascii` twins (spec.md, Glyphs). */
export function glyphs(ascii: boolean) {
  return {
    bar: ascii ? ">" : "▌",
    dot: ascii ? "-" : "·",
    dash: ascii ? "-" : "–",
    ellipsis: ascii ? "..." : "…",
    live: ascii ? "*" : "●",
    idle: ascii ? "o" : "○",
    pending: ascii ? "~" : "◌",
    failed: ascii ? "x" : "✗",
    met: ascii ? "+" : "✓",
    done: ascii ? "=" : "━",
  };
}

/** The privacy opt-ins on for the selected office, from its `office.summary` (DIPO-83). */
export function officeOptIns(state: OfficeStoreState): readonly string[] {
  return state.offices.find((entry) => entry.office === state.office)?.summary?.optIns ?? [];
}

/** The stored data each privacy setting names (0007, DIPO-135). */
const STORED_WORDS: Readonly<Record<string, string>> = {
  "privacy.storeCommandBodies": "stores commands",
  "privacy.storePrompts": "stores prompts",
  "privacy.keepRawEvents": "keeps raw events",
};

/**
 * What the privacy settings that are on store, as words such as `stores commands`, so the
 * maintainer sees what is kept beyond the summary (0007); "" when none is on. Commands
 * are stored by default (DIPO-135), so this label shows on a default office.
 */
export function storedLabel(optIns: readonly string[]): string {
  if (optIns.length === 0) return "";
  return optIns.map((key) => STORED_WORDS[key] ?? key.replace(/^privacy\./, "")).join(", ");
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `HH:MM` in the local time zone. */
export function clockTime(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function isOffline(state: OfficeStoreState): boolean {
  return state.connection === "reconnecting" || state.connection === "closed";
}

/** Offline after the daemon said it stops: the daemon is stopped, not merely out of reach. */
export function daemonStopped(state: OfficeStoreState): boolean {
  return isOffline(state) && state.daemon === "draining";
}

export function officeName(state: OfficeStoreState): string | null {
  if (state.office === null) return null;
  return state.offices.find((entry) => entry.office === state.office)?.name ?? state.office;
}

/** The daemon chip of the header: a glyph and a word, each in its role. */
export interface DaemonChip {
  readonly glyph: string;
  readonly glyphRole: Role;
  readonly word: string;
  readonly wordRole: Role | undefined;
}

function makeChip(
  glyph: string,
  glyphRole: Role,
  word: string,
  wordRole: Role | undefined,
): DaemonChip {
  return { glyph, glyphRole, word, wordRole };
}

/** The connection and the daemon state as one chip (spec.md, The frame and States). */
export function daemonChip(state: OfficeStoreState, ascii: boolean): DaemonChip {
  const g = glyphs(ascii);
  if (daemonStopped(state)) return makeChip(g.failed, "err", "daemon stopped", "err");
  if (isOffline(state)) {
    const since = state.offlineSince === null ? "" : ` since ${clockTime(state.offlineSince)}`;
    return makeChip(g.failed, "err", `offline${since} ${g.dot} view frozen`, "err");
  }
  if (state.connection === "idle" || state.connection === "connecting") {
    return makeChip(g.pending, "dim", `connecting${g.ellipsis}`, "dim");
  }
  const ended = state.streamError;
  if (ended !== null) {
    return makeChip(g.failed, "err", `stream ended: ${ended.code}: ${ended.message}`, "err");
  }
  switch (state.daemon) {
    case "starting":
    case "recovering":
      return makeChip(g.pending, "acc", "daemon recovering", "acc");
    case "draining":
      return makeChip(g.pending, "acc", "daemon stopping", "acc");
    default:
      break;
  }
  if (!state.live || state.offlineSince !== null) {
    return makeChip(g.pending, "dim", "daemon catching up", "dim");
  }
  return makeChip(g.live, "ok", "daemon live", undefined);
}

/** Dollars as `$19.14`. */
function dollars(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** An office's spend today, from `dayUsage.estimatedCost` on its summary; null when unknown. */
export function spendToday(summary: OfficeSummary | undefined): number | null {
  const day = summary?.dayUsage;
  if (day === undefined) return null;
  if (day.estimatedCost !== undefined) return day.estimatedCost;
  return day.tokens === 0 ? 0 : null;
}

/** `$19.14 today` for the open office, or `$27.10 today, all offices` on Offices; null when unknown. */
export function spendText(state: OfficeStoreState, allOffices: boolean): string | null {
  if (!allOffices) {
    const spend = spendToday(state.offices.find((entry) => entry.office === state.office)?.summary);
    return spend === null ? null : `${dollars(spend)} today`;
  }
  const known = state.offices
    .map((entry) => spendToday(entry.summary))
    .filter((spend) => spend !== null);
  if (known.length === 0) return null;
  return `${dollars(known.reduce((sum, spend) => sum + spend, 0))} today, all offices`;
}

/** What waits on the maintainer in the offices that are not open (`+2 elsewhere · O`). */
export function elsewhere(state: OfficeStoreState): number {
  return state.offices
    .filter((entry) => entry.office !== state.office)
    .reduce((sum, entry) => sum + (entry.summary?.waitingOnMaintainer ?? 0), 0);
}

/** The header's parts as plain text. */
export interface HeaderText {
  /** `dipo / dipsaus-orchestrator`. */
  readonly left: string;
  /** `   +2 elsewhere · O`, or "". */
  readonly elsewhere: string;
  /** `● plan open` and four spaces, or "". */
  readonly plan: string;
  /** The daemon chip, then spend today and the time, four spaces apart. */
  readonly right: string;
}

export function headerText(
  state: OfficeStoreState,
  ascii: boolean,
  now: number,
  title?: string,
  planOpen = false,
): HeaderText {
  const g = glyphs(ascii);
  const offices = title !== undefined;
  const place = title ?? officeName(state) ?? "no office";
  const others = offices ? 0 : elsewhere(state);
  const chip = daemonChip(state, ascii);
  const spend = spendText(state, offices);
  // Offline the chip says when the view froze; spend and time would read as live.
  const offline = isOffline(state);
  return {
    left: `dipo / ${place}`,
    elsewhere: others === 0 ? "" : `   +${others} elsewhere ${g.dot} O`,
    plan: planOpen && !offline ? `${g.live} plan open    ` : "",
    right: [
      `${chip.glyph} ${chip.word}`,
      ...(offline || spend === null ? [] : [spend]),
      ...(offline ? [] : [clockTime(now)]),
    ].join("    "),
  };
}

/** The minimum gap between the header's left and right parts. */
const HEADER_GAP = 3;

/**
 * The header fitted to `columns` (spec.md, Widths): spend and the time go first, then the office
 * name shortens (`dipsaus-orch…`), then `+N elsewhere`; the daemon chip stays.
 */
export function fitHeader(text: HeaderText, chip: string, columns: number, ellipsis: string) {
  const width = (t: HeaderText) =>
    t.left.length + t.elsewhere.length + HEADER_GAP + t.plan.length + t.right.length;
  let fitted = text;
  if (width(fitted) > columns) fitted = { ...fitted, right: chip };
  if (width(fitted) > columns) fitted = { ...fitted, plan: "" };
  const over = width(fitted) - columns;
  if (over > 0) {
    const keep = Math.max("dipo / ".length + 4, fitted.left.length - over - ellipsis.length);
    fitted = { ...fitted, left: `${fitted.left.slice(0, keep)}${ellipsis}` };
  }
  if (width(fitted) > columns) fitted = { ...fitted, elsewhere: "" };
  return fitted;
}

/** The header as one plain line of `columns` cells. */
export function headerLine(text: HeaderText, columns: number): string {
  const used = text.left.length + text.elsewhere.length + text.plan.length + text.right.length;
  return `${text.left}${text.elsewhere}${" ".repeat(Math.max(HEADER_GAP, columns - used))}${text.plan}${text.right}`;
}

export function Header(props: {
  readonly state: OfficeStoreState;
  readonly display: Display;
  readonly now: number;
  readonly columns: number;
  /** A place that is not an office, such as `Offices`. */
  readonly title?: string;
  /** On the Desk while a planning session is open: `● plan open` at the right. */
  readonly planOpen?: boolean;
}) {
  const { state, display, now, columns } = props;
  const chip = daemonChip(state, display.ascii);
  const g = glyphs(display.ascii);
  const chipText = `${chip.glyph} ${chip.word}`;
  const text = fitHeader(
    headerText(state, display.ascii, now, props.title, props.planOpen === true),
    chipText,
    columns,
    g.ellipsis,
  );
  const place = text.left.slice("dipo / ".length);
  const others = text.elsewhere === "" ? 0 : elsewhere(state);
  const tail = text.right.slice(chipText.length);
  const used = text.left.length + text.elsewhere.length + text.plan.length + text.right.length;
  return (
    <Text wrap="truncate-end">
      <Colored display={display} role="acc" bold>
        dipo
      </Colored>
      <Colored display={display} role="dim">
        {" / "}
      </Colored>
      {place}
      {others === 0 ? null : (
        <>
          {"   "}
          <Colored display={display} role="acc">
            {`+${others}`}
          </Colored>
          <Colored display={display} role="dim">
            {` elsewhere ${g.dot} `}
          </Colored>
          <Colored display={display} role="acc">
            O
          </Colored>
        </>
      )}
      {" ".repeat(Math.max(HEADER_GAP, columns - used))}
      {text.plan === "" ? null : (
        <>
          <Colored display={display} role="acc">
            {g.live}
          </Colored>
          {text.plan.slice(g.live.length)}
        </>
      )}
      <Colored display={display} role={chip.glyphRole}>
        {chip.glyph}
      </Colored>
      <Colored display={display} role={chip.wordRole}>
        {` ${chip.word}`}
      </Colored>
      <Colored display={display} role="dim">
        {tail}
      </Colored>
    </Text>
  );
}

/** The rooms of an office, with the keys that switch to them. */
export type Room = "desk" | "floor" | "queue" | "retro";

const ROOMS: readonly { readonly room: Room; readonly key: string; readonly name: string }[] = [
  { room: "desk", key: "1", name: "Desk" },
  { room: "floor", key: "2", name: "Floor" },
  { room: "queue", key: "3", name: "Queue" },
  { room: "retro", key: "4", name: "Retro" },
];

/** Each room's count as the engine sent it: needs you, running, Ready·waiting; none for Retro. */
export function roomCounts(
  state: OfficeStoreState,
  ascii: boolean,
): Readonly<Record<Room, string>> {
  const summary = state.offices.find((entry) => entry.office === state.office)?.summary;
  const waiting = state.stories.filter((story) => story.column === "waiting").length;
  return {
    desk: summary === undefined ? "" : String(summary.waitingOnMaintainer),
    floor: summary === undefined ? "" : String(summary.running),
    queue: summary?.ready === undefined ? "" : `${summary.ready}${glyphs(ascii).dot}${waiting}`,
    retro: "",
  };
}

/** The rooms band as plain text: `1 Desk 6    2 Floor 2    3 Queue 1·4    4 Retro`. */
export function roomsText(state: OfficeStoreState, ascii: boolean): string {
  const counts = roomCounts(state, ascii);
  return ROOMS.map(
    ({ room, key, name }) => `${key} ${name}${counts[room] === "" ? "" : ` ${counts[room]}`}`,
  ).join("    ");
}

/** The rooms band: the current room hi and underlined, the others dim; the Desk count in acc. */
export function Rooms(props: {
  readonly state: OfficeStoreState;
  readonly display: Display;
  readonly current: Room | null;
}) {
  const { state, display, current } = props;
  const counts = roomCounts(state, display.ascii);
  return (
    <Text wrap="truncate-end">
      {ROOMS.map(({ room, key, name }, i) => {
        const count = counts[room];
        const here = room === current;
        return (
          <Text key={room}>
            {i === 0 ? "" : "    "}
            <Colored display={display} role={here ? "hi" : "dim"} underline={here}>
              {`${key} ${name}${count === "" ? "" : " "}`}
              {count === "" ? null : (
                <Colored display={display} role={room === "desk" ? "acc" : undefined}>
                  {count}
                </Colored>
              )}
            </Colored>
          </Text>
        );
      })}
    </Text>
  );
}

/** Whole days since `iso`, or null without it. */
export function idleDays(iso: string | undefined, now: number): number | null {
  if (iso === undefined) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : Math.floor(Math.max(0, now - at) / 86_400_000);
}

/** An office's state on Offices: live, starts paused or idle (spec.md, Offices). */
export type OfficeState = "live" | "paused" | "idle";

/**
 * Starts paused when the engine says so; live when open or running; idle after a whole day
 * without a change in its log (`lastActivityAt`).
 */
export function officeState(entry: OfficeEntry, open: boolean, now: number): OfficeState {
  const summary = entry.summary;
  if (summary?.startsPaused === true) return "paused";
  if (open || (summary?.running ?? 0) > 0) return "live";
  const days = idleDays(summary?.lastActivityAt, now);
  return days !== null && days >= 1 ? "idle" : "live";
}

/** The width of the TODAY bar. */
const BAR_CELLS = 12;

/** One office's cells on Offices, as text, from its `OfficeSummary`; `?` before the first one. */
export interface OfficeCells {
  readonly glyph: string;
  readonly state: OfficeState;
  readonly name: string;
  /** ` · open`, ` · starts paused`, ` · idle 3 days`. */
  readonly note: string;
  readonly needs: string;
  readonly running: string;
  readonly ready: string;
  /** The filled cells of the TODAY bar; null without a day limit. */
  readonly filled: number | null;
  /** `62%`, `96% ALERT`, or "". */
  readonly share: string;
  readonly alert: boolean;
}

/** The words after an office's name: `open`, `starts paused`, `idle 3 days`. */
function officeNotes(state: OfficeState, open: boolean, days: number | null): string[] {
  return [
    ...(open ? ["open"] : []),
    ...(state === "paused" ? ["starts paused"] : []),
    ...(state === "idle" && days !== null ? [`idle ${days} day${days === 1 ? "" : "s"}`] : []),
  ];
}

export function officeCells(
  entry: OfficeEntry,
  open: boolean,
  now: number,
  ascii: boolean,
): OfficeCells {
  const g = glyphs(ascii);
  const summary = entry.summary;
  const state = officeState(entry, open, now);
  const notes = officeNotes(state, open, idleDays(summary?.lastActivityAt, now));
  const day = summary?.dayUsage;
  const share = day?.share;
  return {
    glyph: state === "paused" ? "!" : state === "idle" ? g.idle : g.live,
    state,
    name: summary?.name ?? entry.name,
    note: notes.map((note) => ` ${g.dot} ${note}`).join(""),
    needs: summary === undefined ? "?" : String(summary.waitingOnMaintainer),
    running: summary === undefined ? "?" : String(summary.running),
    ready: summary?.ready === undefined ? "?" : String(summary.ready),
    filled: share === undefined ? null : Math.min(BAR_CELLS, Math.round(share * BAR_CELLS)),
    share: share === undefined ? "" : `${percent(share)}${day?.alert === true ? " ALERT" : ""}`,
    alert: day?.alert === true,
  };
}

/** The column widths of Offices after the office column. */
const NEEDS_WIDTH = 12;
const RUNNING_WIDTH = 10;
const READY_WIDTH = 8;

/** The office column: 56 cells as the mock has it, narrower on a narrow terminal. */
function officeWidth(cells: readonly OfficeCells[], columns: number): number {
  const longest = Math.max(6, ...cells.map((cell) => cell.name.length + cell.note.length + 2));
  const room = columns - 4 - NEEDS_WIDTH - RUNNING_WIDTH - READY_WIDTH - BAR_CELLS - 11;
  return Math.max(longest + 3, Math.min(56, room));
}

/** The Offices lines as plain text: the titles and one line per office. */
export function officesLines(
  state: OfficeStoreState,
  index: number,
  columns: number,
  now: number,
  ascii: boolean,
): string[] {
  const g = glyphs(ascii);
  const cells = state.offices.map((entry) =>
    officeCells(entry, entry.office === state.office, now, ascii),
  );
  const width = officeWidth(cells, columns);
  const bar = (cell: OfficeCells) =>
    cell.filled === null ? "" : `${g.done.repeat(BAR_CELLS)} ${cell.share}`;
  const title = `    ${"OFFICE".padEnd(width - 2)}${"NEEDS YOU".padEnd(NEEDS_WIDTH)}${"RUNNING".padEnd(RUNNING_WIDTH)}${"READY".padEnd(READY_WIDTH)}TODAY`;
  return [
    title,
    ...cells.map((cell, i) =>
      `${i === index ? g.bar : " "} ${cell.glyph} ${(cell.name + cell.note).padEnd(width - 2)}${cell.needs.padEnd(NEEDS_WIDTH)}${cell.running.padEnd(RUNNING_WIDTH)}${cell.ready.padEnd(READY_WIDTH)}${bar(cell)}`.trimEnd(),
    ),
  ];
}

/** One office's row: the focus bar, the state glyph, the name, the counts and the TODAY bar. */
function OfficeRow(props: {
  readonly cell: OfficeCells;
  readonly focused: boolean;
  readonly width: number;
  readonly display: Display;
}) {
  const { cell, focused, width, display } = props;
  const g = glyphs(display.ascii);
  const idle = cell.state === "idle";
  const count = (value: string, w: number) => (
    <Colored display={display} role={value === "0" || idle ? "dim" : undefined}>
      {value.padEnd(w)}
    </Colored>
  );
  const needs = cell.needs !== "0" && cell.needs !== "?";
  const filled = cell.filled ?? 0;
  return (
    <Colored display={display} role={focused ? "sel" : undefined} wrap="truncate-end">
      {focused ? (
        <Colored display={display} role="acc">
          {g.bar}
        </Colored>
      ) : (
        " "
      )}{" "}
      <Colored display={display} role={cell.state === "paused" ? "acc" : idle ? "dim" : "ok"}>
        {cell.glyph}
      </Colored>{" "}
      <Colored display={display} role={idle ? "dim" : focused ? "hi" : undefined}>
        {cell.name}
      </Colored>
      <Colored display={display} role="dim">
        {cell.note.padEnd(Math.max(0, width - 2 - cell.name.length))}
      </Colored>
      <Colored display={display} role={needs ? "acc" : "dim"} bold={needs}>
        {cell.needs}
      </Colored>
      {" ".repeat(Math.max(0, NEEDS_WIDTH - cell.needs.length))}
      {count(cell.running, RUNNING_WIDTH)}
      {count(cell.ready, READY_WIDTH)}
      {cell.filled === null ? null : (
        <>
          <Colored display={display} role={cell.alert ? "err" : idle ? "faint" : "acc"}>
            {g.done.repeat(filled)}
          </Colored>
          <Colored display={display} role="faint">
            {g.done.repeat(BAR_CELLS - filled)}
          </Colored>
          <Colored display={display} role={cell.alert ? "err" : "dim"}>
            {` ${cell.share}`}
          </Colored>
        </>
      )}
    </Colored>
  );
}

/** Offices (S2e, 0009): every registered office from `engine.hello` and `office.summary`. */
export function OfficesBody(props: {
  readonly state: OfficeStoreState;
  readonly display: Display;
  readonly index: number;
  readonly now: number;
  readonly columns: number;
  /** The path being typed after `a`, or null. */
  readonly path: string | null;
}) {
  const { state, display, index, now, columns } = props;
  const g = glyphs(display.ascii);
  const cells = state.offices.map((entry) =>
    officeCells(entry, entry.office === state.office, now, display.ascii),
  );
  const width = officeWidth(cells, columns);
  const [title] = officesLines(state, index, columns, now, display.ascii);
  return (
    <Box flexDirection="column">
      {state.offices.length === 0 ? (
        <Text>No office is registered yet. Press a to open a repository.</Text>
      ) : (
        <>
          <Colored display={display} role="dim" wrap="truncate-end">
            {title}
          </Colored>
          {cells.map((cell, i) => (
            <OfficeRow
              key={state.offices[i]?.office ?? i}
              cell={cell}
              focused={i === index}
              width={width}
              display={display}
            />
          ))}
        </>
      )}
      <Text> </Text>
      {props.path === null ? (
        <Colored display={display} role="dim">
          {`  + a  open a repository path${g.ellipsis}`}
        </Colored>
      ) : (
        <Text wrap="truncate-end">{`  + path: ${props.path}_`}</Text>
      )}
    </Box>
  );
}
