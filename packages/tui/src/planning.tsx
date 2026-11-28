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
  type ChatCardView,
  type Clock,
  type LaneProgress,
  PLANNING_KINDS,
  type PlanningProposalView,
  type PlanningQuestionBlock,
  type PlanningSummary,
  type PlanningView,
  type RunId,
} from "@dipsaus-orchestrator/contract";
import { Box, type Key, Text } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";

import type { TuiActions } from "./app";
import { type ChatCards, useChatCards } from "./chat-card-state";
import { cardRows, cardText } from "./chat-cards";
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
import { type Span, SpanLine } from "./spans";
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

/** The kinds the planning view's choice offers: the Roles room starts `roles` (DIPO-475). */
export const PLANNING_CHOICES = PLANNING_KINDS.filter((kind) => kind !== "roles");

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
  /** The clock the cards' result lines read the time from (DIPO-525). */
  readonly clock: Clock;
  /** Opens the existing drop or discard prompt for a story, leaving the view (DIPO-525). */
  readonly startPrompt: (action: "drop" | "discard", story: string) => boolean;
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
  /** The number of the focused chat card (DIPO-525), or null. */
  readonly focusedCard: number | null;
  /** The number of the chat card whose text the input holds (DIPO-525), or null. */
  readonly editingCard: number | null;
  /** The chat's action cards and what became of the ones sent (DIPO-525). */
  readonly chatCards: ChatCards;
  /** The number of the proposal whose form the input holds, or null. */
  readonly editing: number | null;
  /** The stories fold-out is open. */
  readonly rail: boolean;
  /** The block of questions the maintainer answers now, and the dialog's state (DIPO-455). */
  readonly dialog: { readonly block: PlanningQuestionBlock; readonly state: DialogState } | null;
  /** The Roles room's chat has the keys: a roles session is open, or its goal is being typed. */
  readonly chatting: boolean;
  /** Whether this view takes the keys in the mode `mode`: the planning view, or the Roles chat. */
  keysIn(mode: string): boolean;
  /** The Roles room's chat key: asks for the goal of a roles session (DIPO-475). */
  startRoles(): void;
  /** Opens the view with `text` in the input, as the retro's `d` does (DIPO-479). */
  discuss(text: string): void;
  onKey(input: string, key: Key): void;
}

/** The proposals a decision applies to: open ones, and those the lane could not file. */
const decidable = (proposal: PlanningProposalView) =>
  proposal.state === "open" || proposal.state === "failed";

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
  readonly focusedCard: number | null;
  readonly editing: number | null;
  readonly editingCard: number | null;
  /** Handles a key of the cards; false when it is not one of theirs. */
  onKey(input: string, key: Key): boolean;
  /** Sends the form in the input as `planning.edit`, or keeps a chat card's edited text. */
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

type CardKey =
  | "up"
  | "down"
  | "leave"
  | "tab"
  | "confirm"
  | "decline"
  | "edit"
  | "dropStory"
  | "discardStory"
  | "ignore"
  | "type";

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
  if (text === "X") return "dropStory";
  if (text === "D") return "discardStory";
  return text === "e" ? "edit" : "type";
}

/** A card with focus: a proposal that needs a decision, or one of the chat's action cards. */
interface Focus {
  readonly kind: "proposal" | "card";
  readonly n: number;
}

/** The focus `step` places after `focus` in `order`; the last one from the input. */
function stepFocus(order: readonly Focus[], focus: Focus | null, step: number): Focus | null {
  if (order.length === 0) return null;
  const at = order.findIndex((item) => item.kind === focus?.kind && item.n === focus.n);
  const from = at < 0 ? order.length - 1 : at + step;
  return order[Math.max(0, Math.min(order.length - 1, from))] ?? null;
}

/** What the card edits share with the cards' focus: setting focus on a card and leaving it. */
interface Edits {
  readonly editing: number | null;
  readonly editingCard: number | null;
  startProposal(proposal: PlanningProposalView): void;
  startCard(card: ChatCardView): void;
  save(): void;
  /** Esc: the edit is not sent. */
  cancel(): void;
}

/**
 * The edits of a card (DIPO-450, DIPO-525): a proposal's form goes to the input and Enter sends it
 * as `planning.edit`; a chat card's text goes to the input and Enter keeps it for the card's next
 * `c`. Esc leaves either unsent, and the draft the input held comes back.
 */
function useCardEdits(
  args: PlanningArgs,
  input: CardInput,
  chat: ChatCards,
  focusCard: (n: number) => void,
): Edits {
  const [editing, setEditing] = useState<number | null>(null);
  const [editingCard, setEditingCard] = useState<number | null>(null);
  const [kept, setKept] = useState("");
  const stop = () => {
    setEditing(null);
    setEditingCard(null);
    input.setDraft(kept);
  };
  const saveCard = (n: number) => {
    const text = input.draft.trim();
    if (text === "") {
      args.setMessage("the card's text is empty; write it, or Esc to keep it as it was");
      return;
    }
    chat.edit(n, text);
    args.setMessage(`card ${n} edited; c sends it`);
    focusCard(n);
    stop();
  };
  const save = () => {
    if (editingCard !== null) {
      saveCard(editingCard);
      return;
    }
    const original = (args.state.planning?.proposals ?? []).find((p) => p.n === editing);
    if (original === undefined) {
      stop();
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
      stop();
    });
  };
  return {
    editing,
    editingCard,
    startProposal: (proposal) => {
      setKept(input.draft);
      setEditing(proposal.n);
      input.setDraft(proposalForm(proposal.proposal));
    },
    startCard: (card) => {
      if (card.card.kind === "command") {
        args.setMessage("a command card is copied as it is");
        return;
      }
      setKept(input.draft);
      setEditingCard(card.n);
      input.setDraft(cardText(card.card, chat.edited.get(card.n)));
    },
    save,
    cancel: () => {
      args.setMessage("the edit was not sent");
      if (editingCard !== null) focusCard(editingCard);
      stop();
    },
  };
}

/**
 * The card keys (DIPO-450, DIPO-487, DIPO-525): Up on an empty input moves focus into the cards,
 * Up and Down move between them, `c` confirms a proposal, sends a chat card's command or copies a
 * command card's line, `x` declines a proposal or drops a chat card from view, `e` edits (a
 * proposal in a form, a chat card's text), `X` and `D` open the drop and discard prompts of the
 * story a command card names; Esc, or any other printable key, gives focus back to the input.
 * Ctrl keys do nothing.
 */
function useCards(
  args: PlanningArgs,
  input: CardInput,
  dialogOpen: () => boolean,
  chat: ChatCards,
): CardKeys {
  const cards = (args.state.planning?.proposals ?? []).filter(decidable);
  const order: Focus[] = [
    ...cards.map((card): Focus => ({ kind: "proposal", n: card.n })),
    ...chat.open.map((card): Focus => ({ kind: "card", n: card.n })),
  ];
  const [asked, setFocus] = useState<Focus | null>(null);
  const edits = useCardEdits(args, input, chat, (n) => setFocus({ kind: "card", n }));
  const focus =
    asked !== null && order.some((item) => item.kind === asked.kind && item.n === asked.n)
      ? asked
      : null;
  const focused = focus?.kind === "proposal" ? focus.n : null;
  const focusedCard = focus?.kind === "card" ? focus.n : null;

  /** The focus after the card `focus` leaves the deck: its next, else its previous. */
  const leave = (kind: Focus["kind"], n: number) => {
    const at = order.findIndex((item) => item.kind === kind && item.n === n);
    setFocus(order[at + 1] ?? order[at - 1] ?? null);
  };
  const decide = (proposal: number, command: "planning.confirm" | "planning.decline") => {
    if (input.sending || args.refusedOffline()) return;
    leave("proposal", proposal);
    input.send("proposal", command, { proposal }, (result) =>
      args.setMessage(
        command === "planning.confirm"
          ? `proposal ${proposal} confirmed${filedWords(result)}`
          : `proposal ${proposal} declined`,
      ),
    );
  };
  const onCardKey = (act: CardKey, n: number) => {
    const card = chat.views.find((item) => item.n === n);
    if (act === "confirm") {
      chat.send(n);
      if (card?.card.kind !== "command") leave("card", n);
    } else if (act === "decline") {
      chat.hide(n);
      leave("card", n);
    } else if (act === "edit" && card !== undefined) {
      if (card.card.kind !== "command") setFocus(null);
      edits.startCard(card);
    } else if (act === "dropStory" || act === "discardStory") {
      chat.startPrompt(n, act === "dropStory" ? "drop" : "discard");
    }
  };
  const onProposalKey = (act: CardKey, n: number) => {
    const proposal = cards.find((item) => item.n === n);
    if (act === "confirm") decide(n, "planning.confirm");
    else if (act === "decline") decide(n, "planning.decline");
    else if (act === "edit" && proposal !== undefined) {
      setFocus(null);
      edits.startProposal(proposal);
    }
  };
  /** A key while the card `on` has focus. */
  const onFocused = (text: string, key: Key, on: Focus): boolean => {
    const act = cardKey(text, key);
    // The drop and discard keys belong to the chat's command cards; on a proposal they type.
    const typed = act === "type" || (on.kind === "proposal" && act.endsWith("Story"));
    if (typed) setFocus(null);
    else if (act === "up" || act === "down") setFocus(stepFocus(order, on, act === "up" ? -1 : 1));
    else if (act === "leave") setFocus(null);
    else if (on.kind === "card") onCardKey(act, on.n);
    else onProposalKey(act, on.n);
    return !typed && act !== "tab";
  };
  const onKey = (text: string, key: Key): boolean => {
    if (dialogOpen()) return false;
    if (key.ctrl && text === "r" && chat.retry()) return true;
    if (edits.editing !== null || edits.editingCard !== null) {
      if (!key.escape) return false;
      edits.cancel();
      return true;
    }
    if (focus === null) {
      if (!key.upArrow || input.draft !== "" || order.length === 0) return false;
      setFocus(order.at(-1) ?? null);
      return true;
    }
    return onFocused(text, key, focus);
  };
  return {
    focused,
    focusedCard,
    editing: edits.editing,
    editingCard: edits.editingCard,
    onKey,
    saveEdit: edits.save,
  };
}

/** The chat's action cards and the keys of every card, the proposals' too (DIPO-525). */
function useCardDeck(args: PlanningArgs, input: CardInput, dialogOpen: () => boolean) {
  const chat = useChatCards(args);
  return { chat, cards: useCards(args, input, dialogOpen, chat) };
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

/** The kind of the session the form starts: the chosen one, or `roles` while the Roles chat asks for its goal. */
function useKindChoice(args: PlanningArgs) {
  const view = args.state.planning;
  const [kindIndex, setKindIndex] = useState(0);
  const [rolesGoal, setRolesGoal] = useState(false);
  const kind = rolesGoal ? "roles" : (PLANNING_CHOICES[kindIndex] ?? PLANNING_CHOICES[0] ?? "plan");
  const cycleKind = () => {
    if (!rolesGoal) setKindIndex((index) => (index + 1) % PLANNING_CHOICES.length);
  };
  const chatting = view === null ? rolesGoal : view.kind === "roles";
  const startRoles = () => {
    if (view === null) {
      if (!args.refusedOffline()) setRolesGoal(true);
    } else if (view.kind !== "roles") args.setMessage("a planning session is open: end it first");
  };
  return { kind, rolesGoal, setRolesGoal, cycleKind, chatting, startRoles };
}

/** The planning view's state; always mounted, so an open draft survives a visit to another mode. */
export function usePlanning(args: PlanningArgs): Planning {
  const { state } = args;
  const view = state.planning;
  const office = state.office;
  const session = view === null ? null : (view.session ?? view.run);
  const [draft, setDraft] = useState("");
  const { kind, setRolesGoal, cycleKind, chatting, startRoles } = useKindChoice(args);
  const [sending, setSending] = useState<Sending | null>(null);
  const [rail, setRail] = useState(false);
  const [ending, setEnding] = useState<EndStep | null>(null);
  const transcript = useTranscript(args);
  const fold = useFolds(transcript, session, office);
  useResets(session, office, setEnding, setDraft);
  const send: Send = (which, command, commandArgs, done) =>
    sendCommand(args, setSending, which, { command, args: commandArgs }, done);
  const { chat, cards } = useCardDeck(
    args,
    { draft, setDraft, send, sending: sending !== null },
    () => questions.dialog !== null,
  );
  const questions = useQuestions(args, send, sending !== null, cards.editing);
  const endKey = useEnd(args, send, sending !== null, ending, setEnding);
  const submit = () => {
    const text = draft.trim();
    if (sending !== null) return;
    if (cards.editing !== null || cards.editingCard !== null) {
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
      send("start", "planning.start", { kind, goal: text }, () => {
        setDraft("");
        setRolesGoal(false);
      });
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
      if (view === null) cycleKind();
      else if (key.shift) fold.move(1);
      else setRail((open) => !open);
      return;
    }
    const event = composerKey(draft, input, key);
    if (event.kind === "cancel") {
      // The session keeps running.
      setRolesGoal(false);
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
    focusedCard: cards.focusedCard,
    editingCard: cards.editingCard,
    chatCards: chat,
    editing: cards.editing,
    rail,
    dialog: questions.dialog,
    chatting,
    keysIn: (mode) => mode === "planning" || (mode === "roles" && chatting),
    startRoles,
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

/** A proposal's title, proposed tier and role: what a card and the end list call it. */
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
    case "role":
      return { title: `add role ${proposal.name} · ${proposal.roleKind ?? "code"}` };
    case "role-edit":
      return { title: `edit role ${proposal.name}` };
    case "role-remove":
      return { title: `remove role ${proposal.name}` };
    default:
      return { title: String((proposal as { kind?: unknown }).kind ?? "proposal") };
  }
}

/** A card's second line: the story line of a story, else why it is proposed. */
function firstLine(proposal: PlanningProposalView["proposal"]): string {
  const line =
    (proposal.kind === "story" || proposal.kind === "refine") && proposal.storyLine !== undefined
      ? proposal.storyLine
      : (proposal.kind === "role" || proposal.kind === "role-edit") &&
          proposal.purpose !== undefined
        ? proposal.purpose
        : proposal.why;
  return line.replace(/\s+/g, " ");
}

/**
 * The summaries a proposal carries, each with the part it belongs to (DIPO-505); a proposal from an
 * engine before the summary has none.
 */
function summariesOf(
  proposal: PlanningProposalView["proposal"],
): { readonly label: string; readonly summary: PlanningSummary }[] {
  switch (proposal.kind) {
    case "story":
    case "refine":
    case "edit":
      return proposal.summary === undefined ? [] : [{ label: "", summary: proposal.summary }];
    case "split":
      return [
        { label: "new story ", summary: proposal.story.summary },
        { label: "edit ", summary: proposal.edit.summary },
      ].filter((part) => part.summary !== undefined);
    default:
      return [];
  }
}

/** A card's count line: `2 not doing, 3 ADR lines, 1 risk`. */
function summaryCounts(proposal: PlanningProposalView["proposal"]): string | null {
  const all = summariesOf(proposal).map(({ summary }) => summary);
  if (all.length === 0) return null;
  const sum = (pick: (summary: PlanningSummary) => number) =>
    all.reduce((total, summary) => total + pick(summary), 0);
  const adr = sum((summary) => summary.adrLines.length);
  const risks = sum((summary) => summary.risks.length);
  return [
    `${sum((summary) => summary.notDoing.length)} not doing`,
    `${adr} ADR ${adr === 1 ? "line" : "lines"}`,
    `${risks} ${risks === 1 ? "risk" : "risks"}`,
  ].join(", ");
}

/** The rows of a focused card's summary: what it does not do, each ADR line, the risks. */
function summaryRows(
  proposal: PlanningProposalView["proposal"],
  width: number,
  ellipsis: string,
): Row[] {
  const rows: Row[] = [];
  const add = (text: string, role: Role = "fg") =>
    rows.push({ text: truncate(text, width, ellipsis), role });
  for (const { label, summary } of summariesOf(proposal)) {
    add(`    ${label}does not do:`, "dim");
    if (summary.notDoing.length === 0) add("      none");
    for (const item of summary.notDoing) add(`      - ${item}`);
    add(`    ${label}ADR lines that change:`, "dim");
    if (summary.adrLines.length === 0) add("      none");
    for (const line of summary.adrLines) {
      add(`      - ${line.file}, section ${line.section}`);
      add(`        was: ${line.quote ?? "(new line)"}`, "dim");
      add(`        becomes: ${line.becomes}`);
    }
    add(`    ${label}risks:`, "dim");
    if (summary.risks.length === 0) add("      none");
    for (const risk of summary.risks) add(`      - ${risk.kind}: ${risk.text}`);
  }
  return rows;
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
      const counts = summaryCounts(item.proposal);
      if (isFocused) rows.push(...summaryRows(item.proposal, width, ellipsis));
      else if (counts !== null)
        rows.push({ text: truncate(`    ${counts}`, width, ellipsis), role: "dim" });
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
function fitBlocks<R>(
  blocks: readonly { readonly rows: readonly R[]; readonly focused?: boolean }[],
  max: number,
): R[] {
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
  if (planning.kind === "roles") {
    return ["Roles chat: no open session", "goal (what do you want to ask about the roles?):"];
  }
  return [
    "Planning: no open planning session",
    `kind: ${PLANNING_CHOICES.map((kind) => (kind === planning.kind ? `[${kind}]` : kind)).join("  ")}`,
    "goal (what do you want to plan?):",
  ];
}

/** The chat's action cards as blocks of rows, the focused one with its keys (DIPO-525). */
function chatBlocksOf(planning: Planning, columns: number, display: Display) {
  if (planning.view === null) return [];
  const { chatCards } = planning;
  return chatCards.views.map((card) => ({
    rows: cardRows(card, {
      focused: card.n === planning.focusedCard,
      width: Math.max(10, columns - 2),
      gutter: 1,
      gutterInside: true,
      ascii: display.ascii,
      send: chatCards.sends.get(card.n),
      edited: chatCards.edited.get(card.n),
    }),
    focused: card.n === planning.focusedCard,
  }));
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
  const chatBlocks = chatBlocksOf(planning, columns, display);
  const space = Math.max(1, props.height - head.length - foot - 2);
  const cards = fitBlocks(blocks, Math.max(1, space - extra.length - 1));
  const chatRows = fitBlocks(chatBlocks, Math.max(1, space - extra.length - cards.length - 1));
  const room = Math.max(0, space - cards.length - chatRows.length - extra.length);
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
      <Colored display={display} role="faint" wrap="truncate-end">
        {` ${rule}`}
      </Colored>
      {view === null ? null : (
        <Answers
          view={view}
          rows={rows}
          ellipsis={glyphs(display.ascii).ellipsis}
          display={display}
        />
      )}
      {cards.map((row, i) => line(row, `card:${i}`))}
      {chatRows.map((spans: Span[], i) => (
        <SpanLine key={`chat:${i}`} spans={spans} display={display} />
      ))}
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
