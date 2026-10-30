// `story.park` and `story.drop` (DIPO-160, DIPO-344; 0020, 0005). A story that no run owns
// changes through the planning lane (0010, lane b): the operation is journaled first, so the
// pending-op skip covers the story at once, then the facts are written and the lane flushes.
//
// - `story.park { story, note }` (0020): the one way the maintainer stops a story, with reason
//   `by-maintainer` and the note as detail. A story with a run (In Progress or In Review, its claim
//   live) parks through run control (`parkRun`, `RunControl.parkByMaintainer`), which stops a
//   running worker first. A Refined or Ready story with no run parks through the lane: its `hold`
//   operation writes F16 (`park: {reason: by-maintainer, from, note}`) and status Parked; an open
//   `parks` row without a run is the park's run detail, and `story.parked` follows
//   `story.state`. A Parked story answers `changed: false`; any other status fails
//   `story.notParkable`. `work.resume` of a park with no run is `resumeHold` below. A hold the
//   Backlog CLI failed to write keeps the story out of pickup (DIPO-401): `story.park` sends it
//   again, replacing its park row, and `work.resume` dismisses it (`dismissFailedHold`).
// - `story.drop { story, deleteBranch }`: a Draft, Refined, Ready or Parked story is archived.
//   In Progress or In Review fails `story.active`, and a story another active story depends on
//   fails `story.hasDependents`. `deleteBranch` needs the typed story id from the client. The order
//   is 0010 section 2a: journal, close the story PR with a comment, release the claim (branch kept
//   and recorded as released, or deleted locally and on the remote; a story has no worktree), then
//   the park is resolved `drop`, `story.state` says Removed and the lane
//   flushes. A failure before the facts are written withdraws the journal entry, so the story is
//   not archived later behind the maintainer's back. Every step is target-state under a re-run: an
//   open journal entry is reused, a closed PR and a released claim are not touched again.
// - `story.losses { story }` (DIPO-228): what `deleteBranch` loses, read before the typed id: the
//   commits not on the base of the claim's branch (or the kept branches without a claim; with
//   `work.discard`, the branches a story Done elsewhere kept as leftovers, DIPO-161). A drop
//   without a live claim and with `deleteBranch` deletes the kept branches of the story and
//   reclaims their rows; a failure after the PR closed says so.

import {
  type CommandName,
  type Lifecycle,
  type LostCommit,
  type RunId,
  StoryId,
  type StoryKey,
  storyDrop,
  storyPark,
  storyLosses,
  type StoryView,
} from "@dipsaus-orchestrator/contract";
import type { z } from "zod";

import type { NewEntry } from "../changelog/log";
import { CommandError } from "../commands/errors";
import type {
  AsyncCommandContext,
  CommandOutcome,
  FeatureModule,
  FeatureRegistry,
  ReadContext,
} from "../commands/registry";
import type { OfficeHandle } from "../db/office";
import type { GitSession, OfficeGit } from "../git/office";
import { type CodeHost, CodeHostError } from "../platform/host";
import type { ProcessProbe } from "../platform/process";
import { openPark, openParkIds, parkActions, resolvePark } from "../run/park";
import { insertPark } from "../run/park-records";
import type { ParkStore } from "../records/park-state";
import { activeRuns } from "../records/run-records";
import { hostAlive, workerHostsOf } from "../records/worker-hosts";
import type { StoryIdentity } from "../records/story-keys";
import { latestStoryPr, setStoryPrState } from "../records/story-prs";
import { LIVE_CLAIM_REFUSAL, PlanningRefusedError } from "../story-store/errors";
import { DROP_KIND, type PlanningLane } from "../story-store/planning";
import { deriveStoryView, lifecycleOf, storyView } from "../views/story";
import {
  deleteKeptBranches,
  leftoverBranchNames,
  releaseForDrop,
  repoOfPrUrl,
} from "../worktree/release";
import { leftoverTargets } from "../worktree/done-elsewhere";
import {
  liveClaimOf,
  openReleasedBranches,
  type ClaimRecord,
  type ReleasedBranch,
} from "../worktree/records";

/** `engine.notice` codes of park and drop. */
export const PLANNING_NOTICES = {
  remoteBranch: "drop.remoteBranch",
} as const;

export interface StoryPlanningDeps {
  /** The story store: the park a pending planning change writes (`plannedPark`, 0010). */
  readonly stories: ParkStore;
  /** The office's planning lane (0010), through the StoryStore seam. */
  readonly lane: (office: OfficeHandle["officeId"]) => PlanningLane | undefined;
  readonly git: (office: OfficeHandle["officeId"]) => OfficeGit | undefined;
  /** The code host the open story PR is closed on. */
  readonly host: Pick<CodeHost, "closePr">;
  /** The commands the engine registered, for the `actions` of `story.parked`. */
  readonly implemented: (name: CommandName) => boolean;
  /** Reads whether a worker host of the claim's run still runs (0020 section 8). */
  readonly probe: ProcessProbe;
  /** Parks a story with a run (`RunControl.parkByMaintainer`); without it such a story is refused. */
  readonly parkRun?: (
    ctx: AsyncCommandContext,
    args: { readonly story: string; readonly note: string },
  ) => Promise<CommandOutcome<{ run: RunId }>>;
}

type StoryResult = { story: StoryId; key: StoryKey };
type ParkArgs = z.output<typeof storyPark.args>;
type ParkResult = z.input<typeof storyPark.result>;
type DropArgs = z.output<typeof storyDrop.args>;
type LossesArgs = z.output<typeof storyLosses.args>;
type LossesResult = {
  story: StoryId;
  key: StoryKey;
  commits: LostCommit[];
};

/** `story.park` of a story that is neither Refined, Ready, In Progress, In Review nor Parked. */
export const NOT_PARKABLE = "story.notParkable";
export const STORY_ACTIVE = "story.active";
export const HAS_DEPENDENTS = "story.hasDependents";
export const PR_NOT_CLOSED = "story.prNotClosed";
export const NOT_DROPPABLE = "story.notDroppable";
/** 0005's retryable code: a worker host of the parked run still runs (0020 section 8). */
export const RUN_HOST_ALIVE = "run.hostAlive";

export class StoryPlanning {
  readonly #deps: StoryPlanningDeps;

  constructor(deps: StoryPlanningDeps) {
    this.#deps = deps;
  }

  /** `story.park` and `story.drop` on the waiting command path. */
  get feature(): FeatureModule {
    return {
      name: "stories/planning",
      register: (registry: FeatureRegistry) => {
        registry.addAsyncOfficeCommand({
          definition: storyPark,
          handle: (ctx, args) => this.park(ctx, args),
        });
        registry.addAsyncOfficeCommand({
          definition: storyDrop,
          handle: (ctx, args) => this.drop(ctx, args),
        });
        registry.addAsyncRead({
          definition: storyLosses,
          handle: (ctx, args) => this.losses(ctx, args),
        });
      },
    };
  }

  // ---- losses --------------------------------------------------------------------------------

  /**
   * `story.losses` (DIPO-228): what `story.drop` with `deleteBranch` loses. The commits of the live
   * claim's branch, else of the open released branches, that are not on the base as last fetched.
   * Reads git only.
   *
   * With `command: work.discard` (DIPO-161) and no live claim it lists exactly what the discard of
   * the story's leftovers removes (`leftoverTargets`): the commits of the open released branches
   * and of the leftovers' own branches (settled or not).
   */
  async losses(ctx: ReadContext, args: LossesArgs): Promise<LossesResult> {
    const office = ctx.office;
    const identity = ctx.stories.get(args.story);
    if (office === undefined || identity === undefined) {
      throw new Error("story.losses runs with its office and its story resolved");
    }
    const { key, story } = identity;
    const discard = args.command === "work.discard";
    const claim = liveClaimOf(office, key);
    const leftovers = claim === null ? leftoverTargets(office, key) : null;
    const branches =
      claim !== null
        ? [claim.branch]
        : discard && leftovers !== null
          ? leftoverBranchNames(leftovers)
          : openReleasedBranches(office, key).map((release) => release.branch);
    if (branches.length === 0) return { story, key, commits: [] };
    const git = this.#deps.git(office.officeId);
    if (git === undefined) throw new Error(`The office ${office.officeId} has no git attached.`);
    const commits = await git.run(async (session) => {
      const base = await baseRefOf(git, session);
      const found = new Map<string, LostCommit>();
      for (const branch of branches) {
        // A kept branch deleted by hand has nothing left to lose: skip it, never fail the read.
        const ref = await session.step(session.repository, [
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/heads/${branch}^{commit}`,
        ]);
        if (ref.code !== 0) continue;
        const log = await session.ok(session.repository, [
          "log",
          "--format=%h%x09%s",
          `${base}..refs/heads/${branch}`,
        ]);
        for (const line of log.split("\n")) {
          const tab = line.indexOf("\t");
          if (tab <= 0) continue;
          const sha = line.slice(0, tab);
          if (!found.has(sha)) found.set(sha, { sha, subject: line.slice(tab + 1) });
        }
      }
      return [...found.values()];
    });
    return { story, key, commits };
  }

  // ---- park ----------------------------------------------------------------------------------

  /** `story.park`: see the file comment. */
  async park(ctx: AsyncCommandContext, args: ParkArgs): Promise<CommandOutcome<ParkResult>> {
    const office = ctx.office;
    const identity = identityOf(ctx, args.story);
    const { key, story } = identity;
    const result = { story, key };
    const view = storyView(office, key);
    // A park whose hold failed to write is no park (DIPO-401): the story is where the hold found
    // it, and this park sends it again.
    const failed = this.#deps.lane(office.officeId)?.failedHold(key);
    const lifecycle =
      failed !== undefined && view?.lifecycle === "Parked"
        ? (failed.from ?? view.lifecycle)
        : view?.lifecycle;
    // Parked already: the target state (0005).
    if (lifecycle === "Parked" || openPark(this.#deps.stories, office, key) !== null) {
      return { result, changed: false };
    }
    const claim = liveClaimOf(office, key);
    const running = activeRuns(office).some((run) => run.kind === "story" && run.key === key);
    if (running || (claim !== null && (lifecycle === "In Progress" || lifecycle === "In Review"))) {
      // A story with a run parks through run control, which stops a running worker first.
      if (this.#deps.parkRun === undefined) {
        throw new CommandError(
          NOT_PARKABLE,
          `${story} has a run, and this dipo cannot park a run.`,
          { story },
        );
      }
      const parked = await this.#deps.parkRun(ctx, { story: args.story, note: args.note });
      return {
        result: { ...result, run: parked.result.run },
        ...(parked.changed === undefined ? {} : { changed: parked.changed }),
      };
    }
    if (view === null || (lifecycle !== "Refined" && lifecycle !== "Ready")) {
      throw new CommandError(
        NOT_PARKABLE,
        `${story} is ${lifecycle ?? "unknown"}; only a Refined, Ready, In Progress or In Review story can be parked.`,
        { story },
      );
    }
    const from: "Refined" | "Ready" = lifecycle;
    const lane = this.#laneOf(office);
    // A park sent again after its hold failed to write (DIPO-401): the earlier attempt's open
    // park row gives way to this one.
    const again = failed === undefined ? [] : openParkIds(office, key);
    try {
      await lane.hold({ key, story }, { from, note: args.note });
    } catch (error) {
      if (error instanceof PlanningRefusedError && error.code === LIVE_CLAIM_REFUSAL) {
        throw new CommandError(
          NOT_PARKABLE,
          `${story} was claimed meanwhile; send story.park again to park its run.`,
          { story },
        );
      }
      throw error;
    }
    const at = ctx.clock.now();
    ctx.commit((): NewEntry[] => {
      const replaced = again.flatMap((parkId) =>
        resolvePark(office, parkId, "reconcile", at, "replaced by the park sent again"),
      );
      insertPark(office, {
        key,
        story,
        runId: null,
        reason: "by-maintainer",
        detail: args.note,
        at,
      });
      const parked = deriveStoryView({
        ...factsOf(view),
        lifecycle: "Parked",
        park: { reason: "by-maintainer", from, note: args.note, since: at },
      });
      return [
        ...replaced,
        {
          type: "story.state",
          key,
          delta: { story, key, from, to: "Parked", detail: [`by-maintainer: ${args.note}`] },
          view: parked,
        },
        {
          type: "story.parked",
          key,
          delta: {
            story,
            key,
            reason: "by-maintainer",
            detail: args.note,
            from,
            actions: parkActions("by-maintainer", this.#deps.implemented),
          },
        },
      ];
    });
    await lane.flush();
    return { result, changed: true };
  }

  /**
   * `work.resume` of a park with no run (0020): the lane removes F16 and sets the status back to
   * `park.from`; the story is covered by the pending-op skip until that merges, and a story
   * returned to Ready goes through the pickup re-check at the next `work.run`.
   */
  async resumeHold(
    ctx: AsyncCommandContext,
    identity: StoryIdentity,
    park: { readonly parkId: number; readonly from: string; readonly detail: string },
    note: string | undefined,
  ): Promise<Lifecycle> {
    const office = ctx.office;
    const { key, story } = identity;
    const to: Lifecycle = park.from === "Ready" ? "Ready" : "Refined";
    const lane = this.#laneOf(office);
    await lane.resume({ key, story }, to);
    const at = ctx.clock.now();
    ctx.commit((): NewEntry[] => {
      const closed = resolvePark(office, park.parkId, "resume", at, note ?? null);
      const current = storyView(office, key);
      const view = deriveStoryView({
        ...(current === null ? { key, story: identity.story, title: "" } : factsOf(current)),
        lifecycle: to,
      });
      return [
        ...closed,
        {
          type: "story.state",
          key,
          delta: {
            story,
            key,
            from: "Parked",
            to,
            detail: [
              `resumed from by-maintainer: ${park.detail}`,
              ...(note === undefined ? [] : [note]),
            ],
          },
          view,
        },
      ];
    });
    await lane.flush();
    return to;
  }

  /**
   * `work.resume` of a story whose park failed to write (DIPO-401): the failed hold is withdrawn,
   * so pickup may take the story again, and the park row it left is resolved `resume`. Null when
   * the story has no failed hold.
   */
  async dismissFailedHold(
    ctx: AsyncCommandContext,
    identity: StoryIdentity,
    note: string | undefined,
  ): Promise<Lifecycle | null> {
    const office = ctx.office;
    const { key, story } = identity;
    const lane = this.#laneOf(office);
    const failed = lane.failedHold(key);
    if (failed === undefined) return null;
    const current = storyView(office, key);
    const to: Lifecycle =
      current !== null && current.lifecycle !== "Parked"
        ? current.lifecycle
        : (failed.from ?? "Refined");
    const at = ctx.clock.now();
    ctx.commit((): NewEntry[] => {
      lane.withdraw(failed);
      const closed = openParkIds(office, key).flatMap((parkId) =>
        resolvePark(office, parkId, "resume", at, note ?? null),
      );
      if (current === null || current.lifecycle === to) return closed;
      return [
        ...closed,
        {
          type: "story.state",
          key,
          delta: {
            story,
            key,
            from: current.lifecycle,
            to,
            detail: [
              "the park that failed to write was dismissed",
              ...(note === undefined ? [] : [note]),
            ],
          },
          view: deriveStoryView({ ...factsOf(current), lifecycle: to }),
        },
      ];
    });
    return to;
  }

  // ---- drop ----------------------------------------------------------------------------------

  async drop(ctx: AsyncCommandContext, args: DropArgs): Promise<CommandOutcome<StoryResult>> {
    const office = ctx.office;
    const identity = identityOf(ctx, args.story);
    const { key, story } = identity;
    const result = { story, key };
    const view = storyView(office, key);
    const lifecycle = view?.lifecycle ?? "Removed";
    // Archived already: the target state, so a re-run answers the same.
    if (lifecycle === "Removed") return { result, changed: false };
    // A re-run after the drop's facts were written: its journal entry is open, and nothing is left
    // to release or close. The lane may still owe the flush.
    if (this.#dropWritten(office, key)) {
      await this.#laneOf(office).flush();
      return { result, changed: false };
    }
    const running = activeRuns(office).some((run) => run.kind === "story" && run.key === key);
    if (running || lifecycle === "In Progress" || lifecycle === "In Review") {
      throw new CommandError(
        STORY_ACTIVE,
        `${story} is ${lifecycle}; park it with \`dipo park ${story} --note <why>\` first, then drop it.`,
        { story, lifecycle },
      );
    }
    if (lifecycle === "Done") {
      throw new CommandError(NOT_DROPPABLE, `${story} is Done; there is nothing to drop.`, {
        story,
      });
    }
    const dropping = this.#deps.lane(office.officeId)?.dropping() ?? new Set<StoryKey>();
    const dependents = activeDependents(office, identity, dropping);
    if (dependents.length > 0) {
      throw new CommandError(
        HAS_DEPENDENTS,
        `${dependents.join(", ")} ${dependents.length === 1 ? "depends" : "depend"} on ${story}; drop ${dependents.length === 1 ? "it" : "them"} or remove the dependency first.`,
        { story, dependents },
      );
    }
    const claim = liveClaimOf(office, key);
    // Without a live claim, `deleteBranch` deletes the branches the story's releases kept (DIPO-228).
    const kept = claim === null && args.deleteBranch ? openReleasedBranches(office, key) : [];
    const git = this.#deps.git(office.officeId);
    if ((claim !== null || kept.length > 0) && git === undefined) {
      throw new Error(`The office ${office.officeId} has no git attached.`);
    }
    // A worker host of the parked run that still runs owns the story's box: refuse before anything
    // is journaled, closed or removed, with or without deleteBranch (0020 section 8).
    if (claim !== null) {
      const pid = await this.#liveHostPid(office, claim.runId);
      if (pid !== null) {
        throw new CommandError(
          RUN_HOST_ALIVE,
          `A worker host of ${story} still runs (pid ${pid}), so its box is in use. Drop it again in a moment, once the host has exited.`,
          { story, pid },
        );
      }
    }

    const lane = this.#laneOf(office);
    const entry = await lane.drop({ key, story }, lifecycle === "Draft" ? "draft" : "task");
    let closedPr: number | null = null;
    try {
      closedPr = await this.#closePr(ctx, identity);
      if (claim !== null && git !== undefined) {
        await this.#release(ctx, identity, claim, args, closedPr);
      } else if (kept.length > 0 && git !== undefined) {
        await this.#deleteKept(ctx, identity, git, kept, closedPr);
      }
    } catch (error) {
      // Nothing was archived: the story must not be, later, by a flush of this entry.
      lane.withdraw(entry);
      throw error;
    }
    const at = ctx.clock.now();
    ctx.commit((): NewEntry[] => {
      // Every open park row of the story is run detail the drop ends, whatever Backlog.md says.
      const closed = openParkIds(office, key).flatMap((park) =>
        resolvePark(office, park, "drop", at),
      );
      const removed = deriveStoryView({
        ...(view === null ? { key, story, title: "" } : factsOf(view)),
        lifecycle: "Removed",
      });
      return [
        ...closed,
        {
          type: "story.state",
          key,
          delta: { story, key, from: lifecycle, to: "Removed", detail: ["dropped"] },
          view: removed,
        },
      ];
    });
    await lane.flush();
    return { result, changed: true };
  }

  /** The PID of the first worker host of `runId` that still runs, or null. */
  async #liveHostPid(office: OfficeHandle, runId: RunId): Promise<number | null> {
    for (const host of workerHostsOf(office, runId)) {
      if (await hostAlive(host, this.#deps.probe)) return host.pid;
    }
    return null;
  }

  /** True when `story.drop` journaled the story's drop and left no claim, PR or park behind. */
  #dropWritten(office: OfficeHandle, key: StoryKey): boolean {
    const journaled = this.#deps.lane(office.officeId)?.isOpen(key, DROP_KIND) ?? false;
    if (!journaled || liveClaimOf(office, key) !== null || openParkIds(office, key).length > 0) {
      return false;
    }
    return latestStoryPr(office, key)?.state !== "open";
  }

  /** Closes the story's open PR with a comment naming the drop; returns its number, or null. */
  async #closePr(ctx: AsyncCommandContext, identity: StoryIdentity): Promise<number | null> {
    const office = ctx.office;
    const pr = latestStoryPr(office, identity.key);
    if (pr === null || pr.state !== "open") return null;
    const repo = repoOfPrUrl(pr.url);
    if (repo === null) {
      throw new CommandError(
        PR_NOT_CLOSED,
        `dipo could not tell which repository the PR ${pr.url} of ${identity.story} is on, so it did not close it.`,
        { story: identity.story, url: pr.url },
      );
    }
    const comment = `Closed by dipo: ${identity.story} was dropped (story.drop). Its task file is archived on the base, so this PR must not merge.`;
    try {
      await this.#deps.host.closePr(repo, pr.number, comment);
    } catch (error) {
      if (!(error instanceof CodeHostError)) throw error;
      throw new CommandError(
        PR_NOT_CLOSED,
        `dipo could not close PR #${pr.number} of ${identity.story}: ${error.message}. Nothing was dropped.`,
        { story: identity.story, number: pr.number },
      );
    }
    const at = ctx.clock.now();
    ctx.commit((): NewEntry[] => {
      setStoryPrState(office, pr.runId, { state: "closed", closedAt: at });
      return [
        {
          type: "story.pr",
          key: identity.key,
          run: pr.runId,
          delta: {
            story: identity.story,
            key: identity.key,
            pr: { number: pr.number, url: pr.url, state: "closed" },
          },
        },
      ];
    });
    return pr.number;
  }

  /** Releases the claim: the branch is kept or deleted as the drop asked. */
  async #release(
    ctx: AsyncCommandContext,
    identity: StoryIdentity,
    claim: ClaimRecord,
    args: DropArgs,
    closedPr: number | null,
  ): Promise<void> {
    const git = this.#deps.git(ctx.office.officeId);
    if (git === undefined)
      throw new Error(`The office ${ctx.office.officeId} has no git attached.`);
    const outcome = await releaseForDrop(
      {
        officeId: ctx.office.officeId,
        office: ctx.office,
        git,
        clock: ctx.clock,
      },
      claim,
      { deleteBranch: args.deleteBranch },
    );
    if (!outcome.ok) throw notDropped(identity.story, closedPr, outcome.why);
    if (outcome.remoteProblem !== null) {
      const remote = git.settings.remote;
      const text = `dipo could not delete the remote branch ${claim.branch}: ${outcome.remoteProblem}. Delete it by hand (\`git push ${remote} --delete ${claim.branch}\`).`;
      ctx.commit((): NewEntry[] => [
        {
          type: "engine.notice",
          key: identity.key,
          delta: { level: "warn", code: PLANNING_NOTICES.remoteBranch, text },
        },
      ]);
    }
  }

  /**
   * `deleteBranch` of a story without a live claim (DIPO-228): deletes the branches its releases
   * kept, locally and on the remote, and reclaims their rows.
   */
  async #deleteKept(
    ctx: AsyncCommandContext,
    identity: StoryIdentity,
    git: OfficeGit,
    released: readonly ReleasedBranch[],
    closedPr: number | null,
  ): Promise<void> {
    const outcome = await deleteKeptBranches(
      { officeId: ctx.office.officeId, office: ctx.office, git, clock: ctx.clock },
      released,
    );
    if (!outcome.ok) throw notDropped(identity.story, closedPr, outcome.why);
    if (outcome.remoteProblem !== null) {
      const remote = git.settings.remote;
      const text = `dipo could not delete a remote branch of ${identity.story}: ${outcome.remoteProblem}. Delete it by hand (\`git push ${remote} --delete <branch>\`).`;
      ctx.commit((): NewEntry[] => [
        {
          type: "engine.notice",
          key: identity.key,
          delta: { level: "warn", code: PLANNING_NOTICES.remoteBranch, text },
        },
      ]);
    }
  }

  #laneOf(office: OfficeHandle): PlanningLane {
    const lane = this.#deps.lane(office.officeId);
    if (lane === undefined) throw new Error(`The office ${office.officeId} has no backlog lane.`);
    return lane;
  }
}

/**
 * The error of a drop whose release or branch deletion failed. After the drop closed the story's PR
 * the error says so, since that PR stays closed while the story is not archived (DIPO-228).
 */
function notDropped(story: StoryId, closedPr: number | null, why: string): CommandError {
  const closed =
    closedPr === null ? "" : `PR #${closedPr} was closed and the story was not archived: `;
  return new CommandError(NOT_DROPPABLE, `${story} was not dropped: ${closed}${why}.`, { story });
}

/** The base as last fetched: `refs/remotes/<remote>/<base>`, else the local `<base>` branch. */
async function baseRefOf(git: OfficeGit, session: GitSession): Promise<string> {
  const base = await git.resolveBaseIn(session);
  const remote = `refs/remotes/${git.settings.remote}/${base}`;
  const found = await session.step(session.repository, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${remote}^{commit}`,
  ]);
  return found.code === 0 ? remote : `refs/heads/${base}`;
}

function identityOf(ctx: AsyncCommandContext, ref: string): StoryIdentity {
  const identity = ctx.stories.get(ref);
  if (identity === undefined) throw new Error(`${ref} was not resolved`);
  return identity;
}

/** The facts a derived view is rebuilt from, taken from the story's current view. */
function factsOf(view: StoryView): {
  key: StoryKey;
  story: StoryId;
  title: string;
  tier?: NonNullable<StoryView["tier"]>;
} {
  return {
    key: view.key,
    story: view.story,
    title: view.title,
    ...(view.tier === undefined ? {} : { tier: view.tier }),
  };
}

/**
 * The active stories (not Done, not removed, no drop pending) that list `story` among their
 * dependencies, by id. The dependencies are what the story index mirrored from `_base`.
 */
function activeDependents(
  office: OfficeHandle,
  identity: StoryIdentity,
  dropping: ReadonlySet<StoryKey>,
): string[] {
  const rows = office.all<{
    key: string;
    story_id: string;
    kind: "task" | "draft";
    status: string;
    deps: string | null;
  }>(
    `select s.key as key, s.story_id as story_id, m.kind as kind, m.status as status,
            coalesce(m.gate_dependencies, m.waiting_on) as deps
       from stories s
       join backlog_mirror m on m.office_id = s.office_id and m.key = s.key
      where s.office_id = $office_id and s.removed_at is null and s.key != $key`,
    { key: identity.key },
  );
  const wanted = identity.story.toUpperCase();
  return rows
    .filter((row) => {
      if (row.deps === null || dropping.has(row.key as StoryKey)) return false;
      if (lifecycleOf(row.kind, row.status) === "Done") return false;
      const ids = JSON.parse(row.deps) as unknown;
      return (
        Array.isArray(ids) &&
        ids.some((id) => typeof id === "string" && id.toUpperCase() === wanted)
      );
    })
    .map((row) => row.story_id)
    .toSorted();
}
