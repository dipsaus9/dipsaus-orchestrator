// The office overview (`1`, 0009 sections 4 and 9, as amended by DIPO-81): a board. A count line
// at the top (running, needs you, in review, Ready, waiting, held, and today at 120 columns), then
// the sections RUNNING, NEEDS YOU, IN REVIEW and READY with the story title on every row; empty
// sections are hidden. Each running row has a `now:` line: a phase word, the newest stored worker
// line (the newest verify line in the verify phase) as stored, and its age. With nothing running
// one line says why, from the stories the engine sent (dependencies, Ready gate rules, parks).
//
// At 120 columns or more a running row shows role, tier, phase, health, criteria, loop, budget bar
// with its share, elapsed time and model; from 80 to 119 phase, health, criteria and budget; from
// 60 to 79 each run is a two-line card with the `now` text on its second line. The board is cut
// to the rows it has room for, running rows first, so the footer with `[q] quit` stays on screen.
// The selected row is marked with `>`; `j`/`k` move over every row and Enter opens it: a running
// story's live detail (DIPO-55), or the latest run of a story that ran (DIPO-81). Lines are
// memoised by their text and cut to the width.

import type { OfficeStoreState } from "@dipsaus-orchestrator/client";
import type {
  Clock,
  GateView,
  RunId,
  StoryId,
  StoryKey,
  StoryView,
  WorkView,
} from "@dipsaus-orchestrator/contract";
import { Box, Text } from "ink";
import { memo, useEffect, useState } from "react";

import {
  age,
  budgetBar,
  elapsed,
  evidenceOf,
  marked,
  percent,
  tokens,
  truncate,
  type Width,
} from "./format";
import type { LatestLines } from "./latest";
import { boardNow } from "./now";
import type { Display } from "./options";
import { glyphs, healthLabel } from "./views";

/** The legend for evidence markers, shown in the footer with the `evidence` capability. */
export const EVIDENCE_LEGEND = "* claimed ~ estimated ? none";

export function evidenceEnabled(state: OfficeStoreState): boolean {
  return state.capabilities.includes("evidence");
}

/** The widest title per width tier; shorter titles keep their own width. */
const TITLE_WIDTH: Readonly<Record<Width, number>> = { full: 27, medium: 22, cards: 16 };

/** The indent of a running row's `now:` line. */
const NOW_INDENT = "     ";

/** The cells of one run, as the engine sent them, with evidence markers when enabled. */
function cells(view: WorkView, evidence: boolean) {
  const { progress, usage } = view;
  const mark = (value: string, path: string) =>
    marked(value, evidenceOf(view.evidence, path, evidence));
  return {
    roleTier: `${view.work.role} ${view.work.tier}`,
    phase: view.phase,
    health: healthLabel(view.health),
    ac: `AC ${mark(`${progress.criteriaMet}/${progress.criteriaTotal}`, "progress.criteriaMet")}`,
    loop: `loop ${mark(`${progress.loop}/${progress.loopCap}`, "progress.loop")}`,
    budget: `${budgetBar(usage)} ${mark(percent(usage.budgetShare), "usage.budgetShare")}`,
    time: mark(elapsed(usage.run.elapsedMs), "usage.run.elapsedMs"),
    model: view.work.model,
  };
}

type Cells = ReturnType<typeof cells>;

/** The cell groups of a running row per tier; each is padded to the widest in its column. */
function groupsOf(row: Cells, width: Width): string[] {
  if (width === "full") {
    return [row.roleTier, row.phase, row.health, row.ac, row.loop, `${row.budget} ${row.time}`];
  }
  return [row.phase, row.health, row.ac, `${row.budget} ${row.time}`];
}

function columnWidths(rows: readonly (readonly string[])[]): number[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return widths;
}

function columnCount(state: OfficeStoreState, column: string): number {
  return state.stories.filter((story) => story.column === column).length;
}

/** `1 running · 1 needs you · 1 in review · Ready 1 · waiting 0 · held 0 · today 1.2M of 4M tokens`. */
export function countLine(state: OfficeStoreState, dot: string, width: Width): string {
  const summary = state.offices.find((entry) => entry.office === state.office)?.summary;
  const parts = [
    `${state.work.length} running`,
    `${summary?.waitingOnMaintainer ?? "?"} needs you`,
    `${columnCount(state, "review")} in review`,
    `Ready ${columnCount(state, "ready")}`,
    `waiting ${columnCount(state, "waiting")}`,
    `held ${columnCount(state, "held")}`,
  ];
  const day = summary?.dayUsage;
  if (day !== undefined && width === "full") {
    const limit = day.limit === undefined ? "" : ` of ${tokens(day.limit)}`;
    const cost = day.estimatedCost === undefined ? "" : ` (~$${day.estimatedCost.toFixed(2)})`;
    parts.push(`today ${tokens(day.tokens)}${limit} tokens${cost}`);
  }
  return ` ${parts.join(` ${dot} `)}`;
}

/** The rule id of a Ready gate message (`ready DIPO-33 failed R15: …` gives `R15`), or null. */
function gateRule(message: string): string | null {
  return /\b(R\d+[a-z]?):/.exec(message)?.[1] ?? null;
}

/** A park reason in words: `needs-permission` reads `needs permission`. */
function words(reason: string): string {
  return reason.replaceAll("-", " ");
}

/**
 * Why nothing runs, in one line, from the stories the engine sent: Ready stories wait for `u`;
 * without them, the waiting dependencies, the first failed Ready gate rule of each Refined story,
 * the parked and held stories and the drafts.
 */
export function idleLine(state: OfficeStoreState, dot: string): string {
  const ready = columnCount(state, "ready");
  if (ready > 0) return ` Nothing is running. Ready ${ready}: [2] queue, then u to run one.`;
  const reasons: string[] = [];
  for (const story of state.stories) {
    if (story.column !== "waiting") continue;
    const on = story.waitingOn ?? [];
    reasons.push(
      on.length === 0 ? `${story.story} waits` : `${story.story} waits on ${on.join(" and ")}`,
    );
  }
  for (const story of state.stories) {
    if (story.column !== "refined") continue;
    const rule = (story.gateMessages ?? []).map(gateRule).find((found) => found !== null);
    reasons.push(`${story.story} is Refined${rule === undefined ? "" : ` (${rule})`}`);
  }
  for (const story of state.stories) {
    if (story.column === "desk") {
      const reason = story.parked === undefined ? "" : ` (${words(story.parked.reason)})`;
      reasons.push(`${story.story} is parked${reason}`);
    } else if (story.column === "held") {
      reasons.push(`${story.story} is on hold`);
    }
  }
  const drafts = columnCount(state, "draft");
  if (drafts > 0) reasons.push(`${drafts} draft${drafts === 1 ? "" : "s"}`);
  if (reasons.length === 0) {
    return ` Nothing is running and nothing is Ready ${dot} this office has no open story.`;
  }
  return ` Nothing is running and nothing is Ready: ${reasons.join(", ")}.`;
}

/** One screen line of the board. */
export interface BoardLine {
  readonly key: string;
  readonly text: string;
  readonly tone?: "section" | "now" | "selected";
}

/** One row of a section: the story line and, for a running row, its `now` line. */
export interface BoardRow {
  readonly key: string;
  readonly lines: readonly BoardLine[];
}

export interface Section {
  readonly title: string;
  readonly rows: readonly BoardRow[];
  /** The row that stays on screen when the section is cut: the selected run. */
  readonly keep?: number;
}

/** The stories of the NEEDS YOU, IN REVIEW and READY sections, in the engine's order. */
function waitingStories(state: OfficeStoreState) {
  const running = new Set(state.work.map((view) => String(view.work.key)));
  const gated = new Map<string, GateView>();
  for (const gate of state.gates) {
    const key = String(gate.work.key);
    if (gate.waitingOn === "maintainer" && !running.has(key)) gated.set(key, gate);
  }
  return {
    needs: state.stories.filter((story) => story.column === "desk" || gated.has(String(story.key))),
    review: state.stories.filter(
      (story) => story.column === "review" && !gated.has(String(story.key)),
    ),
    ready: state.stories.filter((story) => story.column === "ready"),
    gated,
  };
}

/** One selectable board row: a story, with its run while it runs. */
export interface BoardEntry {
  readonly key: StoryKey;
  readonly story: StoryId;
  readonly run: RunId | null;
}

/** The board's selectable rows in screen order: running, needs you, in review, Ready. */
export function boardEntries(state: OfficeStoreState): BoardEntry[] {
  const { needs, review, ready } = waitingStories(state);
  return [
    ...state.work.map((view) => ({
      key: view.work.key,
      story: view.work.story,
      run: view.work.run,
    })),
    ...[...needs, ...review, ...ready].map((story) => ({
      key: story.key,
      story: story.story,
      run: null,
    })),
  ];
}

interface Widths {
  readonly story: number;
  readonly title: number;
}

/** `>DIPO-24 Add verify retry       `: marker, id and title, padded to the board's widths. */
function head(story: string, title: string, widths: Widths, ellipsis: string, marker = " ") {
  const cut = truncate(title, widths.title, ellipsis).padEnd(widths.title);
  return `${marker}${story.padEnd(widths.story)} ${cut}`;
}

/** The board's sections, before they are cut to the height. */
function sections(options: {
  state: OfficeStoreState;
  width: Width;
  selected: string | null | undefined;
  latest: LatestLines | null;
  now: number;
  dot: string;
  columns: number;
  ellipsis: string;
}): Section[] {
  const { state, width, latest, now, dot, ellipsis } = options;
  const evidence = evidenceEnabled(state);
  const { needs, review, ready, gated } = waitingStories(state);
  const titleOf = new Map(state.stories.map((story) => [String(story.key), story.title]));
  const named = [
    ...state.work.map((view) => ({
      story: String(view.work.story),
      title: titleOf.get(String(view.work.key)) ?? "",
    })),
    ...[...needs, ...review, ...ready].map((story) => ({
      story: String(story.story),
      title: story.title,
    })),
  ];
  const runCells = state.work.map((view) => cells(view, evidence));
  const groups = runCells.map((row) => groupsOf(row, width));
  const groupWidths = columnWidths(groups);
  const sep = width === "full" ? "  " : " ";
  // What follows the title on the widest running row: the title gives way so the row fits.
  const tail =
    width === "cards"
      ? 0
      : Math.max(
          0,
          ...runCells.map(
            (row) =>
              1 +
              groupWidths.reduce((sum, w) => sum + w, 0) +
              sep.length * (groupWidths.length - 1) +
              (width === "full" ? 1 + row.model.length : 0),
          ),
        );
  const storyWidth = Math.max(0, ...named.map((row) => row.story.length));
  const widths: Widths = {
    story: storyWidth,
    title: Math.max(
      Math.min(10, TITLE_WIDTH[width]),
      Math.min(
        TITLE_WIDTH[width],
        Math.max(0, ...named.map((row) => row.title.length)),
        options.columns - 2 - storyWidth - tail,
      ),
    ),
  };
  const running = state.work.map((view, i): BoardRow => {
    const row = runCells[i]!;
    const selected = String(view.work.key) === options.selected;
    const marker = selected ? ">" : " ";
    const title = titleOf.get(String(view.work.key)) ?? "";
    const nowText = boardNow({
      view,
      worker: latest?.line(view.work.run, "worker") ?? null,
      verify: latest?.line(view.work.run, "verify") ?? null,
      question: state.questions.find((question) => question.work.run === view.work.run),
      now,
      dot,
    });
    let first: string;
    let second: string;
    if (width === "cards") {
      first = `${marker}${view.work.story}  ${row.health}  ${row.phase}  ${row.ac}  ${row.loop}  ${row.budget}  ${title}`;
      second = `   now: ${nowText}`;
    } else {
      const cellsText = groups[i]!.map((cell, c) => cell.padEnd(groupWidths[c] ?? 0)).join(sep);
      const model = width === "full" ? ` ${row.model}` : "";
      first = `${head(String(view.work.story), title, widths, ellipsis, marker)} ${cellsText}${model}`;
      second = `${NOW_INDENT}now: ${nowText}`;
    }
    const run = String(view.work.run);
    return {
      key: String(view.work.key),
      lines: [
        selected
          ? { key: `${run}:row`, text: first, tone: "selected" }
          : { key: `${run}:row`, text: first },
        { key: `${run}:now`, text: second, tone: "now" },
      ],
    };
  });

  const tier = (story: StoryView) =>
    width === "full" && story.tier !== undefined ? `${story.tier}  ` : "";
  const line = (story: StoryView, note: string): BoardRow => {
    const selected = String(story.key) === options.selected;
    const text = `${head(String(story.story), story.title, widths, ellipsis, selected ? ">" : " ")}  ${note}`;
    return {
      key: String(story.key),
      lines: [
        selected
          ? { key: String(story.key), text, tone: "selected" }
          : { key: String(story.key), text },
      ],
    };
  };
  const needsRows = needs.map((story) => {
    const gate = gated.get(String(story.key));
    if (gate !== undefined && story.column !== "desk") {
      return line(story, `${gate.kind} gate waits on you ${dot} ${gate.summary}`);
    }
    const parked = story.parked;
    if (parked === undefined) return line(story, "parked");
    const detail = parked.detail === "" ? "" : `: ${parked.detail}`;
    const since = age(now - Date.parse(parked.since));
    return line(story, `parked ${since} ${dot} ${words(parked.reason)}${detail}`);
  });
  const reviewRows = review.map((story) =>
    line(story, `${tier(story)}in review ${dot} no worker running`),
  );
  const readyRows = ready.map((story, i) =>
    line(story, `${tier(story)}Ready${i === 0 ? ` ${dot} [2] queue, then u` : ""}`),
  );
  const section = (title: string, rows: BoardRow[]): Section => {
    const keep = rows.findIndex((row) => row.key === options.selected);
    return keep === -1 ? { title, rows } : { title, rows, keep };
  };
  return [
    section("RUNNING", running),
    section("NEEDS YOU", needsRows),
    section("IN REVIEW", reviewRows),
    section("READY", readyRows),
  ];
}

/** The lines a section takes when it gets `space` lines: all of it, or a window with its kept row. */
function cutSection(section: Section, space: number, ellipsis: string): BoardLine[] {
  const title: BoardLine = {
    key: `section:${section.title}`,
    text: ` ${section.title} (${section.rows.length})`,
    tone: "section",
  };
  const need = 1 + section.rows.reduce((sum, row) => sum + row.lines.length, 0);
  if (need <= space) return [title, ...section.rows.flatMap((row) => row.lines)];
  if (space < 2) return [];
  // The title and the "more" line take two lines; whole rows fill the rest.
  const rowSpace = space - 2;
  const fitting = (from: number) => {
    let used = 0;
    let count = 0;
    for (const row of section.rows.slice(from)) {
      if (used + row.lines.length > rowSpace) break;
      used += row.lines.length;
      count += 1;
    }
    return count;
  };
  const keep = Math.min(section.keep ?? 0, section.rows.length - 1);
  let start = 0;
  let shown = fitting(0);
  while (start < keep && keep >= start + shown) {
    start += 1;
    shown = fitting(start);
  }
  return [
    title,
    ...section.rows.slice(start, start + shown).flatMap((row) => row.lines),
    { key: `more:${section.title}`, text: `   ${ellipsis} ${section.rows.length - shown} more` },
  ];
}

/**
 * The sections cut to `height` lines, in their order, which is their order of importance. A
 * section that does not fit shows its title, the whole rows that fit (always with its kept row)
 * and a line with the number left out. Room for the selected row's section (title, the row and
 * the "more" line) is kept first, so the selection stays on screen.
 */
export function fitSections(
  list: readonly Section[],
  height: number,
  ellipsis: string,
): BoardLine[] {
  const selected = list.findIndex(
    (section) => section.keep !== undefined && section.rows.length > 0,
  );
  const kept = list[selected];
  const reserve =
    kept === undefined
      ? 0
      : 1 + (kept.rows[kept.keep ?? 0]?.lines.length ?? 0) + (kept.rows.length > 1 ? 1 : 0);
  let room = height;
  const out: BoardLine[] = [];
  for (const [i, section] of list.entries()) {
    if (section.rows.length === 0) continue;
    const space = room - (i < selected ? reserve : 0);
    const lines = cutSection(section, Math.max(0, space), ellipsis);
    out.push(...lines);
    room -= lines.length;
    // A cut section ends the board, unless the selected section still follows.
    if (lines.length === 0 || lines.at(-1)?.key.startsWith("more:")) {
      if (i >= selected) break;
    }
  }
  return out;
}

/** Memoised by its text: a line renders again only when what it says changes. */
const Line = memo(function Line(props: {
  text: string;
  tone: BoardLine["tone"];
  display: Display;
}) {
  const { text, tone, display } = props;
  if (!display.color || tone === undefined) return <Text wrap="truncate-end">{text}</Text>;
  if (tone === "section") {
    return (
      <Text bold wrap="truncate-end">
        {text}
      </Text>
    );
  }
  return (
    <Text color="cyan" wrap="truncate-end">
      {text}
    </Text>
  );
});

/** Renders again every second while runs show, so the age on the `now` lines moves on. */
function useTick(clock: Clock, active: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    let handle = clock.setTimeout(function tick() {
      setTick((n) => n + 1);
      handle = clock.setTimeout(tick, 1_000);
    }, 1_000);
    return () => clock.clearTimeout(handle);
  }, [clock, active]);
}

export function Overview(props: {
  state: OfficeStoreState;
  display: Display;
  width: Width;
  columns: number;
  /** Rows for the board, from its count line to its last row. */
  height: number;
  clock: Clock;
  /** The newest output lines of the running runs; null until an office is open. */
  latest: LatestLines | null;
  /** The selected row by story key, marked with `>`; Enter opens it. */
  selected?: string | null;
}) {
  const { state, display, width, columns } = props;
  const { dot, ellipsis } = glyphs(display.ascii);
  useTick(props.clock, state.work.length > 0);
  if (state.office === null) {
    return <Text>{" No office selected. Press o to choose one."}</Text>;
  }
  if (state.loading && state.stories.length === 0) {
    return <Text>{` Loading${ellipsis}`}</Text>;
  }
  const top: BoardLine[] = [{ key: "counts", text: countLine(state, dot, width) }];
  if (state.work.length === 0) top.push({ key: "idle", text: idleLine(state, dot) });
  const board = fitSections(
    sections({
      state,
      width,
      selected: props.selected,
      latest: props.latest,
      now: props.clock.now(),
      columns,
      dot,
      ellipsis,
    }),
    Math.max(0, props.height - top.length),
    ellipsis,
  );
  return (
    <Box flexDirection="column">
      {[...top, ...board].map((line) => (
        <Line
          key={line.key}
          text={truncate(line.text, columns, ellipsis)}
          tone={line.tone}
          display={display}
        />
      ))}
    </Box>
  );
}
