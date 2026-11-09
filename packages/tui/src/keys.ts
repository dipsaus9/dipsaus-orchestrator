// The one key table of the TUI's actions (0009, DIPO-308, DIPO-458): which key sends which
// command, in which view, as `docs/design/tui-v2/keymap.json` binds it. Lowercase acts on the
// focused item, capitals spend or destroy (`R` run, `X` drop, `D` discard). The desk binds every
// action `office.desk` can list; the live agent detail adds `s` steer and `p` park, the queue `p`
// park and `X` drop, the test checklist `y` pass and `n` fail, and an overview row whose run asks
// offers `a` answer.
//
// On a desk row a key is offered only when the row's `actions` lists its command; a view's row
// binding wins over a global key (`n` rejects a merge, dismisses a proposed story or a decision
// note and declines a next up story; `y` approves a merge, accepts a proposed story and starts a
// next up story). The Desk's preview shows a row's bound actions as buttons with their `button`
// label, the first one primary (DIPO-459). An action no entry binds on its row, or
// whose key an earlier action of the row took, shows its `cli` line in the footer. An answer is
// always a text (0020). The desk's `i` hands the maintainer's quick idea to the audit (0022,
// DIPO-454) on any row. Client and daemon are one binary (0005), so every command in the table
// exists.
//
// The command palette (`palette.tsx`) and the keys overlay (`help.tsx`) read the same table,
// `NAV_KEYS` and `GLOBAL_KEYS` (DIPO-463). Stopping a run has no key: it is a palette row.

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
  | "stop"
  | "nextConfirm"
  | "nextDecline";

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
  readonly views: readonly ActionView[];
  /** Why the palette and the keys overlay list the action as off when `when` is false. */
  readonly why?: string;
  /** Its label on a Desk preview button, `…` when it asks for more (`Reject…`). */
  readonly button?: string;
}

/** A key and its label as the footer and a wide desk row print them: `y approve`. */
export function hintText(entry: { readonly key: string; readonly label: string }): string {
  return entry.key === "" ? entry.label : `${entry.key} ${entry.label}`;
}

/** The table, in the order a row's keys are shown and taken. */
export const KEY_TABLE: readonly KeyBinding[] = [
  {
    id: "answer",
    button: "Answer…",
    label: "answer",
    priority: 85,
    command: "work.answer",
    when: offered("work.answer"),
    key: "a",
    views: ["desk", "detail", "overview"],
  },
  {
    id: "approve",
    button: "Approve",
    why: "no merge waits",
    label: "approve",
    priority: 85,
    command: "gate.approve",
    when: offered("gate.approve"),
    key: "y",
    views: ["desk"],
  },
  {
    id: "reject",
    button: "Reject…",
    why: "no merge waits",
    label: "reject",
    priority: 85,
    command: "gate.reject",
    when: offered("gate.reject"),
    key: "n",
    views: ["desk"],
  },
  {
    id: "accept",
    button: "Accept",
    label: "accept",
    priority: 85,
    command: "idea.accept",
    when: offered("idea.accept"),
    key: "y",
    views: ["desk"],
  },
  {
    id: "dismiss",
    button: "Dismiss",
    label: "dismiss",
    priority: 85,
    command: "idea.dismiss",
    when: offered("idea.dismiss"),
    key: "n",
    views: ["desk"],
  },
  {
    id: "dismissNote",
    button: "Dismiss",
    label: "dismiss",
    priority: 85,
    command: "note.dismiss",
    when: offered("note.dismiss"),
    key: "n",
    views: ["desk"],
  },
  {
    id: "nextConfirm",
    why: "no story is offered as next up",
    label: "start it",
    button: "Start it",
    priority: 85,
    command: "nextUp.confirm",
    when: offered("nextUp.confirm"),
    key: "y",
    views: ["desk"],
  },
  {
    id: "nextDecline",
    why: "no story is offered as next up",
    label: "offer the next one",
    button: "Offer the next one",
    priority: 84,
    command: "nextUp.decline",
    when: offered("nextUp.decline"),
    key: "n",
    views: ["desk"],
  },
  {
    id: "idea",
    label: "idea…",
    priority: 30,
    command: "idea.add",
    when: () => true,
    key: "i",
    views: ["desk"],
  },
  {
    id: "resume",
    button: "Start again",
    why: "not parked",
    label: "start again",
    priority: 85,
    command: "work.resume",
    when: offered("work.resume"),
    key: "r",
    views: ["desk"],
  },
  {
    id: "test",
    button: "Test first",
    why: "no merge to test",
    label: "test",
    priority: 85,
    command: "test.start",
    when: offered("test.start"),
    key: "t",
    views: ["desk"],
  },
  {
    id: "park",
    button: "Park…",
    why: "nothing to park",
    label: "park",
    priority: 85,
    command: "story.park",
    when: offered("story.park"),
    key: "p",
    views: ["desk", "detail", "queue"],
  },
  {
    id: "drop",
    button: "Drop…",
    why: "nothing to drop",
    label: "drop",
    priority: 85,
    command: "story.drop",
    when: offered("story.drop"),
    key: "X",
    views: ["desk", "queue"],
  },
  {
    id: "discard",
    button: "Discard…",
    why: "nothing to discard",
    label: "discard",
    priority: 85,
    command: "work.discard",
    when: offered("work.discard"),
    key: "D",
    views: ["desk"],
  },
  {
    id: "steer",
    label: "steer",
    priority: 72,
    command: "work.steer",
    when: offered("work.steer"),
    key: "s",
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
    views: [],
    why: "no run is going",
  },
  {
    id: "pass",
    label: "pass",
    priority: 75,
    command: "test.record",
    when: offered("test.record"),
    key: "y",
    views: ["checklist"],
  },
  {
    id: "fail",
    label: "fail…",
    priority: 75,
    command: "test.record",
    when: offered("test.record"),
    key: "n",
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
  /** Below 100 columns: the Desk is one list, and ⏎ reads the focused item (DIPO-459). */
  readonly narrow: boolean;
  /** A planning session is open (the `P` key shows). */
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
  /** The word for it in the footer, help and the palette. */
  readonly label: string;
  /** The footer label when it depends on the screen, such as `save proposal 2`. */
  readonly text?: (ctx: FooterContext) => string;
  readonly views: readonly FooterView[];
  readonly when?: (ctx: FooterContext) => boolean;
  /** Footer drop order when the width is short: the lowest goes first, 100 never. */
  readonly priority: number;
  /** `right` for the global keys (esc back, q q quit); the verbs print left. */
  readonly side?: "left" | "right";
  /** The palette's row for the key on the focused item, such as `Expand stream to full screen`. */
  readonly palette?: string;
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
  const { key, label, priority } = binding(id);
  return { id: footerId, key, label, views, priority };
}

/** The footer's keys in the order they print. */
export const FOOTER_KEYS: readonly FooterKey[] = [
  {
    id: "pathOpen",
    key: "⏎",
    label: "open",
    views: ["path"],
    priority: NEVER,
  },
  {
    id: "pathCancel",
    key: "esc",
    label: "cancel",
    views: ["path"],
    priority: NEVER,
  },
  {
    id: "privacyYes",
    key: "y",
    label: "change it",
    views: ["privacy"],
    priority: NEVER,
  },
  {
    id: "privacyKeep",
    key: "any other key",
    label: "keep it",
    views: ["privacy"],
    priority: 50,
  },
  {
    id: "planningEndYes",
    key: "y",
    label: "end the session",
    views: ["planning"],
    when: asking,
    priority: NEVER,
  },
  {
    id: "planningEndKeep",
    key: "any other key",
    label: "keep it",
    views: ["planning"],
    when: asking,
    priority: 50,
  },
  {
    id: "planningSend",
    key: "ctrl-s",
    label: "send",
    text: (ctx) => (ctx.planning.session ? "send" : "start"),
    views: ["planning"],
    when: free,
    priority: NEVER,
  },
  {
    id: "planningSave",
    key: "ctrl-s",
    label: "save proposal",
    text: (ctx) => `save proposal ${ctx.planning.editing}`,
    views: ["planning"],
    when: saving,
    priority: NEVER,
  },
  {
    id: "planningReadySave",
    key: "ctrl-s",
    label: "set the stories left Ready",
    views: ["planning"],
    when: readying,
    priority: NEVER,
  },
  {
    id: "planningNewLine",
    key: "⏎",
    label: "new line",
    views: ["planning"],
    when: (ctx) => inInput(ctx) && !ctx.planning.readying,
    priority: 90,
  },
  {
    id: "planningKind",
    key: "tab",
    label: "kind",
    views: ["planning"],
    when: (ctx) => free(ctx) && !ctx.planning.session,
    priority: 80,
  },
  {
    id: "planningEnd",
    key: "ctrl-e",
    label: "end session",
    views: ["planning"],
    when: (ctx) => free(ctx) && ctx.planning.session,
    priority: 70,
  },
  {
    id: "planningConfirm",
    key: "ctrl-y",
    label: "confirm",
    views: ["planning"],
    when: proposing,
    priority: 78,
  },
  {
    id: "planningEdit",
    key: "ctrl-r",
    label: "edit",
    views: ["planning"],
    when: proposing,
    priority: 76,
  },
  {
    id: "planningSetReady",
    key: "ctrl-g",
    label: "set Ready",
    views: ["planning"],
    when: proposing,
    priority: 75,
  },
  {
    id: "planningDecline",
    key: "ctrl-d",
    label: "decline",
    views: ["planning"],
    when: proposing,
    priority: 74,
  },
  {
    id: "planningProposal",
    key: "↑↓",
    label: "proposal",
    views: ["planning"],
    when: proposing,
    priority: 72,
  },
  {
    id: "planningCancelEdit",
    key: "esc",
    label: "cancel the edit",
    views: ["planning"],
    when: saving,
    priority: 85,
  },
  {
    id: "planningReadyCancel",
    key: "esc",
    label: "cancel",
    views: ["planning"],
    when: readying,
    priority: 85,
  },
  {
    id: "dialogTake",
    key: "⏎",
    label: "take the answer",
    views: ["planning"],
    when: typingAnswer,
    priority: NEVER,
  },
  {
    id: "dialogOptions",
    key: "esc",
    label: "back to the options",
    views: ["planning"],
    when: typingAnswer,
    priority: 85,
  },
  {
    id: "dialogSend",
    key: "ctrl-s",
    label: "send the answers",
    text: (ctx) =>
      ctx.planning.dialog?.complete === true ? "send the answers" : "send (when all answered)",
    views: ["planning"],
    when: choosing,
    priority: NEVER,
  },
  {
    id: "dialogPick",
    key: "⏎",
    label: "pick",
    views: ["planning"],
    when: choosing,
    priority: 90,
  },
  {
    id: "dialogOption",
    key: "↑↓",
    label: "option",
    views: ["planning"],
    when: choosing,
    priority: 80,
  },
  {
    id: "dialogQuestion",
    key: "←→",
    label: "question",
    views: ["planning"],
    when: choosing,
    priority: 78,
  },
  {
    id: "dialogLeave",
    key: "ctrl-n",
    label: "write a message instead",
    views: ["planning"],
    when: choosing,
    priority: 70,
  },
  {
    id: "planningSending",
    key: "",
    label: "sending",
    views: ["planning"],
    when: (ctx) => editing(ctx) && ctx.planning.sending,
    priority: 60,
  },
  {
    id: "planningBack",
    key: "esc",
    label: "back",
    views: ["planning"],
    when: free,
    priority: 85,
    side: "right",
  },
  { id: "paletteRun", key: "⏎", label: "run", views: ["palette"], priority: NEVER },
  { id: "paletteChoose", key: "↑↓", label: "choose", views: ["palette"], priority: 70 },
  { id: "helpPalette", key: "⏎", label: "in the palette", views: ["help"], priority: 60 },
  { id: "paletteClose", key: "esc", label: "close", views: ["palette", "help"], priority: 90 },
  {
    id: "retroScroll",
    key: "↑↓",
    label: "scroll",
    views: ["retro"],
    priority: 30,
  },
  {
    id: "switcherMove",
    key: "↑↓",
    label: "move",
    views: ["switcher"],
    priority: 30,
  },
  {
    id: "switcherOpen",
    key: "⏎",
    label: "open",
    views: ["switcher"],
    priority: 70,
  },
  {
    id: "switcherNew",
    key: "a",
    label: "new path",
    views: ["switcher"],
    priority: 40,
  },

  { id: "cardSection", key: "←→", label: "section", views: ["card"], priority: 60 },
  { id: "cardScroll", key: "↑↓", label: "scroll", views: ["card"], priority: 30 },
  { id: "cardExpand", key: "⏎", label: "expand round", views: ["card"], priority: 50 },
  { id: "cardOpen", key: "o", label: "open on GitHub", views: ["card"], priority: 40 },
  { id: "cardCopy", key: "c", label: "copy id", views: ["card"], priority: 20 },

  { id: "detailStreams", key: "v", label: "stream", views: ["detail"], priority: 75 },
  { id: "detailScroll", key: "↑↓", label: "scroll", views: ["detail"], priority: 35 },
  { id: "detailFollow", key: "G", label: "follow", views: ["detail"], priority: 45 },
  {
    id: "detailExpand",
    key: "z",
    label: "expand",
    views: ["detail"],
    priority: 25,
    palette: "Expand stream to full screen",
  },
  {
    id: "detailCopy",
    key: "c",
    label: "copy id",
    views: ["detail"],
    priority: 20,
    palette: "Copy id",
  },

  { id: "settingsMove", key: "↑↓", label: "move", views: ["settings"], priority: 30 },
  { id: "settingsToggle", key: "⏎", label: "toggle", views: ["settings"], priority: 70 },

  { id: "queueMove", key: "↑↓", label: "move", views: ["queue"], priority: 30 },
  { id: "queueStory", key: "⏎", label: "story", views: ["queue"], priority: 60 },
  { id: "queueRun", key: "R", label: "run", views: ["queue"], priority: 70 },
  { id: "queueDone", key: ".", label: "show done", views: ["queue"], priority: 20 },
  {
    id: "queueCopy",
    key: "c",
    label: "copy id",
    views: ["queue"],
    when: (ctx) => ctx.hasRow,
    priority: 15,
  },

  { id: "checklistStep", key: "↑↓", label: "step", views: ["checklist"], priority: 30 },
  { id: "checklistTick", key: "space", label: "tick", views: ["checklist"], priority: 70 },
  fromTable("pass", "checklistPass", ["checklist"]),
  fromTable("fail", "checklistFail", ["checklist"]),

  {
    id: "deskMove",
    key: "↑↓",
    label: "move",
    views: ["desk", "overview"],
    when: (ctx) => ctx.hasRow,
    priority: 30,
  },
  {
    id: "deskOpen",
    key: "⏎",
    label: "open",
    views: ["overview"],
    when: (ctx) => ctx.hasRow,
    priority: 60,
  },
  {
    id: "deskStory",
    key: "⏎",
    label: "open story",
    text: (ctx) => (ctx.narrow ? "read" : "open story"),
    views: ["desk"],
    when: (ctx) => ctx.hasRow,
    priority: 60,
  },
  {
    id: "deskCopy",
    key: "c",
    label: "copy id",
    views: ["desk", "overview"],
    when: (ctx) => ctx.hasRow,
    priority: 15,
  },

  // The global keys, at the right end of the footer.
  {
    id: "back",
    key: "esc",
    label: "back",
    views: ["switcher", "card", "detail", "settings", "checklist", "retro"],
    when: (ctx) => ctx.office,
    priority: 90,
    side: "right",
  },
  {
    id: "plan",
    key: "P",
    label: "plan",
    views: HOME_VIEWS,
    when: (ctx) => ctx.planningOpen,
    priority: 10,
    side: "right",
  },
  {
    id: "palette",
    key: ":",
    label: "commands",
    views: ["overview", "desk", "queue"],
    priority: 35,
    side: "right",
  },
  {
    id: "help",
    key: "?",
    label: "keys",
    views: ["overview", "desk", "queue"],
    priority: 32,
    side: "right",
  },
  {
    id: "offices",
    key: "O",
    label: "offices",
    views: ["overview", "desk", "queue"],
    priority: 40,
    side: "right",
  },
  {
    id: "quit",
    key: "q q",
    label: "quit",
    views: ["switcher", "card", "detail", "retro", ...HOME_VIEWS],
    priority: NEVER,
    side: "right",
  },
];

/** The keys the footer keeps while offline: reading still works, actions are off (0009). */
const OFFLINE_KEYS: ReadonlySet<string> = new Set([
  "deskMove",
  "deskOpen",
  "deskStory",
  "queueMove",
  "queueStory",
  "switcherMove",
  "cardSection",
  "cardScroll",
  "detailScroll",
  "detailFollow",
  "detailStreams",
  "settingsMove",
  "checklistStep",
  "retroScroll",
  "back",
  "quit",
]);

/** A footer hint: the key in acc, its label, and the side it prints on (DIPO-458). */
export interface Hint {
  readonly key: string;
  readonly label: string;
  /** Footer drop order when the width is short: the lowest goes first, 100 never. */
  readonly priority: number;
  /** Verbs for the focused item print left, the global keys right. */
  readonly side?: "left" | "right";
  /** A hint that is a warning, such as `actions off while offline`, prints in err. */
  readonly warning?: boolean;
}

/** The footer hints of `view` in print order; offline only the reading keys stay (keymap.json). */
export function footerHints(view: FooterView, ctx: FooterContext): Hint[] {
  return FOOTER_KEYS.filter(
    (entry) =>
      entry.views.includes(view) &&
      (entry.when?.(ctx) ?? true) &&
      (!ctx.offline || OFFLINE_KEYS.has(entry.id)),
  ).map((entry) => ({
    key: entry.key,
    label: typeof entry.text === "function" ? entry.text(ctx) : entry.label,
    priority: entry.priority,
    ...(entry.side === undefined ? {} : { side: entry.side }),
  }));
}

/** Where a navigation key goes: the rooms of the Frame, the Plan view and the offices. */
export type NavTo = "desk" | "overview" | "queue" | "retro" | "planning" | "offices";

export interface NavKey {
  readonly id: NavTo;
  readonly key: string;
  readonly label: string;
}

/** The keys that go to a room or view from anywhere; the palette's GO TO and the keys overlay read them. */
export const NAV_KEYS: readonly NavKey[] = [
  { id: "desk", key: "1", label: "Desk" },
  { id: "overview", key: "2", label: "Floor" },
  { id: "queue", key: "3", label: "Queue" },
  { id: "retro", key: "4", label: "Retro" },
  { id: "planning", key: "P", label: "Plan" },
  { id: "offices", key: "O", label: "Open offices…" },
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

const ROOMS: readonly NavTo[] = ["desk", "overview", "queue", "retro"];
const roomKeys = NAV_KEYS.filter((nav) => ROOMS.includes(nav.id)).map((nav) => nav.key);

/** The keys that work anywhere: the rooms as one range, then the other NAV_KEYS and the tools. */
export const GLOBAL_KEYS: readonly PlainKey[] = [
  { key: `${roomKeys[0]}–${roomKeys.at(-1)}`, label: "rooms" },
  ...NAV_KEYS.filter((nav) => !ROOMS.includes(nav.id)).map((nav) => ({
    key: nav.key,
    label: nav.label.replace("Open ", "").replace("…", "").toLowerCase(),
  })),
  { key: ": ctrl-k", label: "all commands" },
  { key: "?", label: "keys" },
  { key: "q q", label: "quit (daemon keeps working)" },
];
