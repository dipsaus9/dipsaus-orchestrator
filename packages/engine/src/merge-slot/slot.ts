// The office merge slot (0016 rule 2 and its amendment of 2026-10-22; 0010 section 7, Merge slot
// row; 0019 section 9; 0002 amendment: backlog-only PRs merge without the reviewer agent). One slot
// per office holds one PR at a time; story PRs and backlog PRs share it, first come first served by
// the time each became eligible: a story PR when its merge gate was approved (`story-slot.ts`,
// DIPO-150), a backlog PR when its last structural check passed.
//
// The occupant is persisted (`merge_slot`, `store.ts`): its PR, step, pushed head and attempt
// count, so a daemon restart continues with the same occupant at the same step, and every step is
// idempotent when it runs again. The row is deleted when the PR merges or leaves the slot.
//
// The guard (0016 rule 12, 0019 section 7): a PR labelled `autorelease: pending` is never merged by
// the engine, for any PR kind, checked before it enters and right before the host merge; a label of
// `mergeSlot.holdLabels` holds it until the label is gone. No engine code calls a deployment or
// environment API.
//
// A backlog PR whose last structural check passed (DIPO-35) enters the slot. Inside it:
//   1. merge `<remote>/<base>` into its branch unless the branch contains it (`SlotGit.syncBase`);
//      a conflict aborts the merge and the lane rebuilds the branch from the journal on a new
//      branch name, which opens a new PR and closes the old one (DIPO-34, DIPO-35);
//   2. push once, never forced;
//   3. wait for the office's `mergeSlot.requiredChecks` (`ci-ok` and `pr-title` by default, DIPO-133),
//      read every `polling.prStateSeconds`, while the PR is open,
//      at most `CHECKS_WAIT_MS` (also when the host cannot be read), then leave with a notice;
//   4. run the structural check again on the head it merges, and the label guard;
//   5. squash-merge on the host with `--match-head-commit`. A refusal after which the base has
//      moved goes back to step 1; after `MAX_MERGE_ATTEMPTS` refusals the PR stays open with an
//      `engine.notice`. A refusal for any other reason leaves it open with a notice too.
// After the merge the PR's journal entries whose commit is in the merged head are merged (so
// `pendingLaneOp` stops reporting their stories; any other is applied again on a new branch), the
// PR record is merged (DIPO-35's sync does not check it again), the blocks it fixed are cleared
// and its branch is deleted.
//
// While a backlog PR is in the slot the lane holds new operations (`holding`): they stay journaled
// and go to the next backlog PR after the merge, or onto the branch when the PR leaves the slot
// unmerged. A story PR in the slot holds nothing of the lane. A PR that left the slot unmerged stays
// out of it until its head changes; a backlog PR whose required checks failed comes back once they
// no longer fail (a re-run), one whose checks never reported once they pass. A notice that would
// repeat on every poll is shown once per PR, code and head or cause.
//
// Each git step is its own item of the office git queue; waiting for CI holds only the slot. Work
// of one office runs one tick at a time.
//
// With the office's PR-state poll (`prState`, DIPO-314) the slot's poll tick is part of each of its
// rounds, after the story-PR poll, instead of a timer of its own, and that tick reads a PR's state
// through the reads the round gave it, so a PR the story-PR poll read this round is not read
// again; a PR the tick merged is dropped from the round. Any other tick (a kick after a flush or a
// decision) and a read right after the slot's own merge attempt go to the host.

import type { Clock, OfficeId, RunId, StoryKey, TimerHandle } from "@dipsaus-orchestrator/contract";

import { openEntries, updateEntry } from "../backlog/lane/journal";
import type { OfficeLane } from "../backlog/lane/lane";
import type { CheckResult } from "../backlog/pr/check";
import { repoOfUrl } from "../backlog/pr/feature";
import { clearBlocks, closePrRecord, findPr, openPrs } from "../backlog/pr/records";
import { appendEntries, type NewEntry } from "../changelog/log";
import type { FeatureModule } from "../commands/registry";
import { OFFICE_DEFAULTS, type OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import type { Logger } from "../log/logger";
import { type CodeHost, CodeHostError, type PrReviewHost } from "../platform/host";
import type { PrStatePoll, PrStateReads } from "../platform/pr-state";

import { evaluateChecks, REQUIRED_CHECKS } from "./checks";
import { autoreleasePending, holdLabelsOn, type StoredMergeGate } from "./gates";
import { laneSlotGit, type SlotGit } from "./git";
import { enterSlot, leaveSlot, type SlotOccupant, slotOccupant, updateSlot } from "./store";
import {
  type StoryCandidate,
  StorySlot,
  type StorySlotContext,
  type StorySlotDeps,
} from "./story-slot";

/** The load step that starts the office's merge slot poll. */
export const MERGE_SLOT_STEP = "mergeSlot.watch";

/** Host merges a PR gets in one stay in the slot while the base keeps moving (0016 rule 2). */
export const MAX_MERGE_ATTEMPTS = 3;

/**
 * How long a PR may wait in the slot for its required checks (or for the host to answer about
 * them) before it leaves, so lane-b operations are never held without end: 30 minutes.
 */
export const CHECKS_WAIT_MS = 30 * 60_000;

/** `engine.notice` codes of the merge slot. */
export const SLOT_NOTICES = {
  entered: "mergeSlot.entered",
  merged: "mergeSlot.merged",
  rebuilt: "mergeSlot.rebuilt",
  baseMoved: "mergeSlot.baseMoved",
  refused: "mergeSlot.refused",
  checksFailed: "mergeSlot.checksFailed",
  pushFailed: "mergeSlot.pushFailed",
  checksStuck: "mergeSlot.checksStuck",
  checksUnreadable: "mergeSlot.checksUnreadable",
  closed: "mergeSlot.closed",
  failed: "mergeSlot.failed",
  held: "merge.held",
} as const;

/** What one tick of the slot did. */
export type SlotOutcome =
  /** No PR is in the slot and none may enter. */
  | "idle"
  /** A PR is in the slot, waiting for its required checks. */
  | "waiting"
  | "merged"
  /** The branch conflicted with the base and was handed to the lane for a rebuild. */
  | "rebuilt"
  /** The PR left the slot unmerged, with a notice. */
  | "left";

export interface MergeSlotDeps {
  readonly host: CodeHost;
  /** The structural check of the open backlog PR (DIPO-35 `BacklogPrs.recheck`). */
  readonly prs: { recheck(office: OfficeId, number: number): Promise<CheckResult> };
  readonly lane: (office: OfficeId) => OfficeLane | undefined;
  readonly offices: {
    get(office: OfficeId): OfficeHandle | undefined;
    config?(office: OfficeId): OfficeConfig | undefined;
  };
  readonly clock: Clock;
  /** The slot's git for a lane; the real `laneSlotGit` by default. */
  readonly git?: (lane: OfficeLane) => SlotGit;
  /**
   * The checks every PR waits for when the office config gives none (tests); the office's
   * `mergeSlot.requiredChecks` decides otherwise, and `REQUIRED_CHECKS` when neither does.
   */
  readonly requiredChecks?: readonly string[];
  /** How long a PR waits for its checks before it leaves; `CHECKS_WAIT_MS` by default. */
  readonly checksWaitMs?: number;
  /**
   * A backlog PR's labels, for the guard (0019 section 7). Without it a backlog PR's labels are
   * not read (tests); story PRs read theirs through `stories.labels`.
   */
  readonly labels?: Pick<PrReviewHost, "prLabels">;
  /** Story PRs in the slot (DIPO-150); without it the slot merges backlog PRs only. */
  readonly stories?: StorySlotDeps;
  readonly onChanged?: (office: OfficeId) => void;
  /** Gets each tick's outcome at debug level (idle at trace) and a failed poll or tick as a warning. */
  readonly logger?: Logger;
  /**
   * The office's one PR-state poll (DIPO-314): the slot ticks as part of its rounds, not on a timer
   * of its own, and reads PR state through it. Without it the slot keeps its own timer.
   */
  readonly prState?: Pick<PrStatePoll, "subscribe">;
}

type ParkReason =
  | "checksFailed"
  | "checksStuck"
  | "checkFailed"
  | "refused"
  | "baseMoved"
  | "closed"
  | "held";

interface OfficeSlot {
  busy: Promise<unknown>;
  /** Ticks queued or running. */
  pending: number;
  /** Backlog PRs that left the slot unmerged, with the head they left at. */
  readonly parked: Map<number, { readonly head: string; readonly reason: ParkReason }>;
  /** Story PRs that left the slot unmerged, by run, with the head they left at. */
  readonly left: Map<string, string>;
  /**
   * Notices that must not repeat, by `<PR or story>:<code>`, with the head or cause they were
   * given for: the same notice for the same subject, code and head or cause is shown once.
   */
  readonly noticed: Map<string, string>;
  clock: Clock;
  seconds: number;
  timer: TimerHandle | null;
  /** The reads of the PR-state round the running tick belongs to (DIPO-314), or null. */
  reads: PrStateReads | null;
}

/** A PR that may enter the slot, with the time it became eligible. */
type Candidate =
  | { readonly kind: "backlog"; readonly occupant: SlotOccupant; readonly eligibleAt: number }
  | { readonly kind: "story"; readonly story: StoryCandidate; readonly eligibleAt: number };

export class MergeSlot {
  readonly #deps: MergeSlotDeps;
  readonly #offices = new Map<OfficeId, OfficeSlot>();
  readonly #stories: StorySlot | null;
  #stopped = false;

  constructor(deps: MergeSlotDeps) {
    this.#deps = deps;
    this.#stories = deps.stories === undefined ? null : new StorySlot(deps.stories);
    deps.prState?.subscribe("merge-slot", (office, reads) => this.#polled(office, reads));
  }

  /** The tick of a PR-state round; skipped while a tick still runs, as the slot's own poll was. */
  async #polled(office: OfficeId, reads: PrStateReads): Promise<void> {
    const state = this.#offices.get(office);
    if (state === undefined || this.#deps.offices.get(office) === undefined) return;
    if (state.pending > 0) {
      this.#deps.logger?.debug("merge slot poll skipped: a tick still runs", { office });
      return;
    }
    await this.tick(office, reads);
  }

  /** How the running tick reads a PR's state: through its PR-state round, else the host. */
  #reads(office: OfficeId): Pick<PrStateReads, "viewPr" | "invalidate"> {
    return this.#offices.get(office)?.reads ?? this.#deps.host;
  }

  /** The branch of the backlog PR in the office's slot, or null; the lane holds operations meanwhile. */
  holding(office: OfficeId): string | null {
    const handle = this.#deps.offices.get(office);
    if (handle === undefined) return null;
    const occupant = slotOccupant(handle);
    return occupant?.kind === "backlog" ? occupant.branch : null;
  }

  /**
   * True when the merge gate `gate` holds for the PR head `head`: its own head, or one its verdict
   * carried to (`StorySlot.gateHolds`); only its own head without story PRs.
   */
  async gateHolds(office: OfficeHandle, gate: StoredMergeGate, head: string): Promise<boolean> {
    if (gate.head === head) return true;
    if (this.#stories === null) return false;
    return this.#stories.gateHolds(office.officeId as OfficeId, office, gate, head);
  }

  /** The PR number in the office's slot, or null. */
  occupant(office: OfficeId): number | null {
    const handle = this.#deps.offices.get(office);
    return handle === undefined ? null : (slotOccupant(handle)?.number ?? null);
  }

  /**
   * One step of the office's slot, after any tick already running: open the merge gates due, let
   * a PR in, or move the one in it on as far as it can go without waiting.
   */
  tick(office: OfficeId, reads?: PrStateReads): Promise<SlotOutcome> {
    const state = this.#stateOf(office);
    state.pending += 1;
    const step = () => {
      // A tick of a PR-state round reads through it (DIPO-314); any other reads the host.
      state.reads = reads ?? null;
      return this.#logged(office, state).finally(() => {
        state.reads = null;
        state.pending -= 1;
      });
    };
    const run = state.busy.then(step, step);
    state.busy = run.catch(() => undefined);
    return run;
  }

  /** Resolves once the office's running tick, if any, has finished. */
  async whenIdle(office: OfficeId): Promise<void> {
    await this.#offices.get(office)?.busy;
  }

  /**
   * DIPO-155's `SlotReentry`: a resumed `slot-refused` park lets its story into the slot again, with
   * a fresh per-stay count (a new occupant row), at the next tick it is eligible at. The park and
   * its lift each committed the task file on the branch and pushed it, so the story PR is first
   * updated to that pushed head (DIPO-324): the slot compares the host's head with the recorded
   * one, and a head it did not record keeps the story out as a hand change.
   */
  async reenter(office: OfficeId, run: { readonly runId: string }): Promise<void> {
    this.#offices.get(office)?.left.delete(run.runId);
    await this.#stories?.prSynced(office, run.runId as RunId).catch((error: unknown) => {
      this.#deps.logger?.warn("updating a re-entered story's PR to its head failed", {
        office,
        run: run.runId,
        reason: reasonOf(error),
      });
    });
    this.kick(office);
  }

  /** Starts a tick without waiting for it (after a flush, or a maintainer's merge decision). */
  kick(office: OfficeId): void {
    void this.tick(office).catch((error: unknown) => {
      this.#deps.logger?.warn("merge slot tick failed", { office, reason: reasonOf(error) });
    });
  }

  /** Ticks the office's slot every `seconds` (its `polling.prStateSeconds`) until it is forgotten. */
  watch(office: OfficeId, clock: Clock, seconds: number): void {
    const state = this.#stateOf(office);
    state.clock = clock;
    state.seconds = seconds;
    this.#schedule(office, state);
  }

  /** Stops every poll; ticks already running finish. */
  stop(): void {
    this.#stopped = true;
    for (const state of this.#offices.values()) this.#cancel(state);
  }

  /** The feature module whose load step starts the office's poll. */
  get feature(): FeatureModule {
    return {
      name: "merge-slot",
      register: (registry) => {
        registry.registerLoadStep(MERGE_SLOT_STEP, (ctx) => {
          // With the PR-state poll the slot ticks in its rounds (DIPO-314); it only needs its state.
          if (this.#deps.prState === undefined) {
            this.watch(ctx.officeId, ctx.clock, secondsOf(ctx.config));
          } else this.#stateOf(ctx.officeId);
          return { ok: true };
        });
      },
    };
  }

  // ---- the poll ------------------------------------------------------------------------------

  #schedule(office: OfficeId, state: OfficeSlot): void {
    if (this.#stopped || state.timer !== null || state.seconds <= 0) return;
    if (this.#offices.get(office) !== state) return;
    state.timer = state.clock.setTimeout(() => {
      state.timer = null;
      try {
        // Called on the directory itself: the daemon's is the `OfficeManager`, whose `config`
        // reads its own fields, so a detached `config` throws and ends the poll.
        const { offices } = this.#deps;
        if (offices.config !== undefined) state.seconds = secondsOf(offices.config(office));
        // A poll that comes while a tick still runs is skipped.
        if (state.pending === 0) this.kick(office);
        else this.#deps.logger?.debug("merge slot poll skipped: a tick still runs", { office });
      } catch (error) {
        this.#deps.logger?.warn("merge slot poll failed", { office, reason: reasonOf(error) });
      } finally {
        // The next poll is armed whatever this one did.
        this.#schedule(office, state);
      }
    }, state.seconds * 1000);
  }

  #cancel(state: OfficeSlot): void {
    if (state.timer !== null) state.clock.clearTimeout(state.timer);
    state.timer = null;
  }

  #stateOf(office: OfficeId): OfficeSlot {
    let state = this.#offices.get(office);
    if (state === undefined) {
      state = {
        busy: Promise.resolve(),
        pending: 0,
        parked: new Map(),
        left: new Map(),
        noticed: new Map(),
        clock: this.#deps.clock,
        seconds: 0,
        timer: null,
        reads: null,
      };
      this.#offices.set(office, state);
    }
    return state;
  }

  // ---- one tick ------------------------------------------------------------------------------

  /** One tick, its outcome logged at debug level (an idle one at trace, as it comes every poll). */
  async #logged(office: OfficeId, state: OfficeSlot): Promise<SlotOutcome> {
    const handle = this.#deps.offices.get(office);
    const before = handle === undefined ? null : (slotOccupant(handle)?.number ?? null);
    const outcome = await this.#tick(office, state);
    const after =
      handle === undefined || this.#deps.offices.get(office) === undefined
        ? null
        : (slotOccupant(handle)?.number ?? null);
    const pr = after ?? before;
    const fields = pr === null ? { office, outcome } : { office, outcome, pr };
    if (outcome === "idle") this.#deps.logger?.trace("merge slot tick", fields);
    else this.#deps.logger?.debug("merge slot tick", fields);
    return outcome;
  }

  async #tick(office: OfficeId, state: OfficeSlot): Promise<SlotOutcome> {
    const handle = this.#deps.offices.get(office);
    const lane = this.#deps.lane(office);
    if (handle === undefined) {
      // A forgotten office: its poll ends.
      this.#cancel(state);
      state.seconds = 0;
      if (this.#offices.get(office) === state) this.#offices.delete(office);
      return "idle";
    }
    if (lane === undefined && this.#stories === null) return "idle";
    const git = lane === undefined ? null : (this.#deps.git ?? laneSlotGit)(lane);
    const context = this.#storyContext(office, state, handle);
    let occupant: SlotOccupant | null = null;
    try {
      // The merge gates open whether or not the slot is free (0019 section 11).
      const stories =
        this.#stories === null || context === null ? [] : await this.#stories.candidates(context);
      occupant = slotOccupant(handle);
      if (occupant === null) {
        occupant = await this.#enter(office, state, handle, git, stories);
        if (occupant === null) return "idle";
      }
      if (occupant.kind === "story") {
        if (this.#stories === null || context === null) {
          this.#write(office, handle, () => leaveSlot(handle));
          return "left";
        }
        return await this.#stories.advance(context, occupant);
      }
      if (lane === undefined || git === null) return "idle";
      return await this.#advance(office, state, occupant, handle, lane, git);
    } catch (error) {
      const reason = reasonOf(error);
      const number = occupant?.number ?? 0;
      const what = occupant?.kind === "story" ? "story PR" : "backlog PR";
      this.#once(office, handle, state, `${number}`, SLOT_NOTICES.failed, reason, () =>
        notice(
          "error",
          SLOT_NOTICES.failed,
          `The merge slot could not move the ${what}${occupant === null ? "" : ` #${number}`} on: ${reason}. dipo tries again at the next poll.`,
        ),
      );
      if (lane !== undefined) await this.#release(handle, lane);
      else this.#write(office, handle, () => leaveSlot(handle));
      return "left";
    }
  }

  /** What the story steps get of this tick, or null without story PRs. */
  #storyContext(
    office: OfficeId,
    state: OfficeSlot,
    handle: OfficeHandle,
  ): StorySlotContext | null {
    if (this.#stories === null) return null;
    return {
      officeId: office,
      office: handle,
      host: this.#deps.host,
      prState: this.#reads(office),
      clock: this.#deps.clock,
      config: this.#deps.offices.config?.(office) ?? OFFICE_DEFAULTS,
      ...(this.#deps.checksWaitMs === undefined ? {} : { checksWaitMs: this.#deps.checksWaitMs }),
      once: (subject, code, value, make) =>
        this.#once(office, handle, state, subject, code, value, make),
      write: (fn) => this.#write(office, handle, () => [...fn()]),
      left: state.left,
      ...(this.#deps.logger === undefined ? {} : { logger: this.#deps.logger }),
    };
  }

  /** Lets the PR that became eligible first into the slot; null when none may enter. */
  async #enter(
    office: OfficeId,
    state: OfficeSlot,
    handle: OfficeHandle,
    git: SlotGit | null,
    stories: readonly StoryCandidate[],
  ): Promise<SlotOccupant | null> {
    const candidates: Candidate[] = stories.map((story) => ({
      kind: "story",
      story,
      eligibleAt: story.eligibleAt,
    }));
    const backlog = git === null ? null : await this.#pick(office, state, handle, git);
    if (backlog !== null) candidates.push(backlog);
    const first = candidates.toSorted((a, b) => a.eligibleAt - b.eligibleAt)[0];
    if (first === undefined) return null;
    const occupant: SlotOccupant =
      first.kind === "backlog"
        ? first.occupant
        : {
            kind: "story",
            number: first.story.number,
            repo: first.story.repo,
            branch: first.story.branch,
            runId: first.story.runId,
            phase: "close-out",
            head: null,
            attempts: 0,
            checksSince: null,
            syncMode: "onConflict",
            enteredAt: this.#deps.clock.now(),
          };
    this.#write(office, handle, () => enterSlot(handle, occupant));
    this.#deps.logger?.debug("merge slot entered", {
      office,
      pr: occupant.number,
      kind: occupant.kind,
    });
    const head = first.kind === "story" ? first.story.head : (occupant.head ?? "");
    const text =
      first.kind === "story"
        ? `The story PR #${occupant.number} entered the merge slot; other PRs of the office wait until it leaves.`
        : `The backlog PR #${occupant.number} entered the merge slot; new backlog changes wait until it leaves.`;
    const key = first.kind === "story" ? first.story.key : null;
    this.#once(office, handle, state, `${occupant.number}`, SLOT_NOTICES.entered, head, () =>
      notice("info", SLOT_NOTICES.entered, text, key),
    );
    return occupant;
  }

  /** The oldest open backlog PR whose last structural check passed and that may enter. */
  async #pick(
    office: OfficeId,
    state: OfficeSlot,
    handle: OfficeHandle,
    git: SlotGit,
  ): Promise<Candidate | null> {
    for (const pr of openPrs(handle)) {
      if (pr.check !== "passed") continue;
      const repo = repoOfUrl(pr.url);
      if (repo === null) continue;
      const head = await git.head(pr.branch);
      if (head === null) continue;
      const parked = state.parked.get(pr.number);
      if (parked !== undefined && parked.reason !== "held") {
        const recheckable = parked.reason === "checksFailed" || parked.reason === "checksStuck";
        if (parked.head === head && !recheckable) continue;
        if (parked.head === head) {
          // Red required checks come back once they no longer fail (a re-run); checks that never
          // reported come back once they pass.
          const checks = await this.#deps.host.requiredChecks(repo, pr.number).catch(() => null);
          const names = this.#namesOf(office);
          const verdict = checks === null ? null : evaluateChecks(checks, names).state;
          if (verdict === null || verdict === "failed") continue;
          if (parked.reason === "checksStuck" && verdict !== "passed") continue;
        }
      }
      // The label guard before the PR enters (0019 section 7); a held PR is asked again each poll.
      if (await this.#held(office, state, handle, repo, pr.number, head)) {
        state.parked.set(pr.number, { head, reason: "held" });
        continue;
      }
      state.parked.delete(pr.number);
      return {
        kind: "backlog",
        eligibleAt: pr.checkedAt ?? pr.updatedAt,
        occupant: {
          kind: "backlog",
          number: pr.number,
          repo,
          branch: pr.branch,
          runId: null,
          phase: "sync",
          head,
          attempts: 0,
          checksSince: null,
          syncMode: "onConflict",
          enteredAt: this.#deps.clock.now(),
        },
      };
    }
    return null;
  }

  /**
   * True when a label holds the backlog PR (`autorelease: pending`, or one of the office's hold
   * labels), with a notice once per head; false when no label host is wired.
   */
  async #held(
    office: OfficeId,
    state: OfficeSlot,
    handle: OfficeHandle,
    repo: string,
    number: number,
    head: string,
  ): Promise<boolean> {
    const host = this.#deps.labels;
    if (host === undefined) return false;
    const labels = await host.prLabels(repo, number);
    const config = this.#deps.offices.config?.(office) ?? OFFICE_DEFAULTS;
    const held = holdLabelsOn(labels, config.mergeSlot.holdLabels);
    if (held.length === 0) return false;
    const value = `${head}:${held.join(",")}`;
    this.#once(office, handle, state, `${number}`, SLOT_NOTICES.held, value, () =>
      notice(
        "info",
        SLOT_NOTICES.held,
        autoreleasePending(held)
          ? `The backlog PR #${number} carries "autorelease: pending", so dipo never merges it; merge it by hand on GitHub.`
          : `The backlog PR #${number} carries the hold label ${held.map((label) => `"${label}"`).join(", ")}; dipo merges it once the label is gone.`,
      ),
    );
    return true;
  }

  async #advance(
    office: OfficeId,
    state: OfficeSlot,
    occupant: SlotOccupant,
    handle: OfficeHandle,
    lane: OfficeLane,
    git: SlotGit,
  ): Promise<SlotOutcome> {
    let slot = occupant;
    const move = (change: Parameters<typeof updateSlot>[1]): void => {
      this.#write(office, handle, () => updateSlot(handle, change));
      slot = { ...slot, ...change };
    };
    for (;;) {
      if (slot.phase === "sync") {
        // Step 1: bring the branch up to date with the base.
        if (!(await git.fetch())) {
          // Offline: the slot lets go, so held operations are not stuck; the next poll retries.
          await this.#release(handle, lane);
          return "left";
        }
        const sync = await git.syncBase(slot.branch);
        if (sync.kind === "conflict") {
          const number = slot.number;
          this.#write(office, handle, () => {
            leaveSlot(handle);
            return [
              notice(
                "info",
                SLOT_NOTICES.rebuilt,
                `The backlog PR #${number} conflicts with the base; dipo rebuilds its operations from the journal on a new branch, opens a new PR and closes #${number}.`,
              ),
            ];
          });
          // The flush puts its own notice on the office when it fails.
          await lane.flush({ rebuild: slot.branch }).catch(() => undefined);
          return "rebuilt";
        }
        // Step 2: one push, never forced.
        const pushed = await git.push(slot.branch);
        if (!pushed.ok) {
          const number = slot.number;
          const branch = slot.branch;
          this.#once(office, handle, state, `${number}`, SLOT_NOTICES.pushFailed, sync.head, () =>
            notice(
              "warn",
              SLOT_NOTICES.pushFailed,
              `The merge slot could not push the backlog PR #${number} (${branch}): ${pushed.detail}. dipo tries again at the next poll.`,
            ),
          );
          await this.#release(handle, lane);
          return "left";
        }
        move({ head: sync.head, phase: "checks", checksSince: this.#deps.clock.now() });
      }

      const head = slot.head ?? "";
      const number = slot.number;
      // Step 3: wait for the required checks, while the PR is still open.
      let checks;
      try {
        const pr = await this.#reads(office).viewPr(slot.repo, number);
        const record = findPr(handle, number);
        if (pr.state === "merged" && record?.state === "open" && slot.phase === "merge") {
          // A merge this slot asked for before a restart, which the host took: finish it.
          break;
        }
        if (pr.state !== "open" || record?.state !== "open") {
          const now = pr.state !== "open" ? pr.state : (record?.state ?? "gone");
          this.#once(office, handle, state, `${number}`, SLOT_NOTICES.closed, head, () =>
            notice(
              "info",
              SLOT_NOTICES.closed,
              `The backlog PR #${number} left the merge slot: it is ${now} now, so dipo does not merge it.`,
            ),
          );
          state.parked.set(number, { head, reason: "closed" });
          await this.#release(handle, lane);
          return "left";
        }
        checks = await this.#deps.host.requiredChecks(slot.repo, number);
      } catch (error) {
        if (!(error instanceof CodeHostError)) throw error;
        const cause = error.message;
        this.#once(office, handle, state, `${number}`, SLOT_NOTICES.checksUnreadable, cause, () =>
          notice(
            "warn",
            SLOT_NOTICES.checksUnreadable,
            `The merge slot cannot read the state of the backlog PR #${number}: ${cause} dipo asks again at the next poll.`,
          ),
        );
        return this.#waitOrLeave(office, state, slot, handle, lane, ["the host's answer"]);
      }
      const verdict = evaluateChecks(checks, this.#namesOf(office));
      if (verdict.state === "pending") {
        return this.#waitOrLeave(office, state, slot, handle, lane, verdict.waiting);
      }
      if (verdict.state === "failed") {
        this.#write(office, handle, () => [
          notice(
            "warn",
            SLOT_NOTICES.checksFailed,
            `The backlog PR #${number} left the merge slot unmerged: its required checks ${verdict.failed.join(", ")} failed. dipo takes it in again when they pass after a re-run or when the PR changes.`,
          ),
        ]);
        state.parked.set(number, { head, reason: "checksFailed" });
        await this.#release(handle, lane);
        return "left";
      }

      // Step 4: the structural check again, on the head that merges. It notices its own failures.
      const result = await this.#deps.prs.recheck(office, number);
      const record = findPr(handle, number);
      if (record === null || record.checkedHead !== head) {
        // The branch moved under the slot: start again from step 1.
        move({ phase: "sync" });
        continue;
      }
      if (!result.passed) {
        state.parked.set(number, { head, reason: "checkFailed" });
        await this.#release(handle, lane);
        return "left";
      }
      // The label guard right before the host merge (0019 section 7).
      if (await this.#held(office, state, handle, slot.repo, number, head)) {
        state.parked.set(number, { head, reason: "held" });
        await this.#release(handle, lane);
        return "left";
      }

      // Step 5: squash-merge, only while the head is the one checked.
      try {
        move({ phase: "merge" });
        await this.#deps.host.squashMerge(slot.repo, number, {
          headSha: head,
          subject: record.title,
        });
      } catch (error) {
        if (!(error instanceof CodeHostError)) throw error;
        const attempts = slot.attempts + 1;
        move({ attempts, phase: "checks" });
        const host = await this.#deps.host.viewPr(slot.repo, number).catch(() => null);
        if (host?.state === "merged") break;
        const moved = (await git.fetch()) && !(await git.containsBase(slot.branch));
        if (!moved) {
          this.#write(office, handle, () => [
            notice(
              "warn",
              SLOT_NOTICES.refused,
              `The host refused to merge the backlog PR #${number}: ${error.message} It stays open; dipo takes it in again when it changes.`,
            ),
          ]);
          state.parked.set(number, { head, reason: "refused" });
          await this.#release(handle, lane);
          return "left";
        }
        if (attempts >= MAX_MERGE_ATTEMPTS) {
          this.#write(office, handle, () => [
            notice(
              "warn",
              SLOT_NOTICES.baseMoved,
              `The backlog PR #${number} stays open: base moved during merge ${MAX_MERGE_ATTEMPTS} times. dipo takes it in again when it changes.`,
            ),
          ]);
          state.parked.set(number, { head, reason: "baseMoved" });
          await this.#release(handle, lane);
          return "left";
        }
        move({ phase: "sync" });
        continue;
      }
      break;
    }
    // The round's copy of the PR is stale now (DIPO-314).
    this.#reads(office).invalidate?.(slot.repo, slot.number);
    await this.#merged(office, state, slot, handle, lane, git);
    return "merged";
  }

  /**
   * After the host merge: the PR's journal entries and record are merged, the blocks it fixed are
   * cleared, its branch is deleted, and the held operations go onto a new branch.
   */
  async #merged(
    office: OfficeId,
    state: OfficeSlot,
    slot: SlotOccupant,
    handle: OfficeHandle,
    lane: OfficeLane,
    git: SlotGit,
  ): Promise<void> {
    const head = slot.head ?? "";
    // Only operations whose commit is in the merged head merged; any other stays open, and the
    // lane applies it again on a new branch (its old branch is deleted below).
    const merged: number[] = [];
    let leftOut = false;
    for (const entry of openEntries(handle)) {
      if (entry.branch !== slot.branch) continue;
      if (entry.commit !== null && (await git.inHead(entry.commit, head))) {
        merged.push(entry.opId);
      } else {
        leftOut = true;
      }
    }
    const now = this.#deps.clock.now();
    this.#write(office, handle, () => {
      for (const opId of merged) updateEntry(handle, opId, { state: "merged" }, now);
      const touched: readonly StoryKey[] = findPr(handle, slot.number)?.touched ?? [];
      clearBlocks(handle, slot.number, touched, now);
      closePrRecord(handle, slot.number, "merged", now);
      return [
        notice(
          "info",
          SLOT_NOTICES.merged,
          `dipo squash-merged the backlog PR #${slot.number} after its required checks and the structural check passed.`,
        ),
      ];
    });
    for (const key of state.noticed.keys()) {
      if (key.startsWith(`${slot.number}:`)) state.noticed.delete(key);
    }
    await git.deleteBranch(slot.branch).catch(() => undefined);
    // An operation left out still names the deleted branch: flush now, so the lane applies it again
    // on a new branch instead of at the next backlog change.
    await this.#release(handle, lane, leftOut);
  }

  /**
   * Keeps waiting for the checks until `checksWaitMs` passed since the slot started waiting; then
   * the PR leaves the slot with a notice naming what it waited for, and stays out until its checks
   * pass or its head changes.
   */
  async #waitOrLeave(
    office: OfficeId,
    state: OfficeSlot,
    slot: SlotOccupant,
    handle: OfficeHandle,
    lane: OfficeLane,
    waiting: readonly string[],
  ): Promise<SlotOutcome> {
    const limit = this.#deps.checksWaitMs ?? CHECKS_WAIT_MS;
    const since = slot.checksSince ?? this.#deps.clock.now();
    if (this.#deps.clock.now() - since < limit) return "waiting";
    const head = slot.head ?? "";
    this.#once(office, handle, state, `${slot.number}`, SLOT_NOTICES.checksStuck, head, () =>
      notice(
        "warn",
        SLOT_NOTICES.checksStuck,
        `The backlog PR #${slot.number} left the merge slot unmerged: after ${Math.round(limit / 60_000)} minutes it still waits for ${waiting.join(", ")}. dipo takes it in again when its checks pass or when the PR changes.`,
      ),
    );
    state.parked.set(slot.number, { head, reason: "checksStuck" });
    await this.#release(handle, lane);
    return "left";
  }

  /** Lets go of the slot and applies the operations it held. */
  async #release(handle: OfficeHandle, lane: OfficeLane, flush = false): Promise<void> {
    handle.immediate(() => leaveSlot(handle));
    if (!flush && !openEntries(handle).some((entry) => entry.state === "pending")) return;
    // The flush puts its own notice on the office when it fails.
    await lane.flush().catch(() => undefined);
  }

  /** The check names the office's PRs wait for: its `mergeSlot.requiredChecks` (DIPO-133). */
  #namesOf(office: OfficeId): readonly string[] {
    return (
      this.#deps.offices.config?.(office)?.mergeSlot.requiredChecks ??
      this.#deps.requiredChecks ??
      REQUIRED_CHECKS
    );
  }

  /** Writes the notice unless this subject had it already for the same head or cause. */
  #once(
    office: OfficeId,
    handle: OfficeHandle,
    state: OfficeSlot,
    subject: string,
    code: string,
    value: string,
    make: () => NewEntry,
  ): void {
    const key = `${subject}:${code}`;
    if (state.noticed.get(key) === value) return;
    state.noticed.set(key, value);
    this.#write(office, handle, () => [make()]);
  }

  #write(office: OfficeId, handle: OfficeHandle, fn: () => NewEntry[] | void): void {
    const now = this.#deps.clock.now();
    const count = handle.immediate(() => {
      const entries = fn() ?? [];
      appendEntries(handle, entries, { at: now });
      return entries.length;
    });
    if (count > 0) this.#deps.onChanged?.(office);
  }
}

function notice(
  level: "info" | "warn" | "error",
  code: string,
  text: string,
  key: StoryKey | null = null,
): NewEntry {
  return { type: "engine.notice", ...(key === null ? {} : { key }), delta: { level, code, text } };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function secondsOf(config: OfficeConfig | undefined): number {
  return (config ?? OFFICE_DEFAULTS).polling.prStateSeconds;
}
