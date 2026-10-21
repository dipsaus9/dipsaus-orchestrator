// Parking a story (DIPO-50; 0012 F16 and the transition In Progress or In Review to Parked, 0010
// sections 2 and 3, 0005 section 5, 0007 section 4, 0008 section 2).
//
// `parkStory` writes the park on the story branch first, through a `ParkWriter`: in dipo's own
// copy of the story's backlog (`inStoryBacklog`, 0021 section 14; never in the story worktree),
// inside the office's git queue, the Backlog CLI writes the F16 `park` block
// (`{reason, from, note}`) through the single field write path and sets status `Parked`; only the
// task file is committed, as `<ID>: status Parked`, and the branch is pushed without force. Then,
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

import {
  type CommandName,
  type Lifecycle,
  type OfficeId,
  type ParkReason,
  StoryId,
  type WorkRef,
} from "@dipsaus-orchestrator/contract";

import { viewStory, writeFields } from "../backlog/fields/write";
import { type BacklogCli, runBacklog } from "../backlog/runner";
import type { NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import type { GitLocation } from "../git/hardened";
import type { OfficeGit } from "../git/office";
import { GitError } from "../git/runner";
import { commitTaskFile, pushBranch } from "../git/task-commit";
import { parkQuestionText, recordedPermission, sandboxBinding } from "../hooks/park-questions";
import { insertParkQuestion, questionViewOf } from "../hooks/questions";
import { deriveStoryView, storyView } from "../views/story";
import { workRefOf } from "../views/work";
import { inStoryBacklog, repoPath, TASK_FIELD_ERROR } from "../worktree/claim";
import { PARKED_STATUS } from "../worktree/done";

import { endRunMarked } from "./markers";
import { appendRunStep, reopenRun, type StoredRun } from "./records";

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
}

/** Writes the park on the story branch (the real one is `gitParkWriter`). */
export interface ParkWriter {
  write(office: OfficeId, request: ParkBranchRequest): Promise<BranchPark>;
}

type WorktreeLocation = Extract<GitLocation, { kind: "worktree" }>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
        const { from, taskFile } = await inStoryBacklog(
          git,
          session,
          location,
          request.story,
          true,
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
            return { from: left, taskFile: repoPath(backlog.cwd, before.file) };
          },
        );
        // Only the task file: anything else staged stays out of the park commit.
        const commit = await commitTaskFile(
          session,
          location,
          taskFile,
          `${request.story}: status ${PARKED_STATUS}`,
        );
        const pushed = await pushBranch(session, git.settings.remote, request.branch);
        return { commit, lastGoodCommit, from, pushed: pushed.pushed, pushError: pushed.error };
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
}

/** What lifting the park on the branch did. */
export interface BranchUnpark {
  /** The commit, or null when the task file already held no park and the status. */
  readonly commit: string | null;
  readonly pushed: boolean;
  readonly pushError: string | null;
}

/** Lifts a park on the story branch (the real one is `gitUnparkWriter`). */
export interface UnparkWriter {
  lift(office: OfficeId, request: UnparkBranchRequest): Promise<BranchUnpark>;
}

/**
 * The park lifted on the story branch with the Backlog CLI and the office git (DIPO-75): in dipo's
 * own copy of the story's backlog (`inStoryBacklog`), never the worktree, the F16 `park` block is
 * removed through the single field write path and the status set back to the park's `from`; only
 * the task file is committed, as `<ID>: status <to>`,
 * and the branch is pushed without force. A tampered worktree throws `git.worktreeTampered`.
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
        const taskFile = await inStoryBacklog(
          git,
          session,
          location,
          request.story,
          true,
          async (backlog) => {
            const target = { cli: deps.cli, cwd: backlog.cwd, id: request.story };
            const before = await viewStory(target);
            await writeFields(target, (fields) => {
              const { park: _park, ...rest } = fields;
              return rest;
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
            return repoPath(backlog.cwd, before.file);
          },
        );
        // Only the task file: anything else staged stays out of the commit.
        const commit = await commitTaskFile(
          session,
          location,
          taskFile,
          `${request.story}: status ${request.to}`,
        );
        const pushed = await pushBranch(session, git.settings.remote, request.branch);
        return { commit, pushed: pushed.pushed, pushError: pushed.error };
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
): NewEntry[] {
  office.run(
    `update parks set resolved_at = $at, resolved_how = 'resume'
     where office_id = $office_id and park_id = $park and resolved_at is null`,
    { at, park: park.parkId },
  );
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

export interface ParkDeps {
  readonly office: OfficeHandle;
  readonly writer: ParkWriter;
  readonly now: () => number;
  /** Runs `fn` in one transaction and appends the entries it returns. */
  readonly write: (fn: () => readonly NewEntry[]) => void;
  /** True when the engine implements the command; `actions` lists only those. */
  readonly implemented: (name: CommandName) => boolean;
  /**
   * The permission question of a `needs-permission` park (DIPO-75): a new question id and the
   * office's `sandbox.allowedDomains`. Without it no question is asked.
   */
  readonly question?: {
    readonly id: () => string;
    readonly allowedDomains: readonly string[];
  };
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
  const binding = sandboxBinding(permission, {
    worktree: run.worktree,
    allowedDomains: deps.question.allowedDomains,
  });
  const question = insertParkQuestion(office, {
    questionId: deps.question.id(),
    runId: run.runId,
    agentId: work.agent,
    parkId: park.park_id,
    tool: permission.tool,
    action: permission.action,
    text: parkQuestionText(permission, binding),
    at,
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
 * Commands the engine implements, but not yet for a parked story: `work.resume` continues only
 * runs held by a plan limit (DIPO-61) and the park `on-hold` (DIPO-160).
 */
const NOT_FOR_PARKED: readonly CommandName[] = ["work.resume"] as CommandName[];

/** The actions a parked story offers (0005 section 5): only commands the engine implements. */
export function parkActions(
  reason: ParkReason,
  implemented: (name: CommandName) => boolean,
): CommandName[] {
  return PARK_ACTIONS.filter(
    (name) =>
      (name !== "work.answer" || reason === "needs-permission") &&
      (reason === "on-hold" || !NOT_FOR_PARKED.includes(name)) &&
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
    branch = await deps.writer.write(deps.office.officeId, {
      story,
      branch: run.branch ?? "",
      worktree: run.worktree ?? "",
      reason,
      note: detail,
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
          actions: parkActions(reason, deps.implemented),
        },
      },
      ...askParkQuestion(deps, request, reason, detail, at),
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
