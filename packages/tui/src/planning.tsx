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

import {
  healthLabel,
  type OfficeStore,
  type OfficeStoreState,
  usageTokens,
} from "@dipsaus-orchestrator/client";
import { PLANNING_KINDS, type PlanningView, type RunId } from "@dipsaus-orchestrator/contract";
import { Box, type Key, Text } from "ink";
import { useEffect, useRef, useState } from "react";

import type { TuiActions } from "./app";
import type { Hint } from "./footer";
import { truncate } from "./format";
import type { Display } from "./options";
import { splitLines, wrapLines } from "./output";
import { clockTime, glyphs } from "./views";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The lines of the input the view shows; the rest scrolls up out of sight. */
const INPUT_ROWS = 6;

/** The text a key adds to the draft: a paste keeps its line breaks, control characters go. */
function typed(input: string): string {
  let text = "";
  for (const char of input.replace(/\r\n?/g, "\n")) {
    if (char === "\n" || char.charCodeAt(0) >= 32) {
      if (char.charCodeAt(0) !== 127) text += char;
    }
  }
  return text;
}

/**
 * The draft after `key`, or null when the key is not an edit. Enter adds a line; the send key
 * (Ctrl-S) is not an edit.
 */
export function editDraft(draft: string, input: string, key: Key): string | null {
  if (key.return) return `${draft}\n`;
  if (key.backspace || key.delete) return draft.slice(0, -1);
  if (key.ctrl || key.meta || key.escape || key.tab) return null;
  if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return null;
  const text = typed(input);
  return text === "" ? null : draft + text;
}

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
  readonly hints: readonly Hint[];
  onKey(input: string, key: Key): void;
}

const QUIT = 100;

function planningHints(
  view: PlanningView | null,
  confirmingEnd: boolean,
  sending: boolean,
): Hint[] {
  if (confirmingEnd) {
    return [
      ["[y] end the session", QUIT],
      ["[any other key] keep it", 50],
    ];
  }
  const hints: Hint[] = [
    [view === null ? "[Ctrl-S] start" : "[Ctrl-S] send", QUIT],
    ["[Enter] new line", 90],
  ];
  if (view === null) hints.push(["[Tab] kind", 80]);
  else hints.push(["[Ctrl-E] end session", 70]);
  if (sending) hints.push(["sending", 60]);
  hints.push(["[Esc] back", 85]);
  return hints;
}

/** Appends `chunk` to what is shown when it continues it; true when it did. */
function continues(have: number, from: number, to: number): boolean {
  return from <= have && to > have;
}

type Sending = "start" | "message" | "end";

/** Sends one command; an error stays in the footer and the draft stays. */
function sendCommand(
  args: PlanningArgs,
  setSending: (sending: Sending | null) => void,
  which: Sending,
  request: { readonly command: string; readonly args: Record<string, unknown> },
  done: () => void,
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
      if (outcome.ok) done();
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

  const send = (
    which: Sending,
    command: string,
    commandArgs: Record<string, unknown>,
    done: () => void,
  ) => sendCommand(args, setSending, which, { command, args: commandArgs }, done);

  const submit = () => {
    const text = draft.trim();
    if (sending !== null) return;
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
    if (key.escape) {
      args.setMessage(null);
      args.leave();
      return;
    }
    if (key.ctrl) {
      if (input === "s") submit();
      else if (input === "e" && view !== null && sending === null) setConfirmingEnd(true);
      return;
    }
    if (key.tab) {
      if (view === null) setKindIndex((index) => (index + 1) % PLANNING_KINDS.length);
      return;
    }
    const next = editDraft(draft, input, key);
    if (next !== null) setDraft(next);
  };

  return {
    view,
    kind,
    draft,
    transcript,
    sending,
    confirmingEnd,
    hints: planningHints(view, confirmingEnd, sending !== null),
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

/** The input as rows: the last `INPUT_ROWS`, a prompt on the first, the cursor on the last. */
export function inputRows(draft: string, columns: number): string[] {
  const rows = wrapLines(
    draft.split("\n").map((line, i) => `${i === 0 ? "> " : "  "}${line}`),
    Math.max(10, columns - 2),
  );
  rows[rows.length - 1] = `${rows.at(-1) ?? "> "}_`;
  return rows.slice(-INPUT_ROWS);
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
      : headLines(view, columns, display);
  const input = inputRows(planning.draft, columns);
  const confirm = planning.confirmingEnd ? ["End the planning session? [y/N]"] : [];
  const room = Math.max(0, props.height - head.length - input.length - confirm.length - 2);
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
      {input.map((row, i) => (
        <Text key={`input:${i}`} wrap="truncate-end">{` ${row}`}</Text>
      ))}
      {confirm.map((line) => (
        <Text key="confirm">{` ${line}`}</Text>
      ))}
    </Box>
  );
}
