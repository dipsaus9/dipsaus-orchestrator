// The one key table of the TUI's actions (0009, DIPO-308): which key sends which
// command, in which view. The desk binds every action `office.desk` can list; the live agent detail
// adds `s` steer and `P` park, the queue `P` park and `d` drop, and an overview row whose run asks
// offers `a` answer.
//
// On a desk row a key is offered only when the row's `actions` lists its command; a view's row
// binding wins over a global key (`n` rejects a merge and dismisses a proposed story or a decision
// note, `y` approves a merge and accepts a proposed story). An action no entry binds on its row, or
// whose key an earlier action of the row took, shows its `cli` line in the footer. An answer is
// always a text (0020). The desk's `i` hands the maintainer's quick idea to the audit (0022,
// DIPO-454) on any row. Client and daemon are one binary (0005), so every command in the table
// exists.

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
  | "dismissNote"
  | "idea"
  | "steer"
  | "pass"
  | "fail"
  | "stop";

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
  /** Why the palette and the keys overlay list the action as off when `when` is false. */
  readonly why?: string;
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
    why: "no merge waits",
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
    why: "no merge waits",
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
    command: "idea.accept",
    when: offered("idea.accept"),
    key: "y",
    hint: "[y] accept",
    views: ["desk"],
  },
  {
    id: "dismiss",
    label: "dismiss",
    priority: 85,
    command: "idea.dismiss",
    when: offered("idea.dismiss"),
    key: "n",
    hint: "[n] dismiss",
    views: ["desk"],
  },
  {
    id: "dismissNote",
    label: "dismiss",
    priority: 85,
    command: "note.dismiss",
    when: offered("note.dismiss"),
    key: "n",
    hint: "[n] dismiss",
    views: ["desk"],
  },
  {
    id: "idea",
    label: "idea…",
    priority: 30,
    command: "idea.add",
    when: () => true,
    key: "i",
    hint: "[i]dea",
    views: ["desk"],
  },
  {
    id: "resume",
    why: "not parked",
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
    why: "no merge to test",
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
    why: "nothing to park",
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
    why: "nothing to drop",
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
    why: "nothing to discard",
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
  // Stopping a run has no key (0009): it is a palette row, which asks first (`actions.ts`).
  {
    id: "stop",
    label: "stop run",
    priority: 0,
    command: "story.park",
    when: offered("story.park"),
    key: "",
    hint: "",
    views: [],
    why: "no run is going",
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
    case "idea.accept":
    case "idea.dismiss":
      return item.idea !== undefined;
    case "note.dismiss":
      return item.note !== undefined;
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

/**
 * The keys a view offers without a row's `actions` (the detail's steer and park, the queue's, the
 * desk's quick idea).
 */
export function viewKeys(view: ActionView, ctx?: RowContext): KeyBinding[] {
  return KEY_TABLE.filter(
    (entry) =>
      entry.views.includes(view) &&
      (ctx === undefined || entry.when(ctx)) &&
      (view !== "detail" || entry.id === "steer" || entry.id === "park") &&
      (view !== "queue" || entry.id === "park" || entry.id === "drop") &&
      (view !== "desk" || entry.id === "idea"),
  );
}

/** The screens a footer key belongs to; `ended` and `detail` share the live agent detail's keys. */
export type FooterView =
  | "path"
  | "privacy"
  | "switcher"
  | "planning"
  | "retro"
  | "palette"
  | "help"
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
    /** The number of the proposal whose form the input holds (DIPO-450). */
    readonly editing: number | null;
    /** The session has proposals. */
    readonly proposals: boolean;
    /** The input holds the list of stories to set Ready (DIPO-451). */
    readonly readying: boolean;
    /**
     * The question dialog is open (DIPO-455): whether a free answer is being typed and whether
     * every question has an answer; null without a dialog.
     */
    readonly dialog: { readonly typing: boolean; readonly complete: boolean } | null;
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
/** The question dialog has the keys (DIPO-455); the input's keys wait under it. */
const inDialog = (ctx: FooterContext) =>
  !ctx.planning.confirmingEnd && ctx.planning.dialog !== null;
const typingAnswer = (ctx: FooterContext) => inDialog(ctx) && ctx.planning.dialog?.typing === true;
const choosing = (ctx: FooterContext) => inDialog(ctx) && ctx.planning.dialog?.typing === false;
const inInput = (ctx: FooterContext) => !ctx.planning.confirmingEnd && ctx.planning.dialog === null;
const free = (ctx: FooterContext) =>
  inInput(ctx) && ctx.planning.editing === null && !ctx.planning.readying;
const editing = (ctx: FooterContext) => !ctx.planning.confirmingEnd;
const readying = (ctx: FooterContext) => inInput(ctx) && ctx.planning.readying;
const saving = (ctx: FooterContext) =>
  inInput(ctx) && ctx.planning.editing !== null && !ctx.planning.readying;
const proposing = (ctx: FooterContext) => free(ctx) && ctx.planning.proposals;

/** A footer key for an action of the key table, so the action's key is defined once. */
function fromTable(id: ActionId, footerId: string, views: readonly FooterView[]): FooterKey {
  const { key, label, hint, priority } = binding(id);
  return { id: footerId, key, label, hint, views, priority };
}

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
    when: free,
    priority: NEVER,
  },
  {
    id: "planningSave",
    key: "Ctrl-S",
    label: "save proposal",
    hint: (ctx) => `[Ctrl-S] save proposal ${ctx.planning.editing}`,
    views: ["planning"],
    when: saving,
    priority: NEVER,
  },
  {
    id: "planningReadySave",
    key: "Ctrl-S",
    label: "set the stories left Ready",
    hint: "[Ctrl-S] set the stories left Ready",
    views: ["planning"],
    when: readying,
    priority: NEVER,
  },
  {
    id: "planningNewLine",
    key: "Enter",
    label: "new line",
    hint: "[Enter] new line",
    views: ["planning"],
    when: (ctx) => inInput(ctx) && !ctx.planning.readying,
    priority: 90,
  },
  {
    id: "planningKind",
    key: "Tab",
    label: "kind",
    hint: "[Tab] kind",
    views: ["planning"],
    when: (ctx) => free(ctx) && !ctx.planning.session,
    priority: 80,
  },
  {
    id: "planningEnd",
    key: "Ctrl-E",
    label: "end session",
    hint: "[Ctrl-E] end session",
    views: ["planning"],
    when: (ctx) => free(ctx) && ctx.planning.session,
    priority: 70,
  },
  {
    id: "planningConfirm",
    key: "Ctrl-Y",
    label: "confirm",
    hint: "[Ctrl-Y] confirm",
    views: ["planning"],
    when: proposing,
    priority: 78,
  },
  {
    id: "planningEdit",
    key: "Ctrl-R",
    label: "edit",
    hint: "[Ctrl-R] edit",
    views: ["planning"],
    when: proposing,
    priority: 76,
  },
  {
    id: "planningSetReady",
    key: "Ctrl-G",
    label: "set Ready",
    hint: "[Ctrl-G] set Ready",
    views: ["planning"],
    when: proposing,
    priority: 75,
  },
  {
    id: "planningDecline",
    key: "Ctrl-D",
    label: "decline",
    hint: "[Ctrl-D] decline",
    views: ["planning"],
    when: proposing,
    priority: 74,
  },
  {
    id: "planningProposal",
    key: "Up/Down",
    label: "proposal",
    hint: "[Up/Down] proposal",
    views: ["planning"],
    when: proposing,
    priority: 72,
  },
  {
    id: "planningCancelEdit",
    key: "Esc",
    label: "cancel the edit",
    hint: "[Esc] cancel the edit",
    views: ["planning"],
    when: saving,
    priority: 85,
  },
  {
    id: "planningReadyCancel",
    key: "Esc",
    label: "cancel",
    hint: "[Esc] cancel",
    views: ["planning"],
    when: readying,
    priority: 85,
  },
  {
    id: "dialogTake",
    key: "Enter",
    label: "take the answer",
    hint: "[Enter] take the answer",
    views: ["planning"],
    when: typingAnswer,
    priority: NEVER,
  },
  {
    id: "dialogOptions",
    key: "Esc",
    label: "back to the options",
    hint: "[Esc] back to the options",
    views: ["planning"],
    when: typingAnswer,
    priority: 85,
  },
  {
    id: "dialogSend",
    key: "Ctrl-S",
    label: "send the answers",
    hint: (ctx) =>
      ctx.planning.dialog?.complete === true
        ? "[Ctrl-S] send the answers"
        : "[Ctrl-S] send (when all answered)",
    views: ["planning"],
    when: choosing,
    priority: NEVER,
  },
  {
    id: "dialogPick",
    key: "Enter",
    label: "pick",
    hint: "[Enter] pick",
    views: ["planning"],
    when: choosing,
    priority: 90,
  },
  {
    id: "dialogOption",
    key: "Up/Down",
    label: "option",
    hint: "[Up/Down] option",
    views: ["planning"],
    when: choosing,
    priority: 80,
  },
  {
    id: "dialogQuestion",
    key: "Left/Right",
    label: "question",
    hint: "[Left/Right] question",
    views: ["planning"],
    when: choosing,
    priority: 78,
  },
  {
    id: "dialogLeave",
    key: "Ctrl-N",
    label: "write a message instead",
    hint: "[Ctrl-N] write a message instead",
    views: ["planning"],
    when: choosing,
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
    when: free,
    priority: 85,
  },
  {
    id: "paletteRun",
    key: "Enter",
    label: "run",
    hint: "[Enter] run",
    views: ["palette"],
    priority: NEVER,
  },
  {
    id: "paletteMove",
    key: "Up/Down",
    label: "choose",
    hint: "[Up/Down] choose",
    views: ["palette"],
    priority: 70,
  },
  {
    id: "paletteClose",
    key: "Esc",
    label: "close",
    hint: "[Esc] close",
    views: ["palette", "help"],
    priority: 90,
  },
  {
    id: "helpPalette",
    key: "Enter",
    label: "in the palette",
    hint: "[Enter] in the palette",
    views: ["help"],
    priority: 60,
  },
  {
    id: "retroScroll",
    key: "j/k",
    label: "scroll",
    hint: "[j/k] scroll",
    views: ["retro"],
    priority: 30,
  },
  {
    id: "retroBack",
    key: "Esc",
    label: "back",
    hint: "[Esc] back",
    views: ["retro"],
    priority: 90,
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
  fromTable("pass", "checklistPass", ["checklist"]),
  fromTable("fail", "checklistFail", ["checklist"]),
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
    id: "planningOpen",
    key: "P",
    label: "planning",
    hint: "[P] planning",
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
    id: "palette",
    key: ":",
    label: "commands",
    hint: "[:] commands",
    views: [...HOME_VIEWS, "retro"],
    priority: 20,
  },
  {
    id: "help",
    key: "?",
    label: "keys",
    hint: "[?] keys",
    views: [...HOME_VIEWS, "retro"],
    priority: 25,
  },
  {
    id: "quit",
    key: "q",
    label: "quit",
    hint: (ctx) => `[q] quit${ctx.offline ? " (offline: actions disabled)" : ""}`,
    views: ["switcher", "card", "detail", "retro", ...HOME_VIEWS],
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

/** Where a navigation key goes: the rooms of the Frame, the Plan view and the offices. */
export type NavTo = "overview" | "queue" | "desk" | "checklist" | "planning" | "retro" | "offices";

export interface NavKey {
  readonly id: NavTo;
  readonly key: string;
  readonly label: string;
}

/** The keys that go to a room or view from anywhere in home; the palette's GO TO and the keys overlay read them. */
export const NAV_KEYS: readonly NavKey[] = [
  { id: "overview", key: "1", label: "Overview" },
  { id: "queue", key: "2", label: "Queue" },
  { id: "desk", key: "3", label: "Your desk" },
  { id: "checklist", key: "4", label: "Checklist" },
  { id: "planning", key: "P", label: "Plan" },
  { id: "retro", key: "6", label: "Retro" },
  { id: "offices", key: "o", label: "Open offices…" },
];

/** A key that moves, and the global keys the keys overlay prints next to the focused item's. */
export interface PlainKey {
  readonly key: string;
  readonly label: string;
}

export const MOVE_KEYS: readonly PlainKey[] = [
  { key: "↑↓ jk", label: "move" },
  { key: "⏎", label: "open" },
  { key: "esc", label: "back" },
];

export const GLOBAL_KEYS: readonly PlainKey[] = [
  ...NAV_KEYS.map(({ key, label }) => ({ key, label: label.replace("…", "").toLowerCase() })),
  { key: ":", label: "all commands" },
  { key: "ctrl-k", label: "all commands" },
  { key: "?", label: "keys" },
  { key: "q q", label: "quit (daemon keeps working)" },
];
