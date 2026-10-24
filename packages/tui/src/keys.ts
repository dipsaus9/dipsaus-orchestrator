// The one key table of the TUI's actions (0009 sections 5 and 6, amended by DIPO-308): which key
// sends which command, in which view, behind which capability flag. The desk binds every action
// `office.desk` can list; the live agent detail adds `s` steer and `p` pause, the queue `h` hold
// and `d` drop, and an overview row whose run asks offers `a` answer.
//
// On a desk row a key is offered only when the row's `actions` lists its command and the engine's
// capability flags allow it; a view's row binding wins over a global key (`n` denies a permission,
// rejects a merge and dismisses a proposal, `y` approves a merge and accepts a proposal). An
// action no entry binds on its row, or whose key an earlier action of the row took, shows its
// `cli` line in the footer. `work.answer` is listed once per answer form: the engine's command
// line says which (`… allow`, `… deny "<reason>"`, or `--text`), since a permission question takes
// allow or deny and a worker question takes a text. Commands without a flag (`story.hold`,
// `story.drop`, `work.discard`, `work.stop`) are gated by the engine's answer alone.

import type { DeskAction, DeskItem } from "@dipsaus-orchestrator/contract";

/** Where a key works. */
export type ActionView = "desk" | "detail" | "queue" | "overview";

export type ActionId =
  | "answer"
  | "allow"
  | "deny"
  | "approve"
  | "reject"
  | "resume"
  | "discard"
  | "drop"
  | "hold"
  | "test"
  | "accept"
  | "dismiss"
  | "stop"
  | "steer"
  | "pause";

export interface KeyBinding {
  readonly id: ActionId;
  readonly command: string;
  /** The input the key sends; `D` is Shift-D. */
  readonly key: string;
  /** The footer and row hint. */
  readonly hint: string;
  readonly views: readonly ActionView[];
  /** The capability flag (0005 section 7) the engine must report; null when none covers it. */
  readonly flag: string | null;
}

/** The table, in the order a row's keys are shown and taken. */
export const KEY_TABLE: readonly KeyBinding[] = [
  {
    id: "answer",
    command: "work.answer",
    key: "a",
    hint: "[a]nswer",
    views: ["desk", "detail", "overview"],
    flag: "work.intervene",
  },
  {
    id: "allow",
    command: "work.answer",
    key: "A",
    hint: "[A]llow once",
    views: ["desk"],
    flag: "work.intervene",
  },
  {
    id: "deny",
    command: "work.answer",
    key: "n",
    hint: "[n] deny",
    views: ["desk"],
    flag: "work.intervene",
  },
  {
    id: "approve",
    command: "gate.approve",
    key: "y",
    hint: "[y] approve",
    views: ["desk"],
    flag: "review",
  },
  {
    id: "reject",
    command: "gate.reject",
    key: "n",
    hint: "[n] reject",
    views: ["desk"],
    flag: "review",
  },
  {
    id: "accept",
    command: "proposal.accept",
    key: "y",
    hint: "[y] accept",
    views: ["desk"],
    flag: "proposals",
  },
  {
    id: "dismiss",
    command: "proposal.dismiss",
    key: "n",
    hint: "[n] dismiss",
    views: ["desk"],
    flag: "proposals",
  },
  {
    id: "resume",
    command: "work.resume",
    key: "r",
    hint: "[r]esume",
    views: ["desk"],
    flag: "work.intervene",
  },
  {
    id: "test",
    command: "test.start",
    key: "t",
    hint: "[t]est",
    views: ["desk"],
    flag: "test.sessions",
  },
  {
    id: "hold",
    command: "story.hold",
    key: "h",
    hint: "[h]old",
    views: ["desk", "queue"],
    flag: null,
  },
  {
    id: "drop",
    command: "story.drop",
    key: "d",
    hint: "[d]rop",
    views: ["desk", "queue"],
    flag: null,
  },
  {
    id: "discard",
    command: "work.discard",
    key: "D",
    hint: "[Shift-D]iscard",
    views: ["desk"],
    flag: null,
  },
  {
    id: "stop",
    command: "work.stop",
    key: "X",
    hint: "[X] stop",
    views: ["desk", "detail"],
    flag: null,
  },
  {
    id: "steer",
    command: "work.steer",
    key: "s",
    hint: "[s]teer",
    views: ["detail"],
    flag: "work.intervene",
  },
  {
    id: "pause",
    command: "work.pause",
    key: "p",
    hint: "[p]ause",
    views: ["detail"],
    flag: "work.intervene",
  },
];

export function binding(id: ActionId): KeyBinding {
  const found = KEY_TABLE.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no key binding ${id}`);
  return found;
}

/** True when the engine reports the flag the binding needs. */
export function allowed(entry: KeyBinding, capabilities: readonly string[]): boolean {
  return entry.flag === null || capabilities.includes(entry.flag);
}

/** The answer form of a `work.answer` action, from the command line the engine built for it. */
function answerForm(action: DeskAction): ActionId {
  if (action.cli.endsWith(" allow")) return "allow";
  if (/ deny( |$)/.test(action.cli)) return "deny";
  return "answer";
}

/** Whether a desk row carries the target the binding's command needs. */
function hasTarget(entry: KeyBinding, item: DeskItem): boolean {
  switch (entry.command) {
    case "work.answer":
      return item.question !== undefined;
    case "gate.approve":
    case "gate.reject":
      return item.gate !== undefined;
    case "proposal.accept":
    case "proposal.dismiss":
      return item.proposal !== undefined;
    default:
      return item.story !== undefined;
  }
}

/** One action of a desk row with the key that sends it. */
export interface BoundAction {
  readonly binding: KeyBinding;
  readonly action: DeskAction;
}

/** A desk row's keys, and the actions no key sends, whose command lines the footer shows. */
export interface RowKeys {
  readonly bound: readonly BoundAction[];
  readonly unbound: readonly DeskAction[];
}

/** The keys a desk row offers: only for the commands its `actions` lists and the flags allow. */
export function rowKeys(item: DeskItem, capabilities: readonly string[]): RowKeys {
  const bound: BoundAction[] = [];
  const unbound: DeskAction[] = [];
  for (const action of item.actions) {
    const form = action.command === "work.answer" ? answerForm(action) : null;
    const entry = KEY_TABLE.find(
      (candidate) =>
        candidate.command === action.command &&
        candidate.views.includes("desk") &&
        (form === null || candidate.id === form) &&
        hasTarget(candidate, item) &&
        allowed(candidate, capabilities),
    );
    const taken = entry !== undefined && bound.some((other) => other.binding.key === entry.key);
    if (entry === undefined || taken) unbound.push(action);
    else bound.push({ binding: entry, action });
  }
  return { bound, unbound };
}

/** The keys a view offers without a row's `actions` (the detail's steer and pause, the queue's). */
export function viewKeys(view: ActionView, capabilities: readonly string[]): KeyBinding[] {
  return KEY_TABLE.filter(
    (entry) =>
      entry.views.includes(view) &&
      (view !== "detail" || entry.id === "steer" || entry.id === "pause") &&
      (view !== "queue" || entry.id === "hold" || entry.id === "drop") &&
      allowed(entry, capabilities),
  );
}
