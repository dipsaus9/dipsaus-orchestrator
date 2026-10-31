// Parking a story (DIPO-50; 0012 F16 and the transition In Progress or In Review to Parked, 0010
// sections 2 and 3, 0005 section 5, 0007 section 4, 0008 section 2).
//
// `parkStory` writes the park on the story branch first, through a `ParkWriter`: in one story lane
// edit of the StoryStore (`editOnBranch`), inside the office's git queue, the store writes the F16
// `park` block (`{reason, from, note}`) through the single field write path, sets status `Parked` and appends the
// park's structured summary block to the implementation notes (0020 section 13, `summary.ts`; a
// lift appends the resume line the same way); only the task file is committed, as
// `<ID>: status Parked`, and the branch is pushed without force. Then,
// in one transaction, it records the park's run detail and history in `parks` (the reason it was
// made with, detail, last good commit, time), sets the story index's read of the story to what the
// branch write read back (status Parked and the F16 record, `mirrorPark`), ends the run parked
// (0020) and emits `story.state` to Parked and `story.parked` with the actions the engine
// implements. The current reason and origin are Backlog.md's: every reader asks `openPark`, never
// `parks` (DIPO-360, 0001, 0007).
//
// A park has one of the eight reasons of 0001 and a one-line detail. The detail is text: no code
// decides anything from it (0020).
//
// A task file holding fields dipo does not know parks the story `scope-violation` instead, with the
// refusal as detail. A park that could not be written on the branch, or a push that failed, is still
// recorded in `parks` and emitted, with an `engine.notice` saying what is missing. One not written
// on the branch is no park while Backlog.md does not hold it: `openPark` answers null and reconcile
// closes its row with a notice.

import {
  type CommandName,
  type FieldBlock,
  type Lifecycle,
  type OfficeId,
  type ParkReason,
  StoryId,
  type WorkRef,
} from "@dipsaus-orchestrator/contract";

import { CommandError } from "../commands/errors";
import type { NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import { gateStoryFromView } from "../gate/input";
import { contractCharacters } from "../gate/rules";
import type { OfficeGit } from "../git/office";
import { GitError } from "../git/runner";
import { branchTip, pushBranch } from "../git/write";
import { recordBranchPush } from "../records/story-prs";
import { insertWorkerQuestion, questionViewOf } from "../run-state/questions";
import { presetEndReasons } from "../records/agents";
import { TASK_FIELD_ERROR } from "../story-store/errors";
import { parseFieldBlock } from "../story-store/fields/block";
import type { StoryEditor, StoryStore } from "../story-store/store";
import { deriveStoryView, storyView } from "../views/story";
import { workRefOf } from "../views/work";
import { PARKED_STATUS } from "../worktree/done";

import { endRunMarked } from "../ingest/markers";
import { mirrorPark } from "../records/park-state";
import { appendRunStep, findRun, type StoredRun } from "../records/run-records";
import { parkResumeNeed } from "../records/resume-policy";
import { renderParkBlock, runSummaryFacts } from "../records/summary";

import { insertPark, reparkOpen } from "../run-state/park-records";

export { openParkIds, type ParkResolution, resolvePark } from "../run-state/park-records";
export { type BacklogPark, backlogPark, type OpenPark, openPark } from "../records/park-state";

/** The error of a maintainer's park whose write to Backlog.md failed (DIPO-360). */
export const PARK_NOT_WRITTEN = "story.parkNotWritten";

/** `engine.notice` codes of a park. */
export const PARK_NOTICES = {
  notWritten: "park.notWritten",
  pushFailed: "park.pushFailed",
  /** The park or lift was written, but its implementation-notes summary was not (0020 section 13). */
  summaryMissing: "park.summaryMissing",
  /**
   * A question park was resumed with its answer, but the answer was not written to the story's
   * unknowns: writing it would break R26, or the write failed (0020 section 7, DIPO-159).
   */
  answerNotWritten: "park.answerNotWritten",
} as const;

/** Commands a parked story's `actions` may offer, when the engine implements them (0005). */
const PARK_ACTIONS: readonly CommandName[] = [
  "work.resume",
  "work.answer",
  "work.discard",
  "story.drop",
] as CommandName[];

/** What the branch write needs. */
export interface ParkBranchRequest {
  readonly story: string;
  readonly branch: string;
  readonly reason: ParkReason;
  readonly note: string;
  /**
   * The implementation-notes block of the park (0020 section 13), built from what the branch
   * write reads; appended in the same task-file commit as F16 when the park is new on the branch.
   */
  readonly summary?: (branch: ParkBranchFacts) => string;
}

/** What the branch write reads for the park's summary block. */
export interface ParkBranchFacts {
  /** The branch tip before the park commit. */
  readonly lastGoodCommit: string;
}

/** What the branch write did. */
export interface BranchPark {
  /** The park commit, or null when the task file already held the park. */
  readonly commit: string | null;
  /** The branch tip before the park commit. */
  readonly lastGoodCommit: string;
  /** The lifecycle the story left, read from its status on the branch. */
  readonly from: Lifecycle;
  /** True when the branch was pushed; false without a remote or when the push failed. */
  readonly pushed: boolean;
  /** Why the push failed, or null. */
  readonly pushError: string | null;
  /**
   * Why the park's summary block was not written, or null: a failure building or appending it
   * never costs the park, whose F16 block and status are committed without it.
   */
  readonly summaryError?: string | null;
}

/** Writes the park on the story branch (the real one is `gitParkWriter`). */
export interface ParkWriter {
  write(office: OfficeId, request: ParkBranchRequest): Promise<BranchPark>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Appends a summary text to the story's implementation notes; the reason it failed, or null. A
 * failed append is caught, so the edit it is part of still commits its F16 block and status.
 */
async function appendOrReason(story: StoryEditor, text: string): Promise<string | null> {
  try {
    await story.appendNotes(text);
    return null;
  } catch (error) {
    return `appending it failed: ${messageOf(error)}`;
  }
}

/** The park written on the story branch with the story store and the office git. */
export function gitParkWriter(deps: {
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  readonly stories: StoryStore;
}): ParkWriter {
  return {
    async write(office, request) {
      const git = deps.git(office);
      if (git === undefined) throw new Error(`Office ${office} has no git attached.`);
      return git.run(async (session) => {
        const lastGoodCommit = await branchTip(session, request.branch);
        // The summary block is built before the CLI writes anything, and a failure building or
        // appending it only leaves it out (`summaryError`): the park itself is always written.
        let block: string | null = null;
        let summaryError: string | null = null;
        if (request.summary !== undefined) {
          try {
            block = request.summary({ lastGoodCommit });
          } catch (error) {
            summaryError = `building it failed: ${messageOf(error)}`;
          }
        }
        // Only the task file.
        const { value: from, commit } = await deps.stories.editOnBranch(
          git,
          session,
          request,
          `${request.story}: status ${PARKED_STATUS}`,
          async (story) => {
            const before = await story.view();
            const left: Lifecycle = before.status === "In Review" ? "In Review" : "In Progress";
            await story.writeFields((fields) => ({
              ...fields,
              park: { reason: request.reason, from: left, note: request.note },
            }));
            if (before.status !== PARKED_STATUS) await story.setStatus(PARKED_STATUS);
            const back = await story.view();
            if (back.status !== PARKED_STATUS) {
              throw new GitError(
                "park.statusNotWritten",
                `The Backlog CLI left ${request.story} at ${back.status}, not ${PARKED_STATUS}.`,
              );
            }
            // The park's summary block (0020 section 13), once: a park already on the branch (a
            // retried write) appends nothing.
            if (block !== null && before.status !== PARKED_STATUS) {
              summaryError = await appendOrReason(story, block);
            }
            return left;
          },
        );
        const pushed = await pushBranch(session, git.settings.remote, request.branch);
        return {
          commit,
          lastGoodCommit,
          from,
          pushed: pushed.pushed,
          pushError: pushed.error,
          summaryError,
        };
      });
    },
  };
}

/** What lifting a park on the story branch needs (DIPO-75). */
export interface UnparkBranchRequest {
  readonly story: string;
  readonly branch: string;
  /** The lifecycle the story returns to (the park's `from`). */
  readonly to: Lifecycle;
  /**
   * The resume's implementation-notes line (0020 section 13), appended in the same task-file
   * commit when the park is still on the branch; a lift already written appends nothing.
   */
  readonly line?: string;
  /**
   * The answer of a question park's resume (0020 section 7, DIPO-159): added to the story's
   * unknowns as a resolved unknown in the same commit, through the single field write path, unless
   * the story contract would then be over `contractMax` characters (R26).
   */
  readonly answer?: UnparkAnswer;
}

/** The answer a question park's lift writes to the story as a resolved unknown. */
export interface UnparkAnswer {
  /** The worker's question. */
  readonly q: string;
  readonly answer: string;
  /** `prompt.contractMax` of the office (R26). */
  readonly contractMax: number;
}

/**
 * Pure: the field block with `answer` as a resolved unknown (DIPO-159), replacing an unknown with
 * the same question, so a lift written again changes nothing.
 */
export function withResolvedUnknown(
  fields: FieldBlock,
  answer: Pick<UnparkAnswer, "q" | "answer">,
): FieldBlock {
  const q = answer.q.trim();
  const unknown = { q, status: "resolved" as const, answer: answer.answer.trim() };
  const kept = (fields.unknowns ?? []).filter((candidate) => candidate.q.trim() !== q);
  return { ...fields, unknowns: [...kept, unknown] };
}

/** What lifting the park on the branch did. */
export interface BranchUnpark {
  /** The commit, or null when the task file already held no park and the status. */
  readonly commit: string | null;
  readonly pushed: boolean;
  readonly pushError: string | null;
  /** Why the resume's line was not appended, or null; the lift itself is always committed. */
  readonly lineError?: string | null;
  /**
   * Why the request's answer was not written as a resolved unknown (it would break R26), or null;
   * the lift itself is always committed, and the answer still reaches the worker.
   */
  readonly answerError?: string | null;
}

/** Lifts a park on the story branch (the real one is `gitUnparkWriter`). */
export interface UnparkWriter {
  lift(office: OfficeId, request: UnparkBranchRequest): Promise<BranchUnpark>;
}

/**
 * The park lifted on the story branch with the story store and the office git (DIPO-75): in one
 * story lane edit (`editOnBranch`), the F16 `park` block is removed through
 * the single field write path and the status set back to the park's `from`; only the task file is
 * committed on the branch, as `<ID>: status <to>`, and the branch is pushed without force. The
 * answer of a question park goes into the same field write as a resolved unknown, unless the
 * story contract would then break R26 (`answerError`).
 */
export function gitUnparkWriter(deps: {
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  readonly stories: StoryStore;
}): UnparkWriter {
  return {
    async lift(office, request) {
      const git = deps.git(office);
      if (git === undefined) throw new Error(`Office ${office} has no git attached.`);
      return git.run(async (session) => {
        let lineError: string | null = null;
        let answerError: string | null = null;
        const answer = request.answer;
        // Only the task file.
        const { commit } = await deps.stories.editOnBranch(
          git,
          session,
          request,
          `${request.story}: status ${request.to}`,
          async (story) => {
            const before = await story.view();
            await story.writeFields((fields) => {
              const { park: _park, ...rest } = fields;
              if (answer === undefined) return rest;
              // The answer is a story fact only while the contract stays within R26.
              const answered = withResolvedUnknown(rest, answer);
              const size = contractCharacters(gateStoryFromView(before, []), answered);
              answerError =
                size <= answer.contractMax
                  ? null
                  : `the story contract would be ${size} characters with it, over the limit of ${answer.contractMax} (R26)`;
              return answerError === null ? answered : rest;
            });
            if (before.status !== request.to) await story.setStatus(request.to);
            const back = await story.view();
            if (back.status !== request.to) {
              throw new GitError(
                "park.statusNotWritten",
                `The Backlog CLI left ${request.story} at ${back.status}, not ${request.to}.`,
              );
            }
            const lifting =
              before.status !== request.to ||
              parseFieldBlock(before.description).fields.park !== undefined;
            if (request.line !== undefined && lifting) {
              lineError = await appendOrReason(story, request.line);
            }
          },
        );
        const pushed = await pushBranch(session, git.settings.remote, request.branch);
        return {
          commit,
          pushed: pushed.pushed,
          pushError: pushed.error,
          lineError,
          ...(answer === undefined ? {} : { answerError }),
        };
      });
    },
  };
}

export interface ParkDeps {
  readonly office: OfficeHandle;
  readonly writer: ParkWriter;
  readonly now: () => number;
  /** Runs `fn` in one transaction and appends the entries it returns. */
  readonly write: (fn: () => readonly NewEntry[]) => void;
  /** True when the engine implements the command; `actions` lists only those. */
  readonly implemented: (name: CommandName) => boolean;
  /** The worker question of an `ambiguous-spec` park: a new question id. Without it none is asked. */
  readonly question?: { readonly id: () => string };
}

/**
 * Inside the park's transaction, after the park row (DIPO-272, DIPO-159): a worker question still
 * open when the run parks (asked live and then let go by a cap, a stop, the end of its wait, the
 * last TUI closing or the worker's own exit) becomes this park's question and stays open, so the
 * maintainer's question is not lost. So does one of the session that parks whose answer came while
 * the run was ending and is held for the next session. Nothing is emitted: the question was asked
 * already. Returns the park's id, or null.
 */
function carryWorkerQuestions(office: OfficeHandle, run: StoredRun): number | null {
  const park = office.get<{ park_id: number }>(
    `select park_id from parks where office_id = $office_id and run_id = $run
      order by park_id desc limit 1`,
    { run: run.runId },
  );
  if (park === null) return null;
  office.run(
    `update questions set park_id = $park
      where office_id = $office_id and run_id = $run and kind = 'question' and park_id is null
        and (closed_at is null
          or (closed_how = 'answered' and delivered = 'on-resume'
            and asked_at >= coalesce((select max(started_at) from agents
              where office_id = $office_id and run_id = $run), 0)))`,
    { park: park.park_id, run: run.runId },
  );
  return park.park_id;
}

/**
 * Inside the park's transaction, after the carry (DIPO-159, 0020): an `ambiguous-spec` park that
 * carries no worker question asks its own (the worker's question when no TUI was connected), kind
 * `question`, linked to the run and the park, and emits `question.asked`, so the maintainer can
 * answer it with `dipo answer <question> --text`.
 */
function askWorkerQuestionOfPark(
  deps: ParkDeps,
  request: ParkRequest,
  park: { readonly parkId: number | null; readonly reason: ParkReason },
  at: number,
): NewEntry[] {
  const { run } = request;
  const text = request.question?.trim() ?? "";
  if (park.reason !== "ambiguous-spec") return [];
  if (park.parkId === null || deps.question === undefined || run.key === null) return [];
  const office = deps.office;
  const carried = office.get<{ found: number }>(
    `select 1 as found from questions where office_id = $office_id and park_id = $park
      and kind = 'question' limit 1`,
    { park: park.parkId },
  );
  const work = request.work ?? workRefOf(office, run.runId);
  if (carried !== null || work === null || text === "") return [];
  const question = insertWorkerQuestion(office, {
    questionId: deps.question.id(),
    runId: run.runId,
    agentId: work.agent,
    text,
    at,
    parkId: park.parkId,
  });
  const view = questionViewOf(office, question);
  return view === null
    ? []
    : [{ type: "question.asked", key: run.key, run: run.runId, delta: view }];
}

export interface ParkRequest {
  /** The story run that parks; its story and branch are set. */
  readonly run: StoredRun;
  readonly work?: WorkRef;
  readonly reason: ParkReason;
  readonly detail: string;
  /** The `cap` run step value of a done turn that crossed a cap, written with the run's end (DIPO-222). */
  readonly capStep?: string;
  /**
   * The worker's question of an `ambiguous-spec` park (DIPO-159): asked as the park's question
   * unless an open question of the run carries over to it.
   */
  readonly question?: string;
  /**
   * The maintainer's park of a run that waits and was not stopped (DIPO-360): when the write to
   * Backlog.md fails, nothing is recorded or emitted and `parkStory` throws
   * `story.parkNotWritten`, so the maintainer can send it again. A task file holding fields dipo
   * does not know still parks `scope-violation`, held until reconcile (`heldByPark`).
   */
  readonly mustWrite?: boolean;
  /**
   * The unresolved park row of this run whose write to Backlog.md failed (DIPO-360): the park is
   * written again on it instead of a new row, so no second open row holds the story.
   */
  readonly parkId?: number;
  /**
   * A park a plan limit made (0020): dipo resumes it by itself when the office's starts paused
   * lifts (`parks.resume_on_lift`, `starts-paused.ts`).
   */
  readonly resumeOnLift?: boolean;
}

export interface ParkOutcome {
  readonly reason: ParkReason;
  readonly detail: string;
  readonly from: Lifecycle;
  /** The park commit on the story branch, or null when none was written. */
  readonly commit: string | null;
  readonly lastGoodCommit: string | null;
  readonly pushed: boolean;
  /** True when Backlog.md holds the park (DIPO-360). */
  readonly written: boolean;
  /** Why the write to Backlog.md failed, or null. */
  readonly writeError: string | null;
}

/**
 * The actions a parked story offers (0005): only commands the engine implements, `work.answer`
 * for an `ambiguous-spec` park, which waits on its question's answer, and `work.resume` only for a
 * reason the 0020 table resumes.
 */
export function parkActions(
  reason: ParkReason,
  implemented: (name: CommandName) => boolean,
): CommandName[] {
  return PARK_ACTIONS.filter(
    (name) =>
      (name !== "work.answer" || reason === "ambiguous-spec") &&
      (name !== "work.resume" || parkResumeNeed(reason).kind === "resume") &&
      implemented(name),
  );
}

/** Parks the run's story; see the file comment. Never throws for a branch write that failed. */
export async function parkStory(deps: ParkDeps, request: ParkRequest): Promise<ParkOutcome> {
  const { run } = request;
  const story = run.story;
  const key = run.key;
  if (run.kind !== "story" || story === null || key === null) {
    throw new Error(`${run.runId} is not a story run; only a story parks.`);
  }
  let reason = request.reason;
  let detail = request.detail;
  let branch: BranchPark | null = null;
  let writeError: string | null = null;
  const notices: NewEntry[] = [];
  const notice = (code: string, text: string): void => {
    notices.push({ type: "engine.notice", key, delta: { level: "warn", code, text } });
  };
  try {
    const parked = { reason, detail };
    branch = await deps.writer.write(deps.office.officeId, {
      story,
      branch: run.branch ?? "",
      reason,
      note: detail,
      // The implementation-notes block, from the stored facts as of the park (0020 section 13).
      summary: (facts) => {
        const at = deps.now();
        return renderParkBlock({
          at,
          ...parked,
          runId: run.runId,
          ...runSummaryFacts(deps.office, run, at),
          ...facts,
        });
      },
    });
  } catch (error) {
    writeError = messageOf(error);
    if (error instanceof GitError && error.code === TASK_FIELD_ERROR) {
      // 0021 section 14: a task file holding fields dipo does not know never reaches the CLI.
      detail =
        reason === "scope-violation"
          ? `${error.message} ${detail}`
          : `${error.message} (dipo was parking it as ${reason}: ${detail})`;
      reason = "scope-violation";
      notice(
        PARK_NOTICES.notWritten,
        `${story} parked as scope-violation, but the park was not written on ${run.branch ?? "its branch"}: its task file holds fields dipo does not know.`,
      );
    } else if (request.mustWrite === true) {
      throw new CommandError(
        PARK_NOT_WRITTEN,
        `${story} was not parked: writing the park on ${run.branch ?? "its branch"} failed (${messageOf(error)}). dipo recorded nothing; send the park again.`,
        { story },
      );
    } else {
      notice(
        PARK_NOTICES.notWritten,
        `${story} parked as ${reason}, but writing the park on ${run.branch ?? "its branch"} failed: ${messageOf(error)}`,
      );
    }
  }
  if (branch?.summaryError != null) {
    notice(
      PARK_NOTICES.summaryMissing,
      `${story} is parked, but its summary block is missing from the task file's implementation notes: ${branch.summaryError}`,
    );
  }
  if (branch?.pushError != null) {
    notice(
      PARK_NOTICES.pushFailed,
      `${story} is parked, but ${branch.pushError}; the park is on the local branch only until a later push succeeds.`,
    );
  }
  const from: Lifecycle = branch?.from ?? "In Progress";
  const lastGoodCommit = branch?.lastGoodCommit ?? null;
  const at = deps.now();
  // Only the park the plan limit asked for resumes by itself, not one a refused task file turned
  // into `scope-violation`.
  const resumeOnLift = request.resumeOnLift === true && reason === request.reason;
  deps.write(() => {
    const office = deps.office;
    // Run detail and history (0007): the reason is the one the park was made with, never read as
    // the current reason; Backlog.md holds that, and its read-back goes to the mirror (DIPO-360).
    if (request.parkId !== undefined) {
      reparkOpen(office, request.parkId, { reason, detail, lastGoodCommit });
    } else
      insertPark(office, {
        key,
        story,
        runId: run.runId,
        reason,
        detail,
        lastGoodCommit,
        at,
        resumeOnLift,
      });
    // Only a park written on the branch is a park: one that failed stays in `parks` as detail,
    // and reconcile closes it (DIPO-360).
    if (branch !== null) mirrorPark(office, key, { reason, from, note: detail }, at);
    if (request.capStep !== undefined) appendRunStep(office, run.runId, "cap", request.capStep, at);
    // The park commit's push, on the claim like every story-branch push (DIPO-315).
    if (branch !== null && run.branch !== null) {
      recordBranchPush(office, run.branch, { pushed: branch.pushed, error: branch.pushError }, at);
    }
    // The run ends parked (0020); a run open at In Review keeps the end of its last active period.
    // A park Backlog.md does not hold ends no run that stands open at In Review: nothing was
    // stopped, the park row holds it until reconcile closes it or the park is written again.
    if (branch !== null || findRun(office, run.runId)?.endedAt == null) {
      endRunMarked(office, run.runId, at, "parked");
    }
    // The agent ends when its exit is ingested; the reason it ended is known now: the park's.
    presetEndReasons(office, run.runId, reason);
    const current = storyView(office, key);
    const view = {
      ...deriveStoryView({
        key,
        story: current?.story ?? StoryId.parse(story),
        title: current?.title ?? "",
        lifecycle: "Parked",
        ...(current?.tier === undefined ? {} : { tier: current.tier }),
      }),
      parked: { reason, detail, from, since: new Date(at).toISOString() },
    };
    return [
      ...notices,
      {
        type: "story.state",
        key,
        delta: { story, key, from, to: "Parked", detail: [`${reason}: ${detail}`] },
        view,
      },
      {
        type: "story.parked",
        key,
        run: run.runId,
        delta: {
          story,
          key,
          ...(request.work === undefined ? {} : { work: request.work }),
          reason,
          detail,
          from,
          ...(lastGoodCommit === null ? {} : { lastGoodCommit }),
          actions: parkActions(reason, deps.implemented),
        },
      },
      ...askWorkerQuestionOfPark(
        deps,
        request,
        { parkId: carryWorkerQuestions(deps.office, request.run), reason },
        at,
      ),
    ];
  });
  return {
    reason,
    detail,
    from,
    commit: branch?.commit ?? null,
    lastGoodCommit,
    pushed: branch?.pushed ?? false,
    written: branch !== null,
    writeError,
  };
}
