// The facts of the place a chat message is written from (DIPO-524, 0024). Code builds them, never a
// model: per room, the item the maintainer focuses and the lists around it, from the rows the rooms
// themselves read. They go to the model session once per change of place (`contextKey`), as a
// `<context>` block before the message, and the schema of the proposals follows the place
// (`proposalSchemaFor`): role proposals only in the Roles room, the others anywhere else.

import type {
  BackgroundItem,
  ChatContext,
  DeskItem,
  StoryView,
  WorkView,
} from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import { retro } from "../records/retro";
import { storedFeedbackOf } from "../records/open-feedback";
import { outputTail, storyFilesOf } from "../records/verify-records";
import { activeStoryViews } from "../views/story";
import { activeWorkViews } from "../views/work";
import { backgroundItems } from "./background";

/** The most stream lines the Run room's facts hold (spec P3). */
export const CHAT_STREAM_LINES = 200;
/** The most stories a list of the Queue's facts names. */
export const CHAT_LIST_MAX = 30;

/** What the facts read besides the office's own rows. */
export interface ChatFactSources {
  readonly now: number;
  /** The desk of the office now, as `office.desk` returns it. */
  readonly desk?: (office: OfficeHandle, now: number) => readonly DeskItem[];
  /** The roster of the roles with their runs, as text (what the roles kind gets). */
  readonly roles?: () => string;
}

/** Pure: the place as one key; two messages from the same key send the facts once. */
export const contextKey = (context: ChatContext): string =>
  `${context.room}${context.item === undefined ? "" : `:${context.item}`}`;

/** Pure: the proposal kinds the Roles room takes; every other room takes the others. */
const ROLE_KINDS: readonly string[] = ["role", "role-edit", "role-remove"];

/** Pure: whether a message from `context` takes role proposals (and only those). */
export const takesRoleProposals = (context: ChatContext): boolean => context.room === "roles";

/** Pure: the schema of the proposals a message from `context` may carry, from the schema of all. */
export function proposalSchemaFor(
  context: ChatContext,
  schema: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const alternatives = schema.oneOf;
  if (!Array.isArray(alternatives)) return schema;
  const roles = takesRoleProposals(context);
  return {
    ...schema,
    oneOf: alternatives.filter((alternative) => {
      const kind = (alternative as { properties?: { kind?: { const?: unknown } } }).properties?.kind
        ?.const;
      return typeof kind === "string" && ROLE_KINDS.includes(kind) === roles;
    }),
  };
}

const list = (lines: readonly string[], none: string): string[] =>
  lines.length === 0 ? [none] : [...lines];

const storyLine = (view: StoryView): string =>
  `- ${view.story}: ${view.title} (${view.lifecycle}${view.tier === undefined ? "" : `, tier ${view.tier}`})`;

/** The dependencies each story waits on (those not Done), by story id, from the office's rows. */
export function dependenciesOf(office: OfficeHandle): ReadonlyMap<string, readonly string[]> {
  const rows = office.all<{ story_id: string; waiting_on: string | null }>(
    `select s.story_id as story_id, m.waiting_on as waiting_on
       from stories s
       join backlog_mirror m on m.office_id = s.office_id and m.key = s.key
      where s.office_id = $office_id and s.removed_at is null`,
  );
  return new Map(
    rows.map((row) => [
      row.story_id,
      row.waiting_on === null ? [] : (JSON.parse(row.waiting_on) as string[]),
    ]),
  );
}

/** Pure: one story as lines: its state, the Ready gate's result, its chain, its park and its PR. */
export function storyLines(
  view: StoryView,
  chain: ReadonlyMap<string, readonly string[]>,
): string[] {
  const lines = [
    `${view.story}: ${view.title}`,
    `state: ${view.lifecycle}${view.tier === undefined ? "" : `, tier ${view.tier}`}, column ${view.column}`,
  ];
  if (view.lifecycle === "Refined") {
    lines.push(
      view.gatePasses === true
        ? "Ready gate: passes"
        : (view.gateFailures?.length ?? 0) > 0
          ? `Ready gate: fails: ${view.gateFailures
              ?.map((failure) => `${failure.rule}: ${failure.message}`)
              .join("; ")}`
          : (view.gateMessages?.length ?? 0) > 0
            ? `Ready gate: fails: ${view.gateMessages?.join("; ")}`
            : "Ready gate: has not decided it",
    );
  }
  const waiting = chain.get(view.story) ?? [];
  const unblocks = [...chain]
    .filter(([, dependencies]) => dependencies.includes(view.story))
    .map(([story]) => story);
  lines.push(
    `chain: waits on ${waiting.length === 0 ? "nothing" : waiting.join(", ")}; unblocks ${unblocks.length === 0 ? "nothing" : unblocks.join(", ")}`,
  );
  if (view.parked !== undefined) {
    lines.push(`parked: ${view.parked.reason}: ${view.parked.detail}`);
  }
  if (view.pr !== undefined) lines.push(`PR #${view.pr.number}: ${view.pr.state}`);
  return lines;
}

function workLines(work: WorkView): string[] {
  const { progress, usage } = work;
  return [
    `run ${work.work.run} of ${work.work.story}: phase ${work.phase}, health ${work.health}, role ${work.work.role}`,
    `criteria: ${progress.criteriaMet} of ${progress.criteriaTotal} met; loop ${progress.loop} of ${progress.loopCap}; review round ${progress.reviewRound}${progress.reviewRoundCap === undefined ? "" : ` of ${progress.reviewRoundCap}`}`,
    `budget: ${usage.budget.used} of ${usage.budget.limit} ${usage.budget.unit}`,
  ];
}

function deskLine(item: Pick<DeskItem, "kind" | "story" | "detail">): string {
  return `- ${item.kind}${item.story === undefined ? "" : ` ${item.story}`}: ${item.detail}`;
}

function streamTail(office: OfficeHandle, run: string): string {
  return outputTail(office, run as never, CHAT_STREAM_LINES);
}

function deskFacts(office: OfficeHandle, context: ChatContext, sources: ChatFactSources): string[] {
  const items = sources.desk?.(office, sources.now) ?? [];
  const focused =
    context.item === undefined ? [] : items.filter((item) => item.story === context.item);
  const view =
    context.item === undefined
      ? undefined
      : activeStoryViews(office).find((candidate) => candidate.story === context.item);
  return [
    ...(context.item === undefined ? [] : [`focus: ${context.item}`]),
    ...focused.map(deskLine),
    ...(view === undefined ? [] : storyLines(view, dependenciesOf(office))),
    "on the desk:",
    ...list(items.map(deskLine), "Nothing waits on the maintainer."),
  ];
}

function floorFacts(office: OfficeHandle): string[] {
  const works = activeWorkViews(office);
  return list(
    works.map((work) => `- ${work.work.story}: phase ${work.phase}, health ${work.health}`),
    "No story runs.",
  );
}

function queueFacts(office: OfficeHandle, context: ChatContext): string[] {
  const views = activeStoryViews(office);
  const focused =
    context.item === undefined ? undefined : views.find((view) => view.story === context.item);
  const ready = views.filter((view) => view.lifecycle === "Ready");
  const waiting = views.filter((view) => view.column === "waiting");
  const running = activeWorkViews(office);
  return [
    ...(context.item === undefined
      ? []
      : focused === undefined
        ? [`focus: ${context.item} (not in the backlog)`]
        : storyLines(focused, dependenciesOf(office))),
    "Ready:",
    ...list(ready.slice(0, CHAT_LIST_MAX).map(storyLine), "No story is Ready."),
    "waiting:",
    ...list(
      waiting
        .slice(0, CHAT_LIST_MAX)
        .map((view) => `${storyLine(view)}, waits on ${(view.waitingOn ?? []).join(", ")}`),
      "No story waits.",
    ),
    "files of the stories that run:",
    ...list(
      running.map((work) => {
        const files = storyFilesOf(office, work.work.key);
        return `- ${work.work.story}: ${files.length === 0 ? "none recorded yet" : files.join(", ")}`;
      }),
      "No story runs.",
    ),
  ];
}

function runFacts(office: OfficeHandle, context: ChatContext): string[] {
  const work = activeWorkViews(office).find((view) => view.work.story === context.item);
  if (context.item === undefined || work === undefined) {
    return [`No story run${context.item === undefined ? "" : ` of ${context.item}`} is active.`];
  }
  const feedback = storedFeedbackOf(office, work.work.run);
  const last = feedback.at(-1);
  return [
    ...workLines(work),
    `last findings (${feedback.length} items kept${last === undefined ? "" : `; the last is ${last.source}`}):`,
    ...list(
      feedback.slice(-3).map((item) => `[${item.source}] ${item.text}`),
      "none",
    ),
    `the last ${CHAT_STREAM_LINES} stream lines, with the verify and CI output:`,
    streamTail(office, work.work.run),
  ];
}

function storyFacts(office: OfficeHandle, context: ChatContext): string[] {
  const views = activeStoryViews(office);
  const view = views.find((candidate) => candidate.story === context.item);
  if (view === undefined) return ["No story is focused."];
  const work = activeWorkViews(office).find((candidate) => candidate.work.story === view.story);
  const runs = office.all<{ end_kind: string | null; tokens: number }>(
    `select r.end_kind,
       coalesce((select sum(u.input + u.output + u.cache_create) from usage_totals u
                  where u.office_id = r.office_id and u.run_id = r.run_id), 0) as tokens
     from runs r
     where r.office_id = $office_id and r.kind = 'story' and r.story_id = $story
     order by r.started_at desc, r.rowid desc limit 20`,
    { story: view.story },
  );
  return [
    ...storyLines(view, dependenciesOf(office)),
    ...(work === undefined
      ? ["criteria and rounds: no run is active"]
      : [
          `criteria: ${work.progress.criteriaMet} of ${work.progress.criteriaTotal} met`,
          `review rounds: ${work.progress.reviewRound}${work.progress.reviewRoundsFailed === undefined ? "" : `, ${work.progress.reviewRoundsFailed} failed`}`,
        ]),
    "runs:",
    ...list(
      runs.map(
        (run) => `- ${run.end_kind ?? "running"}, ${run.tokens.toLocaleString("en-US")} tokens`,
      ),
      "none",
    ),
  ];
}

function backgroundFacts(office: OfficeHandle, context: ChatContext, now: number): string[] {
  const items: readonly BackgroundItem[] = backgroundItems(office, now, null);
  const item = items.find((candidate) => candidate.ref === context.item);
  if (item === undefined) {
    return [
      ...(context.item === undefined ? [] : [`${context.item} is not listed any more.`]),
      ...list(
        items.map((candidate) => `- ${candidate.ref} ${candidate.subject} (${candidate.state})`),
        "Nothing runs or waits in the background.",
      ),
    ];
  }
  return [
    `${item.ref}: ${item.subject}`,
    `state: ${item.state}${item.next === undefined ? "" : `; next: ${item.next}`}`,
    ...(item.ci === undefined ? [] : [`checks: ${item.ci}`]),
    ...(item.url === undefined ? [] : [`url: ${item.url}`]),
  ];
}

/**
 * Pure of the model: the `<context>` block for a message written from `context`, or null where the
 * room has no facts (the chat itself). The text is cut at no length: each list is bounded above.
 */
export function chatFacts(
  office: OfficeHandle,
  context: ChatContext,
  sources: ChatFactSources,
): string | null {
  let lines: string[];
  switch (context.room) {
    case "desk":
      lines = deskFacts(office, context, sources);
      break;
    case "floor":
      lines = floorFacts(office);
      break;
    case "queue":
      lines = queueFacts(office, context);
      break;
    case "run":
      lines = runFacts(office, context);
      break;
    case "story":
      lines = storyFacts(office, context);
      break;
    case "retro":
      lines = retro(office).lines;
      break;
    case "roles":
      lines = [sources.roles?.() ?? "The roles are not loaded yet."];
      break;
    case "background":
      lines = backgroundFacts(office, context, sources.now);
      break;
    default:
      return null;
  }
  return [
    `<context room="${context.room}"${context.item === undefined ? "" : ` item="${context.item}"`}>`,
    `The maintainer writes from the ${context.room} room${context.item === undefined ? "" : `, on ${context.item}`}. dipo counted these facts; answer from them and the repository.`,
    ...lines,
    "</context>",
  ].join("\n");
}
