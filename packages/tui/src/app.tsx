// The TUI root (0009 sections 4 to 7 and 9): the header with office, daemon state and connection,
// the banners, the office overview (`1`), the queue (`2`) or the office switcher, and the footer
// with the keys that work now. Global keys: `1` overview, `2` queue, `o` offices, `q` twice within
// 2 s quits, Ctrl+C quits. In the queue: `j`/`k` or arrows move, `u` runs the selected story (or
// lets the engine pick the next Ready one) with `work.run`, `.` shows Done stories. In the
// overview `j`/`k` or arrows move over every board row; Enter on a running story, there or in the
// queue, opens the live agent detail (`detail.tsx`), and on a story that ran before its latest run
// read-only through `story.detail` (a story that never ran says so in the footer). There `P` asks
// for a note and sends `story.park`, and Esc returns to the view it came from. In the switcher: `j`/`k` or arrows move, Enter opens the office through
// `office.switch`, `n` opens a new repository path through `office.open`, Esc goes back. Action
// keys are off while offline. In the overview `p` opens the privacy settings (`settings.tsx`):
// Enter toggles the selected one after a yes that names what is stored, through `office.setPrivacy`.
//
// `3` opens Your desk (`desk.tsx`, DIPO-308): `j`/`k` move, the keys of the selected row act on it
// (`keys.ts`, `actions.ts`), and Enter opens the story with its park record and review verdicts
// (`story-card.tsx`), where Esc returns to the same row. The same key table gives `a` answer, `s`
// steer and `p` pause in the live agent detail, `a` answer on an overview row whose run asks, and
// `h` hold and `d` drop in the queue. Under the overview's count line one line says what happened
// since the maintainer last left the office (`office.digest`).
//
// `4` opens the test checklist (`checklist.tsx`, DIPO-365): the open test's manual steps with local
// ticks (Space), `P` passes it and `F` fails it with a note that starts as the first unticked step,
// and Esc leaves it open. `t` on a desk row opens the same checklist for that story.
//
// An action is done only when the office stream passes its reply cursor (read-your-writes). An
// error shows in the footer; a retryable one offers Ctrl-R, which sends the same request again
// with the same request id. The store's state is taken at most 10 times per second.

import {
  cursorReached,
  type OfficeStore,
  type OfficeStoreState,
} from "@dipsaus-orchestrator/client";
import type {
  Clock,
  Cursor,
  DeskItem,
  EngineError,
  OfficeId,
  RequestId,
  RunRecord,
  StoryKey,
  StoryRefValue,
  StoryView,
  Verdict,
} from "@dipsaus-orchestrator/contract";
import { Box, type Key, Text, useInput, useWindowSize } from "ink";
import { useEffect, useState } from "react";

import {
  type ActionTarget,
  type CommandOutcome,
  type CommandRequest,
  type LossesOutcome,
  type LossesRequest,
  useActions,
} from "./actions";
import { useBatchedState } from "./batch";
import {
  Desk,
  DESK_WIDE_COLUMNS,
  deskRowId,
  deskRows,
  type ReadDesk,
  rowHints,
  selectedRow,
  useDesk,
} from "./desk";
import { Checklist, firstUnticked } from "./checklist";
import { Detail, type DetailTarget, type ReadOutput, type ReadPrompt } from "./detail";
import { skipReason, widthOf } from "./format";
import { useLatestLines } from "./latest";
import type { Display } from "./options";
import { OUTPUT_TAIL_BYTES } from "./output";
import { boardEntries, EVIDENCE_LEGEND, EVIDENCE_MARKERS, Overview } from "./overview";
import { digestLine, type ReadDigest, useDigest } from "./digest";
import { type ActionId, rowKeys, viewKeys } from "./keys";
import { Queue, queueRows } from "./queue";
import { appliesWords, confirmPrompt, privacySettings, Settings, settingName } from "./settings";
import { type CardOutcome, StoryCard } from "./story-card";
import {
  Banners,
  bannerLines,
  Footer,
  glyphs,
  Header,
  isOffline,
  NARROW_COLUMNS,
  NARROW_ROWS,
  NarrowBody,
  SwitcherBody,
} from "./views";

/** A key event with no modifier, for keys taken one by one from a multi-key write. */
const NO_KEY = {} as Key;

/** A second `q` within this window quits (0009 section 6). */
export const QUIT_WINDOW_MS = 2_000;

export type ActionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

/** What `work.run` answered, as far as the TUI shows it. */
export interface RunResult {
  readonly started: readonly { readonly story: string; readonly run: string }[];
  readonly skipped: readonly { readonly story: string; readonly reason: string }[];
}

/** A command reply; a failure on the client side comes back as an error too. */
export type RunOutcome =
  | { readonly ok: true; readonly result: RunResult; readonly cursor?: Cursor }
  | { readonly ok: false; readonly error: EngineError };

export interface RunRequest {
  readonly office: OfficeId;
  /** Omitted: the engine picks the next Ready story. */
  readonly stories?: readonly StoryRefValue[];
  readonly requestId: RequestId;
}

/** One `office.setPrivacy`: `key` is the setting name, such as `storePrompts`. */
export interface PrivacyRequest {
  readonly office: OfficeId;
  readonly key: string;
  readonly value: boolean;
  readonly requestId: RequestId;
}

/** A story's view and runs, as `story.detail` answers (DIPO-81). */
export type StoryOutcome =
  | {
      readonly ok: true;
      readonly result: {
        readonly view: StoryView;
        readonly runs: readonly RunRecord[];
        /** The story's decided gates with their review rounds (0019 section 14). */
        readonly verdicts?: readonly Verdict[];
      };
    }
  | { readonly ok: false; readonly error: EngineError };

/** The commands the TUI sends; `run` builds them on the client session. */
export interface TuiActions {
  /** `work.outputRange` for the live agent detail (0005 section 7). */
  readOutput: ReadOutput;
  /** `work.prompt` for the prompt pane of the live agent detail (DIPO-137). */
  readPrompt: ReadPrompt;
  /** `story.detail`: the runs of a story that is not running, to open its latest (DIPO-81). */
  readStory(request: {
    readonly office: OfficeId;
    readonly story: StoryKey;
  }): Promise<StoryOutcome>;
  /** `office.open` for a path the maintainer typed. */
  openPath(path: string): Promise<ActionResult<OfficeId>>;
  /** `office.setPrivacy` for the setting the maintainer confirmed (DIPO-136). */
  setPrivacy(request: PrivacyRequest): Promise<ActionResult<null>>;
  /** `work.run` with `origin: "tui"` and the given request id (0009 section 5). */
  runStories(request: RunRequest): Promise<RunOutcome>;
  /** One command of the desk, the detail or the queue (`actions.ts`, DIPO-308). */
  sendCommand(request: CommandRequest): Promise<CommandOutcome>;
  /** `story.losses` before a discard, or a drop that deletes the branch. */
  readLosses(request: LossesRequest): Promise<LossesOutcome>;
  /** `office.desk` (DIPO-158). */
  readDesk: ReadDesk;
  /** `office.digest` without `since`: since the office's last TUI client left (DIPO-308). */
  readDigest: ReadDigest;
  /** A fresh request id for a new action; a retry reuses the old one. */
  newRequestId(): RequestId;
}

type Mode =
  | { readonly kind: "home" }
  | { readonly kind: "switcher"; readonly index: number }
  | { readonly kind: "path"; readonly index: number; readonly text: string }
  | { readonly kind: "confirm-privacy"; readonly key: string; readonly value: boolean };

type View = "overview" | "queue" | "settings" | "desk" | "checklist";

/** The story a desk row opened with Enter, and what `story.detail` answered for it. */
interface CardState {
  readonly item: DeskItem;
  readonly outcome: CardOutcome | null;
  readonly top: number;
}

/** The live agent detail and the view Esc returns to. */
interface DetailState {
  readonly target: DetailTarget;
  readonly back: View;
}

/** One `work.run` the maintainer sent, from send to done. */
interface RunAction {
  readonly request: RunRequest;
  readonly label: string;
  readonly status: "sending" | "syncing" | "done" | "failed";
  readonly result?: RunResult;
  readonly cursor?: Cursor;
  /** The store's snapshot count when the reply arrived; a later re-read has seen the write. */
  readonly snapshots?: number;
  readonly error?: EngineError;
}

export interface AppProps {
  readonly store: OfficeStore;
  readonly clock: Clock;
  readonly display: Display;
  readonly actions: TuiActions;
  /** Called once when the maintainer quits. */
  readonly onQuit: () => void;
  /** Start in the switcher, for example when no office could be chosen. */
  readonly startInSwitcher?: boolean;
  /** Bytes an output pane keeps while it follows the tail; `OUTPUT_TAIL_BYTES` by default. */
  readonly outputTailBytes?: number;
}

/** One line of text: line breaks and control characters become single spaces. */
function oneLine(text: string): string {
  // oxlint-disable-next-line no-control-regex
  return text.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
}

/** What a desk row's action is about, with the command line the engine built for it. */
function deskTarget(item: DeskItem, cli: string, id: ActionId): ActionTarget {
  return {
    ...(item.story === undefined ? {} : { story: String(item.story) }),
    ...(item.question === undefined ? {} : { question: String(item.question) }),
    ...(item.gate === undefined ? {} : { gate: String(item.gate) }),
    ...(item.proposal === undefined ? {} : { proposal: item.proposal.id }),
    cli,
    ...(id === "answer" ? { text: item.detail } : {}),
  };
}

function selectedIndex(state: OfficeStoreState): number {
  const index = state.offices.findIndex((entry) => entry.office === state.office);
  return index === -1 ? 0 : index;
}

/** The lines under the body for a run: what started, what was skipped and why. */
function runLines(action: RunAction, state: OfficeStoreState, ellipsis: string): string[] {
  const lines: string[] = [];
  switch (action.status) {
    case "sending":
      lines.push(`run ${action.label}: sending${ellipsis}`);
      break;
    case "syncing":
      lines.push(`run ${action.label}: answered, waiting for the office stream${ellipsis}`);
      break;
    case "done":
      lines.push(`run ${action.label}: done`);
      break;
    case "failed":
      return lines;
  }
  const result = action.result;
  if (result === undefined) return lines;
  for (const story of result.started) lines.push(`  started ${story.story} (${story.run})`);
  for (const story of result.skipped) {
    const view = state.stories.find((candidate) => String(candidate.story) === story.story);
    const needs =
      story.reason === "dependency" && view?.waitingOn !== undefined && view.waitingOn.length > 0
        ? ` (needs ${view.waitingOn.join(", ")})`
        : "";
    lines.push(`  skipped ${story.story}: ${skipReason(story.reason)}${needs}`);
  }
  if (result.started.length === 0 && result.skipped.length === 0) {
    lines.push("  no Ready story to start");
  }
  return lines;
}

export function App(props: AppProps) {
  const { store, clock, display, actions } = props;
  const state = useBatchedState(store, clock);
  const { columns, rows } = useWindowSize();
  const [mode, setMode] = useState<Mode>(
    props.startInSwitcher === true ? { kind: "switcher", index: 0 } : { kind: "home" },
  );
  const [view, setView] = useState<View>("overview");
  // The selected queue row by story key, so it follows the story when the queue changes; null is
  // the "next Ready story" row.
  const [queueKey, setQueueKey] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [run, setRun] = useState<RunAction | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Why a `u` was refused; cleared by the next key and when the run it names ends.
  const [refusal, setRefusal] = useState<string | null>(null);
  // Keys that arrived in one write (fast typing, a paste), handled one per render so each sees
  // the state the one before it left.
  const [pending, setPending] = useState("");
  const [quitArmedAt, setQuitArmedAt] = useState<number | null>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);
  // The selected overview row by story key, so it follows the story when rows come and go.
  const [overviewKey, setOverviewKey] = useState<string | null>(null);
  // The selected privacy setting, and whether one was written (the comments warning is then gone).
  const [settingsIndex, setSettingsIndex] = useState(0);
  const [privacyWritten, setPrivacyWritten] = useState(false);
  // The checklist (DIPO-365): the story whose open test shows (null: the first open test), the view
  // Esc returns to, the step the cursor is on and the steps ticked, by test id, on this screen.
  const [checklistKey, setChecklistKey] = useState<string | null>(null);
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
  const offline = isOffline(state);
  // Every board row is selectable: running stories first, then needs you, in review and Ready.
  const board = boardEntries(state);
  const overviewIndex = Math.max(
    0,
    board.findIndex((entry) => String(entry.key) === overviewKey),
  );
  const overviewEntry = board[overviewIndex] ?? null;
  const { ellipsis } = glyphs(display.ascii);
  const queue = queueRows(state.stories, showDone);
  const queueSelected = Math.max(
    0,
    queue.findIndex((row) => (row.kind === "next" ? null : row.view.key) === queueKey),
  );
  const selectQueue = (index: number) => {
    const row = queue[Math.max(0, Math.min(queue.length - 1, index))];
    setQueueKey(row === undefined || row.kind === "next" ? null : row.view.key);
  };
  // The desk (DIPO-308): read while it or a story opened from it shows; the selection by row id,
  // else its story key, else its place.
  const [deskSelection, setDeskSelection] = useState<{
    readonly id: string | null;
    readonly key: string | null;
    readonly index: number;
  }>({ id: null, key: null, index: 0 });
  const [card, setCard] = useState<CardState | null>(null);
  const desk = useDesk({
    store,
    clock,
    readDesk: actions.readDesk,
    office: state.office,
    active: view === "desk" && detail === null,
    snapshots: state.snapshots,
  });
  const deskAll = desk.items === null ? [] : deskRows(desk.items).all;
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
  });
  const acts = useActions({
    store,
    sendCommand: actions.sendCommand,
    readLosses: actions.readLosses,
    newRequestId: actions.newRequestId,
    offline,
    office: state.office,
    cursor: state.cursor,
    snapshots: state.snapshots,
    ellipsis,
  });
  /** Starts a key table action, or says why it is off. */
  const act = (id: ActionId, target: ActionTarget) => {
    setMessage(null);
    acts.start(id, target);
  };
  // The open test the checklist shows: the story's, else the first open one (DIPO-365).
  const checklistTest =
    state.tests.find((test) => checklistKey === null || String(test.key) === checklistKey) ?? null;
  /** `4`, or `t` on a desk row: the checklist; Esc returns to `back`. */
  const openChecklist = (key: string | null, back: View) => {
    setMessage(null);
    setChecklistKey(key);
    setChecklistBack(back);
    setChecklistStep(0);
    setView("checklist");
  };
  /** `P` or `F` on the checklist: passes or fails the open test, a fail with its note (DIPO-365). */
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
  /** `s` or `P` in the live agent detail. */
  const steerOrPark = (id: "steer" | "park", runId: string) => {
    const live = state.work.find((candidate) => candidate.work.run === runId);
    if (live === undefined) {
      setMessage(
        id === "steer"
          ? "this run has ended; there is no worker to steer"
          : "this run has ended; park its story from the queue or the desk",
      );
    } else {
      act(id, { story: String(live.work.story) });
    }
  };
  /** Enter on a desk row: the story with its park record and review verdicts. */
  const openCard = (item: DeskItem) => {
    if (item.key === undefined || state.office === null) {
      setMessage("this row names no story; what it needs is on the row");
      return;
    }
    const office = state.office;
    setMessage(null);
    setDeskSelection({ id: deskRowId(item), key: item.key, index: deskIndex });
    setCard({ item, outcome: null, top: 0 });
    void actions.readStory({ office, story: item.key }).then((outcome) => {
      if (store.state.office !== office) return;
      const read: CardOutcome = outcome.ok
        ? { ok: true, view: outcome.result.view, verdicts: outcome.result.verdicts ?? [] }
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

  const quit = () => props.onQuit();

  const switchTo = (office: OfficeId, name: string) => {
    setMessage(`opening ${name}${ellipsis}`);
    void store.switchTo(office).then((outcome) => {
      if (outcome.ok) {
        setMessage(null);
        setMode({ kind: "home" });
        setQueueKey(null);
        setOverviewKey(null);
        setDetail(null);
      } else {
        setMessage(`${outcome.error.code}: ${outcome.error.message}`);
      }
    });
  };

  const openPath = (path: string, index: number) => {
    setMessage(`opening ${path}${ellipsis}`);
    void actions.openPath(path).then((outcome) => {
      if (!outcome.ok) {
        setMessage(outcome.message);
        setMode({ kind: "switcher", index });
        return;
      }
      switchTo(outcome.value, path);
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
    const requestId = actions.newRequestId();
    if (row === undefined || row.kind === "next") {
      send({ office: state.office, requestId }, "next Ready story");
    } else {
      send({ office: state.office, stories: [row.view.key], requestId }, String(row.view.story));
    }
  };

  useEffect(() => {
    if (run?.status !== "sending" && run?.status !== "syncing") setRefusal(null);
  }, [run?.status]);

  const handleKey = (input: string, key: Key) => {
    if (key.ctrl && input === "c") {
      quit();
      return;
    }
    setRefusal(null);
    if (state.notice !== null) store.dismissNotice();
    // An open action prompt takes every key (`actions.ts`).
    if (acts.key(input, key)) return;
    acts.setMessage(null);

    if (mode.kind === "path") {
      if (key.escape) {
        setMode({ kind: "switcher", index: mode.index });
        setMessage(null);
      } else if (key.return) {
        const path = mode.text.trim();
        if (path === "") return;
        if (offline) {
          setMessage("offline: actions are disabled");
          return;
        }
        openPath(path, mode.index);
      } else if (key.backspace || key.delete) {
        setMode({ ...mode, text: mode.text.slice(0, -1) });
      } else if (!key.ctrl && !key.meta && input !== "") {
        setMode({ ...mode, text: mode.text + input });
      }
      return;
    }

    if (mode.kind === "confirm-privacy") {
      setMode({ kind: "home" });
      if (input !== "y" && input !== "Y") {
        setMessage(`${settingName(mode.key)} stays as it was`);
        return;
      }
      if (offline) {
        setMessage("offline: actions are disabled");
        return;
      }
      sendPrivacy(mode.key, mode.value);
      return;
    }

    if (input === "q") {
      const now = clock.now();
      if (quitArmedAt !== null && now - quitArmedAt <= QUIT_WINDOW_MS) {
        quit();
        return;
      }
      setQuitArmedAt(now);
      setMessage("press q again to quit");
      return;
    }
    if (quitArmedAt !== null) {
      setQuitArmedAt(null);
      setMessage(null);
    }

    if (mode.kind === "switcher") {
      const count = state.offices.length;
      if (key.escape) {
        if (state.office !== null) setMode({ kind: "home" });
      } else if (key.downArrow || input === "j") {
        setMode({ kind: "switcher", index: Math.min(Math.max(0, count - 1), mode.index + 1) });
      } else if (key.upArrow || input === "k") {
        setMode({ kind: "switcher", index: Math.max(0, mode.index - 1) });
      } else if (key.return) {
        const entry = state.offices[mode.index];
        if (entry === undefined) return;
        if (offline) {
          setMessage("offline: actions are disabled");
          return;
        }
        switchTo(entry.office, entry.name);
      } else if (input === "n") {
        if (offline) {
          setMessage("offline: actions are disabled");
          return;
        }
        setMessage(null);
        setMode({ kind: "path", index: mode.index, text: "" });
      }
      return;
    }

    // The live agent detail: Esc goes back; the pane takes its own keys.
    if (detail !== null) {
      if (key.escape) {
        setDetail(null);
        setView(detail.back);
        setMessage(null);
        return;
      }
      // The key table's actions on the run (DIPO-308): answer its question, steer, park.
      if (input === "a") {
        answerRun(detail.target.run);
        return;
      }
      if (input === "s" || input === "P") {
        steerOrPark(input === "s" ? "steer" : "park", detail.target.run);
        return;
      }
      const leaves =
        input === "1" || input === "2" || input === "3" || input === "4" || input === "o";
      if (!leaves && !(key.ctrl && input === "r")) return;
      if (leaves) setDetail(null);
    }

    // Home: the overview, the queue, the desk or the settings.
    if (key.ctrl && input === "r") {
      if (acts.retry()) return;
      if (run?.status !== "failed" || run.error?.retryable !== true) return;
      if (offline) {
        setMessage("offline: actions are disabled");
        return;
      }
      // The same request id: the engine runs the command at most once (0005 section 9).
      send(run.request, run.label);
      return;
    }
    // The story a desk row opened: Esc returns to the desk, `j`/`k` scroll, view keys leave it.
    if (view === "desk" && card !== null) {
      if (key.escape) {
        setCard(null);
        setMessage(null);
        return;
      }
      if (key.downArrow || input === "j") {
        setCard({ ...card, top: card.top + 1 });
        return;
      }
      if (key.upArrow || input === "k") {
        setCard({ ...card, top: Math.max(0, card.top - 1) });
        return;
      }
      const leaves =
        input === "1" || input === "2" || input === "3" || input === "4" || input === "o";
      if (!leaves) return;
      if (leaves) setCard(null);
    }
    if (input === "1") {
      setView("overview");
    } else if (input === "2") {
      setView("queue");
    } else if (input === "3") {
      setMessage(null);
      setCard(null);
      setView("desk");
    } else if (input === "o") {
      setMessage(null);
      setMode({ kind: "switcher", index: selectedIndex(state) });
    } else if (input === "4") {
      // Esc returns to where the checklist was opened from, not to the checklist itself.
      openChecklist(null, view === "checklist" ? checklistBack : view);
    } else if (key.escape) {
      setRun(null);
      setMessage(null);
      acts.dismiss();
      if (view === "settings") setView("overview");
      // Esc leaves the test open: nothing is sent (DIPO-365).
      if (view === "checklist") setView(checklistBack);
    } else if (view === "overview") {
      const count = board.length;
      const select = (index: number) => {
        const entry = board[Math.max(0, Math.min(count - 1, index))];
        setOverviewKey(entry === undefined ? null : String(entry.key));
      };
      if (input === "p") {
        setMessage(null);
        setView("settings");
      } else if (key.downArrow || input === "j") {
        select(overviewIndex + 1);
      } else if (key.upArrow || input === "k") {
        select(overviewIndex - 1);
      } else if (key.return && overviewEntry !== null) {
        setOverviewKey(String(overviewEntry.key));
        if (overviewEntry.run !== null) openDetail(overviewEntry.run, "overview");
        else openStory(overviewEntry.key, String(overviewEntry.story), "overview");
      } else if (input === "a" && overviewEntry !== null) {
        if (overviewEntry.run === null) setMessage("no question waits on this row");
        else answerRun(overviewEntry.run);
      }
    } else if (view === "settings") {
      const settings = privacySettings(state);
      const index = Math.min(settingsIndex, Math.max(0, settings.length - 1));
      if (key.downArrow || input === "j") {
        setSettingsIndex(Math.min(Math.max(0, settings.length - 1), index + 1));
      } else if (key.upArrow || input === "k") {
        setSettingsIndex(Math.max(0, index - 1));
      } else if ((key.return || input === " ") && settings[index] !== undefined) {
        if (offline) {
          setMessage("offline: actions are disabled");
          return;
        }
        const setting = settings[index];
        setMessage(null);
        setMode({ kind: "confirm-privacy", key: setting.key, value: !setting.value });
      }
    } else if (view === "checklist") {
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
      } else if (input === "P") {
        recordTest("pass");
      } else if (input === "F") {
        recordTest("fail");
      }
    } else if (view === "queue") {
      if (key.downArrow || input === "j") {
        selectQueue(queueSelected + 1);
      } else if (key.upArrow || input === "k") {
        selectQueue(queueSelected - 1);
      } else if (key.return) {
        const row = queue[queueSelected];
        if (row?.kind !== "story") return;
        openStory(row.view.key, String(row.view.story), "queue");
      } else if (input === ".") {
        setShowDone(!showDone);
      } else if (input === "u") {
        if (offline) {
          setMessage("offline: actions are disabled");
          return;
        }
        runSelected();
      } else if (input === "P" || input === "d") {
        const row = queue[queueSelected];
        if (row?.kind !== "story") {
          setMessage("select a story to park or drop");
          return;
        }
        act(input === "P" ? "park" : "drop", { story: String(row.view.story) });
      }
    } else if (view === "desk") {
      if (key.downArrow || input === "j") {
        selectDesk(deskIndex + 1);
      } else if (key.upArrow || input === "k") {
        selectDesk(deskIndex - 1);
      } else if (key.return && deskItem !== null) {
        openCard(deskItem);
      } else if (deskItem !== null) {
        const bound = rowKeys(deskItem).bound.find((entry) => entry.binding.key === input);
        if (bound === undefined) return;
        setDeskSelection({ id: deskRowId(deskItem), key: deskItem.key ?? null, index: deskIndex });
        if (bound.binding.id === "test" && deskItem.key !== undefined) {
          openChecklist(String(deskItem.key), "desk");
        }
        act(bound.binding.id, deskTarget(deskItem, bound.action.cli, bound.binding.id));
      }
    }
  };

  useInput((input, key) => {
    // Several printable keys in one write: the first acts now, the rest one per render. A typed
    // path keeps the whole text.
    const several =
      mode.kind !== "path" &&
      !acts.typing &&
      input.length > 1 &&
      !key.ctrl &&
      !key.meta &&
      !key.escape &&
      !key.return &&
      /^[\x20-\x7e]+$/.test(input);
    if (!several) {
      handleKey(input, key);
      return;
    }
    handleKey(input.slice(0, 1), key);
    setPending((rest) => rest + input.slice(1));
  });

  useEffect(() => {
    if (pending === "") return;
    setPending(pending.slice(1));
    handleKey(pending.slice(0, 1), NO_KEY);
    // handleKey is this render's: it sees the state the key before it left.
  }, [pending]);

  const narrow = columns < NARROW_COLUMNS || rows < NARROW_ROWS;
  const inSwitcher = mode.kind === "switcher" || mode.kind === "path";
  const switcherIndex = mode.kind === "switcher" || mode.kind === "path" ? mode.index : 0;
  const notice = state.notice;
  const failure =
    run?.status === "failed" && run.error !== undefined
      ? `run ${run.label}: ${run.error.code}: ${run.error.message}`
      : null;
  // A refusal names a run on its way; the effect that clears it runs only after the frame that
  // shows the run done, so the footer drops it in that same frame.
  const activeRefusal = run?.status === "sending" || run?.status === "syncing" ? refusal : null;
  const footerMessage = message ?? acts.statusLine() ?? activeRefusal ?? failure ?? notice;
  const inDetail = detail !== null && !(mode.kind === "switcher" || mode.kind === "path");
  // The footer line starts with a space.
  const detailRun =
    detail === null
      ? undefined
      : state.work.find((candidate) => candidate.work.run === detail.target.run);
  const detailLive = detailRun !== undefined;
  const asks = (runId: string | null) =>
    runId !== null && state.questions.some((question) => question.work.run === runId);
  // The key table's hints for what is selected (DIPO-308).
  const rowHintList: Hint[] = [];
  if (inDetail) {
    if (detail !== null && asks(detail.target.run)) rowHintList.push(["[a]nswer", 85]);
    if (detailLive) {
      for (const entry of viewKeys("detail")) {
        rowHintList.push([entry.hint, 72]);
      }
    }
  } else if (view === "overview") {
    if (overviewEntry !== null && asks(overviewEntry.run)) rowHintList.push(["[a]nswer", 85]);
  } else if (view === "queue") {
    if (queue[queueSelected]?.kind === "story") {
      for (const entry of viewKeys("queue")) {
        rowHintList.push([entry.hint, 25]);
      }
    }
  } else if (view === "desk" && card === null && deskItem !== null) {
    const hints = rowHints(deskItem);
    if (hints !== "") rowHintList.push([hints, 85]);
  }
  const keys = footerKeys(
    mode,
    inDetail ? (detailLive ? "detail" : "ended") : view === "desk" && card !== null ? "card" : view,
    state,
    offline,
    run,
    columns - 1,
    {
      prompt: acts.promptHints(),
      row: rowHintList,
      retry: acts.retryable,
      desk: deskItem !== null,
    },
  );

  if (narrow) {
    return (
      <Box flexDirection="column">
        <NarrowBody
          state={state}
          display={display}
          switcher={inSwitcher ? { index: switcherIndex } : null}
        />
        {/* An open action prompt shows at every size, so what a key does is on screen. */}
        {acts.promptLines().map((line, i) => (
          <Text key={`prompt:${i}`} wrap="truncate-end">
            {line}
          </Text>
        ))}
        {footerMessage === null ? null : <Text wrap="truncate-end">{footerMessage}</Text>}
      </Box>
    );
  }

  const panel = !inSwitcher && run !== null ? runLines(run, state, ellipsis) : [];
  // The selected desk row's actions no key sends, as the command line to type, and (below 80
  // columns, where the row has no second line) its hand action.
  const deskShown = !inSwitcher && detail === null && view === "desk";
  if (deskShown && card === null && deskItem !== null) {
    for (const action of rowKeys(deskItem).unbound) {
      panel.push(`type: ${action.cli}`);
    }
    if (deskItem.hand !== undefined && columns < DESK_WIDE_COLUMNS) {
      panel.push(`by hand: ${deskItem.hand}`);
    }
  }
  // The open action prompt (`actions.ts`).
  if (!inSwitcher) panel.push(...acts.promptLines());
  // Header, banners, footer keys and message, and the run lines stay on screen; the queue gets
  // the rest.
  const prompt = mode.kind === "path" || mode.kind.startsWith("confirm") ? 1 : 0;
  // A confirmation question that wraps takes more than one line.
  const promptLines =
    mode.kind === "confirm-privacy"
      ? Math.ceil((confirmPrompt(mode.key, mode.value).length + 8) / Math.max(1, columns))
      : prompt;
  const height =
    rows -
    3 -
    bannerLines(state, display.ascii).length -
    panel.length -
    promptLines -
    (footerMessage === null ? 0 : 1);

  return (
    <Box flexDirection="column">
      <Header state={state} display={display} />
      <Banners state={state} display={display} />
      {inSwitcher ? (
        <SwitcherBody
          state={state}
          display={display}
          index={switcherIndex}
          now={clock.now()}
          columns={columns}
        />
      ) : detail !== null ? (
        <Detail
          // A new run starts with a fresh pane.
          key={detail.target.run}
          state={state}
          store={store}
          clock={clock}
          display={display}
          target={detail.target}
          readOutput={actions.readOutput}
          readPrompt={actions.readPrompt}
          columns={columns}
          height={height}
          keysActive={mode.kind === "home" && acts.flow === null}
          tailBytes={props.outputTailBytes ?? OUTPUT_TAIL_BYTES}
        />
      ) : view === "settings" ? (
        <Settings
          state={state}
          display={display}
          selected={settingsIndex}
          written={privacyWritten}
        />
      ) : view === "desk" && card !== null ? (
        <StoryCard
          item={card.item}
          outcome={card.outcome}
          now={clock.now()}
          evidence={EVIDENCE_MARKERS}
          display={display}
          columns={columns}
          height={height}
          top={card.top}
        />
      ) : view === "desk" ? (
        <Desk
          desk={desk}
          selected={deskIndex}
          columns={columns}
          height={height}
          now={clock.now()}
          display={display}
        />
      ) : view === "queue" ? (
        <Queue
          rows={queue}
          selected={queueSelected}
          display={display}
          columns={columns}
          height={height}
          now={clock.now()}
        />
      ) : view === "checklist" ? (
        <Checklist
          test={checklistTest}
          empty={
            checklistKey === null
              ? "No test is open. t on a desk row starts one."
              : `No test is open for ${checklistKey}.`
          }
          ticked={checklistTest === null ? [] : (ticks[checklistTest.test] ?? [])}
          step={checklistStep}
          display={display}
          columns={columns}
        />
      ) : (
        <Overview
          state={state}
          display={display}
          width={widthOf(columns)}
          columns={columns}
          height={height}
          clock={clock}
          latest={latest}
          selected={overviewEntry === null ? null : String(overviewEntry.key)}
          digest={digest === null ? null : digestLine(digest, glyphs(display.ascii).dot)}
        />
      )}
      {panel.map((line, i) => (
        <Text key={i} wrap="truncate-end">{` ${line}`}</Text>
      ))}
      {mode.kind === "path" ? <Text>{` open repository path: ${mode.text}_`}</Text> : null}
      {mode.kind === "confirm-privacy" ? (
        <Text>{` ${confirmPrompt(mode.key, mode.value)} [y/N]`}</Text>
      ) : null}
      <Footer keys={keys} message={footerMessage} display={display} />
    </Box>
  );
}

/** A footer hint; when the line is too wide the lowest priority goes first, `[q] quit` never. */
type Hint = readonly [text: string, priority: number];

/** The hints in their order, without the lowest-priority ones that do not fit in `width`. */
export function fitHints(hints: readonly Hint[], width: number): string {
  const kept = [...hints];
  const text = () => kept.map(([hint]) => hint).join("  ");
  while (text().length > width && kept.length > 1) {
    let lowest = 0;
    for (let i = 1; i < kept.length; i++) {
      if ((kept[i]?.[1] ?? 0) < (kept[lowest]?.[1] ?? 0)) lowest = i;
    }
    kept.splice(lowest, 1);
  }
  return text();
}

const QUIT = 100;

/** The footer's parts the key table adds (DIPO-308). */
interface FooterExtras {
  /** The keys of an open action prompt; they replace every other hint. */
  readonly prompt: string | null;
  /** The keys of the selected row or run. */
  readonly row: readonly Hint[];
  /** True when a failed action offers Ctrl-R. */
  readonly retry: boolean;
  /** True when the desk has a row selected. */
  readonly desk: boolean;
}

function footerKeys(
  mode: Mode,
  view: View | "detail" | "ended" | "card",
  state: OfficeStoreState,
  offline: boolean,
  run: RunAction | null,
  width: number,
  extras: FooterExtras,
): string {
  if (extras.prompt !== null) return fitHints([[extras.prompt, QUIT]], width);
  const quit: Hint = [`[q] quit${offline ? " (offline: actions disabled)" : ""}`, QUIT];
  const hints: Hint[] = [];
  switch (mode.kind) {
    case "path":
      return fitHints(
        [
          ["[Enter] open", QUIT],
          ["[Esc] cancel", QUIT],
        ],
        width,
      );
    case "confirm-privacy":
      return fitHints(
        [
          ["[y] change it", QUIT],
          ["[any other key] keep it", 50],
        ],
        width,
      );
    case "switcher":
      hints.push(["[Enter] open", 70], ["[n] open new repo path", 40], ["[j/k] move", 30]);
      if (state.office !== null) hints.push(["[Esc] back", 50]);
      hints.push(quit);
      return fitHints(hints, width);
    default:
      if (extras.retry || (run?.status === "failed" && run.error?.retryable === true)) {
        hints.push(["[Ctrl-R] retry", 80]);
      }
      hints.push(...extras.row);
      if (view === "card") {
        hints.push(["[j/k] scroll", 30], ["[Esc] back", 90], quit);
        if (EVIDENCE_MARKERS) hints.push([EVIDENCE_LEGEND, 10]);
        return fitHints(hints, width);
      }
      if (view === "detail" || view === "ended") {
        hints.push(
          ["[w]orker [v]erify [i] prompt", 75],
          ["[k/j PgUp/PgDn] scroll", 35],
          ["[End] follow tail", 45],
        );
        hints.push(["[Esc] back", 90]);
        hints.push(quit);
        if (EVIDENCE_MARKERS) hints.push([EVIDENCE_LEGEND, 10]);
        return fitHints(hints, width);
      }
      if (view === "settings") {
        hints.push(
          ["[Enter] toggle", 70],
          ["[j/k] move", 30],
          ["[Esc] back", 50],
          ["[1] overview", 40],
        );
      } else if (view === "queue") {
        hints.push(
          ["[Enter] detail", 60],
          ["r[u]n selected", 70],
          ["[j/k] move", 30],
          ["[.] show done", 20],
          ["[1] overview", 50],
        );
        hints.push(["[3] desk", 45]);
      } else if (view === "checklist") {
        hints.push(
          ["[Space] tick", 70],
          ["[P] pass", 75],
          ["[F] fail", 75],
          ["[j/k] step", 30],
          ["[Esc] back", 90],
        );
      } else if (view === "desk") {
        if (extras.desk) hints.push(["[Enter] detail", 60], ["[j/k] move", 30]);
        hints.push(["[1] overview", 50], ["[2] queue", 45], ["[4] checklist", 35]);
      } else {
        if (boardEntries(state).length > 0) {
          hints.push(["[Enter] detail", 60], ["[j/k] move", 30]);
        }
        hints.push(["[2] queue", 50], ["[3] desk", 48], ["[p] privacy", 45]);
      }
      hints.push(["[o] offices", 40]);
      hints.push(quit);
      if (EVIDENCE_MARKERS) hints.push([EVIDENCE_LEGEND, 10]);
      return fitHints(hints, width);
  }
}
