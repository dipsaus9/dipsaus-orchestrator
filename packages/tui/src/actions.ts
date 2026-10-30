// The TUI's actions on the desk, the live agent detail, the queue and the overview (0009 section 5,
// DIPO-308). Each key of the table in `keys.ts` starts a flow: the prompts it needs, then one
// command with `origin: "tui"` and a fresh request id.
//
// - Text prompts take Enter to send and Esc to cancel: the answer, the park, reject and discard
//   notes, the steer text, and the resume note where the park needs one (the engine's command
//   line for it names `--note`). A text prompt keeps its draft while offline and sends nothing.
// - Which actions confirm comes from the command definitions, as in the CLI (DIPO-320,
//   `confirmSteps`): a command with `confirm` asks yes or no (reject, first); an `irreversible`
//   one, or one an `irreversibleWhen` argument makes so (drop with branch deletion), reads
//   `story.losses`, lists what is lost and asks for the story id typed out (0009 open question 4).
//   Drop first asks whether to keep the branch; that choice is its yes or no.
// - A resume with a budget (the engine's line names `--budget`, which `work.resume` declares in
//   `confirmWhen`) is sent unconfirmed; the engine answers with the caps before and after, which
//   the prompt shows before it asks yes or no and sends it confirmed.
// - Every other action is one key.
//
// An action is done only when the office stream passes its reply cursor (read-your-writes), when
// the store read the office again after the reply, or once the maintainer switched office. An
// error shows in the footer with the engine's message, so a prompt whose question or gate closed
// meanwhile ends with `question.closed` or the gate's code; a retryable error offers Ctrl-R, which
// sends the same request again with the same request id (0005 section 9). A reply with
// `changed: false` ends at once with "already so; nothing changed", such as a resume of a story
// that already runs.

import { cursorReached, type OfficeStore, storyRef } from "@dipsaus-orchestrator/client";
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
} from "@dipsaus-orchestrator/contract";
import type { Key } from "ink";
import { useEffect, useState } from "react";

import { binding, type ActionId } from "./keys";

/** One command an action sends. */
export interface CommandRequest {
  readonly office: OfficeId;
  readonly command: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly requestId: RequestId;
  /** True only after the maintainer agreed (0005 section 9). */
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
  readonly question?: string;
  readonly gate?: string;
  readonly proposal?: string;
  /** The command line the engine built for the action, when a desk row offered it. */
  readonly cli?: string;
  /** What the prompt names: the question's text or the permission. */
  readonly text?: string;
  /** The open test a checklist action is about (DIPO-365). */
  readonly test?: string;
  /** What a fail note starts with: the first unticked step (DIPO-365). */
  readonly prefill?: string;
}

type Step =
  | { readonly kind: "text"; readonly field: "text" | "note"; readonly label: string }
  | { readonly kind: "yesno"; readonly question: string }
  | { readonly kind: "drop" }
  | { readonly kind: "losses"; readonly command: "work.discard" | "story.drop" }
  | { readonly kind: "typed" };

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
  /** What the prompt lists above its question: the losses, or the caps before and after. */
  readonly lines: readonly string[];
  /** True while `story.losses` is read. */
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
}

/** The verb of each action in its label. */
const VERBS: Readonly<Record<ActionId, string>> = {
  answer: "answer",
  approve: "approve",
  reject: "reject",
  resume: "resume",
  discard: "discard",
  drop: "drop",
  park: "park",
  test: "test",
  accept: "accept",
  dismiss: "dismiss",
  steer: "steer",
  pass: "pass",
  fail: "fail",
};

/** What the irreversible commands do, as the typed confirmation says it (0009 section 5). */
const LOSES: Readonly<Record<"work.discard" | "story.drop", string>> = {
  "work.discard":
    "ends the run, deletes the box and branch, closes the PR and returns the story to Refined",
  "story.drop": "archives it, releases its claim and deletes its branch",
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
      return needsNote(target.cli) ? [{ kind: "text", field: "note", label: "resume note" }] : [];
    case "discard":
      return [{ kind: "text", field: "note", label: "discard note" }];
    case "drop":
      // Keep or delete the branch; `deleteBranch` then decides the rest (`confirmSteps`).
      return [{ kind: "drop" }];
    case "park":
      return [{ kind: "text", field: "note", label: `park note for ${story}` }];
    case "steer":
      return [{ kind: "text", field: "text", label: "steer text" }];
    case "fail":
      return [{ kind: "text", field: "note", label: "fail note" }];
    default:
      return [];
  }
}

/** A new flow for the action `id` on `target`. */
export function startFlow(
  id: ActionId,
  office: OfficeId,
  target: ActionTarget,
  lookup: DefinitionLookup = findCommand,
): Flow {
  const budget = id === "resume" ? budgetOf(target.cli) : undefined;
  const subject = id === "accept" || id === "dismiss" ? "proposal" : (target.story ?? "");
  return {
    id,
    office,
    target,
    label: `${VERBS[id]} ${subject}`.trim(),
    steps: stepsOf(id, target, lookup),
    at: 0,
    values: budget === undefined ? {} : { budget },
    draft: target.prefill ?? "",
    lines: [],
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
      args = { proposal: target.proposal };
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
      args = { ...story, ...note };
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

/** The lines listing what a discard or drop loses. */
export function lossLines(
  command: "work.discard" | "story.drop",
  story: string,
  losses: Extract<LossesOutcome, { ok: true }>["result"],
): string[] {
  const lines = [`${command === "work.discard" ? "Discard" : "Drop"} ${story}: ${LOSES[command]}.`];
  if (losses.commits.length === 0) {
    lines.push("  lost: nothing (no commits off the base)");
  } else {
    lines.push("  lost:");
    for (const commit of losses.commits) lines.push(`    commit ${commit.sha} ${commit.subject}`);
  }
  return lines;
}

/** The caps before and after a top-up, as the resume question shows them. */
export function capsLines(details: ResumeConfirmDetails): string[] {
  const rows: [string, number, number][] = [
    ["tokens", details.before.budgetTokens, details.after.budgetTokens],
    ["turns", details.before.maxTurns, details.after.maxTurns],
    ["minutes", details.before.maxMinutes, details.after.maxMinutes],
  ];
  return rows.map(([name, before, after]) => `  ${name.padEnd(8)}${before} -> ${after}`);
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

/** What an action's reply adds to its done line. */
function replyNote(flow: Flow, result: unknown): string | undefined {
  if (flow.id !== "test" || typeof result !== "object" || result === null) return undefined;
  const checkout = (result as { checkout?: unknown }).checkout;
  return typeof checkout === "string" ? `checkout ${checkout}` : undefined;
}

/** The flows, the action on its way and the keys of an open prompt. */
export function useActions(deps: ActionDeps) {
  const { store, offline, ellipsis } = deps;
  const [flow, setFlow] = useState<Flow | null>(null);
  const [action, setAction] = useState<ActionState | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Read-your-writes, as for `work.run` (0009 section 5).
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
    setAction({ label: sent.label, request, status: "sending" });
    void deps.sendCommand(request).then((outcome) => {
      if (!outcome.ok) {
        const details = ResumeConfirmDetails.safeParse(outcome.error.details);
        if (
          outcome.error.code === "confirmation.required" &&
          !request.confirmed &&
          details.success
        ) {
          // `confirmWhen`: the engine named the caps before and after; ask, then send confirmed.
          setAction(null);
          setFlow({
            ...sent,
            steps: [
              { kind: "yesno", question: `Raise ${sent.target.story}'s caps and resume it?` },
            ],
            at: 0,
            values: { ...sent.values, confirmed: true },
            lines: [
              `Top up ${sent.target.story}: its caps go from the left to the right.`,
              ...capsLines(details.data),
            ],
            draft: "",
          });
          return;
        }
        setAction({ label: sent.label, request, status: "failed", error: outcome.error });
        return;
      }
      // `changed: false`: the state already matched and nothing was written, so there is no write to
      // wait for (0005, 0009).
      if (!outcome.changed) {
        setAction({ label: sent.label, request, status: "done", unchanged: true });
        return;
      }
      const note = replyNote(sent, outcome.result);
      setAction({
        label: sent.label,
        request,
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
    setFlow({ ...next, reading: true, lines: [] });
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
            : {
                ...next,
                at: at + 1,
                reading: false,
                lines: lossLines(step.command, story, outcome.result),
              },
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
    if (created.steps.length === 0) advance({ ...created, at: -1 });
    else setFlow(created);
    return true;
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
      case "text":
      case "typed": {
        if (pressed.escape) {
          cancel(flow);
        } else if (pressed.return) {
          const text = flow.draft.trim();
          if (step.kind === "typed") {
            // The typed id reads as every story reference does; only the story's own id passes.
            const typed = storyRef(text);
            if (typed === null || typed !== storyRef(flow.target.story ?? "")) {
              setMessage(`type ${flow.target.story} to confirm, or Esc to cancel`);
              return true;
            }
            setMessage(null);
            advance(flow);
            return true;
          }
          if (text === "") {
            setMessage(`the ${step.label} is empty; type it, or Esc to cancel`);
            return true;
          }
          setMessage(null);
          advance({ ...flow, values: { ...flow.values, [step.field]: text } });
        } else if (pressed.backspace || pressed.delete) {
          setFlow({ ...flow, draft: flow.draft.slice(0, -1) });
        } else if (!pressed.ctrl && !pressed.meta && input !== "") {
          // A paste arrives as one input and goes in literally, line breaks as spaces.
          setFlow({ ...flow, draft: flow.draft + input.replace(/[\r\n]+/g, " ") });
        }
        return true;
      }
      case "yesno":
        if (input === "y" || input === "Y") advance(flow);
        else cancel(flow);
        return true;
      case "drop":
        if (input === "y" || input === "Y") {
          advance({ ...flow, values: { ...flow.values, deleteBranch: false } });
        } else if (input === "D") {
          const story = flow.target.story ?? "the story";
          advance({
            ...flow,
            steps: [...flow.steps, ...confirmSteps(flow.id, story, { deleteBranch: true })],
            values: { ...flow.values, deleteBranch: true },
          });
        } else cancel(flow);
        return true;
      case "losses":
        if (pressed.escape) cancel(flow);
        return true;
    }
  };

  /** Ctrl-R: sends a failed retryable action again with its request id; false when none waits. */
  const retry = (): boolean => {
    if (action?.status !== "failed" || action.error?.retryable !== true) return false;
    if (offline) {
      setMessage("offline: actions are disabled");
      return true;
    }
    const { request, label } = action;
    setMessage(null);
    setAction({ label, request, status: "sending" });
    void deps.sendCommand(request).then((outcome) => {
      if (!outcome.ok) {
        setAction({ label, request, status: "failed", error: outcome.error });
        return;
      }
      setAction({
        label,
        request,
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

  /** The lines of the open prompt, above the footer. */
  const promptLines = (): string[] => {
    if (flow === null) return [];
    const step = flow.steps[flow.at];
    const story = flow.target.story ?? "";
    if (flow.reading || step === undefined)
      return [`${flow.label}: reading what is lost${ellipsis}`];
    const named = flow.target.text === undefined ? [] : [`${flow.label}: ${flow.target.text}`];
    switch (step.kind) {
      case "text":
        return [...named, `${step.label}: ${flow.draft}_`];
      case "typed":
        return [...flow.lines, `type ${story} to confirm: ${flow.draft}_`];
      case "yesno":
        return [...flow.lines, `${step.question} [y/N]`];
      case "drop":
        return [
          `Drop ${story}: archive it and release its claim? [y] keep its branch  [D] delete the branch too`,
        ];
      case "losses":
        return [`${flow.label}: reading what is lost${ellipsis}`];
    }
  };

  /** The footer keys while a prompt is open; null when none is. */
  const promptHints = (): string | null => {
    if (flow === null) return null;
    const step = flow.steps[flow.at];
    if (step === undefined || flow.reading) return "[Esc] cancel";
    switch (step.kind) {
      case "text":
        return "[Enter] send  [Esc] cancel";
      case "typed":
        return "[Enter] confirm  [Esc] cancel";
      case "yesno":
        return "[y] yes  [any other key] cancel";
      case "drop":
        return "[y] drop, keep branch  [D] delete branch  [any other key] cancel";
      case "losses":
        return "[Esc] cancel";
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
        if (action.unchanged === true) return `${action.label}: already so; nothing changed`;
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
    promptLines,
    promptHints,
    statusLine,
    /** True while a text or typed-id prompt takes whole inputs (a paste). */
    typing:
      flow !== null &&
      !flow.reading &&
      (flow.steps[flow.at]?.kind === "text" || flow.steps[flow.at]?.kind === "typed"),
    retryable: action?.status === "failed" && action.error?.retryable === true,
    setMessage,
  };
}
