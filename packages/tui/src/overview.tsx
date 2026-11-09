// The Floor (`2`, 0009, DIPO-81, DIPO-460): what the team is doing, built for a second monitor.
// RUNNING and IN REVIEW hold one card per story, and a story is in one of them, never both: a
// story under review with no session, or whose session is the reviewer, is IN REVIEW; every other
// story with a session is RUNNING. A card is the story line, the Pipeline with its loop or round,
// the `now` line with the budget bar, and criteria, review round and model; health shows only
// when it is stuck, looping or lost. UP NEXT is one sentence the engine computed from the
// dependency graph (`chain.ts`). Stories that wait for you are on the Desk, Ready and waiting
// ones in the Queue. The selected card is marked with `▌`; `j`/`k` move over every card and Enter
// opens it: a running story's live detail (DIPO-55), or the latest run of a story that ran
// (DIPO-81). Cards are memoised by what they say.

import { healthLabel, type OfficeStoreState, percent } from "@dipsaus-orchestrator/client";
import type {
  Clock,
  RunId,
  StoryId,
  StoryKey,
  StoryView,
  WorkView,
} from "@dipsaus-orchestrator/contract";
import { Box, Text } from "ink";
import { useEffect, useState } from "react";

import { type Chain, upNextSpans } from "./chain";
import { elapsed, truncate } from "./format";
import type { LatestLines } from "./latest";
import { boardNowParts } from "./now";
import type { Display } from "./options";
import { pipelineSpans } from "./pipeline";
import { cutSpans, focused, type Span, SpanLine, spread } from "./spans";
import { glyphs } from "./views";

/** Columns the card's lines are indented by: focus bar, glyph and the story id padded to ten. */
const INDENT = 14;

/** The cells of the budget bar. */
const BAR_CELLS = 14;

function columnCount(state: OfficeStoreState, column: string): number {
  return state.stories.filter((story) => story.column === column).length;
}

/** A park reason in words: `by-maintainer` reads `by maintainer`. */
function words(reason: string): string {
  return reason.replaceAll("-", " ");
}

/**
 * Why nothing runs, in one line, from the stories the engine sent: Ready stories wait for `R`;
 * without them, the waiting dependencies, the first failed Ready gate rule of each Refined story,
 * the parked stories and the drafts.
 */
export function idleLine(state: OfficeStoreState, dot: string): string {
  const ready = columnCount(state, "ready");
  if (ready > 0) return `Nothing is running. Ready ${ready}: 3 Queue, then R to run one.`;
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
    const rule = story.gateFailures?.[0]?.rule;
    reasons.push(`${story.story} is Refined${rule === undefined ? "" : ` (${rule})`}`);
  }
  for (const story of state.stories) {
    if (story.column === "desk") {
      const reason = story.parked === undefined ? "" : ` (${words(story.parked.reason)})`;
      reasons.push(`${story.story} is parked${reason}`);
    }
  }
  const drafts = columnCount(state, "draft");
  if (drafts > 0) reasons.push(`${drafts} draft${drafts === 1 ? "" : "s"}`);
  if (reasons.length === 0) {
    return `Nothing is running and nothing is Ready ${dot} this office has no open story.`;
  }
  return `Nothing is running and nothing is Ready: ${reasons.join(", ")}.`;
}

/** One story on the Floor: its view, and the run when a session works on it. */
export interface FloorStory {
  readonly story: StoryView;
  readonly view: WorkView | null;
}

/**
 * The stories of RUNNING and IN REVIEW, each story once: a story under review whose session is the
 * reviewer, or that has none, is IN REVIEW; a story with any other session is RUNNING. A story
 * that waits for the maintainer (a parked story, a gate waiting on them) is on the Desk instead.
 */
export function floorStories(state: OfficeStoreState): {
  readonly running: readonly FloorStory[];
  readonly review: readonly FloorStory[];
} {
  const waitsForYou = new Set(
    state.gates
      .filter((gate) => gate.waitingOn === "maintainer")
      .map((gate) => String(gate.work.key)),
  );
  const storyOf = new Map(state.stories.map((story) => [String(story.key), story]));
  const running: FloorStory[] = [];
  const review: FloorStory[] = [];
  const withRun = new Set<string>();
  for (const view of state.work) {
    const key = String(view.work.key);
    withRun.add(key);
    const story = storyOf.get(key);
    if (story === undefined || story.column === "desk") continue;
    const reviewing = story.column === "review" && view.phase === "review";
    (reviewing ? review : running).push({ story, view });
  }
  for (const story of state.stories) {
    const key = String(story.key);
    if (story.column === "review" && !withRun.has(key) && !waitsForYou.has(key)) {
      review.push({ story, view: null });
    }
  }
  return { running, review };
}

/** One selectable board row: a story, with its run while a session works on it. */
export interface BoardEntry {
  readonly key: StoryKey;
  readonly story: StoryId;
  readonly run: RunId | null;
}

/** The board's selectable rows in screen order: running, then in review. */
export function boardEntries(state: OfficeStoreState): BoardEntry[] {
  const { running, review } = floorStories(state);
  return [...running, ...review].map(({ story, view }) => ({
    key: story.key,
    story: story.story,
    run: view === null ? null : view.work.run,
  }));
}

/** The budget bar: `━` filled in acc, the rest in faint; `=` and `-` under `--ascii`. */
export function budgetSpans(share: number, ascii: boolean): Span[] {
  const g = glyphs(ascii);
  const filled = Math.max(0, Math.min(BAR_CELLS, Math.round(share * BAR_CELLS)));
  const rest = ascii ? "-" : g.done;
  return [
    { text: g.done.repeat(filled), role: "acc" },
    { text: rest.repeat(BAR_CELLS - filled), role: "faint" },
  ];
}

/** One line of the board: its spans, and the card it belongs to. */
interface FloorLine {
  readonly key: string;
  readonly spans: readonly Span[];
  readonly card: string | null;
}

interface FloorOptions {
  readonly state: OfficeStoreState;
  readonly chain: Chain;
  readonly latest: LatestLines | null;
  readonly selected: string | null | undefined;
  readonly now: number;
  readonly width: number;
  readonly ascii: boolean;
}

/** The card of one story: four lines for a running story, three for one in review. */
function cardLines(
  kind: "running" | "review",
  item: FloorStory,
  options: FloorOptions,
): FloorLine[] {
  const { state, latest, now, width, ascii } = options;
  const g = glyphs(ascii);
  const { story, view } = item;
  const key = String(story.key);
  const selected = key === options.selected;
  const indent = " ".repeat(INDENT);
  const line = (n: number, left: readonly Span[], right: readonly Span[] = []): FloorLine => ({
    key: `${key}:${n}`,
    card: key,
    spans: focused(spread(left, right, width - 1), selected),
  });
  const time = view === null ? "" : elapsed(view.usage.run.elapsedMs);
  const titleRoom = Math.max(0, width - 1 - INDENT - time.length - 2);
  const first = line(
    0,
    [
      { text: selected ? g.bar : " ", role: "acc" },
      { text: " " },
      kind === "running" ? { text: g.live, role: "ok" } : { text: g.idle, role: "acc" },
      { text: " " },
      { text: String(story.story).padEnd(10), role: "dim" },
      { text: truncate(story.title, titleRoom, g.ellipsis), role: "hi" },
    ],
    [{ text: `${time} `, role: "dim" }],
  );
  const pipeline = view === null ? "review" : view.phase;
  const marker =
    view === null
      ? ""
      : kind === "running"
        ? `loop ${view.progress.loop} of ${view.progress.loopCap}`
        : `round ${view.progress.reviewRound}`;
  const second = line(
    1,
    [{ text: indent }, ...pipelineSpans({ phase: pipeline, ascii })],
    [{ text: `${marker} `, role: "dim" }],
  );
  const lines = [first, second];
  if (view === null) {
    lines.push(
      line(2, [
        { text: indent },
        { text: `no session ${g.dot} waits for its review, test or merge`, role: "dim" },
      ]),
    );
  } else if (kind === "review") {
    const { criteriaMet, criteriaTotal } = view.progress;
    lines.push(
      line(2, [
        { text: indent },
        {
          text: `reviewer reading ${g.dot} criteria ${criteriaMet} of ${criteriaTotal} checked so far`,
          role: "dim",
        },
      ]),
    );
  } else {
    const parts = boardNowParts({
      view,
      worker: latest?.line(view.work.run, "worker") ?? null,
      question: state.questions.find((question) => question.work.run === view.work.run),
      now,
    });
    const unwell = view.health === "stuck" || view.health === "looping" || view.health === "lost";
    lines.push(
      line(
        2,
        [
          { text: indent },
          { text: "now ", role: "dim" },
          parts.asking ? { text: parts.lead, role: "acc" } : { text: parts.lead },
          { text: ` ${g.dot} ${parts.rest.join(` ${g.dot} `)}`, role: "dim" },
          ...(unwell
            ? [
                { text: ` ${g.dot} `, role: "dim" as const },
                { text: healthLabel(view.health), role: "err" as const },
              ]
            : []),
        ],
        [
          { text: "budget ", role: "dim" },
          ...budgetSpans(view.usage.budgetShare, ascii),
          { text: ` ${percent(view.usage.budgetShare)} ` },
        ],
      ),
    );
    const { criteriaMet, criteriaTotal, reviewRound } = view.progress;
    const complete = criteriaTotal > 0 && criteriaMet === criteriaTotal;
    lines.push(
      line(3, [
        { text: indent },
        { text: "criteria ", role: "dim" },
        {
          text: `${criteriaMet}/${criteriaTotal}${complete ? ` ${g.met}` : ""}`,
          role: complete ? "ok" : undefined,
        },
        {
          text: `${reviewRound > 0 ? ` ${g.dot} review round ${reviewRound}` : ""} ${g.dot} ${view.work.model}`,
          role: "dim",
        },
      ]),
    );
  }
  return lines;
}

/** A section header: the title in hi and bold, its note dim at the right. */
function header(key: string, title: string, note: string, width: number): FloorLine {
  return {
    key: `section:${key}`,
    card: null,
    spans: spread(
      [{ text: title, role: "hi", bold: true }],
      [{ text: note, role: "dim" }],
      width - 1,
    ),
  };
}

const blank = (key: string): FloorLine => ({ key, spans: [], card: null });

/** The board's lines: the sections, their cards and UP NEXT, before they are cut to the height. */
export function floorLines(options: FloorOptions): FloorLine[] {
  const { state, chain, width, ascii } = options;
  const g = glyphs(ascii);
  const { running, review } = floorStories(state);
  const summary = state.offices.find((entry) => entry.office === state.office)?.summary;
  const out: FloorLine[] = [];
  const slots = summary?.slots === undefined ? "" : `${running.length} of ${summary.slots} slots`;
  out.push(header("running", "RUNNING", slots, width), blank("after:running"));
  if (running.length === 0) {
    out.push({
      key: "idle",
      card: null,
      spans: [{ text: `  ${idleLine(state, g.dot)}`, role: "dim" }],
    });
  }
  const cards = (kind: "running" | "review", list: readonly FloorStory[]) =>
    list.forEach((item, i) => {
      if (i > 0) out.push(blank(`gap:${item.story.key}`));
      out.push(...cardLines(kind, item, options));
    });
  cards("running", running);
  if (review.length > 0) {
    out.push(blank("before:review"), header("review", "IN REVIEW", String(review.length), width));
    out.push(blank("after:review"));
    cards("review", review);
  }
  out.push(
    blank("before:next"),
    header(
      "next",
      "UP NEXT",
      `${columnCount(state, "ready")} ready ${g.dot} ${columnCount(state, "waiting")} waiting`,
      width,
    ),
    blank("after:next"),
  );
  const sentence = upNextSpans(chain, ascii ? "->" : "→");
  out.push({
    key: "sentence",
    card: null,
    spans:
      sentence === null
        ? [{ text: "    Nothing waits on another story.", role: "dim" }]
        : [{ text: "    " }, ...sentence],
  });
  return out;
}

/** The lines cut to `height`, from the first one, moved down so the selected card is on screen. */
export function fitFloor(
  lines: readonly FloorLine[],
  height: number,
  selected: string | null | undefined,
) {
  if (lines.length <= height) return lines;
  const last = lines.findLastIndex((line) => line.card !== null && line.card === selected);
  const start = last === -1 ? 0 : Math.max(0, last + 1 - height);
  return lines.slice(start, start + height);
}

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
  columns: number;
  /** Rows for the board, from its first line to its last. */
  height: number;
  clock: Clock;
  /** The newest output lines of the running runs; null until an office is open. */
  latest: LatestLines | null;
  /** The dependency chain the engine sent, for UP NEXT. */
  chain: Chain;
  /** The selected card by story key, marked with `▌`; Enter opens it. */
  selected?: string | null;
}) {
  const { state, display, columns } = props;
  const { ellipsis } = glyphs(display.ascii);
  useTick(props.clock, state.work.length > 0);
  if (state.office === null) {
    return <Text>{" No office selected. Press o to choose one."}</Text>;
  }
  if (state.loading && state.stories.length === 0) {
    return <Text>{` Loading${ellipsis}`}</Text>;
  }
  const all = floorLines({
    state,
    chain: props.chain,
    latest: props.latest,
    selected: props.selected,
    now: props.clock.now(),
    width: columns,
    ascii: display.ascii,
  });
  const shown = fitFloor(all, props.height, props.selected);
  return (
    <Box flexDirection="column">
      {shown.map((line) => (
        <SpanLine key={line.key} spans={cutSpans(line.spans, columns - 1)} display={display} />
      ))}
    </Box>
  );
}
