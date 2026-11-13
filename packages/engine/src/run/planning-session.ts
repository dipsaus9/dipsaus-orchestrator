// The maintainer's planning session (DIPO-447, 0008, 0002): a model session in a read-only box that the
// maintainer talks to turn by turn, until they end it. It implements `planning.start`,
// `planning.message` and `planning.end` through the worker port only, so nothing here names the model:
//
// - `planning.start { kind, goal }` opens it: a `runs` row of kind `session`, role `planner`, with
//   no story, branch or key, then a box made as a reviewer's (`BoxWorkers.planning`): a read-only
//   copy of the base branch's tip with the backlog, nothing mounted, the box firewall and web
//   proxy, and the model proxy. The worker port plans kind `planning`, which has only the reading,
//   search and web tools, the office `planning` block's model and effort, and no structured
//   output. Its first message is the kind and goal with the facts code knows: the open drafts, the
//   desk and the recent story runs (`planningFirstMessage`). The reply comes once its host started.
// - An office has at most one open planning session (`planning.open` while one is open or
//   starting), and it holds no run slot: it is a session run, which the places never count (0002).
// - `planning.message { text }` sends the maintainer's text to the open session's stdin: its next
//   turn. Ingestion streams each answer as `planning.output` events and the spend as
//   `planning.updated` (usage at most once a second, and at each turn end), with the planning view,
//   since the session has no story and so no `WorkRef`. The model proxy counts the box's requests
//   against the run, with no cap (`proxied-usage.ts`), so the spend counts in the office's usage.
// - Waiting for the maintainer is no stall: at each turn end the watchdog's quiet and stuck waits
//   stop (`Watchdog.waiting`) until the next message starts them again (`Watchdog.working`), and the
//   session has no minute or token cap. A session that waits `planning.idleHours` for a message ends
//   by itself (`idle`).
// - `planning.end` ends it (`maintainer`): a waiting session gets its stdin closed, a working one
//   the stop, and the run ends once its exit is read, or two minutes later without one. Its box is
//   deleted then, and `planning.ended` and `run.ended` follow. At daemon stop every open session
//   gets the stop and ends `daemon-stopped`; at daemon start a planning run a stopped daemon left
//   open is ended (`recover`).
// - An aside (DIPO-452): an idea the session noticed outside its goal, sent as a `dipo-aside` block
//   in its answer. Each valid block is held as an idea and audited when it arrives (`onIdea`); an
//   invalid one is refused with an `engine.notice` that says why (`asides.ts`).
// - The record (DIPO-448, 0007): `planning_records` keeps the session's goal, each confirmed choice,
//   each filed or edited story and each open question (`record`), the maintainer's messages and
//   each model session's last answer (DIPO-489), and when each model session started and ended. A planning session is named by the run of its first model session. When a
//   turn ends and the context nears full (the last main-agent message's `contextSize` reaches the
//   limit, or the session compacted; read from the stream's usage events, DIPO-489), dipo ends that model session
//   (`context-full`) and starts a fresh one, with a new run, whose first message code builds from
//   the record and the facts of the first message; `planning.continued` says so. A session whose
//   model session ended by idle, a daemon stop or its exit continues the same way on
//   `planning.continue`, unless the maintainer ended it.
//
// Proposals (DIPO-450, 0022): the first message gives the session the proposal schema, and at
// each turn end the answer's proposal blocks are read (`planning-proposals.ts`). A valid one joins
// the planning view as an open proposal with its number, tier and why; an invalid one is refused,
// shown in the view, and its problems go to the session at once as its next message, at most
// `AUTO_REFUSALS_MAX` answers in a row, after which they wait for the maintainer's next message.
// The maintainer decides each proposal with a command:
//
// - `planning.confirm` journals it in the office's planning lane (0010): a new story as a `file`
//   change, an edit as a `revise` change, a split as both, a refined draft as a `refine` change
//   (promoted to a story with a new id and a branch named for it) and a dropped draft as a
//   `drop` of the draft (DIPO-454, triage), then flushes the lane, which opens or updates dipo's
//   backlog PR. The confirm is the Ready choice (DIPO-495): the lane gates each story it files or
//   refines as filed and files it Ready when it passes, Refined otherwise, and gates an edited
//   Ready story again; the view shows the gate's answer per story (`PlanningProposalView.gate`) and
//   the session's next message says it. Each filed or edited story's id goes into the session's record once
//   the lane applied its change (`planning_record`). A new story whose title an active story or
//   another confirmed proposal has, a dependency the office does not know, an edit of a task that
//   is not Refined, Ready or Parked, or a refine or drop of anything but an open draft is refused
//   before anything is journaled.
// - `planning.edit` replaces an open proposal with the maintainer's version, checked the same way.
// - `planning.decline` closes it; nothing is filed.
//
// What the maintainer decided reaches the session with their next message, as `[dipo]` lines
// before it, so it never proposes a filed or declined story again.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  AgentId,
  type Clock,
  ideaOriginWords,
  type DeskItem,
  type IdSource,
  type OfficeId,
  type PlanningEndReason,
  type PlanningKind,
  planningAnswer,
  planningContinue,
  planningRecord,
  PLANNING_QUESTIONS_FENCE,
  type PlanningQuestion,
  PLANNING_PROPOSAL_FENCE,
  planningConfirm,
  planningDecline,
  planningEdit,
  planningEnd,
  planningMessage,
  type PlanningProposal,
  type PlanningProposalView,
  planningStart,
  type PlanningState,
  type PlanningMessageView,
  type PlanningModelSession,
  type PlanningView,
  RunId,
  type StoryKey,
  type UsageTotals,
} from "@dipsaus-orchestrator/contract";
import type { z } from "zod";

import { cycleThrough } from "../gate/rules";
import { baseCommit } from "../box/image";
import { retro, type RoleRunCounts, roleRunCounts, roleRunLines } from "../records/retro";
import { loadRoleFiles } from "../roles/base";
import { REVIEW_CODE_DIR } from "../box/review-box";
import type { BoxSession, BoxWorkers } from "../box/workers";
import { appendEntries, type NewEntry } from "../changelog/log";
import { CommandError } from "../commands/errors";
import type { AsyncCommandContext, CommandOutcome, FeatureModule } from "../commands/registry";
import type { OfficeConfig } from "../config";
import { configHash } from "../config/merge";
import type { OfficeHandle } from "../db/office";
import type { OfficeGit } from "../git/office";
import { Ingestor, type IngestAdapter, type IngestedExit } from "../ingest/ingestor";
import type { StorylessEvents } from "../ingest/pending";
import { ensurePrivateDir } from "../platform/paths";
import { promptParts, recordPromptParts, recordPromptTexts } from "../prompts/parts";
import { renderSystemFile } from "../prompts/system";
<<<<<<< 8adc49388915cff5acb4fdf2f29bbf77ddf2cfd8
import { rendered, renderTemplate, ROLE_TEMPLATES, TASK_TEMPLATES } from "../prompts/templates";
=======
import { type Rendered, rendered, renderTemplate, TASK_TEMPLATES } from "../prompts/templates";
>>>>>>> c554aaedc63d3a6500f7da2db5f0b55b9397db5d
import { recordAgent } from "../records/agents";
import {
  addPlanningEntry,
  continuableSession,
  type NewPlanningEntry,
  type FiledStory,
  filedStoriesText,
  outputEndOf,
  planningRecordText,
  planningSessionOfRun,
  readPlanningRecord,
  recordLastAnswer,
} from "../records/planning-record";
import { PLANNER_ROLE } from "../records/caps";
import type { RunEnd } from "../records/lifecycle";
import { currentProfileId, endRun, insertRun, recordConfigSnapshot } from "../records/run-records";
import { activeSignals } from "../records/signals";
import { contextSize, readUsage } from "../records/usage";
import type { LaunchedHost } from "../records/worker-hosts";
import { draftOrigins } from "../records/ideas";
import { isProvisionalId, resolveStoryRef, type StoryIdentity } from "../records/story-keys";
import { PlanningRefusedError } from "../story-store/errors";
import {
  type PlannedChange,
  type PlannedFiling,
  type PlanningLane,
  REVISE_KIND,
} from "../story-store/planning";
import { activeStoryViews, storyView } from "../views/story";
import type { RunLaunchPaths, WorkerPort } from "../workers/port";
import { PlanError, type HostOp, type WorkerEvent, type WorkerSpec } from "../workers/types";

import { ASIDE_FENCE, holdAsides } from "./asides";
import {
  answersMessage,
  PLANNING_QUESTIONS_JSON_SCHEMA,
  questionsRefusalMessage,
  readAnswers,
  readQuestionBlocks,
} from "./planning-questions";
import type { RunSteering } from "./control-types";
import {
  AUTO_REFUSALS_MAX,
  checkProposal,
  editFieldsOf,
  fileTargetOf,
  PLANNING_REFUSALS_SHOWN,
  readProposals,
  roleAddTargetOf,
  roleEditTargetOf,
  type RoleFacts,
  rosterProblems,
  refineFieldsOf,
  refineTargetOf,
  refusalMessage,
  reviseTargetOf,
  storyFieldsOf,
} from "./planning-proposals";
import { openStoriesOfRole } from "../records/role-stories";
import { claimHost, connectWhenBound } from "./hosts";
import { type HostStarter, runLaunchPaths } from "./launch";
import { sessionUuid } from "./prompts";
import { prepareRunTempDirs } from "./temp-dirs";
import { Watchdog, type WatchdogTimeouts } from "./watchdog";

type StartArgs = z.output<typeof planningStart.args>;
type StartResult = z.input<typeof planningStart.result>;
type MessageArgs = z.output<typeof planningMessage.args>;
type AnswerArgs = z.output<typeof planningAnswer.args>;
type AnswerResult = z.input<typeof planningAnswer.result>;
type RecordArgs = z.output<typeof planningRecord.args>;
type RecordResult = z.input<typeof planningRecord.result>;
type MessageResult = z.input<typeof planningMessage.result>;
type EndResult = z.input<typeof planningEnd.result>;
type ConfirmArgs = z.output<typeof planningConfirm.args>;
type ConfirmResult = z.input<typeof planningConfirm.result>;
type EditArgs = z.output<typeof planningEdit.args>;
type EditResult = z.input<typeof planningEdit.result>;
type DeclineArgs = z.output<typeof planningDecline.args>;
type DeclineResult = z.input<typeof planningDecline.result>;

/** The session's system file in its run directory. */
export const PLANNING_SYSTEM_FILE = "system-planning.md";
/** How long after the end dipo waits for the session's exit before it ends the run anyway. */
export const PLANNING_EXIT_GRACE_MS = 2 * 60_000;
/** Milliseconds from an end to SIGTERM and to SIGKILL, when closing stdin did not end it. */
export const PLANNING_SIGTERM_AFTER_MS = 10_000;
export const PLANNING_SIGKILL_AFTER_MS = 30_000;
/** The daemon's recovery step that ends the planning runs a stopped daemon left open. */
export const PLANNING_RECOVERY_STEP = "planning-recover";
/** The most story runs the first message lists. */
export const PLANNING_RECENT_RUNS = 10;
/** The size of a model session's last main-agent message from which its context counts as nearly full. */
export const PLANNING_CONTEXT_TOKENS = 150_000;

const HOUR_MS = 60 * 60_000;

/** One story run as the first message lists it. */
export interface RecentRun {
  readonly story: string;
  readonly tier: string | null;
  /** How it ended (done, parked, dropped), or null while it runs. */
  readonly ending: string | null;
  readonly startedAt: number;
  /** Input plus output plus cache-creation tokens (0008). */
  readonly tokens: number;
}

/** An open draft as the first message lists it, with where it came from (DIPO-454). */
export interface PlanningDraft {
  readonly story: string;
  readonly title: string;
  /** In words: the idea it was filed from and its source story, or that none is recorded. */
  readonly origin: string;
}

/** The facts the first message gives the session (DIPO-447). */
export interface PlanningFacts {
  readonly kind: PlanningKind;
  readonly goal: string;
  /** The session's record as text (`planningRecordText`). */
  readonly record: string;
  readonly drafts: readonly PlanningDraft[];
  readonly desk: readonly Pick<DeskItem, "kind" | "story" | "detail">[];
  readonly runs: readonly RecentRun[];
  /** The roster of the base's role files, each with its purpose (DIPO-476). */
  readonly roles: readonly {
    readonly name: string;
    readonly purpose: string;
    readonly model?: string;
    readonly effort?: string;
    readonly instructions?: string;
  }[];
  /** A roles session (DIPO-475): each role file that failed to load, with its problem. */
  readonly invalidRoles?: readonly string[];
  /** A roles session: the recent runs of each role, counted by code (`roleRunCounts`). */
  readonly roleRuns?: readonly RoleRunCounts[];
  /** The retro numbers as text (DIPO-453): counted by code, to explain and never to compute. */
  readonly retro: string;
  /** The base branch's commit the read-only copy holds. */
  readonly commit: string;
  /** The JSON Schema of a proposal block (DIPO-450), as the worker port hands it out. */
  readonly proposalSchema: Readonly<Record<string, unknown>>;
  /** The office's `.dipo/planning.md` at the base commit; null when it has none (DIPO-455). */
  readonly preferences: string | null;
}

/** The office file with the maintainer's standing planning preferences (DIPO-455). */
export const PLANNING_PREFERENCES_FILE = ".dipo/planning.md";
/** The most characters of the office planning file the first message holds. */
export const PLANNING_PREFERENCES_MAX_CHARS = 20_000;

const listOr = (lines: readonly string[], none: string): string =>
  lines.length === 0 ? none : lines.join("\n");

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Pure: the schema of the role proposals only, from the schema of every proposal (DIPO-475). */
export function roleProposalSchema(
  schema: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const alternatives = schema.oneOf;
  if (!Array.isArray(alternatives)) return schema;
  const kinds = ["role", "role-edit", "role-remove"];
  return {
    ...schema,
    oneOf: alternatives.filter((alternative) => {
      const kind = (alternative as { properties?: { kind?: { const?: unknown } } }).properties?.kind
        ?.const;
      return typeof kind === "string" && kinds.includes(kind);
    }),
  };
}

/** Pure: the first message of a roles session: the roster, its runs and the role proposal schema. */
function rolesFirstMessage(facts: PlanningFacts): string {
  const runs = new Map((facts.roleRuns ?? []).map((counts) => [counts.role, counts]));
  const roster = facts.roles.map((role) =>
    [
      `## ${role.name}`,
      `purpose: ${role.purpose}`,
      `model: ${role.model ?? "the tier's model"}`,
      `effort: ${role.effort ?? "the tier's effort"}`,
      `recent runs: ${roleRunLines(runs.get(role.name)).join("; ")}`,
      "instructions:",
      role.instructions ?? "",
    ].join("\n"),
  );
  return renderTemplate(TASK_TEMPLATES.planningRoles, {
    kind: facts.kind,
    goal: facts.goal,
    record: facts.record,
    roles: roster.length === 0 ? "The office has no roles." : roster.join("\n\n"),
    invalid: listOr(facts.invalidRoles ?? [], "Every role file loaded."),
    commit: rendered(facts.commit),
    dir: rendered(REVIEW_CODE_DIR),
    fence: rendered(PLANNING_PROPOSAL_FENCE),
    schema: rendered(JSON.stringify(roleProposalSchema(facts.proposalSchema))),
    questions_fence: rendered(PLANNING_QUESTIONS_FENCE),
    questions_schema: rendered(JSON.stringify(PLANNING_QUESTIONS_JSON_SCHEMA)),
    preferences: preferencesSection(facts.preferences),
  });
}

function preferencesSection(preferences: string | null): string | Rendered {
  return preferences === null || preferences.trim() === ""
    ? ""
    : rendered(
        `${renderTemplate(TASK_TEMPLATES.planningPreferences, {
          text: preferences.trim().slice(0, PLANNING_PREFERENCES_MAX_CHARS),
        })}\n`,
      );
}

/** Pure: the session's first message, as text, from the facts code knows. */
export function planningFirstMessage(facts: PlanningFacts): string {
  if (facts.kind === "roles") return rolesFirstMessage(facts);
  return renderTemplate(TASK_TEMPLATES.planning, {
    kind: facts.kind,
    goal: facts.goal,
    record: facts.record,
    drafts: listOr(
      facts.drafts.map((draft) => `- ${draft.story}: ${draft.title} (origin: ${draft.origin})`),
      "No open drafts.",
    ),
    desk: listOr(
      facts.desk.map(
        (item) =>
          `- ${item.kind}${item.story === undefined ? "" : ` ${item.story}`}: ${item.detail}`,
      ),
      "Nothing waits on the maintainer.",
    ),
    runs: listOr(
      facts.runs.map(
        (run) =>
          `- ${run.story}${run.tier === null ? "" : ` (${run.tier})`}: ${run.ending ?? "running"}, ${run.tokens.toLocaleString("en-US")} tokens, started ${day(run.startedAt)}`,
      ),
      "No story runs yet.",
    ),
    roles: listOr(
      facts.roles.map((role) => `- ${role.name}: ${role.purpose}`),
      "The office has no roles.",
    ),
    retro: facts.retro,
    commit: rendered(facts.commit),
    dir: rendered(REVIEW_CODE_DIR),
    fence: rendered(PLANNING_PROPOSAL_FENCE),
    schema: rendered(JSON.stringify(facts.proposalSchema)),
    questions_fence: rendered(PLANNING_QUESTIONS_FENCE),
    questions_schema: rendered(JSON.stringify(PLANNING_QUESTIONS_JSON_SCHEMA)),
    preferences: preferencesSection(facts.preferences),
  });
}

/**
 * The open drafts of `office`, each with its origin (DIPO-454): the idea the maintainer accepted it
 * from, with that idea's source story, when the office recorded one under its id and title.
 */
export function planningDrafts(office: OfficeHandle): PlanningDraft[] {
  const origins = draftOrigins(office);
  return activeStoryViews(office)
    .filter((view) => view.lifecycle === "Draft")
    .map((view) => {
      const origin = origins.get(String(view.story).toUpperCase());
      const from =
        origin === undefined || titleKey(origin.title) !== titleKey(view.title)
          ? "not recorded; filed by hand or before dipo kept it"
          : `${ideaOriginWords(origin.origin)}, source story ${origin.story ?? "none"}`;
      return { story: view.story, title: view.title, origin: from };
    });
}

/** The latest story runs of `office`, newest first, with their spend. */
export function recentStoryRuns(office: OfficeHandle, limit = PLANNING_RECENT_RUNS): RecentRun[] {
  return office
    .all<{
      story_id: string;
      tier: string | null;
      end_kind: string | null;
      started_at: number;
      tokens: number;
    }>(
      `select r.story_id, r.tier, r.end_kind, r.started_at,
         coalesce((select sum(u.input + u.output + u.cache_create) from usage_totals u
                    where u.office_id = r.office_id and u.run_id = r.run_id), 0) as tokens
       from runs r
       where r.office_id = $office_id and r.kind = 'story' and r.story_id is not null
       order by r.started_at desc, r.rowid desc limit $limit`,
      { limit },
    )
    .map((row) => ({
      story: row.story_id,
      tier: row.tier,
      ending: row.end_kind,
      startedAt: row.started_at,
      tokens: row.tokens,
    }));
}

export interface PlanningSessionsDeps {
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly offices: {
    get(office: OfficeId): OfficeHandle | undefined;
    config(office: OfficeId): OfficeConfig | undefined;
  };
  readonly worker: WorkerPort;
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  /** The planning boxes (`BoxWorkers`); without them no planning session starts. */
  readonly boxes?: Pick<BoxWorkers, "planning" | "endPlanning">;
  readonly hosts: HostStarter;
  /** Sends host ops to the running session: each message, the end. */
  readonly steering: RunSteering;
  /** The desk of the office now (`office.desk`), for the first message; none without it. */
  readonly desk?: (office: OfficeHandle, now: number) => readonly DeskItem[];
  /** The text of `.dipo/planning.md` at `commit`, or null; read through git by default. */
  readonly planningFile?: (git: OfficeGit, commit: string) => Promise<string | null>;
  /** The base branch's tip the copy holds; `baseCommit` by default. */
  readonly baseCommit?: (git: OfficeGit) => Promise<string>;
  /** The context size from which a model session's context nears full; `PLANNING_CONTEXT_TOKENS`. */
  readonly contextTokens?: number;
  readonly runtimeDir: string;
  /** dipo's temp root: the run temp directories. */
  readonly tmpRoot: string;
  readonly tempOwner?: () => string | undefined;
  /** The office's planning lane (0010), which files the proposals the maintainer confirms. */
  readonly lane?: (office: OfficeId) => PlanningLane | undefined;
  /** The role files on the base of the office (0017), for the role proposals' checks (DIPO-474). */
  readonly roleFiles?: (office: OfficeId) => ReadonlyMap<string, string | undefined> | undefined;
  readonly onChanged?: (office: OfficeId) => void;
  /** The session held an idea from an aside block (DIPO-452): the audit takes it now. */
  readonly onIdea?: (office: OfficeId) => void;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
  /** Each handover to a fresh model session is logged here (DIPO-489). */
  readonly info?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

/** The model session a fresh one continues, and why that one ended. */
interface Continued {
  readonly previous: RunId;
  readonly reason: PlanningEndReason;
  /** The context size that ended `previous` as full, when it was measured (DIPO-489). */
  readonly size?: number;
}

/** One open planning session of this daemon. */
interface Open {
  readonly office: OfficeId;
  readonly handle: OfficeHandle;
  readonly run: RunId;
  /** The planning session: the run of its first model session. */
  readonly session: RunId;
  /** Set for a fresh model session that continues a planning session. */
  readonly continued: Continued | null;
  readonly agent: AgentId;
  readonly kind: PlanningKind;
  readonly goal: string;
  readonly model: string;
  readonly startedAt: number;
  state: PlanningState;
  turns: number;
  lastOutputAt: number | null;
  /**
   * The context size of the last main-agent message (`contextSize`), from the stream's usage
   * events whether or not they are stored (DIPO-489); null before the first. Not kept across a
   * daemon restart: the model session continues as a fresh one then.
   */
  contextTokens: number | null;
  /** True once the model session compacted its context; it then counts as full. */
  compacted: boolean;
  /** Why it ends, once its end was asked for or decided. */
  ending: { readonly reason: PlanningEndReason; readonly detail?: string } | null;
  idle: ReturnType<Clock["setTimeout"]> | null;
  grace: ReturnType<Clock["setTimeout"]> | null;
  ingestor: Ingestor | null;
  settled: boolean;
  /** The texts of the answer in progress, read for proposal blocks at its turn end (DIPO-450). */
  answer: string[];
  proposals: OpenProposal[];
  /** The question blocks of the session, answered or not (DIPO-455). */
  questions: OpenQuestions[];
  /** The refused proposal blocks, newest last. */
  refusals: { readonly at: number; readonly problems: readonly string[] }[];
  /** How many answers in a row dipo refused by itself (`AUTO_REFUSALS_MAX`). */
  autoRefusals: number;
  /** The `[dipo]` lines the next maintainer message carries before it. */
  notes: string[];
  /** The list of filed stories the session last got (`filedSignature`); null before any (DIPO-480). */
  filedSeen: string | null;
  /** The base commit dipo first saw each story on the base at, by story id (DIPO-480). */
  readonly mergedSince: Map<string, string>;
}

/** A story of the session's record with the filing the lane journaled for it (DIPO-480). */
interface SessionStory {
  readonly story: string;
  readonly key: StoryKey | null;
  readonly kind: "filed" | "edited";
  readonly filing: PlannedFiling | undefined;
}

/** Pure: what a list of filed stories says, to tell when a filing changed. */
const filedSignature = (filed: readonly FiledStory[]): string =>
  JSON.stringify(filed.map((f) => [f.story, f.state, f.since, f.notice]));

/** Pure: the text of the filing's target as the story was filed, or the fields an edit changed. */
function filingText(filing: PlannedFiling): string {
  if (filing.kind === REVISE_KIND) {
    const edit = filing.target;
    return [
      ...(edit.title === undefined ? [] : [`Title: ${edit.title}`]),
      ...(edit.storyLine === undefined ? [] : [`Story: ${edit.storyLine}`]),
      ...(edit.context === undefined ? [] : [edit.context]),
      ...(edit.criteria === undefined
        ? []
        : ["Acceptance criteria:", ...edit.criteria.map((text, i) => `${i + 1}. ${text}`)]),
      ...(edit.references === undefined ? [] : [`References: ${edit.references.join(", ")}`]),
      ...(edit.dependencies === undefined
        ? []
        : [
            `Dependencies: ${edit.dependencies.length === 0 ? "none" : edit.dependencies.join(", ")}`,
          ]),
    ].join("\n");
  }
  const story = filing.target;
  const plan = story.testPlan;
  return [
    `Title: ${story.title}`,
    `Type ${story.type}, milestone ${story.milestone}, tier ${story.tier}`,
    story.description,
    "Acceptance criteria:",
    ...story.criteria.map((text, i) => `${i + 1}. ${text}`),
    `References: ${story.references.length === 0 ? "none" : story.references.join(", ")}`,
    ...(plan === undefined
      ? []
      : plan.entries !== undefined
        ? [
            "Test plan:",
            ...plan.entries.map(
              (entry) =>
                `- (${entry.kind}) ${entry.check}${entry.expect === undefined ? "" : ` Expected: ${entry.expect}`}`,
            ),
          ]
        : [`Test plan: not applicable: ${plan.not_applicable}`]),
  ].join("\n");
}

/** A block of questions of an open session (DIPO-455). */
interface OpenQuestions {
  readonly n: number;
  readonly questions: readonly PlanningQuestion[];
  answered: boolean;
  readonly at: number;
}

/** A proposal of an open session (DIPO-450). */
interface OpenProposal {
  readonly n: number;
  proposal: PlanningProposal;
  /** `confirmed` once its lane changes are journaled; the lane says how far they got. */
  state: "open" | "confirmed" | "declined";
  edited: boolean;
  changes: readonly PlannedChange[];
  readonly at: number;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const ZERO_TOTALS: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreateTokens: 0,
  cacheReadTokens: 0,
  turns: 0,
  elapsedMs: 0,
};

const iso = (ms: number) => new Date(ms).toISOString();

function notOpen(why: string): CommandError {
  return new CommandError("planning.notOpen", `There is no open planning session: ${why}.`);
}

function proposalClosed(item: { readonly n: number }, why: string): CommandError {
  return new CommandError("planning.proposalClosed", `Proposal ${item.n} is closed: ${why}.`, {
    proposal: item.n,
  });
}

/** The lifecycles a confirmed edit applies from (0012). */
const REVISABLE_LIFECYCLES: readonly string[] = ["Refined", "Ready", "Parked"];

/** A title as two titles compare: trimmed, NFC, one space, lower case. */
const titleKey = (title: string): string =>
  title.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();

/** The role a proposal adds, edits or removes, and which; null for any other proposal (DIPO-474). */
function roleChangeOf(
  proposal: PlanningProposal,
): { readonly name: string; readonly change: "added" | "edited" | "removed" } | null {
  switch (proposal.kind) {
    case "role":
      return { name: proposal.name, change: "added" };
    case "role-edit":
      return { name: proposal.name, change: "edited" };
    case "role-remove":
      return { name: proposal.name, change: "removed" };
    default:
      return null;
  }
}

/** The title of the new story a proposal files, or null for an edit or a drop. */
function newStoryTitle(proposal: PlanningProposal): string | null {
  if (proposal.kind === "story" || proposal.kind === "refine") return proposal.title;
  return proposal.kind === "split" ? proposal.story.title : null;
}

/** The planning sessions of every office: at most one open per office. */
export class PlanningSessions {
  readonly #deps: PlanningSessionsDeps;
  /** The open session of each office, from its start until it ended. */
  readonly #open = new Map<OfficeId, Open>();
  /** The offices whose session start is under way. */
  readonly #starting = new Set<OfficeId>();
  readonly #watchdog: Watchdog;

  constructor(deps: PlanningSessionsDeps) {
    this.#deps = deps;
    this.#watchdog = new Watchdog({
      clock: deps.clock,
      timeouts: (office): WatchdogTimeouts | undefined => deps.offices.config(office)?.timeouts,
      onAppended: (office) => deps.onChanged?.(office),
      // Quiet and stuck while it works on an answer: the planning view's health says so.
      storyless: (handle, run) => {
        const open = [...this.#open.values()].find((candidate) => candidate.run === run);
        return open === undefined || open.handle !== handle ? [] : [this.#updated(open)];
      },
    });
  }

  /** `planning.start`, `planning.message` and `planning.end` on the waiting command path. */
  get feature(): FeatureModule {
    return {
      name: "run",
      register: (registry) => {
        registry.addAsyncOfficeCommand({
          definition: planningStart,
          handle: (ctx, args) => this.start(ctx, args),
        });
        registry.addAsyncOfficeCommand({
          definition: planningMessage,
          handle: (ctx, args) => this.message(ctx, args),
        });
        registry.addAsyncOfficeCommand({
          definition: planningAnswer,
          handle: (ctx, args) => this.answer(ctx, args),
        });
        registry.addAsyncOfficeCommand({
          definition: planningRecord,
          handle: (ctx, args) => Promise.resolve(this.recordCommand(ctx, args)),
        });
        registry.addAsyncOfficeCommand({
          definition: planningEnd,
          handle: (ctx) => this.end(ctx),
        });
        registry.addAsyncOfficeCommand({
          definition: planningContinue,
          handle: (ctx) => this.continue(ctx),
        });
        registry.addAsyncOfficeCommand({
          definition: planningConfirm,
          handle: (ctx, args) => this.confirm(ctx, args),
        });
        registry.addAsyncOfficeCommand({
          definition: planningEdit,
          handle: (ctx, args) => this.edit(ctx, args),
        });
        registry.addAsyncOfficeCommand({
          definition: planningDecline,
          handle: (ctx, args) => this.decline(ctx, args),
        });
      },
    };
  }

  /** The view of the open planning session of `office`; null without one. */
  view(office: OfficeId): PlanningView | null {
    const open = this.#open.get(office);
    return open === undefined ? null : open.handle.deferred(() => this.#viewOf(open));
  }

  /** The run ids of the planning sessions this daemon follows now. */
  liveRuns(): string[] {
    return [...this.#open.values()].map((open) => open.run);
  }

  async start(ctx: AsyncCommandContext, args: StartArgs): Promise<CommandOutcome<StartResult>> {
    const office = ctx.office.officeId as OfficeId;
    this.#refuseWhenOpen(office);
    this.#starting.add(office);
    try {
      const view = await this.#begin(ctx.office, office, {
        ...args,
        session: null,
        continued: null,
      });
      return { result: { run: view.run, view }, changed: true };
    } finally {
      this.#starting.delete(office);
    }
  }

  /** `planning.continue`: see the file comment. */
  async continue(ctx: AsyncCommandContext): Promise<CommandOutcome<StartResult>> {
    const office = ctx.office.officeId as OfficeId;
    this.#refuseWhenOpen(office);
    const found = ctx.office.deferred(() => continuableSession(ctx.office));
    if (found === null) {
      throw new CommandError(
        "planning.notContinuable",
        "No planning session can continue: start one with planning.start. A session the maintainer ended does not continue.",
      );
    }
    this.#starting.add(office);
    try {
      const view = await this.#begin(ctx.office, office, {
        kind: found.kind,
        goal: found.goal,
        session: RunId.parse(found.session),
        continued: { previous: RunId.parse(found.previous), reason: found.reason },
      });
      return { result: { run: view.run, view }, changed: true };
    } finally {
      this.#starting.delete(office);
    }
  }

  /**
   * Adds an entry to the record of the open planning session of `office`: a confirmed choice, a
   * filed or edited story, or an open question. Written by code when the maintainer confirms.
   */
  record(office: OfficeId, entry: Omit<NewPlanningEntry, "at">): void {
    const open = this.#open.get(office);
    if (open === undefined) throw notOpen("none was started");
    const at = this.#deps.clock.now();
    open.handle.immediate(() => addPlanningEntry(open.handle, open.session, { ...entry, at }));
  }

  /** `planning.record`: the maintainer's confirmation, stored by `record`. */
  recordCommand(ctx: AsyncCommandContext, args: RecordArgs): CommandOutcome<RecordResult> {
    const office = ctx.office.officeId as OfficeId;
    this.record(office, {
      kind: args.kind,
      ...("subject" in args ? { subject: args.subject } : {}),
      text: args.text,
    });
    const run = this.#open.get(office)?.run;
    return { result: { run: RunId.parse(run), recorded: true }, changed: true };
  }

  #refuseWhenOpen(office: OfficeId): void {
    const open = this.#open.get(office);
    if (open !== undefined || this.#starting.has(office)) {
      throw new CommandError(
        "planning.open",
        `The office has an open planning session${open === undefined ? "" : ` (${open.run})`}: end it with planning.end first.`,
        open === undefined ? {} : { run: open.run },
      );
    }
  }

  async message(
    ctx: AsyncCommandContext,
    args: MessageArgs,
  ): Promise<CommandOutcome<MessageResult>> {
    const office = ctx.office.officeId as OfficeId;
    const open = this.#open.get(office);
    if (open === undefined) {
      throw notOpen(
        this.#starting.has(office)
          ? "it is continuing in a fresh model session; send the message again in a moment"
          : "start one with planning.start",
      );
    }
    await this.#deliver(open, args.text);
    return { result: { run: open.run, delivered: "next-turn" }, changed: true };
  }

  /**
   * The maintainer's text is the next user message: read after the answer in progress, if any. What
   * the maintainer decided since their last message goes first, as `[dipo]` lines.
   */
  async #deliver(open: Open, text: string): Promise<void> {
    if (open.ending !== null || open.settled) throw notOpen(`${open.run} is ending`);
    const notes = open.notes;
    const filing = await this.#filingNote(open);
    if (
      !(await this.#sendText(
        open,
        [...notes, ...(filing === null ? [] : [filing.note]), text].join("\n\n"),
      ))
    ) {
      throw notOpen(`${open.run} could not be reached`);
    }
    this.#recordMessage(open, text);
    // The view lists the message the moment it was kept (DIPO-490).
    this.#append(open, () => [this.#updated(open)]);
    if (filing !== null) open.filedSeen = filing.signature;
    open.notes = open.notes.slice(notes.length);
    open.autoRefusals = 0;
  }

  /** Keeps the maintainer's message in the record, with the model session's output offset (DIPO-489). */
  #recordMessage(open: Open, text: string): void {
    const { handle } = open;
    const at = this.#deps.clock.now();
    try {
      handle.immediate(() =>
        addPlanningEntry(handle, open.session, {
          kind: "message",
          run: open.run,
          text,
          outputOffset: outputEndOf(handle, open.run),
          at,
        }),
      );
    } catch (error) {
      this.#deps.warn?.("recording a planning message failed", {
        run: open.run,
        reason: messageOf(error),
      });
    }
  }

  /** `planning.answer`: the answers to a block of questions go to the session as one message. */
  async answer(ctx: AsyncCommandContext, args: AnswerArgs): Promise<CommandOutcome<AnswerResult>> {
    const office = ctx.office.officeId as OfficeId;
    const open = this.#open.get(office);
    if (open === undefined) throw notOpen("start one with planning.start");
    const block = open.questions.find((candidate) => candidate.n === args.block);
    if (block === undefined || block.answered) {
      throw new CommandError(
        "planning.questionsUnknown",
        `The planning session ${open.run} has no open question block ${args.block}.`,
        { block: args.block },
      );
    }
    const read = readAnswers(block.questions, args.answers);
    if (!read.ok) {
      throw new CommandError("planning.answerInvalid", `${read.problem}.`, { block: args.block });
    }
    await this.#deliver(open, answersMessage(block.questions, read.answers));
    block.answered = true;
    const at = this.#deps.clock.now();
    open.handle.immediate(() => {
      for (const [index, question] of block.questions.entries()) {
        addPlanningEntry(open.handle, open.session, {
          kind: "choice",
          subject: question.question,
          text: read.answers[index] ?? "",
          at,
        });
      }
    });
    return { result: { run: open.run, block: block.n, delivered: "next-turn" }, changed: true };
  }

  /** Sends `text` to the session as its next user message; false when it did not reach it. */
  async #sendText(open: Open, text: string): Promise<boolean> {
    const sent = await this.#send(open, this.#deps.worker.encode({ kind: "answer", text }));
    if (!sent) return false;
    this.#clearIdle(open);
    this.#watchdog.working(open.run);
    open.state = "working";
    this.#append(open, () => [this.#updated(open)]);
    return true;
  }

  // ---- proposals (DIPO-450) --------------------------------------------------------------------

  /** `planning.confirm`: files the proposal through the planning lane (see the file comment). */
  async confirm(
    ctx: AsyncCommandContext,
    args: ConfirmArgs,
  ): Promise<CommandOutcome<ConfirmResult>> {
    const { open, item } = this.#proposalOf(ctx, args.proposal);
    if (item.state === "declined") throw proposalClosed(item, "it was declined");
    const before = this.#proposalView(open, item);
    if (item.state === "confirmed" && before.state !== "failed") {
      return {
        result: {
          run: open.run,
          proposal: item.n,
          state: before.state,
          stories: before.stories ?? [],
        },
        changed: false,
      };
    }
    const lane = this.#deps.lane?.(open.office);
    if (lane === undefined) {
      throw new CommandError(
        "planning.notFiled",
        "This office has no backlog lane yet, so nothing can be filed; try again once it loaded.",
        { proposal: item.n },
      );
    }
    let changes: PlannedChange[];
    try {
      changes = await this.#journal(open, item, lane);
    } catch (error) {
      if (!(error instanceof PlanningRefusedError)) throw error;
      throw new CommandError("planning.notFiled", error.message, { proposal: item.n });
    }
    item.state = "confirmed";
    item.changes = changes;
    this.#append(open, () => [this.#updated(open)]);
    const last = changes.at(-1);
    const flush = last === undefined ? null : await lane.flush(last);
    const view = this.#proposalView(open, item);
    const stories = view.stories ?? [];
    const role = roleChangeOf(item.proposal);
    if (role !== null && view.state !== "failed") {
      // The role change is a confirmed choice of the record (DIPO-474).
      const at = this.#deps.clock.now();
      open.handle.immediate(() =>
        addPlanningEntry(open.handle, open.session, {
          kind: "choice",
          subject: `Proposal ${item.n}: role ${role.name}`,
          text: role.change,
          at,
        }),
      );
    }
    open.notes.push(
      view.state === "failed"
        ? `[dipo] The maintainer confirmed proposal ${item.n}, but it could not be filed: ${view.detail ?? "the backlog lane closed it"}.`
        : role !== null
          ? `[dipo] The maintainer confirmed proposal ${item.n}: role \`${role.name}\` ${role.change} in dipo's backlog PR. Do not propose it again.`
          : `[dipo] The maintainer confirmed proposal ${item.n}${stories.length === 0 ? "; dipo files it in its backlog PR" : `: ${stories.join(" and ")} in dipo's backlog PR`}.${(view.gate ?? []).map((line) => ` ${line.replace(/\.$/, "")}.`).join("")} Do not propose it again.`,
    );
    this.#append(open, () => [this.#updated(open)]);
    return {
      result: {
        run: open.run,
        proposal: item.n,
        state: view.state,
        stories,
        ...(flush === null ? {} : { flush }),
      },
      changed: true,
    };
  }

  /** `planning.edit`: the maintainer's version replaces an open proposal of the same kind. */
  async edit(ctx: AsyncCommandContext, args: EditArgs): Promise<CommandOutcome<EditResult>> {
    const { open, item } = this.#proposalOf(ctx, args.proposal);
    if (item.state === "declined") throw proposalClosed(item, "it was declined");
    if (item.state === "confirmed" && this.#proposalView(open, item).state !== "failed") {
      throw proposalClosed(item, "it was confirmed");
    }
    if (args.edited.kind !== item.proposal.kind) {
      throw new CommandError(
        "planning.kindChanged",
        `Proposal ${item.n} is a ${item.proposal.kind}; an edit keeps its kind, so propose a ${args.edited.kind} anew.`,
        { proposal: item.n },
      );
    }
    const checked = checkProposal(args.edited, this.#roleFacts(open), open.kind);
    if (!checked.ok) {
      throw new CommandError(
        "planning.invalid",
        `The edited proposal ${item.n} is not valid: ${checked.problems.join("; ")}.`,
        { proposal: item.n, problems: [...checked.problems] },
      );
    }
    item.proposal = checked.proposal;
    item.edited = true;
    item.state = "open";
    item.changes = [];
    open.notes.push(
      `[dipo] The maintainer edited proposal ${item.n}; it now reads: ${JSON.stringify(checked.proposal)}`,
    );
    this.#append(open, () => [this.#updated(open)]);
    return { result: { run: open.run, proposal: item.n }, changed: true };
  }

  /** `planning.decline`: nothing is filed for the proposal. */
  async decline(
    ctx: AsyncCommandContext,
    args: DeclineArgs,
  ): Promise<CommandOutcome<DeclineResult>> {
    const { open, item } = this.#proposalOf(ctx, args.proposal);
    const result: DeclineResult = { run: open.run, proposal: item.n, state: "declined" };
    if (item.state === "declined") return { result, changed: false };
    if (item.state === "confirmed" && this.#proposalView(open, item).state !== "failed") {
      throw proposalClosed(item, "it was confirmed and is filed through the backlog lane");
    }
    item.state = "declined";
    item.changes = [];
    open.notes.push(
      `[dipo] The maintainer declined proposal ${item.n}; nothing was filed for it. Do not propose it again unless they ask.`,
    );
    this.#append(open, () => [this.#updated(open)]);
    return { result, changed: true };
  }

  /** The open session of `ctx`'s office and its proposal `n`; throws the command errors. */
  #proposalOf(ctx: AsyncCommandContext, n: number): { open: Open; item: OpenProposal } {
    const open = this.#open.get(ctx.office.officeId as OfficeId);
    if (open === undefined) throw notOpen("start one with planning.start");
    if (open.ending !== null || open.settled) throw notOpen(`${open.run} is ending`);
    const item = open.proposals.find((candidate) => candidate.n === n);
    if (item === undefined) {
      throw new CommandError(
        "planning.proposalUnknown",
        `The planning session ${open.run} has no proposal ${n}.`,
        { proposal: n },
      );
    }
    return { open, item };
  }

  /**
   * Journals the lane changes of `item` after the checks code can make: a new story's title and
   * dependencies, an edited task's id and status. A split files the new story first and withdraws
   * it when the edit cannot be journaled.
   */
  async #journal(open: Open, item: OpenProposal, lane: PlanningLane): Promise<PlannedChange[]> {
    const { handle, run } = open;
    const proposal = item.proposal;
    switch (proposal.kind) {
      case "story": {
        const story = storyFieldsOf(proposal);
        this.#checkNewStory(open, item, story.title, story.dependencies ?? []);
        return [await lane.fileStory(fileTargetOf(run, item.n, story))];
      }
      case "edit": {
        const identity = this.#revisable(handle, proposal.id);
        this.#checkEditRole(open, item, proposal.role, "role");
        this.#checkEditDependencies(open, item, identity.story, proposal.dependencies ?? []);
        const change = await lane.reviseStory(
          identity,
          reviseTargetOf(run, item.n, editFieldsOf(proposal)),
        );
        return [change];
      }
      case "split": {
        const identity = this.#revisable(handle, proposal.id);
        this.#checkEditRole(open, item, proposal.edit.role, "edit.role");
        this.#checkNewStory(open, item, proposal.story.title, proposal.story.dependencies ?? []);
        this.#checkEditDependencies(open, item, identity.story, proposal.edit.dependencies ?? []);
        const filed = await lane.fileStory(fileTargetOf(run, item.n, proposal.story));
        let revised: PlannedChange;
        try {
          revised = await lane.reviseStory(identity, reviseTargetOf(run, item.n, proposal.edit));
        } catch (error) {
          lane.withdraw(filed);
          throw error;
        }
        return [filed, revised];
      }
      case "refine": {
        const draft = this.#openDraft(handle, proposal.draft);
        const story = refineFieldsOf(proposal);
        this.#checkNewStory(open, item, story.title, story.dependencies ?? [], draft.key);
        return [
          await lane.refineDraft(
            { key: draft.key, story: draft.story },
            refineTargetOf(run, item.n, story, draft.title),
          ),
        ];
      }
      case "drop": {
        const draft = this.#openDraft(handle, proposal.draft);
        return [await lane.drop({ key: draft.key, story: draft.story }, "draft")];
      }
      case "role":
        return [await lane.addRole(roleAddTargetOf(run, item.n, proposal))];
      case "role-edit":
        return [await lane.editRole(roleEditTargetOf(run, item.n, proposal))];
      case "role-remove":
        return [await lane.removeRole({ run, proposal: item.n, name: proposal.name })];
    }
  }

  /** Refuses an edit's role that is not in the roster of the base's role files now. */
  #checkEditRole(open: Open, item: OpenProposal, role: string | undefined, where: string): void {
    if (role === undefined) return;
    const problems = rosterProblems(role, this.#roleFacts(open), where);
    if (problems.length > 0) {
      throw new CommandError("planning.notFiled", problems.join("; "), { proposal: item.n });
    }
  }

  /** What the role proposals are checked against; none while the office's roles are not loaded. */
  #roleFacts(open: Open): RoleFacts | undefined {
    const files = this.#deps.roleFiles?.(open.office);
    if (files === undefined) return undefined;
    return {
      files,
      openStories: (name) => open.handle.deferred(() => openStoriesOfRole(open.handle, name)),
    };
  }

  /** The open draft a refine or drop names, with its title (DIPO-454). */
  #openDraft(handle: OfficeHandle, id: string): StoryIdentity & { readonly title: string } {
    const found = handle.deferred(() => resolveStoryRef(handle, id.toUpperCase()));
    const view = found.ok ? handle.deferred(() => storyView(handle, found.key)) : null;
    if (!found.ok || view === null || view.lifecycle !== "Draft") {
      throw new CommandError(
        "planning.storyUnknown",
        `This office has no open draft ${id} to refine or drop.`,
        { story: id },
      );
    }
    return { key: found.key, story: found.story, title: view.title };
  }

  /**
   * Refuses a new story whose title is taken or whose dependency the office does not know. A
   * refined draft (`self`) may keep its own title.
   */
  #checkNewStory(
    open: Open,
    item: OpenProposal,
    title: string,
    dependencies: readonly string[],
    self?: StoryKey,
  ): void {
    const { handle } = open;
    const wanted = titleKey(title);
    const taken = handle
      .deferred(() => activeStoryViews(handle))
      .find((view) => view.key !== self && titleKey(view.title) === wanted);
    const twin = open.proposals.find(
      (other) =>
        other !== item &&
        other.state === "confirmed" &&
        this.#proposalView(open, other).state !== "failed" &&
        newStoryTitle(other.proposal) !== null &&
        titleKey(newStoryTitle(other.proposal) ?? "") === wanted,
    );
    if (taken !== undefined || twin !== undefined) {
      throw new CommandError(
        "planning.duplicate",
        taken !== undefined
          ? `${taken.story} already has the title "${title}"; edit the proposal to give the new story its own title.`
          : `Proposal ${twin?.n ?? ""} files a story titled "${title}" already.`,
        { proposal: item.n },
      );
    }
    this.#checkDependencies(open, item, dependencies);
  }

  /** Refuses a dependency the office does not know and this session did not file. */
  #checkDependencies(open: Open, item: OpenProposal, dependencies: readonly string[]): void {
    const { handle } = open;
    for (const dependency of dependencies) {
      const id = dependency.toUpperCase();
      const found = handle.deferred(() => resolveStoryRef(handle, id));
      // A story of this session whose change the lane closed is not on any branch: no dependency.
      const filed = found.ok ? null : this.#sessionStory(open, id);
      if (!found.ok && (filed === null || filed.filing?.outcome === "closed")) {
        throw new CommandError(
          "planning.storyUnknown",
          `Proposal ${item.n} depends on ${dependency}, which neither this office nor this planning session has filed.`,
          { proposal: item.n, story: dependency },
        );
      }
    }
  }

  /**
   * Refuses an edit's dependencies the office cannot hold: an unknown one, the edited task itself,
   * or one that closes a dependency cycle with the backlog's other dependencies (DIPO-493).
   */
  #checkEditDependencies(
    open: Open,
    item: OpenProposal,
    story: string,
    dependencies: readonly string[],
  ): void {
    this.#checkDependencies(open, item, dependencies);
    const self = story.toUpperCase();
    const wanted = dependencies.map((dependency) => dependency.toUpperCase());
    if (wanted.includes(self)) {
      throw new CommandError(
        "planning.dependencyInvalid",
        `Proposal ${item.n} makes ${self} depend on itself; a story cannot depend on itself.`,
        { proposal: item.n, story: self },
      );
    }
    const rows = open.handle.deferred(() =>
      open.handle.all<{ story_id: string; deps: string | null }>(
        `select s.story_id as story_id, coalesce(m.gate_dependencies, m.waiting_on) as deps
           from stories s
           join backlog_mirror m on m.office_id = s.office_id and m.key = s.key
          where s.office_id = $office_id and s.removed_at is null`,
      ),
    );
    const edges = new Map<string, readonly string[]>();
    for (const row of rows) {
      const ids = row.deps === null ? [] : (JSON.parse(row.deps) as unknown);
      edges.set(
        row.story_id.toUpperCase(),
        Array.isArray(ids)
          ? ids.filter((id): id is string => typeof id === "string").map((id) => id.toUpperCase())
          : [],
      );
    }
    edges.set(self, wanted);
    const cycle = cycleThrough(self, edges);
    if (cycle !== undefined) {
      throw new CommandError(
        "planning.dependencyInvalid",
        `Proposal ${item.n} would make a dependency cycle (${cycle.join(" -> ")}); drop the dependency ${cycle[1] ?? ""} or change the order.`,
        { proposal: item.n, story: cycle[1] ?? self },
      );
    }
  }

  /**
   * The stories of the session's record, each with the filing the lane journaled for it. A story
   * whose filing PR has not merged has an id but no key yet: it is in the record only (DIPO-451).
   */
  #sessionStories(open: Open): SessionStory[] {
    const { handle } = open;
    const lane = this.#deps.lane?.(open.office);
    return handle
      .deferred(() => readPlanningRecord(handle, open.session))
      .flatMap((entry): SessionStory[] => {
        if (entry.kind !== "story" || entry.subject === null) return [];
        const subject = entry.subject;
        const kind = entry.text === "edited" ? "edited" : "filed";
        const own = handle.deferred(() => resolveStoryRef(handle, subject));
        const filing =
          lane === undefined || entry.run === null || entry.proposal === null
            ? undefined
            : lane
                .filingsOf(entry.run, entry.proposal)
                .find((candidate) => (kind === "edited") === (candidate.kind === REVISE_KIND));
        return [
          { story: own.ok ? own.story : subject, key: own.ok ? own.key : null, kind, filing },
        ];
      });
  }

  /**
   * The story `ref` names when this planning session filed or edited it, whether or not its filing
   * PR merged; null for anything else (DIPO-480).
   */
  #sessionStory(open: Open, ref: string): SessionStory | null {
    const { handle } = open;
    const id = ref.toUpperCase();
    const found = handle.deferred(() => resolveStoryRef(handle, id));
    return (
      this.#sessionStories(open).find(
        (entry) => entry.story === id || (found.ok && entry.key === found.key),
      ) ?? null
    );
  }

  /**
   * The stories the session filed or edited, with their state; `base` is the commit a story that
   * merged since the last message is first seen on the base at.
   */
  #filedStories(open: Open, base: string): FiledStory[] {
    return this.#sessionStories(open).map((entry): FiledStory => {
      const { filing } = entry;
      const merged = filing === undefined ? entry.key !== null : filing.merged;
      if (merged && !open.mergedSince.has(entry.story)) open.mergedSince.set(entry.story, base);
      return {
        story: entry.story,
        kind: entry.kind,
        title: filing?.target.title ?? null,
        dependencies:
          filing === undefined || filing.kind === REVISE_KIND ? [] : filing.target.dependencies,
        text: filing === undefined ? null : filingText(filing),
        state:
          filing?.outcome === "closed"
            ? "closed"
            : merged
              ? "merged"
              : filing === undefined
                ? "unknown"
                : "open",
        since: open.mergedSince.get(entry.story) ?? null,
        notice: filing?.notice ?? null,
      };
    });
  }

  /**
   * The `[dipo]` message that lists the session's filed stories, when a filing changed since the
   * last list the session got: a story was filed, its backlog PR merged or its change was closed.
   * The box copy is never refreshed; this is how the session knows them (DIPO-480).
   */
  async #filingNote(open: Open): Promise<{ note: string; signature: string } | null> {
    const stories = this.#sessionStories(open);
    if (stories.length === 0) return null;
    const unseen = stories.some(
      (entry) =>
        (entry.filing === undefined ? entry.key !== null : entry.filing.merged) &&
        !open.mergedSince.has(entry.story),
    );
    const git = this.#deps.git(open.office);
    const base =
      unseen && git !== undefined ? await (this.#deps.baseCommit ?? defaultBaseCommit)(git) : "";
    const filed = this.#filedStories(open, base);
    const signature = filedSignature(filed);
    if (signature === open.filedSeen) return null;
    return {
      signature,
      note: [
        "[dipo] The stories this planning session filed or edited, as they stand now. The copy of the base branch is not refreshed: a story filed, or merged, after its commit is in this list and not in the copy, so a story that is listed here is never missing.",
        filedStoriesText(filed),
      ].join("\n"),
    };
  }

  /** The task an edit changes: one the office knows, Refined, Ready or Parked. */
  #revisable(handle: OfficeHandle, id: string): StoryIdentity {
    const found = handle.deferred(() => resolveStoryRef(handle, id));
    const view = found.ok ? handle.deferred(() => storyView(handle, found.key)) : null;
    if (!found.ok || view === null || isProvisionalId(found.story)) {
      throw new CommandError("planning.storyUnknown", `This office has no task ${id} to edit.`, {
        story: id,
      });
    }
    if (!REVISABLE_LIFECYCLES.includes(view.lifecycle)) {
      throw new CommandError(
        "planning.storyUnknown",
        `${found.story} is ${view.lifecycle}; only a Refined, Ready or Parked story is edited in a planning session.`,
        { story: found.story },
      );
    }
    return { key: found.key, story: found.story };
  }

  /** Reads the proposal blocks of the answer that ended; refuses the invalid ones (DIPO-450). */
  #readAnswer(open: Open): void {
    const text = open.answer.join("\n");
    open.answer = [];
    if (text === "") return;
    const at = this.#deps.clock.now();
    try {
      open.handle.immediate(() =>
        recordLastAnswer(open.handle, open.session, {
          run: open.run,
          text,
          outputOffset: outputEndOf(open.handle, open.run),
          at,
        }),
      );
    } catch (error) {
      this.#deps.warn?.("recording a planning answer failed", {
        run: open.run,
        reason: messageOf(error),
      });
    }
    const refused: (readonly string[])[] = [];
    const refusedQuestions: (readonly string[])[] = [];
    for (const read of readQuestionBlocks(text)) {
      if (read.ok) {
        const n = open.questions.length + 1;
        open.questions.push({ n, questions: read.questions, answered: false, at });
        // Each question is open in the record until a choice answers it (DIPO-448).
        for (const question of read.questions) {
          open.handle.immediate(() =>
            addPlanningEntry(open.handle, open.session, {
              kind: "question",
              text: question.question,
              at,
            }),
          );
        }
      } else {
        refusedQuestions.push(read.problems);
        open.refusals.push({ at, problems: read.problems });
      }
    }
    for (const read of readProposals(text, this.#roleFacts(open), open.kind)) {
      if (read.ok) {
        open.proposals.push({
          n: open.proposals.length + 1,
          proposal: read.proposal,
          state: "open",
          edited: false,
          changes: [],
          at,
        });
      } else {
        refused.push(read.problems);
        open.refusals.push({ at, problems: read.problems });
      }
    }
    open.refusals = open.refusals.slice(-PLANNING_REFUSALS_SHOWN);
    if (refused.length === 0 && refusedQuestions.length === 0) return;
    const message = [
      ...(refused.length === 0 ? [] : [refusalMessage(refused)]),
      ...(refusedQuestions.length === 0 ? [] : [questionsRefusalMessage(refusedQuestions)]),
    ].join("\n\n");
    // Sent at once while the session refused fewer answers in a row than the cap, so it never loops.
    if (open.autoRefusals < AUTO_REFUSALS_MAX && open.ending === null) {
      open.autoRefusals += 1;
      void this.#sendText(open, message).then((sent) => {
        if (!sent) open.notes.push(message);
      });
    } else {
      open.notes.push(message);
    }
  }

  /** The view of one proposal: its state from the lane, its stories from the session's record. */
  #proposalView(open: Open, item: OpenProposal): PlanningProposalView {
    const { handle } = open;
    let state: PlanningProposalView["state"] = item.state;
    let detail: string | undefined;
    let gate: string[] = [];
    if (item.state === "confirmed") {
      const lane = this.#deps.lane?.(open.office);
      const outcomes = item.changes.map((change) => lane?.outcomeOf(change));
      // What the Ready gate decided for each story as the lane filed it (DIPO-495).
      gate = outcomes.flatMap((outcome) => (outcome?.gate === undefined ? [] : [outcome.gate]));
      const closed = outcomes.find((outcome) => outcome?.outcome === "closed");
      if (closed !== undefined) {
        state = "failed";
        detail = closed.notice ?? "the backlog lane closed it";
      } else {
        // A change the journal no longer has was applied and pruned.
        state = outcomes.every((outcome) => outcome === undefined || outcome.outcome === "applied")
          ? "filed"
          : "filing";
      }
    }
    const stories = handle
      .deferred(() => readPlanningRecord(handle, open.session))
      .filter((entry) => entry.kind === "story" && entry.proposal === item.n)
      .map((entry) => entry.subject ?? "");
    return {
      n: item.n,
      proposal: item.proposal,
      state,
      ...(item.edited ? { edited: true } : {}),
      ...(stories.length === 0 || state === "open" || state === "declined" ? {} : { stories }),
      ...(gate.length === 0 ? {} : { gate }),
      ...(detail === undefined ? {} : { detail }),
      at: iso(item.at),
    };
  }

  async end(ctx: AsyncCommandContext): Promise<CommandOutcome<EndResult>> {
    const office = ctx.office.officeId as OfficeId;
    const open = this.#open.get(office);
    if (open === undefined) throw notOpen("none was started");
    const reason = open.ending?.reason ?? "maintainer";
    await this.#stop(open, { reason });
    return { result: { run: open.run, ended: reason }, changed: true };
  }

  /**
   * Daemon stop: every open session gets the stop and ends `daemon-stopped` at once, since no
   * daemon reads its exit after the stop. Never rejects.
   */
  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.#open.values()].map(async (open) => {
        await this.#stop(open, { reason: "daemon-stopped" });
        await this.#finish(open, null);
      }),
    );
    this.#watchdog.close();
  }

  /**
   * Daemon start: a planning run of the loaded `offices` that a stopped daemon left open is ended
   * dropped; its box went with that daemon's stop or goes with the start sweep. Returns how many.
   */
  recover(offices: readonly OfficeId[]): number {
    let ended = 0;
    const at = this.#deps.clock.now();
    for (const office of offices) {
      const handle = this.#deps.offices.get(office);
      if (handle === undefined) continue;
      const followed = new Set(this.liveRuns());
      const left = handle
        .all<{ run_id: string }>(
          `select run_id from runs where office_id = $office_id and kind = 'session'
             and role = $role and ended_at is null`,
          { role: PLANNER_ROLE },
        )
        .filter((row) => !followed.has(row.run_id));
      for (const row of left) {
        handle.immediate(() => {
          endRun(handle, RunId.parse(row.run_id), at, "dropped");
          const session = planningSessionOfRun(handle, row.run_id);
          if (session !== null) {
            addPlanningEntry(handle, session, {
              kind: "ended",
              run: row.run_id,
              text: "daemon-stopped",
              at,
            });
          }
        });
        ended += 1;
      }
      if (left.length > 0) this.#deps.onChanged?.(office);
    }
    return ended;
  }

  // ---- start ---------------------------------------------------------------------------------

  async #begin(
    handle: OfficeHandle,
    office: OfficeId,
    args: {
      readonly kind: PlanningKind;
      readonly goal: string;
      /** The planning session this model session continues; null for a new one. */
      readonly session: RunId | null;
      readonly continued: Continued | null;
    },
  ): Promise<PlanningView> {
    const deps = this.#deps;
    const boxes = deps.boxes;
    const config = deps.offices.config(office);
    const git = deps.git(office);
    if (config === undefined || git === undefined) {
      throw new CommandError("planning.startFailed", `Office ${office} is not loaded.`);
    }
    if (boxes === undefined) {
      throw new CommandError(
        "planning.startFailed",
        "This daemon has no box backend, and a planning session runs only in a read-only box of its own (0008).",
      );
    }
    const run = RunId.parse(deps.ids.next("run"));
    const agent = AgentId.parse(deps.ids.next("agt"));
    const settings = config.planning;
    const startedAt = deps.clock.now();
    const open: Open = {
      office,
      handle,
      run,
      session: args.session ?? run,
      continued: args.continued,
      agent,
      kind: args.kind,
      goal: args.goal,
      model: settings.model,
      startedAt,
      state: "starting",
      turns: 0,
      lastOutputAt: null,
      contextTokens: null,
      compacted: false,
      ending: null,
      idle: null,
      grace: null,
      ingestor: null,
      settled: false,
      answer: [],
      proposals: [],
      questions: [],
      refusals: [],
      autoRefusals: 0,
      notes: [],
      filedSeen: null,
      mergedSince: new Map(),
    };
    this.#recordStart(open, config);
    this.#open.set(office, open);
    this.#announceStart(open);
    try {
      await this.#launch(open, config, git, boxes);
    } catch (error) {
      const detail = error instanceof CommandError ? error.message : messageOf(error);
      open.ending = { reason: "start-failed", detail };
      await this.#finish(open, null);
      if (error instanceof CommandError) throw error;
      throw new CommandError(
        "planning.startFailed",
        `The planning session did not start: ${detail}`,
        { run },
      );
    }
    return handle.deferred(() => this.#viewOf(open));
  }

  /** The run's row and the record's entries, in one transaction. */
  #recordStart(open: Open, config: OfficeConfig): void {
    const { handle, run, startedAt } = open;
    const settings = config.planning;
    const hash = configHash(config);
    handle.immediate(() => {
      recordConfigSnapshot(handle, hash, config, startedAt);
      insertRun(handle, {
        runId: run,
        kind: "session",
        key: null,
        story: null,
        tier: null,
        role: PLANNER_ROLE,
        model: settings.model,
        startSha: null,
        branch: null,
        budgetUnit: "tokens",
        // No run cap (DIPO-447): the session ends when the maintainer ends it.
        budgetLimit: 0,
        loopCap: 0,
        maxTurns: settings.maxTurns,
        maxMinutes: null,
        reviewRoundCap: null,
        configHash: hash,
        overrideKeys: null,
        runProfileId: currentProfileId(handle),
        startedAt,
      });
      if (open.session === run) {
        addPlanningEntry(handle, run, {
          kind: "goal",
          subject: open.kind,
          text: open.goal,
          at: startedAt,
        });
      }
      addPlanningEntry(handle, open.session, {
        kind: "started",
        run,
        subject: open.continued?.reason ?? "start",
        text: "",
        at: startedAt,
      });
    });
  }

  /** `planning.started`, and `planning.continued` for a fresh model session of a session. */
  #announceStart(open: Open): void {
    const { run, continued } = open;
    if (continued !== null) {
      this.#deps.info?.("a planning session continues in a fresh model session", {
        office: open.office,
        previous: continued.previous,
        run,
        reason: continued.reason,
        ...(continued.reason === "context-full" && continued.size !== undefined
          ? { contextTokens: continued.size }
          : {}),
      });
    }
    this.#append(open, () => [
      { type: "planning.started", run, delta: { run, view: this.#viewOf(open) } },
      ...(continued === null
        ? []
        : [
            {
              type: "planning.continued",
              run,
              delta: {
                run,
                previous: continued.previous,
                reason: continued.reason,
                view: this.#viewOf(open),
              },
            },
          ]),
    ]);
  }

  /** The session's spec and system file: its first message holds the facts code knows. */
  #spec(
    open: Open,
    config: OfficeConfig,
    paths: RunLaunchPaths,
    commit: string,
    preferences: string | null,
  ): { readonly spec: WorkerSpec; readonly systemFile: string } {
    const deps = this.#deps;
    const { handle, run, agent } = open;
    const settings = config.planning;
    const now = deps.clock.now();
    // The stories the session filed so far (a continuing session): the same list its messages carry.
    const filed = this.#filedStories(open, commit);
    open.filedSeen = filedSignature(filed);
    const taskMessage = planningFirstMessage(
      handle.deferred(() => {
        const loaded = loadRoleFiles(this.#roleFacts(open)?.files ?? new Map());
        return {
          kind: open.kind,
          goal: open.goal,
          record: planningRecordText(readPlanningRecord(handle, open.session), filed),
          drafts: planningDrafts(handle),
          desk: deps.desk?.(handle, now) ?? [],
          runs: recentStoryRuns(handle),
          roles: loaded.roles,
          invalidRoles: loaded.problems,
          roleRuns: open.kind === "roles" ? roleRunCounts(handle) : [],
          retro: retro(handle).lines.join("\n"),
          commit,
          proposalSchema: deps.worker.reportSchema.planning,
          preferences,
        };
      }),
    );
    const systemFile = renderSystemFile("planning-box", ROLE_TEMPLATES.planner);
    const spec: WorkerSpec = {
      run,
      agent,
      kind: "planning",
      workdir: paths.runDir,
      model: settings.model,
      effort: settings.effort,
      // Only the turns of one answer: no token or minute cap holds a planning session (DIPO-447).
      caps: { budgetTokens: 0, maxTurns: settings.maxTurns, maxMinutes: 0 },
      systemFile: join(paths.runDir, PLANNING_SYSTEM_FILE),
      taskMessage,
      web: false,
      session: { id: sessionUuid(agent) },
      // A planning session answers in text: its plan passes no schema.
      reportSchema: {},
    };
    return { spec, systemFile };
  }

  async #launch(
    open: Open,
    config: OfficeConfig,
    git: OfficeGit,
    boxes: NonNullable<PlanningSessionsDeps["boxes"]>,
  ): Promise<void> {
    const deps = this.#deps;
    const { handle, run, agent } = open;
    const paths = runLaunchPaths(git, deps, run);
    const commit = await (deps.baseCommit ?? defaultBaseCommit)(git);
    const preferences = await (deps.planningFile ?? defaultPlanningFile)(git, commit).catch(
      () => null,
    );
    const { spec, systemFile } = this.#spec(open, config, paths, commit, preferences);
    try {
      ensurePrivateDir(paths.runDir);
      prepareRunTempDirs(paths, run, deps.tempOwner?.());
      writeFileSync(spec.systemFile, systemFile, { mode: 0o600 });
    } catch (error) {
      throw new Error(`the run directory could not be prepared: ${messageOf(error)}`, {
        cause: error,
      });
    }
    let place: BoxSession;
    try {
      place = await boxes.planning({
        office: open.office,
        runId: run,
        agent,
        git,
        commit,
        systemFile: spec.systemFile,
      });
    } catch (error) {
      throw new Error(`its box could not be made: ${messageOf(error)}`, { cause: error });
    }
    let prepared;
    try {
      prepared = await deps.worker.prepare(
        spec,
        paths,
        config,
        sessionUuid(`${agent}:launch-check`),
        place,
      );
    } catch (error) {
      throw new Error(
        error instanceof PlanError
          ? `the launch plan refused it: ${error.message}`
          : messageOf(error),
        { cause: error },
      );
    }
    if (!prepared.ok) {
      throw new Error(
        `a launch check holds the adapter: ${prepared.pause.failures.map((f) => f.detail).join("; ")}`,
      );
    }
    let host: LaunchedHost;
    try {
      host = await deps.hosts.start(handle, {
        runId: run,
        agentId: agent,
        officeDir: paths.officeDir,
        plan: prepared.plan,
        record: () => this.#record(open, spec, systemFile, config),
      });
    } catch (error) {
      throw new Error(`its host did not start: ${messageOf(error)}`, { cause: error });
    }
    open.state = "working";
    this.#follow(open, spec, paths, config, host);
    this.#append(open, () => [this.#updated(open)]);
  }

  /** The session's agent and prompt parts, in the transaction that records its host. */
  #record(open: Open, spec: WorkerSpec, systemFile: string, config: OfficeConfig): void {
    const deps = this.#deps;
    const { handle, run, agent } = open;
    const settings = config.planning;
    const { taskMessage } = spec;
    recordAgent(handle, {
      agentId: agent,
      runId: run,
      role: PLANNER_ROLE,
      model: settings.model,
      effort: settings.effort,
      sessionId: spec.session.id,
      startedAt: deps.clock.now(),
    });
    recordPromptParts(handle, run, agent, promptParts(systemFile, taskMessage, []), deps.clock);
    recordPromptTexts(
      handle,
      run,
      agent,
      [
        { part: "system", text: systemFile },
        { part: "message", text: taskMessage },
      ],
      config,
      deps.clock,
    );
  }

  // ---- following -----------------------------------------------------------------------------

  /** Ingests the session's events until its exit; claims its host (DIPO-386). */
  #follow(
    open: Open,
    spec: WorkerSpec,
    paths: RunLaunchPaths,
    config: OfficeConfig,
    host: LaunchedHost,
  ): void {
    const deps = this.#deps;
    const { handle, run, agent } = open;
    const storyless: StorylessEvents = {
      output: (range) => {
        open.lastOutputAt = deps.clock.now();
        return { type: "planning.output", run, delta: { run, ...range, view: this.#viewOf(open) } };
      },
      usage: () => this.#updated(open),
    };
    const ingestor = new Ingestor({
      office: handle,
      clock: deps.clock,
      hooks: {
        onLines: () => this.#watchdog.lineSeen(run),
        onWorkerEvents: (_run, _agent, events: readonly WorkerEvent[]) => {
          for (const event of events) {
            if (event.t === "initRejected" || event.t === "startRefused") {
              void this.#stop(open, {
                reason: open.turns === 0 ? "start-failed" : "exited",
                detail: event.reason,
              });
            }
            // The context size is the last main-agent message's, never a spend: a subagent has a
            // context of its own (DIPO-489).
            if (event.t === "usage" && event.agentId === undefined) {
              open.contextTokens = contextSize(event);
            }
            if (event.t === "compacted") open.compacted = true;
            if (event.t === "output") {
              open.answer.push(event.text);
              this.#asides(open, event.text);
            }
            if (event.t === "turn") this.#turnEnded(open);
          }
        },
        onEnded: (_run, _agent, end) => void this.#finish(open, end),
        onAppended: () => deps.onChanged?.(open.office),
      },
      warn: (message, fields) => deps.warn?.(message, fields),
    });
    open.ingestor = ingestor;
    this.#watchdog.track(handle, run);
    void this.#claim(host, () => open.settled);
    try {
      ingestor.track({
        run,
        agent,
        role: PLANNER_ROLE,
        tier: "",
        budgetLimit: 0,
        model: spec.model,
        adapter: deps.worker.adapter(paths, config) as IngestAdapter,
        initialState: deps.worker.initialState(spec),
        storyless,
      });
    } catch (error) {
      deps.warn?.("ingesting a planning session failed", { run, reason: messageOf(error) });
      void this.#stop(open, { reason: "exited", detail: "its events could not be ingested" });
    }
  }

  /**
   * Holds the aside blocks of one output text as ideas, and says so of a refused one (DIPO-452).
   * A failed write is logged; the session goes on.
   */
  #asides(open: Open, text: string): void {
    if (!text.includes(ASIDE_FENCE)) return;
    const { handle } = open;
    try {
      const at = this.#deps.clock.now();
      const held = handle.immediate(() => {
        const asides = holdAsides(handle, { run: open.run, text, at });
        appendEntries(handle, asides.refused, { at });
        return asides;
      });
      if (held.refused.length > 0) this.#deps.onChanged?.(open.office);
      if (held.held > 0) this.#deps.onIdea?.(open.office);
    } catch (error) {
      this.#deps.warn?.("holding a planning session's asides failed", {
        run: open.run,
        reason: messageOf(error),
      });
    }
  }

  /** An answer ended: the session waits for the maintainer, with no watchdog wait running. */
  #turnEnded(open: Open): void {
    if (open.settled) return;
    open.turns += 1;
    if (open.ending !== null) return;
    this.#readAnswer(open);
    if (
      open.compacted ||
      (open.contextTokens ?? 0) >= (this.#deps.contextTokens ?? PLANNING_CONTEXT_TOKENS)
    ) {
      // The context nears full: this model session ends and a fresh one continues from the record.
      open.state = "waiting";
      void this.#stop(open, { reason: "context-full" });
      return;
    }
    open.state = "waiting";
    this.#watchdog.waiting(open.run);
    this.#clearIdle(open);
    const settings = this.#deps.offices.config(open.office)?.planning;
    const hours = settings?.idleHours ?? 24;
    open.idle = this.#deps.clock.setTimeout(() => {
      open.idle = null;
      void this.#stop(open, { reason: "idle" });
    }, hours * HOUR_MS);
    this.#append(open, () => [this.#updated(open)]);
  }

  /**
   * Ends the session's worker: a waiting one by closing its stdin, a working one with the stop,
   * then signals if it does not exit. The run ends once its exit is read, or after
   * `PLANNING_EXIT_GRACE_MS`. Once per session.
   */
  async #stop(
    open: Open,
    ending: { readonly reason: PlanningEndReason; readonly detail?: string },
  ): Promise<void> {
    if (open.settled || open.ending !== null) return;
    open.ending = ending;
    this.#clearIdle(open);
    this.#watchdog.untrack(open.run);
    open.grace = this.#deps.clock.setTimeout(() => {
      open.grace = null;
      void this.#finish(open, null);
    }, PLANNING_EXIT_GRACE_MS);
    const ops: readonly HostOp[] =
      open.state === "waiting"
        ? [
            { closeStdin: true },
            { signal: "SIGTERM", afterMs: PLANNING_SIGTERM_AFTER_MS },
            { signal: "SIGKILL", afterMs: PLANNING_SIGKILL_AFTER_MS },
          ]
        : this.#deps.worker.encode({ kind: "stop" });
    await this.#send(open, ops);
  }

  /** Sends `ops` to the session's host; false when they did not reach it. */
  async #send(open: Open, ops: readonly HostOp[]): Promise<boolean> {
    try {
      const sent = await this.#deps.steering.send(open.handle, open.run, ops);
      if (!sent.ok) {
        this.#deps.warn?.("sending to a planning session failed", {
          run: open.run,
          reason: sent.reason,
        });
      }
      return sent.ok;
    } catch (error) {
      this.#deps.warn?.("sending to a planning session failed", {
        run: open.run,
        reason: messageOf(error),
      });
      return false;
    }
  }

  /**
   * The session is over: its run ends (done when the maintainer, the idle end or a clean exit
   * ended it, else dropped), its box is deleted, and `planning.ended` follows. Once per session.
   */
  async #finish(open: Open, end: IngestedExit | null): Promise<void> {
    if (open.settled) return;
    open.settled = true;
    this.#clearIdle(open);
    if (open.grace !== null) this.#deps.clock.clearTimeout(open.grace);
    open.grace = null;
    this.#watchdog.untrack(open.run);
    const ingestor = open.ingestor;
    // Stopped after the exit's pass committed, outside its hooks.
    if (ingestor !== null) queueMicrotask(() => ingestor.close());
    const clean = end !== null && end.exit.code === 0 && end.exit.signal === null;
    const ending = open.ending ?? {
      reason: "exited" as const,
      ...(end === null ? {} : { detail: `its worker exited with code ${end.exit.code}` }),
    };
    open.ending = ending;
    open.state = "ended";
    const done =
      ending.reason === "maintainer" ||
      ending.reason === "context-full" ||
      ending.reason === "idle" ||
      (ending.reason === "exited" && clean);
    this.#endRecords(open, ending.reason, done ? "done" : "dropped");
    await this.#release(open, ending.reason);
  }

  /**
   * Frees the office's open slot and deletes the box. A full context continues in a fresh model
   * session, and the office stays taken meanwhile.
   */
  async #release(open: Open, reason: PlanningEndReason): Promise<void> {
    const continuing = reason === "context-full";
    if (continuing) this.#starting.add(open.office);
    if (this.#open.get(open.office) === open) this.#open.delete(open.office);
    this.#deps.onChanged?.(open.office);
    try {
      await this.#deps.boxes?.endPlanning(open.agent);
      if (continuing) await this.#continueFresh(open, reason);
    } catch (error) {
      this.#deps.warn?.("continuing a planning session failed", {
        run: open.run,
        reason: messageOf(error),
      });
    } finally {
      if (continuing) this.#starting.delete(open.office);
    }
  }

  /** Ends the run, and appends `planning.ended` and the record's end entry, in one transaction. */
  #endRecords(open: Open, reason: PlanningEndReason, runEnd: RunEnd): void {
    const at = this.#deps.clock.now();
    const { handle } = open;
    try {
      handle.immediate(() => {
        endRun(handle, open.run, at, runEnd);
        appendEntries(
          handle,
          [
            {
              type: "planning.ended",
              run: open.run,
              delta: { run: open.run, reason, view: this.#viewOf(open, at) },
            },
          ],
          { at },
        );
        addPlanningEntry(handle, open.session, { kind: "ended", run: open.run, text: reason, at });
      });
    } catch (error) {
      this.#deps.warn?.("ending a planning run failed", {
        run: open.run,
        reason: messageOf(error),
      });
    }
  }

  /** Starts the fresh model session that continues the planning session of `open`. */
  async #continueFresh(open: Open, reason: PlanningEndReason): Promise<void> {
    await this.#begin(open.handle, open.office, {
      kind: open.kind,
      goal: open.goal,
      session: open.session,
      continued: {
        previous: open.run,
        reason,
        ...(open.contextTokens === null ? {} : { size: open.contextTokens }),
      },
    });
  }

  #clearIdle(open: Open): void {
    if (open.idle !== null) this.#deps.clock.clearTimeout(open.idle);
    open.idle = null;
  }

  /** Connects to the session's new host and claims it; says so when it could not (DIPO-386). */
  async #claim(host: LaunchedHost, settled: () => boolean): Promise<void> {
    const deps = this.#deps;
    const unclaimed = (reason: string) =>
      deps.warn?.("the planning session's host was not claimed; it stops at its launch deadline", {
        run: host.runId,
        reason,
      });
    try {
      const connected = await connectWhenBound(host, deps.clock, settled);
      if (!connected.ok) {
        if (!settled()) unclaimed(connected.reason);
        return;
      }
      try {
        const refused = await claimHost(connected.client, host.pid);
        if (refused !== null) unclaimed(refused);
      } finally {
        connected.client.close();
      }
    } catch (error) {
      unclaimed(messageOf(error));
    }
  }

  // ---- views and entries ---------------------------------------------------------------------

  /** Appends the entries `build` returns in one transaction, and tells the subscribers. */
  #append(open: Open, build: () => readonly NewEntry[]): void {
    const at = this.#deps.clock.now();
    const { handle } = open;
    const appended = handle.immediate(() => {
      const entries = build();
      appendEntries(handle, entries, { at });
      return entries.length;
    });
    if (appended > 0) this.#deps.onChanged?.(open.office);
  }

  /** `planning.updated` with the view now; inside the caller's transaction. */
  #updated(open: Open): NewEntry {
    return {
      type: "planning.updated",
      run: open.run,
      delta: { run: open.run, view: this.#viewOf(open) },
    };
  }

  /**
   * The session's model sessions in order and the maintainer's messages, from the record
   * (DIPO-490). The model session of `open` is always listed; its end is not in the record yet
   * while its `planning.ended` is being written, so it comes from `open`.
   */
  #conversationOf(
    open: Open,
    endedAt: number | undefined,
  ): { sessions: PlanningModelSession[]; messages: PlanningMessageView[] } {
    const entries = readPlanningRecord(open.handle, open.session);
    const sessions: PlanningModelSession[] = entries
      .filter((entry) => entry.kind === "started" && entry.run !== null)
      .map((started) => {
        const run = started.run as string;
        const end = entries.find((entry) => entry.kind === "ended" && entry.run === run);
        return {
          run: RunId.parse(run),
          startedAt: iso(started.at),
          ...(end === undefined ? {} : { endedAt: iso(end.at), ended: end.text }),
        };
      });
    const current = sessions.findIndex((item) => item.run === open.run);
    const now: PlanningModelSession = {
      ...(sessions[current] ?? { run: open.run, startedAt: iso(open.startedAt) }),
      ...(endedAt === undefined || open.ending === null || open.state !== "ended"
        ? {}
        : { endedAt: iso(endedAt), ended: open.ending.reason }),
    };
    if (current === -1) sessions.push(now);
    else sessions[current] = now;
    const messages = entries
      .filter((entry) => entry.kind === "message" && entry.run !== null)
      .map((entry) => ({
        run: RunId.parse(entry.run),
        text: entry.text,
        outputOffset: entry.outputOffset ?? 0,
        at: iso(entry.at),
      }));
    return { sessions, messages };
  }

  /** The planning view of `open`, from its state and the stored usage and signals. */
  #viewOf(open: Open, endedAt?: number): PlanningView {
    const { handle } = open;
    const usage =
      open.state === "starting"
        ? ZERO_TOTALS
        : readUsage(handle, {
            run: open.run,
            agent: open.agent,
            role: PLANNER_ROLE,
            tier: "",
            budgetLimit: 0,
          }).run;
    const noOutput = activeSignals(handle, open.run).find((fact) => fact.signal === "no-output");
    const { sessions, messages } = this.#conversationOf(open, endedAt);
    return {
      run: open.run,
      session: open.session,
      ...(open.state === "starting" ? {} : { agent: open.agent }),
      kind: open.kind,
      goal: open.goal,
      model: open.model,
      state: open.state,
      // Quiet or stuck only while it works on an answer, never while it waits (DIPO-447).
      ...(open.state === "working"
        ? {
            health: noOutput === undefined ? "busy" : noOutput.stuckAt === null ? "quiet" : "stuck",
          }
        : {}),
      turns: open.turns,
      usage,
      startedAt: iso(open.startedAt),
      ...(open.lastOutputAt === null ? {} : { lastOutputAt: iso(open.lastOutputAt) }),
      ...(open.continued === null ? {} : { continuedAt: iso(open.startedAt) }),
      sessions,
      ...(messages.length === 0 ? {} : { messages }),
      ...(endedAt === undefined ? {} : { endedAt: iso(endedAt) }),
      ...(open.ending === null || open.state !== "ended" ? {} : { ended: open.ending.reason }),
      ...(open.ending?.detail === undefined || open.state !== "ended"
        ? {}
        : { detail: open.ending.detail }),
      ...(open.proposals.length === 0
        ? {}
        : { proposals: open.proposals.map((item) => this.#proposalView(open, item)) }),
      ...(open.refusals.length === 0
        ? {}
        : {
            refusals: open.refusals.map((refusal) => ({
              at: iso(refusal.at),
              problems: [...refusal.problems],
            })),
          }),
      ...(open.questions.every((block) => block.answered)
        ? {}
        : {
            questions: open.questions
              .filter((block) => !block.answered)
              .map((block) => ({ n: block.n, questions: [...block.questions], at: iso(block.at) })),
          }),
    };
  }
}

/** The office planning file at `commit`; null when the commit has none. */
async function defaultPlanningFile(git: OfficeGit, commit: string): Promise<string | null> {
  return git.run(async (session) => {
    const shown = await session.step(session.repository, [
      "show",
      `${commit}:${PLANNING_PREFERENCES_FILE}`,
    ]);
    return shown.code === 0 ? shown.stdout : null;
  });
}

/** The tip of `<remote>/<base>`, the commit the planning copy holds. */
async function defaultBaseCommit(git: OfficeGit): Promise<string> {
  const { commit } = await git.run((session) => baseCommit(git, session));
  return commit;
}
