// `story.hold` and `story.drop` (DIPO-160; 0020 section 8, 0005 section 4 and the waiting command
// path of the amendment of 2026-10-17). Both change a story that no run owns through the planning
// lane (0010 section 2, lane b): the operation is journaled first, so the pending-op skip covers
// the story at once, then the facts are written and the lane flushes.
//
// - `story.hold { story, note }`: a Refined or Ready story becomes Parked `on-hold`. A running
//   story fails `story.notHoldable` naming `dipo stop`, a parked story with a claim fails it naming
//   resume and discard. The lane's `hold` writes F16 (`park: {reason: on-hold, from, note}`) and
//   status Parked; an open `parks` row without a run is the park's history, and `story.parked`
//   follows `story.state`. `work.resume` of the park is `resumeHold` below.
// - `story.drop { story, deleteBranch }`: a Draft, Refined, Ready or Parked story is archived.
//   In Progress or In Review fails `story.active`, a story another active story depends on fails
//   `story.hasDependents`, and a worktree with uncommitted or untracked files fails
//   `story.dirtyWorktree` listing them, unless `deleteBranch` is set (the client asked for the
//   typed story id). The order is 0010 section 2a: journal, close the story PR with a comment,
//   release the claim (worktree removed; branch kept and recorded as released, or deleted locally
//   and on the remote), then the park is resolved `drop`, `story.state` says Removed and the lane
//   flushes. A failure before the facts are written withdraws the journal entry, so the story is
//   not archived later behind the maintainer's back. Every step is target-state under a re-run: an
//   open journal entry is reused, a closed PR and a released claim are not touched again.
// - `story.losses { story }` (DIPO-228): what `deleteBranch` loses, read before the typed id: the
//   commits not on the base of the claim's branch (or the kept branches without a claim) and the
//   files of the claim's worktree; without a claim, the files of the worktrees a story Done
//   elsewhere kept as leftovers (DIPO-161), which `work.discard` lists too. A drop without a live
//   claim and with `deleteBranch` deletes the kept branches of the story and reclaims their rows; a
//   failure after the PR closed says so.

import {
  type CommandName,
  type Lifecycle,
  type LostCommit,
  type RunId,
  StoryId,
  type StoryKey,
  storyDrop,
  storyHold,
  storyLosses,
  type StoryView,
} from "@dipsaus-orchestrator/contract";
import type { z } from "zod";

import {
  allEntries,
  HOLD_KIND,
  type JournalEntry,
  LaneError,
  LaneFlushError,
  type LaneOp,
  OPEN_STATES,
  type OfficeLane,
  DROP_KIND,
  RESUME_KIND,
} from "../backlog/lane";
import { updateEntry } from "../backlog/lane/journal";
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
import { parkActions, openPark } from "../run/park";
import { activeRuns } from "../run/records";
import { hostAlive, workerHostsOf } from "../runs/worker-hosts";
import { latestStoryPr, setStoryPrState } from "../story-pr/records";
import { deriveStoryView, lifecycleOf, storyView } from "../views/story";
import { deleteKeptBranches, dirtyFilesOf, releaseForDrop, repoOfPrUrl } from "../worktree/release";
import { openLeftovers } from "../worktree/done-elsewhere";
import {
  findClaim,
  liveClaimOf,
  openReleasedBranches,
  type ClaimRecord,
  type ReleasedBranch,
} from "../worktree/records";
import type { SlotTable } from "../worktree/slots";

import type { StoryIdentity } from "./keys";

/** `engine.notice` codes of hold and drop. */
export const PLANNING_NOTICES = {
  remoteBranch: "drop.remoteBranch",
} as const;

export interface StoryPlanningDeps {
  readonly lane: (office: OfficeHandle["officeId"]) => OfficeLane | undefined;
  readonly git: (office: OfficeHandle["officeId"]) => OfficeGit | undefined;
  /** The code host the open story PR is closed on. */
  readonly host: Pick<CodeHost, "closePr">;
  readonly slots?: SlotTable;
  /** The commands the engine registered, for the `actions` of `story.parked`. */
  readonly implemented: (name: CommandName) => boolean;
  /** Reads whether a worker host of the claim's run still runs (0020 section 8). */
  readonly probe: ProcessProbe;
}

type StoryResult = { story: StoryId; key: StoryKey };
type HoldArgs = z.output<typeof storyHold.args>;
type DropArgs = z.output<typeof storyDrop.args>;
type LossesArgs = z.output<typeof storyLosses.args>;
type LossesResult = { story: StoryId; key: StoryKey; commits: LostCommit[]; files: string[] };

/** The Backlog.md statuses a hold applies from; `To Do` is what office init migrates to Refined. */
const HOLDABLE_STATUSES = ["Refined", "Ready", "To Do"];

export const NOT_HOLDABLE = "story.notHoldable";
export const STORY_ACTIVE = "story.active";
export const HAS_DEPENDENTS = "story.hasDependents";
export const DIRTY_WORKTREE = "story.dirtyWorktree";
export const PR_NOT_CLOSED = "story.prNotClosed";
export const NOT_DROPPABLE = "story.notDroppable";
/** 0005's retryable code: a worker host of the parked run still runs (0020 section 8). */
export const RUN_HOST_ALIVE = "run.hostAlive";

export class StoryPlanning {
  readonly #deps: StoryPlanningDeps;

  constructor(deps: StoryPlanningDeps) {
    this.#deps = deps;
  }

  /** `story.hold` and `story.drop` on the waiting command path. */
  get feature(): FeatureModule {
    return {
      name: "stories/planning",
      register: (registry: FeatureRegistry) => {
        registry.addAsyncOfficeCommand({
          definition: storyHold,
          handle: (ctx, args) => this.hold(ctx, args),
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
   * claim's branch, else of the open released branches, that are not on the base as last fetched,
   * and the uncommitted and untracked files of the claim's worktree, else of the worktrees a story
   * Done elsewhere kept as leftovers (DIPO-161). Reads git only.
   */
  async losses(ctx: ReadContext, args: LossesArgs): Promise<LossesResult> {
    const office = ctx.office;
    const identity = ctx.stories.get(args.story);
    if (office === undefined || identity === undefined) {
      throw new Error("story.losses runs with its office and its story resolved");
    }
    const { key, story } = identity;
    const claim = liveClaimOf(office, key);
    const branches =
      claim === null
        ? openReleasedBranches(office, key).map((release) => release.branch)
        : [claim.branch];
    const trees =
      claim === null
        ? openLeftovers(office, key)
            .map((row) => findClaim(office, row.runId))
            .filter((tree): tree is ClaimRecord => tree !== null)
        : [claim];
    if (branches.length === 0 && trees.length === 0) return { story, key, commits: [], files: [] };
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
    const files: string[] = [];
    for (const tree of trees) {
      for (const file of await dirtyFilesOf({ git }, tree)) {
        if (!files.includes(file)) files.push(file);
      }
    }
    return { story, key, commits, files };
  }

  // ---- hold ----------------------------------------------------------------------------------

  async hold(ctx: AsyncCommandContext, args: HoldArgs): Promise<CommandOutcome<StoryResult>> {
    const office = ctx.office;
    const identity = identityOf(ctx, args.story);
    const { key, story } = identity;
    const result = { story, key };
    const view = storyView(office, key);
    const open = openPark(office, key);
    if (open !== null && open.reason === "on-hold") {
      // A re-run of the same hold finds its own park; another note is another hold.
      if (open.detail === args.note) return { result, changed: false };
      throw new CommandError(
        NOT_HOLDABLE,
        `${story} is already on hold; resume it with \`dipo resume ${story}\` first.`,
        { story },
      );
    }
    const claim = liveClaimOf(office, key);
    const running = activeRuns(office).some((run) => run.kind === "story" && run.key === key);
    const lifecycle = view?.lifecycle;
    if (running || lifecycle === "In Progress") {
      throw new CommandError(
        NOT_HOLDABLE,
        `${story} is running; stop it with \`dipo stop ${story}\` first.`,
        { story },
      );
    }
    if (lifecycle === "In Review") {
      throw new CommandError(
        NOT_HOLDABLE,
        `${story} is In Review and keeps its claim and PR; only a Refined or Ready story can be held.`,
        { story },
      );
    }
    if (lifecycle === "Parked" && claim !== null) {
      throw new CommandError(
        NOT_HOLDABLE,
        `${story} is parked with its claim; resume it with \`dipo resume ${story}\` or discard it with \`dipo discard ${story}\`.`,
        { story },
      );
    }
    if (view === null || (lifecycle !== "Refined" && lifecycle !== "Ready")) {
      throw new CommandError(
        NOT_HOLDABLE,
        `${story} is ${lifecycle ?? "unknown"}; only a Refined or Ready story can be held.`,
        { story },
      );
    }
    const from: "Refined" | "Ready" = lifecycle;
    const lane = this.#laneOf(office);
    const op: LaneOp = {
      kind: HOLD_KIND,
      key,
      subject: story,
      target: {
        from: HOLDABLE_STATUSES,
        status: "Parked",
        fields: { park: { reason: "on-hold", from, note: args.note } },
      },
    };
    try {
      await journalOnce(lane, office, op);
    } catch (error) {
      if (error instanceof LaneError && error.code === "backlog.lane.liveClaim") {
        throw new CommandError(
          NOT_HOLDABLE,
          `${story} has a live claim; stop it with \`dipo stop ${story}\` first.`,
          { story },
        );
      }
      throw error;
    }
    const at = ctx.clock.now();
    ctx.commit((): NewEntry[] => {
      office.run(
        `insert into parks (office_id, park_id, key, story_id, run_id, reason, from_state, detail, at)
         values ($office_id, (select coalesce(max(park_id), 0) + 1 from parks
           where office_id = $office_id), $key, $story, null, 'on-hold', $from, $note, $at)`,
        { key, story, from, note: args.note, at },
      );
      const parked = deriveStoryView({
        ...factsOf(view),
        lifecycle: "Parked",
        park: { reason: "on-hold", from, note: args.note, since: at },
      });
      return [
        {
          type: "story.state",
          key,
          delta: { story, key, from, to: "Parked", detail: [`on-hold: ${args.note}`] },
          view: parked,
        },
        {
          type: "story.parked",
          key,
          delta: {
            story,
            key,
            reason: "on-hold",
            detail: args.note,
            from,
            actions: parkActions("on-hold", this.#deps.implemented),
          },
        },
      ];
    });
    await flushQuietly(lane);
    return { result, changed: true };
  }

  /**
   * `work.resume` of an on-hold park (0020 section 8): the lane removes F16 and sets the status
   * back to `park.from`; the story is covered by the pending-op skip until that merges, and a
   * story returned to Ready goes through the pickup re-check at the next `work.run`.
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
    await journalOnce(lane, office, {
      kind: RESUME_KIND,
      key,
      subject: story,
      target: { from: ["Parked"], status: to, unset: ["park"] },
    });
    const at = ctx.clock.now();
    ctx.commit((): NewEntry[] => {
      office.run(
        `update parks set resolved_at = $at, resolved_how = 'resume'
         where office_id = $office_id and park_id = $park and resolved_at is null`,
        { at, park: park.parkId },
      );
      const current = storyView(office, key);
      const view = deriveStoryView({
        ...(current === null ? { key, story: identity.story, title: "" } : factsOf(current)),
        lifecycle: to,
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
            detail: [`resumed from on-hold: ${park.detail}`, ...(note === undefined ? [] : [note])],
          },
          view,
        },
      ];
    });
    await flushQuietly(lane);
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
      await flushQuietly(this.#laneOf(office));
      return { result, changed: false };
    }
    const running = activeRuns(office).some((run) => run.kind === "story" && run.key === key);
    if (running || lifecycle === "In Progress" || lifecycle === "In Review") {
      throw new CommandError(
        STORY_ACTIVE,
        `${story} is ${lifecycle}; stop it with \`dipo stop ${story}\` first, then drop it.`,
        { story, lifecycle },
      );
    }
    if (lifecycle === "Done") {
      throw new CommandError(NOT_DROPPABLE, `${story} is Done; there is nothing to drop.`, {
        story,
      });
    }
    const dependents = activeDependents(office, identity);
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
    // A worker host of the parked run that still runs owns the worktree: refuse before anything
    // is journaled, closed or removed, with or without deleteBranch (0020 section 8).
    if (claim !== null) {
      const pid = await this.#liveHostPid(office, claim.runId);
      if (pid !== null) {
        throw new CommandError(
          RUN_HOST_ALIVE,
          `A worker host of ${story} still runs (pid ${pid}), so its worktree is in use. Drop it again in a moment, once the host has exited.`,
          { story, pid },
        );
      }
    }
    if (claim !== null && git !== undefined && !args.deleteBranch) {
      const files = await dirtyFilesOf({ git }, claim);
      if (files.length > 0) {
        throw new CommandError(
          DIRTY_WORKTREE,
          `The worktree of ${story} has uncommitted or untracked files: ${files.join(", ")}. Commit or remove them, or drop with \`--delete-branch\` to remove the worktree and the branch with them.`,
          { story, files },
        );
      }
    }

    const lane = this.#laneOf(office);
    const entry = await journalOnce(lane, office, {
      kind: DROP_KIND,
      key,
      subject: story,
      target: { kind: lifecycle === "Draft" ? "draft" : "task" },
      releasesClaim: true,
    });
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
      office.immediate(() =>
        updateEntry(office, entry.opId, { state: "withdrawn" }, ctx.clock.now()),
      );
      throw error;
    }
    const at = ctx.clock.now();
    ctx.commit((): NewEntry[] => {
      const open = openPark(office, key);
      if (open !== null) {
        office.run(
          `update parks set resolved_at = $at, resolved_how = 'drop'
           where office_id = $office_id and park_id = $park and resolved_at is null`,
          { at, park: open.parkId },
        );
      }
      const removed = deriveStoryView({
        ...(view === null ? { key, story, title: "" } : factsOf(view)),
        lifecycle: "Removed",
      });
      return [
        {
          type: "story.state",
          key,
          delta: { story, key, from: lifecycle, to: "Removed", detail: ["dropped"] },
          view: removed,
        },
      ];
    });
    await flushQuietly(lane);
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
    const journaled = allEntries(office).some(
      (entry) => entry.key === key && entry.kind === DROP_KIND && OPEN_STATES.includes(entry.state),
    );
    if (!journaled || liveClaimOf(office, key) !== null || openPark(office, key) !== null) {
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

  /** Releases the claim: the worktree goes, the branch is kept or deleted as the drop asked. */
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
        ...(this.#deps.slots === undefined ? {} : { slots: this.#deps.slots }),
      },
      claim,
      { deleteBranch: args.deleteBranch },
    );
    if (!outcome.ok) throw notDropped(identity.story, closedPr, outcome.why, outcome.files);
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
    if (!outcome.ok) throw notDropped(identity.story, closedPr, outcome.why, outcome.files);
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

  #laneOf(office: OfficeHandle): OfficeLane {
    const lane = this.#deps.lane(office.officeId);
    if (lane === undefined) throw new Error(`The office ${office.officeId} has no backlog lane.`);
    return lane;
  }
}

/**
 * The error of a drop whose release or branch deletion failed. After the drop closed the story's PR
 * the error says so, since that PR stays closed while the story is not archived (DIPO-228).
 */
function notDropped(
  story: StoryId,
  closedPr: number | null,
  why: string,
  files: readonly string[],
): CommandError {
  const closed =
    closedPr === null ? "" : `PR #${closedPr} was closed and the story was not archived: `;
  return new CommandError(
    files.length > 0 ? DIRTY_WORKTREE : NOT_DROPPABLE,
    `${story} was not dropped: ${closed}${why}.${files.length > 0 ? ` Files: ${files.join(", ")}.` : ""}`,
    { story, files: [...files] },
  );
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

/** The open journal entry of the same kind for the story, else a new one (a re-run reuses it). */
async function journalOnce(
  lane: OfficeLane,
  office: OfficeHandle,
  op: LaneOp,
): Promise<JournalEntry> {
  const open = allEntries(office).find(
    (entry) =>
      entry.key === (op.key ?? null) && entry.kind === op.kind && OPEN_STATES.includes(entry.state),
  );
  return open ?? lane.journal(op);
}

/** Flushes the lane; a failed flush put its own notice on the office and leaves the op journaled. */
async function flushQuietly(lane: OfficeLane): Promise<void> {
  await lane.flush().catch((error: unknown) => {
    if (!(error instanceof LaneFlushError)) throw error;
  });
}

/**
 * The active stories (not Done, not removed, no drop pending) that list `story` among their
 * dependencies, by id. The dependencies are what the story index mirrored from `_base`.
 */
function activeDependents(office: OfficeHandle, identity: StoryIdentity): string[] {
  const dropping = new Set(
    allEntries(office)
      .filter((entry) => entry.kind === DROP_KIND && OPEN_STATES.includes(entry.state))
      .map((entry) => entry.key),
  );
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
