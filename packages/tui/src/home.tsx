// The home mode of the TUI (0009, DIPO-443, DIPO-458): the rooms behind `1` to `3` (desk, floor,
// queue), the test checklist `t` opens from a desk row, the privacy settings, the live agent detail
// and the desk card over them, and the `work.run` `R` sends from a queue row. `useHome` holds
// their state and keys; `HomeMode` draws the one that shows. `app.tsx` wires it to the modes and
// the footer. A run's result shows once in the ticker and clears on the next key.

import {
  cursorReached,
  type OfficeStore,
  type OfficeStoreState,
} from "@dipsaus-orchestrator/client";
import {
  type Clock,
  type Cursor,
  type DeskItem,
  type EngineError,
  officeSetPrivacy,
  type StoryKey,
} from "@dipsaus-orchestrator/contract";
import { Box, type Key, useWindowSize } from "ink";
import { useEffect, useState } from "react";

import type { ActionTarget, useActions } from "./actions";
import type { RunRequest, RunResult, TuiActions } from "./app";
import { Checklist, endedWords, firstUnticked } from "./checklist";
import {
  Desk,
  DESK_SPLIT_COLUMNS,
  deskGroups,
  deskRowId,
  selectedRow,
  sinceBand,
  useDesk,
} from "./desk";
import { previewLines } from "./desk-preview";
import { Detail, type DetailTarget } from "./detail";
import { useSteering } from "./steering";
import { useChain, useGate } from "./chain";
import { skipReason } from "./format";
import { useDigest } from "./digest";
import { NO_KEY } from "./input";
import { type ActionId, binding, type Hint, rowKeys, viewKeys } from "./keys";
import { NO_FOCUS, type PaletteFocus } from "./palette";
import { useLatestLines } from "./latest";
import type { Display } from "./options";
import { OUTPUT_TAIL_BYTES } from "./output";
import { promptRows } from "./prompt-box";
import type { SegLine } from "./segments";
import { waitsOn } from "./lane";
import { boardEntries, isBacklogEntry, Overview } from "./overview";
import { doneCount, Queue, queueRows } from "./queue";
import { readyLines } from "@dipsaus-orchestrator/client";
import { privacySettings, Settings, settingName, appliesWords } from "./settings";
import {
  type CardOutcome,
  type DiffOutcome,
  nextOpen,
  SECTIONS,
  type Section,
  StoryCard,
} from "./story-card";
import { glyphs } from "./views";
import { Shaded } from "./colour";

export type View = "overview" | "queue" | "settings" | "desk" | "checklist";

/** The story a desk row opened with Enter, and what `story.detail` answered for it. */
interface CardState {
  readonly item: DeskItem;
  readonly outcome: CardOutcome | null;
  readonly top: number;
  /** The section shown (DIPO-462), the earlier review rounds shown open and the diff once read. */
  readonly section: Section;
  readonly open: readonly number[];
  readonly diff: DiffOutcome | null;
}

/** The live agent detail and the view Esc returns to. */
interface DetailState {
  readonly target: DetailTarget;
  readonly back: View;
}

/** One `work.run` the maintainer sent, from send to done. */
export interface RunAction {
  readonly request: RunRequest;
  readonly label: string;
  readonly status: "sending" | "syncing" | "done" | "failed";
  readonly result?: RunResult;
  readonly cursor?: Cursor;
  /** The store's snapshot count when the reply arrived; a later re-read has seen the write. */
  readonly snapshots?: number;
  readonly error?: EngineError;
}

/** One line of text: line breaks and control characters become single spaces. */
function oneLine(text: string): string {
  // oxlint-disable-next-line no-control-regex
  return text.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
}

/** The rows PgUp and PgDn move the desk's preview by (DIPO-483). */
const DESK_SCROLL_STEP = 8;

/** The park reasons whose resume note starts as the park's detail: the failing check, the paths. */
const PREFILLED_PARKS: ReadonlySet<string> = new Set([
  "verify-failing",
  "conflict",
  "worker-failed",
]);

/** What a desk row's action is about, with the command line the engine built for it. */
function deskTarget(item: DeskItem, cli: string, id: ActionId): ActionTarget {
  const prefill =
    id === "resume" && PREFILLED_PARKS.has(item.reason ?? "") && !cli.includes("--note");
  return {
    row: deskRowId(item),
    ...(prefill ? { prefill: item.detail } : {}),
    ...(item.story === undefined ? {} : { story: String(item.story) }),
    ...(item.question === undefined ? {} : { question: String(item.question) }),
    ...(item.gate === undefined ? {} : { gate: String(item.gate) }),
    ...(item.note === undefined ? {} : { note: item.note.id }),
    ...(item.idea === undefined ? {} : { idea: item.idea.id, title: item.idea.title }),
    cli,
    ...(id === "answer" ? { text: item.detail } : {}),
  };
}

/**
 * A run as one ticker line (DIPO-458): what started and, after it, what was skipped and why, so no
 * list of skipped stories stays under the views.
 */
export function runSummary(
  action: RunAction,
  state: OfficeStoreState,
  ellipsis: string,
  dot: string,
): string | null {
  switch (action.status) {
    case "sending":
      return `run ${action.label}: sending${ellipsis}`;
    case "failed":
      return null;
    default:
      break;
  }
  const result = action.result;
  const head =
    action.status === "syncing"
      ? `run ${action.label}: answered, waiting for the office stream${ellipsis}`
      : `run ${action.label}: done`;
  if (result === undefined) return head;
  const parts = result.started.map((story) => `started ${story.story}`);
  for (const story of result.skipped) {
    const view = state.stories.find((candidate) => String(candidate.story) === story.story);
    const needs =
      story.reason === "dependency" && view?.waitingOn !== undefined && view.waitingOn.length > 0
        ? ` (needs ${view.waitingOn.join(", ")})`
        : "";
    parts.push(`skipped ${story.story}: ${skipReason(story.reason)}${needs}`);
  }
  if (parts.length === 0) parts.push("no Ready story to start");
  return [head, ...parts].join(`  ${dot}  `);
}

/** A key table entry as a footer hint. */
/** A Refined story: the only row Y sets Ready. */
const isRefined = (row: { readonly view: { readonly lifecycle: string } }) =>
  row.view.lifecycle === "Refined";

function hintOf(entry: { key: string; label: string; priority: number }): Hint {
  return { key: entry.key, label: entry.label, priority: entry.priority };
}

/** True for the keys that leave an overlay for a room: `1` to `6` and `O`. */
export function leavesOverlay(input: string): boolean {
  return ["1", "2", "3", "4", "5", "6", "O"].includes(input);
}

/** What `useHome` needs from the app around it. */
export interface HomeArgs {
  readonly store: OfficeStore;
  readonly clock: Clock;
  readonly display: Display;
  readonly actions: TuiActions;
  /** The batched store state. */
  readonly state: OfficeStoreState;
  readonly ellipsis: string;
  readonly acts: ReturnType<typeof useActions>;
  /** Starts a key table action, or says why it is off. */
  readonly act: (id: ActionId, target: ActionTarget) => void;
  readonly setMessage: (message: string | null) => void;
  /** True, with the footer saying so, while offline: the caller sends nothing. */
  readonly refusedOffline: () => boolean;
  /** `O`: opens Offices. */
  readonly openSwitcher: () => void;
  /** `c`: copies a story or run id to the clipboard. */
  readonly copy: (text: string) => void;
  /** Asks to confirm a privacy change (the mode `confirm-privacy`). */
  readonly confirmPrivacy: (key: string, value: boolean) => void;
  /** `o`: opens a PR in the browser; resolves to why it did not open, or null. */
  readonly openUrl: (url: string) => Promise<string | null>;
}

/** The state, the keys and the footer facts of the home mode. */
export function useHome(args: HomeArgs) {
  const { store, clock, display, actions, state, ellipsis, acts, act, setMessage } = args;
  const { columns } = useWindowSize();
  const [view, setView] = useState<View>("overview");
  // `z` on the run stream: the stream takes the whole screen (DIPO-458).
  const [expanded, setExpanded] = useState(false);
  // The selected queue row by story key, so it follows the story when the queue changes.
  const [queueKey, setQueueKey] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  // The Refined rows marked with space, by story key; `Y` sets them Ready (DIPO-482).
  const [marks, setMarks] = useState<ReadonlySet<string>>(new Set());
  const [run, setRun] = useState<RunAction | null>(null);
  // Why an `R` was refused; cleared by the next key and when the run it names ends.
  const [refusal, setRefusal] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);
  // The steer Composer in the stream and the `you` lines it sent (DIPO-461).
  const steering = useSteering({ actions, state, clock });
  // The selected overview row by story key, so it follows the story when rows come and go.
  const [overviewKey, setOverviewKey] = useState<string | null>(null);
  // The selected privacy setting, and whether one was written (the comments warning is then gone).
  const [settingsIndex, setSettingsIndex] = useState(0);
  const [privacyWritten, setPrivacyWritten] = useState(false);
  // The checklist (DIPO-365): the story whose open test shows (null: the first open test), the view
  // Esc returns to, the step the cursor is on and the steps ticked, by test id, on this screen.
  const [checklistKey, setChecklistKey] = useState<string | null>(null);
  // The story id the checklist names its story by, never the internal key (DIPO-421).
  const [checklistStory, setChecklistStory] = useState<string | null>(null);
  const [checklistBack, setChecklistBack] = useState<View>("overview");
  const [checklistStep, setChecklistStep] = useState(0);
  const [ticks, setTicks] = useState<Readonly<Record<string, readonly number[]>>>({});
  // The newest output line of each running run, for the overview's `now:` lines (DIPO-81).
  const { latest } = useLatestLines({
    store,
    clock,
    readOutput: actions.readOutput,
    office: state.office,
    runs: state.work.map((candidate) => candidate.work.run),
    snapshots: state.snapshots,
  });
  // Every board row is selectable: running stories first, then needs you, in review and Ready.
  const board = boardEntries(state);
  const overviewIndex = Math.max(
    0,
    board.findIndex((entry) => String(entry.key) === overviewKey),
  );
  const overviewPick = board[overviewIndex] ?? null;
  // The BACKLOG row (DIPO-481) is no story: its Enter lists the lane's open changes under it.
  const backlogSelected = overviewPick !== null && isBacklogEntry(overviewPick);
  const overviewEntry = overviewPick === null || isBacklogEntry(overviewPick) ? null : overviewPick;
  const [backlogOpen, setBacklogOpen] = useState(false);
  const queue = queueRows(state.stories, showDone);
  const queueSelected = Math.max(
    0,
    queue.findIndex((row) => row.view.key === queueKey),
  );
  const queueRow = queue[queueSelected] ?? null;
  // What `Y` sets Ready: the marked rows that are still Refined, else the focused one if it is.
  const readyTargets = (() => {
    const marked = queue.filter((row) => marks.has(String(row.view.key)) && isRefined(row));
    if (marked.length > 0) return marked;
    return queueRow !== null && isRefined(queueRow) ? [queueRow] : [];
  })();
  // The dependency chain the Floor and the Queue draw, and the selected story's gate (DIPO-460).
  const chain = useChain({
    readChain: actions.readChain,
    office: state.office,
    stories: state.stories,
    active: view === "overview" || view === "queue",
  });
  const gate = useGate({
    readGate: actions.readGate,
    office: state.office,
    story: queueRow === null ? null : queueRow.view.story,
    version: queueRow === null ? "" : `${queueRow.view.column}:${queueRow.view.lifecycle}`,
    active: view === "queue",
  });
  const selectQueue = (index: number) => {
    const row = queue[Math.max(0, Math.min(queue.length - 1, index))];
    setQueueKey(row === undefined ? null : row.view.key);
  };
  // The desk (DIPO-308): read while it or a story opened from it shows; the selection by row id,
  // else its story key, else its place.
  const [deskSelection, setDeskSelection] = useState<{
    readonly id: string | null;
    readonly key: string | null;
    readonly index: number;
  }>({ id: null, key: null, index: 0 });
  const [card, setCard] = useState<CardState | null>(null);
  // Below 100 columns Enter opens the focused item's preview full screen (spec.md, Widths).
  const [deskPreview, setDeskPreview] = useState(false);
  // The preview's first row: PgUp and PgDn move it by a step, and moving the selection resets it.
  const [deskScroll, setDeskScroll] = useState(0);
  // The digest whose Since band any key dismissed, by its `since`.
  const [sinceDismissed, setSinceDismissed] = useState<string | null>(null);
  const desk = useDesk({
    store,
    clock,
    readDesk: actions.readDesk,
    office: state.office,
    active: view === "desk" && detail === null,
    snapshots: state.snapshots,
  });
  const deskAll = desk.items === null ? [] : deskGroups(desk.items).all;
  const deskIndex = selectedRow(deskAll, deskSelection);
  const deskItem = deskAll[deskIndex] ?? null;
  const selectDesk = (index: number) => {
    const item = deskAll[Math.max(0, Math.min(deskAll.length - 1, index))];
    if (item === undefined) return;
    setDeskSelection({
      id: deskRowId(item),
      key: item.key ?? null,
      index: Math.max(0, Math.min(deskAll.length - 1, index)),
    });
  };
  const digest = useDigest({
    office: state.office,
    readDigest: actions.readDigest,
    clock,
  });
  const deskNarrow = columns < DESK_SPLIT_COLUMNS;
  // The Since band shows on the wide Desk until any key dismisses it (spec.md, The frame).
  const sinceShown =
    view === "desk" &&
    detail === null &&
    card === null &&
    !deskNarrow &&
    digest !== null &&
    digest.since !== sinceDismissed &&
    sinceBand(digest, columns - 1, display.ascii) !== null;
  // The open test the checklist shows: the story's, else the first open one (DIPO-365).
  const checklistTest =
    state.tests.find((test) => checklistKey === null || String(test.key) === checklistKey) ?? null;
  /** `t` on a desk row: the checklist of `story`; Esc returns to `back`. */
  const openChecklist = (
    story: { readonly key: string; readonly id: string } | null,
    back: View,
  ) => {
    setMessage(null);
    setChecklistKey(story?.key ?? null);
    setChecklistStory(story?.id ?? null);
    setChecklistBack(back);
    setChecklistStep(0);
    setView("checklist");
  };
  /** `y` or `n` on the checklist: passes or fails the open test, a fail with its note (DIPO-365). */
  const recordTest = (id: "pass" | "fail") => {
    if (checklistTest === null) {
      setMessage("no test is open to record");
    } else {
      const ticked = ticks[checklistTest.test] ?? [];
      act(id, {
        story: String(checklistTest.story),
        test: checklistTest.test,
        ...(id === "fail"
          ? { prefill: firstUnticked(checklistTest.steps, ticked)?.check ?? "" }
          : {}),
      });
    }
  };
  /** `a` on a run: answers its oldest open question. */
  const answerRun = (runId: string) => {
    const question = state.questions
      .filter((candidate) => candidate.work.run === runId)
      .toSorted((a, b) => Date.parse(a.askedAt) - Date.parse(b.askedAt))[0];
    if (question === undefined) {
      setMessage("no question waits on this run");
    } else {
      act("answer", {
        story: String(question.work.story),
        question: question.question,
        text: JSON.stringify(oneLine(question.text)),
      });
    }
  };
  /** `s` or `p` in the live agent detail: `s` opens the Composer in the stream. */
  const steerOrPark = (id: "steer" | "park", runId: string) => {
    const live = state.work.find((candidate) => candidate.work.run === runId);
    if (live === undefined) {
      setMessage(
        id === "steer"
          ? "this run has ended; there is no worker to steer"
          : "this run has ended; park its story from the queue or the desk",
      );
    } else if (id === "steer") {
      steering.open();
    } else {
      act(id, { story: String(live.work.story) });
    }
  };
  /**
   * Enter on a desk row: the story with its park record and review verdicts; a proposed story's
   * card is the desk item itself, its proposed user story in full (DIPO-454).
   */
  const openCard = (item: DeskItem) => {
    if (item.idea !== undefined) {
      setMessage(null);
      setDeskSelection({ id: deskRowId(item), key: item.key ?? null, index: deskIndex });
      setCard({ item, outcome: null, top: 0, section: "Story", open: [], diff: null });
      return;
    }
    if (item.key === undefined || state.office === null) {
      setMessage("this row names no story; what it needs is on the row");
      return;
    }
    const office = state.office;
    setMessage(null);
    setDeskSelection({ id: deskRowId(item), key: item.key, index: deskIndex });
    setCard({ item, outcome: null, top: 0, section: "Story", open: [], diff: null });
    void actions.readStory({ office, story: item.key }).then((outcome) => {
      if (store.state.office !== office) return;
      const read: CardOutcome = outcome.ok
        ? {
            ok: true,
            view: outcome.result.view,
            verdicts: outcome.result.verdicts ?? [],
            runs: outcome.result.runs,
          }
        : outcome;
      setCard((open) => (open?.item === item ? { ...open, outcome: read } : open));
    });
  };

  // Read-your-writes: a run is done once the office stream passes its reply cursor, once the store
  // read a snapshot again after the reply (a history gap), or once the
  // maintainer switched to another office, whose stream will never carry it.
  useEffect(() => {
    if (run?.status !== "syncing") return;
    const passed =
      run.cursor === undefined ||
      state.office !== run.request.office ||
      cursorReached(state.cursor, run.cursor) ||
      (run.snapshots !== undefined && state.snapshots > run.snapshots);
    if (passed) setRun({ ...run, status: "done" });
  }, [run, state.cursor, state.office, state.snapshots]);

  const openDetail = (runId: string, back: View) => {
    const found = state.work.find((candidate) => candidate.work.run === runId);
    if (found === undefined) return;
    setMessage(null);
    setDetail({ target: { run: found.work.run, key: found.work.key }, back });
  };

  // A story that is not running: its latest run read-only, or "not run yet" (DIPO-81).
  const openStory = (key: StoryKey, label: string, back: View) => {
    const running = state.work.find((candidate) => candidate.work.key === key);
    if (running !== undefined) {
      openDetail(running.work.run, back);
      return;
    }
    if (state.office === null) return;
    const office = state.office;
    setMessage(`opening ${label}${ellipsis}`);
    void actions.readStory({ office, story: key }).then((outcome) => {
      if (store.state.office !== office) return;
      if (!outcome.ok) {
        setMessage(`${label}: ${outcome.error.code}: ${outcome.error.message}`);
        return;
      }
      const last = outcome.result.runs.at(-1);
      if (last === undefined) {
        const { view: story } = outcome.result;
        setMessage(
          `${story.story} ${story.title} ${glyphs(display.ascii).dot} ${story.lifecycle}, not run yet`,
        );
        return;
      }
      setMessage(null);
      setDetail({ target: { run: last.run, key, record: last }, back });
    });
  };

  const send = (request: RunRequest, label: string) => {
    setMessage(null);
    setRun({ request, label, status: "sending" });
    void actions.runStories(request).then((outcome) => {
      if (!outcome.ok) {
        setRun({ request, label, status: "failed", error: outcome.error });
        return;
      }
      setRun({
        request,
        label,
        status: "syncing",
        result: outcome.result,
        ...(outcome.cursor === undefined ? {} : { cursor: outcome.cursor }),
        // Live, not the batched state: a re-read before this moment does not count.
        snapshots: store.state.snapshots,
      });
    });
  };

  const runSelected = () => {
    if (state.office === null) return;
    if (run?.status === "sending" || run?.status === "syncing") {
      setRefusal(
        run.status === "sending"
          ? `run ${run.label} is being sent; wait for its reply`
          : `run ${run.label} waits for the office stream; wait until it is done`,
      );
      return;
    }
    const row = queue[queueSelected];
    if (row === undefined) {
      setMessage("select a story to run");
      return;
    }
    const requestId = actions.newRequestId();
    send({ office: state.office, stories: [row.view.key], requestId }, String(row.view.story));
  };

  useEffect(() => {
    if (run?.status !== "sending" && run?.status !== "syncing") setRefusal(null);
  }, [run?.status]);

  // Key handling: the live agent detail and a desk card take their keys first, then the keys
  // every view shares, then one handler per view.

  /**
   * The live agent detail: Esc goes back; the pane takes its own keys. True when the key ends
   * here; a view key or Ctrl-R closes nothing or the detail and goes on to the views.
   */
  const onDetailKey = (open: DetailState, input: string, key: Key): boolean => {
    if (key.escape && expanded) {
      setExpanded(false);
      return true;
    }
    if (key.escape) {
      setDetail(null);
      setView(open.back);
      setMessage(null);
      return true;
    }
    if (input === "z") {
      setExpanded(!expanded);
      return true;
    }
    if (input === "c") {
      copyId(open.target.run);
      return true;
    }
    // The key table's actions on the run (DIPO-308): answer its question, steer, park.
    if (input === "a") {
      answerRun(open.target.run);
      return true;
    }
    if (input === "s" || input === "p") {
      steerOrPark(input === "s" ? "steer" : "park", open.target.run);
      return true;
    }
    const leaves = leavesOverlay(input);
    if (!leaves && !(key.ctrl && input === "r")) return true;
    if (leaves) {
      setDetail(null);
      setExpanded(false);
    }
    return false;
  };

  /** Ctrl-R sends a failed retryable action or `work.run` again with its request id. */
  const onRetryKey = () => {
    if (acts.retry()) return;
    if (run?.status !== "failed" || run.error?.retryable !== true || args.refusedOffline()) return;
    // The same request id: the engine runs the command at most once (0005).
    send(run.request, run.label);
  };

  /** Shows `section` of the card; the Diff section reads `story.diff` the first time. */
  const showSection = (open: CardState, section: Section) => {
    setCard({ ...open, section, top: 0 });
    if (section !== "Diff" || open.diff !== null || open.item.key === undefined) return;
    const office = state.office;
    if (office === null) return;
    const { item } = open;
    void actions.readDiff({ office, story: item.key as StoryKey }).then((diff) => {
      if (store.state.office !== office) return;
      setCard((current) => (current?.item === item ? { ...current, diff } : current));
    });
  };

  /** The story a desk row opened: Esc returns to the desk, `j`/`k` scroll, view keys leave it. */
  const onCardKey = (open: CardState, input: string, key: Key): boolean => {
    if (key.escape) {
      setCard(null);
      setMessage(null);
      return true;
    }
    const at = SECTIONS.indexOf(open.section);
    if (key.leftArrow || key.rightArrow || input === "h" || input === "l") {
      const step = key.leftArrow || input === "h" ? -1 : 1;
      const section = SECTIONS[(at + step + SECTIONS.length) % SECTIONS.length] ?? "Story";
      showSection(open, section);
      return true;
    }
    if (key.return && open.section === "Reviews" && open.outcome?.ok === true) {
      setCard({ ...open, open: nextOpen(open.outcome.verdicts, open.open), top: 0 });
      return true;
    }
    if (input === "o" && open.section === "Reviews" && open.outcome?.ok === true) {
      const url = open.outcome.verdicts
        .flatMap((verdict) => (verdict.review === undefined ? [] : [verdict.review]))
        .toSorted((a, b) => b.round - a.round)[0]?.commentUrl;
      if (url === undefined) setMessage("the latest round has no comment on GitHub");
      else void args.openUrl(url).then((failure) => setMessage(failure ?? `opened ${url}`));
      return true;
    }
    if (key.downArrow || input === "j") {
      setCard({ ...open, top: open.top + 1 });
      return true;
    }
    if (key.upArrow || input === "k") {
      setCard({ ...open, top: Math.max(0, open.top - 1) });
      return true;
    }
    if (input === "c") {
      if (open.item.story !== undefined) copyId(String(open.item.story));
      return true;
    }
    if (!leavesOverlay(input)) return true;
    setCard(null);
    return false;
  };

  /** The keys every view shares: switch rooms, open Offices, Esc. */
  const onSharedViewKey = (input: string, key: Key): boolean => {
    if (input === "1") {
      setMessage(null);
      setCard(null);
      setView("desk");
    } else if (input === "2") {
      setView("overview");
    } else if (input === "3") {
      setView("queue");
    } else if (input === "O") {
      setMessage(null);
      args.openSwitcher();
    } else if (key.escape) {
      setRun(null);
      setMessage(null);
      acts.dismiss();
      setDeskPreview(false);
      if (view === "settings") setView("overview");
      // Esc leaves the test open: nothing is sent (DIPO-365).
      if (view === "checklist") setView(checklistBack);
    } else {
      return false;
    }
    return true;
  };

  const onOverviewKey = (input: string, key: Key) => {
    const count = board.length;
    const select = (index: number) => {
      const entry = board[Math.max(0, Math.min(count - 1, index))];
      setOverviewKey(entry === undefined ? null : String(entry.key));
    };
    if (key.downArrow || input === "j") {
      select(overviewIndex + 1);
    } else if (key.upArrow || input === "k") {
      select(overviewIndex - 1);
    } else if (key.return && backlogSelected) {
      setBacklogOpen(!backlogOpen);
    } else if (key.return && overviewEntry !== null) {
      setOverviewKey(String(overviewEntry.key));
      if (overviewEntry.run !== null) openDetail(overviewEntry.run, "overview");
      else openStory(overviewEntry.key, String(overviewEntry.story), "overview");
    } else if (input === "a" && overviewEntry !== null) {
      if (overviewEntry.run === null) setMessage("no question waits on this row");
      else answerRun(overviewEntry.run);
    } else if (input === "c" && overviewEntry !== null) {
      copyId(String(overviewEntry.story));
    }
  };

  /** `office.setPrivacy` for a confirmed setting. */
  const sendPrivacy = (key: string, value: boolean) => {
    if (state.office === null) return;
    const name = settingName(key);
    setMessage(`${name}: sending${ellipsis}`);
    void actions
      .setPrivacy({ office: state.office, key: name, value, requestId: actions.newRequestId() })
      .then((outcome) => {
        if (!outcome.ok) {
          setMessage(`${name}: ${outcome.message}`);
          return;
        }
        setPrivacyWritten(true);
        setMessage(`${name} is ${value ? "on" : "off"}; applies ${appliesWords(key)}`);
      });
  };

  const onSettingsKey = (input: string, key: Key) => {
    const settings = privacySettings(state);
    const index = Math.min(settingsIndex, Math.max(0, settings.length - 1));
    if (key.downArrow || input === "j") {
      setSettingsIndex(Math.min(Math.max(0, settings.length - 1), index + 1));
    } else if (key.upArrow || input === "k") {
      setSettingsIndex(Math.max(0, index - 1));
    } else if ((key.return || input === " ") && settings[index] !== undefined) {
      if (args.refusedOffline()) return;
      const setting = settings[index];
      setMessage(null);
      // `office.setPrivacy` asks first when its definition says `confirm`, as the CLI does.
      if (officeSetPrivacy.confirm) {
        args.confirmPrivacy(setting.key, !setting.value);
      } else {
        sendPrivacy(setting.key, !setting.value);
      }
    }
  };

  const onChecklistKey = (input: string, key: Key) => {
    const steps = checklistTest?.steps.length ?? 0;
    if (key.downArrow || input === "j") {
      setChecklistStep(Math.min(Math.max(0, steps - 1), checklistStep + 1));
    } else if (key.upArrow || input === "k") {
      setChecklistStep(Math.max(0, checklistStep - 1));
    } else if (input === " " && checklistTest !== null) {
      const id = checklistTest.test;
      const ticked = ticks[id] ?? [];
      const next = ticked.includes(checklistStep)
        ? ticked.filter((index) => index !== checklistStep)
        : [...ticked, checklistStep];
      setTicks({ ...ticks, [id]: next });
    } else if (input === "y") {
      recordTest("pass");
    } else if (input === "n") {
      recordTest("fail");
    } else if (input === "c" && checklistTest?.shell !== undefined) {
      copyId(checklistTest.shell);
    } else if (input === "o" && checklistTest?.url !== undefined) {
      const url = checklistTest.url;
      void args.openUrl(url).then((failure) => setMessage(failure ?? `opened ${url}`));
    }
  };

  const markSelected = () => {
    const row = queue[queueSelected];
    if (row === undefined || !isRefined(row)) {
      setMessage("only a Refined story can be marked to set Ready");
      return;
    }
    const next = new Set(marks);
    const id = String(row.view.key);
    if (!next.delete(id)) next.add(id);
    setMarks(next);
  };

  // A set-Ready that was sent has used the marks.
  const readyRequest =
    acts.action?.request.command === "story.ready" ? acts.action.request.requestId : null;
  useEffect(() => {
    if (readyRequest !== null) setMarks(new Set());
  }, [readyRequest]);

  const onQueueKey = (input: string, key: Key) => {
    if (key.downArrow || input === "j") {
      selectQueue(queueSelected + 1);
    } else if (key.upArrow || input === "k") {
      selectQueue(queueSelected - 1);
    } else if (key.return) {
      const row = queue[queueSelected];
      if (row === undefined) return;
      openStory(row.view.key, String(row.view.story), "queue");
    } else if (input === ".") {
      setShowDone(!showDone);
    } else if (input === " ") {
      markSelected();
    } else if (input === "Y") {
      if (args.refusedOffline()) return;
      if (readyTargets.length === 0) {
        setMessage("select a Refined story first; space marks several");
        return;
      }
      act("ready", { stories: readyTargets.map((row) => String(row.view.story)) });
    } else if (input === "r") {
      if (args.refusedOffline()) return;
      runSelected();
    } else if (input === "p" || input === "X") {
      const row = queue[queueSelected];
      if (row === undefined) {
        setMessage("select a story to park or drop");
        return;
      }
      act(input === "p" ? "park" : "drop", { story: String(row.view.story) });
    } else if (input === "c") {
      const row = queue[queueSelected];
      if (row !== undefined) copyId(String(row.view.story));
    }
  };

  /** Starts a desk action on `item` with the command line the engine built for it. */
  const actOnDesk = (item: DeskItem, id: ActionId, cli: string) => {
    setDeskSelection({ id: deskRowId(item), key: item.key ?? null, index: deskIndex });
    act(id, deskTarget(item, cli, id));
  };

  const onDeskKey = (input: string, key: Key) => {
    const resume = deskItem?.actions.find((action) => action.command === "work.resume");
    const answer = deskItem?.actions.find((action) => action.command === "work.answer");
    if (key.pageDown) {
      setDeskScroll((at) => at + DESK_SCROLL_STEP);
    } else if (key.pageUp) {
      setDeskScroll((at) => Math.max(0, at - DESK_SCROLL_STEP));
    } else if (key.downArrow || input === "j") {
      setDeskPreview(false);
      setDeskScroll(0);
      selectDesk(deskIndex + 1);
    } else if (key.upArrow || input === "k") {
      setDeskPreview(false);
      setDeskScroll(0);
      selectDesk(deskIndex - 1);
    } else if (key.return && deskItem !== null) {
      // Below 100 columns the first Enter opens the preview, the next one the story.
      if (deskNarrow && !deskPreview) setDeskPreview(true);
      else openCard(deskItem);
    } else if (input === "o" && deskItem?.pr !== undefined) {
      const url = deskItem.pr.url;
      void args.openUrl(url).then((failure) => setMessage(failure ?? `opened ${url}`));
    } else if (input === "r" && deskItem?.kind === "PARKED" && answer !== undefined) {
      // An ambiguous-spec park starts again with its answer: `r` is `a` (spec.md, PARKED).
      actOnDesk(deskItem, "answer", answer.cli);
    } else if (
      input === "s" &&
      deskItem !== null &&
      resume !== undefined &&
      deskItem.kind === "PARKED"
    ) {
      // A failed run starts again with a hint: the resume's note, empty (screens/15).
      act("resume", { ...deskTarget(deskItem, resume.cli, "resume"), prefill: "" });
    } else if (input === "i") {
      // The maintainer's quick idea goes to the audit (0022, DIPO-454), whatever row is selected.
      act("idea", {});
    } else if (input === "c" && deskItem !== null) {
      if (deskItem.story !== undefined) copyId(String(deskItem.story));
      else setMessage("this row names no story to copy");
    } else if (
      input === "t" &&
      deskItem !== null &&
      !rowKeys(deskItem).bound.some((entry) => entry.binding.key === "t") &&
      openTestOf(deskItem) !== null
    ) {
      // A test that is open already and not offered again: `t` shows its checklist and sends
      // nothing (DIPO-458; the checklist left room 4).
      const test = openTestOf(deskItem);
      if (test !== null) {
        openChecklist({ key: String(test.key), id: String(test.story) }, "desk");
      }
    } else if (deskItem !== null) {
      const bound = rowKeys(deskItem).bound.find((entry) => entry.binding.key === input);
      if (bound === undefined) return;
      if (bound.binding.id === "test" && deskItem.key !== undefined) {
        const storyKey = String(deskItem.key);
        const id =
          deskItem.story ?? state.stories.find((story) => String(story.key) === storyKey)?.story;
        setDeskSelection({ id: deskRowId(deskItem), key: deskItem.key ?? null, index: deskIndex });
        openChecklist({ key: storyKey, id: id === undefined ? "this story" : String(id) }, "desk");
      }
      actOnDesk(deskItem, bound.binding.id, bound.action.cli);
    }
  };

  /** The keys of each view after the shared ones. */
  const onViewKey: Readonly<Record<View, (input: string, key: Key) => void>> = {
    overview: onOverviewKey,
    settings: onSettingsKey,
    checklist: onChecklistKey,
    queue: onQueueKey,
    desk: onDeskKey,
  };

  /** `c`: the id goes to the clipboard, and the ticker says so. */
  const copyId = (id: string) => {
    args.copy(id);
    setMessage(`copied ${id}`);
  };

  /** The open test of a desk row's story, or null. */
  const openTestOf = (item: DeskItem) =>
    item.key === undefined
      ? null
      : (state.tests.find((test) => String(test.key) === String(item.key)) ?? null);

  /** An open detail or card first, then Ctrl-R, the shared view keys and the view's own. */
  const onKey = (input: string, key: Key) => {
    if (sinceShown && digest !== null) {
      // Any key dismisses the Since band, and does nothing else (keymap.json, dismissSince).
      setSinceDismissed(digest.since);
      return;
    }
    if (detail !== null && onDetailKey(detail, input, key)) return;
    if (key.ctrl && input === "r") {
      onRetryKey();
      return;
    }
    if (view === "desk" && card !== null && onCardKey(card, input, key)) return;
    if (onSharedViewKey(input, key)) return;
    onViewKey[view](input, key);
  };

  /** The item the palette and the keys overlay are about: the detail's run, else the view's row. */
  const paletteFocus = (): PaletteFocus => {
    const runningKeys = new Set(state.work.map((candidate) => candidate.work.key));
    if (detail !== null) {
      const live = state.work.find((candidate) => candidate.work.run === detail.target.run);
      const commands = new Set<string>();
      if (asks(detail.target.run)) commands.add("work.answer");
      if (live !== undefined) commands.add("story.park").add("work.steer");
      return {
        ...NO_FOCUS,
        view: "detail",
        commands,
        running: live !== undefined,
        story: live === undefined ? null : String(live.work.story),
        label: live === undefined ? null : String(live.work.story),
      };
    }
    if (view === "overview" && overviewEntry !== null) {
      return {
        ...NO_FOCUS,
        view: "overview",
        label: String(overviewEntry.story),
        story: String(overviewEntry.story),
        commands: new Set(asks(overviewEntry.run) ? ["work.answer"] : []),
        running: overviewEntry.run !== null,
      };
    }
    const row = queue[queueSelected];
    if (view === "queue" && row !== undefined) {
      return {
        ...NO_FOCUS,
        view: "queue",
        label: String(row.view.story),
        story: String(row.view.story),
        commands: new Set(["story.park", "story.drop"]),
        running: runningKeys.has(row.view.key),
      };
    }
    if (view === "desk" && deskItem !== null && card === null) {
      const bound = rowKeys(deskItem);
      return {
        ...NO_FOCUS,
        view: "desk",
        kind: deskItem.kind,
        label: deskItem.story === undefined ? deskItem.kind : String(deskItem.story),
        story: deskItem.story === undefined ? null : String(deskItem.story),
        commands: new Set(deskItem.actions.map((action) => action.command)),
        running: deskItem.key !== undefined && runningKeys.has(deskItem.key),
        typed: bound.unbound.map((action) => action.cli),
      };
    }
    if (view === "desk") return { ...NO_FOCUS, view: "desk", commands: new Set() };
    if (view === "checklist" && checklistTest !== null) {
      return { ...NO_FOCUS, view: "checklist", commands: new Set(["test.record"]) };
    }
    return NO_FOCUS;
  };

  /** Stopping a run (palette only): the park flow, which asks first, for the focused story. */
  const stopRun = (story: string) => {
    act("stop", { story });
  };

  // A refusal names a run on its way; the effect that clears it runs only after the frame that
  // shows the run done, so the footer drops it in that same frame.
  const activeRefusal = run?.status === "sending" || run?.status === "syncing" ? refusal : null;
  const failure =
    run?.status === "failed" && run.error !== undefined
      ? `run ${run.label}: ${run.error.code}: ${run.error.message}`
      : null;
  const detailLive =
    detail !== null && state.work.some((candidate) => candidate.work.run === detail.target.run);
  const asks = (runId: string | null) =>
    runId !== null && state.questions.some((question) => question.work.run === runId);
  // The key table's hints for what is selected (DIPO-308).
  const rowHintList: Hint[] = [];
  if (detail !== null) {
    const commands = new Set<string>();
    if (asks(detail.target.run)) commands.add("work.answer");
    if (detailLive) commands.add("story.park").add("work.steer");
    if (asks(detail.target.run)) rowHintList.push(hintOf(binding("answer")));
    for (const entry of viewKeys("detail", { commands })) rowHintList.push(hintOf(entry));
  } else if (view === "overview") {
    if (overviewEntry !== null && asks(overviewEntry.run)) {
      rowHintList.push(hintOf(binding("answer")));
    }
  } else if (view === "queue") {
    if (queue[queueSelected] !== undefined) {
      const commands = new Set(["story.park", "story.drop"]);
      if (readyTargets.length > 0) commands.add("story.ready");
      for (const entry of viewKeys("queue", { commands })) rowHintList.push(hintOf(entry));
    }
  } else if (view === "desk" && card === null) {
    if (deskItem !== null) {
      for (const entry of rowKeys(deskItem).bound) rowHintList.push(hintOf(entry.binding));
      if (deskItem.pr !== undefined) rowHintList.push({ key: "o", label: "PR", priority: 20 });
    }
    for (const entry of viewKeys("desk")) rowHintList.push(hintOf(entry));
  }

  const footerView: View | "detail" | "ended" | "card" =
    detail !== null
      ? detailLive
        ? "detail"
        : "ended"
      : view === "desk" && card !== null
        ? "card"
        : view;

  return {
    store,
    clock,
    display,
    actions,
    state,
    view,
    run,
    detail,
    card,
    desk,
    deskIndex,
    deskItem,
    queue,
    queueSelected,
    chain,
    gate,
    showDone,
    marks,
    readyResult: acts.action?.ready === undefined ? [] : readyLines(acts.action.ready),
    doneTotal: doneCount(state.stories),
    overviewEntry,
    /** The selected board row, a story's key or the BACKLOG row's. */
    overviewSelected: overviewPick === null ? null : String(overviewPick.key),
    backlogOpen,
    settingsIndex,
    privacyWritten,
    checklistKey,
    checklistStory,
    checklistTest,
    checklistStep,
    ticks,
    latest,
    digest,
    onKey,
    paletteFocus,
    stopRun,
    /** The privacy settings, opened from the palette. */
    openSettings() {
      setMessage(null);
      setDetail(null);
      setView("settings");
    },
    steering,
    /** A key while the steer Composer is open on the detail's live run; true when it took it. */
    onSteerKey(input: string, key: Key): boolean {
      if (detail === null || steering.draft === null) return false;
      const live = state.work.find((candidate) => candidate.work.run === detail.target.run);
      steering.onKey(input, key, String(detail.target.run), String(live?.work.story ?? ""));
      return true;
    },
    /** A navigation key of the palette or the keys: the same handler as pressing it. */
    pressKey(input: string) {
      onKey(input, NO_KEY);
    },
    sendPrivacy,
    rowHintList,
    expanded,
    /** The run's one ticker line until the next key after it is done (DIPO-458). */
    runSummary: run === null ? null : runSummary(run, state, ellipsis, glyphs(display.ascii).dot),
    refusal: activeRefusal,
    failure,
    /** The view the footer names. */
    footerView,
    /** The maintainer switched office: what was selected there is gone. */
    reset() {
      setQueueKey(null);
      setOverviewKey(null);
      setDetail(null);
    },
    /** A key arrived: a refusal is gone, and so is a run that is done (it was shown once). */
    clearRefusal() {
      setRefusal(null);
      if (run?.status === "done") setRun(null);
    },
    sinceShown,
    deskPreview,
    deskScroll,
    /** The action on its way or just answered, for the desk row it was started on. */
    deskAction: acts.action,
    /** The accepted idea the lane queued, until the snapshot has no open change (DIPO-481). */
    deskQueued:
      acts.action?.queued === true && state.lane !== null
        ? { title: acts.action.title ?? "an accepted idea", waits: waitsOn(state.lane) }
        : null,
    /** True when the open prompt is drawn in the focused desk item's preview, not under the body. */
    promptInDesk:
      acts.flow !== null &&
      detail === null &&
      view === "desk" &&
      card === null &&
      deskItem !== null &&
      acts.flow.target.row === deskRowId(deskItem) &&
      (!deskNarrow || deskPreview),
    /** The focused desk item's preview at `width` (`desk-preview.ts`), its open prompt in it. */
    deskPreviewLines(width: number): readonly SegLine[] {
      if (deskItem === null) return [];
      const story = deskItem.story === undefined ? null : String(deskItem.story);
      const storyView =
        story === null
          ? undefined
          : state.stories.find((candidate) => String(candidate.story) === story);
      const work = state.work.find(
        (candidate) => String(candidate.work.key) === String(deskItem.key ?? ""),
      );
      const flow = acts.flow;
      const prompt =
        flow !== null && flow.target.row === deskRowId(deskItem)
          ? promptRows(flow, { width, ascii: display.ascii, context: false })
          : null;
      return previewLines(deskItem, {
        width,
        now: clock.now(),
        ascii: display.ascii,
        title: storyView?.title ?? null,
        phase: work?.phase ?? null,
        waitingOn: (storyView?.waitingOn ?? []).map(String),
        prompt,
      });
    },
  };
}

export type Home = ReturnType<typeof useHome>;

export interface HomeModeProps {
  readonly home: Home;
  readonly columns: number;
  readonly height: number;
  /** True while the detail pane takes its keys. */
  readonly keysActive: boolean;
  readonly outputTailBytes?: number;
}

/** The view that shows in home: the detail, the privacy settings, the desk card or one of the views. */
export function HomeMode(props: HomeModeProps) {
  const { home, columns, height } = props;
  const { state, display, clock, view, detail, card } = home;
  if (detail !== null) {
    return (
      <Detail
        // A new run starts with a fresh pane.
        key={detail.target.run}
        state={state}
        store={home.store}
        clock={clock}
        display={display}
        target={detail.target}
        readOutput={home.actions.readOutput}
        readPrompt={home.actions.readPrompt}
        columns={columns}
        height={height}
        keysActive={props.keysActive && home.steering.draft === null}
        tailBytes={props.outputTailBytes ?? OUTPUT_TAIL_BYTES}
        steer={home.steering.draft}
        sent={home.steering.sent(String(detail.target.run))}
      />
    );
  }
  if (view === "settings") {
    return (
      <Settings
        state={state}
        display={display}
        selected={home.settingsIndex}
        written={home.privacyWritten}
      />
    );
  }
  if (view === "desk" && card !== null) {
    return (
      <StoryCard
        item={card.item}
        outcome={card.outcome}
        now={clock.now()}
        display={display}
        columns={columns}
        height={height}
        top={card.top}
        section={card.section}
        open={card.open}
        diff={card.diff}
      />
    );
  }
  const deskElement = (
    <Desk
      desk={home.desk}
      selected={home.deskIndex}
      columns={columns}
      height={height}
      now={clock.now()}
      display={display}
      title={(story) =>
        state.stories.find((candidate) => String(candidate.story) === story)?.title ?? null
      }
      preview={home.deskPreviewLines}
      previewOpen={home.deskPreview}
      previewScroll={home.deskScroll}
      since={home.sinceShown ? home.digest : null}
      action={home.deskAction}
      queued={home.deskQueued}
      team={{
        running: state.work.length,
        inReview: state.stories.filter((story) => story.column === "review").length,
      }}
    />
  );
  if (view === "desk") return deskElement;
  if (view === "queue") {
    return (
      <Queue
        rows={home.queue}
        selected={home.queueSelected}
        display={display}
        columns={columns}
        height={height}
        chain={home.chain}
        gate={home.gate}
        showDone={home.showDone}
        doneTotal={home.doneTotal}
        marks={home.marks}
        result={home.readyResult}
      />
    );
  }
  if (view === "checklist") {
    const { checklistTest, checklistKey, checklistStory } = home;
    const ended = state.testEnd;
    return (
      <Box flexDirection="column" height={height} overflow="hidden">
        <Shaded display={display}>{deskElement}</Shaded>
        <Box position="absolute" flexDirection="column" width="100%">
          <Checklist
            test={checklistTest}
            empty={
              checklistKey === null
                ? "No test is open. t on a desk row starts one."
                : `No test is open for ${checklistStory ?? "this story"}.`
            }
            ended={
              checklistTest === null && ended !== null && String(ended.story) === checklistStory
                ? endedWords(ended.reason)
                : null
            }
            ticked={checklistTest === null ? [] : (home.ticks[checklistTest.test] ?? [])}
            step={home.checklistStep}
            display={display}
            columns={columns}
          />
        </Box>
      </Box>
    );
  }
  return (
    <Overview
      state={state}
      display={display}
      columns={columns}
      height={height}
      clock={clock}
      latest={home.latest}
      chain={home.chain}
      selected={home.overviewSelected}
      backlogOpen={home.backlogOpen}
    />
  );
}
