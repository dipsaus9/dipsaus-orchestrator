// Parking a story (DIPO-50; 0012 F16 and the transition In Progress or In Review to Parked, 0010
// sections 2 and 3, 0005 section 5, 0007 section 4, 0008 section 2).
//
// `parkStory` writes the park on the story branch first, through a `ParkWriter`: in dipo's own
// copy of the story's backlog (`editInStoryBacklog`, 0021 section 14; never in the story worktree),
// inside the office's git queue, the Backlog CLI writes the F16 `park` block
// (`{reason, from, note}`) through the single field write path, sets status `Parked` and appends the
// park's structured summary block to the implementation notes (0020 section 13, `summary.ts`; a
// lift appends the resume line the same way); only the task file is committed, as
// `<ID>: status Parked`, and the branch is pushed without force. Then,
// in one transaction, it records the park in `parks` (reason, cause, the lifecycle it left, detail,
// last good commit, time), ends the run with its end kind and emits `story.state` to Parked and
// `story.parked` with the cause and the actions the engine implements.
//
// Every park names its cause (0020 section 2, DIPO-142), one of `PARK_CAUSES`: the trigger where
// 0020 splits a reason into causes that resume differently, else the session that parked (`build`
// for the developer's, `review` for the reviewer's). Code reads the cause, never the detail.
//
// A `git.worktreeTampered` refusal (the worktree's git links changed since the claim) parks the
// story `scope-violation` with cause `tampered` instead, with the refusal as detail, and nothing
// more runs in that worktree: the office git keeps the claim's pin, so every later engine git call
// there is refused. A park that could not be written on the branch, or a push that failed, is still recorded and
// emitted, with an `engine.notice` saying what is missing.

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  type CommandName,
  type FieldBlock,
  type Lifecycle,
  type OfficeId,
  type ParkReason,
  StoryId,
  type WorkRef,
} from "@dipsaus-orchestrator/contract";

import { parseFieldBlock } from "../backlog/fields/block";
import { appendImplementationNotes } from "../backlog/fields/summary";
import { type StoryTarget, viewStory, writeFields } from "../backlog/fields/write";
import { type BacklogCli, runBacklog, TASK_FIELD_ERROR } from "../backlog/runner";
import { BOX_RUN_FILE } from "../box/workers";
import type { NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import { gateStoryFromView } from "../gate/input";
import { contractCharacters } from "../gate/rules";
import type { GitLocation } from "../git/hardened";
import type { OfficeGit } from "../git/office";
import { GitError } from "../git/runner";
import { pushBranch } from "../git/task-commit";
import { parkQuestionText, recordedPermission } from "../hooks/park-questions";
import { insertParkQuestion, insertWorkerQuestion, questionViewOf } from "../hooks/questions";
import { officeDirectory } from "../office/marker";
import { runDirectory } from "../runs/worker-hosts";
import { deriveStoryView, storyView } from "../views/story";
import { workRefOf } from "../views/work";
import { editInStoryBacklog } from "../worktree/claim";
import { PARKED_STATUS } from "../worktree/done";

import { endRunMarked } from "./markers";
import { appendRunStep, reopenRun, type StoredRun } from "./records";
import { parkResumeRow } from "./resume-policy";
import { renderParkBlock, runSummaryFacts } from "./summary";

/** The code of the refusal that parks a story `scope-violation` (DIPO-38, 0008 section 2). */
export const WORKTREE_TAMPERED = "git.worktreeTampered";

/**
 * The causes a park records (0020 section 2 and its interface with 0019), an open string in
 * `parks.cause` and `story.parked.cause`.
 */
export const PARK_CAUSES = {
  /** `ambiguous-spec`: the worker asked a question. */
  question: "question",
  /** `ambiguous-spec`: no valid report after the report feedback turn. */
  noReport: "no-report",
  /** `ambiguous-spec`: the project rules conflict with the contract. */
  ruleConflict: "rule-conflict",
  /** `verify-failing`: local verify red at the tier's loop cap. */
  loops: "loops",
  /** `verify-failing`: required checks red `mergeSlot.ciAttempts` times (0019 section 8). */
  ci: "ci",
  /** `verify-failing`: verify could not run. */
  refused: "refused",
  /** `verify-failing`: verify red on the done turn that crossed a cap, so no turn is left (0020). */
  capped: "capped",
  /** `conflict`: the second failed conflict hand-off, the merge left in progress (0019). */
  mergeInProgress: "merge-in-progress",
  /** `conflict`: a conflict in a path the worker cannot write (0019). */
  unwritablePath: "unwritable-path",
  /** `conflict`: a non-fast-forward push. */
  pushRejected: "push-rejected",
  /** `conflict`: the host refused the merge three times because the base moved (0019). */
  slotRefused: "slot-refused",
  /** `scope-violation`: written outside scope at `done`. */
  paths: "paths",
  /** `scope-violation`: the worktree's git links changed (`git.worktreeTampered`). */
  tampered: "tampered",
  /** `scope-violation`: the story's task file holds fields dipo does not know (0021 section 14). */
  taskFile: "task-file",
  /** `scope-violation`: a box part changes a protected file or holds a link (0021 section 8). */
  protectedFile: "protected-file",
  /** `scope-violation`: a box part holds what looks like a secret (0021 section 8). */
  secret: "secret",
  /** `scope-violation`: a box part dipo could not take out of the box (too big, a hostile archive). */
  partRefused: "part-refused",
  /** `scope-violation`: the backstop saw HEAD, branch, stash, `backlog/` or `.dipo/` change. */
  backstop: "backstop",
  /** `scope-violation`: reconcile found the worktree or branch changed by hand. */
  handChange: "hand-change",
  /** `review-blocked`: the third failed review round (0019). */
  rounds: "rounds",
  /** A developer session parked: its caps, a crash, a permission, an interruption. */
  build: "build",
  /** A reviewer session parked: the budget, two crashes, or a stop during a review (0019). */
  review: "review",
  /** `worker-failed`: the reviewer hit its own turn or minute cap (0019). */
  reviewCap: "review-cap",
  /** `stopped`: the maintainer stopped a developer session. */
  maintainer: "maintainer",
  /** `stopped`: the story PR was closed on the host (0019). */
  prClosed: "pr-closed",
} as const;

export type ParkCause = (typeof PARK_CAUSES)[keyof typeof PARK_CAUSES];

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
  readonly worktree: string;
  readonly reason: ParkReason;
  readonly note: string;
  /** The parking run: a box run's worktree has no uncommitted files of its own to count. */
  readonly runId?: string;
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
  /** Uncommitted and untracked files in the worktree; null for a box run (its work is in the box). */
  readonly uncommitted: number | null;
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

type WorktreeLocation = Extract<GitLocation, { kind: "worktree" }>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when `runId` is a box worker's run: its run directory holds the box record (DIPO-271). */
function boxRunOf(git: OfficeGit, runId: string | undefined): boolean {
  if (runId === undefined) return false;
  return existsSync(join(runDirectory(officeDirectory(git.commonDir), runId), BOX_RUN_FILE));
}

/** The entries of `git status --porcelain=v1 -z` output; a rename's second path is not one. */
function statusEntries(status: string): number {
  const fields = status.split("\0");
  let count = 0;
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i] ?? "";
    if (entry === "") continue;
    count += 1;
    if (entry.startsWith("R") || entry.startsWith("C")) i += 1;
  }
  return count;
}

/**
 * Appends a summary text to the story's implementation notes; the reason it failed, or null. A
 * failed append is caught, so the edit it is part of still commits its F16 block and status.
 */
async function appendOrReason(target: StoryTarget, text: string): Promise<string | null> {
  try {
    await appendImplementationNotes(target, text);
    return null;
  } catch (error) {
    return `appending it failed: ${messageOf(error)}`;
  }
}

/** The park written on the story branch with the Backlog CLI and the office git. */
export function gitParkWriter(deps: {
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  readonly cli: BacklogCli;
}): ParkWriter {
  return {
    async write(office, request) {
      const git = deps.git(office);
      if (git === undefined) throw new Error(`Office ${office} has no git attached.`);
      return git.run(async (session) => {
        // A pinned worktree whose links changed throws `git.worktreeTampered` here, before any
        // CLI or git call runs in it.
        const location = git.worktreeLocation(request.worktree) as WorktreeLocation;
        const lastGoodCommit = (
          await session.ok(location, ["rev-parse", "--verify", "HEAD"])
        ).trim();
        // The summary block is built before the CLI writes anything, and a failure building or
        // appending it only leaves it out (`summaryError`): the park itself is always written.
        let block: string | null = null;
        let summaryError: string | null = null;
        if (request.summary !== undefined) {
          try {
            // A box run's Mac worktree keeps the start commit's files while its branch follows
            // the delivered parts (DIPO-302), so its status counts nothing of the worker's.
            const uncommitted = boxRunOf(git, request.runId)
              ? null
              : statusEntries(
                  await session.ok(location, [
                    "status",
                    "--porcelain=v1",
                    "-z",
                    "--untracked-files=all",
                  ]),
                );
            block = request.summary({ lastGoodCommit, uncommitted });
          } catch (error) {
            summaryError = `building it failed: ${messageOf(error)}`;
          }
        }
        // Only the task file: anything else staged stays out of the park commit.
        const { value: from, commit } = await editInStoryBacklog(
          git,
          session,
          location,
          request.story,
          `${request.story}: status ${PARKED_STATUS}`,
          async (backlog) => {
            const target = { cli: deps.cli, cwd: backlog.cwd, id: request.story };
            const before = await viewStory(target);
            const left: Lifecycle = before.status === "In Review" ? "In Review" : "In Progress";
            await writeFields(target, (fields) => ({
              ...fields,
              park: { reason: request.reason, from: left, note: request.note },
            }));
            if (before.status !== PARKED_STATUS) {
              await runBacklog(deps.cli, backlog.cwd, [
                "task",
                "edit",
                request.story,
                "--status",
                PARKED_STATUS,
              ]);
            }
            const back = await viewStory(target);
            if (back.status !== PARKED_STATUS) {
              throw new GitError(
                "park.statusNotWritten",
                `The Backlog CLI left ${request.story} at ${back.status}, not ${PARKED_STATUS}.`,
              );
            }
            // The park's summary block (0020 section 13), once: a park already on the branch (a
            // retried write) appends nothing.
            if (block !== null && before.status !== PARKED_STATUS) {
              summaryError = await appendOrReason(target, block);
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
  readonly worktree: string;
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
 * The park lifted on the story branch with the Backlog CLI and the office git (DIPO-75): in dipo's
 * own copy of the story's backlog (`editInStoryBacklog`), never the worktree, the F16 `park` block is
 * removed through the single field write path and the status set back to the park's `from`; only
 * the task file is committed, as `<ID>: status <to>`,
 * and the branch is pushed without force. A tampered worktree throws `git.worktreeTampered`. The
 * answer of a question park goes into the same field write as a resolved unknown, unless the
 * story contract would then break R26 (`answerError`).
 */
export function gitUnparkWriter(deps: {
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  readonly cli: BacklogCli;
}): UnparkWriter {
  return {
    async lift(office, request) {
      const git = deps.git(office);
      if (git === undefined) throw new Error(`Office ${office} has no git attached.`);
      return git.run(async (session) => {
        const location = git.worktreeLocation(request.worktree) as WorktreeLocation;
        let lineError: string | null = null;
        let answerError: string | null = null;
        const answer = request.answer;
        // Only the task file: anything else staged stays out of the commit.
        const { commit } = await editInStoryBacklog(
          git,
          session,
          location,
          request.story,
          `${request.story}: status ${request.to}`,
          async (backlog) => {
            const target = { cli: deps.cli, cwd: backlog.cwd, id: request.story };
            const before = await viewStory(target);
            await writeFields(target, (fields) => {
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
            if (before.status !== request.to) {
              await runBacklog(deps.cli, backlog.cwd, [
                "task",
                "edit",
                request.story,
                "--status",
                request.to,
              ]);
            }
            const back = await viewStory(target);
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
              lineError = await appendOrReason(target, request.line);
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

/**
 * Inside the caller's transaction (DIPO-75): the park `parkId` is resolved `resume` and its run is
 * active again (`reopenRun`), so the resumed session continues the same run with what remains of
 * its budget (0008 section 8). The run's outcome row goes, since the run has not ended; its next
 * end writes it again with every park of the run. The time since the run ended at the park is
 * added to `runs.parked_ms`, so its caps and minutes count only the time it worked. Returns the
 * `story.state` entry back to `to`.
 */
export function reopenParkedRun(
  office: OfficeHandle,
  park: { readonly parkId: number; readonly reason: string; readonly detail: string },
  run: StoredRun,
  to: Lifecycle,
  at: number,
  /** The maintainer's note on the resume (0020 section 3, DIPO-155), kept on the park row. */
  note: string | null = null,
): NewEntry[] {
  resolveParkResumed(office, park.parkId, at, note);
  reopenRun(office, run.runId, at);
  const key = run.key;
  const story = run.story;
  if (key === null || story === null) return [];
  const current = storyView(office, key);
  const view = deriveStoryView({
    key,
    story: current?.story ?? StoryId.parse(story),
    title: current?.title ?? "",
    lifecycle: to,
    ...(current?.tier === undefined ? {} : { tier: current.tier }),
  });
  return [
    {
      type: "story.state",
      key,
      delta: {
        story,
        key,
        from: "Parked",
        to,
        detail: [`resumed from ${park.reason}: ${park.detail}`],
      },
      view,
    },
  ];
}

/**
 * Inside the caller's transaction: the open park `parkId` is resolved `resume` at `at`, with the
 * maintainer's note when the resume carried one (`parks.resolved_note`, 0020 section 3). False
 * when it was resolved already.
 */
export function resolveParkResumed(
  office: OfficeHandle,
  parkId: number,
  at: number,
  note: string | null,
): boolean {
  return (
    office.run(
      `update parks set resolved_at = $at, resolved_how = 'resume', resolved_note = $note
       where office_id = $office_id and park_id = $park and resolved_at is null`,
      { at, park: parkId, note },
    ).changes > 0
  );
}

export interface ParkDeps {
  readonly office: OfficeHandle;
  readonly writer: ParkWriter;
  readonly now: () => number;
  /** Runs `fn` in one transaction and appends the entries it returns. */
  readonly write: (fn: () => readonly NewEntry[]) => void;
  /** True when the engine implements the command; `actions` lists only those. */
  readonly implemented: (name: CommandName) => boolean;
  /**
   * The permission question of a `needs-permission` park (DIPO-75): a new question id. Without it
   * no question is asked.
   */
  readonly question?: { readonly id: () => string };
}

/**
 * Inside the park's transaction, after the park row: a `needs-permission` park stores its
 * permission question (the recorded tool and action, no hook call) and emits `question.asked`.
 */
function askParkQuestion(
  deps: ParkDeps,
  request: ParkRequest,
  reason: ParkReason,
  detail: string,
  at: number,
): NewEntry[] {
  const { run } = request;
  if (reason !== "needs-permission" || deps.question === undefined || run.key === null) return [];
  const permission = recordedPermission(detail);
  const work = request.work ?? workRefOf(deps.office, run.runId);
  if (permission === null || work === null) return [];
  const office = deps.office;
  const park = office.get<{ park_id: number }>(
    `select park_id from parks where office_id = $office_id and run_id = $run
      order by park_id desc limit 1`,
    { run: run.runId },
  );
  if (park === null) return [];
  const question = insertParkQuestion(office, {
    questionId: deps.question.id(),
    runId: run.runId,
    agentId: work.agent,
    parkId: park.park_id,
    tool: permission.tool,
    action: permission.action,
    text: parkQuestionText(permission),
    at,
  });
  const view = questionViewOf(office, question);
  return view === null
    ? []
    : [{ type: "question.asked", key: run.key, run: run.runId, delta: view }];
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
 * Inside the park's transaction, after the carry (DIPO-159, 0020 section 7): an `ambiguous-spec`
 * park with cause `question` that carries no worker question asks its own (the worker's question
 * when no TUI was connected), kind `question`, linked to the run and the park, and emits
 * `question.asked`, so the maintainer can answer it with `dipo answer <question> --text`.
 */
function askWorkerQuestionOfPark(
  deps: ParkDeps,
  request: ParkRequest,
  park: { readonly parkId: number | null; readonly reason: ParkReason; readonly cause: string },
  at: number,
): NewEntry[] {
  const { run } = request;
  const text = request.question?.trim() ?? "";
  if (park.reason !== "ambiguous-spec" || park.cause !== PARK_CAUSES.question) return [];
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
  /** The story run that parks; its story, branch and worktree are set. */
  readonly run: StoredRun;
  readonly work?: WorkRef;
  readonly reason: ParkReason;
  /** Which of the reason's causes parked it (`PARK_CAUSES`, 0020 section 2). */
  readonly cause: string;
  readonly detail: string;
  /** How the run ends (`runs.end_kind`), for example `stopped` or `capped`. */
  readonly endKind: string;
  /** The `cap` run step value of a done turn that crossed a cap, written with the run's end (DIPO-222). */
  readonly capStep?: string;
  /**
   * The worker's question of an `ambiguous-spec` park with cause `question` (DIPO-159): asked as the
   * park's question unless an open question of the run carries over to it.
   */
  readonly question?: string;
}

export interface ParkOutcome {
  readonly reason: ParkReason;
  readonly cause: string;
  readonly detail: string;
  readonly from: Lifecycle;
  /** The park commit on the story branch, or null when none was written. */
  readonly commit: string | null;
  readonly lastGoodCommit: string | null;
  readonly pushed: boolean;
}

/**
 * True when `work.resume` resumes a park of `reason` and `cause`: the park `on-hold` (DIPO-160) and
 * every reason and cause with a resuming row in the 0020 matrix (`resume-policy.ts`, DIPO-155).
 */
export function resumableByCommand(reason: string, cause: string | null): boolean {
  return reason === "on-hold" || parkResumeRow(reason, cause)?.kind === "resume";
}

/**
 * The actions a parked story offers (0005 section 5): only commands the engine implements,
 * `work.answer` for a park that waits on its question's answer (`needs-permission`, and
 * `ambiguous-spec` with cause `question`, DIPO-159), and `work.resume` only for a reason and cause
 * it resumes (0020 section 14).
 */
export function parkActions(
  reason: ParkReason,
  implemented: (name: CommandName) => boolean,
  cause: string | null = null,
): CommandName[] {
  const answers =
    reason === "needs-permission" ||
    (reason === "ambiguous-spec" && cause === PARK_CAUSES.question);
  return PARK_ACTIONS.filter(
    (name) =>
      (name !== "work.answer" || answers) &&
      (name !== "work.resume" || resumableByCommand(reason, cause)) &&
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
  let cause = request.cause;
  let detail = request.detail;
  let branch: BranchPark | null = null;
  const notices: NewEntry[] = [];
  const notice = (code: string, text: string): void => {
    notices.push({ type: "engine.notice", key, delta: { level: "warn", code, text } });
  };
  try {
    const parked = { reason, cause, detail };
    branch = await deps.writer.write(deps.office.officeId, {
      story,
      branch: run.branch ?? "",
      worktree: run.worktree ?? "",
      reason,
      note: detail,
      runId: run.runId,
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
    if (error instanceof GitError && error.code === WORKTREE_TAMPERED) {
      // 0008 section 2: a tampered worktree parks `scope-violation` and runs no more git.
      if (reason !== "scope-violation") {
        detail = `${error.message} (dipo was parking it as ${reason}: ${detail})`;
      } else {
        detail = `${error.message} ${detail}`;
      }
      reason = "scope-violation";
      cause = PARK_CAUSES.tampered;
      notice(
        PARK_NOTICES.notWritten,
        `${story} parked as scope-violation, but the park was not written on ${run.branch ?? "its branch"}: dipo runs no git in ${run.worktree ?? "its worktree"} since its git links changed.`,
      );
    } else if (error instanceof GitError && error.code === TASK_FIELD_ERROR) {
      // 0021 section 14: a task file holding fields dipo does not know never reaches the CLI.
      detail =
        reason === "scope-violation"
          ? `${error.message} ${detail}`
          : `${error.message} (dipo was parking it as ${reason}: ${detail})`;
      reason = "scope-violation";
      cause = PARK_CAUSES.taskFile;
      notice(
        PARK_NOTICES.notWritten,
        `${story} parked as scope-violation, but the park was not written on ${run.branch ?? "its branch"}: its task file holds fields dipo does not know.`,
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
  deps.write(() => {
    const office = deps.office;
    office.run(
      `insert into parks (office_id, park_id, key, story_id, run_id, reason, cause, from_state,
         detail, last_good_commit, at)
       values ($office_id, (select coalesce(max(park_id), 0) + 1 from parks
         where office_id = $office_id), $key, $story, $run, $reason, $cause, $from, $detail,
         $commit, $at)`,
      { key, story, run: run.runId, reason, cause, from, detail, commit: lastGoodCommit, at },
    );
    if (request.capStep !== undefined) appendRunStep(office, run.runId, "cap", request.capStep, at);
    endRunMarked(office, run.runId, at, request.endKind);
    // The agent ends when its exit is ingested; the reason it ended is known now.
    office.run(
      `update agents set end_reason = coalesce(end_reason, $kind)
       where office_id = $office_id and run_id = $run and ended_at is null`,
      { kind: request.endKind, run: run.runId },
    );
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
          cause,
          detail,
          from,
          ...(lastGoodCommit === null ? {} : { lastGoodCommit }),
          actions: parkActions(reason, deps.implemented, cause),
        },
      },
      ...askParkQuestion(deps, request, reason, detail, at),
      ...askWorkerQuestionOfPark(
        deps,
        request,
        { parkId: carryWorkerQuestions(deps.office, request.run), reason, cause },
        at,
      ),
    ];
  });
  return {
    reason,
    cause,
    detail,
    from,
    commit: branch?.commit ?? null,
    lastGoodCommit,
    pushed: branch?.pushed ?? false,
  };
}

/** The open park of a story, newest first; null when it has none. */
export function openPark(
  office: OfficeHandle,
  key: string,
): {
  readonly parkId: number;
  readonly reason: string;
  /** Null on a park written before causes were kept, or one recorded from a hand-written record. */
  readonly cause: string | null;
  readonly from: string;
  readonly detail: string;
  readonly runId: string | null;
  readonly lastGoodCommit: string | null;
  readonly at: number;
} | null {
  const row = office.get<{
    park_id: number;
    reason: string;
    cause: string | null;
    from_state: string;
    detail: string;
    run_id: string | null;
    last_good_commit: string | null;
    at: number;
  }>(
    `select park_id, reason, cause, from_state, detail, run_id, last_good_commit, at from parks
     where office_id = $office_id and key = $key and resolved_at is null
     order by park_id desc limit 1`,
    { key },
  );
  return row === null
    ? null
    : {
        parkId: row.park_id,
        reason: row.reason,
        cause: row.cause,
        from: row.from_state,
        detail: row.detail,
        runId: row.run_id,
        lastGoodCommit: row.last_good_commit,
        at: row.at,
      };
}
