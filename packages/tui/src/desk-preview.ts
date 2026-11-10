// The Desk's preview (spec.md, Desk; screens/01, 11, 14 and 15): everything the focused item needs
// the maintainer to decide, from its `DeskItem` and nothing the TUI works out itself. A dim
// `KIND · why` line, the bold title, the pipeline of a running story, the full text wrapped at 60
// columns, dim labels padded to 8, then the item's bound actions as buttons (the `y` one primary,
// else the first), the action's consequence line (`DeskAction.consequence`, else the TUI's own
// sentence for the command) and its `$ dipo …` line, so the TUI teaches the CLI; the command lines
// of the actions no key sends follow. A budget-exceeded park and a failed run read as the state
// cards of screens/15. Nothing in the preview is cut: every text wraps.

import type { DeskAction, DeskItem } from "@dipsaus-orchestrator/contract";
import { KNOWN_PHASES } from "@dipsaus-orchestrator/contract";

import { age, wrapWords } from "./format";
import { type BoundAction, rowKeys } from "./keys";
import { seg, type Seg, type SegLine } from "./segments";
import { clockTime, glyphs } from "./views";

/** The widest the preview's prose runs, whatever the pane (spec.md: wrapped at 60 columns). */
export const PREVIEW_MEASURE = 60;

/** What the preview reads besides the item: the store's facts about its story, the time. */
export interface PreviewContext {
  readonly width: number;
  readonly now: number;
  readonly ascii: boolean;
  /** The story's title, from the office snapshot; null when the store has no such story. */
  readonly title: string | null;
  /** The phase of the story's live work, for the pipeline line; null when it has none. */
  readonly phase: string | null;
  /** The stories it waits on (`StoryView.waitingOn`). */
  readonly waitingOn: readonly string[];
  /** The open prompt's rows when its action is on this item: they take the buttons' place. */
  readonly prompt: readonly SegLine[] | null;
}

/**
 * The TUI's sentence for a command, until the engine sends the action's `consequence`
 * (migration.md, addition 5): the action's own line wins.
 */
export const CONSEQUENCE_FALLBACK: Readonly<Record<string, string>> = {
  "idea.accept": "Accepting files it as a Backlog draft. You refine it in a triage session.",
  "gate.approve": "Approve merges once the checks pass on the close-out head.",
  "work.answer": "The worker gets it on resume, and the run continues.",
  "work.resume": "A fresh session starts with a handoff. The box and branch are kept.",
  "nextUp.confirm":
    "Nothing starts until you confirm. Declined stories return once their task file changes.",
};

/** An action's consequence line: the engine's, else the fallback for its command. */
export function consequenceOf(action: DeskAction): string | undefined {
  return action.consequence ?? CONSEQUENCE_FALLBACK[action.command];
}

/** The kind as the Desk names it: PROFILE is a setup issue (spec.md, Vocabulary). */
export function kindName(kind: string): string {
  return kind === "PROFILE" ? "SETUP" : kind;
}

/** The park reasons a run failed with, which preview as the run-failed card (screens/15). */
const FAILED_REASONS: ReadonlySet<string> = new Set([
  "verify-failing",
  "worker-failed",
  "conflict",
]);

/** What a failed park's title says happened. */
const FAILED_WORDS: Readonly<Record<string, string>> = {
  "verify-failing": "failed in verify",
  "worker-failed": "failed: its worker stopped",
  conflict: "stopped on a conflict",
};

/** How long ago, in words: `7 min ago`, `3h ago`. */
function agoWords(ms: number): string {
  const short = age(ms);
  return short.endsWith("m") ? `${short.slice(0, -1)} min ago` : `${short} ago`;
}

/** `1 Refined, not Ready yet`, or ""; those stories wait for you, not for the item (DIPO-484). */
function refinedText(item: DeskItem): string {
  return (item.refined ?? []).length === 0 ? "" : `${item.refined?.length} Refined, not Ready yet`;
}

/** `blocks 3`, or "". */
function blocksText(item: DeskItem): string {
  return item.blocks.length === 0 ? "" : `blocks ${item.blocks.length}`;
}

/** Where an idea came from, as its kind line says it: `follow-up to DIPO-447`. */
function ideaWhy(item: DeskItem): string {
  const idea = item.idea;
  if (idea === undefined) return "";
  const source = idea.story.sourceStory ?? item.story;
  if (source !== undefined) return `follow-up to ${source}`;
  if (idea.origin === "quick") return "your quick idea";
  if (idea.origin === "aside") return "a planning session's aside";
  return idea.origin;
}

/** The dim kind line: `MERGE · waits for you`, `PARKED · budget-exceeded · 31m · blocks 3`. */
function kindLine(item: DeskItem, ctx: PreviewContext): string {
  const { dot } = glyphs(ctx.ascii);
  const waited = age(ctx.now - Date.parse(item.since));
  const parts: string[] = [kindName(item.kind)];
  switch (item.kind) {
    case "MERGE":
      parts.push("waits for you");
      break;
    case "QUESTION":
      parts.push(`worker waiting ${waited}`);
      break;
    case "PARKED":
    case "PARKED BY YOU":
      parts.push(item.reason ?? "", waited, blocksText(item), refinedText(item));
      break;
    case "PROPOSED STORY":
      parts.push(ideaWhy(item));
      break;
    case "NEXT UP":
      parts.push("a run slot is free");
      break;
    case "STARTS PAUSED":
      parts.push("whole office", `since ${clockTime(Date.parse(item.since))}`);
      break;
    default:
      parts.push(waited);
  }
  return parts.filter((part) => part !== "").join(` ${dot} `);
}

/** The bold title: the story with its title, or what the item is about. */
export function previewTitle(item: DeskItem, title: string | null): string {
  const story = item.story === undefined ? null : String(item.story);
  if (item.kind === "STARTS PAUSED") return "No new sessions start in this office";
  if (item.idea !== undefined) return item.idea.title;
  if (item.note !== undefined) return item.note.title;
  if (story !== null && item.kind === "PARKED" && item.reason === "budget-exceeded") {
    return `${story} paused: token budget reached`;
  }
  if (story !== null && item.kind === "PARKED" && FAILED_REASONS.has(item.reason ?? "")) {
    return `${story} ${FAILED_WORDS[item.reason ?? ""] ?? item.reason}`;
  }
  if (story === null) return item.detail;
  return title === null ? story : `${story} ${title}`;
}

/**
 * The pipeline line (spec.md, Show the pipeline): finished phases ok and joined by `━━`, the current
 * one `● name` in acc (`✗ name` in err for a failed run), the ones to come faint behind `┄┄`.
 */
export function pipelineLine(phase: string, failed: boolean, ascii: boolean): SegLine {
  const g = glyphs(ascii);
  const done = g.done.repeat(2);
  const dotted = ascii ? ".." : "┄┄";
  const at = (KNOWN_PHASES as readonly string[]).indexOf(phase);
  const out: Seg[] = [];
  KNOWN_PHASES.forEach((name, i) => {
    if (i < at) out.push(seg(`${name} ${done} `, "ok"));
    else if (i === at) {
      out.push(failed ? seg(`${g.failed} ${name}`, "err") : seg(`${g.live} ${name}`, "acc"));
    } else out.push(seg(` ${dotted} ${name}`, "faint"));
  });
  return out;
}

/** The labelled rows: a dim label padded to 8, the value wrapped under itself. */
function labelled(label: string, value: string, width: number, role?: Seg["role"]): SegLine[] {
  const lines = wrapWords(value, Math.max(10, Math.min(PREVIEW_MEASURE, width) - 8));
  return lines.map((line, i): SegLine => [
    seg((i === 0 ? label : "").padEnd(8), "dim"),
    seg(line, role),
  ]);
}

/** Prose wrapped at the measure. */
function prose(text: string, width: number, role?: Seg["role"]): SegLine[] {
  return wrapWords(text, Math.min(PREVIEW_MEASURE, width)).map((line): SegLine => [
    seg(line, role),
  ]);
}

/** A MERGE item's CI row: the required checks and where they stand. */
function checksRow(item: DeskItem, ctx: PreviewContext): SegLine[] {
  const checks = item.pr?.checks;
  if (checks === undefined) return [];
  const g = glyphs(ctx.ascii);
  const many = `${checks.required} required check${checks.required === 1 ? "" : "s"}`;
  const [glyph, role, words] =
    checks.state === "passed"
      ? [g.met, "ok" as const, `${many} green`]
      : checks.state === "failed"
        ? [g.failed, "err" as const, `${many}, failing`]
        : [g.live, "acc" as const, `${many} pending`];
  return [[seg("CI".padEnd(8), "dim"), seg(glyph, role), seg(` ${words}`)]];
}

/** A MERGE item's Change row: `6 files · +214 −38`. */
function changeRow(item: DeskItem, ctx: PreviewContext): SegLine[] {
  const change = item.pr?.change;
  if (change === undefined) return [];
  const { dot } = glyphs(ctx.ascii);
  const minus = ctx.ascii ? "-" : "−";
  const files = `${change.files} file${change.files === 1 ? "" : "s"}`;
  return labelled(
    "Change",
    `${files} ${dot} +${change.additions} ${minus}${change.deletions}`,
    ctx.width,
  );
}

/** The labelled facts of the item's kind. */
function factRows(item: DeskItem, ctx: PreviewContext): SegLine[] {
  const { dot } = glyphs(ctx.ascii);
  const rows: SegLine[] = [];
  const blocks = item.blocks.join(` ${dot} `);
  const refined = (item.refined ?? []).map(
    (entry) =>
      `${entry.story} Refined, not Ready yet${entry.reason === undefined ? "" : `: ${entry.reason}`}`,
  );
  switch (item.kind) {
    case "MERGE":
      rows.push(...labelled("Why", item.detail, ctx.width));
      rows.push(...checksRow(item, ctx), ...changeRow(item, ctx));
      break;
    case "PROPOSED STORY": {
      const idea = item.idea;
      if (idea === undefined) break;
      rows.push(...labelled("Why", idea.story.why, ctx.width));
      if (blocks !== "") rows.push(...labelled("Blocks", blocks, ctx.width));
      if (idea.story.tier !== undefined) rows.push(...labelled("Size", idea.story.tier, ctx.width));
      const raiser = idea.raisedBy;
      const by =
        raiser === undefined
          ? ""
          : ` by ${raiser.role}${raiser.model === undefined ? "" : ` (${raiser.model})`}`;
      rows.push(
        ...labelled("Raised", `${agoWords(ctx.now - Date.parse(item.since))}${by}`, ctx.width),
      );
      return rows;
    }
    case "NEXT UP":
      rows.push(...labelled("Why", item.detail, ctx.width));
      break;
    case "STARTS PAUSED":
      rows.push(...labelled("Reason", item.detail, ctx.width));
      if (item.hand !== undefined) rows.push(...labelled("Lifts", item.hand, ctx.width));
      return rows;
    default:
      break;
  }
  if (blocks !== "") rows.push(...labelled("Blocks", blocks, ctx.width));
  for (const text of refined) rows.push(...labelled("Refined", text, ctx.width));
  if (item.hand !== undefined) rows.push(...labelled("By hand", item.hand, ctx.width));
  return rows;
}

/** The text in full under the title, for the kinds whose detail is not a labelled fact. */
function textRows(item: DeskItem, ctx: PreviewContext, title: string): SegLine[] {
  if (item.idea !== undefined) return prose(item.idea.story.storyLine, ctx.width);
  if (["MERGE", "NEXT UP", "STARTS PAUSED"].includes(item.kind)) return [];
  if (item.detail === title) return [];
  if (item.kind === "PARKED" && item.reason === "scope-violation") {
    return [
      ...prose("Not resumable: a part touched a protected file.", ctx.width),
      ...prose(item.detail, ctx.width),
    ];
  }
  const parked = item.kind === "PARKED" && item.reason === "budget-exceeded";
  return prose(item.detail, ctx.width, parked ? "dim" : undefined);
}

/** One button: `⟦ y Approve ⟧`, its brackets acc when it is the primary one, else faint. */
function button(key: string, label: string, primary: boolean, ascii: boolean): Seg[] {
  const [open, close] = ascii ? ["[", "]"] : ["⟦", "⟧"];
  const edge = primary ? ("acc" as const) : ("faint" as const);
  return [seg(open, edge), seg(" "), seg(key, "acc"), seg(` ${label} `), seg(close, edge)];
}

/** The buttons, two spaces apart, wrapped onto more rows when the pane is narrow. */
function buttonRows(buttons: readonly Seg[][], width: number): SegLine[] {
  const rows: Seg[][] = [];
  let row: Seg[] = [];
  let used = 0;
  for (const piece of buttons) {
    const size = piece.reduce((sum, part) => sum + part.text.length, 0);
    if (row.length > 0 && used + 2 + size > width) {
      rows.push(row);
      row = [];
      used = 0;
    }
    if (row.length > 0) {
      row.push(seg("  "));
      used += 2;
    }
    row.push(...piece);
    used += size;
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

/** The action the consequence and the `$` line are about: the one `y` sends, else the first. */
function mainAction(bound: readonly BoundAction[], item: DeskItem): DeskAction | undefined {
  return bound.find((entry) => entry.binding.key === "y")?.action ?? item.actions[0];
}

/** A key and its label as the state cards print them: `r start again`. */
function keyHint(k: string, label: string): Seg[] {
  return [seg(k, "acc"), seg(` ${label}`)];
}

/** The key line of the state cards of screens/15, for a budget park and a failed run. */
function stateKeys(item: DeskItem, ctx: PreviewContext): SegLine[] | null {
  if (item.kind !== "PARKED" || !item.actions.some((a) => a.command === "work.resume")) return null;
  const { dot } = glyphs(ctx.ascii);
  if (item.reason === "budget-exceeded") {
    return [
      [
        ...keyHint("r", `start again with a top-up: +25% ${dot} +50% ${dot} +100%`),
        seg("   "),
        ...keyHint("⏎", "inspect"),
      ],
    ];
  }
  if (FAILED_REASONS.has(item.reason ?? "")) {
    return [
      [
        ...keyHint("r", "start again"),
        seg("   "),
        ...keyHint("s", "start again with a hint"),
        seg("   "),
        ...keyHint("⏎", "open run"),
      ],
    ];
  }
  return null;
}

/** The preview of `item`, row by row, at `ctx.width` cells. */
export function previewLines(item: DeskItem, ctx: PreviewContext): SegLine[] {
  const g = glyphs(ctx.ascii);
  const width = Math.max(20, ctx.width);
  const title = previewTitle(item, ctx.title);
  const out: SegLine[] = [[seg(kindLine(item, ctx), "dim")]];
  out.push(...wrapWords(title, width).map((line): SegLine => [seg(line, "hi", true)]));
  const failed = item.kind === "PARKED" && FAILED_REASONS.has(item.reason ?? "");
  if (ctx.phase !== null) out.push(pipelineLine(ctx.phase, failed, ctx.ascii));
  const text = textRows(item, { ...ctx, width }, title);
  if (text.length > 0) out.push([], ...text);
  if (ctx.waitingOn.length > 0)
    out.push([], ...prose(`Waiting on ${ctx.waitingOn.join(", ")}`, width));
  const facts = factRows(item, { ...ctx, width });
  if (facts.length > 0) out.push([], ...facts);
  if (item.kind === "STARTS PAUSED") {
    out.push([], [seg(`${g.met} Nothing to do. Look away until it lifts.`, "ok")]);
  }
  out.push([]);
  if (ctx.prompt !== null) {
    out.push(...ctx.prompt);
    return out;
  }
  const keys = rowKeys(item);
  const state = stateKeys(item, ctx);
  if (state !== null) out.push(...state);
  else {
    const buttons = keys.bound.map((entry, i) => {
      const label =
        entry.binding.id === "approve" && item.kind === "PARKED"
          ? "Overrule…"
          : (entry.binding.button ?? entry.binding.label);
      return button(entry.binding.key, label, i === 0, ctx.ascii);
    });
    if (item.pr !== undefined) buttons.push(button("o", "PR", buttons.length === 0, ctx.ascii));
    if (buttons.length > 0) out.push(...buttonRows(buttons, width));
  }
  const main = mainAction(keys.bound, item);
  const consequence = main === undefined ? undefined : consequenceOf(main);
  const tail: SegLine[] = [];
  if (consequence !== undefined) tail.push(...prose(consequence, width, "dim"));
  const clis = [
    ...(main === undefined ? [] : [main.cli]),
    ...keys.unbound.map((action) => action.cli),
  ].filter((cli, i, all) => all.indexOf(cli) === i);
  for (const cli of clis)
    tail.push(...wrapWords(`$ ${cli}`, width).map((line): SegLine => [seg(line, "dim")]));
  if (tail.length > 0) out.push([], ...tail);
  return out;
}
