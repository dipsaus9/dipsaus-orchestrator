// The TUI's actions on the desk, the live agent detail, the queue and the overview (0009,
// DIPO-308). Each key of the table in `keys.ts` starts a flow: the prompts it needs, then one
// command with `origin: "tui"` and a fresh request id.
//
// - Text prompts are the Composer (DIPO-459): Enter adds a line, Ctrl-S sends, Esc cancels. The
//   answer, the park, reject and discard notes, the steer text and the resume note: required where
//   the engine's command line names `--note`, else optional and prefilled with the park's detail
//   (the failing check, the conflicted paths). A text prompt keeps its draft while offline and sends
//   nothing.
// - Which actions confirm comes from the command definitions, as in the CLI (DIPO-320,
//   `confirmSteps`): a command with `confirm` asks yes or no (reject, first); an `irreversible`
//   one, or one an `irreversibleWhen` argument makes so (drop with branch deletion), reads
//   `story.losses`, lists what is lost and asks for the story id typed out (0009 open question 4).
//   Drop reads its losses first and offers "also delete its branch" (space); that choice is its yes
//   or no, and ticking it asks for the typed id.
// - A resume with a budget (the engine's line names `--budget`, which `work.resume` declares in
//   `confirmWhen`) is the top-up prompt: +25%, +50% or +100% (←→, the choices of `dipo resume
//   --budget`) and its note (Tab). Its first Ctrl-S sends it unconfirmed, and the engine answers with
//   the caps before and after, which the prompt shows; seeing them is the confirmation, so the next
//   Ctrl-S sends it confirmed (spec.md, PARKED). A change of the top-up asks for its caps again.
// - Every other action is one key.
//
// An action is done only when the office stream passes its reply cursor (read-your-writes), when
// the store read the office again after the reply, or once the maintainer switched office. An
// error shows in the footer with the engine's message, so a prompt whose question or gate closed
// meanwhile ends with `question.closed` or the gate's code; a retryable error offers Ctrl-R, which
// sends the same request again with the same request id (0005). A reply with
// `changed: false` ends at once with "already so; nothing changed", such as a resume of a story
// that already runs.

import {
  cursorReached,
  type OfficeStore,
  type ReadyResult,
  readyLines,
  storyRef,
} from "@dipsaus-orchestrator/client";
import {
  type Cursor,
  type EngineError,
  type CommandDefinition,
  findCommand,
  type LostCommit,
  type OfficeId,
  type RequestId,
  type ResumeBudget,
  ResumeConfirmDetails,
  storyReady,
} from "@dipsaus-orchestrator/contract";
import type { Key } from "ink";
import { useEffect, useState } from "react";

import { composerKey, editDraft } from "./composer";
import { binding, type ActionId, type Hint } from "./keys";

/** One command an action sends. */
export interface CommandRequest {
  readonly office: OfficeId;
  readonly command: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly requestId: RequestId;
  /** True only after the maintainer agreed (0005). */
  readonly confirmed: boolean;
}

/** A command reply; a failure on the client side comes back as an error too. */
export type CommandOutcome =
  | {
      readonly ok: true;
      readonly result: unknown;
      readonly changed: boolean;
      readonly cursor?: Cursor;
    }
  | { readonly ok: false; readonly error: EngineError };

/** What `story.losses` answered. */
export type LossesOutcome =
  | {
      readonly ok: true;
      readonly result: { readonly commits: readonly LostCommit[] };
    }
  | { readonly ok: false; readonly error: EngineError };

export interface LossesRequest {
  readonly office: OfficeId;
  readonly story: string;
  readonly command: "work.discard" | "story.drop";
}

/** What an action is about, from the desk row, the detail's run or the queue's story. */
export interface ActionTarget {
  /** The story id, sent as the story reference. */
  readonly story?: string;
  /** The stories a `ready` action sets Ready, in the order the Queue lists them (DIPO-482). */
  readonly stories?: readonly string[];
  readonly question?: string;
  readonly gate?: string;
  /** The decision note a dismiss is about (DIPO-404). */
  readonly note?: string;
  /** The proposed story an accept or dismiss is about (DIPO-454). */
  readonly idea?: string;
  /** The command line the engine built for the action, when a desk row offered it. */
  readonly cli?: string;
  /** What the prompt names: the question's text or the permission. */
  readonly text?: string;
  /** The open test a checklist action is about (DIPO-365). */
  readonly test?: string;
  /** What a fail note or an optional resume note starts with (DIPO-365, DIPO-459). */
  readonly prefill?: string;
  /** The desk row the action was started on, so the row shows it pending (DIPO-459). */
  readonly row?: string;
}

export type Step =
  | {
      readonly kind: "text";
      readonly field: "text" | "note";
      readonly label: string;
      /** True when an empty text may be sent: an optional resume note. */
      readonly optional?: boolean;
    }
  | { readonly kind: "yesno"; readonly question: string }
  | { readonly kind: "drop" }
  | { readonly kind: "losses"; readonly command: "work.discard" | "story.drop" }
  | { readonly kind: "typed" }
  | { readonly kind: "topup"; readonly noteRequired: boolean };

/** The top-ups the resume prompt offers, as shares of the run's starting caps (`dipo resume --budget`). */
export const TOP_UPS: readonly number[] = [25, 50, 100];

interface Values {
  readonly text?: string;
  readonly note?: string;
  readonly deleteBranch?: boolean;
  readonly budget?: ResumeBudget;
  /** Set once the maintainer agreed to what `confirmWhen` asks about. */
  readonly confirmed?: boolean;
}

/** An action whose prompts are open. */
export interface Flow {
  readonly id: ActionId;
  readonly office: OfficeId;
  readonly target: ActionTarget;
  readonly label: string;
  readonly steps: readonly Step[];
  readonly at: number;
  readonly values: Values;
  /** The text typed into the current text or typed-id prompt. */
  readonly draft: string;
  /** What `story.losses` listed for a discard or a drop; null before it was read. */
  readonly losses: readonly LostCommit[] | null;
  /** The top-up prompt's caps before and after, for the share they were asked for. */
  readonly caps: { readonly share: number; readonly details: ResumeConfirmDetails } | null;
  /** The top-up prompt's field in focus. */
  readonly field: "choice" | "note";
  /** True while `story.losses` is read, or the caps of a top-up are asked for. */
  readonly reading: boolean;
}

/** One sent action, from send to done. */
export interface ActionState {
  readonly label: string;
  readonly request: CommandRequest;
  readonly status: "sending" | "syncing" | "done" | "failed";
  readonly cursor?: Cursor;
  /** The store's snapshot count when the reply arrived; a later re-read has seen the write. */
  readonly snapshots?: number;
  readonly error?: EngineError;
  /** What the reply adds to the done line, such as a test checkout. */
  readonly note?: string;
  /** The reply said `changed: false`: the state already matched, and nothing was written (0005). */
  readonly unchanged?: boolean;
  /** The verb alone, for a desk row's pending line (`accept`). */
  readonly verb: string;
  /** The desk row it was started on (`ActionTarget.row`). */
  readonly row?: string;
  /** What `story.ready` answered, for the Queue's result lines (DIPO-482). */
  readonly ready?: ReadyResult;
}

/** What a sent flow's state starts with: its label, request, verb and row. */
function sentState(sent: Flow, request: CommandRequest) {
  return {
    label: sent.label,
    request,
    verb: VERBS[sent.id],
    ...(sent.target.row === undefined ? {} : { row: sent.target.row }),
  };
}

/** The verb of each action in its label. */
const VERBS: Readonly<Record<ActionId, string>> = {
  answer: "answer",
  approve: "approve",
  reject: "reject",
  resume: "resume",
  discard: "discard",
  drop: "drop",
  ready: "set Ready",
  park: "park",
  test: "test",
  accept: "accept",
  dismiss: "dismiss",
  dismissNote: "dismiss",
  idea: "hand to the audit",
  steer: "steer",
  pass: "pass",
  fail: "fail",
  stop: "stop run",
  nextConfirm: "start",
  nextDecline: "decline",
};

/** The budget a resume's command line names: `--budget +50%` or `--budget +200000`. */
export function budgetOf(cli: string | undefined): ResumeBudget | undefined {
  const match = /--budget \+(\d+)(%?)/.exec(cli ?? "");
  if (match === null) return undefined;
  const amount = Number(match[1]);
  return match[2] === "%" ? { share: amount } : { tokens: amount };
}

function needsNote(cli: string | undefined): boolean {
  return (cli ?? "").includes("--note");
}

/** A required note's label: the placeholder of the engine's line (`<answer>`, `<direction>`). */
function noteLabel(cli: string | undefined): string {
  return /--note "<([a-z ]+)>"/.exec(cli ?? "")?.[1] ?? "note";
}

/** The share the top-up prompt has chosen now. */
export function shareChosen(flow: Flow): number {
  const budget = flow.values.budget;
  return budget !== undefined && "share" in budget ? budget.share : 50;
}

/** The share a top-up starts at: the one the engine's command line names, else +50%. */
function shareOf(cli: string | undefined): number {
  const budget = budgetOf(cli);
  return budget !== undefined && "share" in budget ? budget.share : 50;
}

/** The commands whose losses `story.losses` lists. */
const LOSS_COMMANDS: readonly LossesRequest["command"][] = ["work.discard", "story.drop"];

/** Where an action's command definition comes from; the contract's by default. */
export type DefinitionLookup = (
  name: string,
) => Pick<CommandDefinition, "confirm" | "irreversible" | "irreversibleWhen"> | undefined;

/** The yes-or-no question of an action whose command has `confirm`, where it says more. */
const QUESTIONS: Partial<Record<ActionId, (story: string) => string>> = {
  reject: (story) => `Reject the merge of ${story}? Its note goes to the worker as a fix item.`,
};

/**
 * The confirmation the command of `id` asks for with `args`, read from its definition as the CLI
 * reads it (0005, 0009): one that is `irreversible`, or that an argument in `irreversibleWhen`
 * makes so, lists what is lost and asks for the story id typed out; one with `confirm` asks yes
 * or no; any other asks nothing.
 */
export function confirmSteps(
  id: ActionId,
  story: string,
  args: Readonly<Record<string, unknown>> = {},
  lookup: DefinitionLookup = findCommand,
): Step[] {
  const command = binding(id).command;
  const definition = lookup(command);
  if (definition === undefined) return [];
  const irreversible =
    definition.irreversible ||
    (definition.irreversibleWhen ?? []).some((field) => args[field] === true);
  if (irreversible) {
    const losses = LOSS_COMMANDS.find((candidate) => candidate === command);
    return losses === undefined
      ? [{ kind: "typed" }]
      : [{ kind: "losses", command: losses }, { kind: "typed" }];
  }
  if (!definition.confirm) return [];
  return [{ kind: "yesno", question: QUESTIONS[id]?.(story) ?? `${VERBS[id]} ${story}?` }];
}

/**
 * The prompts of an action, in order: the confirmation its command's definition asks for
 * (`confirmSteps`, for every action alike) around the prompts for its arguments. A yes or no comes
 * first; a typed id comes last, after the arguments and the list of what is lost. Drop's first
 * prompt, keep or delete the branch, is its yes or no.
 */
function stepsOf(id: ActionId, target: ActionTarget, lookup: DefinitionLookup): Step[] {
  const story = target.story ?? "the story";
  const inputs = inputStepsOf(id, target, story);
  const confirm = confirmSteps(id, story, {}, lookup);
  const choosesItself = inputs.some((step) => step.kind === "drop");
  const first = confirm.filter((step) => step.kind === "yesno" && !choosesItself);
  const last = confirm.filter((step) => step.kind !== "yesno");
  return [...first, ...inputs, ...last];
}

/** The prompts for an action's arguments, without its confirmation. */
function inputStepsOf(id: ActionId, target: ActionTarget, story: string): Step[] {
  switch (id) {
    case "answer":
      return [{ kind: "text", field: "text", label: "answer" }];
    case "approve":
      return needsNote(target.cli)
        ? [{ kind: "text", field: "note", label: "approve note (overrides the blocked review)" }]
        : [];
    case "reject":
      return [{ kind: "text", field: "note", label: "reject note" }];
    case "resume":
      if (budgetOf(target.cli) !== undefined) {
        return [{ kind: "topup", noteRequired: needsNote(target.cli) }];
      }
      return needsNote(target.cli)
        ? [{ kind: "text", field: "note", label: noteLabel(target.cli) }]
        : [{ kind: "text", field: "note", label: "note", optional: true }];
    case "discard":
      return [{ kind: "text", field: "note", label: "discard note" }];
    case "drop":
      // What it loses first, then keep or delete the branch; `deleteBranch` decides the rest.
      return [{ kind: "losses", command: "story.drop" }, { kind: "drop" }];
    case "park":
      return [{ kind: "text", field: "note", label: `park note for ${story}` }];
    case "ready":
      // One confirm that lists every story (DIPO-482); the engine's gate decides each one.
      return [
        {
          kind: "yesno",
          question: `Set ${(target.stories ?? []).join(", ")} Ready? Each one that passes the Ready gate goes into a backlog PR; the others stay Refined.`,
        },
      ];
    case "steer":
      return [{ kind: "text", field: "text", label: "steer text" }];
    case "fail":
      return [{ kind: "text", field: "note", label: "fail note" }];
    case "stop":
      // Stopping a run is the only action with no key, so it always asks first (0009).
      return [
        {
          kind: "yesno",
          question: `Stop the run of ${story}? Its worker stops and the story is parked.`,
        },
        { kind: "text", field: "note", label: `stop note for ${story}` },
      ];
    case "idea":
      return [{ kind: "text", field: "text", label: "idea (its first words are its title)" }];
    default:
      return [];
  }
}

/** `DIPO-1, DIPO-2`, or a count when there are many. */
function storiesLabel(stories: readonly string[]): string {
  return stories.length <= 3 ? stories.join(", ") : `${stories.length} stories`;
}

/** The result of a `story.ready` reply, when it parses. */
function readyOf(result: unknown): ReadyResult | undefined {
  const parsed = storyReady.result.safeParse(result);
  return parsed.success ? parsed.data : undefined;
}

/** A new flow for the action `id` on `target`. */
export function startFlow(
  id: ActionId,
  office: OfficeId,
  target: ActionTarget,
  lookup: DefinitionLookup = findCommand,
): Flow {
  const budget =
    id === "resume" && budgetOf(target.cli) !== undefined
      ? { share: shareOf(target.cli) }
      : undefined;
  const subject =
    id === "accept" || id === "dismiss"
      ? "proposed story"
      : id === "dismissNote"
        ? "decision note"
        : id === "idea"
          ? "a quick idea"
          : id === "ready"
            ? storiesLabel(target.stories ?? [])
            : (target.story ?? "");
  return {
    id,
    office,
    target,
    label: `${VERBS[id]} ${subject}`.trim(),
    steps: stepsOf(id, target, lookup),
    at: 0,
    values: budget === undefined ? {} : { budget },
    draft: target.prefill ?? "",
    losses: null,
    caps: null,
    field: "choice",
    reading: false,
  };
}

/** The command and args a finished flow sends. */
export function requestOf(flow: Flow, requestId: RequestId): CommandRequest {
  const { target, values } = flow;
  const story = { story: target.story };
  const note = values.note === undefined ? {} : { note: values.note };
  const command = binding(flow.id).command;
  let args: Record<string, unknown>;
  switch (flow.id) {
    case "answer":
      args = { question: target.question, text: values.text ?? "" };
      break;
    case "approve":
    case "reject":
      args = { gate: target.gate, ...note };
      break;
    case "accept":
    case "dismiss":
      args = { idea: target.idea };
      break;
    case "dismissNote":
      args = { note: target.note };
      break;
    case "idea":
      args = { text: values.text ?? "" };
      break;
    case "resume":
      args = {
        ...story,
        ...note,
        ...(values.budget === undefined ? {} : { budget: values.budget }),
      };
      break;
    case "drop":
      args = { ...story, deleteBranch: values.deleteBranch === true };
      break;
    case "steer":
      args = { ...story, text: values.text ?? "" };
      break;
    case "pass":
      args = { test: target.test, result: "pass" };
      break;
    case "fail":
      args = { test: target.test, result: "fail", ...note };
      break;
    case "discard":
    case "park":
    case "stop":
      args = { ...story, ...note };
      break;
    case "ready":
      args = { stories: target.stories ?? [] };
      break;
    default:
      args = story;
  }
  // A command with `confirm` was asked about in the flow; one with `confirmWhen` waits for the
  // engine's question unless the maintainer answered it already.
  const definition = findCommand(command);
  const asksFirst =
    definition?.confirmWhen?.some((field) => field in args) === true && values.confirmed !== true;
  const confirmed = !asksFirst && (definition?.confirm === true || values.confirmed === true);
  return { office: flow.office, command, args, requestId, confirmed };
}

export interface ActionDeps {
  readonly store: OfficeStore;
  readonly sendCommand: (request: CommandRequest) => Promise<CommandOutcome>;
  readonly readLosses: (request: LossesRequest) => Promise<LossesOutcome>;
  readonly newRequestId: () => RequestId;
  readonly offline: boolean;
  readonly office: OfficeId | null;
  readonly cursor: Cursor | null;
  readonly snapshots: number;
  readonly ellipsis: string;
}

/** `2 set, 1 refused` for the footer; the lines are in the Queue. */
function readySummary(result: ReadyResult): string {
  const lines = readyLines(result);
  const refused = lines.filter((line) => line.state === "refused").length;
  const set = lines.length - refused;
  return [set > 0 ? `${set} set` : null, refused > 0 ? `${refused} refused` : null]
    .filter((part) => part !== null)
    .join(", ");
}

/** What an action's reply adds to its done line. */
function replyNote(flow: Flow, result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  if (flow.id === "test") {
    const checkout = (result as { checkout?: unknown }).checkout;
    return typeof checkout === "string" ? `checkout ${checkout}` : undefined;
  }
  if (flow.id === "ready") {
    const ready = readyOf(result);
    return ready === undefined ? undefined : readySummary(ready);
  }
  if (flow.id !== "accept") return undefined;
  // `draft-31 in backlog PR #612` (DIPO-459): the draft and the PR the lane filed it in.
  const { draft, flush } = result as { draft?: unknown; flush?: { pr?: unknown } };
  if (typeof draft !== "string") return undefined;
  const pr = typeof flush?.pr === "string" ? /\/pull\/(\d+)/.exec(flush.pr)?.[1] : undefined;
  return pr === undefined ? draft : `${draft} in backlog PR #${pr}`;
}

/** A key of an open prompt; the prompt's keys are never dropped from the footer. */
function promptHint(key: string, label: string, side?: "right"): Hint {
  return { key, label, priority: 100, ...(side === undefined ? {} : { side }) };
}

export function useActions(deps: ActionDeps) {
  const { store, offline, ellipsis } = deps;
  const [flow, setFlow] = useState<Flow | null>(null);
  const [action, setAction] = useState<ActionState | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Read-your-writes, as for `work.run` (0009).
  useEffect(() => {
    if (action?.status !== "syncing") return;
    const passed =
      action.cursor === undefined ||
      deps.office !== action.request.office ||
      cursorReached(deps.cursor, action.cursor) ||
      (action.snapshots !== undefined && deps.snapshots > action.snapshots);
    if (passed) setAction({ ...action, status: "done" });
  }, [action, deps.cursor, deps.office, deps.snapshots]);

  const dispatch = (request: CommandRequest, sent: Flow) => {
    setMessage(null);
    setAction({ ...sentState(sent, request), status: "sending" });
    void deps.sendCommand(request).then((outcome) => {
      if (!outcome.ok) {
        const details = ResumeConfirmDetails.safeParse(outcome.error.details);
        const share = sent.values.budget !== undefined && "share" in sent.values.budget;
        if (
          outcome.error.code === "confirmation.required" &&
          !request.confirmed &&
          details.success &&
          share
        ) {
          // `confirmWhen`: the engine named the caps before and after; the top-up prompt shows
          // them, and its next Ctrl-S sends it confirmed.
          setAction(null);
          setFlow({
            ...sent,
            reading: false,
            caps: { share: shareChosen(sent), details: details.data },
          });
          return;
        }
        setAction({ ...sentState(sent, request), status: "failed", error: outcome.error });
        return;
      }
      // `changed: false`: the state already matched and nothing was written, so there is no write to
      // wait for (0005, 0009).
      const ready = sent.id === "ready" ? readyOf(outcome.result) : undefined;
      if (!outcome.changed) {
        setAction({
          ...sentState(sent, request),
          status: "done",
          unchanged: true,
          ...(ready === undefined ? {} : { ready }),
        });
        return;
      }
      const note = replyNote(sent, outcome.result);
      setAction({
        ...sentState(sent, request),
        ...(ready === undefined ? {} : { ready }),
        status: "syncing",
        ...(outcome.cursor === undefined ? {} : { cursor: outcome.cursor }),
        // Live, not the batched state: a re-read before this moment does not count.
        snapshots: store.state.snapshots,
        ...(note === undefined ? {} : { note }),
      });
    });
  };

  /** The next prompt of `current`, or the send once none is left. */
  const advance = (current: Flow) => {
    const at = current.at + 1;
    const step = current.steps[at];
    if (step === undefined) {
      if (offline) {
        setFlow(current);
        setMessage("offline: the prompt is kept; it sends once the connection is back");
        return;
      }
      setFlow(null);
      dispatch(requestOf(current, deps.newRequestId()), current);
      return;
    }
    const next = { ...current, at, draft: "" };
    if (step.kind !== "losses") {
      setFlow(next);
      return;
    }
    if (offline) {
      setFlow(current);
      setMessage("offline: the prompt is kept; it goes on once the connection is back");
      return;
    }
    setFlow({ ...next, reading: true, losses: null });
    const story = current.target.story ?? "";
    void deps
      .readLosses({ office: current.office, story, command: step.command })
      .then((outcome) => {
        if (!outcome.ok) {
          setFlow(null);
          setMessage(`${current.label}: ${outcome.error.code}: ${outcome.error.message}`);
          return;
        }
        setFlow((open) =>
          open === null || open.label !== current.label
            ? open
            : { ...next, at: at + 1, reading: false, losses: outcome.result.commits },
        );
      });
  };

  /** Starts the action `id`; false when it cannot start now (offline, or one is being sent). */
  const start = (id: ActionId, target: ActionTarget): boolean => {
    if (deps.office === null) return false;
    if (offline) {
      setMessage("offline: actions are disabled");
      return false;
    }
    if (action?.status === "sending") {
      setMessage(`${action.label} is being sent; wait for its reply`);
      return false;
    }
    setMessage(null);
    const created = startFlow(id, deps.office, target);
    // A flow that reads what it loses first (drop) reads it at once.
    if (created.steps.length === 0 || created.steps[0]?.kind === "losses") {
      advance({ ...created, at: -1 });
    } else setFlow(created);
    return true;
  };

  /**
   * Ctrl-S on the top-up prompt: the resume unconfirmed, for the caps of the chosen share; once they
   * show, the resume confirmed.
   */
  const sendTopUp = (open: Flow, required: boolean) => {
    const note = open.draft.trim();
    if (required && note === "") {
      setMessage("the note is empty; type it (tab), or Esc to cancel");
      return;
    }
    if (offline) {
      setMessage("offline: the prompt is kept; it sends once the connection is back");
      return;
    }
    const share = shareChosen(open);
    const shown = open.caps?.share === share;
    const sent: Flow = {
      ...open,
      values: {
        ...open.values,
        ...(note === "" ? {} : { note }),
        budget: { share },
        ...(shown ? { confirmed: true } : {}),
      },
    };
    if (shown) setFlow(null);
    else setFlow({ ...open, reading: true });
    dispatch(requestOf(sent, deps.newRequestId()), sent);
  };

  const cancel = (open: Flow) => {
    setFlow(null);
    setMessage(`${open.label}: nothing sent`);
  };

  /** Handles a key while a prompt is open; false when none is. */
  const key = (input: string, pressed: Key): boolean => {
    if (flow === null) return false;
    const step = flow.steps[flow.at];
    if (step === undefined || flow.reading) {
      if (pressed.escape) cancel(flow);
      return true;
    }
    switch (step.kind) {
      case "text": {
        // The Composer: Enter adds a line, Ctrl-S sends, Esc cancels.
        const event = composerKey(flow.draft, input, pressed);
        if (event.kind === "cancel") {
          cancel(flow);
        } else if (event.kind === "edit") {
          setFlow({ ...flow, draft: event.draft });
        } else if (event.kind === "send") {
          const text = flow.draft.trim();
          if (text === "" && step.optional !== true) {
            setMessage(`the ${step.label} is empty; type it, or Esc to cancel`);
            return true;
          }
          setMessage(null);
          const values = text === "" ? flow.values : { ...flow.values, [step.field]: text };
          advance({ ...flow, values });
        }
        return true;
      }
      case "typed": {
        if (pressed.escape) {
          cancel(flow);
        } else if (pressed.return) {
          // The typed id reads as every story reference does; only the story's own id passes.
          const typed = storyRef(flow.draft.trim());
          if (typed === null || typed !== storyRef(flow.target.story ?? "")) {
            setMessage(`type ${flow.target.story} to confirm, or Esc to keep it`);
            return true;
          }
          setMessage(null);
          advance(flow);
        } else {
          // One line: a paste's line breaks are dropped.
          const draft = editDraft(flow.draft, input.replace(/[\r\n]+/g, ""), pressed);
          if (draft !== null) setFlow({ ...flow, draft });
        }
        return true;
      }
      case "topup":
        return topUpKey(flow, step.noteRequired, input, pressed);
      case "yesno":
        if (input === "y" || input === "Y") advance(flow);
        else cancel(flow);
        return true;
      case "drop": {
        const remove = flow.values.deleteBranch === true;
        if (pressed.escape) {
          cancel(flow);
        } else if (input === " ") {
          // Ticking "also delete its branch" makes the drop irreversible (`irreversibleWhen`).
          setFlow({ ...flow, values: { ...flow.values, deleteBranch: !remove } });
        } else if (input === "y" || input === "Y") {
          const story = flow.target.story ?? "the story";
          // The losses were read when the drop started; only the typed id is left to ask.
          const more = remove
            ? confirmSteps(flow.id, story, { deleteBranch: true }).filter(
                (extra) => extra.kind === "typed",
              )
            : [];
          advance({
            ...flow,
            steps: [...flow.steps, ...more],
            values: { ...flow.values, deleteBranch: remove },
          });
        }
        return true;
      }
      case "losses":
        if (pressed.escape) cancel(flow);
        return true;
    }
  };

  /** A key on the top-up prompt: ←→ the share, Tab the field, the note's Composer, Ctrl-S. */
  const topUpKey = (open: Flow, required: boolean, input: string, pressed: Key): boolean => {
    if (pressed.escape) {
      cancel(open);
      return true;
    }
    if (open.reading) return true;
    if (pressed.ctrl && input === "s") {
      sendTopUp(open, required);
      return true;
    }
    if (pressed.tab) {
      setFlow({ ...open, field: open.field === "choice" ? "note" : "choice" });
      return true;
    }
    if (open.field === "choice") {
      if (!pressed.leftArrow && !pressed.rightArrow) return true;
      const share = shareChosen(open);
      const at = Math.max(0, TOP_UPS.indexOf(share));
      const next =
        TOP_UPS[Math.max(0, Math.min(TOP_UPS.length - 1, at + (pressed.leftArrow ? -1 : 1)))];
      setFlow({ ...open, values: { ...open.values, budget: { share: next ?? share } } });
      return true;
    }
    const draft = editDraft(open.draft, input, pressed);
    if (draft !== null) setFlow({ ...open, draft });
    return true;
  };

  /** Ctrl-R: sends a failed retryable action again with its request id; false when none waits. */
  const retry = (): boolean => {
    if (action?.status !== "failed" || action.error?.retryable !== true) return false;
    if (offline) {
      setMessage("offline: actions are disabled");
      return true;
    }
    const { request, label } = action;
    const sent = {
      label,
      request,
      verb: action.verb,
      ...(action.row === undefined ? {} : { row: action.row }),
    };
    setMessage(null);
    setAction({ ...sent, status: "sending" });
    void deps.sendCommand(request).then((outcome) => {
      if (!outcome.ok) {
        setAction({ ...sent, status: "failed", error: outcome.error });
        return;
      }
      setAction({
        ...sent,
        status: "syncing",
        ...(outcome.cursor === undefined ? {} : { cursor: outcome.cursor }),
        snapshots: store.state.snapshots,
      });
    });
    return true;
  };

  /** Esc at home: the failed or done action's line goes. */
  const dismiss = () => {
    if (action?.status === "failed" || action?.status === "done") setAction(null);
    setMessage(null);
  };

  /** The footer keys while a prompt is open (screens/11, 12); null when none is. */
  const promptHints = (): Hint[] | null => {
    if (flow === null) return null;
    const escCancel = promptHint("esc", "cancel");
    const escKeep = promptHint("esc", "keep it");
    const step = flow.steps[flow.at];
    if (step === undefined || flow.reading) return [escCancel];
    switch (step.kind) {
      case "text":
        return [promptHint("⏎", "new line"), promptHint("ctrl-s", "send"), escCancel];
      case "topup":
        return [
          promptHint("ctrl-s", flow.caps?.share === shareChosen(flow) ? "resume" : "show the caps"),
          promptHint("←→", "top-up"),
          promptHint("tab", "field"),
          escCancel,
        ];
      case "typed":
        return [
          promptHint("⏎", `${flow.id === "drop" ? "drop" : "discard"} (when the id matches)`),
          escKeep,
        ];
      case "yesno":
        return [promptHint("y", "yes"), promptHint("any other key", "cancel", "right")];
      case "drop":
        return [promptHint("y", "drop"), promptHint("space", "toggle branch"), escKeep];
      case "losses":
        return [escCancel];
    }
  };

  /** The footer line of the action on its way, or of the last one. */
  const statusLine = (): string | null => {
    if (message !== null) return message;
    if (action === null) return null;
    switch (action.status) {
      case "sending":
        return `${action.label}: sending${ellipsis}`;
      case "syncing":
        return `${action.label}: answered, waiting for the office stream${ellipsis}`;
      case "done":
        if (action.unchanged === true) {
          return action.ready === undefined
            ? `${action.label}: already so; nothing changed`
            : `${action.label}: ${readySummary(action.ready)}`;
        }
        return `${action.label}: done${action.note === undefined ? "" : `; ${action.note}`}`;
      case "failed":
        return `${action.label}: ${action.error?.code}: ${action.error?.message}`;
    }
  };

  return {
    flow,
    action,
    start,
    key,
    retry,
    dismiss,
    promptHints,
    statusLine,
    /** True while a text or typed-id prompt takes whole inputs (a paste). */
    typing:
      flow !== null &&
      !flow.reading &&
      (flow.steps[flow.at]?.kind === "text" ||
        flow.steps[flow.at]?.kind === "typed" ||
        (flow.steps[flow.at]?.kind === "topup" && flow.field === "note")),
    retryable: action?.status === "failed" && action.error?.retryable === true,
    setMessage,
  };
}
