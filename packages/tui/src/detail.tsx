// The live agent detail (`Enter` on a running story, 0009 sections 4, 6 and 9). It answers "what is
// the worker doing right now" first: under the story header a `now` line shows the health, the
// phase and the newest output line (a tool call such as `[tool] Edit src/app.ts`, or the agent's
// words) with its age. Facts sit on the left (phase, health, loop over cap, verify, criteria,
// usage in, out, cache writes, cache reads and turns, budget bar, active signals with their start
// time) and the output of the selected source on the right; below 100 columns they stack.
//
// The output pane shows `work.output` of the worker (`w`) or of verify (`v`) and follows the tail.
// `k`/`j`, arrows and PageUp/PageDown scroll; scrolling past the text held reads earlier text with
// `work.outputRange`, and End returns to following. The text lives in an `OutputFeed` outside
// React; the render keeps only the rows on screen. When the run ends the detail keeps its last
// view and output, and says where the story went.

import type { OfficeStore, OfficeStoreState } from "@dipsaus-orchestrator/client";
import type {
  Clock,
  OfficeId,
  OutputSource,
  RunId,
  StoryKey,
  StoryView,
  WorkView,
} from "@dipsaus-orchestrator/contract";
import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";

import { budgetBar, evidenceOf, marked, percent, tokens, truncate } from "./format";
import type { Display } from "./options";
import { nowLine } from "./now";
import { evidenceEnabled } from "./overview";
import {
  type FeedChange,
  lastLine,
  OutputFeed,
  type RangeOutcome,
  rowCount,
  visibleRows,
} from "./output";
import { clockTime, glyphs, healthLabel } from "./views";

// The `now` line is shared with the overview (DIPO-81).
export { nowLine, shortAge } from "./now";

/** The run the detail shows; the key finds its story when the id changes. */
export interface DetailTarget {
  readonly run: RunId;
  readonly key: StoryKey;
}

export interface OutputRequest {
  readonly office: OfficeId;
  readonly run: RunId;
  readonly source: OutputSource;
  readonly from: number;
  readonly to?: number;
}

/** `work.outputRange` as the detail calls it. */
export type ReadOutput = (request: OutputRequest) => Promise<RangeOutcome>;

/** At this width and wider, facts and output sit side by side. */
export const SIDE_BY_SIDE_COLUMNS = 100;
/** The facts column when side by side. */
export const FACTS_WIDTH = 36;
/** The most criteria boxes drawn; more show as the count only. */
const MAX_BOXES = 20;

/** The confirmation `X` asks before `work.stop` (0009 section 5). */
export const STOP_PROMPT = "worker ends, branch kept, story parks as stopped";

/** A follow-only run (host alive, socket gone) cannot be steered (0006 decision 8). */
function signalFollowOnly(view: WorkView): boolean {
  return view.signals.some((signal) => signal.signal === "follow-only");
}

/** `DIPO-24 Add verify retry · developer · S · claude-sonnet · run_01J…  [follow]` (AC 1). */
export function headerLine(view: WorkView, story: StoryView | undefined, dot: string): string {
  const { work } = view;
  const parts = [
    `${work.story}${story === undefined ? "" : ` ${story.title}`}`,
    work.role,
    work.tier,
    work.model,
    String(work.run),
  ];
  return `${parts.join(` ${dot} `)}${signalFollowOnly(view) ? "  [follow]" : ""}`;
}

function criteriaBoxes(met: number, total: number): string {
  if (total === 0 || total > MAX_BOXES) return "";
  const checked = Math.min(met, total);
  return "[x]".repeat(checked) + "[ ]".repeat(total - checked);
}

/** The values of the facts panel, with evidence markers when the engine sends them. */
function facts(view: WorkView, evidence: boolean) {
  const { progress, usage } = view;
  const mark = (value: string, path: string) =>
    marked(value, evidenceOf(view.evidence, path, evidence));
  const run = usage.run;
  return {
    phase: view.phase,
    health: healthLabel(view.health),
    loop: mark(`${progress.loop}/${progress.loopCap}`, "progress.loop"),
    verify: mark(progress.verify, "progress.verify"),
    review: `round ${progress.reviewRound}`,
    criteria: mark(`${progress.criteriaMet}/${progress.criteriaTotal}`, "progress.criteriaMet"),
    boxes: criteriaBoxes(progress.criteriaMet, progress.criteriaTotal),
    input: `in ${mark(tokens(run.inputTokens), "usage.run.inputTokens")}`,
    output: `out ${mark(tokens(run.outputTokens), "usage.run.outputTokens")}`,
    cacheWrite: `cw ${mark(tokens(run.cacheCreateTokens), "usage.run.cacheCreateTokens")}`,
    cacheRead: `cr ${mark(tokens(run.cacheReadTokens), "usage.run.cacheReadTokens")}`,
    turns: `turns ${mark(String(run.turns), "usage.run.turns")}`,
    // Dollars are always an estimate from the pricing catalog (0009 section 8).
    cost: run.estimatedCost === undefined ? "" : `~$${run.estimatedCost.toFixed(2)}`,
    budget: `${budgetBar(usage)} ${mark(percent(usage.budgetShare), "usage.budgetShare")} of ${tokens(usage.budget.limit)}`,
    signals: view.signals.map(
      (signal) => `${signal.signal} since ${clockTime(Date.parse(signal.since))}`,
    ),
  };
}

/** The facts as a column of labelled lines, for the side-by-side layout (AC 2). */
export function factLines(view: WorkView, evidence: boolean): string[] {
  const f = facts(view, evidence);
  const lines = [
    `phase    ${f.phase}`,
    `health   ${f.health}`,
    `loop     ${f.loop}`,
    `verify   ${f.verify}`,
    `review   ${f.review}`,
    `criteria ${f.criteria}`,
  ];
  if (f.boxes !== "") lines.push(`         ${f.boxes}`);
  lines.push(
    `usage    ${f.input} ${f.output}`,
    `         ${f.cacheWrite} ${f.cacheRead}`,
    `         ${f.turns}${f.cost === "" ? "" : `  ${f.cost}`}`,
    `budget   ${f.budget}`,
  );
  if (f.signals.length === 0) lines.push("signals  none");
  f.signals.forEach((signal, i) => lines.push(`${i === 0 ? "signals  " : "         "}${signal}`));
  return lines;
}

/** The facts in four lines, for the stacked layout below 100 columns (AC 2). */
export function compactFactLines(view: WorkView, evidence: boolean): string[] {
  const f = facts(view, evidence);
  const cost = f.cost === "" ? "" : ` ${f.cost}`;
  return [
    `phase ${f.phase}  health ${f.health}  loop ${f.loop}  verify ${f.verify}  review ${f.review}`,
    `criteria ${f.criteria}${f.boxes === "" ? "" : `  ${f.boxes}`}`,
    `usage ${f.input} ${f.output} ${f.cacheWrite} ${f.cacheRead} ${f.turns}${cost}  budget ${f.budget}`,
    `signals: ${f.signals.length === 0 ? "none" : f.signals.join(", ")}`,
  ];
}

/** One output feed of the detail's run, re-created when the store read a snapshot again. */
function useFeed(options: {
  store: OfficeStore;
  readOutput: ReadOutput;
  office: OfficeId;
  run: RunId;
  source: OutputSource;
  tailBytes: number;
  snapshots: number;
}) {
  const { store, readOutput, office, run, source, tailBytes, snapshots } = options;
  const [version, setVersion] = useState(0);
  const lastChange = useRef<FeedChange>("reset");
  const feed = useMemo(
    () =>
      new OutputFeed(
        (from, to) =>
          readOutput(
            to === undefined ? { office, run, source, from } : { office, run, source, from, to },
          ),
        tailBytes,
        (change) => {
          lastChange.current = change;
          setVersion((n) => n + 1);
        },
      ),
    // A new snapshot means a history gap: read the output again.
    [store, readOutput, office, run, source, tailBytes, snapshots],
  );
  useEffect(() => {
    const stop = store.onOutput((chunk) => {
      if (chunk.run === run && chunk.source === source) feed.push(chunk);
    });
    void feed.load();
    return () => {
      stop();
      feed.close();
    };
  }, [feed, store, run, source]);
  return { feed, version, lastChange };
}

export interface DetailProps {
  readonly state: OfficeStoreState;
  readonly store: OfficeStore;
  readonly clock: Clock;
  readonly display: Display;
  readonly target: DetailTarget;
  readonly readOutput: ReadOutput;
  readonly columns: number;
  /** Rows for the detail, from its header to the end of the output pane. */
  readonly height: number;
  /** False while a prompt has the keys. */
  readonly keysActive: boolean;
  readonly tailBytes: number;
}

/** The last view of the run while the engine still sends it; kept after the run ends. */
export function useRunView(state: OfficeStoreState, target: DetailTarget): WorkView | undefined {
  const current = state.work.find((view) => view.work.run === target.run);
  const last = useRef<WorkView | undefined>(current);
  if (current !== undefined) last.current = current;
  return last.current;
}

export function Detail(props: DetailProps) {
  const { state, store, clock, display, target, columns, height } = props;
  const { dot, ellipsis } = glyphs(display.ascii);
  const view = useRunView(state, target);
  const [source, setSource] = useState<"worker" | "verify">("worker");
  // Rows from the bottom; 0 follows the tail.
  const [offset, setOffset] = useState(0);
  const [, setTick] = useState(0);
  const office = state.office;
  const feedOptions = {
    store,
    readOutput: props.readOutput,
    office: office ?? ("" as OfficeId),
    run: target.run,
    tailBytes: props.tailBytes,
    snapshots: state.snapshots,
  };
  const worker = useFeed({ ...feedOptions, source: "worker" });
  const verify = useFeed({ ...feedOptions, source: "verify" });
  const shown = source === "worker" ? worker : verify;

  // The age on the `now` line moves on without events.
  useEffect(() => {
    let handle = clock.setTimeout(function tick() {
      setTick((n) => n + 1);
      handle = clock.setTimeout(tick, 1_000);
    }, 1_000);
    return () => clock.clearTimeout(handle);
  }, [clock]);

  const side = columns >= SIDE_BY_SIDE_COLUMNS;
  const evidence = evidenceEnabled(state);
  const factText =
    view === undefined ? [] : side ? factLines(view, evidence) : compactFactLines(view, evidence);
  // Header and `now` line, then (stacked) the facts, then the pane's title and status lines.
  const paneHeight = Math.max(1, height - 2 - (side ? 0 : factText.length) - 2);
  const paneWidth = Math.max(10, side ? columns - FACTS_WIDTH - 3 : columns - 2);

  // Only the row count of all held text; the rows themselves are cut for the screen alone.
  const total = useMemo(
    () => rowCount(shown.feed.lines, paneWidth),
    [shown.feed, shown.version, paneWidth],
  );
  const maxOffset = Math.max(0, total - paneHeight);
  const scrolled = Math.min(offset, maxOffset);

  // Scrolled back, new text arrives below: keep the same rows on screen.
  const previousTotal = useRef(total);
  useEffect(() => {
    const delta = total - previousTotal.current;
    previousTotal.current = total;
    if (shown.lastChange.current === "append" && delta > 0) {
      setOffset((current) => (current > 0 ? current + delta : 0));
    }
  }, [total]);

  useEffect(() => {
    shown.feed.setFollowing(scrolled === 0);
  }, [shown.feed, scrolled === 0]);

  // The top of the pane reached the start of what is held: read earlier text.
  useEffect(() => {
    const feed = shown.feed;
    if (feed.loaded && !feed.busy && !feed.atStart && scrolled + paneHeight >= total) {
      void feed.loadEarlier();
    }
  }, [shown.feed, shown.version, scrolled, paneHeight, total]);

  useInput(
    (input, key) => {
      if (input === "w" || input === "v") {
        const next = input === "w" ? "worker" : "verify";
        if (next !== source) {
          setSource(next);
          setOffset(0);
        }
      } else if (key.upArrow || input === "k") {
        setOffset(Math.min(maxOffset, scrolled + 1));
      } else if (key.downArrow || input === "j") {
        setOffset(Math.max(0, scrolled - 1));
      } else if (key.pageUp) {
        setOffset(Math.min(maxOffset, scrolled + Math.max(1, paneHeight - 1)));
      } else if (key.pageDown) {
        setOffset(Math.max(0, scrolled - Math.max(1, paneHeight - 1)));
      } else if (key.end || input === "G") {
        setOffset(0);
      }
    },
    { isActive: props.keysActive },
  );

  if (view === undefined || office === null) {
    return <Text>{" This run is not in the office view."}</Text>;
  }

  const current = state.work.some((candidate) => candidate.work.run === target.run);
  const story = state.stories.find((candidate) => candidate.key === target.key);
  const ended = current ? undefined : (story ?? null);
  const now = nowLine({
    view,
    ended,
    worker: lastLine(worker.feed.lines),
    verify: lastLine(verify.feed.lines),
    now: clock.now(),
    dot,
  });

  const start = Math.max(0, total - paneHeight - scrolled);
  const visible = visibleRows(shown.feed.lines, paneWidth, paneHeight, scrolled);
  const feed = shown.feed;
  const tabs = source === "worker" ? "[w]orker* [v]erify" : "[w]orker [v]erify*";
  const title = `output (${source}) ${tabs}`;
  let status: string;
  if (feed.error !== null) status = feed.error;
  else if (!feed.loaded) status = `reading output${ellipsis}`;
  else if (feed.busy && scrolled > 0) status = `reading earlier output${ellipsis}`;
  else if (scrolled > 0) {
    const top = start === 0 && feed.atStart ? "start of output  " : "";
    status = `${top}${scrolled} rows below ${dot} [End] follow tail`;
  } else status = "following the tail";
  const empty = feed.loaded && total === 0 ? [`no ${source} output yet`] : [];
  const pane = (
    <Box flexDirection="column" width={side ? paneWidth + 1 : columns}>
      <Text wrap="truncate-end">{` ${truncate(title, paneWidth, ellipsis)}`}</Text>
      {[...empty, ...visible].map((row, i) => (
        <Text key={i} wrap="truncate-end">{` ${row}`}</Text>
      ))}
      {Array.from({ length: Math.max(0, paneHeight - visible.length - empty.length) }, (_, i) => (
        <Text key={`pad${i}`}> </Text>
      ))}
      <Text wrap="truncate-end">{` ${truncate(status, paneWidth, ellipsis)}`}</Text>
    </Box>
  );
  const header = (
    <>
      <Text wrap="truncate-end" bold={display.color}>
        {` ${truncate(headerLine(view, story, dot), columns - 1, ellipsis)}`}
      </Text>
      {display.color ? (
        <Text wrap="truncate-end" color={ended === undefined ? "cyan" : "yellow"}>
          {` ${truncate(now, columns - 1, ellipsis)}`}
        </Text>
      ) : (
        <Text wrap="truncate-end">{` ${truncate(now, columns - 1, ellipsis)}`}</Text>
      )}
    </>
  );
  if (!side) {
    return (
      <Box flexDirection="column">
        {header}
        {factText.map((line, i) => (
          <Text key={i} wrap="truncate-end">{` ${truncate(line, columns - 1, ellipsis)}`}</Text>
        ))}
        {pane}
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      {header}
      <Box flexDirection="row">
        <Box flexDirection="column" width={FACTS_WIDTH + 1}>
          {factText.map((line, i) => (
            <Text key={i} wrap="truncate-end">{` ${truncate(line, FACTS_WIDTH, ellipsis)}`}</Text>
          ))}
        </Box>
        <Box width={1} flexDirection="column">
          {Array.from({ length: paneHeight + 2 }, (_, i) => (
            <Text key={i}>{display.ascii ? "|" : "│"}</Text>
          ))}
        </Box>
        {pane}
      </Box>
    </Box>
  );
}
