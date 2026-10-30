// The one key table of the TUI's actions (0009, amended by DIPO-308): which key sends which
// command, in which view. The desk binds every action `office.desk` can list; the live agent detail
// adds `s` steer and `P` park, the queue `P` park and `d` drop, and an overview row whose run asks
// offers `a` answer.
//
// On a desk row a key is offered only when the row's `actions` lists its command; a view's row
// binding wins over a global key (`n` rejects a merge and dismisses a proposal, `y` approves a merge
// and accepts a proposal). An action no entry binds on its row, or whose key an earlier action of
// the row took, shows its `cli` line in the footer. An answer is always a text (0020). Client and
// daemon are one binary (0005), so every command in the table exists.

import type { DeskAction, DeskItem } from "@dipsaus-orchestrator/contract";

/** Where a key works. */
export type ActionView = "desk" | "detail" | "queue" | "overview" | "checklist";

export type ActionId =
  | "answer"
  | "approve"
  | "reject"
  | "resume"
  | "discard"
  | "drop"
  | "park"
  | "test"
  | "accept"
  | "dismiss"
  | "steer"
  | "pass"
  | "fail";

export interface KeyBinding {
  readonly id: ActionId;
  readonly command: string;
  /** The input the key sends; `D` is Shift-D. */
  readonly key: string;
  /** The footer and row hint. */
  readonly hint: string;
  readonly views: readonly ActionView[];
}

/** The table, in the order a row's keys are shown and taken. */
export const KEY_TABLE: readonly KeyBinding[] = [
  {
    id: "answer",
    command: "work.answer",
    key: "a",
    hint: "[a]nswer",
    views: ["desk", "detail", "overview"],
  },
  {
    id: "approve",
    command: "gate.approve",
    key: "y",
    hint: "[y] approve",
    views: ["desk"],
  },
  {
    id: "reject",
    command: "gate.reject",
    key: "n",
    hint: "[n] reject",
    views: ["desk"],
  },
  {
    id: "accept",
    command: "proposal.accept",
    key: "y",
    hint: "[y] accept",
    views: ["desk"],
  },
  {
    id: "dismiss",
    command: "proposal.dismiss",
    key: "n",
    hint: "[n] dismiss",
    views: ["desk"],
  },
  {
    id: "resume",
    command: "work.resume",
    key: "r",
    hint: "[r]esume",
    views: ["desk"],
  },
  {
    id: "test",
    command: "test.start",
    key: "t",
    hint: "[t]est",
    views: ["desk"],
  },
  {
    id: "park",
    command: "story.park",
    key: "P",
    hint: "[P]ark",
    views: ["desk", "detail", "queue"],
  },
  {
    id: "drop",
    command: "story.drop",
    key: "d",
    hint: "[d]rop",
    views: ["desk", "queue"],
  },
  {
    id: "discard",
    command: "work.discard",
    key: "D",
    hint: "[Shift-D]iscard",
    views: ["desk"],
  },
  {
    id: "steer",
    command: "work.steer",
    key: "s",
    hint: "[s]teer",
    views: ["detail"],
  },
  {
    id: "pass",
    command: "test.record",
    key: "P",
    hint: "[P] pass",
    views: ["checklist"],
  },
  {
    id: "fail",
    command: "test.record",
    key: "F",
    hint: "[F] fail",
    views: ["checklist"],
  },
];

export function binding(id: ActionId): KeyBinding {
  const found = KEY_TABLE.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no key binding ${id}`);
  return found;
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

/** The keys a desk row offers: only for the commands its `actions` lists. */
export function rowKeys(item: DeskItem): RowKeys {
  const bound: BoundAction[] = [];
  const unbound: DeskAction[] = [];
  for (const action of item.actions) {
    const entry = KEY_TABLE.find(
      (candidate) =>
        candidate.command === action.command &&
        candidate.views.includes("desk") &&
        hasTarget(candidate, item),
    );
    const taken = entry !== undefined && bound.some((other) => other.binding.key === entry.key);
    if (entry === undefined || taken) unbound.push(action);
    else bound.push({ binding: entry, action });
  }
  return { bound, unbound };
}

/** The keys a view offers without a row's `actions` (the detail's steer and park, the queue's). */
export function viewKeys(view: ActionView): KeyBinding[] {
  return KEY_TABLE.filter(
    (entry) =>
      entry.views.includes(view) &&
      (view !== "detail" || entry.id === "steer" || entry.id === "park") &&
      (view !== "queue" || entry.id === "park" || entry.id === "drop"),
  );
}
