// The planning view (DIPO-449, 0009, 0008): its own mode, opened with `5` beside the rooms. Without an open
// planning session it asks for a kind (`Tab` changes it) and a goal and starts one with
// `planning.start`; with one it is one conversation column (DIPO-487): the
// session's head, the answers as they stream in (`planning.output`), the proposals that still need
// a decision as compact cards, one line for each proposal that was confirmed, and one input at the
// foot for the next message (`planning.message`). The session is the engine's view
// (`OfficeStoreState.planning`, from the snapshot and the office stream), so a TUI that opens later
// shows the open session again, with its stored answers read with `work.outputRange` and the
// maintainer's messages the engine's view lists. The conversation is the whole planning session's,
// across its model sessions (DIPO-490): a fresh model session adds to it, one dim line marks the
// handover (DIPO-448), and between the end of a full context and the fresh session the view stays.
//
// The input (DIPO-479): Enter sends; Shift+Enter, Option+Enter or a backslash before Enter adds a
// line; Backspace erases, a paste keeps its line breaks. Esc goes back to home and leaves the
// session running. `Tab` opens and closes the stories fold-out (IN THIS PLAN, ON END).
//
// Cards (DIPO-450, DIPO-487): a proposal that is open, or failed with the lane's reason, shows as a
// card with its title, proposed tier and first story line. With an empty input, Up moves focus
// into the cards; Up and Down move between them; `c` confirms the focused card
// (`planning.confirm`), `x` declines it (`planning.decline`) and `e` puts it into the input as a
// form (`proposal-form.ts`) that Enter sends as `planning.edit` and Esc leaves unsent. Esc, or any
// other printable key, returns focus to the input and types there. A confirmed proposal leaves the
// cards at once and shows as one line, `filing…` and then `filed as DIPO-n`; a declined one leaves.
//
// Ending (DIPO-487, DIPO-497): `/end` then Enter asks to end; `Y` sends `planning.end`, and when
// the session filed or edited stories that stayed Refined, the view lists each one with the gate's
// first message and how to set it Ready later (the Queue's `space` and `Y`, or `dipo ready <ID>`)
// until a key is pressed. Any other key keeps the session open. Stories are set Ready only by the
// confirm and by `story.ready`, never by ending.

import {
  healthLabel,
  type OfficeStore,
  type OfficeStoreState,
  usageTokens,
} from "@dipsaus-orchestrator/client";
import {
  type LaneProgress,
  PLANNING_KINDS,
  type PlanningProposalView,
  type PlanningQuestionBlock,
  type PlanningView,
  type RunId,
} from "@dipsaus-orchestrator/contract";
import { Box, type Key, Text } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";

import type { TuiActions } from "./app";
import { Colored, type Role } from "./colour";
import { COMPOSER_ROWS, Composer, composerKey, composerRows } from "./composer";
import { truncate } from "./format";
import { waitsOn } from "./lane";
import type { Display } from "./options";
import { proposalForm, readProposalForm } from "./proposal-form";
import {
  dialogAnswers,
  dialogKey,
  dialogRows,
  type DialogState,
  freshDialog,
} from "./question-dialog";
import { SpanLine } from "./spans";
import {
  conversationParts,
  foldCount,
  type Transcript,
  type TranscriptPart,
  type TranscriptRow,
  transcriptRows,
} from "./transcript";
import { clockTime, glyphs } from "./views";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The lines of the input while it holds a proposal's form (DIPO-450). */
const FORM_ROWS = 16;

/** What the planning view needs from the app around it. */
export interface PlanningArgs {
  readonly store: OfficeStore;
  readonly actions: TuiActions;
  readonly state: OfficeStoreState;
  readonly setMessage: (message: string | null) => void;
  /** True, with the footer saying so, while offline: the caller sends nothing. */
  readonly refusedOffline: () => boolean;
  /** Esc: back to home. */
  readonly leave: () => void;
  /** Opens the planning view (the retro's `d`). */
  readonly open: () => void;
}

/** A story the session filed or edited that stayed Refined, with the gate's first message (DIPO-497). */
export interface StayedRefined {
  readonly story: string;
  readonly message: string;
}

/**
 * The end question (DIPO-487, DIPO-497): null `stayed` while it asks; once the session ended, the
 * stories that stayed Refined, listed until a key is pressed.
 */
export interface EndStep {
  readonly stayed: readonly StayedRefined[] | null;
}

export interface Planning {
  readonly view: PlanningView | null;
  readonly kind: string;
  readonly draft: string;
  readonly transcript: Transcript;
  /** What is under way: a start, a message or an end; null otherwise. */
  readonly sending: Sending | null;
  /** The end question, or null while the conversation has the keys. */
  readonly ending: EndStep | null;
  /** The fold under the focus bar and the folds that are open (DIPO-486), by number. */
  readonly focus: number | null;
  readonly open: ReadonlySet<number>;
  /** The number of the focused card, or null while the input has focus (DIPO-487). */
  readonly focused: number | null;
  /** The number of the proposal whose form the input holds, or null. */
  readonly editing: number | null;
  /** The stories fold-out is open. */
  readonly rail: boolean;
  /** The block of questions the maintainer answers now, and the dialog's state (DIPO-455). */
  readonly dialog: { readonly block: PlanningQuestionBlock; readonly state: DialogState } | null;
  /** Opens the view with `text` in the input, as the retro's `d` does (DIPO-479). */
  discuss(text: string): void;
  onKey(input: string, key: Key): void;
}

/** The proposals a decision applies to: open ones, and those the lane could not file. */
const decidable = (proposal: PlanningProposalView) =>
  proposal.state === "open" || proposal.state === "failed";

/** The card after `step` from `focused`, among the cards that take a decision. */
function stepFocus(
  cards: readonly PlanningProposalView[],
  focused: number | null,
  step: number,
): number | null {
  if (cards.length === 0) return null;
  const at = cards.findIndex((card) => card.n === focused);
  const from = at < 0 ? cards.length - 1 : at + step;
  return cards[Math.max(0, Math.min(cards.length - 1, from))]?.n ?? null;
}

/** Appends `chunk` to what is shown when it continues it; true when it did. */
function continues(have: number, from: number, to: number): boolean {
  return from <= have && to > have;
}

type Sending = "start" | "message" | "end" | "proposal" | "answer";

/** Sends one command; an error stays in the footer and the draft stays. */
function sendCommand(
  args: PlanningArgs,
  setSending: (sending: Sending | null) => void,
  which: Sending,
  request: { readonly command: string; readonly args: Record<string, unknown> },
  done: (result: unknown) => void,
): void {
  const { actions, state } = args;
  if (state.office === null) return;
  setSending(which);
  args.setMessage(null);
  void actions
    .sendCommand({
      office: state.office,
      ...request,
      requestId: actions.newRequestId(),
      confirmed: false,
    })
    .then((outcome) => {
      setSending(null);
      if (outcome.ok) done(outcome.result);
      else args.setMessage(`${outcome.error.code}: ${outcome.error.message}`);
    });
}

/**
 * The planning session's conversation (DIPO-490): every model session's stored output, read from
 * the start, then every `planning.output` that continues it (a gap is read again), with the
 * maintainer's messages and the handovers from the engine's view (`conversationParts`). It is
 * keyed by the session, so a fresh model session adds to it; it starts over for another session or
 * office.
 */
function useTranscript(args: PlanningArgs): TranscriptPart[] {
  const { store, actions, state } = args;
  const view = state.planning;
  const session = view === null ? null : (view.session ?? view.run);
  const runs = view === null ? [] : (view.sessions?.map((model) => model.run) ?? [view.run]);
  const runKey = runs.join(",");
  const office = state.office;
  const [outputs, setOutputs] = useState<Readonly<Record<string, string>>>({});
  /** The byte offset of each run's stored output the transcript holds up to. */
  const have = useRef(new Map<string, number>());
  const syncing = useRef(new Set<string>());
  const again = useRef(new Set<string>());
  const known = useRef<readonly string[]>(runs);
  const syncer = useRef<(run: string) => Promise<void>>(async () => {});
  known.current = runs;

  useEffect(() => {
    have.current = new Map();
    syncing.current = new Set();
    again.current = new Set();
    setOutputs({});
    if (session === null || office === null) {
      syncer.current = async () => {};
      return;
    }
    const live = { cancelled: false };
    const append = (run: string, text: string) =>
      setOutputs((shown) => ({ ...shown, [run]: (shown[run] ?? "") + text }));
    const sync = async (run: string): Promise<void> => {
      if (syncing.current.has(run)) {
        again.current.add(run);
        return;
      }
      syncing.current.add(run);
      try {
        do {
          again.current.delete(run);
          for (;;) {
            const from = have.current.get(run) ?? 0;
            const outcome = await actions.readOutput({
              office,
              run: run as RunId,
              source: "worker",
              from,
            });
            if (live.cancelled || !outcome.ok || outcome.result.to <= from) break;
            have.current.set(run, outcome.result.to);
            append(run, outcome.result.text);
          }
        } while (again.current.has(run) && !live.cancelled);
      } finally {
        syncing.current.delete(run);
      }
    };
    syncer.current = sync;
    const stop = store.onPlanningOutput((chunk) => {
      const held = have.current.get(chunk.run) ?? 0;
      if (!known.current.includes(chunk.run) || live.cancelled || chunk.to <= held) return;
      if (!syncing.current.has(chunk.run) && continues(held, chunk.from, chunk.to)) {
        // Whole characters only: bytes already shown are cut off the front.
        const skip = held - chunk.from;
        have.current.set(chunk.run, chunk.to);
        append(
          chunk.run,
          skip === 0 ? chunk.text : decoder.decode(encoder.encode(chunk.text).subarray(skip)),
        );
        return;
      }
      void sync(chunk.run);
    });
    return () => {
      live.cancelled = true;
      stop();
    };
  }, [session, office, store, actions, state.snapshots]);

  // Each model session of the session is read once it is listed: a fresh one starts mid-session.
  useEffect(() => {
    for (const run of runKey === "" ? [] : runKey.split(",")) void syncer.current(run);
  }, [runKey, session, office, state.snapshots]);

  return useMemo(() => (view === null ? [] : conversationParts(view, outputs)), [view, outputs]);
}

/** Sends one command of the planning view; `done` gets its result. */
type Send = (
  which: Sending,
  command: string,
  commandArgs: Record<string, unknown>,
  done: (result: unknown) => void,
) => void;

interface CardKeys {
  readonly focused: number | null;
  readonly editing: number | null;
  /** Handles a key of the cards; false when it is not one of theirs. */
  onKey(input: string, key: Key): boolean;
  /** Sends the form in the input as `planning.edit`. */
  saveEdit(): void;
}

/** What the card keys need of the input. */
interface CardInput {
  readonly draft: string;
  readonly setDraft: (draft: string) => void;
  readonly send: Send;
  readonly sending: boolean;
}

/** The stories a confirm's result names, as words. */
function filedWords(result: unknown): string {
  const stories = (result as { stories?: unknown } | null)?.stories;
  return Array.isArray(stories) && stories.length > 0 ? `: ${stories.join(", ")}` : "";
}

/**
 * Pure: the stories the session filed or edited that stayed Refined, each with the gate's first
 * message (DIPO-497). The lane's gate line of a story that stayed Refined reads `<ID> is Refined:
 * <messages>`, and its messages are joined with `; `.
 */
export function stayedRefined(view: PlanningView): StayedRefined[] {
  const marker = " is Refined: ";
  return (view.proposals ?? []).flatMap((item) =>
    (item.gate ?? []).flatMap((line): StayedRefined[] => {
      const at = line.indexOf(marker);
      if (at < 0) return [];
      const message = line.slice(at + marker.length).split("; ")[0] ?? "";
      return [{ story: line.slice(0, at), message }];
    }),
  );
}

/** The text that asks to end the session; it is typed in the input, with no key of its own. */
const END_COMMAND = "/end";

type CardKey = "up" | "down" | "leave" | "tab" | "confirm" | "decline" | "edit" | "ignore" | "type";

/**
 * What a key does while a card has focus: a card key, Esc, Tab (the view's), nothing (Ctrl keys,
 * Enter and the other keys that are not text), or text, which goes back to the input.
 */
function cardKey(text: string, key: Key): CardKey {
  if (key.upArrow) return "up";
  if (key.downArrow) return "down";
  if (key.escape) return "leave";
  if (key.tab) return "tab";
  if (key.ctrl || key.meta || text.length === 0 || text.charCodeAt(0) < 32) return "ignore";
  if (text === "c") return "confirm";
  if (text === "x") return "decline";
  return text === "e" ? "edit" : "type";
}

/**
 * The card keys (DIPO-450, DIPO-487): Up on an empty input moves focus into the cards, Up and Down
 * move between them, `c` confirms, `x` declines and `e` edits in the input; Esc, or any other
 * printable key, gives focus back to the input. Ctrl keys do nothing.
 */
function useCards(args: PlanningArgs, input: CardInput, dialogOpen: () => boolean): CardKeys {
  const cards = (args.state.planning?.proposals ?? []).filter(decidable);
  const [focus, setFocus] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [kept, setKept] = useState("");
  const focused = cards.some((card) => card.n === focus) ? focus : null;

  const chosen = cards.find((card) => card.n === focused);
  const stopEdit = () => {
    setEditing(null);
    input.setDraft(kept);
  };
  const decide = (command: "planning.confirm" | "planning.decline") => {
    if (chosen === undefined || input.sending || args.refusedOffline()) return;
    const at = cards.indexOf(chosen);
    setFocus((cards[at + 1] ?? cards[at - 1])?.n ?? null);
    input.send("proposal", command, { proposal: chosen.n }, (result) =>
      args.setMessage(
        command === "planning.confirm"
          ? `proposal ${chosen.n} confirmed${filedWords(result)}`
          : `proposal ${chosen.n} declined`,
      ),
    );
  };
  const startEdit = () => {
    if (chosen === undefined) return;
    setKept(input.draft);
    setFocus(null);
    setEditing(chosen.n);
    input.setDraft(proposalForm(chosen.proposal));
  };
  const saveEdit = () => {
    const original = (args.state.planning?.proposals ?? []).find((p) => p.n === editing);
    if (original === undefined) {
      stopEdit();
      return;
    }
    const read = readProposalForm(original.proposal, input.draft);
    if (!read.ok) {
      args.setMessage(read.error);
      return;
    }
    if (args.refusedOffline()) return;
    input.send("proposal", "planning.edit", { proposal: original.n, edited: read.proposal }, () => {
      args.setMessage(`proposal ${original.n} edited`);
      stopEdit();
    });
  };
  const onKey = (text: string, key: Key): boolean => {
    if (dialogOpen()) return false;
    if (editing !== null) {
      if (!key.escape) return false;
      args.setMessage("the edit was not sent");
      stopEdit();
      return true;
    }
    if (focused === null) {
      if (!key.upArrow || input.draft !== "" || cards.length === 0) return false;
      setFocus(cards.at(-1)?.n ?? null);
      return true;
    }
    const act = cardKey(text, key);
    if (act === "type") setFocus(null);
    else if (act === "up" || act === "down")
      setFocus(stepFocus(cards, focused, act === "up" ? -1 : 1));
    else if (act === "leave") setFocus(null);
    else if (act === "confirm") decide("planning.confirm");
    else if (act === "decline") decide("planning.decline");
    else if (act === "edit") startEdit();
    return act !== "type" && act !== "tab";
  };
  return { focused, editing, onKey, saveEdit };
}

/**
 * The dialog of the oldest unanswered question block (DIPO-455): its state is the maintainer's
 * choices so far, kept until the block is answered or left with Esc. Its keys come before the
 * input's; a key the dialog does not own goes on to the rest of the view.
 */
function useQuestions(
  args: PlanningArgs,
  send: Send,
  sending: boolean,
  editing: number | null,
): { dialog: Planning["dialog"]; onKey(input: string, key: Key): boolean } {
  const blocks = args.state.planning?.questions ?? [];
  const [left, setLeft] = useState<number[]>([]);
  const block = blocks.find((candidate) => !left.includes(candidate.n)) ?? null;
  const [state, setState] = useState<DialogState | null>(null);
  const number = block?.n ?? null;

  // A new block starts a new dialog.
  useEffect(() => {
    setState(block === null ? null : freshDialog(block));
  }, [number]);

  const open = block !== null && state !== null && editing === null;
  const onKey = (input: string, key: Key): boolean => {
    if (!open) return false;
    const step = dialogKey(block, state, input, key);
    if (step === null) return false;
    setState(step.state);
    if (step.message !== undefined) args.setMessage(step.message);
    if (step.action === "dismiss") {
      setLeft((numbers) => [...numbers, block.n]);
      args.setMessage("the questions stay unanswered; write a message instead");
    } else if (step.action === "send" && !sending && !args.refusedOffline()) {
      send(
        "answer",
        "planning.answer",
        { block: block.n, answers: dialogAnswers(step.state) },
        () => args.setMessage("answers sent"),
      );
    }
    return true;
  };
  return { dialog: open ? { block, state } : null, onKey };
}

/** A new office or session closes the end prompt of the old one; another office has its own draft. */
function useResets(
  run: string | null,
  office: string | null,
  setEnding: (ending: EndStep | null) => void,
  setDraft: (draft: string) => void,
): void {
  useEffect(() => setEnding(null), [run, office]);
  useEffect(() => setDraft(""), [office]);
}

/**
 * The keys of the end question (DIPO-487, DIPO-497): it takes every key while it is open. `Y`
 * ends the session, and when stories stayed Refined the list stays up until a key is pressed;
 * any other key keeps the session open.
 */
function useEnd(
  args: PlanningArgs,
  send: Send,
  sending: boolean,
  ending: EndStep | null,
  setEnding: (ending: EndStep | null) => void,
): (input: string, key: Key) => void {
  const end = () => {
    if (sending || args.refusedOffline()) return;
    const stayed = args.state.planning === null ? [] : stayedRefined(args.state.planning);
    send("end", "planning.end", {}, () => {
      args.setMessage("planning session ended");
      setEnding(stayed.length === 0 ? null : { stayed });
    });
  };
  return (input) => {
    if (ending === null) return;
    if (ending.stayed !== null) setEnding(null);
    else if (input === "y" || input === "Y") end();
    else {
      args.setMessage("the session stays open");
      setEnding(null);
    }
  };
}

/**
 * The folds of the conversation (DIPO-486): the one under the focus bar and the ones open. Tab
 * walks the folds and Shift+Tab walks back, past the last the focus is off; Enter on an empty
 * input opens the focused fold and shuts it again. A new session starts with every fold shut.
 */
function useFolds(transcript: Transcript, session: string | null, office: string | null) {
  const [focus, setFocus] = useState<number | null>(null);
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const folds = foldCount(transcript);
  useEffect(() => {
    setFocus(null);
    setOpen(new Set());
  }, [session, office]);
  return {
    focus,
    open,
    move: (step: number) => {
      if (folds === 0) return;
      setFocus((at) => {
        const next = at === null ? (step > 0 ? 0 : folds - 1) : at + step;
        return next < 0 || next >= folds ? null : next;
      });
    },
    toggle: () => {
      if (focus === null) return;
      setOpen((held) => {
        const next = new Set(held);
        if (!next.delete(focus)) next.add(focus);
        return next;
      });
    },
  };
}

/** The planning view's state; always mounted, so an open draft survives a visit to another mode. */
export function usePlanning(args: PlanningArgs): Planning {
  const { state } = args;
  const view = state.planning;
  const office = state.office;
  const session = view === null ? null : (view.session ?? view.run);
  const [draft, setDraft] = useState("");
  const [kindIndex, setKindIndex] = useState(0);
  const [sending, setSending] = useState<Sending | null>(null);
  const [rail, setRail] = useState(false);
  const [ending, setEnding] = useState<EndStep | null>(null);
  const transcript = useTranscript(args);
  const fold = useFolds(transcript, session, office);
  useResets(session, office, setEnding, setDraft);
  const kind = PLANNING_KINDS[kindIndex] ?? PLANNING_KINDS[0];
  const send: Send = (which, command, commandArgs, done) =>
    sendCommand(args, setSending, which, { command, args: commandArgs }, done);
  const cards = useCards(
    args,
    { draft, setDraft, send, sending: sending !== null },
    () => questions.dialog !== null,
  );
  const questions = useQuestions(args, send, sending !== null, cards.editing);
  const endKey = useEnd(args, send, sending !== null, ending, setEnding);

  const submit = () => {
    const text = draft.trim();
    if (sending !== null) return;
    if (cards.editing !== null) {
      cards.saveEdit();
      return;
    }
    if (text === "") {
      args.setMessage(view === null ? "write the goal first" : "write a message first");
      return;
    }
    if (view !== null && text === END_COMMAND) {
      setDraft("");
      setEnding({ stayed: null });
      return;
    }
    if (args.refusedOffline()) return;
    if (view === null) {
      send("start", "planning.start", { kind, goal: text }, () => setDraft(""));
      return;
    }
    send("message", "planning.message", { text }, () => setDraft(""));
  };

  const onKey = (input: string, key: Key) => {
    if (ending !== null) {
      endKey(input, key);
      return;
    }
    if (questions.onKey(input, key)) return;
    if (cards.onKey(input, key)) return;
    if (key.tab) {
      if (view === null) setKindIndex((index) => (index + 1) % PLANNING_KINDS.length);
      else if (key.shift) fold.move(1);
      else setRail((open) => !open);
      return;
    }
    const event = composerKey(draft, input, key);
    if (event.kind === "cancel") {
      // The session keeps running.
      args.setMessage(null);
      args.leave();
    } else if (event.kind === "send" && fold.focus !== null && draft.trim() === "") {
      fold.toggle();
    } else if (event.kind === "send") submit();
    else if (event.kind === "edit") setDraft(event.draft);
  };

  return {
    view,
    kind,
    draft,
    transcript,
    sending,
    ending,
    focus: fold.focus,
    open: fold.open,
    focused: cards.focused,
    editing: cards.editing,
    rail,
    dialog: questions.dialog,
    discuss: (text) => {
      setDraft(text);
      args.open();
    },
    onKey,
  };
}

/** The usage line of the session: its spend so far, as the model proxy counted it. */
export function spendLine(view: PlanningView, dot: string): string {
  const usage = view.usage;
  return [
    `spend: in ${usageTokens(usage.inputTokens)}`,
    `out ${usageTokens(usage.outputTokens)}`,
    `cache write ${usageTokens(usage.cacheCreateTokens)}`,
    `cache read ${usageTokens(usage.cacheReadTokens)}`,
  ].join(` ${dot} `);
}

/** The lines above the transcript: the session's kind, goal, state and spend, and the notice. */
export function headLines(view: PlanningView, columns: number, display: Display): string[] {
  const { dot, ellipsis } = glyphs(display.ascii);
  const state =
    view.state === "ended" && view.ended === "context-full"
      ? "continuing"
      : view.health === undefined
        ? view.state
        : `${view.state} ${healthLabel(view.health)}`;
  const lines = [
    `Planning ${dot} ${view.kind} ${dot} ${state} ${dot} ${view.turns} ${view.turns === 1 ? "answer" : "answers"} ${dot} ${view.model}`,
    `goal: ${truncate(view.goal.replace(/\s+/g, " "), Math.max(10, columns - 8), ellipsis)}`,
    spendLine(view, dot),
  ];
  return lines;
}

/** Pure: the line of the latest refused proposal block and its problems; none without one. */
export function refusalLines(view: PlanningView, columns: number, display: Display): string[] {
  const latest = view.refusals?.at(-1);
  if (latest === undefined) return [];
  const { ellipsis } = glyphs(display.ascii);
  return [
    truncate(
      `refused a proposal at ${clockTime(Date.parse(latest.at))}: ${latest.problems.join("; ")}`,
      Math.max(10, columns - 4),
      ellipsis,
    ),
  ];
}

<<<<<<< 515b56b7b1e5b5210ec423daf39d50c0b5e28000
/** A proposal's title and proposed tier: what a card and the end list call it. */
=======
/** A proposal's title and proposed tier and role: what a card and the Ready step call it. */
>>>>>>> 356ae81852ad4b08a1cfa01a437e87658169ce39
function proposalHead(proposal: PlanningProposalView["proposal"]): {
  title: string;
  tier?: string;
} {
  switch (proposal.kind) {
    case "story":
    case "refine":
      return { title: proposal.title, tier: `${proposal.tier} · ${proposal.role}` };
    case "edit":
      return {
        title: `edit ${proposal.id}${proposal.title === undefined ? "" : `: ${proposal.title}`}`,
      };
    case "split":
      return {
        title: `split ${proposal.id} + ${proposal.story.title}`,
        tier: `${proposal.story.tier} · ${proposal.story.role}`,
      };
    case "drop":
      return { title: `drop ${proposal.draft}` };
    default:
      return { title: String((proposal as { kind?: unknown }).kind ?? "proposal") };
  }
}

/** A card's second line: the story line of a story, else why it is proposed. */
function firstLine(proposal: PlanningProposalView["proposal"]): string {
  const line =
    (proposal.kind === "story" || proposal.kind === "refine") && proposal.storyLine !== undefined
      ? proposal.storyLine
      : proposal.why;
  return line.replace(/\s+/g, " ");
}

/** One row of the view: its text, and the role it is painted in. */
export interface Row {
  readonly text: string;
  readonly role?: Role;
  readonly bold?: boolean;
}

/** The rows of one block of the conversation, kept together when the view is short of room. */
interface Block {
  readonly rows: readonly Row[];
  readonly focused?: boolean;
}

/** Pure: what a confirmed proposal's line says: where it waits while filing, then where it was filed. */
function filingWords(
  item: PlanningProposalView,
  lane: LaneProgress | null,
  ellipsis: string,
): string {
  if (item.state === "filing") {
    return `filing${ellipsis}${lane === null ? "" : ` waiting for ${waitsOn(lane)}`}`;
  }
  const ids = item.stories ?? [];
  return `filed${ids.length === 0 ? "" : ` as ${ids.join(", ")}`}`;
}

/**
 * Pure: what the conversation shows of the proposals (DIPO-487): a line for each confirmed one,
 * `filing…` (with the backlog PR it waits on and its CI, from the lane's progress, DIPO-481) and then `filed as DIPO-n`, a card for each one that still needs a decision, and
 * nothing for a declined one. The focused card shows its keys.
 */
export function proposalBlocks(
  view: PlanningView,
  focused: number | null,
  columns: number,
  display: Display,
  lane: LaneProgress | null = null,
): Block[] {
  const { ellipsis, bar, failed, met } = glyphs(display.ascii);
  const width = Math.max(10, columns - 4);
  const lines: Block[] = [];
  const cards: Block[] = [];
  for (const item of view.proposals ?? []) {
    const { title, tier } = proposalHead(item.proposal);
    const named = `${title}${tier === undefined ? "" : ` · ${tier}`}`;
    if (item.state === "filing" || item.state === "filed") {
      const said = filingWords(item, lane, ellipsis);
      lines.push({
        rows: [
          {
            text: truncate(
              `  ${item.state === "filed" ? met : " "} ${said} · ${title}`,
              width,
              ellipsis,
            ),
            role: item.state === "filed" ? "ok" : "dim",
          },
          // What the Ready gate decided as each story was filed: Ready, or Refined and why (DIPO-495).
          ...(item.gate ?? []).map((line): Row => ({
            text: truncate(`    ${line}`, width, ellipsis),
            role: "dim",
          })),
        ],
      });
    } else if (decidable(item)) {
      const isFocused = item.n === focused;
      const rows: Row[] = [
        {
          text: truncate(
            `${isFocused ? bar : " "} ${item.state === "failed" ? failed : display.ascii ? "#" : "◆"} ${named}`,
            width,
            ellipsis,
          ),
          role: isFocused ? "hi" : "fg",
          bold: isFocused,
        },
        { text: truncate(`    ${firstLine(item.proposal)}`, width, ellipsis), role: "dim" },
      ];
      if (item.state === "failed") {
        rows.push({
          text: truncate(`    failed: ${item.detail ?? "not filed"}`, width, ellipsis),
          role: "err",
        });
      }
      if (isFocused) {
        rows.push({ text: "    c confirm   e edit   x decline   esc to the input", role: "acc" });
      }
      cards.push({ rows, focused: isFocused });
    }
  }
  return [...lines, ...cards];
}

/** Pure: the stories fold-out (Tab): the plan's proposals with their state, and what the end will offer. */
export function railRows(view: PlanningView, columns: number, display: Display): Row[] {
  const { ellipsis, met, failed, dot } = glyphs(display.ascii);
  const width = Math.max(10, columns - 4);
  const rows: Row[] = [{ text: "IN THIS PLAN", role: "dim" }];
  const proposals = view.proposals ?? [];
  if (proposals.length === 0) rows.push({ text: "  no proposal yet", role: "dim" });
  for (const item of proposals) {
    const { title } = proposalHead(item.proposal);
    const mark =
      item.state === "filed"
        ? met
        : item.state === "failed"
          ? failed
          : item.state === "open"
            ? display.ascii
              ? "#"
              : "◆"
            : dot;
    const ids = item.stories ?? [];
    rows.push({
      text: truncate(
        `  ${mark} ${ids.length === 0 ? "" : `${ids.join(", ")} `}${title} ${dot} ${item.state}`,
        width,
        ellipsis,
      ),
      role: item.state === "filed" ? "ok" : item.state === "declined" ? "dim" : "fg",
    });
  }
  const left = stayedRefined(view).length;
  rows.push(
    { text: "ON END", role: "dim" },
    {
      text:
        left === 0
          ? "  nothing stayed Refined; /end ends the session"
          : `  ${left} stayed Refined ${dot} /end lists them`,
    },
  );
  return rows;
}

/** Pure: the end question, or once ended the stories that stayed Refined (DIPO-497). */
export function endRows(step: EndStep, columns: number, display: Display): Row[] {
  const { ellipsis, dot } = glyphs(display.ascii);
  const width = Math.max(10, columns - 4);
  if (step.stayed === null) return [{ text: "End the planning session? [y/N]" }];
  const count = step.stayed.length;
  return [
    {
      text: `Ended ${dot} ${count === 1 ? "1 story stayed" : `${count} stories stayed`} Refined`,
      role: "acc",
      bold: true,
    },
    ...step.stayed.flatMap(({ story, message }): Row[] => [
      { text: truncate(`  ${story} stays Refined: ${message}`, width, ellipsis), role: "err" },
      {
        text: truncate(
          `    set it Ready later: space and Y in the Queue, or dipo ready ${story}`,
          width,
          ellipsis,
        ),
        role: "dim",
      },
    ]),
  ];
}
/** The last `room` rows of the conversation; a focused fold above them pulls the window up to it. */
function conversationRows(planning: Planning, columns: number, display: Display, room: number) {
  const { dot, ellipsis, bar, live } = glyphs(display.ascii);
  const all = transcriptRows(planning.transcript, Math.max(10, columns - 2), {
    dot,
    ellipsis,
    rule: display.ascii ? "-" : "─",
    bar,
    bullet: live,
    open: planning.open,
    focus: planning.focus,
  });
  const focused = all.findIndex((row) => planning.focus !== null && row.fold === planning.focus);
  const start = Math.min(Math.max(0, all.length - room), focused < 0 ? Infinity : focused);
  return all.slice(start, start + room);
}

export interface PlanningModeProps {
  readonly planning: Planning;
  readonly display: Display;
  readonly columns: number;
  /** Rows for the view, from its first line to the end of the input. */
  readonly height: number;
  /** The planning lane's open changes and the backlog PR they wait on (DIPO-481); null when none. */
  readonly lane: LaneProgress | null;
}

/** Drops the blocks that fit least, never the focused one, until the rows fit `max`. */
function fitBlocks(blocks: readonly Block[], max: number): Row[] {
  const kept = [...blocks];
  const count = () => kept.reduce((sum, block) => sum + block.rows.length, 0);
  while (kept.length > 1 && count() > max) {
    const drop = kept.findIndex((block) => block.focused !== true);
    if (drop < 0) break;
    kept.splice(drop, 1);
  }
  return kept.flatMap((block) => block.rows);
}

/** The answers of the session, or why there are none yet. */
function Answers(props: {
  view: PlanningView;
  rows: readonly TranscriptRow[];
  ellipsis: string;
  display: Display;
}) {
  const { view, rows, ellipsis, display } = props;
  if (rows.length === 0) {
    const none =
      view.state === "waiting" ? " no answers yet" : ` waiting for the answer${ellipsis}`;
    return <Text wrap="truncate-end">{none}</Text>;
  }
  return (
    <>
      {rows.map((row, i) => (
        <SpanLine key={`row:${i}`} spans={[{ text: " " }, ...row.spans]} display={display} />
      ))}
    </>
  );
}

/** The lines above the conversation: the session's head, or the form that starts one. */
function viewHead(planning: Planning, columns: number, display: Display): string[] {
  const { view } = planning;
  if (view !== null)
    return [...headLines(view, columns, display), ...refusalLines(view, columns, display)];
  return [
    "Planning: no open planning session",
    `kind: ${PLANNING_KINDS.map((kind) => (kind === planning.kind ? `[${kind}]` : kind)).join("  ")}`,
    "goal (what do you want to plan?):",
  ];
}

/** The planning mode's body: one conversation column and one input at the foot. */
export function PlanningMode(props: PlanningModeProps) {
  const { planning, display, columns } = props;
  const { view } = planning;
  const rule = (display.ascii ? "-" : "─").repeat(Math.max(1, columns - 2));
  const head = viewHead(planning, columns, display);
  const inputRows = planning.editing === null ? COMPOSER_ROWS : FORM_ROWS;
  const step =
    view !== null && planning.ending !== null ? endRows(planning.ending, columns, display) : null;
  const dialog =
    planning.dialog === null
      ? null
      : dialogRows(planning.dialog.block, planning.dialog.state, columns, display);
  const inputLength = dialog?.length ?? composerRows(planning.draft, columns, inputRows).length;
  const foot = step?.length ?? inputLength + (planning.editing === null ? 0 : 1);
  const extra: Row[] = view === null || !planning.rail ? [] : railRows(view, columns, display);
  const blocks =
    view === null ? [] : proposalBlocks(view, planning.focused, columns, display, props.lane);
  const space = Math.max(1, props.height - head.length - foot - 2);
  const cards = fitBlocks(blocks, Math.max(1, space - extra.length - 1));
  const room = Math.max(0, space - cards.length - extra.length);
  const rows = view === null ? [] : conversationRows(planning, columns, display, room);
  const line = (row: Row, key: string) => (
    <Colored
      key={key}
      display={display}
      role={row.role}
      {...(row.bold === true ? { bold: true } : {})}
      wrap="truncate-end"
    >
      {` ${row.text}`}
    </Colored>
  );
  return (
    <Box flexDirection="column" height={props.height}>
      {head.map((text, i) => (
        <Text key={`head:${i}`} wrap="truncate-end">{` ${text}`}</Text>
      ))}
      <Text wrap="truncate-end">{` ${rule}`}</Text>
      {view === null ? null : (
        <Answers
          view={view}
          rows={rows}
          ellipsis={glyphs(display.ascii).ellipsis}
          display={display}
        />
      )}
      {cards.map((row, i) => line(row, `card:${i}`))}
      {extra.map((row, i) => line(row, `extra:${i}`))}
      <Box flexGrow={1} />
      {view !== null && step !== null ? (
        step.map((row, i) => line(row, `step:${i}`))
      ) : (
        <>
          {planning.editing === null ? null : (
            <Text wrap="truncate-end">{` editing proposal ${planning.editing}:`}</Text>
          )}
          {dialog === null ? (
            <Composer draft={planning.draft} columns={columns} rows={inputRows} />
          ) : (
            dialog.map((spans, i) => (
              <SpanLine key={`dialog:${i}`} spans={[{ text: " " }, ...spans]} display={display} />
            ))
          )}
        </>
      )}
    </Box>
  );
}

/** The keys the end question takes: its question, or the stories that stayed Refined (DIPO-497). */
export function endingKind(planning: Planning): "ask" | "listed" | null {
  const { ending } = planning;
  if (ending === null) return null;
  return ending.stayed === null ? "ask" : "listed";
}
