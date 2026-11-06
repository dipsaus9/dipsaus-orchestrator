// `work.run` (DIPO-48, DIPO-456; 0005, 0012, 0010, 0013, 0014, 0008): pick one Ready story from
// `origin/<base>` (or the named ones), decide at once which start and why, answer, and then claim
// each started story, record its run and launch its worker. `work.preview` (DIPO-74) is the same
// selection as a read that changes nothing.
//
// The decision answers at once (DIPO-456). `work.run` is a synchronous office command: it decides
// from the base as last read, which a background pass keeps (`refreshBase`: the statuses check,
// the Ready stories on `_base` and their pickup gate, read at office load and again whenever the
// story index read a new base commit; the story index's poll keeps the base fetched). It never waits for a fetch, a
// claim, a push, a box or an install; a command that names a story the office does not know yet
// reads it after the executor's story refresh (DIPO-104). What takes time runs after the answer, as the start of each
// started story, and every failure there parks nothing and leaves the story Ready with a notice
// (`run.startAborted`, or the claim's and the launch's own notices), or moves it to Refined when
// its pickup check fails.
//
// Order of the decision:
// 1. Refusals of the whole command, each with the predicate's message: an invalid configuration
//    (`config.invalid`, `configBlocksRuns`), the office's starts paused (`run.refused`, check
//    `plan-limit` or `adapter`, 0020; a run that names its stories goes on through an adapter
//    pause a launch check lifts, and repeats the launch checks, which lift it when they pass), a
//    base not read yet (`run.refused`, check `base`), statuses the base lacks (`run.refused`,
//    `officeStatusesReady`) and an unresolved verify (`run.refused`, `verifyResolved`). The daemon
//    answers the retryable `daemon.draining` while draining before the command reaches the engine.
// 2. Without `stories`, the candidates are the Ready stories on the base in pickup order; with
//    `stories`, only those, in the order given.
// 3. Each candidate not started is a skip: its status (`notReady`, `parked`, `notRunnable`), a
//    start already decided (`starting`), a live claim, a story PR recorded merged, a pending
//    lane-b operation or a failed backlog PR check (`notRunnable`), every one of the office's `caps.parallelRuns`
//    slots held by a running or starting story or owed to a waiting resume, fix round, conflict
//    hand-off or review first (`capacity`, with the limit in its detail, 0002, DIPO-142; a
//    session run takes no slot), a dependency not Done (`dependency`), or a failed pickup check
//    (`pickupCheckFailed`; after the answer the base is fetched, and the story moves to Refined
//    only when it still fails there, else a `run.checkedAgain` notice says it stays Ready). A call
//    starts its candidates in order while a slot is free, so it can start a story while others
//    run. A decided start holds its slot (`Places.reservePickup`) and is recorded as starting
//    (`run_starts`) in the command's transaction, with `work.phase setup` and `story.state`, so the
//    overview shows it in `setup` and the queue no longer lists it as Ready; its run row replaces
//    it, or its end clears it (`run.startAborted`). An office load clears the starts a daemon
//    restart cut short.
// 4. Before the decision the story contract is assembled (DIPO-47); `prompt.contractTooLarge`
//    is a failed pickup check, checked again on the fresh base the same way.
//
// The start of a decided story, after the answer:
// 5. The base is fetched and indexed, the run profile refreshed, and the story read again on the
//    fresh base. A story that can no longer start there (Done or merged elsewhere, a dependency or
//    its gate changed, verify unresolved, the fetch failed) is not claimed, and a
//    `run.startAborted` notice names the story and why. While the daemon drains, no start runs:
//    its slot and its row go with the same notice.
// 6. The claim (DIPO-38) runs the pickup re-check (the Ready gate in `pickup` mode, stored through
//    DIPO-71) first inside its git queue item. A failed re-check moves the story to Refined through
//    the backlog lane and emits `story.state` with the gate messages in `detail`.
// 7. A claimed story gets its run row (with the slot setup took), its developer agent (with the
//    engine-made session id), the configuration snapshot and the `setup` phase, and
//    `work.assigned` and `work.phase setup` in the same transaction.
// 8. With a launcher, the worker host starts and `work.phase build` follows; a failed setup or
//    launch check rolled the claim back in step 6 and put its own notice on the office (the story
//    stays Ready).
//
// Every run's developer works in its story's box (DIPO-240, 0008): the launcher makes the box
// whenever the daemon has box workers. `args.box` is accepted and changes nothing, so
// clients that still send it keep working.

import { relative } from "node:path";

import {
  type AgentId,
  type ConfigError,
  type OfficeErrorCode,
  type OfficeId,
  type Progress,
  RoleId,
  RunId,
  type SkipReason,
  StoryId,
  type StoryKey,
  type WorkRef,
  workPreview,
  workRun,
} from "@dipsaus-orchestrator/contract";
import type { z } from "zod";

import { appendEntries, type NewEntry } from "../changelog/log";
import { CommandError } from "../commands/errors";
import type {
  AsyncCommandContext,
  CommandContext,
  CommandOutcome,
  FeatureModule,
  ReadContext,
} from "../commands/registry";
import type { OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import type { BaseCheckout } from "../gate-decisions/feature";
import type { GateMode, GateResult } from "../gate/types";
import type { GitSession, OfficeGit } from "../git/office";
import { GitError } from "../git/runner";
import { background } from "../platform/background";
import { assembleContract, ContractTooLargeError } from "../prompts/contract";
import { recordPromptParts, recordPromptTexts } from "../prompts/parts";
import { promptStoryOf } from "../prompts/story";
import { recordAgent } from "../records/agents";
import { resolveStoryRef } from "../records/story-keys";
import { mergedStoryKeys } from "../records/story-prs";
import {
  clearRunStarts,
  deleteRunStart,
  insertRunStart,
  runStartOf,
  runStarts,
} from "../records/run-starts";
import { mapLimited, VIEW_CONCURRENCY } from "../stories/read";
import { PlanningRefusedError, StoryParseError } from "../story-store/errors";
import { parseFieldBlock } from "../story-store/fields/block";
import { readLabels } from "../story-store/fields/labels";
import type { PlanningHold, PlanningLane } from "../story-store/planning";
import type { StoryStore } from "../story-store/store";
import type { PlainTask } from "../story-store/story";
import { deriveStoryView, type GateFailureFact, storyView } from "../views/story";
import { withWorkViews, workView } from "../views/work";
import { PlanError } from "../workers/types";
import type { ClaimOutcome, ClaimRequest } from "../worktree/claim";
import { type ClaimRecord, liveClaimOf } from "../worktree/records";

import { recordRunCriteria } from "../records/criteria";
import { planRefusedText, type PreparedRun, type RunFacts, type RunLauncher } from "./launch";
import { markPhase } from "../ingest/markers";

import { PICKUP_START, placeTaken, type Places } from "../run-state/places";
import {
  currentProfileId,
  hasActiveRun,
  insertRun,
  recordConfigSnapshot,
} from "../records/run-records";
import { openDependencies, pickupOrder, READY_STATUS, statusSkip } from "../records/select";
import { type StartsPausedState, startsPausedRefusal } from "./starts-paused";

/** The role every M0 run starts with (0012 F12). */
export const DEVELOPER_ROLE = RoleId.parse("developer");

/** The status a failed pickup check moves a story back to (0012). */
export const REFINED_STATUS = "Refined";

/** The error code of a run refused by an office check (`details.check` names it). */
export const RUN_REFUSED = "run.refused" satisfies OfficeErrorCode;

/** The active-work check `office.forget` asks (DIPO-27). */
export const RUNS_CHECK = "runs";

/** The office load step that reads the base `work.run` decides from (DIPO-456). */
export const RUN_BASE_STEP = "run/base";

/** `engine.notice` codes of `work.run`. */
export const RUN_NOTICES = {
  notMovedToRefined: "run.notMovedToRefined",
  /** A story `work.run` answered as started that did not start (DIPO-456). */
  startAborted: "run.startAborted",
  /** A story answered as failing its pickup check that the fresh base did not move (DIPO-456). */
  checkedAgain: "run.checkedAgain",
} as const;

/** What the base holds for a run: active statuses and the views of the stories asked for. */
export interface BaseRead {
  /** The status of every active task on the base, by id, as `task list --plain` groups them. */
  readonly statuses: ReadonlyMap<string, string>;
  /** The views of the stories asked for (every Ready one without a list) that parsed. */
  readonly views: readonly PlainTask[];
  /** Ids asked for whose view did not parse; the pickup gate (R02) decides on them. */
  readonly unparsed: readonly string[];
  /** The `_base` checkout that was read. */
  readonly checkout: BaseCheckout;
}

/** How `work.run` reaches the office's base. */
export interface RunBase {
  /** Fetches the office's remote, when it has one; a failed fetch throws `git.fetchFailed`. */
  fetch(office: OfficeId): Promise<void>;
  /** Reads `ids` on `_base`, or every Ready story when `ids` is null. */
  read(office: OfficeId, ids: readonly string[] | null): Promise<BaseRead>;
  /** Why the planning lane holds the story from pickup (`StoryStore.planningHold`), or null. */
  planningHold(office: OfficeHandle, key: StoryKey): PlanningHold | null;
}

export interface RunOffices {
  get(office: OfficeId): OfficeHandle | undefined;
  config(office: OfficeId): OfficeConfig | undefined;
  configHash(office: OfficeId): string | undefined;
  configBlocksRuns(office: OfficeId): readonly ConfigError[];
}

/** The part of the planning lane `work.run` uses to move a story back to Refined. */
export type RunLane = Pick<PlanningLane, "toRefined" | "flush">;

export interface WorkRunDeps {
  readonly offices: RunOffices;
  readonly base: RunBase;
  /**
   * One story index pass (DIPO-32), and one story read again on its branch right after its claim
   * commit (DIPO-56), so the story views say In Progress at once.
   */
  readonly stories: {
    indexStories(office: OfficeId): Promise<unknown>;
    refreshStory?(office: OfficeId, key: StoryKey): Promise<unknown>;
    /**
     * The `_base` commit the story index last read (`StoryIndex.lastPass`), or null: the base
     * `work.run` decides from is read again when it moves (DIPO-456).
     */
    baseSha?(office: OfficeId): string | null;
    /**
     * The story refresh (`StoryIndex.refresh`, DIPO-104): a fetch and an index pass, shared with
     * one already under way. The base is read again after it when a command names a story the
     * office does not know yet (DIPO-456).
     */
    refresh?(office: OfficeId): Promise<void>;
  };
  /** The run profile (DIPO-72): refreshed before each claim, then its verify refusal read. */
  readonly profiles: {
    ensureFreshProfile(office: OfficeId): Promise<unknown>;
    verifyResolved(office: OfficeHandle): string | null;
  };
  /** `officeStatusesReady` (DIPO-36): the refusal while the base lacks the run statuses. */
  readonly statuses: (office: OfficeId) => Promise<string | null>;
  /** The office's starts paused (0020, `StartsPaused.state`): no new run starts while it holds. */
  readonly startsPaused: (office: OfficeId) => StartsPausedState | null;
  readonly claims: { claim(office: OfficeId, request: ClaimRequest): Promise<ClaimOutcome> };
  readonly gates: {
    recordGateDecision(
      office: OfficeId,
      key: StoryKey,
      mode: GateMode,
      checkout?: BaseCheckout,
      session?: GitSession,
    ): Promise<{ readonly passed: boolean; readonly result: GateResult }>;
    /** The gate evaluated on `_base` without storing it (`work.preview`, the base pass). */
    checkGate?(office: OfficeId, story: StoryId, mode: GateMode): Promise<GateResult>;
  };
  readonly lane: (office: OfficeId) => RunLane | undefined;
  /**
   * Setup, the prompts, the launch checks and the worker start of a claimed run (DIPO-74). Without
   * it a claimed run stops at the `setup` phase with no worker, as DIPO-48 left it.
   */
  readonly launcher?: RunLauncher;

  /**
   * The office's slots (DIPO-208, DIPO-314): a decided start holds one through `reservePickup`
   * until its run row is in. Without them the slots are counted from the office's runs and the
   * starts decided here, as the tests of one run do.
   */
  readonly places?: Partial<Pick<Places, "reservePickup" | "slotTaken">>;
  /** The start after the answer appended entries outside the command; subscribers catch up. */
  readonly onChanged?: (office: OfficeId) => void;
  /**
   * Counts the start after the answer as the daemon's pending work, so a drain waits for it
   * (`DaemonLifecycle.beginWork`); returns its end, or null while draining.
   */
  readonly beginWork?: () => (() => void) | null;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

type Args = z.output<typeof workRun.args>;
type Result = z.input<typeof workRun.result>;
type Started = Result["started"][number];
type Skipped = Result["skipped"][number];
/** Why a candidate did not start, with the detail of a `capacity` skip. */
type Skip = Pick<Skipped, "reason" | "detail">;

type PreviewArgs = z.output<typeof workPreview.args>;
type Preview = z.input<typeof workPreview.result>;

/** What the claim of a candidate needs, once every check that writes nothing passed. */
interface Startable {
  readonly view: PlainTask;
  readonly fields: ReturnType<typeof parseFieldBlock>["fields"];
  readonly branch: string;
  readonly tier: string;
  readonly caps: OfficeConfig["tiers"]["S"];
  readonly taskFile: string;
}

interface Candidate {
  readonly story: StoryId;
  readonly key: StoryKey;
}

/** What one candidate's check works from. */
interface CheckInput {
  readonly candidate: Candidate;
  readonly status: string | undefined;
  readonly view: PlainTask | undefined;
  readonly unparsed: boolean;
  readonly checkout: BaseCheckout;
  /** Why no slot is free for a new pickup (`slotsFullText`), or null. */
  readonly full: string | null;
  readonly config: OfficeConfig;
}

/** What one decided start works from after the answer. */
interface StartInput {
  readonly candidate: Candidate;
  readonly config: OfficeConfig;
  readonly configHash: string;
  readonly runId: RunId;
  readonly agent: AgentId;
}

/**
 * The base `work.run` decides from (DIPO-456): what the background pass read, as last fetched.
 * `refusal` is the error of the whole command the pass found (the statuses check, a base that
 * could not be read); `gates` holds the pickup gate of each Ready story read (none without
 * `checkGate`), stored nowhere. `complete` is false when a gate could not be evaluated (at office
 * load the configuration may not be in force yet): the claim's own re-check then decides, and the
 * next change of the office reads the base again.
 */
interface BaseSnapshot {
  readonly sha: string | null;
  readonly read: BaseRead | null;
  readonly refusal: CommandError | null;
  readonly gates: ReadonlyMap<string, GateResult>;
  readonly complete: boolean;
}

/** The background pass of one office: the one running, and whether another one is owed. */
interface BasePass {
  running: Promise<void> | null;
  again: boolean;
}

/** Inside the run's transaction: the developer agent with the engine-made session id (0007). */
function recordDeveloper(
  handle: OfficeHandle,
  input: {
    readonly runId: RunId;
    readonly agent: AgentId;
    readonly caps: OfficeConfig["tiers"]["S"];
    readonly prepared: PreparedRun | null;
    readonly at: number;
  },
): void {
  const { prepared, caps } = input;
  recordAgent(
    handle,
    {
      agentId: input.agent,
      runId: input.runId,
      role: DEVELOPER_ROLE,
      model: caps.model,
      effort: prepared === null ? null : caps.effort,
      sessionId: prepared === null ? null : prepared.spec.session.id,
      startedAt: input.at,
    },
    false,
  );
}

/** Inside the run's transaction: what the launcher prepared, for the prompt records. */
function recordPrepared(
  handle: OfficeHandle,
  input: {
    readonly branch: string;
    readonly runId: RunId;
    readonly agent: AgentId;
    readonly prepared: PreparedRun;
    readonly config: OfficeConfig;
    readonly clock: AsyncCommandContext["clock"];
    readonly at: number;
  },
): void {
  const { runId, agent, prepared, clock } = input;
  // The prompt parts of the session's text, measured for the run (0014).
  recordPromptParts(handle, runId, agent, prepared.parts, clock);
  // The prompt text itself, with `privacy.storePrompts` on (DIPO-137).
  recordPromptTexts(handle, runId, agent, prepared.texts, input.config, clock);
}

/** Why a run without named stories starts no second one, though a slot is free. */
export const ONE_STORY =
  "a run without story ids starts one story; name the stories to start more at once";

/** Why `work.preview` skips the candidates after the story it shows. */
const ONE_PREVIEWED = "the preview shows the first story a run starts";

/** Why `work.run` refuses while the base it decides from has not been read yet (DIPO-456). */
export const BASE_NOT_READ =
  "dipo has not read the office's base yet; it is reading it now, so send the run again in a moment";

/** Why a story the decision started did not start on the fresh base, by skip reason (DIPO-456). */
const ABORTED_BECAUSE: Readonly<Record<string, string>> = {
  notReady: "it is no longer Ready on the base",
  parked: "it is parked on the base",
  notRunnable:
    "it can no longer start (not on the base, Done or merged, claimed, or a backlog change for it is pending)",
  dependency: "a dependency is no longer Done on the base",
  capacity: "no run slot is free",
  pickupCheckFailed: "it failed its pickup check on the base and goes back to Refined",
};

/** `git.fetchFailed` and other git refusals as command errors; anything else as it is. */
function commandErrorOf(error: unknown): unknown {
  if (error instanceof GitError) return new CommandError(error.code, error.message, error.details);
  return error;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * True when a run that names its stories goes on through the office's starts paused: an adapter
 * pause its launch checks lift when they pass (DIPO-43, DIPO-74); never a sticky one (DIPO-271) or
 * a plan limit.
 */
function repeatsChecks(
  paused: StartsPausedState,
  named: boolean,
  deps: Pick<WorkRunDeps, "launcher">,
): boolean {
  return (
    named &&
    deps.launcher !== undefined &&
    paused.reason === "adapter" &&
    paused.pause?.liftedBy === undefined
  );
}

function refused(office: OfficeId, check: string, message: string): CommandError {
  return new CommandError(RUN_REFUSED, message, { office, check });
}

/** The skip of a check result that is a reason, with the capacity detail when it has one. */
function skipOf(reason: SkipReason, full: string | null): Skip {
  return reason === "capacity" && full !== null ? { reason, detail: [full] } : { reason };
}

export class WorkRun {
  readonly #deps: WorkRunDeps;
  /** The base each office's runs decide from (DIPO-456). */
  readonly #snapshots = new Map<OfficeId, BaseSnapshot>();
  readonly #passes = new Map<OfficeId, BasePass>();
  /** The starts and base passes still under way, for `settled`. */
  readonly #inflight = new Set<Promise<unknown>>();

  constructor(deps: WorkRunDeps) {
    this.#deps = deps;
  }

  /** Resolves once every start decided so far and every base pass has ended (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled(this.#inflight);
  }

  /** The keys of the office's stories decided to start whose run row is not in yet. */
  starting(office: OfficeId): readonly string[] {
    const handle = this.#deps.offices.get(office);
    return handle === undefined ? [] : runStarts(handle).map((start) => start.key);
  }

  /**
   * Reads the base `work.run` decides from again, after any pass under way; calls while one runs
   * are coalesced into one more. Never throws.
   */
  refreshBase(office: OfficeId): Promise<void> {
    let pass = this.#passes.get(office);
    if (pass === undefined) {
      pass = { running: null, again: false };
      this.#passes.set(office, pass);
    }
    pass.again = true;
    if (pass.running === null) {
      const state = pass;
      const running = (async () => {
        // After the caller's own transaction.
        await Promise.resolve();
        try {
          while (state.again) {
            state.again = false;
            await this.#readBase(office);
          }
        } finally {
          state.running = null;
        }
      })();
      state.running = running;
      this.#track(running);
    }
    return pass.running ?? Promise.resolve();
  }

  /**
   * Reads the base again when the story index read a commit the snapshot was not read at (after
   * every change of the office). An incomplete snapshot is read again by the next run and after a
   * configuration reload, not at every change. Never throws.
   */
  baseChanged(office: OfficeId): void {
    // Not loaded, or still loading: its load step reads the base.
    if (this.#deps.offices.get(office) === undefined) return;
    const snapshot = this.#snapshots.get(office);
    const sha = this.#deps.stories.baseSha?.(office) ?? null;
    if (snapshot !== undefined && snapshot.sha === sha) return;
    // Coalesced with a pass under way into one more after it.
    void this.refreshBase(office);
  }

  /** One base pass: the statuses check, the Ready stories on `_base` and their pickup gate. */
  async #readBase(office: OfficeId): Promise<void> {
    const deps = this.#deps;
    let sha: string | null = null;
    let snapshot: BaseSnapshot;
    try {
      sha = deps.stories.baseSha?.(office) ?? null;
      const statuses = await deps.statuses(office);
      const read = await deps.base.read(office, null);
      const gates = new Map<string, GateResult>();
      let complete = true;
      const check = deps.gates.checkGate;
      // Without a configuration in force the gate cannot run: the claim's re-check decides.
      const usable =
        deps.offices.config(office) !== undefined &&
        deps.offices.configBlocksRuns(office).length === 0;
      if (check !== undefined && !usable) complete = false;
      if (check !== undefined && usable) {
        for (const view of read.views) {
          const result = await check
            .call(deps.gates, office, StoryId.parse(view.id), "pickup")
            .catch(() => null);
          if (result === null) complete = false;
          else gates.set(view.id, result);
        }
      }
      snapshot = {
        sha,
        read,
        refusal: statuses === null ? null : refused(office, "statuses", statuses),
        gates,
        complete,
      };
    } catch (error) {
      const thrown = commandErrorOf(error);
      snapshot = {
        sha,
        read: null,
        refusal:
          thrown instanceof CommandError
            ? thrown
            : new CommandError(
                "backlog.unreadable",
                `dipo could not read the office's base: ${messageOf(error)}`,
                { office },
              ),
        gates: new Map(),
        complete: false,
      };
    }
    this.#snapshots.set(office, snapshot);
  }

  #track(job: Promise<unknown>): void {
    this.#inflight.add(job);
    void job.then(
      () => this.#inflight.delete(job),
      () => this.#inflight.delete(job),
    );
  }

  /**
   * `work.run`: decides at once from the base as last read (steps 1 to 4) and answers; each
   * started story's claim and launch run after the answer (`#start`).
   */
  run(ctx: CommandContext, args: Args): CommandOutcome<Result> {
    const deps = this.#deps;
    const handle = ctx.office;
    const office = handle.officeId;
    const blocks = deps.offices.configBlocksRuns(office);
    const config = deps.offices.config(office);
    const configHash = deps.offices.configHash(office);
    if (blocks.length > 0 || config === undefined || configHash === undefined) {
      const why =
        blocks.length > 0
          ? blocks.map((error) => error.message).join("; ")
          : "the office has no valid configuration yet";
      throw new CommandError(
        "config.invalid",
        `New runs are refused until \`dipo office reload-config\` reads a valid configuration: ${why}`,
        { office },
      );
    }
    // The office's starts paused refuses the run (0020). A run that names its stories is the
    // explicit run that repeats the launch checks (DIPO-43, DIPO-74), so an adapter pause they lift
    // when they pass lets it go on; a sticky one (DIPO-271: the box token) and a plan limit do not.
    const paused = deps.startsPaused(office);
    if (paused !== null && !repeatsChecks(paused, args.stories !== undefined, deps)) {
      throw startsPausedRefusal("New runs are refused", paused, { office });
    }

    const snapshot = this.#snapshots.get(office);
    if (snapshot === undefined || snapshot.read === null) {
      void this.refreshBase(office);
      if (snapshot?.refusal != null) throw snapshot.refusal;
      throw refused(office, "base", BASE_NOT_READ);
    }
    if (snapshot.refusal !== null) {
      // The next run decides from a base read again.
      void this.refreshBase(office);
      throw snapshot.refusal;
    }
    const verify = deps.profiles.verifyResolved(handle);
    if (verify !== null) throw refused(office, "verify", verify);
    // A gate the pass could not evaluate: the claim's re-check decides this time.
    if (!snapshot.complete) void this.refreshBase(office);

    const read = snapshot.read;
    const candidates: Candidate[] =
      args.stories === undefined
        ? pickupOrder(read.views).flatMap((view) => {
            const resolved = resolveStoryRef(handle, view.id);
            return resolved.ok ? [{ story: resolved.story, key: resolved.key }] : [];
          })
        : args.stories.map((ref) => {
            const identity = ctx.stories.get(ref);
            if (identity === undefined) throw new Error(`${ref} was not resolved`);
            return identity;
          });
    return {
      result: this.#decideEach(ctx, snapshot, read, candidates, {
        config,
        configHash,
        oneStory: args.stories === undefined,
      }),
    };
  }

  /**
   * Decides the candidates in order (step 3 on): every named story while a slot is free, or the
   * first startable one when `oneStory`. Each started story holds its slot from here; its start,
   * and the move to Refined of a story whose pickup check failed, run after the answer.
   */
  #decideEach(
    ctx: CommandContext,
    snapshot: BaseSnapshot,
    read: BaseRead,
    candidates: readonly Candidate[],
    run: { readonly config: OfficeConfig; readonly configHash: string; readonly oneStory: boolean },
  ): { started: Started[]; skipped: Skipped[] } {
    const { config, configHash, oneStory } = run;
    const handle = ctx.office;
    const office = handle.officeId;
    const views = new Map(read.views.map((view) => [view.id, view]));
    const started: Started[] = [];
    const skipped: Skipped[] = [];
    // What runs after the answer: started only once every candidate is decided.
    const after: { job: () => Promise<void>; draining?: () => void }[] = [];
    const releases: (() => void)[] = [];
    try {
      for (const candidate of candidates) {
        const full =
          this.#slotTaken(handle, config) ?? (oneStory && started.length > 0 ? ONE_STORY : null);
        const checked = this.#precheck(handle, {
          candidate,
          status: read.statuses.get(candidate.story),
          view: views.get(candidate.story),
          unparsed: read.unparsed.includes(candidate.story),
          checkout: read.checkout,
          full,
          config,
        });
        if (typeof checked === "string" && checked !== "gate") {
          skipped.push({ ...candidate, ...skipOf(checked, full) });
          continue;
        }
        if (typeof checked === "object" && "tooLarge" in checked) {
          skipped.push({ ...candidate, reason: "pickupCheckFailed" });
          after.push({
            job: () => this.#refineOnFreshBase(this.#afterAnswer(ctx), candidate, config),
          });
          continue;
        }
        const gate = snapshot.gates.get(candidate.story);
        if (checked === "gate" || (gate !== undefined && !gate.passed)) {
          // The gate's answer on the base as read; the stored decision and the move to Refined
          // follow after the answer on the base as it is then.
          if (checked === "gate" && gate?.passed === true) {
            skipped.push({ ...candidate, reason: "notRunnable" });
            continue;
          }
          // The gate messages come with the move to Refined (`story.state`), as before.
          skipped.push({ ...candidate, reason: "pickupCheckFailed" });
          after.push({
            job: () => this.#refineOnFreshBase(this.#afterAnswer(ctx), candidate, config),
          });
          continue;
        }
        // Only what the claim needs is left here.
        if (typeof checked !== "object") continue;
        const runId = RunId.parse(ctx.ids.next("run"));
        const agent = ctx.ids.next("agt") as AgentId;
        // From the decision until the run row the start holds its slot (DIPO-314, DIPO-456).
        const release = this.#hold(office, runId, candidate);
        releases.push(release);
        this.#recordStart(ctx, candidate, { runId, agent, tier: checked.tier, caps: checked.caps });
        started.push({ story: candidate.story, key: candidate.key, run: runId });
        const input: StartInput = { candidate, config, configHash, runId, agent };
        const later = this.#afterAnswer(ctx);
        after.push({
          job: () => this.#start(ctx, input, release),
          // Draining: the start never runs; its slot and its row go, with a notice.
          draining: () => {
            release();
            this.#ended(
              later,
              candidate,
              runId,
              "the daemon is draining, so it starts nothing new",
            );
          },
        });
      }
    } catch (error) {
      for (const release of releases) release();
      throw error;
    }
    for (const job of after) this.#later(office, job);
    return { started, skipped };
  }

  /**
   * Inside the command's transaction: the decided start's row, and the entries that show it in
   * `setup` and move the story out of Ready in the queue (DIPO-456).
   */
  #recordStart(
    ctx: CommandContext,
    candidate: Candidate,
    start: {
      readonly runId: RunId;
      readonly agent: AgentId;
      readonly tier: string;
      readonly caps: OfficeConfig["tiers"]["S"];
    },
  ): void {
    const handle = ctx.office;
    insertRunStart(handle, {
      runId: start.runId,
      key: candidate.key,
      story: candidate.story,
      agent: start.agent,
      tier: start.tier,
      model: start.caps.model,
      loopCap: start.caps.loops,
      startedAt: ctx.now,
    });
    const work = workView(handle, start.runId);
    // The phase with its view; `work.assigned` comes with the run row, once.
    if (work !== null) {
      ctx.emit({
        type: "work.phase",
        key: candidate.key,
        run: start.runId,
        delta: { work: work.work, phase: "setup", progress: work.progress },
        view: work,
      });
    }
    const story = storyView(handle, candidate.key);
    if (story !== null) {
      ctx.emit({
        type: "story.state",
        key: candidate.key,
        delta: {
          story: candidate.story,
          key: candidate.key,
          from: story.lifecycle,
          to: story.lifecycle,
        },
        view: story,
      });
    }
  }

  /**
   * Holds a slot of the office for a decided start (`Places.reservePickup`); the release may be
   * called more than once.
   */
  #hold(office: OfficeId, runId: RunId, candidate: Candidate): () => void {
    const slot = this.#deps.places?.reservePickup?.(office, runId, candidate.story) ?? null;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      slot?.();
    };
  }

  /**
   * Runs `job` after the answer: after the command's transaction, counted as the daemon's pending
   * work, its failures logged, and the office's subscribers told at its end. While the daemon
   * drains, `draining` runs instead (nothing for a job without one).
   */
  #later(
    office: OfficeId,
    later: { readonly job: () => Promise<void>; readonly draining?: () => void },
  ): void {
    const end = this.#deps.beginWork === undefined ? () => undefined : this.#deps.beginWork();
    const done = background(
      async () => {
        await Promise.resolve();
        if (end === null) later.draining?.();
        else await later.job();
      },
      {
        failed: "a start after work.run's answer failed",
        fields: { office },
        log: this.#deps.warn,
        settled: () => {
          end?.();
          this.#deps.onChanged?.(office);
        },
      },
    );
    this.#track(done);
  }

  /**
   * The checks of one candidate that write nothing (step 3 up to the contract): a skip reason,
   * `gate` when only the pickup gate can say what is wrong, or what the claim needs. `own` is the
   * start itself when it checks again on the fresh base.
   */
  #precheck(
    handle: OfficeHandle,
    c: CheckInput,
    own: boolean = false,
  ): SkipReason | "gate" | Startable | { readonly tooLarge: string } {
    const { story, key } = c.candidate;
    // Not on the base: a draft, or a story archived or completed since the last index.
    if (c.status === undefined) return "notRunnable";
    const byStatus = statusSkip(c.status);
    if (byStatus !== null) return byStatus;
    if (liveClaimOf(handle, key) !== null) return "notRunnable";
    // A start decided and not ended yet (DIPO-456).
    if (!own && runStartOf(handle, key) !== null) return "starting";
    // Merged, while the base read may still say Ready until its next fetch (DIPO-445).
    if (mergedStoryKeys(handle).includes(key)) return "notRunnable";
    if (c.full !== null) return "capacity";
    if (this.#deps.base.planningHold(handle, key) !== null) return "notRunnable";
    const view = c.view;
    if (view === undefined || c.unparsed) return "gate";
    if (openDependencies(view).length > 0) return "dependency";

    let fields;
    try {
      fields = parseFieldBlock(view.description).fields;
    } catch {
      return "gate";
    }
    const branch = fields.branch;
    const tier = readLabels(view.labels).tiers[0];
    const caps =
      tier === undefined ? undefined : c.config.tiers[tier as keyof OfficeConfig["tiers"]];
    if (typeof branch !== "string" || !branch.startsWith(`${story}/`) || caps === undefined) {
      return "gate";
    }
    const taskFile = relative(c.checkout.path, view.file);
    try {
      assembleContract(
        promptStoryOf(view, { dependencies: [], fields, taskFile }),
        c.config.prompt.contractMax,
      );
    } catch (error) {
      if (!(error instanceof ContractTooLargeError)) throw error;
      return { tooLarge: `${story} cannot start: ${error.code}: ${error.message}` };
    }
    return { view, fields, branch, tier: tier as string, caps, taskFile };
  }

  /**
   * Why a new pickup finds no free slot in the office (0002): `Places.slotTaken`, or without the
   * places the office's runs and the starts decided here counted against `caps.parallelRuns`;
   * null when one is free.
   */
  #slotTaken(handle: OfficeHandle, config: OfficeConfig): string | null {
    const places = this.#deps.places;
    if (places?.slotTaken !== undefined) return places.slotTaken(handle.officeId, PICKUP_START);
    return placeTaken(handle, PICKUP_START, {
      limit: config.caps.parallelRuns,
      starting: runStarts(handle).map((start) => start.story),
    });
  }

  /** The command's context for what runs after its answer: each `commit` its own transaction. */
  #afterAnswer(ctx: CommandContext): AsyncCommandContext {
    const { emit: _emit, ...rest } = ctx;
    const office = ctx.office;
    return {
      ...rest,
      commit: (fn) => {
        office.immediate(() => {
          const entries = fn() ?? [];
          if (entries.length === 0) return;
          appendEntries(office, entries, { at: ctx.clock.now(), causedBy: ctx.requestId });
        });
        this.#deps.onChanged?.(office.officeId);
      },
    };
  }

  /**
   * The start of a decided story after the answer (steps 5 to 8): the fresh base, the story checked
   * again on it, the claim, the run row and the launch. A story that can no longer start is not
   * claimed and gets a `run.startAborted` notice; a failure anywhere releases its slot.
   */
  async #start(command: CommandContext, input: StartInput, release: () => void): Promise<void> {
    const ctx = this.#afterAnswer(command);
    const { candidate } = input;
    try {
      const fresh = await this.#freshCheck(ctx, input);
      if (typeof fresh === "string") {
        this.#ended(ctx, candidate, input.runId, fresh);
        return;
      }
      const { checked, checkout } = fresh;
      const facts: RunFacts = {
        office: ctx.office.officeId,
        runId: input.runId,
        agent: input.agent,
        view: checked.view,
        fields: checked.fields,
        caps: checked.caps,
        config: input.config,
        taskFile: checked.taskFile,
      };
      const outcome = await this.#claim(ctx, input, checked, facts, checkout);
      if (!outcome.ok) {
        // The claim's own skips put their notice on the office; a silent one gets this one.
        this.#ended(
          ctx,
          candidate,
          input.runId,
          outcome.notice === null ? (ABORTED_BECAUSE[outcome.reason] ?? outcome.reason) : null,
        );
        return;
      }
      const started = this.#recordRun(ctx, input, checked, facts, outcome);
      release();
      await this.#launch(ctx, input, facts, outcome, started);
    } catch (error) {
      this.#ended(
        ctx,
        candidate,
        input.runId,
        `its start failed: ${messageOf(commandErrorOf(error))}`,
      );
    } finally {
      release();
    }
  }

  /**
   * Step 5: fetch and index the base, refresh the run profile, and check the story again on the
   * base as it is now. Returns what the claim needs, or why the story no longer starts (after
   * moving it to Refined when its pickup check failed).
   */
  async #freshCheck(
    ctx: AsyncCommandContext,
    input: StartInput,
  ): Promise<{ readonly checked: Startable; readonly checkout: BaseCheckout } | string> {
    const deps = this.#deps;
    const handle = ctx.office;
    const office = handle.officeId;
    const { candidate } = input;
    const fetched = await this.#freshBase(office);
    if (fetched !== null) return fetched;
    // A failed scan is recorded as a scan; the stored profile then decides.
    await deps.profiles.ensureFreshProfile(office).catch(() => undefined);
    const verify = deps.profiles.verifyResolved(handle);
    if (verify !== null) return verify;
    const statuses = await deps.statuses(office);
    if (statuses !== null) return statuses;
    let read: BaseRead;
    try {
      read = await deps.base.read(office, [candidate.story]);
    } catch (error) {
      return `the base could not be read: ${messageOf(error)}`;
    }
    const checked = this.#precheck(
      handle,
      {
        candidate,
        status: read.statuses.get(candidate.story),
        view: read.views.find((view) => view.id === candidate.story),
        unparsed: read.unparsed.includes(candidate.story),
        checkout: read.checkout,
        // Its slot is held since the decision.
        full: null,
        config: input.config,
      },
      true,
    );
    if (checked === "gate") {
      const reason = await this.#gateOutsideClaim(ctx, candidate);
      return ABORTED_BECAUSE[reason] ?? reason;
    }
    if (typeof checked === "string") return ABORTED_BECAUSE[checked] ?? checked;
    if ("tooLarge" in checked) {
      await this.#toRefined(ctx, candidate, [{ message: checked.tooLarge }]);
      return ABORTED_BECAUSE["pickupCheckFailed"] as string;
    }
    return { checked, checkout: read.checkout };
  }

  /** Fetches and indexes the base; why it could not, or null. */
  async #freshBase(office: OfficeId): Promise<string | null> {
    try {
      await this.#deps.base.fetch(office);
    } catch (error) {
      return `the fetch of the base failed: ${messageOf(error)}`;
    }
    try {
      await this.#deps.stories.indexStories(office);
    } catch (error) {
      return `dipo could not index the office's stories: ${messageOf(error)}`;
    }
    return null;
  }

  /**
   * The end of a decided start without a run row, in one transaction: its row goes, the story
   * shows as the base has it again, and with `why` a `run.startAborted` notice names the story
   * and why. After its run row is in, only the notice.
   */
  #ended(ctx: AsyncCommandContext, candidate: Candidate, runId: RunId, why: string | null): void {
    try {
      this.#endedCommit(ctx, candidate, runId, why);
    } catch (error) {
      // The row stays until the next office load clears it; say so.
      this.#deps.warn?.(
        "ending a decided start failed; its starting row stays until the office loads again",
        {
          office: ctx.office.officeId,
          run: runId,
          story: candidate.story,
          reason: messageOf(error),
        },
      );
      throw error;
    }
  }

  #endedCommit(
    ctx: AsyncCommandContext,
    candidate: Candidate,
    runId: RunId,
    why: string | null,
  ): void {
    ctx.commit((): NewEntry[] => {
      const entries: NewEntry[] = [];
      if (deleteRunStart(ctx.office, runId)) {
        const story = storyView(ctx.office, candidate.key);
        if (story !== null) {
          entries.push({
            type: "story.state",
            key: candidate.key,
            delta: {
              story: candidate.story,
              key: candidate.key,
              from: story.lifecycle,
              to: story.lifecycle,
            },
            view: story,
          });
        }
      }
      if (why !== null) {
        entries.push({
          type: "engine.notice",
          key: candidate.key,
          delta: {
            level: "warn",
            code: RUN_NOTICES.startAborted,
            text: `${candidate.story} did not start after all: ${why.replace(/\.$/, "")}. It stays as it is on the base; \`dipo run ${candidate.story}\` tries again.`,
          },
        });
      }
      return entries;
    });
  }

  /**
   * After the answer, for a story the base as read said fails its pickup check (its gate, or a
   * contract over `prompt.contractMax`): fetch and index first, and move it to Refined only when it
   * still fails on the fresh base; when it passes there, or cannot be checked, a notice says so.
   */
  async #refineOnFreshBase(
    ctx: AsyncCommandContext,
    candidate: Candidate,
    config: OfficeConfig,
  ): Promise<void> {
    const office = ctx.office.officeId;
    const notice = (text: string) =>
      ctx.commit((): NewEntry[] => [
        {
          type: "engine.notice",
          key: candidate.key,
          delta: { level: "warn", code: RUN_NOTICES.checkedAgain, text },
        },
      ]);
    const fetched = await this.#freshBase(office);
    if (fetched !== null) {
      notice(
        `${candidate.story} was not started: it failed its pickup check on the base as last read, and ${fetched.replace(/\.$/, "")}, so it was not checked again and stays Ready.`,
      );
      return;
    }
    const read = await this.#deps.base.read(office, [candidate.story]);
    const checked = this.#precheck(ctx.office, {
      candidate,
      status: read.statuses.get(candidate.story),
      view: read.views.find((view) => view.id === candidate.story),
      unparsed: read.unparsed.includes(candidate.story),
      checkout: read.checkout,
      full: null,
      // The configuration in force now: the fresh base may have changed it.
      config: this.#deps.offices.config(office) ?? config,
    });
    if (typeof checked === "object" && "tooLarge" in checked) {
      await this.#toRefined(ctx, candidate, [{ message: checked.tooLarge }]);
      return;
    }
    // Not Ready any more, or claimed meanwhile: nothing to move.
    if (typeof checked === "string" && checked !== "gate") return;
    const reason = await this.#gateOutsideClaim(ctx, candidate);
    if (reason === "pickupCheckFailed") return;
    notice(
      `${candidate.story} was not started: it failed its pickup check on the base as last read, but passes it on the fresh base, so it stays Ready; \`dipo run ${candidate.story}\` starts it.`,
    );
  }

  /**
   * The claim with its pickup re-check and, with a launcher, its setup (the box, its install and
   * the launch checks, DIPO-74). A failed re-check moves the story to Refined.
   */
  async #claim(
    ctx: AsyncCommandContext,
    c: StartInput,
    checked: Startable,
    facts: RunFacts,
    checkout: BaseCheckout,
  ): Promise<ClaimOutcome> {
    const office = ctx.office.officeId;
    const { story, key } = c.candidate;
    const launcher = this.#deps.launcher;
    let failures: GateFailureFact[] | null = null;
    let outcome: ClaimOutcome;
    try {
      outcome = await this.#deps.claims.claim(office, {
        key,
        story,
        branch: checked.branch,
        runId: facts.runId,
        recheck: async (git) => {
          const decision = await this.#deps.gates.recordGateDecision(
            office,
            key,
            "pickup",
            checkout,
            git,
          );
          if (decision.passed) return null;
          failures = [...decision.result.failures];
          return { ok: false, reason: "pickupCheckFailed", notice: null, code: null };
        },
        // Setup, the prompts and the launch checks, before the claim commit (DIPO-74).
        ...(launcher === undefined
          ? {}
          : {
              setup: (claim: ClaimRecord) =>
                launcher.prepare(facts, claim, (entry) => ctx.commit(() => [entry])),
            }),
      });
    } catch (error) {
      throw commandErrorOf(error);
    }
    if (!outcome.ok && failures !== null) await this.#toRefined(ctx, c.candidate, failures);
    return outcome;
  }

  /**
   * The claimed story's run row (with the slot setup took), its developer agent, the
   * configuration snapshot and the `setup` phase, with `work.assigned` and `work.phase setup`, in
   * one transaction.
   */
  #recordRun(
    ctx: AsyncCommandContext,
    c: StartInput,
    checked: Startable,
    facts: RunFacts,
    outcome: Extract<ClaimOutcome, { ok: true }>,
  ): { readonly work: WorkRef; readonly progress: Progress } {
    const handle = ctx.office;
    const { story, key } = c.candidate;
    const { view, tier, caps } = checked;
    const { runId, agent } = facts;
    const prepared = outcome.setup as PreparedRun | null;
    const work: WorkRef = {
      story,
      key,
      run: runId,
      agent,
      role: DEVELOPER_ROLE,
      tier,
      model: caps.model,
    };
    const progress: Progress = {
      criteriaMet: view.acceptanceCriteria.filter((criterion) => criterion.checked).length,
      criteriaTotal: view.acceptanceCriteria.length,
      loop: 0,
      loopCap: caps.loops,
      reviewRound: 0,
    };
    const at = ctx.clock.now();
    ctx.commit((): NewEntry[] => {
      // The run row replaces the decided start (DIPO-456).
      deleteRunStart(handle, runId);
      recordConfigSnapshot(handle, c.configHash, c.config, at);
      insertRun(handle, {
        runId,
        kind: "story",
        key,
        story,
        tier,
        role: DEVELOPER_ROLE,
        model: caps.model,
        startSha: outcome.claim.startSha,
        branch: outcome.claim.branch,
        budgetUnit: "tokens",
        budgetLimit: caps.budgetTokens,
        loopCap: caps.loops,
        maxTurns: caps.maxTurns,
        maxMinutes: caps.maxMinutes,
        // The review loop's caps, fixed at the start (0002, 0020).
        reviewRoundCap: c.config.review.maxRounds,
        ciCap: c.config.caps.ciAttempts,
        conflictCap: c.config.caps.conflictAttempts,
        reviewMaxTurns: c.config.review.maxTurns,
        reviewMaxMinutes: c.config.review.maxMinutes,
        reviewMaxTokens: c.config.review.budgetTokens,
        configHash: c.configHash,
        overrideKeys: null,
        runProfileId: currentProfileId(handle),
        startedAt: at,
        scope: view.references,
      });
      // The criteria the worker's reports are counted against (DIPO-85).
      recordRunCriteria(handle, runId, {
        known: view.acceptanceCriteria.map((criterion) => criterion.index),
        checked: view.acceptanceCriteria
          .filter((criterion) => criterion.checked)
          .map((criterion) => criterion.index),
      });
      recordDeveloper(handle, { runId, agent, caps, prepared, at });
      // The context pack and the prompt records of the first session.
      if (prepared !== null) {
        recordPrepared(handle, {
          branch: outcome.claim.branch,
          runId,
          agent,
          prepared,
          config: c.config,
          clock: ctx.clock,
          at,
        });
      }
      const marker = markPhase(handle, runId, "setup", at);
      return withWorkViews(handle, [
        { type: "work.assigned", key, run: runId, delta: { work } },
        ...marker,
        { type: "work.phase", key, run: runId, delta: { work, phase: "setup", progress } },
      ]);
    });
    return { work, progress };
  }

  /** After the run row: the story view read again, then the worker host started (DIPO-74). */
  async #launch(
    ctx: AsyncCommandContext,
    c: StartInput,
    facts: RunFacts,
    outcome: Extract<ClaimOutcome, { ok: true }>,
    started: { readonly work: WorkRef; readonly progress: Progress },
  ): Promise<void> {
    const { key } = c.candidate;
    const prepared = outcome.setup as PreparedRun | null;
    const launcher = this.#deps.launcher;
    // From the run row until its worker is followed, a park waits for the start (DIPO-411).
    const starting =
      launcher !== undefined && prepared !== null ? launcher.starting(facts.runId) : null;
    try {
      // The claim commit set In Progress on the branch: the story view reads it from there now. A
      // read that fails leaves the next pass to do it.
      await this.#deps.stories.refreshStory?.(ctx.office.officeId, key).catch(() => undefined);
      if (launcher !== undefined && prepared !== null) {
        const startedRun = await launcher.start(ctx, {
          facts,
          prepared,
          claim: outcome.claim,
          work: started.work,
          progress: started.progress,
        });
        // A failed start posted its own notice and released the claim (`RunLauncher.start`).
        if (!startedRun.ok) return;
      }
    } finally {
      starting?.();
    }
  }

  /**
   * The pickup gate on its own, for a story the claim cannot even be asked for (no view, a field
   * block that does not parse, no frozen branch, no tier): the stored decision names what fails,
   * and the story goes back to Refined.
   */
  async #gateOutsideClaim(ctx: AsyncCommandContext, candidate: Candidate): Promise<SkipReason> {
    const decision = await this.#deps.gates.recordGateDecision(
      ctx.office.officeId,
      candidate.key,
      "pickup",
    );
    if (decision.passed) return "notRunnable";
    await this.#toRefined(ctx, candidate, decision.result.failures);
    return "pickupCheckFailed";
  }

  /**
   * Moves a story back to Refined through the backlog lane (journaled, then flushed into the
   * office's backlog PR) and emits `story.state` with the failure messages in `detail` and the
   * failures, with their rules, in the view. A lane that refuses the move puts a notice on the
   * office instead.
   */
  async #toRefined(
    ctx: AsyncCommandContext,
    candidate: Candidate,
    failures: readonly GateFailureFact[],
  ): Promise<void> {
    const detail = failures.map((failure) => failure.message);
    const office = ctx.office.officeId;
    const lane = this.#deps.lane(office);
    let why: string | null = lane === undefined ? "the office has no backlog lane" : null;
    if (lane !== undefined) {
      try {
        await lane.toRefined({ key: candidate.key, story: candidate.story });
      } catch (error) {
        if (!(error instanceof PlanningRefusedError)) throw error;
        why = error.message;
      }
      // A failed flush leaves the move journaled; the lane put its own notice on the office.
      if (why === null) await lane.flush();
    }
    ctx.commit((): NewEntry[] => {
      if (why !== null) {
        return [
          {
            type: "engine.notice",
            key: candidate.key,
            delta: {
              level: "warn",
              code: RUN_NOTICES.notMovedToRefined,
              text: `${candidate.story} failed its pickup check but could not be moved to ${REFINED_STATUS} (${why}): ${detail.join(" ")}`,
            },
          },
        ];
      }
      const current = storyView(ctx.office, candidate.key);
      const view = deriveStoryView({
        key: candidate.key,
        story: candidate.story,
        title: current?.title ?? "",
        lifecycle: "Refined",
        ...(current?.tier === undefined ? {} : { tier: current.tier }),
        gateFailures: failures,
      });
      return [
        {
          type: "story.state",
          key: candidate.key,
          delta: {
            story: candidate.story,
            key: candidate.key,
            from: "Ready",
            to: "Refined",
            detail: [...detail],
          },
          view,
        },
      ];
    });
  }

  /**
   * `work.preview`, the dry run of `work.run`: the same refusals (as `refusals`, not errors, except
   * an invalid configuration), the same candidates and skips from the base as last fetched, and
   * the worker launch of the story it would start. Nothing is fetched, indexed, stored, claimed or
   * created; the pickup gate is evaluated without storing a decision. Reading the base may create
   * the engine's `_base` read worktree (DIPO-31) when the office has none yet.
   */
  async preview(ctx: ReadContext, args: PreviewArgs): Promise<Preview> {
    const deps = this.#deps;
    const handle = ctx.office;
    if (handle === undefined) throw new Error("work.preview runs with its office");
    const office = handle.officeId;
    const blocks = deps.offices.configBlocksRuns(office);
    const config = deps.offices.config(office);
    if (blocks.length > 0 || config === undefined) {
      const why =
        blocks.length > 0
          ? blocks.map((error) => error.message).join("; ")
          : "the office has no valid configuration yet";
      throw new CommandError(
        "config.invalid",
        `New runs are refused until \`dipo office reload-config\` reads a valid configuration: ${why}`,
        { office },
      );
    }
    const refusals: Preview["refusals"] = [];
    const paused = deps.startsPaused(office);
    // As in `work.run`: a run that names its stories repeats the launch checks, so an adapter
    // pause they lift is information then, not a refusal.
    const notes: string[] = [];
    // `notes` only when there is one, so the usual reply keeps the shape 0005 names.
    const info = () => (notes.length === 0 ? { refusals } : { refusals, notes });
    if (paused !== null) {
      const message = `The office's starts are paused (${paused.detail}). ${paused.lifts}`;
      if (repeatsChecks(paused, args.stories !== undefined, deps)) {
        notes.push(`${message} The launch checks will be repeated for the named story.`);
      } else {
        refusals.push({ check: paused.reason, message });
      }
    }
    const statuses = await deps.statuses(office);
    if (statuses !== null) refusals.push({ check: "statuses", message: statuses });
    const verify = deps.profiles.verifyResolved(handle);
    if (verify !== null) refusals.push({ check: "verify", message: verify });

    const named: Candidate[] | null =
      args.stories === undefined
        ? null
        : args.stories.map((ref) => {
            const identity = ctx.stories.get(ref);
            if (identity === undefined) throw new Error(`${ref} was not resolved`);
            return identity;
          });
    let read: BaseRead;
    try {
      read = await deps.base.read(office, named === null ? null : named.map((c) => c.story));
    } catch (error) {
      throw commandErrorOf(error);
    }
    const views = new Map(read.views.map((view) => [view.id, view]));
    const candidates: Candidate[] =
      named ??
      pickupOrder(read.views).flatMap((view) => {
        const resolved = resolveStoryRef(handle, view.id);
        return resolved.ok ? [{ story: resolved.story, key: resolved.key }] : [];
      });

    const skipped: Preview["skipped"] = [];
    let chosen: { readonly candidate: Candidate; readonly startable: Startable } | null = null;
    const full = this.#slotTaken(handle, config);
    for (const candidate of candidates) {
      // The preview shows the first story a run would start; the ones after it as capacity.
      const checked = this.#precheck(handle, {
        candidate,
        status: read.statuses.get(candidate.story),
        view: views.get(candidate.story),
        unparsed: read.unparsed.includes(candidate.story),
        checkout: read.checkout,
        full: full ?? (chosen === null ? null : ONE_PREVIEWED),
        config,
      });
      if (checked === "capacity" && full !== null) {
        skipped.push({ ...candidate, reason: checked, detail: [full] });
        continue;
      }
      if (typeof checked === "string" && checked !== "gate") {
        skipped.push({ ...candidate, reason: checked });
        continue;
      }
      if (typeof checked === "object" && "tooLarge" in checked) {
        skipped.push({ ...candidate, reason: "pickupCheckFailed", detail: [checked.tooLarge] });
        continue;
      }
      const result =
        deps.gates.checkGate === undefined
          ? null
          : await deps.gates.checkGate(office, candidate.story, "pickup");
      if (result !== null && !result.passed) {
        skipped.push({
          ...candidate,
          reason: "pickupCheckFailed",
          detail: result.failures.map((failure) => failure.message),
        });
        continue;
      }
      // Only the gate could say what is wrong, and it passed: work.run skips it as not runnable.
      if (typeof checked !== "object") {
        skipped.push({ ...candidate, reason: "notRunnable" });
        continue;
      }
      chosen = { candidate, startable: checked };
    }
    if (chosen === null) return { ...info(), story: null, skipped, launch: null, problem: null };

    const { candidate, startable } = chosen;
    const story = { story: candidate.story, key: candidate.key };
    const launcher = deps.launcher;
    if (launcher === undefined) {
      return { ...info(), story, skipped, launch: null, problem: "this daemon starts no workers" };
    }
    try {
      const launch = await launcher.preview({
        office,
        story: candidate.story,
        branch: startable.branch,
        view: startable.view,
        fields: startable.fields,
        caps: startable.caps,
        config,
        taskFile: startable.taskFile,
        base: read.checkout,
      });
      return { ...info(), story, skipped, launch, problem: null };
    } catch (error) {
      const problem =
        error instanceof PlanError
          ? planRefusedText(candidate.story, error)
          : `the launch could not be planned: ${error instanceof Error ? error.message : String(error)}`;
      return { ...info(), story, skipped, launch: null, problem };
    }
  }

  /**
   * The command `work.run` (not a waiting one: it answers at its decision, DIPO-456), the read
   * `work.preview`, the active-run check of `office.forget` and the load step that reads the base
   * the runs decide from.
   */
  get feature(): FeatureModule {
    return {
      name: "run",
      register: (registry) => {
        registry.addOfficeCommand({
          definition: workRun,
          handle: (ctx, args) => this.run(ctx, args),
        });
        // The office's first run decides from a base already read.
        registry.registerLoadStep(RUN_BASE_STEP, async (ctx) => {
          // No start survives a daemon restart; reconcile sees to a claim it left.
          ctx.office.immediate(() => clearRunStarts(ctx.office));
          await this.refreshBase(ctx.officeId);
          return { ok: true };
        });
        // The gates a snapshot could not evaluate without a valid configuration.
        registry.registerConfigReload(RUN_BASE_STEP, (ctx) => {
          void this.refreshBase(ctx.officeId);
        });
        // A story merged to the base since the last poll: the executor waits for the refresh of
        // the stories before it resolves the names, and the base the run decides from follows it.
        registry.registerStoryRefresh(RUN_BASE_STEP, async (office) => {
          await this.#deps.stories.refresh?.(office);
          await this.refreshBase(office);
        });
        registry.addAsyncRead({
          definition: workPreview,
          handle: (ctx, args) => this.preview(ctx, args),
        });
        // A start decided and not yet a run is active work too (DIPO-456).
        registry.registerActiveWorkCheck(
          RUNS_CHECK,
          (office) => hasActiveRun(office) || runStarts(office).length > 0,
        );
      },
    };
  }
}

/** `RunBase` on the office's git and the story store in `_base`. */
export function storyRunBase(deps: {
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  readonly stories: StoryStore;
}): RunBase {
  const gitOf = (office: OfficeId): OfficeGit => {
    const git = deps.git(office);
    if (git === undefined) throw new Error(`Office ${office} has no git attached.`);
    return git;
  };
  return {
    async fetch(office) {
      const git = gitOf(office);
      const { remote } = git.settings;
      const url = await git.run((session) =>
        session.step(session.repository, ["config", "--get", `remote.${remote}.url`]),
      );
      if (url.code !== 0 || url.stdout.trim() === "") return;
      const fetched = await git.fetch();
      if (!fetched.ok) throw fetched.error;
    },
    async read(office, ids) {
      const git = gitOf(office);
      const checkout = await git.ensureBaseWorktree();
      return git.run(async () => {
        // The whole list (DIPO-323): its statuses decide whether a dependency is Done.
        const listed = await deps.stories.list(checkout.path, "task");
        const statuses = new Map(listed.entries.map((entry) => [entry.id, entry.group]));
        const wanted = (
          ids ?? listed.entries.filter((e) => e.group === READY_STATUS).map((e) => e.id)
        ).filter((id) => statuses.has(id));
        const unparsed: string[] = [];
        const views = await mapLimited(wanted, VIEW_CONCURRENCY, async (id) => {
          try {
            return await deps.stories.view(checkout.path, id);
          } catch (error) {
            if (!(error instanceof StoryParseError)) throw error;
            unparsed.push(id);
            return null;
          }
        });
        return {
          statuses,
          views: views.filter((view): view is PlainTask => view !== null),
          unparsed,
          checkout: { path: checkout.path, base: checkout.base },
        };
      });
    },
    planningHold: (office, key) => deps.stories.planningHold(office, key),
  };
}
