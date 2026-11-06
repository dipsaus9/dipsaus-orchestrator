// The planning view (DIPO-449, 0009, 0008): its own mode, opened with `5` from home. Without an open
// planning session it asks for a kind (`Tab` changes it) and a goal and starts one with
// `planning.start`; with one it shows the session's kind, goal, state and live spend, the answers as
// they stream in (`planning.output`), and the multi-line input for the next message
// (`planning.message`). The session is the engine's view (`OfficeStoreState.planning`, from the
// snapshot and the office stream), so a TUI that opens later shows the open session again and its
// stored answers, read with `work.outputRange`; a session that continued in a fresh model session
// says so (DIPO-448).
//
// The input: Enter adds a line, Ctrl-S sends (the one documented key), Backspace erases, a paste
// keeps its line breaks. Ctrl-E ends the session after a yes (`planning.end`). Esc goes back to home
// and leaves the session running. The maintainer's own messages show in the transcript of this
// run of the TUI only; the engine stores the answers.
//
// Proposals (DIPO-450): the session's proposals show above the transcript, each with its number,
// proposed tier, title and state, and one line of why; the latest refused block shows its problems.
// Up and Down select a proposal; Ctrl-Y confirms it (`planning.confirm`), Ctrl-D declines it
// (`planning.decline`) and Ctrl-R puts it into the input as a form (`proposal-form.ts`) that Ctrl-S
// sends as `planning.edit`, and Esc leaves unsent.
//
// The final confirm (DIPO-451): Ctrl-G puts the session's filed stories into the input, one per
// line; the lines the maintainer keeps are the stories that go Ready, and Ctrl-S sends them as
// `planning.ready`. Esc leaves it unsent. The stories the gate refused show below the proposals
// with the gate's messages, and the stories set Ready with their state.

import {
  healthLabel,
  type OfficeStore,
  type OfficeStoreState,
  usageTokens,
} from "@dipsaus-orchestrator/client";
import {
  PLANNING_KINDS,
  type PlanningProposalView,
  type PlanningReadyView,
  type PlanningView,
  type RunId,
} from "@dipsaus-orchestrator/contract";
import { Box, type Key, Text } from "ink";
import { useEffect, useRef, useState } from "react";

import type { TuiActions } from "./app";
import { COMPOSER_ROWS, Composer, composerKey, composerRows } from "./composer";
import { truncate } from "./format";
import type { Display } from "./options";
import { splitLines, wrapLines } from "./output";
import { proposalForm, readProposalForm } from "./proposal-form";
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
}

export interface Planning {
  readonly view: PlanningView | null;
  readonly kind: string;
  readonly draft: string;
  readonly transcript: string;
  /** What is under way: a start, a message or an end; null otherwise. */
  readonly sending: Sending | null;
  readonly confirmingEnd: boolean;
  /** The number of the selected proposal, or null without one (DIPO-450). */
  readonly selected: number | null;
  /** The number of the proposal whose form the input holds, or null. */
  readonly editing: number | null;
  /** True while the input holds the list of stories to set Ready (DIPO-451). */
  readonly readying: boolean;
  onKey(input: string, key: Key): void;
}

/** The proposals a decision applies to: open ones, and those the lane could not file. */
const decidable = (proposal: PlanningProposalView) =>
  proposal.state === "open" || proposal.state === "failed";

/** The selected proposal after `step` from `selected`, among the view's proposals. */
function stepSelection(
  proposals: readonly PlanningProposalView[],
  selected: number | null,
  step: number,
): number | null {
  if (proposals.length === 0) return null;
  const at = proposals.findIndex((proposal) => proposal.n === selected);
  const from = at < 0 ? proposals.length - 1 : at + step;
  return proposals[Math.max(0, Math.min(proposals.length - 1, from))]?.n ?? null;
}

/** Appends `chunk` to what is shown when it continues it; true when it did. */
function continues(have: number, from: number, to: number): boolean {
  return from <= have && to > have;
}

type Sending = "start" | "message" | "end" | "proposal";

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
 * The session's answers as text: the stored output read from the start, then every
 * `planning.output` that continues it; a gap is read again. Starts over for a new office or
 * session. `local` adds text only this TUI knows, the maintainer's own messages.
 */
function useTranscript(args: PlanningArgs): { transcript: string; local: (text: string) => void } {
  const { store, actions, state } = args;
  const run = state.planning?.run ?? null;
  const office = state.office;
  const [transcript, setTranscript] = useState("");
  /** The byte offset of the stored output the transcript holds up to. */
  const have = useRef(0);
  const syncing = useRef(false);
  const again = useRef(false);

  useEffect(() => {
    have.current = 0;
    setTranscript("");
    if (run === null || office === null) return;
    const live = { cancelled: false };
    const append = (text: string) => setTranscript((shown) => shown + text);
    const sync = async (): Promise<void> => {
      if (syncing.current) {
        again.current = true;
        return;
      }
      syncing.current = true;
      try {
        do {
          again.current = false;
          for (;;) {
            const outcome = await actions.readOutput({
              office,
              run: run as RunId,
              source: "worker",
              from: have.current,
            });
            if (live.cancelled || !outcome.ok || outcome.result.to <= have.current) break;
            have.current = outcome.result.to;
            append(outcome.result.text);
          }
        } while (again.current && !live.cancelled);
      } finally {
        syncing.current = false;
      }
    };
    const stop = store.onPlanningOutput((chunk) => {
      if (chunk.run !== run || live.cancelled || chunk.to <= have.current) return;
      if (!syncing.current && continues(have.current, chunk.from, chunk.to)) {
        // Whole characters only: bytes already shown are cut off the front.
        const skip = have.current - chunk.from;
        have.current = chunk.to;
        append(skip === 0 ? chunk.text : decoder.decode(encoder.encode(chunk.text).subarray(skip)));
        return;
      }
      void sync();
    });
    void sync();
    return () => {
      live.cancelled = true;
      stop();
    };
  }, [run, office, store, actions, state.snapshots]);

  const local = (text: string) =>
    setTranscript((shown) => `${shown}${shown === "" || shown.endsWith("\n") ? "" : "\n"}${text}`);
  return { transcript, local };
}

/** Sends one command of the planning view; `done` gets its result. */
type Send = (
  which: Sending,
  command: string,
  commandArgs: Record<string, unknown>,
  done: (result: unknown) => void,
) => void;

interface ProposalKeys {
  readonly selected: number | null;
  readonly editing: number | null;
  readonly readying: boolean;
  /** Sends the stories left in the input as `planning.ready`. */
  saveReady(): void;
  /** Handles a key of the proposals; false when it is not one of theirs. */
  onKey(input: string, key: Key): boolean;
  /** Sends the form in the input as `planning.edit`. */
  saveEdit(): void;
}

/** What the proposal keys need of the input. */
interface ProposalInput {
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

/** The stories a Ready confirm offers: those the session filed or edited, not set Ready yet. */
export function readyCandidates(view: PlanningView): { story: string; summary: string }[] {
  const taken = new Set(
    (view.ready ?? [])
      .filter((r) => r.state === "set" || r.state === "setting")
      .map((r) => r.story),
  );
  const found = new Map<string, string>();
  for (const item of view.proposals ?? []) {
    if (item.state !== "filed") continue;
    for (const story of item.stories ?? []) {
      if (!taken.has(story) && !found.has(story)) found.set(story, proposalSummary(item.proposal));
    }
  }
  return [...found].map(([story, summary]) => ({ story, summary }));
}

const READY_NOTE = "# Keep the stories that go Ready, one per line; Ctrl-S sends, Esc cancels.";

/** The text of the Ready form: a note, then each candidate with what it is. */
export function readyForm(candidates: readonly { story: string; summary: string }[]): string {
  return [READY_NOTE, ...candidates.map((c) => `${c.story} ${c.summary}`)].join("\n");
}

/** The story ids the lines of a Ready form keep; notes and blank lines are skipped. */
export function readReadyForm(text: string): string[] {
  const stories: string[] = [];
  for (const line of text.split("\n")) {
    const id = line.trim().split(/\s+/)[0] ?? "";
    if (id !== "" && !id.startsWith("#") && !stories.includes(id)) stories.push(id);
  }
  return stories;
}

/** The words for a Ready confirm's result. */
function readyWords(result: unknown): string {
  const r = result as { queued?: string[]; refused?: { story: string }[] } | null;
  const queued = r?.queued ?? [];
  const refused = r?.refused ?? [];
  return [
    queued.length === 0 ? "no story set Ready" : `${queued.join(", ")} set Ready`,
    ...(refused.length === 0 ? [] : [`refused: ${refused.map((x) => x.story).join(", ")}`]),
  ].join("; ");
}

/** What the Ready form does to the input around it. */
interface ReadyForm {
  /** Puts the form's `text` into the input, keeping the draft it replaces. */
  begin(text: string): void;
  /** Closes the form and restores the draft. */
  end(): void;
}

/** Opens the Ready form and sends the stories left in it as `planning.ready` (DIPO-451). */
function readyActions(
  args: PlanningArgs,
  input: ProposalInput,
  form: ReadyForm,
): { startReady(): void; saveReady(): void } {
  return {
    startReady: () => {
      const view = args.state.planning;
      const candidates = view === null ? [] : readyCandidates(view);
      if (candidates.length === 0) {
        args.setMessage("no filed story is left to set Ready");
        return;
      }
      form.begin(readyForm(candidates));
    },
    saveReady: () => {
      const stories = readReadyForm(input.draft);
      if (stories.length === 0) {
        args.setMessage("keep at least one story, or press Esc");
        return;
      }
      if (args.refusedOffline()) return;
      input.send("proposal", "planning.ready", { stories }, (result) => {
        args.setMessage(readyWords(result));
        form.end();
      });
    },
  };
}

/**
 * The proposal keys (DIPO-450): Up and Down select, Ctrl-Y confirms, Ctrl-D declines, Ctrl-R edits
 * in the input, and Esc leaves an edit unsent with the draft it replaced.
 */
function useProposals(args: PlanningArgs, input: ProposalInput): ProposalKeys {
  const proposals = args.state.planning?.proposals ?? [];
  const [selected, setSelected] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [readying, setReadying] = useState(false);
  const [kept, setKept] = useState("");
  const latest = proposals.at(-1)?.n ?? null;

  // A new proposal is selected as it arrives.
  useEffect(() => {
    setSelected(latest);
  }, [latest]);

  const chosen = proposals.find((proposal) => proposal.n === selected);
  const stopEdit = () => {
    setEditing(null);
    setReadying(false);
    input.setDraft(kept);
  };
  const { startReady, saveReady } = readyActions(args, input, {
    begin: (text) => {
      setKept(input.draft);
      setReadying(true);
      input.setDraft(text);
    },
    end: stopEdit,
  });
  const decide = (command: "planning.confirm" | "planning.decline") => {
    if (chosen === undefined || input.sending) return;
    if (!decidable(chosen)) {
      args.setMessage(`proposal ${chosen.n} is ${chosen.state}`);
      return;
    }
    if (args.refusedOffline()) return;
    input.send("proposal", command, { proposal: chosen.n }, (result) =>
      args.setMessage(
        command === "planning.confirm"
          ? `proposal ${chosen.n} confirmed${filedWords(result)}`
          : `proposal ${chosen.n} declined`,
      ),
    );
  };
  const startEdit = () => {
    if (chosen === undefined || !decidable(chosen)) return;
    setKept(input.draft);
    setEditing(chosen.n);
    input.setDraft(proposalForm(chosen.proposal));
  };
  const saveEdit = () => {
    const original = proposals.find((proposal) => proposal.n === editing);
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
    if (editing !== null || readying) {
      if (!key.escape) return false;
      args.setMessage(readying ? "nothing was set Ready" : "the edit was not sent");
      stopEdit();
      return true;
    }
    if (key.upArrow || key.downArrow) {
      setSelected(stepSelection(proposals, selected, key.upArrow ? -1 : 1));
      return true;
    }
    if (key.ctrl && text === "g" && args.state.planning !== null) {
      startReady();
      return true;
    }
    if (!key.ctrl || proposals.length === 0) return false;
    if (text === "y") decide("planning.confirm");
    else if (text === "d") decide("planning.decline");
    else if (text === "r") startEdit();
    else return false;
    return true;
  };
  return { selected, editing, readying, onKey, saveEdit, saveReady };
}

/** The planning view's state; always mounted, so an open draft survives a visit to another mode. */
export function usePlanning(args: PlanningArgs): Planning {
  const { state } = args;
  const view = state.planning;
  const office = state.office;
  const run = view?.run ?? null;
  const [draft, setDraft] = useState("");
  const [kindIndex, setKindIndex] = useState(0);
  const [sending, setSending] = useState<Sending | null>(null);
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const { transcript, local } = useTranscript(args);

  // A new office or session closes a question about ending the old one.
  useEffect(() => {
    setConfirmingEnd(false);
  }, [run, office]);

  // Another office has its own draft.
  useEffect(() => {
    setDraft("");
  }, [office]);

  const kind = PLANNING_KINDS[kindIndex] ?? PLANNING_KINDS[0];

  const send: Send = (which, command, commandArgs, done) =>
    sendCommand(args, setSending, which, { command, args: commandArgs }, done);
  const proposals = useProposals(args, { draft, setDraft, send, sending: sending !== null });

  const submit = () => {
    const text = draft.trim();
    if (sending !== null) return;
    if (proposals.readying) {
      proposals.saveReady();
      return;
    }
    if (proposals.editing !== null) {
      proposals.saveEdit();
      return;
    }
    if (text === "") {
      args.setMessage(view === null ? "write the goal first" : "write a message first");
      return;
    }
    if (args.refusedOffline()) return;
    if (view === null) {
      send("start", "planning.start", { kind, goal: text }, () => setDraft(""));
      return;
    }
    send("message", "planning.message", { text }, () => {
      setDraft("");
      const lines = splitLines(text).map((line) => `you> ${line}`);
      local(`${lines.join("\n")}\n`);
    });
  };

  const onKey = (input: string, key: Key) => {
    if (confirmingEnd) {
      setConfirmingEnd(false);
      if (input !== "y" && input !== "Y") {
        args.setMessage("the session stays open");
        return;
      }
      if (args.refusedOffline()) return;
      send("end", "planning.end", {}, () => args.setMessage("planning session ended"));
      return;
    }
    if (proposals.onKey(input, key)) return;
    if (key.ctrl && input === "e") {
      if (view !== null && sending === null) setConfirmingEnd(true);
      return;
    }
    if (key.tab) {
      if (view === null) setKindIndex((index) => (index + 1) % PLANNING_KINDS.length);
      return;
    }
    const event = composerKey(draft, input, key);
    if (event.kind === "cancel") {
      // The session keeps running.
      args.setMessage(null);
      args.leave();
    } else if (event.kind === "send") submit();
    else if (event.kind === "edit") setDraft(event.draft);
  };

  return {
    view,
    kind,
    draft,
    transcript,
    sending,
    confirmingEnd,
    selected: proposals.selected,
    editing: proposals.editing,
    readying: proposals.readying,
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
    view.health === undefined ? view.state : `${view.state} ${healthLabel(view.health)}`;
  const lines = [
    `Planning ${dot} ${view.kind} ${dot} ${state} ${dot} ${view.turns} ${view.turns === 1 ? "answer" : "answers"} ${dot} ${view.model}`,
    `goal: ${truncate(view.goal.replace(/\s+/g, " "), Math.max(10, columns - 8), ellipsis)}`,
    spendLine(view, dot),
  ];
  if (view.continuedAt !== undefined) {
    lines.push(`continued in a fresh model session at ${clockTime(Date.parse(view.continuedAt))}`);
  }
  return lines;
}

/** How many proposals the view shows at once, ending at the selected one. */
const PROPOSAL_ROWS = 3;

/** One proposal's first line after its number: what it files, with the proposed tier. */
function proposalSummary(proposal: PlanningProposalView["proposal"]): string {
  switch (proposal.kind) {
    case "story":
      return `story [${proposal.tier}] ${proposal.title}`;
    case "edit":
      return `edit ${proposal.id}${proposal.title === undefined ? "" : `: ${proposal.title}`}`;
    case "split":
      return `split ${proposal.id} + story [${proposal.story.tier}] ${proposal.story.title}`;
    default:
      return String((proposal as { kind?: unknown }).kind ?? "proposal");
  }
}

/** A proposal's state, with the stories it filed or why it failed. */
function proposalState(proposal: PlanningProposalView): string {
  const stories = proposal.stories ?? [];
  if (proposal.state === "failed") return `failed: ${proposal.detail ?? "not filed"}`;
  const edited = proposal.edited === true ? " (edited)" : "";
  return `${proposal.state}${edited}${stories.length === 0 ? "" : ` ${stories.join(", ")}`}`;
}

/**
 * Pure: the proposal rows (DIPO-450): a heading, then for each shown proposal its number, kind,
 * proposed tier, title and state, and a line of why; the selected one is marked.
 */
export function proposalLines(
  view: PlanningView,
  selected: number | null,
  columns: number,
  display: Display,
): string[] {
  const proposals = view.proposals ?? [];
  if (proposals.length === 0) return [];
  const { dot, ellipsis } = glyphs(display.ascii);
  const at = Math.max(
    0,
    proposals.findIndex((proposal) => proposal.n === selected),
  );
  const first = Math.max(0, Math.min(at - PROPOSAL_ROWS + 1, proposals.length - PROPOSAL_ROWS));
  const shown = proposals.slice(first, first + PROPOSAL_ROWS);
  const width = Math.max(10, columns - 4);
  const lines = [
    `proposals ${dot} ${proposals.length} ${dot} ${proposals.filter((p) => p.state === "open").length} open`,
  ];
  for (const proposal of shown) {
    const mark = proposal.n === selected ? glyphs(display.ascii).bar : " ";
    lines.push(
      truncate(
        `${mark} #${proposal.n} ${proposalSummary(proposal.proposal)} ${dot} ${proposalState(proposal)}`,
        width,
        ellipsis,
      ),
      truncate(`    why: ${proposal.proposal.why}`, width, ellipsis),
    );
  }
  return lines;
}

/** Pure: the stories chosen to go Ready, each with its state and the gate's messages (DIPO-451). */
export function readyLines(view: PlanningView, columns: number, display: Display): string[] {
  const chosen: readonly PlanningReadyView[] = view.ready ?? [];
  if (chosen.length === 0) return [];
  const { ellipsis } = glyphs(display.ascii);
  const width = Math.max(10, columns - 4);
  return chosen.map((item) =>
    truncate(
      `ready ${item.story}: ${item.state}${
        item.state === "refused"
          ? ` and stays as it is: ${(item.messages ?? []).join("; ")}`
          : item.detail === undefined
            ? ""
            : `: ${item.detail}`
      }`,
      width,
      ellipsis,
    ),
  );
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

export interface PlanningModeProps {
  readonly planning: Planning;
  readonly display: Display;
  readonly columns: number;
  /** Rows for the view, from its first line to the end of the input. */
  readonly height: number;
}

/** The planning mode's body. */
export function PlanningMode(props: PlanningModeProps) {
  const { planning, display, columns } = props;
  const { view } = planning;
  const rule = (display.ascii ? "-" : "─").repeat(Math.max(1, columns - 2));
  const head =
    view === null
      ? [
          "Planning: no open planning session",
          `kind: ${PLANNING_KINDS.map((kind) => (kind === planning.kind ? `[${kind}]` : kind)).join("  ")}`,
          "goal (what do you want to plan?):",
        ]
      : [...headLines(view, columns, display), ...refusalLines(view, columns, display)];
  const inputRows = planning.editing === null && !planning.readying ? COMPOSER_ROWS : FORM_ROWS;
  const input = composerRows(planning.draft, columns, inputRows);
  const confirm = planning.confirmingEnd ? ["End the planning session? [y/N]"] : [];
  // The proposals (DIPO-450) sit between the answers and the input; an edit says which it is.
  const proposals = [
    ...(view === null ? [] : proposalLines(view, planning.selected, columns, display)),
    ...(view === null ? [] : readyLines(view, columns, display)),
    ...(planning.readying ? ["setting stories Ready:"] : []),
    ...(planning.editing === null ? [] : [`editing proposal ${planning.editing}:`]),
  ];
  const room = Math.max(
    0,
    props.height - head.length - input.length - confirm.length - proposals.length - 2,
  );
  const rows =
    view === null
      ? []
      : wrapLines(splitLines(planning.transcript), Math.max(10, columns - 2)).slice(-room);
  return (
    <Box flexDirection="column">
      {head.map((line, i) => (
        <Text key={`head:${i}`} wrap="truncate-end">{` ${line}`}</Text>
      ))}
      <Text wrap="truncate-end">{` ${rule}`}</Text>
      {view === null
        ? null
        : rows.length === 0
          ? [
              <Text key="none" wrap="truncate-end">
                {view.state === "waiting"
                  ? " no answers yet"
                  : ` waiting for the answer${glyphs(display.ascii).ellipsis}`}
              </Text>,
            ]
          : rows.map((row, i) => <Text key={`row:${i}`} wrap="truncate-end">{` ${row}`}</Text>)}
      {view === null ? null : <Text wrap="truncate-end">{` ${rule}`}</Text>}
      {proposals.map((line, i) => (
        <Text key={`proposal:${i}`} wrap="truncate-end">{` ${line}`}</Text>
      ))}
      <Composer draft={planning.draft} columns={columns} rows={inputRows} />
      {confirm.map((line) => (
        <Text key="confirm">{` ${line}`}</Text>
      ))}
    </Box>
  );
}
