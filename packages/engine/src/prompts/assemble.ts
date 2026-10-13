// The `implement` task message, L4 (0014 sections 2, 4 and 5): long reference material first, the
// story contract and feedback last, each section in its tag and present only under its 0014
// condition. Every section has a budget; over the total cap, sections drop in the order
// dependencies, background, context tail, inputs content (the path list stays), each with a
// marker. The contract is never cut. Rendering is deterministic: the same story, pack, handoff
// and feedback give the same bytes.

import type { OfficeConfig } from "../config/schema";
import type { ContextItem, ContextPack, SizeClass } from "../context/types";
import { formatCount } from "../context/truncate";
import {
  assembleContract,
  CONTRACT_MAX_DEFAULT,
  SECTION_ORDER,
  type Section,
  type SectionName,
} from "./contract";
import { cutHead } from "./cut";
import type { FeedbackItem } from "./feedback";
import { renderHandoff, type HandoffFacts } from "./handoff";
import type { PromptStory } from "./story";
import { rendered, renderTemplate, TASK_TEMPLATES } from "./templates";

/** The budgets of one size class, in characters (lines for `feedbackLogLines`). */
export interface TaskBudgets {
  readonly dependencies: number;
  readonly background: number;
  readonly handoff: number;
  readonly feedbackItem: number;
  readonly feedbackTotal: number;
  readonly taskMessage: number;
}

/** The task message budgets of `size` from `prompt.budgets`. */
export function taskBudgetsFor(
  budgets: OfficeConfig["prompt"]["budgets"],
  size: SizeClass,
): TaskBudgets {
  return {
    dependencies: budgets.dependencies[size],
    background: budgets.background[size],
    handoff: budgets.handoff[size],
    feedbackItem: budgets.feedbackItem[size],
    feedbackTotal: budgets.feedbackTotal[size],
    taskMessage: budgets.taskMessage[size],
  };
}

export interface TaskMessageInput {
  readonly story: PromptStory;
  /** The context pack the providers gathered (DIPO-46), already within the context budget. */
  readonly pack: ContextPack;
  /** For a new session on a story with earlier work; otherwise omitted. */
  readonly handoff?: HandoffFacts;
  /** For a fix turn; otherwise omitted or empty. */
  readonly feedback?: readonly FeedbackItem[];
  readonly budgets: TaskBudgets;
  /** `prompt.contractMax`; default 12,000. */
  readonly contractMax?: number;
}

/** A step of the total-cap drop order that was applied. */
export type Drop =
  | { readonly section: "dependencies" | "background" }
  | { readonly section: "context" | "inputs"; readonly items: number };

export interface TaskMessage {
  /** The message, sections separated by a blank line, ending in one newline. */
  readonly text: string;
  /** The sections in message order. */
  readonly sections: readonly Section[];
  /** The drop steps applied to fit the total cap, in order. */
  readonly dropped: readonly Drop[];
  /** True when the message is still over the cap after every drop step. */
  readonly overCap: boolean;
}

const LIMIT = "to keep the task message within its size limit";

const escapeAttribute = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function contentNote(content: string, refusal: string | undefined): string | undefined {
  switch (content) {
    case "binary":
      return "binary, not shown";
    case "secret":
      return "secret, not read";
    case "unreadable":
      return "unreadable";
    case "refused":
      return `not read: ${refusal ?? "refused"}`;
    default:
      return undefined;
  }
}

function aboutItem(item: ContextItem, stale: ReadonlySet<string>): string {
  const reason = item.reason;
  const parts: string[] = [];
  switch (reason.kind) {
    case "scope-file": {
      parts.push("scope file");
      const note = contentNote(reason.content, reason.refusal);
      if (note !== undefined) parts.push(note);
      if (reason.truncated) parts.push("cut");
      break;
    }
    case "scope-dir":
      parts.push(
        `scope directory, ${formatCount(reason.shown)} of ${formatCount(reason.total)} entries`,
      );
      break;
    case "scope-new":
      parts.push(
        `new scope path, ${formatCount(reason.shown)} of ${formatCount(reason.total)} entries of ${reason.parent === "" ? "the repository root" : reason.parent}`,
      );
      break;
    case "component": {
      const via =
        reason.via === "scope"
          ? "matches the scope"
          : reason.via === "depends-on"
            ? "the scope depends on it"
            : "depends on the scope";
      parts.push(`component ${reason.name}, ${via}`);
      parts.push(`${formatCount(reason.shown)} of ${formatCount(reason.total)} files`);
      if (reason.purpose !== null) parts.push(`purpose: ${reason.purpose}`);
      break;
    }
    case "test":
      parts.push(`test of ${reason.of}`);
      break;
    case "input-file": {
      parts.push("input");
      const note = contentNote(reason.content, reason.refusal);
      if (note !== undefined) parts.push(note);
      if (reason.truncated) parts.push("cut");
      break;
    }
    case "input-listed":
      parts.push("input, not shown for size");
      break;
    case "input-url":
      parts.push("input link, not fetched");
      break;
    case "input-missing":
      parts.push("input, missing");
      break;
  }
  if (item.range !== undefined) {
    parts.push(`lines ${formatCount(item.range.from)} to ${formatCount(item.range.to)}`);
  }
  if (stale.has(item.path)) parts.push("stale index, check the file");
  return parts.join(", ");
}

function renderItem(item: ContextItem, stale: ReadonlySet<string>): string {
  const values = {
    path: escapeAttribute(item.path),
    about: escapeAttribute(aboutItem(item, stale)),
  };
  return item.text === ""
    ? renderTemplate(TASK_TEMPLATES.contextListed, values)
    : renderTemplate(TASK_TEMPLATES.contextItem, { ...values, text: item.text.replace(/\n$/, "") });
}

const leftOut = (count: number, what: string): string =>
  `[dipo: the last ${formatCount(count)} ${what} ${count === 1 ? "was" : "were"} left out ${LIMIT}.]`;

function contextSection(pack: ContextPack, keep: number, stale: ReadonlySet<string>): string {
  const shown = pack.items.slice(0, keep).map((item) => renderItem(item, stale));
  const dropped = pack.items.length - keep;
  if (dropped > 0) shown.push(leftOut(dropped, dropped === 1 ? "context item" : "context items"));
  return renderTemplate(TASK_TEMPLATES.context, {
    items: shown.length === 0 ? "No context items for this story." : rendered(shown.join("\n")),
  });
}

const NOT_SHOWN = "not shown for size; read it if you need it";

/** What the inputs path list says about an input beyond its path. */
function inputNotes(item: ContextItem, stale: ReadonlySet<string>): string[] {
  const reason = item.reason;
  const notes: string[] = [];
  switch (reason.kind) {
    case "input-file": {
      const note = contentNote(reason.content, reason.refusal);
      if (note !== undefined) notes.push(note);
      if (reason.truncated) notes.push("cut");
      break;
    }
    case "input-listed":
      notes.push(NOT_SHOWN);
      break;
    case "input-url":
      notes.push("link, not fetched");
      break;
    case "input-missing":
      notes.push("missing");
      break;
    default:
      break;
  }
  if (stale.has(item.path)) notes.push("stale index, check the file");
  return notes;
}

/** Input items with content, in pack order; listed inputs are annotated in the path list. */
function inputContentItems(pack: ContextPack): ContextItem[] {
  return pack.inputs.items.filter((item) => item.text !== "");
}

function inputsSection(
  story: PromptStory,
  pack: ContextPack,
  keep: number,
  stale: ReadonlySet<string>,
): string {
  const byInput = new Map<string, ContextItem>();
  for (const item of pack.inputs.items) {
    if ("input" in item.reason) byInput.set(item.reason.input, item);
  }
  const content = inputContentItems(pack);
  const kept = new Set(content.slice(0, keep));
  const paths = (pack.inputs.paths.length > 0 ? pack.inputs.paths : story.inputs).map((input) => {
    const item = byInput.get(input);
    const notes = item === undefined ? [] : inputNotes(item, stale);
    if (item !== undefined && item.text !== "" && !kept.has(item)) notes.push(NOT_SHOWN);
    return notes.length === 0 ? `- ${input}` : `- ${input} (${notes.join(", ")})`;
  });
  const items = content.slice(0, keep).map((item) => renderItem(item, stale));
  const dropped = content.length - keep;
  if (dropped > 0) items.push(leftOut(dropped, dropped === 1 ? "input file" : "input files"));
  return renderTemplate(TASK_TEMPLATES.inputs, {
    paths: paths.join("\n"),
    items: rendered(items.join("\n")),
  });
}

function dependenciesSection(story: PromptStory, budget: number, dropped: boolean): string {
  if (dropped) {
    return renderTemplate(TASK_TEMPLATES.dependencies, {
      dependencies: `[dipo: the dependency list was left out ${LIMIT}; ${story.taskFile} names them.]`,
    });
  }
  const lines = story.dependencies
    .map((dep) => `- ${dep.id} ${dep.title.trim()}${dep.outcome === "" ? "" : `: ${dep.outcome}`}`)
    .join("\n");
  const cut = cutHead(
    lines,
    budget,
    (shown, total) =>
      `[dipo: list cut, showing ${formatCount(shown)} of ${formatCount(total)} characters; ${story.taskFile} names every dependency.]`,
  );
  return renderTemplate(TASK_TEMPLATES.dependencies, { dependencies: cut.text });
}

function backgroundSection(story: PromptStory, budget: number, dropped: boolean): string {
  const text = dropped
    ? `[dipo: the background was left out ${LIMIT}; read it in ${story.taskFile} only if you need it.]`
    : cutHead(
        story.background,
        budget,
        (shown, total) =>
          `[dipo: truncated, showing ${formatCount(shown)} of ${formatCount(total)} characters. The full text is in ${story.taskFile}; read it only if the shown part is not enough.]`,
      ).text;
  return renderTemplate(TASK_TEMPLATES.background, { background: text });
}

function feedbackSection(items: readonly FeedbackItem[], budgets: TaskBudgets): string {
  const shown: string[] = [];
  let used = 0;
  for (const item of items) {
    const text = cutHead(
      item.text,
      budgets.feedbackItem,
      (s, t) => `[dipo: item cut, showing ${formatCount(s)} of ${formatCount(t)} characters.]`,
    ).text;
    if (shown.length > 0 && used + text.length > budgets.feedbackTotal) break;
    shown.push(text);
    used += text.length;
  }
  const rest = items.length - shown.length;
  if (rest > 0) {
    shown.push(
      `[dipo: ${formatCount(rest)} more feedback ${rest === 1 ? "item was" : "items were"} left out; fix these first.]`,
    );
  }
  return renderTemplate(TASK_TEMPLATES.feedback, { items: shown.join("\n\n") });
}

interface DropState {
  dependencies: boolean;
  background: boolean;
  contextKeep: number;
  inputsKeep: number;
}

const joinSections = (sections: readonly Section[]): string =>
  `${sections.map((section) => section.text).join("\n\n")}\n`;

/**
 * Builds the `implement` task message. Throws `ContractTooLargeError` (`prompt.contractTooLarge`)
 * when the story contract is over `contractMax`, before anything else is rendered.
 */
export function assembleTaskMessage(input: TaskMessageInput): TaskMessage {
  const { story, pack, budgets } = input;
  const contract = assembleContract(story, input.contractMax ?? CONTRACT_MAX_DEFAULT);
  const stale = new Set(pack.provenance.staleFiles);
  const feedback = input.feedback ?? [];
  const handoff =
    input.handoff === undefined ? undefined : renderHandoff(input.handoff, budgets.handoff);
  const inputCount = inputContentItems(pack).length;

  const build = (state: DropState): Section[] => {
    const sections = new Map<SectionName, string>();
    sections.set("context", contextSection(pack, state.contextKeep, stale));
    if (story.inputs.length > 0) {
      sections.set("inputs", inputsSection(story, pack, state.inputsKeep, stale));
    }
    if (story.dependencies.length > 0) {
      sections.set(
        "dependencies",
        dependenciesSection(story, budgets.dependencies, state.dependencies),
      );
    }
    if (story.background !== "") {
      sections.set("background", backgroundSection(story, budgets.background, state.background));
    }
    if (handoff !== undefined) sections.set("handoff", handoff);
    for (const section of contract) sections.set(section.name, section.text);
    if (feedback.length > 0) sections.set("feedback", feedbackSection(feedback, budgets));
    return SECTION_ORDER.flatMap((name) => {
      const text = sections.get(name);
      return text === undefined ? [] : [{ name, text }];
    });
  };

  const state: DropState = {
    dependencies: false,
    background: false,
    contextKeep: pack.items.length,
    inputsKeep: inputCount,
  };
  const dropped: Drop[] = [];
  let sections = build(state);
  const fits = () => joinSections(sections).length <= budgets.taskMessage;

  if (!fits() && story.dependencies.length > 0) {
    state.dependencies = true;
    dropped.push({ section: "dependencies" });
    sections = build(state);
  }
  if (!fits() && story.background !== "") {
    state.background = true;
    dropped.push({ section: "background" });
    sections = build(state);
  }
  if (!fits() && state.contextKeep > 0) {
    while (!fits() && state.contextKeep > 0) {
      state.contextKeep -= 1;
      sections = build(state);
    }
    dropped.push({ section: "context", items: pack.items.length - state.contextKeep });
  }
  if (!fits() && story.inputs.length > 0 && state.inputsKeep > 0) {
    while (!fits() && state.inputsKeep > 0) {
      state.inputsKeep -= 1;
      sections = build(state);
    }
    dropped.push({ section: "inputs", items: inputCount - state.inputsKeep });
  }
  return { text: joinSections(sections), sections, dropped, overCap: !fits() };
}
