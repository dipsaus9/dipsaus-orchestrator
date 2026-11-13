// The live agent detail (`Enter` on a running story, 0009). It answers "what is
// the worker doing right now" first: under the story header a `now` line shows the health, the
// phase and the newest output line (a tool call such as `[tool] <tool> src/app.ts`, or the agent's
// words) with its age. Under it the story's open questions show with their kind, age and text and
// how to answer them (`dipo answer`, DIPO-83). Facts sit on the left (phase, health, loop over
// cap, criteria, usage in, out, cache writes, cache reads and turns, budget bar) and the
// output of the selected source on the right; below 100 columns they stack.
//
// The output pane shows `work.output` of the worker (`w`) or of verify (`v`) and follows the tail.
// The key `i` swaps it for the prompt dipo sent the selected agent's session (`work.prompt`,
// DIPO-137): the system file and the first message, read from the top with the same scroll keys,
// or a line saying none is stored. `p` stays pause (0009).
// The engine's phase markers in the worker output read `── 12:04:31 phase: review ──` (DIPO-83).
// `k`/`j`, arrows and PageUp/PageDown scroll; scrolling past the text held reads earlier text with
// `work.outputRange`, and End returns to following. The text lives in an `OutputFeed` outside
// React; the render keeps only the rows on screen. When the run ends the detail keeps its last
// view and output, and says where the story went. A story that is not running opens its latest
// stored run the same way, read-only, with facts from the stored run (`past.ts`, DIPO-81).

import {
  healthLabel,
  type OfficeStore,
  type OfficeStoreState,
  percent,
  usageTokens,
} from "@dipsaus-orchestrator/client";
import { cleanText } from "@dipsaus-orchestrator/contract";
import type {
  AgentId,
  Clock,
  EngineError,
  OfficeId,
  OutputSource,
  PromptPart,
  QuestionView,
  RunId,
  RunRecord,
  StoryKey,
  WorkView,
} from "@dipsaus-orchestrator/contract";
import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";

import { composerRows } from "./composer";
import { budgetBar, elapsed, truncate } from "./format";
import type { Display } from "./options";
import { endedLine, shortAge } from "./now";
import { pipelineSpans } from "./pipeline";
import { cutSpans, type Span, SpanLine, spread } from "./spans";
import {
  filterEntries,
  nextFilter,
  type SentSteer,
  STREAM_FILTERS,
  type StreamFilter,
  streamEntries,
  type StreamRow,
  streamRows,
  youRow,
} from "./stream";
import { compactRecordFactLines, noOutputLine, recordFactLines, recordHeaderLine } from "./past";
import { type FeedChange, OutputFeed, type RangeOutcome, wrapLines } from "./output";
import { glyphs, officeOptIns, storedLabel } from "./views";
import { Colored } from "./colour";

// The age shared with the overview (DIPO-81).
export { shortAge } from "./now";

/** The run the detail shows; the key finds its story when the id changes. */
export interface DetailTarget {
  readonly run: RunId;
  readonly key: StoryKey;
  /** The stored run, when the detail opens a story that is not running (DIPO-81). */
  readonly record?: RunRecord;
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

/** What `work.prompt` answered for the detail's agent (DIPO-137). */
export type PromptOutcome =
  | {
      readonly ok: true;
      readonly result: { readonly texts: readonly { part: PromptPart; text: string }[] };
    }
  | { readonly ok: false; readonly error: EngineError };

/** `work.prompt` as the detail calls it. */
export type ReadPrompt = (request: {
  readonly office: OfficeId;
  readonly run: RunId;
  readonly agent: AgentId;
}) => Promise<PromptOutcome>;

/** The prompt pane's state: read from the engine when the key `i` is pressed. */
type PromptState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "loaded"; readonly texts: readonly { part: PromptPart; text: string }[] };

/** Said when the engine holds no prompt text for the session (DIPO-137). */
export const NO_PROMPT_STORED =
  "no prompt is stored for this session (privacy.storePrompts is off, or retention removed it)";

const PROMPT_TITLES: Readonly<Record<PromptPart, string>> = {
  system: "system file",
  message: "first message",
};

/** The prompt texts as lines, each under a header naming its part. */
export function promptLines(
  texts: readonly { part: PromptPart; text: string }[],
  dot: string,
): string[] {
  return texts.flatMap(({ part, text }, i) => [
    ...(i === 0 ? [] : [""]),
    `${dot} ${PROMPT_TITLES[part]}`,
    ...cleanText(text).replace(/\n+$/, "").split("\n"),
  ]);
}

/** At this width and wider, facts and output sit side by side. */
export const SIDE_BY_SIDE_COLUMNS = 100;
/** The facts column when side by side. */
export const FACTS_WIDTH = 28;
/** The facts column of a stored run, whose lines are longer. */
const RECORD_FACTS_WIDTH = 36;
/** The draft rows the steer box shows. */
const STEER_DRAFT_ROWS = 3;
/** The most criteria boxes drawn; more show as the count only. */
const MAX_BOXES = 20;
/** The most open questions the detail lists; more show as a count. */
export const MAX_QUESTIONS = 3;
/** The opt-in that puts tool inputs into the worker output (0007). */
const COMMAND_BODIES = "privacy.storeCommandBodies";

/** How to answer a question from a shell: `dipo answer <id> <text>` (DIPO-59). */
export function answerHint(question: QuestionView): string {
  return `dipo answer ${question.question} <text>`;
}

/**
 * The story's open questions, oldest first, two lines each: kind, age and text, then how to answer
 * (DIPO-83). At most `MAX_QUESTIONS`; more show as a count. Empty when none waits.
 */
export function questionLines(
  questions: readonly QuestionView[],
  now: number,
  dot: string,
): string[] {
  const open = questions.toSorted((a, b) => Date.parse(a.askedAt) - Date.parse(b.askedAt));
  const lines: string[] = [];
  for (const question of open.slice(0, MAX_QUESTIONS)) {
    const age = shortAge(now - Date.parse(question.askedAt));
    // One line: line breaks, tabs and control characters become single spaces.
    // oxlint-disable-next-line no-control-regex
    const text = question.text.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
    lines.push(`? ${question.kind} ${age} ago ${dot} ${text}`);
    lines.push(`  answer: ${answerHint(question)}`);
  }
  const more = open.length - MAX_QUESTIONS;
  if (more > 0) {
    lines.push(`  ${more} more open question${more === 1 ? "" : "s"} ${dot} dipo watch lists all`);
  }
  return lines;
}

function criteriaBoxes(met: number, total: number): string {
  if (total === 0 || total > MAX_BOXES) return "";
  const checked = Math.min(met, total);
  return "[x]".repeat(checked) + "[ ]".repeat(total - checked);
}

/** The values of the facts panel. */
function facts(view: WorkView) {
  const { progress, usage } = view;
  const run = usage.run;
  return {
    health: healthLabel(view.health),
    loop: `${progress.loop}/${progress.loopCap}`,
    review: `round ${progress.reviewRound}`,
    criteria: `${progress.criteriaMet}/${progress.criteriaTotal}`,
    boxes: criteriaBoxes(progress.criteriaMet, progress.criteriaTotal),
    input: `in ${usageTokens(run.inputTokens)}`,
    output: `out ${usageTokens(run.outputTokens)}`,
    cacheWrite: `cw ${usageTokens(run.cacheCreateTokens)}`,
    cacheRead: `cr ${usageTokens(run.cacheReadTokens)}`,
    turns: `turns ${run.turns}`,
    // Dollars are the cost the worker CLI reports, itself an estimate (0008).
    cost: run.estimatedCost === undefined ? "" : `~$${run.estimatedCost.toFixed(2)}`,
    budget: `${budgetBar(usage)} ${percent(usage.budgetShare)} of ${usageTokens(usage.budget.limit)}`,
  };
}

/** One labelled line of the Run's left column. */
function row(label: string, value: string | readonly Span[]): Span[] {
  return [
    { text: label.padEnd(10), role: "dim" },
    ...(typeof value === "string" ? [{ text: value }] : value),
  ];
}

/** The width of the bar under the budget line. */
const BUDGET_BAR_CELLS = 25;

/**
 * The facts as the Run's left column (ux-spec S3): dim labels over values, usage and the budget bar
 * as their own blocks, for the side-by-side layout (AC 2).
 */
export function factRows(view: WorkView, width: number, ascii: boolean): Span[][] {
  const g = glyphs(ascii);
  const f = facts(view);
  const { progress, usage } = view;
  const done = progress.criteriaTotal > 0 && progress.criteriaMet >= progress.criteriaTotal;
  const run = String(view.work.run);
  const filled = Math.round(Math.min(1, Math.max(0, usage.budgetShare)) * BUDGET_BAR_CELLS);
  const bar = g.done;
  const { run: totals } = usage;
  const rows: Span[][] = [
    row("PHASE", view.phase),
    row("HEALTH", [
      { text: `${g.live} `, role: view.health === "busy" ? "ok" : "acc" },
      { text: f.health },
    ]),
    row(
      "CRITERIA",
      done ? [{ text: `${f.criteria} ${g.met}`, role: "ok" }] : [{ text: f.criteria }],
    ),
    row("REVIEW", f.review),
    [],
    [{ text: "USAGE", role: "dim" }],
    row("in", usageTokens(totals.inputTokens)),
    row("out", usageTokens(totals.outputTokens)),
    row("cache w", usageTokens(totals.cacheCreateTokens)),
    row("cache r", usageTokens(totals.cacheReadTokens)),
    row("turns", String(totals.turns)),
    [],
    row("BUDGET", `${percent(usage.budgetShare)} of ${usageTokens(usage.budget.limit)}`),
    [
      { text: bar.repeat(filled), role: "acc" },
      { text: bar.repeat(BUDGET_BAR_CELLS - filled), role: "faint" },
    ],
    [],
    row("MODEL", view.work.model),
    row("RUN", run.length > 12 ? `${g.ellipsis}${run.slice(-10)}` : run),
  ];
  return rows.map((spans) => cutSpans(spans, width));
}

/** The facts in four lines, for the stacked layout below 100 columns (AC 2). */
export function compactFactLines(view: WorkView): string[] {
  const f = facts(view);
  const cost = f.cost === "" ? "" : ` ${f.cost}`;
  return [
    `health ${f.health}  loop ${f.loop}  review ${f.review}`,
    `criteria ${f.criteria}${f.boxes === "" ? "" : `  ${f.boxes}`}`,
    `usage ${f.input} ${f.output} ${f.cacheWrite} ${f.cacheRead} ${f.turns}${cost}  budget ${f.budget}`,
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
  readonly readPrompt: ReadPrompt;
  readonly columns: number;
  /** Rows for the detail, from its header to the end of the output pane. */
  readonly height: number;
  /** False while a prompt has the keys. */
  readonly keysActive: boolean;
  readonly tailBytes: number;
  /** The steer draft while the Composer is open in the stream, else null (home owns it). */
  readonly steer: string | null;
  /** What the maintainer steered this run with, oldest first, as `you` lines. */
  readonly sent: readonly SentSteer[];
}

/** The Composer at the foot of the stream: a box with the draft, under a title and over its keys. */
function SteerBox(props: {
  readonly display: Display;
  readonly story: string;
  readonly draft: string;
  readonly width: number;
  readonly ascii: boolean;
}) {
  const { display, width, ascii } = props;
  const { dot } = glyphs(ascii);
  const { tl, tr, bl, br, h, v } = ascii
    ? { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" }
    : { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" };
  const room = width - 5;
  const drafted = composerRows(props.draft, room + 2, STEER_DRAFT_ROWS, "");
  const cursor = ascii ? "_" : "▍";
  const edge = (left: string, right: string): readonly Span[] => [
    { text: `${left}${h.repeat(width - 4)}${right}`, role: "acc" },
  ];
  const boxed = (inside: readonly Span[]): readonly Span[] => {
    const used = inside.reduce((sum, span) => sum + span.text.length, 0);
    return [
      { text: v, role: "acc" },
      { text: " " },
      ...inside,
      { text: `${" ".repeat(Math.max(0, room - used))}` },
      { text: v, role: "acc" },
    ];
  };
  const draftRow = (i: number): readonly Span[] => {
    const text = (drafted[i] ?? "").slice(0, room);
    if (i !== drafted.length - 1) return boxed([{ text, role: "hi" }]);
    return boxed([
      { text: text.slice(0, -1), role: "hi" },
      { text: cursor, role: "acc" },
    ]);
  };
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <SpanLine display={display} spans={edge(tl, tr)} />
      <SpanLine
        display={display}
        spans={boxed([
          {
            text: `steer ${props.story} ${dot} arrives at its next turn`.slice(0, room),
            role: "dim",
          },
        ])}
      />
      {Array.from({ length: STEER_DRAFT_ROWS }, (_, i) => (
        <SpanLine key={i} display={display} spans={draftRow(i)} />
      ))}
      <SpanLine display={display} spans={edge(bl, br)} />
      <SpanLine
        display={display}
        spans={[
          { text: "⏎", role: "acc" },
          { text: " send   ", role: "dim" },
          { text: "⌥⏎", role: "acc" },
          { text: " new line   ", role: "dim" },
          { text: "esc", role: "acc" },
          { text: " cancel", role: "dim" },
        ]}
      />
    </Box>
  );
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
  const [filter, setFilter] = useState<StreamFilter>("all");
  // Enter shows every tool target whole; Enter again cuts them to one row.
  const [full, setFull] = useState(false);
  const source = filter === "prompt" ? "prompt" : filter === "verify" ? "verify" : "worker";
  // The prompt pane reads from its top; rows scrolled off the top.
  const [promptTop, setPromptTop] = useState(0);
  const [prompt, setPrompt] = useState<PromptState>({ kind: "loading" });
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
  // The prompt pane keeps the worker feed running underneath, so the `now` line stays current.
  const shown = source === "verify" ? verify : worker;

  // The age on the `now` line moves on without events.
  useEffect(() => {
    let handle = clock.setTimeout(function tick() {
      setTick((n) => n + 1);
      handle = clock.setTimeout(tick, 1_000);
    }, 1_000);
    return () => clock.clearTimeout(handle);
  }, [clock]);

  // The session the prompt pane shows: the live agent, or the last agent of a stored run.
  const promptAgent: AgentId | undefined =
    props.state.work.find((candidate) => candidate.work.run === target.run)?.work.agent ??
    target.record?.agents.at(-1);
  const promptOffice = state.office;
  useEffect(() => {
    if (source !== "prompt") return;
    if (promptAgent === undefined || promptOffice === null) {
      setPrompt({ kind: "loaded", texts: [] });
      return;
    }
    let current = true;
    setPrompt({ kind: "loading" });
    props
      .readPrompt({ office: promptOffice, run: target.run, agent: promptAgent })
      .then(
        (outcome): PromptState =>
          outcome.ok
            ? { kind: "loaded", texts: outcome.result.texts }
            : { kind: "error", message: `${outcome.error.code}: ${outcome.error.message}` },
        (error): PromptState => ({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        }),
      )
      .then((next) => {
        if (current) setPrompt(next);
      });
    return () => {
      current = false;
    };
  }, [source, promptAgent, promptOffice, target.run, state.snapshots, props.readPrompt]);

  const side = columns >= SIDE_BY_SIDE_COLUMNS;
  const current = state.work.some((candidate) => candidate.work.run === target.run);
  const story = state.stories.find((candidate) => candidate.key === target.key);
  const record = view === undefined ? target.record : undefined;
  const factText =
    view !== undefined
      ? compactFactLines(view)
      : record === undefined
        ? []
        : side
          ? recordFactLines(record, clock.now())
          : compactRecordFactLines(record, clock.now());
  // The story's open questions, under the `now` line (DIPO-83).
  const questionText = questionLines(
    state.questions.filter((question) => question.work.key === target.key),
    clock.now(),
    dot,
  );
  // Header lines, the pipeline, a rule and the questions, then (stacked) the facts, the filter tabs
  // and the steer box under the stream.
  const steerRows = props.steer === null ? 0 : STEER_DRAFT_ROWS + 4;
  const paneHeight = Math.max(
    1,
    height -
      2 -
      (view === undefined ? 0 : 1) -
      (current ? 0 : 1) -
      questionText.length -
      (side ? 0 : factText.length) -
      1 -
      steerRows,
  );
  const factsWidth = view === undefined ? RECORD_FACTS_WIDTH : FACTS_WIDTH;
  const paneWidth = Math.max(10, side ? columns - factsWidth - 1 : columns);

  // The rows of the filtered stream: what the worker and verify wrote, then what was steered.
  const rule = display.ascii ? "-" : "─";
  const streamAll = useMemo(() => {
    const entries = filterEntries(
      filter,
      streamEntries(worker.feed.lines, dot),
      streamEntries(verify.feed.lines, dot, "verify"),
    );
    return streamRows(entries, paneWidth, { full, dot, ellipsis, rule });
  }, [
    worker.feed,
    worker.version,
    verify.feed,
    verify.version,
    filter,
    paneWidth,
    full,
    dot,
    ellipsis,
    rule,
  ]);
  const youRows = useMemo(
    () =>
      filter === "all" || filter === "worker"
        ? props.sent.map((sent) => youRow(sent, paneWidth, { dot, ellipsis }))
        : [],
    [filter, props.sent, paneWidth, dot, ellipsis],
  );
  const total = streamAll.length + youRows.length;
  const promptRows = useMemo(
    () =>
      prompt.kind === "loaded" && prompt.texts.length > 0
        ? wrapLines(promptLines(prompt.texts, dot), paneWidth)
        : [],
    [prompt, paneWidth, dot],
  );
  const promptMax = Math.max(0, promptRows.length - paneHeight);
  const promptAt = Math.min(promptTop, promptMax);
  const maxOffset = Math.max(0, total - paneHeight);
  const scrolled = Math.min(offset, maxOffset);

  // Scrolled back, new text arrives below: keep the same rows on screen.
  const previousTotal = useRef(total);
  useEffect(() => {
    const delta = total - previousTotal.current;
    previousTotal.current = total;
    if (shown.lastChange.current === "append" && delta > 0) {
      setOffset((held) => (held > 0 ? held + delta : 0));
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
      if (input === "v") {
        setFilter(nextFilter(filter));
        setOffset(0);
        setPromptTop(0);
      } else if (key.return) {
        setFull(!full);
      } else if (source === "prompt") {
        const page = Math.max(1, paneHeight - 1);
        if (key.upArrow || input === "k") setPromptTop(Math.max(0, promptAt - 1));
        else if (key.downArrow || input === "j") setPromptTop(Math.min(promptMax, promptAt + 1));
        else if (key.pageUp) setPromptTop(Math.max(0, promptAt - page));
        else if (key.pageDown) setPromptTop(Math.min(promptMax, promptAt + page));
        else if (key.end || input === "G") setPromptTop(promptMax);
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

  if ((view === undefined && record === undefined) || office === null) {
    return <Text>{" This run is not in the office view."}</Text>;
  }

  const ended = current ? undefined : (story ?? null);

  const start = Math.max(0, total - paneHeight - scrolled);
  const stream = [...streamAll, ...youRows];
  const end = Math.max(0, stream.length - scrolled);
  const visible = stream.slice(Math.max(0, end - paneHeight), end);
  const feed = shown.feed;
  let status: string;
  if (feed.error !== null) status = feed.error;
  else if (!feed.loaded) status = `reading output${ellipsis}`;
  else if (feed.busy && scrolled > 0) status = `reading earlier output${ellipsis}`;
  else if (scrolled > 0) {
    const top = start === 0 && feed.atStart ? "start of output  " : "";
    status = `${top}paused ${dot} G to follow`;
  } else status = `following ${display.ascii ? "v" : "↓"}`;
  // The office's stored-output retention period, from its summary (DIPO-97).
  const retentionDays = state.offices.find((entry) => entry.office === state.office)?.summary
    ?.outputRetentionDays;
  const empty: StreamRow[] =
    feed.loaded && total === 0
      ? [
          [
            {
              text: `  ${
                ended === undefined
                  ? `no ${filter === "all" ? "worker" : filter} output yet`
                  : noOutputLine(
                      record?.endedAt ?? record?.inReviewSince,
                      clock.now(),
                      retentionDays,
                    )
              }`,
              role: "dim",
            },
          ],
        ]
      : [];
  let rows: readonly StreamRow[] = [...empty, ...visible];
  if (source === "prompt") {
    if (prompt.kind === "loading") status = `reading prompt${ellipsis}`;
    else if (prompt.kind === "error") status = prompt.message;
    else if (promptRows.length === 0) status = "esc back";
    else {
      status = `rows ${promptAt + 1}-${Math.min(promptRows.length, promptAt + paneHeight)} of ${promptRows.length}`;
    }
    rows = (
      prompt.kind === "loaded" && promptRows.length === 0
        ? [NO_PROMPT_STORED]
        : promptRows.slice(promptAt, promptAt + paneHeight)
    ).map((text): StreamRow => [{ text: `  ${text}` }]);
  }
  // With commands stored (the default, DIPO-135), tool lines in the worker output carry their
  // commands (0007).
  const stores = source === "worker" && officeOptIns(state).includes(COMMAND_BODIES);
  const tabs = STREAM_FILTERS.flatMap((name, i): Span[] => [
    ...(i === 0 ? [] : [{ text: " ".repeat(3) }]),
    name === filter ? { text: name, role: "hi", underline: true } : { text: name, role: "dim" },
  ]);
  const right = `${stores ? `${storedLabel([COMMAND_BODIES])} ${dot} ` : ""}${status}`;
  const tabRow = spread(
    [{ text: "  " }, ...tabs],
    [{ text: truncate(right, Math.max(10, paneWidth - 30), ellipsis), role: "dim" }],
    paneWidth,
  );
  const pane = (
    <Box flexDirection="column" width={paneWidth}>
      <SpanLine display={display} spans={tabRow} />
      {rows.map((line, i) => (
        <SpanLine key={i} display={display} spans={cutSpans(line, paneWidth)} />
      ))}
      {Array.from({ length: Math.max(0, paneHeight - rows.length) }, (_, i) => (
        <Text key={`pad${i}`}> </Text>
      ))}
      {props.steer === null ? null : (
        <SteerBox
          display={display}
          story={String(story?.story ?? view?.work.story ?? "")}
          draft={props.steer}
          width={paneWidth}
          ascii={display.ascii}
        />
      )}
    </Box>
  );
  const title = story?.title ?? view?.work.story ?? record?.run ?? "";
  const loopLine =
    view === undefined
      ? []
      : [
          {
            text: `loop ${view.progress.loop} of ${view.progress.loopCap} ${dot} ${elapsed(clock.now() - Date.parse(view.startedAt))}`,
            role: "dim" as const,
          },
        ];
  const header = (
    <>
      <Colored display={display} role="hi" bold wrap="truncate-end">
        {`${truncate(
          view === undefined && record !== undefined
            ? recordHeaderLine(record, story, dot)
            : String(title),
          columns - 1,
          ellipsis,
        )}`}
      </Colored>
      {view === undefined ? null : (
        <SpanLine
          display={display}
          spans={spread(
            pipelineSpans({ phase: view.phase, ascii: display.ascii }),
            loopLine,
            columns,
          )}
        />
      )}
      <Text wrap="truncate-end">{rule.repeat(columns)}</Text>
      {ended === undefined ? null : (
        <Colored display={display} role="dim" wrap="truncate-end">
          {` ${truncate(endedLine(ended, dot, record), columns - 1, ellipsis)}`}
        </Colored>
      )}
      {questionText.map((line, i) => (
        <Colored key={`q${i}`} display={display} role="acc" wrap="truncate-end">
          {` ${truncate(line, columns - 1, ellipsis)}`}
        </Colored>
      ))}
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
        <Box flexDirection="column" width={factsWidth}>
          {view === undefined
            ? factText.map((line, i) => (
                <Text key={i} wrap="truncate-end">
                  {truncate(line, factsWidth - 1, ellipsis)}
                </Text>
              ))
            : factRows(view, FACTS_WIDTH, display.ascii)
                .slice(0, paneHeight + 1 + steerRows)
                .map((spans, i) => <SpanLine key={i} display={display} spans={spans} />)}
        </Box>
        <Box width={1} flexDirection="column">
          {Array.from({ length: paneHeight + 1 + steerRows }, (_, i) => (
            <Colored key={i} display={display} role="faint">
              {display.ascii ? "|" : "│"}
            </Colored>
          ))}
        </Box>
        {pane}
      </Box>
    </Box>
  );
}
