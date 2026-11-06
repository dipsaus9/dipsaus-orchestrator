// The one key table of the TUI's actions (0009, DIPO-308): which key sends which
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

/** What the focused item offers: the commands its row, run or story can take. */
export interface RowContext {
  readonly commands: ReadonlySet<string>;
}

const offered =
  (command: string) =>
  (ctx: RowContext): boolean =>
    ctx.commands.has(command);

export interface KeyBinding {
  readonly id: ActionId;
  readonly command: string;
  /** The input the key sends; `D` is Shift-D. */
  readonly key: string;
  /** The word for the action in help and the palette. */
  readonly label: string;
  /** Footer drop order when the width is short: the lowest goes first. */
  readonly priority: number;
  /** True when the focused item offers the action. */
  readonly when: (ctx: RowContext) => boolean;
  /** The footer and row hint. */
  readonly hint: string;
  readonly views: readonly ActionView[];
}

/** The table, in the order a row's keys are shown and taken. */
export const KEY_TABLE: readonly KeyBinding[] = [
  {
    id: "answer",
    label: "answer",
    priority: 85,
    command: "work.answer",
    when: offered("work.answer"),
    key: "a",
    hint: "[a]nswer",
    views: ["desk", "detail", "overview"],
  },
  {
    id: "approve",
    label: "approve",
    priority: 85,
    command: "gate.approve",
    when: offered("gate.approve"),
    key: "y",
    hint: "[y] approve",
    views: ["desk"],
  },
  {
    id: "reject",
    label: "reject",
    priority: 85,
    command: "gate.reject",
    when: offered("gate.reject"),
    key: "n",
    hint: "[n] reject",
    views: ["desk"],
  },
  {
    id: "accept",
    label: "accept",
    priority: 85,
    command: "proposal.accept",
    when: offered("proposal.accept"),
    key: "y",
    hint: "[y] accept",
    views: ["desk"],
  },
  {
    id: "dismiss",
    label: "dismiss",
    priority: 85,
    command: "proposal.dismiss",
    when: offered("proposal.dismiss"),
    key: "n",
    hint: "[n] dismiss",
    views: ["desk"],
  },
  {
    id: "resume",
    label: "resume",
    priority: 85,
    command: "work.resume",
    when: offered("work.resume"),
    key: "r",
    hint: "[r]esume",
    views: ["desk"],
  },
  {
    id: "test",
    label: "test",
    priority: 85,
    command: "test.start",
    when: offered("test.start"),
    key: "t",
    hint: "[t]est",
    views: ["desk"],
  },
  {
    id: "park",
    label: "park",
    priority: 85,
    command: "story.park",
    when: offered("story.park"),
    key: "P",
    hint: "[P]ark",
    views: ["desk", "detail", "queue"],
  },
  {
    id: "drop",
    label: "drop",
    priority: 85,
    command: "story.drop",
    when: offered("story.drop"),
    key: "d",
    hint: "[d]rop",
    views: ["desk", "queue"],
  },
  {
    id: "discard",
    label: "discard",
    priority: 85,
    command: "work.discard",
    when: offered("work.discard"),
    key: "D",
    hint: "[Shift-D]iscard",
    views: ["desk"],
  },
  {
    id: "steer",
    label: "steer",
    priority: 72,
    command: "work.steer",
    when: offered("work.steer"),
    key: "s",
    hint: "[s]teer",
    views: ["detail"],
  },
  {
    id: "pass",
    label: "pass",
    priority: 75,
    command: "test.record",
    when: offered("test.record"),
    key: "P",
    hint: "[P] pass",
    views: ["checklist"],
  },
  {
    id: "fail",
    label: "fail",
    priority: 75,
    command: "test.record",
    when: offered("test.record"),
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
export function viewKeys(view: ActionView, ctx?: RowContext): KeyBinding[] {
  return KEY_TABLE.filter(
    (entry) =>
      entry.views.includes(view) &&
      (ctx === undefined || entry.when(ctx)) &&
      (view !== "detail" || entry.id === "steer" || entry.id === "park") &&
      (view !== "queue" || entry.id === "park" || entry.id === "drop"),
  );
}

/** The screens a footer key belongs to; `ended` and `detail` share the live agent detail's keys. */
export type FooterView =
  | "path"
  | "privacy"
  | "switcher"
  | "planning"
  | "overview"
  | "desk"
  | "queue"
  | "settings"
  | "checklist"
  | "detail"
  | "card";

/** What the footer's `when` reads about the screen. */
export interface FooterContext {
  readonly offline: boolean;
  /** An office is open. */
  readonly office: boolean;
  /** The view has a row to open: a desk row or a board entry. */
  readonly hasRow: boolean;
  /** A planning session is open (the `5` key shows). */
  readonly planningOpen: boolean;
  /** The planning view: whether a session is open, a message is on its way, an end is asked. */
  readonly planning: {
    readonly session: boolean;
    readonly sending: boolean;
    readonly confirmingEnd: boolean;
  };
}

/** A key the footer can show: the registry the footer reads, with no per-view lists elsewhere. */
export interface FooterKey {
  readonly id: string;
  /** The key as the footer prints it. */
  readonly key: string;
  /** The word for it in help and the palette. */
  readonly label: string;
  /** The footer text; the quit key says so when offline. */
  readonly hint: string | ((ctx: FooterContext) => string);
  readonly views: readonly FooterView[];
  readonly when?: (ctx: FooterContext) => boolean;
  /** Footer drop order when the width is short: the lowest goes first, 100 never. */
  readonly priority: number;
}

const HOME_VIEWS: readonly FooterView[] = ["overview", "desk", "queue", "settings", "checklist"];
const NEVER = 100;
const asking = (ctx: FooterContext) => ctx.planning.confirmingEnd;
const editing = (ctx: FooterContext) => !ctx.planning.confirmingEnd;

/** The footer's keys in the order they print. */
export const FOOTER_KEYS: readonly FooterKey[] = [
  {
    id: "pathOpen",
    key: "Enter",
    label: "open",
    hint: "[Enter] open",
    views: ["path"],
    priority: NEVER,
  },
  {
    id: "pathCancel",
    key: "Esc",
    label: "cancel",
    hint: "[Esc] cancel",
    views: ["path"],
    priority: NEVER,
  },
  {
    id: "privacyYes",
    key: "y",
    label: "change it",
    hint: "[y] change it",
    views: ["privacy"],
    priority: NEVER,
  },
  {
    id: "privacyKeep",
    key: "any other key",
    label: "keep it",
    hint: "[any other key] keep it",
    views: ["privacy"],
    priority: 50,
  },
  {
    id: "planningEndYes",
    key: "y",
    label: "end the session",
    hint: "[y] end the session",
    views: ["planning"],
    when: asking,
    priority: NEVER,
  },
  {
    id: "planningEndKeep",
    key: "any other key",
    label: "keep it",
    hint: "[any other key] keep it",
    views: ["planning"],
    when: asking,
    priority: 50,
  },
  {
    id: "planningSend",
    key: "Ctrl-S",
    label: "send",
    hint: (ctx) => (ctx.planning.session ? "[Ctrl-S] send" : "[Ctrl-S] start"),
    views: ["planning"],
    when: editing,
    priority: NEVER,
  },
  {
    id: "planningNewLine",
    key: "Enter",
    label: "new line",
    hint: "[Enter] new line",
    views: ["planning"],
    when: editing,
    priority: 90,
  },
  {
    id: "planningKind",
    key: "Tab",
    label: "kind",
    hint: "[Tab] kind",
    views: ["planning"],
    when: (ctx) => editing(ctx) && !ctx.planning.session,
    priority: 80,
  },
  {
    id: "planningEnd",
    key: "Ctrl-E",
    label: "end session",
    hint: "[Ctrl-E] end session",
    views: ["planning"],
    when: (ctx) => editing(ctx) && ctx.planning.session,
    priority: 70,
  },
  {
    id: "planningSending",
    key: "",
    label: "sending",
    hint: "sending",
    views: ["planning"],
    when: (ctx) => editing(ctx) && ctx.planning.sending,
    priority: 60,
  },
  {
    id: "planningBack",
    key: "Esc",
    label: "back",
    hint: "[Esc] back",
    views: ["planning"],
    when: editing,
    priority: 85,
  },

  {
    id: "switcherOpen",
    key: "Enter",
    label: "open",
    hint: "[Enter] open",
    views: ["switcher"],
    priority: 70,
  },
  {
    id: "switcherNew",
    key: "n",
    label: "open new repo path",
    hint: "[n] open new repo path",
    views: ["switcher"],
    priority: 40,
  },
  {
    id: "switcherMove",
    key: "j/k",
    label: "move",
    hint: "[j/k] move",
    views: ["switcher"],
    priority: 30,
  },
  {
    id: "switcherBack",
    key: "Esc",
    label: "back",
    hint: "[Esc] back",
    views: ["switcher"],
    when: (ctx) => ctx.office,
    priority: 50,
  },

  {
    id: "cardScroll",
    key: "j/k",
    label: "scroll",
    hint: "[j/k] scroll",
    views: ["card"],
    priority: 30,
  },
  { id: "cardBack", key: "Esc", label: "back", hint: "[Esc] back", views: ["card"], priority: 90 },

  {
    id: "detailStreams",
    key: "w v i",
    label: "streams",
    hint: "[w]orker [v]erify [i] prompt",
    views: ["detail"],
    priority: 75,
  },
  {
    id: "detailScroll",
    key: "k/j PgUp/PgDn",
    label: "scroll",
    hint: "[k/j PgUp/PgDn] scroll",
    views: ["detail"],
    priority: 35,
  },
  {
    id: "detailFollow",
    key: "End",
    label: "follow tail",
    hint: "[End] follow tail",
    views: ["detail"],
    priority: 45,
  },
  {
    id: "detailBack",
    key: "Esc",
    label: "back",
    hint: "[Esc] back",
    views: ["detail"],
    priority: 90,
  },

  {
    id: "settingsToggle",
    key: "Enter",
    label: "toggle",
    hint: "[Enter] toggle",
    views: ["settings"],
    priority: 70,
  },
  {
    id: "settingsMove",
    key: "j/k",
    label: "move",
    hint: "[j/k] move",
    views: ["settings"],
    priority: 30,
  },
  {
    id: "settingsBack",
    key: "Esc",
    label: "back",
    hint: "[Esc] back",
    views: ["settings"],
    priority: 50,
  },
  {
    id: "settingsOverview",
    key: "1",
    label: "overview",
    hint: "[1] overview",
    views: ["settings"],
    priority: 40,
  },

  {
    id: "queueDetail",
    key: "Enter",
    label: "detail",
    hint: "[Enter] detail",
    views: ["queue"],
    priority: 60,
  },
  {
    id: "queueRun",
    key: "u",
    label: "run selected",
    hint: "r[u]n selected",
    views: ["queue"],
    priority: 70,
  },
  {
    id: "queueMove",
    key: "j/k",
    label: "move",
    hint: "[j/k] move",
    views: ["queue"],
    priority: 30,
  },
  {
    id: "queueDone",
    key: ".",
    label: "show done",
    hint: "[.] show done",
    views: ["queue"],
    priority: 20,
  },
  {
    id: "queueOverview",
    key: "1",
    label: "overview",
    hint: "[1] overview",
    views: ["queue"],
    priority: 50,
  },
  { id: "queueDesk", key: "3", label: "desk", hint: "[3] desk", views: ["queue"], priority: 45 },

  {
    id: "checklistTick",
    key: "Space",
    label: "tick",
    hint: "[Space] tick",
    views: ["checklist"],
    priority: 70,
  },
  {
    id: "checklistPass",
    key: "P",
    label: "pass",
    hint: "[P] pass",
    views: ["checklist"],
    priority: 75,
  },
  {
    id: "checklistFail",
    key: "F",
    label: "fail",
    hint: "[F] fail",
    views: ["checklist"],
    priority: 75,
  },
  {
    id: "checklistStep",
    key: "j/k",
    label: "step",
    hint: "[j/k] step",
    views: ["checklist"],
    priority: 30,
  },
  {
    id: "checklistBack",
    key: "Esc",
    label: "back",
    hint: "[Esc] back",
    views: ["checklist"],
    priority: 90,
  },

  {
    id: "deskDetail",
    key: "Enter",
    label: "detail",
    hint: "[Enter] detail",
    views: ["desk", "overview"],
    when: (ctx) => ctx.hasRow,
    priority: 60,
  },
  {
    id: "deskMove",
    key: "j/k",
    label: "move",
    hint: "[j/k] move",
    views: ["desk", "overview"],
    when: (ctx) => ctx.hasRow,
    priority: 30,
  },
  {
    id: "deskOverview",
    key: "1",
    label: "overview",
    hint: "[1] overview",
    views: ["desk"],
    priority: 50,
  },
  { id: "deskQueue", key: "2", label: "queue", hint: "[2] queue", views: ["desk"], priority: 45 },
  {
    id: "deskChecklist",
    key: "4",
    label: "checklist",
    hint: "[4] checklist",
    views: ["desk"],
    priority: 35,
  },
  {
    id: "overviewQueue",
    key: "2",
    label: "queue",
    hint: "[2] queue",
    views: ["overview"],
    priority: 50,
  },
  {
    id: "overviewDesk",
    key: "3",
    label: "desk",
    hint: "[3] desk",
    views: ["overview"],
    priority: 48,
  },
  {
    id: "overviewPrivacy",
    key: "p",
    label: "privacy",
    hint: "[p] privacy",
    views: ["overview"],
    priority: 45,
  },

  {
    id: "planningOpen",
    key: "5",
    label: "planning",
    hint: "[5] planning",
    views: HOME_VIEWS,
    when: (ctx) => ctx.planningOpen,
    priority: 10,
  },
  {
    id: "offices",
    key: "o",
    label: "offices",
    hint: "[o] offices",
    views: HOME_VIEWS,
    priority: 40,
  },
  {
    id: "quit",
    key: "q",
    label: "quit",
    hint: (ctx) => `[q] quit${ctx.offline ? " (offline: actions disabled)" : ""}`,
    views: ["switcher", "card", "detail", ...HOME_VIEWS],
    priority: NEVER,
  },
];

/** The footer hints of `view`, in print order, as `[text, priority]`. */
export function footerHints(view: FooterView, ctx: FooterContext): [string, number][] {
  return FOOTER_KEYS.filter(
    (entry) => entry.views.includes(view) && (entry.when?.(ctx) ?? true),
  ).map((entry) => [
    typeof entry.hint === "function" ? entry.hint(ctx) : entry.hint,
    entry.priority,
  ]);
}
