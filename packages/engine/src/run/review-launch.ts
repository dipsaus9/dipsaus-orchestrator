// Starting a reviewer session of a story run (0019 sections 4 and 13, DIPO-219), and the git reads
// a review needs. The reviewer is a new agent of the run with role `reviewer`, always a fresh
// session (0008 section 8): the `review` system file (L1+L2) in its own file of the run directory,
// the review task message as its first message, the reviewer's tools, model, effort and its own
// turn and minute caps (`runWorkerSpec` with the review settings), and what remains of the story's
// budget. The launch checks run first (`WorkerPort.prepare`); a refused check is `startFailed`
// with the adapter hold set. The backstop snapshot is taken before the session starts, so a
// worktree the review changed parks `scope-violation` with cause `backstop` (0008 backstop).
// Ingestion starts after what earlier hosts wrote to the run's event file, and run control tracks
// the session with the reviewer's caps.

import { statSync, writeFileSync } from "node:fs";
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
import type { ReviewChangedPath } from "../prompts/review";
import { renderSystemFile } from "../prompts/system";
import { withWorkViews } from "../views/work";
import type { AdapterHold } from "../workers/hold";
import type { WorkerPort } from "../workers/port";
import { PlanError, type Caps } from "../workers/types";

import type { BackstopSnapshot } from "./backstop";
import { REVIEWER_ROLE, runCaps, runTotals } from "./caps";
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
import type { StoredRun } from "./records";
import { codeTreeKeyOf } from "./story-git";
import { prepareRunTempDirs } from "./temp-dirs";

/** The git reads of a review, in the story worktree. */
export interface ReviewGit {
  /** The commit the worktree's HEAD names. */
  head(office: OfficeId, worktree: string): Promise<string>;
  /** sha256 of `git ls-tree -r HEAD` without the story's own task file (0010 section 7). */
  codeTreeKey(office: OfficeId, worktree: string, taskFile: string): Promise<string>;
  /** `git diff <base>...HEAD`, unified, and its changed paths with line counts. */
  diff(
    office: OfficeId,
    worktree: string,
    base: string,
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
    codeTreeKey: (office, worktree, taskFile) => {
      const git = attached(office);
      return git.run(async (session) =>
        codeTreeKeyOf(
          await session.ok(worktreeAt(git, worktree), ["ls-tree", "-r", "-z", "HEAD"]),
          taskFile,
        ),
      );
    },
    diff: (office, worktree, base) => {
      const git = attached(office);
      return git.run(async (session) => {
        const location = worktreeAt(git, worktree);
        const range = `${base}...HEAD`;
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

/** What one reviewer session starts with. */
export interface ReviewSessionRequest {
  readonly office: OfficeId;
  readonly run: StoredRun;
  /** The review task message (L4), the session's first message. */
  readonly taskMessage: string;
}

export type ReviewSessionOutcome =
  | { readonly kind: "started"; readonly agent: AgentId }
  /** A launch check refused the session; the adapter hold is set. */
  | { readonly kind: "startFailed"; readonly hold: AdapterHold }
  | { readonly kind: "failed"; readonly reason: string };

/** Starts a reviewer session (the real one is `ReviewLauncher`). */
export interface ReviewSessions {
  start(request: ReviewSessionRequest): Promise<ReviewSessionOutcome>;
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
  readonly tmpRoot: string;
  readonly tempOwner?: () => string | undefined;
  readonly hosts: HostStarter;
  readonly ingest: RunIngest;
  /** Run control: the session is tracked before its ingestion starts. */
  readonly control: { track(office: OfficeId, run: TrackedRun): void };
  /** The backstop snapshot of the worktree before the review; without it no backstop runs. */
  readonly snapshot?: (office: OfficeId, worktree: string) => Promise<BackstopSnapshot>;
  readonly onChanged?: (office: OfficeId) => void;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The reviewer's settings for the run (0019 sections 4 and 16): model and effort from the office's
 * `review` block, its turn and minute caps from the run's start snapshot with their grants.
 */
export function reviewerSettings(
  office: OfficeHandle,
  run: StoredRun,
  config: OfficeConfig,
): ReviewerSettings {
  const caps = runCaps(office, run);
  return {
    model: config.review.model,
    effort: config.review.effort,
    maxTurns: caps.reviewMaxTurns ?? config.review.maxTurns,
    maxMinutes: caps.reviewMaxMinutes ?? config.review.maxMinutes,
  };
}

/** The real `ReviewSessions`. */
export class ReviewLauncher implements ReviewSessions {
  readonly #deps: ReviewLauncherDeps;

  constructor(deps: ReviewLauncherDeps) {
    this.#deps = deps;
  }

  async start(request: ReviewSessionRequest): Promise<ReviewSessionOutcome> {
    const deps = this.#deps;
    const { run } = request;
    const office = deps.offices.get(request.office);
    const config = deps.offices.config(request.office);
    const git = deps.git(request.office);
    if (office === undefined || config === undefined || git === undefined) {
      return { kind: "failed", reason: `office ${request.office} is not loaded` };
    }
    if (run.worktree === null || run.key === null || run.story === null) {
      return { kind: "failed", reason: `${run.runId} is not a story run with a worktree` };
    }
    const tier =
      (config.tiers as Readonly<Record<string, TierCaps>>)[run.tier ?? ""] ?? config.tiers.M;
    const settings = reviewerSettings(office, run, config);
    const paths = runLaunchPaths(git, deps, run.worktree, run.runId);
    const agent = AgentId.parse(deps.ids.next("agt"));
    const systemFile = renderSystemFile("review", "reviewer");
    // The CLI's own budget is what remains of the story's; the reviewer's turns and minutes are
    // its own caps (0019 section 13).
    const now = deps.clock.now();
    const budget =
      runCaps(office, run).budgetTokens - runTotals(office, run.runId, now, now).budgetTokens;
    const caps: Caps = {
      budgetTokens: Math.max(1, budget),
      maxTurns: settings.maxTurns,
      maxMinutes: settings.maxMinutes,
    };
    const spec = runWorkerSpec(
      deps.worker,
      { runId: run.runId, agent, caps: tier, reviewer: settings },
      paths,
      request.taskMessage,
      { id: sessionUuid(agent), resume: false },
      caps,
    );
    try {
      ensurePrivateDir(paths.runDir);
      prepareRunTempDirs(paths, run.runId, deps.tempOwner?.());
      writeFileSync(spec.systemFile, systemFile, { mode: 0o600 });
    } catch (error) {
      return {
        kind: "failed",
        reason: `the run directory could not be prepared: ${messageOf(error)}`,
      };
    }
    // The launch checks run before every launch (0008 section 2).
    let prepared;
    try {
      prepared = await deps.worker.prepare(
        spec,
        paths,
        config,
        sessionUuid(`${agent}:launch-check`),
      );
    } catch (error) {
      const why =
        error instanceof PlanError
          ? `the launch plan refused it: ${error.message}`
          : messageOf(error);
      return { kind: "failed", reason: why };
    }
    if (!prepared.ok) return { kind: "startFailed", hold: prepared.hold };

    let snapshot: BackstopSnapshot | null = null;
    if (deps.snapshot !== undefined) {
      try {
        snapshot = await deps.snapshot(request.office, run.worktree);
      } catch (error) {
        deps.warn?.("the backstop snapshot before a review could not be taken; no backstop runs", {
          run: run.runId,
          reason: messageOf(error),
        });
      }
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
        promptParts(systemFile, request.taskMessage, []),
        deps.clock,
      );
      recordPromptTexts(
        office,
        run.runId,
        agent,
        [
          { part: "system", text: systemFile },
          { part: "message", text: request.taskMessage },
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
      snapshot,
    });
    deps.ingest.start(office, host, {
      run: run.runId,
      agent,
      role: REVIEWER_ROLE,
      tier: run.tier ?? "",
      budgetLimit: runCaps(office, run).budgetTokens,
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
