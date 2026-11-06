// The home mode of the TUI (0009, DIPO-443): the views behind `1` to `4` (overview, queue, privacy
// settings, desk, checklist), the live agent detail and the desk card over them, and the `work.run`
// a queue row sends. `useHome` holds their state and keys; `HomeMode` draws the one that shows.
// `app.tsx` wires it to the modes and the footer.

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
import type { Key } from "ink";
import { useEffect, useState } from "react";

import type { ActionTarget, useActions } from "./actions";
import type { RunRequest, RunResult, TuiActions } from "./app";
import { Checklist, firstUnticked } from "./checklist";
import {
  Desk,
  DESK_WIDE_COLUMNS,
  deskRowId,
  deskRows,
  rowHints,
  selectedRow,
  useDesk,
} from "./desk";
import { Detail, type DetailTarget } from "./detail";
import { type Hint } from "./footer";
import { skipReason, widthOf } from "./format";
import { digestLine, useDigest } from "./digest";
import { type ActionId, rowKeys, viewKeys } from "./keys";
import { useLatestLines } from "./latest";
import type { Display } from "./options";
import { OUTPUT_TAIL_BYTES } from "./output";
import { boardEntries, Overview } from "./overview";
import { Queue, queueRows } from "./queue";
import { privacySettings, Settings, settingName, appliesWords } from "./settings";
import { type CardOutcome, StoryCard } from "./story-card";
import { glyphs } from "./views";

export type View = "overview" | "queue" | "settings" | "desk" | "checklist";

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

/** True for the keys that leave an overlay for a view: `1` to `4` and `o`. */
function leavesOverlay(input: string): boolean {
  return input === "1" || input === "2" || input === "3" || input === "4" || input === "o";
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
  /** `o`: opens the office switcher. */
  readonly openSwitcher: () => void;
  /** Asks to confirm a privacy change (the mode `confirm-privacy`). */
  readonly confirmPrivacy: (key: string, value: boolean) => void;
}

/** The state, the keys and the footer facts of the home mode. */
export function useHome(args: HomeArgs) {
  const { store, clock, display, actions, state, ellipsis, acts, act, setMessage } = args;
  const [view, setView] = useState<View>("overview");
  // The selected queue row by story key, so it follows the story when the queue changes; null is
  // the "next Ready story" row.
  const [queueKey, setQueueKey] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [run, setRun] = useState<RunAction | null>(null);
  // Why a `u` was refused; cleared by the next key and when the run it names ends.
  const [refusal, setRefusal] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);
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
  const overviewEntry = board[overviewIndex] ?? null;
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
    clock,
  });
  // The open test the checklist shows: the story's, else the first open one (DIPO-365).
  const checklistTest =
    state.tests.find((test) => checklistKey === null || String(test.key) === checklistKey) ?? null;
  /** `4`, or `t` on a desk row: the checklist of `story`, else any; Esc returns to `back`. */
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

  // Key handling: the live agent detail and a desk card take their keys first, then the keys
  // every view shares, then one handler per view.

  /**
   * The live agent detail: Esc goes back; the pane takes its own keys. True when the key ends
   * here; a view key or Ctrl-R closes nothing or the detail and goes on to the views.
   */
  const onDetailKey = (open: DetailState, input: string, key: Key): boolean => {
    if (key.escape) {
      setDetail(null);
      setView(open.back);
      setMessage(null);
      return true;
    }
    // The key table's actions on the run (DIPO-308): answer its question, steer, park.
    if (input === "a") {
      answerRun(open.target.run);
      return true;
    }
    if (input === "s" || input === "P") {
      steerOrPark(input === "s" ? "steer" : "park", open.target.run);
      return true;
    }
    const leaves = leavesOverlay(input);
    if (!leaves && !(key.ctrl && input === "r")) return true;
    if (leaves) setDetail(null);
    return false;
  };

  /** Ctrl-R sends a failed retryable action or `work.run` again with its request id. */
  const onRetryKey = () => {
    if (acts.retry()) return;
    if (run?.status !== "failed" || run.error?.retryable !== true || args.refusedOffline()) return;
    // The same request id: the engine runs the command at most once (0005).
    send(run.request, run.label);
  };

  /** The story a desk row opened: Esc returns to the desk, `j`/`k` scroll, view keys leave it. */
  const onCardKey = (open: CardState, input: string, key: Key): boolean => {
    if (key.escape) {
      setCard(null);
      setMessage(null);
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
    if (!leavesOverlay(input)) return true;
    setCard(null);
    return false;
  };

  /** The keys every view shares: switch views, open the switcher or a checklist, Esc. */
  const onSharedViewKey = (input: string, key: Key): boolean => {
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
      args.openSwitcher();
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
    } else if (input === "P") {
      recordTest("pass");
    } else if (input === "F") {
      recordTest("fail");
    }
  };

  const onQueueKey = (input: string, key: Key) => {
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
      if (args.refusedOffline()) return;
      runSelected();
    } else if (input === "P" || input === "d") {
      const row = queue[queueSelected];
      if (row?.kind !== "story") {
        setMessage("select a story to park or drop");
        return;
      }
      act(input === "P" ? "park" : "drop", { story: String(row.view.story) });
    }
  };

  const onDeskKey = (input: string, key: Key) => {
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
        const storyKey = String(deskItem.key);
        const id =
          deskItem.story ?? state.stories.find((story) => String(story.key) === storyKey)?.story;
        openChecklist({ key: storyKey, id: id === undefined ? "this story" : String(id) }, "desk");
      }
      act(bound.binding.id, deskTarget(deskItem, bound.action.cli, bound.binding.id));
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

  /** An open detail or card first, then Ctrl-R, the shared view keys and the view's own. */
  const onKey = (input: string, key: Key) => {
    if (detail !== null && onDetailKey(detail, input, key)) return;
    if (key.ctrl && input === "r") {
      onRetryKey();
      return;
    }
    if (view === "desk" && card !== null && onCardKey(card, input, key)) return;
    if (onSharedViewKey(input, key)) return;
    onViewKey[view](input, key);
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
    if (asks(detail.target.run)) rowHintList.push(["[a]nswer", 85]);
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
    overviewEntry,
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
    sendPrivacy,
    rowHintList,
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
    /** A key arrived: a refusal is gone. */
    clearRefusal() {
      setRefusal(null);
    },
    /** The lines under the body: the run, and the selected desk row's actions no key sends. */
    panelLines(columns: number): string[] {
      const panel = run !== null ? runLines(run, state, ellipsis) : [];
      // Below 80 columns the desk row has no second line, so its hand action goes here.
      if (detail === null && view === "desk" && card === null && deskItem !== null) {
        for (const action of rowKeys(deskItem).unbound) {
          panel.push(`type: ${action.cli}`);
        }
        if (deskItem.hand !== undefined && columns < DESK_WIDE_COLUMNS) {
          panel.push(`by hand: ${deskItem.hand}`);
        }
      }
      return panel;
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
        keysActive={props.keysActive}
        tailBytes={props.outputTailBytes ?? OUTPUT_TAIL_BYTES}
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
      />
    );
  }
  if (view === "desk") {
    return (
      <Desk
        desk={home.desk}
        selected={home.deskIndex}
        columns={columns}
        height={height}
        now={clock.now()}
        display={display}
      />
    );
  }
  if (view === "queue") {
    return (
      <Queue
        rows={home.queue}
        selected={home.queueSelected}
        display={display}
        columns={columns}
        height={height}
        now={clock.now()}
      />
    );
  }
  if (view === "checklist") {
    const { checklistTest, checklistKey, checklistStory } = home;
    return (
      <Checklist
        test={checklistTest}
        empty={
          checklistKey === null
            ? "No test is open. t on a desk row starts one."
            : `No test is open for ${checklistStory ?? "this story"}.`
        }
        ticked={checklistTest === null ? [] : (home.ticks[checklistTest.test] ?? [])}
        step={home.checklistStep}
        display={display}
        columns={columns}
      />
    );
  }
  return (
    <Overview
      state={state}
      display={display}
      width={widthOf(columns)}
      columns={columns}
      height={height}
      clock={clock}
      latest={home.latest}
      selected={home.overviewEntry === null ? null : String(home.overviewEntry.key)}
      digest={home.digest === null ? null : digestLine(home.digest, glyphs(display.ascii).dot)}
    />
  );
}
