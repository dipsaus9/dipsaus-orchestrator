// `work.discard { story, note }` (DIPO-161; 0020 section 8 and its dirty-worktree option, 0005
// amendment of 2026-10-17: the waiting command path). It throws a story's work away and returns the
// story to Refined, so it must pass the Ready gate again. The client listed what is lost first
// (`story.losses` with `command: work.discard`) and asked for the story id typed out: the command
// is `irreversible`. It removes nothing that list did not show.
//
// From In Progress, In Review or Parked with a claim, in the order of 0010 section 2a:
// 1. An active run is stopped as `story.park` stops it; a worker host of the run that still runs
//    answers the retryable `run.hostAlive`, with nothing changed.
// 2. The lane-b op is journaled (status Refined, the F16 park removed), so the pending-op skip
//    covers the story at once. It applies only while the base status is not Done: lane b never
//    writes over a Done story, and a story the Backlog CLI reads Done in `_base` gets no op at all.
// 3. dipo's open story PR is closed with a comment naming the discard.
// 4. The claim is released (`discard`): the worktree removed with `--force`, the branch deleted
//    locally and on the remote when every commit on the remote tip is on the local branch or on the
//    base; a remote tip with other commits (someone pushed to it) keeps the remote branch with a
//    notice and the other steps go on. The port slot is freed.
// 5. One transaction: the run's open questions closed `ended`, an open park resolved `discard`, and
//    `story.state` to Refined unless the base says Done. The boxes of ended runs are deleted (0021
//    section 6), and the lane flushes.
// The leftovers of a story Done on the base through another branch (0020 section 10) are discarded
// the same way without a claim and with no lane-b write: their kept worktrees and branches go
// (`leftoverTargets`, exactly what the loss list shows) and the leftovers are cleared. A story whose
// PR head changed outside dipo (0019 section 9) is discarded like any other.
// Refused: a story whose PR in `story_prs` merged (`story.prMerged`), and a story with neither a
// claim nor leftovers that was never discarded (`story.notDiscardable`). A failure before the
// release withdraws the journal entry. A re-run after a crash between the release and the facts
// writes the facts it owes and answers `changed: true`; after a finished discard, `changed: false`.

import {
  type Lifecycle,
  type RunId,
  type StoryId,
  type StoryKey,
  type StoryView,
  workDiscard,
} from "@dipsaus-orchestrator/contract";
import type { z } from "zod";

import {
  allEntries,
  DISCARD_KIND,
  type JournalEntry,
  LaneFlushError,
  type LaneOp,
  OPEN_STATES,
  type OfficeLane,
} from "../backlog/lane";
import { updateEntry } from "../backlog/lane/journal";
import type { NewEntry } from "../changelog/log";
import { CommandError } from "../commands/errors";
import type {
  AsyncCommandContext,
  CommandOutcome,
  FeatureModule,
  FeatureRegistry,
} from "../commands/registry";
import type { OfficeHandle } from "../db/office";
import type { BacklogCli } from "../backlog/runner";
import type { OfficeGit } from "../git/office";
import { closeQuestion, openQuestions } from "../hooks/questions";
import { type CodeHost, CodeHostError } from "../platform/host";
import type { ProcessProbe } from "../platform/process";
import { openParkIds, resolvePark } from "../run/park";
import { activeRuns } from "../run/records";
import { hostAlive, workerHostsOf } from "../runs/worker-hosts";
import { findStoryPr, latestStoryPr, setStoryPrState } from "../story-pr/records";
import { deriveStoryView, storyView } from "../views/story";
import { decideDone } from "../worktree/done-check";
import {
  baseStatusOf,
  clearLeftovers,
  leftoverTargets,
  openLeftovers,
} from "../worktree/done-elsewhere";
import { type ClaimRecord, findClaim, liveClaimOf } from "../worktree/records";
import {
  type DiscardBranchOutcome,
  type LeftoverTargets,
  releaseForDiscard,
  removeLeftovers,
  repoOfPrUrl,
} from "../worktree/release";
import type { SlotTable } from "../worktree/slots";

import type { StoryIdentity } from "./keys";

/** The statuses a discard's lane-b write applies from; never from Done. */
export const DISCARDABLE_STATUSES = [
  "In Progress",
  "In Review",
  "Parked",
  "Ready",
  "Refined",
  "To Do",
];

export const NOT_DISCARDABLE = "story.notDiscardable";
export const PR_MERGED = "story.prMerged";
export const DISCARD_PR_NOT_CLOSED = "story.prNotClosed";
export const DISCARD_STORY_ACTIVE = "story.active";
/** 0005's retryable code: a worker host of the run still runs. */
export const DISCARD_HOST_ALIVE = "run.hostAlive";

/** `engine.notice` codes of a discard. */
export const DISCARD_NOTICES = {
  remoteKept: "discard.remoteBranchKept",
  remoteBranch: "discard.remoteBranch",
} as const;

/** The `story.park` of a running story a discard calls first, which stops its worker. */
export type DiscardStop = (
  ctx: AsyncCommandContext,
  args: { readonly story: string; readonly note: string },
) => Promise<unknown>;

export interface StoryDiscardDeps {
  readonly lane: (office: OfficeHandle["officeId"]) => OfficeLane | undefined;
  readonly git: (office: OfficeHandle["officeId"]) => OfficeGit | undefined;
  /** The code host the open story PR is closed on. */
  readonly host: Pick<CodeHost, "closePr">;
  readonly slots?: SlotTable;
  /** Reads whether a worker host of the claim's run still runs. */
  readonly probe: ProcessProbe;
  /** Stops an active run as `story.park` does; without it a running story is refused. */
  readonly stop?: DiscardStop;
  /** Checks and deletes the boxes of ended runs (0021 section 6); best effort. */
  readonly finishBoxes?: () => Promise<unknown>;
  /**
   * Reads the story's status in `_base`: a story Done there gets no backlog write and no Refined
   * state. Without it only the leftovers of a story Done elsewhere count as Done.
   */
  readonly cli?: BacklogCli;
}

type DiscardArgs = z.output<typeof workDiscard.args>;
type DiscardResult = { story: StoryId; key: StoryKey };

export class StoryDiscard {
  readonly #deps: StoryDiscardDeps;

  constructor(deps: StoryDiscardDeps) {
    this.#deps = deps;
  }

  /** `work.discard` on the waiting command path. */
  get feature(): FeatureModule {
    return {
      name: "stories/discard",
      register: (registry: FeatureRegistry) => {
        registry.addAsyncOfficeCommand({
          definition: workDiscard,
          handle: (ctx, args) => this.discard(ctx, args),
        });
      },
    };
  }

  async discard(
    ctx: AsyncCommandContext,
    args: DiscardArgs,
  ): Promise<CommandOutcome<DiscardResult>> {
    const office = ctx.office;
    const identity = ctx.stories.get(args.story);
    if (identity === undefined) throw new Error(`${args.story} was not resolved`);
    const { key, story } = identity;
    const result = { story, key };

    const pr = latestStoryPr(office, key);
    if (pr !== null && pr.state === "merged") {
      throw new CommandError(
        PR_MERGED,
        `The PR #${pr.number} of ${story} merged, so there is nothing to discard.`,
        { story, number: pr.number },
      );
    }

    let claim = liveClaimOf(office, key);
    const running = activeRuns(office).find((run) => run.kind === "story" && run.key === key);
    if (running !== undefined) {
      if (this.#deps.stop === undefined) {
        throw new CommandError(
          DISCARD_STORY_ACTIVE,
          `${story} is running; park it with \`dipo park ${story} --note <why>\` first, then discard it.`,
          { story },
        );
      }
      // The story ref as the command resolved it: `ctx.stories` is keyed by it.
      await this.#deps.stop(ctx, { story: args.story, note: `discarded: ${args.note}` });
      claim = liveClaimOf(office, key);
    }
    const git = this.#deps.git(office.officeId);
    if (git === undefined) throw new Error(`The office ${office.officeId} has no git attached.`);
    const leftovers = claim === null ? openLeftovers(office, key) : [];
    if (claim === null && leftovers.length === 0) {
      return this.#rerun(ctx, identity, git, args.note);
    }
    if (claim !== null) {
      const pid = await this.#liveHostPid(office, claim.runId);
      if (pid !== null) {
        throw new CommandError(
          DISCARD_HOST_ALIVE,
          `A worker host of ${story} still runs (pid ${pid}), so its worktree is in use. Discard it again in a moment, once the host has exited.`,
          { story, pid },
        );
      }
    }

    // A story Done on the base (its leftovers, or a claim the Done poll has not released yet) gets
    // no backlog write and keeps its state: Done is terminal (0020 section 10).
    const doneOnBase = claim === null || (await this.#isDone(office, git, story, claim));
    const lane = doneOnBase ? null : this.#lane(office);
    const entry = lane === null ? null : await journalOnce(lane, office, discardOp(key, story));
    const withdraw = () => {
      if (entry !== null) {
        office.immediate(() =>
          updateEntry(office, entry.opId, { state: "withdrawn" }, ctx.clock.now()),
        );
      }
    };
    // What the release removes: the claim, or exactly the leftovers the loss list showed.
    const targets = claim === null ? leftoverTargets(office, key) : null;
    let released: DiscardBranchOutcome;
    try {
      const closed = await this.#closePr(ctx, identity, args.note, claim === null);
      released = await this.#release(ctx, git, claim, targets);
      if (!released.ok) {
        const closedText = closed === null ? "" : `PR #${closed} was closed, but `;
        throw new CommandError(
          NOT_DISCARDABLE,
          `${story} was not discarded: ${closedText}${released.why}.${released.files.length > 0 ? ` Files: ${released.files.join(", ")}.` : ""}`,
          { story, files: [...released.files] },
        );
      }
    } catch (error) {
      withdraw();
      throw error;
    }
    this.#remoteNotices(ctx, identity, git, claim, released);
    this.#finishFacts(
      ctx,
      identity,
      claim?.runId ?? null,
      args.note,
      !doneOnBase,
      targets?.worktrees.map((tree) => tree.runId) ?? [],
    );
    await this.#deps.finishBoxes?.().catch(() => undefined);
    if (lane !== null) await flushQuietly(lane);
    return { result, changed: true };
  }

  /**
   * One transaction: the open questions of `runId` closed `ended`, the open park of `runId`
   * resolved `discard` (never a park of another run, such as a later hold), the leftovers of the
   * runs in `removed` cleared (only those the release removed), and with `toRefined` the
   * `story.state` to Refined. Returns whether it wrote anything.
   */
  #finishFacts(
    ctx: AsyncCommandContext,
    identity: StoryIdentity,
    runId: RunId | null,
    note: string,
    toRefined: boolean,
    removed: readonly RunId[],
  ): boolean {
    const office = ctx.office;
    const { key, story } = identity;
    const before = storyView(office, key);
    let wrote = false;
    ctx.commit((): NewEntry[] => {
      const at = ctx.clock.now();
      const entries: NewEntry[] = [];
      if (runId !== null) {
        for (const question of openQuestions(office, runId)) {
          if (!closeQuestion(office, question.questionId, "ended", at)) continue;
          entries.push({
            type: "question.closed",
            key,
            run: runId,
            delta: { question: question.questionId },
          });
        }
      }
      let parks = 0;
      for (const park of runId === null ? [] : openParkIds(office, key, runId)) {
        entries.push(...resolvePark(office, park, "discard", at));
        parks += 1;
      }
      const cleared = clearLeftovers(office, key, at, removed);
      if (toRefined) {
        const from: Lifecycle = before?.lifecycle ?? "Parked";
        entries.push({
          type: "story.state",
          key,
          delta: { story, key, from, to: "Refined", detail: [`${DISCARDED_DETAIL}${note}`] },
          view: deriveStoryView({
            ...(before === null ? { key, story, title: "" } : factsOf(before)),
            lifecycle: "Refined",
          }),
        });
      }
      wrote = entries.length > 0 || parks > 0 || cleared > 0;
      return entries;
    });
    return wrote;
  }

  /**
   * A story with neither a claim nor leftovers. After a discard whose release ran and whose facts
   * a crash left unwritten, the re-run writes the facts it owes (questions, park, `story.state`)
   * and answers `changed: true`; after a finished discard it answers `changed: false`. Anything
   * else has no work to discard.
   */
  async #rerun(
    ctx: AsyncCommandContext,
    identity: StoryIdentity,
    git: OfficeGit,
    note: string,
  ): Promise<CommandOutcome<DiscardResult>> {
    const office = ctx.office;
    const { key, story } = identity;
    const result = { story, key };
    const discarded = lastDiscardedClaim(office, key);
    const journaled = allEntries(office).some(
      (entry) =>
        entry.key === key && entry.kind === DISCARD_KIND && OPEN_STATES.includes(entry.state),
    );
    if (discarded !== null) {
      const stateOwed = journaled && !refinedWrittenSince(office, key, discarded.releasedAt ?? 0);
      // Only what the discarded run left open: a later park, such as a hold, is not owed.
      const factsOwed =
        openParkOfRun(office, key, discarded.runId) ||
        openQuestions(office, discarded.runId).length > 0;
      if (stateOwed || factsOwed) {
        const toRefined =
          stateOwed &&
          !(await this.#isDone(office, git, story, findClaim(office, discarded.runId)));
        this.#finishFacts(ctx, identity, discarded.runId, note, toRefined, []);
        await this.#deps.finishBoxes?.().catch(() => undefined);
        if (journaled) await flushQuietly(this.#lane(office));
        return { result, changed: true };
      }
    }
    const cleared =
      office.get<{ n: number }>(
        `select 1 as n from done_elsewhere where office_id = $office_id and key = $key
           and cleared_how = 'discard' limit 1`,
        { key },
      ) !== null;
    // The target state already: the work was discarded and nothing is owed.
    if (journaled || cleared || discarded !== null) {
      if (journaled) await flushQuietly(this.#lane(office));
      return { result, changed: false };
    }
    throw new CommandError(
      NOT_DISCARDABLE,
      `${story} has no claim and no leftovers, so there is no work to discard; drop it with \`dipo drop ${story}\` instead.`,
      { story },
    );
  }

  /**
   * True when the one Done check (`decideDone`, 0002) finds the story Done: the claim's story PR
   * as dipo recorded it merged, or the story Done in `_base` as the Backlog CLI reads it (no base
   * read without the CLI).
   */
  async #isDone(
    office: OfficeHandle,
    git: OfficeGit,
    story: string,
    claim: ClaimRecord | null,
  ): Promise<boolean> {
    const cli = this.#deps.cli;
    const baseStatus = cli === undefined ? null : (await baseStatusOf(git, cli, story)).status;
    const pr = claim === null ? null : findStoryPr(office, claim.runId);
    return decideDone({ claim, pr, baseStatus }) !== "notDone";
  }

  /** Releases the claim, or removes the leftovers of a story Done on the base. */
  async #release(
    ctx: AsyncCommandContext,
    git: OfficeGit,
    claim: ClaimRecord | null,
    targets: LeftoverTargets | null,
  ): Promise<DiscardBranchOutcome> {
    const deps = {
      officeId: ctx.office.officeId,
      office: ctx.office,
      git,
      clock: ctx.clock,
      ...(this.#deps.slots === undefined ? {} : { slots: this.#deps.slots }),
    };
    if (claim !== null) return releaseForDiscard(deps, claim);
    // Exactly what `story.losses` listed for `work.discard` (`leftoverTargets`).
    if (targets === null) throw new Error("a discard without a claim has its leftover targets");
    return removeLeftovers(deps, targets);
  }

  /** The notices of a remote branch kept or not deleted. */
  #remoteNotices(
    ctx: AsyncCommandContext,
    identity: StoryIdentity,
    git: OfficeGit,
    claim: ClaimRecord | null,
    outcome: DiscardBranchOutcome,
  ): void {
    if (!outcome.ok) return;
    const remote = git.settings.remote;
    const branch = claim?.branch ?? "<branch>";
    const entries: NewEntry[] = [];
    if (outcome.remoteKept !== null) {
      entries.push({
        type: "engine.notice",
        key: identity.key,
        delta: {
          level: "warn",
          code: DISCARD_NOTICES.remoteKept,
          text: `dipo kept the remote branch of ${identity.story} (${claim === null ? outcome.remoteKept : `${branch} at ${outcome.remoteKept}`}): its tip there holds commits that are neither on the branch dipo listed nor on the base, so someone else may have work on it. Delete it by hand once checked (\`git push ${remote} --delete ${branch}\`).`,
        },
      });
    }
    if (outcome.remoteProblem !== null) {
      entries.push({
        type: "engine.notice",
        key: identity.key,
        delta: {
          level: "warn",
          code: DISCARD_NOTICES.remoteBranch,
          text: `dipo could not delete the remote branch of ${identity.story}: ${outcome.remoteProblem}. Delete it by hand (\`git push ${remote} --delete ${branch}\`).`,
        },
      });
    }
    if (entries.length > 0) ctx.commit(() => entries);
  }

  /** Closes the story's open PR with a comment naming the discard; returns its number, or null. */
  async #closePr(
    ctx: AsyncCommandContext,
    identity: StoryIdentity,
    note: string,
    doneOnBase: boolean,
  ): Promise<number | null> {
    const office = ctx.office;
    const pr = latestStoryPr(office, identity.key);
    if (pr === null || pr.state !== "open") return null;
    const repo = repoOfPrUrl(pr.url);
    if (repo === null) {
      throw new CommandError(
        DISCARD_PR_NOT_CLOSED,
        `dipo could not tell which repository the PR ${pr.url} of ${identity.story} is on, so it did not close it. Nothing was discarded.`,
        { story: identity.story, url: pr.url },
      );
    }
    const comment = doneOnBase
      ? `Closed by dipo: the leftovers of ${identity.story} were discarded (work.discard): ${note}`
      : `Closed by dipo: the work of ${identity.story} was discarded (work.discard): ${note}. Its branch is deleted and the story returns to Refined, so this PR must not merge.`;
    try {
      await this.#deps.host.closePr(repo, pr.number, comment);
    } catch (error) {
      if (!(error instanceof CodeHostError)) throw error;
      throw new CommandError(
        DISCARD_PR_NOT_CLOSED,
        `dipo could not close PR #${pr.number} of ${identity.story}: ${error.message}. Nothing was discarded.`,
        { story: identity.story, number: pr.number },
      );
    }
    ctx.commit((): NewEntry[] => {
      setStoryPrState(office, pr.runId, { state: "closed", closedAt: ctx.clock.now() });
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

  async #liveHostPid(office: OfficeHandle, runId: RunId): Promise<number | null> {
    for (const host of workerHostsOf(office, runId)) {
      if (await hostAlive(host, this.#deps.probe)) return host.pid;
    }
    return null;
  }

  #lane(office: OfficeHandle): OfficeLane {
    const lane = this.#deps.lane(office.officeId);
    if (lane === undefined) throw new Error(`The office ${office.officeId} has no backlog lane.`);
    return lane;
  }
}

/** The `story.state` detail a discard writes, before its note. */
const DISCARDED_DETAIL = "discarded: ";

/** True when the story has an open park of the run `runId`. */
function openParkOfRun(office: OfficeHandle, key: StoryKey, runId: RunId): boolean {
  return (
    office.get<{ n: number }>(
      `select 1 as n from parks where office_id = $office_id and key = $key and run_id = $run
         and resolved_at is null limit 1`,
      { key, run: runId },
    ) !== null
  );
}

/** The story's latest claim `work.discard` released, or null. */
function lastDiscardedClaim(
  office: OfficeHandle,
  key: StoryKey,
): { readonly runId: RunId; readonly releasedAt: number | null } | null {
  const row = office.get<{ run_id: string; released_at: number | null }>(
    `select run_id, released_at from claims where office_id = $office_id and key = $key
       and release_reason = 'discard' order by released_at desc, run_id desc limit 1`,
    { key },
  );
  return row === null ? null : { runId: row.run_id as RunId, releasedAt: row.released_at };
}

/** True when a discard wrote the story's `story.state` to Refined at or after `since`. */
function refinedWrittenSince(office: OfficeHandle, key: StoryKey, since: number): boolean {
  return (
    office.get<{ n: number }>(
      `select 1 as n from change_log where office_id = $office_id and key = $key
         and type = 'story.state' and at >= $since and delta like $marker limit 1`,
      { key, since, marker: `%"to":"Refined"%${DISCARDED_DETAIL}%` },
    ) !== null
  );
}

/** The lane-b op of a discard: status Refined, the park record removed, never over Done. */
export function discardOp(key: StoryKey, story: string): LaneOp {
  return {
    kind: DISCARD_KIND,
    key,
    subject: story,
    target: { from: DISCARDABLE_STATUSES, status: "Refined", unset: ["park"] },
    releasesClaim: true,
  };
}

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

async function flushQuietly(lane: OfficeLane): Promise<void> {
  await lane.flush().catch((error: unknown) => {
    if (!(error instanceof LaneFlushError)) throw error;
  });
}
