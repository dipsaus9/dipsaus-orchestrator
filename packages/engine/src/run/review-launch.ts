// Starting a reviewer session of a story run (0002, DIPO-219), and the git reads a review needs.
// The reviewer is a new agent of the run with role `reviewer`, always a fresh session (0008): the
// `review` system file (L1+L2; `review-box` for a box run, whose verify ran in the developer's box)
// in its own file of the run directory, the review task message as its first message, the
// reviewer's tools, model, effort and its own turn, minute and token caps (`runWorkerSpec` with the
// review settings). Ingestion starts after what earlier hosts wrote to the run's event file, and
// run control tracks the session with the reviewer's caps.
//
// Each review session runs in a read-only box of its own (0002, 0008, `BoxWorkers.review`): a new
// box from the office image with a copy of exactly the head the review round read
// (`ReviewSessionRequest.head`), refused when the story branch has moved since, no `box.files`, and
// the firewall, the box user and the proxies of any box. Its web traffic goes through the box web
// proxy. No session has hooks. The box is deleted when the start fails, when the session's exit or
// lost host is decided (`finish`), at daemon stop, and at daemon start for one a stopped daemon
// left. The head the session reviews is kept in the run directory (`REVIEW_COMMIT_PREFIX`), read
// back for the verdict (`reviewedCommit`) and removed with the box.
//
// Right before the session starts, the launcher asks again whether the story is held by a park
// (`ReviewSessionRequest.held`, DIPO-346): a park that landed while the box was made starts no
// reviewer, and the box goes.

import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  AgentId,
  type Clock,
  type IdSource,
  type OfficeId,
  RoleId,
  StoryId,
  StoryKey,
  RunId,
  type WorkRef,
} from "@dipsaus-orchestrator/contract";

import { REVIEW_CODE_DIR, ReviewCopyMismatchError } from "../box/review-box";
import { BOX_RUN_FILE, type BoxWorkers } from "../box/workers";
import { appendEntries } from "../changelog/log";
import type { OfficeConfig } from "../config";
import { sizeClassOfWorkspace } from "../context/size";
import type { SizeClass } from "../context/types";
import { gitWorkspace } from "../context/workspace";
import type { OfficeHandle } from "../db/office";
import type { GitLocation } from "../git/hardened";
import type { OfficeGit } from "../git/office";
import { EVENTS_FILE } from "../host/protocol";
import type { IngestAdapter } from "../ingest/ingestor";
import { ensurePrivateDir } from "../platform/paths";
import { promptParts, recordPromptParts, recordPromptTexts } from "../prompts/parts";
import { type ReviewChangedPath, withReviewCommit } from "../prompts/review";
import { renderSystemFile } from "../prompts/system";
import { withWorkViews } from "../views/work";
import type { AdapterHold } from "../workers/hold";
import type { WorkerPort } from "../workers/port";
import { PlanError, type Caps } from "../workers/types";

import { REVIEWER_ROLE, runCaps } from "./caps";
import { runConfigOf } from "./config-snapshot";
import type { TrackedRun } from "./control-types";
import {
  type HostStarter,
  type ReviewerSettings,
  type RunIngest,
  runLaunchPaths,
  runWorkerSpec,
  systemHashOf,
  type TierCaps,
} from "./launch";
import { sessionUuid } from "./prompts";
import { findRun, type StoredRun } from "./records";
import { codeTreeKeyOf } from "./story-git";

/** The git reads of a review, in the story worktree. */
export interface ReviewGit {
  /** The commit the worktree's HEAD names. */
  head(office: OfficeId, worktree: string): Promise<string>;
  /**
   * sha256 of `git ls-tree -r <commit>` without the story's own task file (0010 section 7);
   * `commit` is the worktree's HEAD unless given.
   */
  codeTreeKey(
    office: OfficeId,
    worktree: string,
    taskFile: string,
    commit?: string,
  ): Promise<string>;
  /** `git diff <base>...<commit>` (HEAD unless given), unified, and its changed paths with counts. */
  diff(
    office: OfficeId,
    worktree: string,
    base: string,
    commit?: string,
  ): Promise<{ readonly diff: string; readonly changes: readonly ReviewChangedPath[] }>;
  /** The project's size class at the worktree, for the diff budget (0014 section 4). */
  sizeClass(office: OfficeId, worktree: string): Promise<SizeClass>;
}

/** Pure: `git diff --numstat -z --no-renames` output as changed paths; `-` counts are binary. */
export function parseNumstat(output: string): ReviewChangedPath[] {
  return output.split("\0").flatMap((record): ReviewChangedPath[] => {
    const match = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(record.replace(/^\n+/, ""));
    if (match === null) return [];
    const [, added, removed, path] = match;
    return [
      {
        path: path ?? "",
        added: added === "-" ? null : Number(added),
        removed: removed === "-" ? null : Number(removed),
      },
    ];
  });
}

/** A commit id, or HEAD by default; anything else is refused before it reaches git. */
function revision(commit: string | undefined): string {
  if (commit === undefined) return "HEAD";
  if (!COMMIT_ID.test(commit)) throw new Error(`${JSON.stringify(commit)} is not a commit id`);
  return commit;
}

function worktreeAt(git: OfficeGit, worktree: string): Extract<GitLocation, { kind: "worktree" }> {
  return git.worktreeLocation(worktree) as Extract<GitLocation, { kind: "worktree" }>;
}

/**
 * The `git diff` arguments of the story diff the reviewer gets. The prefixes are fixed, so a user's
 * or a repository's diff.noprefix, diff.srcPrefix or diff.dstPrefix cannot change the `+++ b/<path>`
 * lines parseStoryDiff reads (DIPO-146 review).
 */
export function storyDiffArgs(range: string): string[] {
  return [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-renames",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    range,
  ];
}

/** The real `ReviewGit`: office git queue items through the hardened runner. */
export function gitReviewOps(gitOf: (office: OfficeId) => OfficeGit | undefined): ReviewGit {
  const attached = (office: OfficeId): OfficeGit => {
    const git = gitOf(office);
    if (git === undefined) throw new Error(`Office ${office} has no git attached.`);
    return git;
  };
  return {
    head: (office, worktree) => {
      const git = attached(office);
      return git.run(async (session) =>
        (await session.ok(worktreeAt(git, worktree), ["rev-parse", "--verify", "HEAD"])).trim(),
      );
    },
    codeTreeKey: (office, worktree, taskFile, commit) => {
      const git = attached(office);
      const rev = revision(commit);
      return git.run(async (session) =>
        codeTreeKeyOf(
          await session.ok(worktreeAt(git, worktree), ["ls-tree", "-r", "-z", rev]),
          taskFile,
        ),
      );
    },
    diff: (office, worktree, base, commit) => {
      const git = attached(office);
      const rev = revision(commit);
      return git.run(async (session) => {
        const location = worktreeAt(git, worktree);
        const range = `${base}...${rev}`;
        const diff = await session.ok(location, storyDiffArgs(range));
        const numstat = await session.ok(location, [
          "diff",
          "--numstat",
          "-z",
          "--no-renames",
          range,
        ]);
        return { diff, changes: parseNumstat(numstat) };
      });
    },
    sizeClass: (office, worktree) => {
      const git = attached(office);
      return sizeClassOfWorkspace(gitWorkspace({ git, location: worktreeAt(git, worktree) }));
    },
  };
}

/** The prefix of the file in the run directory that names the head a reviewer session reviews. */
export const REVIEW_COMMIT_PREFIX = "review-commit-";

const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** The file in `runDir` that names the head the review session of `agent` reviews. */
export function reviewCommitFile(runDir: string, agent: string): string {
  return join(runDir, `${REVIEW_COMMIT_PREFIX}${agent}`);
}

/** What one reviewer session starts with. */
export interface ReviewSessionRequest {
  readonly office: OfficeId;
  readonly run: StoredRun;
  /**
   * The review task message (L4), the session's first message; the launcher adds its `commit`
   * section, which names the read-only copy in the reviewer's box.
   */
  readonly taskMessage: string;
  /**
   * The story branch's head the round read once at its start (DIPO-276): the copy holds exactly
   * this commit, and the session is refused when the branch has moved since.
   */
  readonly head: string;
  /**
   * True while the story is held by a park (`heldByPark`, DIPO-344, DIPO-360): asked before the
   * branch is read and again right before the session starts, so a park that landed while the
   * round was built or the box was made starts no reviewer.
   */
  readonly held?: () => boolean;
}

export type ReviewSessionOutcome =
  | { readonly kind: "started"; readonly agent: AgentId }
  /** A launch check refused the session; the adapter hold is set. */
  | { readonly kind: "startFailed"; readonly hold: AdapterHold }
  | {
      readonly kind: "failed";
      readonly reason: string;
      /** The story was parked when the session was to start (`ReviewSessionRequest.held`). */
      readonly parked?: true;
      /**
       * The copy of the head does not match its tree (`ReviewCopyMismatchError`): no session of
       * this head can start, so the maintainer is told.
       */
      readonly copyMismatch?: true;
      /**
       * The launch plan refused the session (`PlanError`), for example a path with a character that
       * has a meaning in Claude Code permission rules: the maintainer is told (DIPO-247).
       */
      readonly planRefused?: PlanError;
    };

/** Starts a reviewer session (the real one is `ReviewLauncher`). */
export interface ReviewSessions {
  start(request: ReviewSessionRequest): Promise<ReviewSessionOutcome>;
  /** Deletes the box of the session of `agent`, once its exit or lost host is decided. */
  finish?(office: OfficeId, runId: string, agent: string): Promise<void>;
  /** The head the session of `agent` was given and reviews, until it finished; else null. */
  reviewedCommit?(office: OfficeId, runId: string, agent: string): Promise<string | null>;
}

export interface ReviewLauncherDeps {
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly offices: {
    get(office: OfficeId): OfficeHandle | undefined;
    config(office: OfficeId): OfficeConfig | undefined;
  };
  readonly worker: WorkerPort;
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  readonly runtimeDir: string;
  /** dipo's temp root: the run temp directories. */
  readonly tmpRoot: string;
  readonly tempOwner?: () => string | undefined;
  /**
   * The reviewer boxes (`BoxWorkers`, 0002): each session gets one. Without them no reviewer runs.
   */
  readonly boxes?: Pick<BoxWorkers, "review" | "endReview">;
  readonly hosts: HostStarter;
  readonly ingest: RunIngest;
  /** Run control: the session is tracked before its ingestion starts. */
  readonly control: { track(office: OfficeId, run: TrackedRun): void };
  readonly onChanged?: (office: OfficeId) => void;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Inside the caller's transaction: the run's snapshot of the reviewer's turn, minute and token caps,
 * from the office's `review` block in force, for a run that has none (one started before they were
 * kept). A cap the snapshot holds is never changed, so a later config change reaches new runs only
 * (0020).
 */
export function snapshotReviewCaps(
  office: OfficeHandle,
  runId: RunId | string,
  config: Pick<OfficeConfig, "review">,
): void {
  office.run(
    `update runs set review_max_turns = coalesce(review_max_turns, $turns),
       review_max_minutes = coalesce(review_max_minutes, $minutes),
       review_max_tokens = coalesce(review_max_tokens, $tokens)
      where office_id = $office_id and run_id = $run`,
    {
      run: runId,
      turns: config.review.maxTurns,
      minutes: config.review.maxMinutes,
      tokens: config.review.budgetTokens,
    },
  );
}

/**
 * The reviewer's settings for the run (0002): model and effort from the office's `review` block,
 * its turn, minute and token caps per session only from the run's start snapshot. A run whose
 * snapshot has none gets the office's current caps written into it first (`snapshotReviewCaps`),
 * and keeps them.
 */
export function reviewerSettings(
  office: OfficeHandle,
  run: StoredRun,
  config: OfficeConfig,
): ReviewerSettings {
  let current = run;
  if (run.reviewMaxTurns == null || run.reviewMaxMinutes == null || run.reviewMaxTokens == null) {
    office.immediate(() => snapshotReviewCaps(office, run.runId, config));
    current = findRun(office, run.runId) ?? run;
  }
  const caps = runCaps(office, current);
  // Model and effort as the run started with them (its configuration snapshot, DIPO-303 review).
  const started = runConfigOf(office, current, config);
  return {
    model: started.review.model,
    effort: started.review.effort,
    // Null only for a run with no row: the snapshot was written above.
    maxTurns: caps.reviewMaxTurns ?? config.review.maxTurns,
    maxMinutes: caps.reviewMaxMinutes ?? config.review.maxMinutes,
    budgetTokens: caps.reviewMaxTokens ?? config.review.budgetTokens,
  };
}

/** The real `ReviewSessions`. */
export class ReviewLauncher implements ReviewSessions {
  readonly #deps: ReviewLauncherDeps;

  constructor(deps: ReviewLauncherDeps) {
    this.#deps = deps;
  }

  /** The run directory of `runId` in `office`; null when the office has no git attached. */
  #runDir(office: OfficeId, runId: string): string | null {
    const git = this.#deps.git(office);
    return git === undefined ? null : runLaunchPaths(git, this.#deps, "/", runId).runDir;
  }

  async start(request: ReviewSessionRequest): Promise<ReviewSessionOutcome> {
    const deps = this.#deps;
    const { run } = request;
    const git = deps.git(request.office);
    if (git === undefined) {
      return { kind: "failed", reason: `office ${request.office} is not loaded` };
    }
    if (run.branch === null) {
      return { kind: "failed", reason: `${run.runId} is not a story run with a branch` };
    }
    if (deps.boxes === undefined) {
      return {
        kind: "failed",
        reason:
          "this daemon has no box backend, and a reviewer runs only in a box of its own (0002)",
      };
    }
    if (request.held?.() === true) {
      return { kind: "failed", reason: "the story is parked", parked: true };
    }
    const branch = run.branch;
    let tip: string;
    try {
      tip = (
        await git.run((session) =>
          session.ok(session.repository, [
            "rev-parse",
            "--verify",
            "--end-of-options",
            `refs/heads/${branch}^{commit}`,
          ]),
        )
      ).trim();
    } catch (error) {
      return { kind: "failed", reason: `the story branch cannot be read: ${messageOf(error)}` };
    }
    if (tip !== request.head) {
      return {
        kind: "failed",
        reason: `the story branch moved from ${request.head} to ${tip} since the review round read it`,
      };
    }
    const agent = AgentId.parse(deps.ids.next("agt"));
    let outcome: ReviewSessionOutcome;
    try {
      outcome = await this.#launch(request, agent, deps.boxes);
    } catch (error) {
      await this.finish(request.office, run.runId, agent);
      throw error;
    }
    if (outcome.kind !== "started") await this.finish(request.office, run.runId, agent);
    return outcome;
  }

  /** Deletes the reviewer box of the session of `agent` and forgets the head it reviewed. */
  async finish(office: OfficeId, runId: string, agent: string): Promise<void> {
    await this.#deps.boxes?.endReview(agent);
    const runDir = this.#runDir(office, runId);
    if (runDir !== null) rmSync(reviewCommitFile(runDir, agent), { force: true });
  }

  /** The head the session of `agent` reviews, from the run directory; null without one. */
  async reviewedCommit(office: OfficeId, runId: string, agent: string): Promise<string | null> {
    const runDir = this.#runDir(office, runId);
    if (runDir === null) return null;
    try {
      const commit = readFileSync(reviewCommitFile(runDir, agent), "utf8").trim();
      return COMMIT_ID.test(commit) ? commit : null;
    } catch {
      return null;
    }
  }

  async #launch(
    request: ReviewSessionRequest,
    agent: AgentId,
    boxes: NonNullable<ReviewLauncherDeps["boxes"]>,
  ): Promise<ReviewSessionOutcome> {
    const deps = this.#deps;
    const { run } = request;
    const office = deps.offices.get(request.office);
    const inForce = deps.offices.config(request.office);
    const git = deps.git(request.office);
    if (office === undefined || inForce === undefined || git === undefined) {
      return { kind: "failed", reason: `office ${request.office} is not loaded` };
    }
    // The configuration the run started with (its snapshot, DIPO-150): a base change that
    // reloaded the configuration in force never reaches a running run's reviewer, its launch plan
    // or its ingest adapter.
    const config = runConfigOf(office, run, inForce);
    if (run.worktree === null || run.key === null || run.story === null) {
      return { kind: "failed", reason: `${run.runId} is not a story run with a worktree` };
    }
    const tier =
      (config.tiers as Readonly<Record<string, TierCaps>>)[run.tier ?? ""] ?? config.tiers.M;
    const settings = reviewerSettings(office, run, config);
    const paths = runLaunchPaths(git, deps, run.worktree, run.runId);
    // The reviewer of a box run reads that dipo ran the verify in the developer's box at done and
    // that CI runs with the review (DIPO-346). The run directory says the run is a box worker's,
    // as for its developer.
    const boxRun = existsSync(join(paths.runDir, BOX_RUN_FILE));
    const systemFile = renderSystemFile(boxRun ? "review-box" : "review", "reviewer");
    const taskMessage = withReviewCommit(request.taskMessage, {
      commit: request.head,
      dir: REVIEW_CODE_DIR,
    });
    // The reviewer's tokens, turns and minutes are its own caps per session, never the story's
    // budget (0002).
    const caps: Caps = {
      budgetTokens: settings.budgetTokens,
      maxTurns: settings.maxTurns,
      maxMinutes: settings.maxMinutes,
    };
    const spec = runWorkerSpec(
      deps.worker,
      { runId: run.runId, agent, caps: tier, reviewer: settings },
      paths,
      taskMessage,
      { id: sessionUuid(agent), resume: false },
      caps,
    );
    try {
      ensurePrivateDir(paths.runDir);
      writeFileSync(spec.systemFile, systemFile, { mode: 0o600 });
      writeFileSync(reviewCommitFile(paths.runDir, agent), `${request.head}\n`, { mode: 0o600 });
    } catch (error) {
      return {
        kind: "failed",
        reason: `the run directory could not be prepared: ${messageOf(error)}`,
      };
    }
    // The session's own read-only box (0002): the copy of the head, the firewall and the proxies.
    let place;
    try {
      place = await boxes.review({ agent, git, commit: request.head, systemFile: spec.systemFile });
    } catch (error) {
      return {
        kind: "failed",
        reason: `the reviewer's box could not be made: ${messageOf(error)}`,
        ...(error instanceof ReviewCopyMismatchError ? { copyMismatch: true as const } : {}),
      };
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
      if (!(error instanceof PlanError)) return { kind: "failed", reason: messageOf(error) };
      // A spec the plan refuses is the maintainer's to fix, as for the worker's launch: the review
      // rounds raise its notice (DIPO-247).
      return {
        kind: "failed",
        reason: `the launch plan refused it: ${error.message}`,
        planRefused: error,
      };
    }
    if (!prepared.ok) return { kind: "startFailed", hold: prepared.hold };
    // Right before the session (DIPO-346 review): a park that landed while the box was made starts
    // no reviewer.
    if (request.held?.() === true) {
      return { kind: "failed", reason: "the story is parked", parked: true };
    }

    // The new host appends to the run's event file: its ingestion starts after what is there.
    let offset = 0;
    try {
      offset = statSync(join(paths.runDir, EVENTS_FILE)).size;
    } catch {
      offset = 0;
    }
    const work: WorkRef = {
      story: StoryId.parse(run.story),
      key: StoryKey.parse(run.key),
      run: RunId.parse(run.runId),
      agent,
      role: RoleId.parse(REVIEWER_ROLE),
      tier: run.tier ?? "",
      model: settings.model,
    };
    const recordAgent = (): void => {
      const at = deps.clock.now();
      office.run(
        `insert or ignore into agents (office_id, agent_id, run_id, role, model, effort,
           session_id, system_hash, started_at)
         values ($office_id, $agent, $run, $role, $model, $effort, $session, $hash, $at)`,
        {
          agent,
          run: run.runId,
          role: REVIEWER_ROLE,
          model: settings.model,
          effort: settings.effort,
          session: spec.session.id,
          hash: systemHashOf(systemFile),
          at,
        },
      );
      recordPromptParts(
        office,
        run.runId,
        agent,
        promptParts(systemFile, taskMessage, []),
        deps.clock,
      );
      recordPromptTexts(
        office,
        run.runId,
        agent,
        [
          { part: "system", text: systemFile },
          { part: "message", text: taskMessage },
        ],
        config,
        deps.clock,
      );
    };
    let recorded = false;
    let host;
    try {
      host = await deps.hosts.start(office, {
        runId: run.runId,
        agentId: agent,
        officeDir: paths.officeDir,
        plan: prepared.plan,
        processedOffset: offset,
        record: () => {
          recordAgent();
          recorded = true;
        },
      });
    } catch (error) {
      return { kind: "failed", reason: `the reviewer host did not start: ${messageOf(error)}` };
    }
    if (!recorded) {
      // A host starter that does not take the extras: the same writes, after the start.
      office.immediate(() => {
        office.run(
          `update worker_hosts set processed_offset = $offset
            where office_id = $office_id and run_id = $run and agent_id = $agent`,
          { offset, run: run.runId, agent },
        );
        recordAgent();
      });
    }
    deps.control.track(request.office, {
      runId: run.runId,
      work,
      caps,
      startedAt: deps.clock.now(),
      snapshot: null,
    });
    deps.ingest.start(office, host, {
      run: run.runId,
      agent,
      role: REVIEWER_ROLE,
      tier: run.tier ?? "",
      // The reviewer's own token cap per session (0002), never the story's budget.
      budgetLimit: settings.budgetTokens,
      model: settings.model,
      work,
      adapter: deps.worker.adapter(paths, config) as IngestAdapter,
      initialState: deps.worker.initialState(spec),
    });
    const at = deps.clock.now();
    const appended = office.immediate(() => {
      const entries = withWorkViews(office, [
        { type: "work.assigned", key: work.key, run: run.runId, delta: { work } },
      ]);
      appendEntries(office, entries, { at });
      return entries.length;
    });
    if (appended > 0) deps.onChanged?.(request.office);
    return { kind: "started", agent };
  }
}
