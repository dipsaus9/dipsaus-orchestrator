// The TUI root (0009 sections 4 to 7 and 9): the header with office, daemon state and connection,
// the banners, the office overview (`1`), the queue (`2`) or the office switcher, and the footer
// with the keys that work now. Global keys: `1` overview, `2` queue, `o` offices, `q` twice within
// 2 s quits, Ctrl+C quits. In the queue: `j`/`k` or arrows move, `u` runs the selected story (or
// lets the engine pick the next Ready one) with `work.run`, `.` shows Done stories. In the
// overview `j`/`k` or arrows move; Enter on a running story, there or in the queue, opens the live
// agent detail (`detail.tsx`), where `X` asks "worker ends, branch kept, story parks as stopped"
// and sends `work.stop` on yes, and Esc returns to the view it came from. In the switcher: `j`/`k`
// or arrows move, Enter opens the office through `office.switch`, `n` opens a new repository path
// through `office.open`, Esc goes back. Action keys are off while offline.
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
  EngineError,
  OfficeId,
  RequestId,
  StoryRefValue,
} from "@dipsaus-orchestrator/contract";
import { Box, type Key, Text, useInput, useWindowSize } from "ink";
import { useEffect, useState } from "react";

import { useBatchedState } from "./batch";
import { Detail, type DetailTarget, type ReadOutput, STOP_PROMPT } from "./detail";
import { skipReason, widthOf } from "./format";
import type { Display } from "./options";
import { OUTPUT_TAIL_BYTES } from "./output";
import { EVIDENCE_LEGEND, evidenceEnabled, Overview } from "./overview";
import { Queue, queueRows } from "./queue";
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

export interface StopRequest {
  readonly office: OfficeId;
  readonly story: StoryRefValue;
  readonly requestId: RequestId;
}

/** A `work.stop` reply. */
export type StopOutcome =
  | { readonly ok: true; readonly cursor?: Cursor }
  | { readonly ok: false; readonly error: EngineError };

/** The commands the TUI sends; `run` builds them on the client session. */
export interface TuiActions {
  /** `work.outputRange` for the live agent detail (0005 section 7). */
  readOutput: ReadOutput;
  /** `work.stop`, confirmed by the maintainer (0009 section 5). */
  stopStory(request: StopRequest): Promise<StopOutcome>;
  /** `office.open` for a path the maintainer typed. */
  openPath(path: string): Promise<ActionResult<OfficeId>>;
  /** `daemon.resumeScheduling`, after the maintainer agreed. */
  resumeScheduling(): Promise<ActionResult<null>>;
  /** `work.run` with `origin: "tui"` and the given request id (0009 section 5). */
  runStories(request: RunRequest): Promise<RunOutcome>;
  /** A fresh request id for a new action; a retry reuses the old one. */
  newRequestId(): RequestId;
}

type Mode =
  | { readonly kind: "home" }
  | { readonly kind: "switcher"; readonly index: number }
  | { readonly kind: "path"; readonly index: number; readonly text: string }
  | { readonly kind: "confirm-resume" }
  | { readonly kind: "confirm-stop"; readonly story: StoryRefValue };

type View = "overview" | "queue";

/** The live agent detail and the view Esc returns to. */
interface DetailState {
  readonly target: DetailTarget;
  readonly back: View;
}

/** One `work.stop` the maintainer confirmed, from send to done. */
interface StopAction {
  readonly story: string;
  readonly status: "sending" | "syncing" | "done";
  readonly cursor?: Cursor;
  readonly snapshots?: number;
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
  // The selected overview row by run, so it follows the run when rows come and go.
  const [overviewRun, setOverviewRun] = useState<string | null>(null);
  const [stop, setStop] = useState<StopAction | null>(null);
  const offline = isOffline(state);
  const overviewIndex = Math.max(
    0,
    state.work.findIndex((candidate) => candidate.work.run === overviewRun),
  );
  const overviewSelected = state.work[overviewIndex]?.work.run ?? null;
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

  // Read-your-writes: a run is done once the office stream passes its reply cursor, once the store
  // read a snapshot again after the reply (a history gap, whatever the epoch), or once the
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

  // The same for a stop.
  useEffect(() => {
    if (stop?.status !== "syncing") return;
    const passed =
      stop.cursor === undefined ||
      cursorReached(state.cursor, stop.cursor) ||
      (stop.snapshots !== undefined && state.snapshots > stop.snapshots);
    if (passed) setStop({ ...stop, status: "done" });
  }, [stop, state.cursor, state.snapshots]);

  const sendStop = (story: StoryRefValue) => {
    if (state.office === null) return;
    const label = String(story);
    setMessage(null);
    setStop({ story: label, status: "sending" });
    void actions
      .stopStory({ office: state.office, story, requestId: actions.newRequestId() })
      .then((outcome) => {
        if (!outcome.ok) {
          setStop(null);
          setMessage(`stop ${label}: ${outcome.error.code}: ${outcome.error.message}`);
          return;
        }
        setStop({
          story: label,
          status: "syncing",
          ...(outcome.cursor === undefined ? {} : { cursor: outcome.cursor }),
          snapshots: store.state.snapshots,
        });
      });
  };

  const openDetail = (runId: string, back: View) => {
    const found = state.work.find((candidate) => candidate.work.run === runId);
    if (found === undefined) return;
    setMessage(null);
    setDetail({ target: { run: found.work.run, key: found.work.key }, back });
  };

  const quit = () => props.onQuit();

  const switchTo = (office: OfficeId, name: string) => {
    setMessage(`opening ${name}${ellipsis}`);
    void store.switchTo(office).then((outcome) => {
      if (outcome.ok) {
        setMessage(null);
        setMode({ kind: "home" });
        setQueueKey(null);
        setOverviewRun(null);
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

    if (mode.kind === "confirm-resume") {
      setMode({ kind: "home" });
      if (input !== "y" && input !== "Y") {
        setMessage("scheduling stays off");
        return;
      }
      setMessage(`resuming scheduling${ellipsis}`);
      void actions.resumeScheduling().then((outcome) => {
        setMessage(outcome.ok ? "scheduling resumed" : outcome.message);
      });
      return;
    }

    if (mode.kind === "confirm-stop") {
      setMode({ kind: "home" });
      if (input !== "y" && input !== "Y") {
        setMessage(`${mode.story} keeps running`);
        return;
      }
      if (offline) {
        setMessage("offline: actions are disabled");
        return;
      }
      sendStop(mode.story);
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

    // The live agent detail: Esc goes back, `X` stops after a yes; the pane takes its own keys.
    if (detail !== null) {
      if (key.escape) {
        setDetail(null);
        setView(detail.back);
        setMessage(null);
        return;
      }
      if (input === "X") {
        const current = state.work.find((candidate) => candidate.work.run === detail.target.run);
        if (current === undefined) {
          setMessage("this run has ended; there is no worker to stop");
          return;
        }
        if (offline) {
          setMessage("offline: actions are disabled");
          return;
        }
        if (stop?.status === "sending" || stop?.status === "syncing") {
          setMessage(`stop ${stop.story} is still on its way; wait until it is done`);
          return;
        }
        setMessage(null);
        setMode({ kind: "confirm-stop", story: current.work.story });
        return;
      }
      const leaves = input === "1" || input === "2" || input === "o";
      if (!leaves && !(input === "S" && state.daemon === "safe") && !(key.ctrl && input === "r")) {
        return;
      }
      if (leaves) setDetail(null);
    }

    // Home: the overview or the queue.
    if (key.ctrl && input === "r") {
      if (run?.status !== "failed" || run.error?.retryable !== true) return;
      if (offline) {
        setMessage("offline: actions are disabled");
        return;
      }
      // The same request id: the engine runs the command at most once (0005 section 9).
      send(run.request, run.label);
      return;
    }
    if (input === "1") {
      setView("overview");
    } else if (input === "2") {
      setView("queue");
    } else if (input === "o") {
      setMessage(null);
      setMode({ kind: "switcher", index: selectedIndex(state) });
    } else if (key.escape) {
      setRun(null);
      setMessage(null);
    } else if (input === "S" && state.daemon === "safe") {
      if (offline) {
        setMessage("offline: actions are disabled");
        return;
      }
      setMode({ kind: "confirm-resume" });
    } else if (view === "overview") {
      const count = state.work.length;
      if (key.downArrow || input === "j") {
        setOverviewRun(state.work[Math.min(count - 1, overviewIndex + 1)]?.work.run ?? null);
      } else if (key.upArrow || input === "k") {
        setOverviewRun(state.work[Math.max(0, overviewIndex - 1)]?.work.run ?? null);
      } else if (key.return && overviewSelected !== null) {
        openDetail(overviewSelected, "overview");
      }
    } else if (view === "queue") {
      if (key.downArrow || input === "j") {
        selectQueue(queueSelected + 1);
      } else if (key.upArrow || input === "k") {
        selectQueue(queueSelected - 1);
      } else if (key.return) {
        const row = queue[queueSelected];
        if (row?.kind !== "story") return;
        const running = state.work.find((candidate) => candidate.work.key === row.view.key);
        if (running === undefined) {
          setMessage(`${row.view.story} is not running; Enter opens the detail of a running story`);
          return;
        }
        openDetail(running.work.run, "queue");
      } else if (input === ".") {
        setShowDone(!showDone);
      } else if (input === "u") {
        if (offline) {
          setMessage("offline: actions are disabled");
          return;
        }
        runSelected();
      }
    }
  };

  useInput((input, key) => {
    // Several printable keys in one write: the first acts now, the rest one per render. A typed
    // path keeps the whole text.
    const several =
      mode.kind !== "path" &&
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
  const stopLine =
    stop === null
      ? null
      : stop.status === "sending"
        ? `stop ${stop.story}: sending${ellipsis}`
        : stop.status === "syncing"
          ? `stop ${stop.story}: answered, waiting for the office stream${ellipsis}`
          : `stop ${stop.story}: done; the worker ends and the story parks as stopped`;
  // A refusal names a run on its way; the effect that clears it runs only after the frame that
  // shows the run done, so the footer drops it in that same frame.
  const activeRefusal = run?.status === "sending" || run?.status === "syncing" ? refusal : null;
  const footerMessage = message ?? activeRefusal ?? failure ?? stopLine ?? notice;
  const inDetail = detail !== null && !(mode.kind === "switcher" || mode.kind === "path");
  // The footer line starts with a space.
  const keys = footerKeys(mode, inDetail ? "detail" : view, state, offline, run, columns - 1);

  if (narrow) {
    return (
      <Box flexDirection="column">
        <NarrowBody
          state={state}
          display={display}
          switcher={inSwitcher ? { index: switcherIndex } : null}
        />
        {footerMessage === null ? null : <Text wrap="truncate-end">{footerMessage}</Text>}
      </Box>
    );
  }

  const panel = !inSwitcher && run !== null ? runLines(run, state, ellipsis) : [];
  // Header, banners, footer keys and message, and the run lines stay on screen; the queue gets
  // the rest.
  const prompt = mode.kind === "path" || mode.kind.startsWith("confirm") ? 1 : 0;
  const height =
    rows -
    3 -
    bannerLines(state, display.ascii).length -
    panel.length -
    prompt -
    (footerMessage === null ? 0 : 1);

  return (
    <Box flexDirection="column">
      <Header state={state} display={display} />
      <Banners state={state} display={display} />
      {inSwitcher ? (
        <SwitcherBody state={state} display={display} index={switcherIndex} now={clock.now()} />
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
          columns={columns}
          height={height}
          keysActive={mode.kind === "home"}
          tailBytes={props.outputTailBytes ?? OUTPUT_TAIL_BYTES}
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
      ) : (
        <Overview
          state={state}
          display={display}
          width={widthOf(columns)}
          columns={columns}
          selected={overviewSelected}
        />
      )}
      {panel.map((line, i) => (
        <Text key={i} wrap="truncate-end">{` ${line}`}</Text>
      ))}
      {mode.kind === "path" ? <Text>{` open repository path: ${mode.text}_`}</Text> : null}
      {mode.kind === "confirm-resume" ? <Text>{" Resume scheduling? [y/N]"}</Text> : null}
      {mode.kind === "confirm-stop" ? (
        <Text wrap="truncate-end">{` Stop ${mode.story}? ${STOP_PROMPT}. [y/N]`}</Text>
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

function footerKeys(
  mode: Mode,
  view: View | "detail",
  state: OfficeStoreState,
  offline: boolean,
  run: RunAction | null,
  width: number,
): string {
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
    case "confirm-resume":
      return fitHints(
        [
          ["[y] resume scheduling", QUIT],
          ["[any other key] cancel", 50],
        ],
        width,
      );
    case "confirm-stop":
      return fitHints(
        [
          ["[y] stop the worker", QUIT],
          ["[any other key] keep it running", 50],
        ],
        width,
      );
    case "switcher":
      hints.push(["[Enter] open", 70], ["[n] open new repo path", 40], ["[j/k] move", 30]);
      if (state.office !== null) hints.push(["[Esc] back", 50]);
      hints.push(quit);
      return fitHints(hints, width);
    default:
      if (run?.status === "failed" && run.error?.retryable === true) {
        hints.push(["[Ctrl-R] retry", 80]);
      }
      if (view === "detail") {
        hints.push(
          ["[w]orker [v]erify", 75],
          ["[k/j PgUp/PgDn] scroll", 35],
          ["[End] follow tail", 45],
          ["[X] stop", 70],
          ["[Esc] back", 90],
        );
        hints.push(quit);
        if (evidenceEnabled(state)) hints.push([EVIDENCE_LEGEND, 10]);
        return fitHints(hints, width);
      }
      if (view === "queue") {
        hints.push(
          ["[Enter] detail", 60],
          ["r[u]n selected", 70],
          ["[j/k] move", 30],
          ["[.] show done", 20],
          ["[1] overview", 50],
        );
      } else {
        if (state.work.length > 0) hints.push(["[Enter] detail", 60], ["[j/k] move", 30]);
        hints.push(["[2] queue", 50]);
      }
      hints.push(["[o] offices", 40]);
      if (state.daemon === "safe") hints.push(["[S] resume scheduling", 60]);
      hints.push(quit);
      if (evidenceEnabled(state)) hints.push([EVIDENCE_LEGEND, 10]);
      return fitHints(hints, width);
  }
}
