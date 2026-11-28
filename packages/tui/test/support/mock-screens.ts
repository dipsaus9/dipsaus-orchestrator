// The text mocks of `docs/design/tui-v2/screens/` and `docs/design/chat-and-activity/screens/` as
// cells (DIPO-520): `mockCells` reads a mock, `frameCells` reads a rendered frame, `expectScreen`
// holds the one to the other in every cell: character, role, bold, underline and the focus row's
// background. The mock wins over the code (the maintainer's rule, DIPO-460).

import { expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

import { ansiPaint, ROLES, type Role } from "../../src/colour";
import type { Rendered } from "./harness";

/** One terminal cell: what it shows and how it is painted. */
export interface Cell {
  readonly ch: string;
  readonly role: Role;
  readonly bold: boolean;
  /** Underlined, in the text's own colour (the maintainer's answer of 2026-11-28: no SGR 58). */
  readonly underline: boolean;
  /** On the focused row's background. */
  readonly sel: boolean;
}

export interface Screen {
  readonly cols: number;
  readonly rows: number;
  readonly cells: Cell[][];
}

const FOLDERS = ["tui-v2", "chat-and-activity"] as const;
const CAPTION = /^=== (.*) · (\d+) cols × (\d+) rows ===$/;

const BLANK: Cell = { ch: " ", role: "fg", bold: false, underline: false, sel: false };

function folderUrl(folder: string): URL {
  return new URL(`../../../../docs/design/${folder}/screens/`, import.meta.url);
}

/** Every screen file of both folders: its folder and name. */
function screenFiles(): { folder: string; file: string }[] {
  return FOLDERS.flatMap((folder) =>
    readdirSync(folderUrl(folder))
      .filter((file) => file.endsWith(".txt"))
      .toSorted()
      .map((file) => ({ folder, file })),
  );
}

/** The captions of every screen file, as the guard test lists them: `<file>#<caption title>`. */
export function mockCaptions(): { file: string; title: string; key: string }[] {
  return screenFiles().flatMap(({ folder, file }) =>
    readFileSync(new URL(file, folderUrl(folder)), "utf8")
      .split("\n")
      .flatMap((line) => {
        const caption = CAPTION.exec(line);
        return caption === null ? [] : [{ file, title: caption[1]!, key: `${file}#${caption[1]}` }];
      }),
  );
}

/** The folder of a screen file name. */
function folderOf(file: string): string {
  const found = screenFiles().find((entry) => entry.file === file);
  if (found === undefined) throw new Error(`no screen file ${file}`);
  return found.folder;
}

/** One row of a mock into `cols` cells; `[role]`, `[/]`, `[sel]`, `**` and `__` per spec.md, Reading the screen files. */
function parseRow(line: string, cols: number): Cell[] {
  const cells: Cell[] = [];
  const stack: string[] = [];
  let bold = false;
  let underline = false;
  const chars = Array.from(line);
  for (let at = 0; at < chars.length;) {
    const rest = chars.slice(at).join("");
    const tag = /^\[(\/|[a-z]+)\]/.exec(rest);
    if (tag !== null) {
      if (tag[1] === "/") stack.pop();
      else stack.push(tag[1]!);
      at += tag[0].length;
      continue;
    }
    if (rest.startsWith("**") || rest.startsWith("__")) {
      if (rest.startsWith("**")) bold = !bold;
      else underline = !underline;
      at += 2;
      continue;
    }
    const ch = chars[at]!;
    at += 1;
    const role = stack.toReversed().find((name) => name !== "sel");
    const unmarkedRule = role === undefined && (ch === "│" || ch === "─");
    cells.push({
      ch,
      role: unmarkedRule ? "faint" : ((role ?? "fg") as Role),
      bold,
      underline,
      sel: stack.includes("sel"),
    });
  }
  if (stack.length > 0 || bold || underline)
    throw new Error(`unclosed marker in mock row: ${line}`);
  while (cells.length < cols) cells.push(BLANK);
  return cells;
}

/**
 * The cells of one mock. `title` is a part of the caption (the whole file's one caption when it has
 * only one); a part that matches no caption or several is an error.
 */
export function mockCells(file: string, title?: string): Screen {
  const lines = readFileSync(new URL(file, folderUrl(folderOf(file))), "utf8").split("\n");
  const at = lines.flatMap((line, index) =>
    CAPTION.test(line) && (title === undefined || line.includes(title)) ? [index] : [],
  );
  if (at.length !== 1) {
    throw new Error(`${file}: ${at.length} captions match ${JSON.stringify(title ?? "")}`);
  }
  const [, , cols, rows] = CAPTION.exec(lines[at[0]!]!)!.map(Number);
  const body = lines.slice(at[0]! + 1, at[0]! + 1 + rows!);
  return { cols: cols!, rows: rows!, cells: body.map((line) => parseRow(line, cols!)) };
}

/** The foreground SGR code of an Ink colour name. */
function fgCode(name: string): number {
  const names = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
  const bright = name.endsWith("Bright");
  const base = names.indexOf(bright ? name.slice(0, -6) : name);
  if (base < 0) throw new Error(`no SGR code for colour ${name}`);
  return (bright ? 90 : 30) + base;
}

/** What each role looks like on the wire on the dark ANSI theme, keyed `<fg code or ->/<faint>`. */
const PAINTS = new Map<string, Role>();
let selBackground = "";
for (const role of ROLES) {
  const paint = ansiPaint(role, "dark");
  if (role === "sel") {
    selBackground = /^ansi256\((\d+)\)$/.exec(paint.color ?? "")![1]!;
    continue;
  }
  if (role === "bg") continue;
  const key = `${paint.color === undefined ? "-" : fgCode(paint.color)}/${paint.faint === true}`;
  PAINTS.set(key, role);
}

// oxlint-disable-next-line no-control-regex
const SGR_OR_TEXT = /\u001b\[([0-9;]*)m|([^\u001b]+)/gu;

/** One rendered row into cells; the SGR state starts plain on every row. */
function readRow(line: string): Cell[] {
  const cells: Cell[] = [];
  let fg: number | undefined;
  let faint = false;
  let bold = false;
  let underline = false;
  let background: string | undefined;
  for (const part of line.matchAll(SGR_OR_TEXT)) {
    if (part[2] === undefined) {
      const params = (part[1] === "" ? "0" : part[1]!).split(";").map(Number);
      for (let at = 0; at < params.length; at += 1) {
        const code = params[at]!;
        if (code === 0) {
          fg = undefined;
          faint = bold = underline = false;
          background = undefined;
        } else if (code === 1) bold = true;
        else if (code === 2) faint = true;
        else if (code === 22) faint = bold = false;
        else if (code === 4) underline = true;
        else if (code === 24) underline = false;
        else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) fg = code;
        else if (code === 39) fg = undefined;
        else if (code === 49) background = undefined;
        else if (code === 48 && params[at + 1] === 5) {
          background = String(params[at + 2]);
          at += 2;
        } else if (code === 38 || code === 48) {
          throw new Error(`unread SGR ${part[1]}: the ANSI frame uses only 16 and 256 colours`);
        }
      }
      continue;
    }
    for (const ch of Array.from(part[2])) {
      const key = `${fg ?? "-"}/${faint}`;
      cells.push({
        ch,
        role: fg === undefined && !faint ? "fg" : (PAINTS.get(key) ?? (`?${key}` as Role)),
        bold,
        underline,
        sel: background === selBackground,
      });
    }
  }
  return cells;
}

/** The cells of a rendered frame (`FakeTerminal.rawFrame()`), padded to `cols` x `rows`. */
export function frameCells(raw: string, cols: number, rows: number): Screen {
  const lines = raw.replace(/\n$/, "").split("\n");
  const cells = Array.from({ length: Math.max(rows, lines.length) }, (_, row) => {
    const read = readRow(lines[row] ?? "");
    while (read.length < cols) read.push(BLANK);
    return read;
  });
  return { cols, rows: cells.length, cells };
}

function describeCell(cell: Cell): string {
  const style = [cell.bold ? "bold" : "", cell.underline ? "underline" : "", cell.sel ? "sel" : ""]
    .filter((word) => word !== "")
    .join("+");
  return `<${cell.ch} ${cell.role}${style === "" ? "" : ` ${style}`}>`;
}

/** Whether two cells look the same: a space shows no colour or bold, only underline and focus. */
function same(a: Cell, b: Cell): boolean {
  if (a.ch !== b.ch || a.underline !== b.underline || a.sel !== b.sel) return false;
  return a.ch === " " || (a.role === b.role && a.bold === b.bold);
}

/** A differing cell, 1-based: `row:col expected <…> got <…>`. */
export interface CellDiff {
  readonly row: number;
  readonly col: number;
  readonly text: string;
}

/** Every differing cell of two screens, in reading order. */
export function screenDiff(expected: Screen, got: Screen): CellDiff[] {
  const diffs: CellDiff[] = [];
  const cols = Math.max(expected.cols, got.cols);
  for (let row = 0; row < Math.max(expected.cells.length, got.cells.length); row += 1) {
    const want = expected.cells[row] ?? [];
    const have = got.cells[row] ?? [];
    for (let col = 0; col < Math.max(cols, want.length, have.length); col += 1) {
      const a = want[col] ?? BLANK;
      const b = have[col] ?? BLANK;
      if (same(a, b)) continue;
      diffs.push({
        row: row + 1,
        col: col + 1,
        text: `${row + 1}:${col + 1} expected ${describeCell(a)} got ${describeCell(b)}`,
      });
    }
  }
  return diffs;
}

/**
 * Captions with no `expectScreen` test, or with cells it tolerates, each with the story that closes
 * them (DIPO-520). A caption with no `cells` has no test at all. `cells` are `row` or
 * `row:from-to` (1-based, columns inclusive): the cells `expectScreen` lets differ. Every one must
 * still hide a difference, so the list only shrinks.
 */
export const KNOWN_GAPS: Readonly<Record<string, { story: string; cells?: readonly string[] }>> = {
  "01-desk.txt#S1b Desk: a full day, every kind (setup first, then engine order; MERGE in focus; a planning session open) · ux-spec mock 2":
    { story: "DIPO-530" },
  "02-floor.txt#S2 Floor: what the team is doing · ux-spec mock 8": {
    story: "DIPO-530",
    cells: ["1", "2", "9", "13", "22", "23", "28", "29", "30"],
  },
  "03-run.txt#S3 Run: watch and steer a live box · ux-spec mock 13": { story: "DIPO-530" },
  "03-run.txt#S7 Steer open at the foot of the stream, then the sent `you` line · ux-spec mock 21":
    { story: "DIPO-530" },
  "04-story-reader.txt#S4 Story: read the reviews (Reviews tab) · ux-spec mock 14": {
    story: "DIPO-530",
  },
  "05-queue.txt#S2b Queue: what's next and why it waits · ux-spec mock 9": {
    story: "DIPO-530",
    cells: [
      "1",
      "2",
      "5:64-112",
      "6:64-112",
      "7:64-112",
      "8:64-112",
      "9:64-112",
      "10:64-112",
      "11:64-112",
      "12:64-112",
      "13:64-112",
      "14:64-112",
      "15:64-112",
      "16:64-112",
      "17:64-112",
      "18:64-112",
      "19:64-112",
      "30",
    ],
  },
  "06-retro.txt#S2c Retro: how to prepare work better (30d) · ux-spec mock 10": {
    story: "DIPO-531",
  },
  "07-plan.txt#S2d Plan: a conversation with the planner · ux-spec mock 11, changed by DIPO-487": {
    story: "DIPO-530",
    cells: ["1", "15", "16", "17", "28:2-2"],
  },
  "08-offices.txt#S2e Offices · ux-spec mock 12": { story: "DIPO-530" },
  "09-palette.txt#S5 Command palette over the Floor (body behind in shade) · ux-spec mock 15": {
    story: "DIPO-530",
  },
  "10-test-overlay.txt#S1d Test overlay over the Desk (t on a MERGE item) · ux-spec mock 7": {
    story: "DIPO-530",
  },
  "11-desk-previews.txt#S1c QUESTION preview, `a` pressed (Composer open) · ux-spec mock 3": {
    story: "DIPO-530",
  },
  "11-desk-previews.txt#S1c PARKED budget-exceeded preview, `r` pressed · ux-spec mock 4": {
    story: "DIPO-530",
  },
  "11-desk-previews.txt#S1c NEXT UP preview · ux-spec mock 5": { story: "DIPO-530" },
  "11-desk-previews.txt#S1c STARTS PAUSED preview · ux-spec mock 6": { story: "DIPO-530" },
  "12-states.txt#S6 Empty Desk · ux-spec mock 16": { story: "DIPO-530" },
  "12-states.txt#S6 Daemon stopped · ux-spec mock 17": { story: "DIPO-530" },
  "12-states.txt#S8 Offline, view frozen (body in shade) · ux-spec mock 25": { story: "DIPO-530" },
  "12-states.txt#S8 Recovering: database unavailable · ux-spec mock 26": { story: "DIPO-530" },
  "12-states.txt#S7 Pending action, then the result in place · ux-spec mock 22": {
    story: "DIPO-530",
  },
  "12-states.txt#S7 Discard (D): red border, typed id · ux-spec mock 23": { story: "DIPO-530" },
  "12-states.txt#S7 Drop (X): acc border, red once the branch box is ticked · ux-spec mock 24": {
    story: "DIPO-530",
  },
  "13-keys-overlay.txt#S9 Keys overlay over the Desk (? on a MERGE item) · ux-spec mock 27": {
    story: "DIPO-530",
  },
  "14-desk-proposals.txt#S1 Desk: what needs you (Since band, SETUP, PROPOSALS, PROPOSED STORY preview, +2 elsewhere) · ux-spec mock 1":
    { story: "DIPO-530" },
  "15-budget-and-failed.txt#S6 Budget reached (lands on the Desk) · ux-spec mock 18": {
    story: "DIPO-530",
  },
  "15-budget-and-failed.txt#S6 Run failed · ux-spec mock 19": { story: "DIPO-530" },
  "16-narrow.txt#S6 At 80 × 24: single pane, no preview, no ticker, no Since line · ux-spec mock 20":
    { story: "DIPO-530" },
  "17-themes.txt#S10 Truecolor, light (Classical on paper) · ux-spec mock 28": {
    story: "DIPO-530",
  },
  "17-themes.txt#S10 16 colours, light · ux-spec mock 29": { story: "DIPO-530" },
  "17-themes.txt#S10 16 colours, dark · ux-spec mock 30": { story: "DIPO-530" },
  "17-themes.txt#S10 NO_COLOR · ux-spec mock 31": { story: "DIPO-530" },
  "01-queue-with-dock.txt#C1 Queue with the chat docked (too narrow for the panel, after `) · a command card in focus":
    { story: "DIPO-526" },
  "02-chat-room.txt#C2 Chat, full screen (5): one conversation in threads, led by context · changes 07-plan.txt":
    { story: "DIPO-523" },
  "03-floor-background.txt#C3 Floor: the BACKGROUND group, the header chip and the chat line (chat hidden with \\)":
    { story: "DIPO-528" },
  "04-background-detail.txt#C3 Floor › a background item: a story PR's checks (chat hidden with \\)":
    { story: "DIPO-528" },
  "05-run-with-dock-wide.txt#C1 Run with the chat docked on the right (152 columns or wider) · a steer card in focus":
    { story: "DIPO-526" },
  "06-desk-jump-and-line.txt#C4 Desk: the attention count, a question and the chat line (chat hidden with \\)":
    { story: "DIPO-526" },
  "07-states.txt#C5 Chat line, idle (the chat hidden, or below 100 columns; the row above the ticker)":
    { story: "DIPO-526" },
  "07-states.txt#C5 Chat line, answering": { story: "DIPO-526" },
  "07-states.txt#C5 Chat line, an answer you haven't seen": { story: "DIPO-526" },
  "07-states.txt#C5 Input while dipo answers: the message waits": { story: "DIPO-526" },
  "07-states.txt#C5 Context line in the dock": { story: "DIPO-526" },
  "07-states.txt#C5 An action card after c (pending, sent, failed; in place, as the Desk's pending rows)":
    { story: "DIPO-526" },
  "07-states.txt#C5 A refused command, with its reason (ticker and card)": { story: "DIPO-526" },
  "07-states.txt#C5 A thread that closed by itself": { story: "DIPO-526" },
  "07-states.txt#C5 Chat while the daemon is away (conversation in shade, input kept)": {
    story: "DIPO-526",
  },
  "07-states.txt#C6 Header chips": { story: "DIPO-526" },
  "07-states.txt#C6 Too narrow for a dock (below 100 columns): ` opens the chat full screen; esc returns to the room":
    { story: "DIPO-526" },
  "08-desk-chat-panel.txt#C7 Desk with the chat panel on (154 columns or wider) · the keyboard in the room":
    { story: "DIPO-526" },
  "09-queue-chat-strip.txt#C7 Queue with the chat strip (the Queue below 168 columns) · the keyboard in the room":
    { story: "DIPO-526" },
  "10-queue-now.txt#C8 Queue · now: only what can start (chat hidden with \\)": {
    story: "DIPO-532",
  },
  "11-queue-plan.txt#C8 Queue · plan: every open story by milestone (chat hidden with \\)": {
    story: "DIPO-532",
  },
};

function covers(spec: string, diff: CellDiff): boolean {
  const [row, range] = spec.split(":");
  if (Number(row) !== diff.row) return false;
  if (range === undefined) return true;
  const [from, to] = range.split("-").map(Number);
  return diff.col >= from! && diff.col <= to!;
}

function rowText(screen: Screen, row: number): string {
  return (screen.cells[row - 1] ?? [])
    .map((cell) => cell.ch)
    .join("")
    .trimEnd();
}

/**
 * Holds the last frame of `rendered` to the mock `file`, caption part `title`, in every cell, header,
 * rooms row, rules, ticker and footer included. Fails with each differing cell and both rows; the
 * cells of a `KNOWN_GAPS` entry are the only ones allowed to differ.
 */
export function expectScreen(
  rendered: Pick<Rendered, "rawFrame">,
  file: string,
  title?: string,
): void {
  const caption = mockCaptions().filter(
    (entry) => entry.file === file && (title === undefined || entry.title.includes(title)),
  );
  if (caption.length !== 1)
    throw new Error(`${file}: ${caption.length} captions match ${title ?? ""}`);
  const key = caption[0]!.key;
  const mock = mockCells(file, title);
  const frame = frameCells(rendered.rawFrame(), mock.cols, mock.rows);
  const diffs = screenDiff(mock, frame);
  const specs = KNOWN_GAPS[key]?.cells ?? [];
  const stale = specs.filter((spec) => !diffs.some((diff) => covers(spec, diff)));
  if (stale.length > 0) {
    throw new Error(`${key}: ${stale.join(", ")} match the mock now; remove them from KNOWN_GAPS`);
  }
  const wrong = diffs.filter((diff) => !specs.some((spec) => covers(spec, diff)));
  const rows = [...new Set(wrong.map((diff) => diff.row))];
  const report = rows.flatMap((row) => {
    const cells = wrong.filter((diff) => diff.row === row);
    return [
      ...cells.slice(0, 12).map((diff) => diff.text),
      ...(cells.length > 12 ? [`… ${cells.length - 12} more cells in row ${row}`] : []),
      `  expected row ${row}: ${rowText(mock, row)}`,
      `  got row      ${row}: ${rowText(frame, row)}`,
    ];
  });
  expect(wrong.length, `${key} differs from its mock:\n${report.join("\n")}`).toBe(0);
}

/** The `expectScreen(…, "<file>", "<title>")` calls of some test sources, as `[file, title or undefined]`. */
export function screenCalls(sources: readonly string[]): [string, string | undefined][] {
  const call = /\bexpectScreen\(\s*[^,()]+,\s*"([^"]+)"(?:\s*,\s*"([^"]+)")?\s*,?\s*\)/g;
  return sources.flatMap((text) =>
    [...text.matchAll(call)].map((m): [string, string | undefined] => [m[1]!, m[2]]),
  );
}

/**
 * What the guard (DIPO-520) refuses: a caption with neither an \`expectScreen\` call nor a
 * \`KNOWN_GAPS\` entry, a gap that names no story, no caption or a caption that has a call yet lists
 * no cells (or has no call yet lists cells).
 */
export function guardProblems(
  captions: readonly { file: string; title: string; key: string }[],
  calls: readonly [string, string | undefined][],
  gaps: Readonly<Record<string, { story: string; cells?: readonly string[] }>>,
): string[] {
  const problems: string[] = [];
  const called = (caption: { file: string; title: string }) =>
    calls.some(
      ([file, title]) =>
        file === caption.file && (title === undefined || caption.title.includes(title)),
    );
  for (const caption of captions) {
    const gap = gaps[caption.key];
    if (gap === undefined) {
      if (!called(caption))
        problems.push(`${caption.key}: no expectScreen call and no KNOWN_GAPS entry`);
      continue;
    }
    if (!/^DIPO-\d+$/.test(gap.story)) problems.push(`${caption.key}: KNOWN_GAPS names no story`);
    if (called(caption) && gap.cells === undefined) {
      problems.push(`${caption.key}: has an expectScreen call, so its KNOWN_GAPS entry must go`);
    }
    if (!called(caption) && gap.cells !== undefined) {
      problems.push(`${caption.key}: KNOWN_GAPS lists cells but no expectScreen call holds it`);
    }
  }
  for (const key of Object.keys(gaps)) {
    if (!captions.some((caption) => caption.key === key)) problems.push(`${key}: no such caption`);
  }
  return problems;
}
