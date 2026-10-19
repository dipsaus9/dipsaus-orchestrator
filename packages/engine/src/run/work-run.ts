// `work.run` (DIPO-48; 0005 section 4, 0012 sections 2 and 3, 0010 sections 2 and 7, 0013 section 2,
// 0014 section 4, 0008 section 9): pick one Ready story from `origin/<base>` (or the named ones),
// re-check it at pickup, claim it and record the run. With a launcher (DIPO-74, `launch.ts`) the
// claim's setup also renders the prompts and runs the launch checks, and the worker starts after
// the claim. `work.preview` (DIPO-74) is the same selection as a read that changes nothing.
//
// Order:
// 1. Refusals of the whole command, each with the predicate's message: `maxAgents` above 1
//    (`args.invalid`, M0 runs one story at a time), an invalid configuration (`config.invalid`,
//    `configBlocksRuns`), an adapter hold (`run.refused`, `adapterHeld`; a run that names its
//    stories goes on and repeats the launch checks, which lift the hold), a plan limit of every
//    model or `credits` (`run.refused`, check `plan-limit`, DIPO-61; named stories too), a failed
//    fetch (the retryable `git.fetchFailed`), statuses the base lacks (`run.refused`,
//    `officeStatusesReady`) and an unresolved verify (`run.refused`, `verifyResolved`). The daemon
//    answers the retryable `scheduling.off` in `safe` before the command reaches the engine.
// 2. The stories are indexed (DIPO-32) and the run profile refreshed (DIPO-72).
// 3. Without `stories`, the candidates are the Ready stories on the base in pickup order; with
//    `stories`, only those, in the order given.
// 4. Each candidate not started is a skip: its status (`notReady`, `parked`, `notRunnable`), a
//    live claim, a pending lane-b operation or a failed backlog PR check (`notRunnable`), the
//    office's worker place held by a developer session or owed to a waiting resume, fix round or
//    conflict hand-off first (`capacity`, 0019 section 12, DIPO-142; a reviewer or a session run
//    takes no worker place), a model-family plan limit on the story's tier model
//    (`capacity`, DIPO-61), a dependency not Done (`dependency`), or a failed pickup
//    check (`pickupCheckFailed`).
// 5. Before the claim the story contract is assembled (DIPO-47); `prompt.contractTooLarge` moves
//    the story to Refined like a failed pickup re-check.
// 6. The claim (DIPO-38) runs the pickup re-check (the Ready gate in `pickup` mode, stored through
//    DIPO-71) first inside its git queue item. A failed re-check moves the story to Refined through
//    the backlog lane and emits `story.state` with the gate messages in `detail`.
// 7. A claimed story gets its run row (with the slot setup took), its developer agent (with the
//    engine-made session id), the configuration snapshot and the `setup` phase, and
//    `work.assigned` and `work.phase setup` in the same transaction.
// 8. With a launcher, the worker host starts and `work.phase build` follows; a failed setup or
//    launch check rolled the claim back in step 6 (a `pickupCheckFailed` skip, the story Ready).

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

import { allSlotsHeld, type SlotEntry, SlotTableError, slotsTakenMessage } from "../worktree/slots";
import { parseFieldBlock } from "../backlog/fields/block";
import { readLabels } from "../backlog/fields/labels";
import { EDIT_KIND } from "../backlog/lane/ops";
import { type JournalEntry, type LaneOp, pendingLaneOp } from "../backlog/lane/journal";
import { LaneError, LaneFlushError } from "../backlog/lane/lane";
import { BacklogParseError, parseList, parseView, type PlainTask } from "../backlog/plain";
import { backlogCheckBlocked } from "../backlog/pr/records";
import { type BacklogCli, runBacklog } from "../backlog/runner";
import type { NewEntry } from "../changelog/log";
import { CommandError } from "../commands/errors";
import type {
  AsyncCommandContext,
  CommandOutcome,
  FeatureModule,
  ReadContext,
} from "../commands/registry";
import type { OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import type { BaseCheckout } from "../gate/store/feature";
import type { GateMode, GateResult } from "../gate/types";
import { writeNudgeSources } from "../hooks/nudges";
import type { OfficeGit } from "../git/office";
import { GitError } from "../git/runner";
import { assembleContract, ContractTooLargeError } from "../prompts/contract";
import { recordPromptParts, recordPromptTexts } from "../prompts/parts";
import { promptStoryOf } from "../prompts/story";
import { resolveStoryRef } from "../stories/keys";
import { mapLimited, VIEW_CONCURRENCY } from "../stories/read";
import { deriveStoryView, type GateFailureFact, storyView } from "../views/story";
import { withWorkViews } from "../views/work";
import { type AdapterHold, holdMessage } from "../workers/hold";
import type { VerifyCommands } from "../workers/port";
import { PlanError } from "../workers/types";
import type { ClaimOutcome, ClaimRequest } from "../worktree/claim";
import { type ClaimRecord, liveClaimOf } from "../worktree/records";

import { recordRunCriteria } from "./criteria";
import { planRefusedText, type PreparedRun, type RunFacts, type RunLauncher } from "./launch";
import { markPhase } from "./markers";

import { placeTaken, START_KINDS } from "./places";
import { currentProfileId, hasActiveRun, insertRun, recordConfigSnapshot } from "./records";
import { openDependencies, pickupOrder, READY_STATUS, statusSkip } from "./select";
import { verifyCommands } from "../scan/store";

/** The resolved verify for the launch checks (DIPO-173); nothing when it is not resolved. */
function verifyOf(handle: OfficeHandle): { readonly verify?: VerifyCommands } {
  const verify = verifyCommands(handle);
  return verify === null ? {} : { verify };
}

/** The role every M0 run starts with (0012 F12). */
export const DEVELOPER_ROLE = RoleId.parse("developer");

/** The status a failed pickup check moves a story back to (0012 section 3). */
export const REFINED_STATUS = "Refined";

/** The error code of a run refused by an office check (`details.check` names it). */
export const RUN_REFUSED = "run.refused" satisfies OfficeErrorCode;

/** `details.check` of the `run.refused` a plan-limit hold gives `work.run` (DIPO-61). */
export const PLAN_LIMIT_CHECK = "plan-limit";

/** The active-work check `office.forget` asks (DIPO-27). */
export const RUNS_CHECK = "runs";

/** `engine.notice` codes of `work.run`. */
export const RUN_NOTICES = {
  notMovedToRefined: "run.notMovedToRefined",
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
}

export interface RunOffices {
  get(office: OfficeId): OfficeHandle | undefined;
  config(office: OfficeId): OfficeConfig | undefined;
  configHash(office: OfficeId): string | undefined;
  configBlocksRuns(office: OfficeId): readonly ConfigError[];
}

/** The part of the planning lane `work.run` uses to move a story back to Refined. */
export interface RunLane {
  journal(op: LaneOp): Promise<JournalEntry>;
  flush(): Promise<unknown>;
}

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
  };
  /** The run profile (DIPO-72): refreshed before each run, then its verify refusal read. */
  readonly profiles: {
    ensureFreshProfile(office: OfficeId): Promise<unknown>;
    verifyResolved(office: OfficeHandle): string | null;
  };
  /** `officeStatusesReady` (DIPO-36): the refusal while the base lacks the run statuses. */
  readonly statuses: (office: OfficeId) => Promise<string | null>;
  /** `adapterHeld` (DIPO-43). */
  readonly adapterHeld: (adapter: string) => AdapterHold | null;
  /**
   * The plan-limit hold (DIPO-61, `PlanLimits.held`): why a new run on the adapter and model must
   * wait, or null. With `model` null only the holds of every model count.
   */
  readonly planLimitHeld?: (adapter: string, model: string | null) => string | null;
  readonly claims: { claim(office: OfficeId, request: ClaimRequest): Promise<ClaimOutcome> };
  readonly gates: {
    recordGateDecision(
      office: OfficeId,
      key: StoryKey,
      mode: GateMode,
      checkout?: BaseCheckout,
    ): Promise<{ readonly passed: boolean; readonly result: GateResult }>;
    /** The gate evaluated on `_base` without storing it (`work.preview`). */
    checkGate?(office: OfficeId, story: StoryId, mode: GateMode): Promise<GateResult>;
  };
  readonly lane: (office: OfficeId) => RunLane | undefined;
  /**
   * Setup, the prompts, the launch checks and the worker start of a claimed run (DIPO-74). Without
   * it a claimed run stops at the `setup` phase with no worker, as DIPO-48 left it.
   */
  readonly launcher?: RunLauncher;
  /**
   * The live entries of the machine-wide port slot table (`SlotTable.live`, DIPO-197), read without
   * writing. Without it no slots refusal is made; setup still fails when every slot is taken.
   */
  readonly liveSlots?: () => readonly SlotEntry[];
}

type Args = z.output<typeof workRun.args>;
type Result = z.input<typeof workRun.result>;
type Started = Result["started"][number];
type Skipped = Result["skipped"][number];

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

/**
 * True when a new pickup cannot take the office's worker place (0019 section 12): a developer
 * session holds it, or a resume, fix round or conflict hand-off waits for it and goes first.
 */
function workerPlaceTaken(office: OfficeHandle): boolean {
  return placeTaken(office, { kind: START_KINDS.pickup, runId: null, since: 0 }) !== null;
}

/** `git.fetchFailed` and other git refusals as command errors; anything else as it is. */
function commandErrorOf(error: unknown): unknown {
  if (error instanceof GitError) return new CommandError(error.code, error.message, error.details);
  return error;
}

function refused(office: OfficeId, check: string, message: string): CommandError {
  return new CommandError(RUN_REFUSED, message, { office, check });
}

/** The check name of the slots refusal. */
const SLOTS_CHECK = "slots";

/**
 * Why `story` cannot get a port slot, or null: every slot from 1 to `maxSlots` is held by a live
 * worktree and none of them is the story's own (a story that holds a slot keeps it). A slot table
 * that cannot be read refuses too, with its reason, since setup could not take a slot from it.
 */
function slotsRefusal(
  liveSlots: (() => readonly SlotEntry[]) | undefined,
  office: OfficeId,
  story: StoryId,
  maxSlots: number,
): string | null {
  if (liveSlots === undefined) return null;
  let live: readonly SlotEntry[];
  try {
    live = liveSlots();
  } catch (error) {
    if (error instanceof SlotTableError) return error.message;
    throw error;
  }
  if (!allSlotsHeld(live, maxSlots)) return null;
  if (live.some((entry) => entry.office === office && entry.story === story)) return null;
  return slotsTakenMessage(live, maxSlots);
}

export class WorkRun {
  readonly #deps: WorkRunDeps;
  readonly #busy = new Map<OfficeId, Promise<unknown>>();

  constructor(deps: WorkRunDeps) {
    this.#deps = deps;
  }

  /** `work.run`: one run per office at a time. */
  run(ctx: AsyncCommandContext, args: Args): Promise<CommandOutcome<Result>> {
    const office = ctx.office.officeId;
    const before = this.#busy.get(office) ?? Promise.resolve();
    const run = before.then(
      () => this.#run(ctx, args),
      () => this.#run(ctx, args),
    );
    this.#busy.set(
      office,
      run.catch(() => undefined),
    );
    return run;
  }

  async #run(ctx: AsyncCommandContext, args: Args): Promise<CommandOutcome<Result>> {
    const deps = this.#deps;
    const handle = ctx.office;
    const office = handle.officeId;
    if (args.maxAgents !== undefined && args.maxAgents > 1) {
      throw new CommandError(
        "args.invalid",
        `M0 runs one story at a time; maxAgents ${args.maxAgents} is refused until M2.`,
        { maxAgents: args.maxAgents },
      );
    }
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
    // A run that names its stories is the explicit run that repeats the launch checks (DIPO-43,
    // DIPO-74): they lift the hold when they pass. Without names the hold refuses the run.
    const hold = deps.adapterHeld(config.worker.adapter);
    if (hold !== null && (args.stories === undefined || deps.launcher === undefined)) {
      throw refused(office, "adapter", holdMessage(hold));
    }
    // A plan limit of every model, or `credits`, holds every run, named or not (DIPO-61).
    const planLimit = deps.planLimitHeld?.(config.worker.adapter, null) ?? null;
    if (planLimit !== null) throw refused(office, PLAN_LIMIT_CHECK, planLimit);

    try {
      await deps.base.fetch(office);
    } catch (error) {
      throw commandErrorOf(error);
    }
    const statuses = await deps.statuses(office);
    if (statuses !== null) throw refused(office, "statuses", statuses);
    try {
      await deps.stories.indexStories(office);
    } catch (error) {
      throw new CommandError(
        "backlog.unreadable",
        `work.run could not index the office's stories: ${error instanceof Error ? error.message : String(error)}`,
        { office },
      );
    }
    // A failed scan is recorded as a scan; the stored profile then decides.
    await deps.profiles.ensureFreshProfile(office).catch(() => undefined);
    const verify = deps.profiles.verifyResolved(handle);
    if (verify !== null) throw refused(office, "verify", verify);

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

    const started: Started[] = [];
    const skipped: Skipped[] = [];
    const busy = workerPlaceTaken(handle);
    for (const candidate of candidates) {
      const reason = await this.#tryStart(ctx, {
        candidate,
        status: read.statuses.get(candidate.story),
        view: views.get(candidate.story),
        unparsed: read.unparsed.includes(candidate.story),
        checkout: read.checkout,
        full: busy || started.length > 0,
        config,
        configHash,
        started,
      });
      if (reason !== null) skipped.push({ ...candidate, reason });
    }
    return { result: { started, skipped } };
  }

  /**
   * The checks of one candidate that write nothing (step 4 up to the contract): a skip reason,
   * `gate` when only the pickup gate can say what is wrong, or what the claim needs.
   */
  #precheck(
    handle: OfficeHandle,
    c: {
      readonly candidate: Candidate;
      readonly status: string | undefined;
      readonly view: PlainTask | undefined;
      readonly unparsed: boolean;
      readonly checkout: BaseCheckout;
      readonly full: boolean;
      readonly config: OfficeConfig;
    },
  ): SkipReason | "gate" | Startable | { readonly tooLarge: string } {
    const { story, key } = c.candidate;
    // Not on the base: a draft, or a story archived or completed since the last index.
    if (c.status === undefined) return "notRunnable";
    const byStatus = statusSkip(c.status);
    if (byStatus !== null) return byStatus;
    if (liveClaimOf(handle, key) !== null) return "notRunnable";
    if (c.full) return "capacity";
    if (pendingLaneOp(handle, key) !== null) return "notRunnable";
    if (backlogCheckBlocked(handle, key) !== null) return "notRunnable";
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
    // A model-family plan limit holds only stories whose tier runs that family (DIPO-61).
    if (this.#deps.planLimitHeld?.(c.config.worker.adapter, caps.model) != null) return "planLimit";
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

  /** Starts one candidate, or returns why it was skipped. */
  async #tryStart(
    ctx: AsyncCommandContext,
    c: {
      readonly candidate: Candidate;
      readonly status: string | undefined;
      readonly view: PlainTask | undefined;
      readonly unparsed: boolean;
      readonly checkout: BaseCheckout;
      readonly full: boolean;
      readonly config: OfficeConfig;
      readonly configHash: string;
      readonly started: Started[];
    },
  ): Promise<SkipReason | null> {
    const handle = ctx.office;
    const office = handle.officeId;
    const { story, key } = c.candidate;
    const checked = this.#precheck(handle, c);
    if (checked === "gate") return this.#gateOutsideClaim(ctx, c.candidate);
    if (typeof checked === "string") return checked;
    if ("tooLarge" in checked) {
      await this.#toRefined(ctx, c.candidate, [{ message: checked.tooLarge }]);
      return "pickupCheckFailed";
    }
    const { view, fields, branch, tier, caps } = checked;
    const noSlot = slotsRefusal(this.#deps.liveSlots, office, story, c.config.worktree.maxSlots);
    if (noSlot !== null) throw refused(office, SLOTS_CHECK, noSlot);

    const runId = RunId.parse(ctx.ids.next("run"));
    const agent = ctx.ids.next("agt") as AgentId;
    const launcher = this.#deps.launcher;
    const facts: RunFacts = {
      office,
      runId,
      agent,
      view,
      fields,
      caps,
      config: c.config,
      taskFile: checked.taskFile,
      ...verifyOf(handle),
    };
    let failures: GateFailureFact[] | null = null;
    let outcome: ClaimOutcome;
    try {
      outcome = await this.#deps.claims.claim(office, {
        key,
        story,
        branch,
        runId,
        recheck: async () => {
          const decision = await this.#deps.gates.recordGateDecision(
            office,
            key,
            "pickup",
            c.checkout,
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
    if (!outcome.ok) {
      if (failures !== null) await this.#toRefined(ctx, c.candidate, failures);
      return outcome.reason;
    }
    const prepared = outcome.setup as PreparedRun | null;
    const session = prepared === null ? null : prepared.spec.session.id;

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
      verify: "none",
      reviewRound: 0,
    };
    const at = ctx.clock.now();
    ctx.commit((): NewEntry[] => {
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
        worktree: outcome.claim.worktree,
        slot: prepared?.slot ?? null,
        budgetUnit: "tokens",
        budgetLimit: caps.budgetTokens,
        loopCap: caps.loops,
        maxTurns: caps.maxTurns,
        maxMinutes: caps.maxMinutes,
        reviewRoundCap: null,
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
      // The engine-made session id is stored on the run's agent (0007 section 4, `agents`).
      handle.run(
        `insert into agents (office_id, agent_id, run_id, role, model, effort, session_id,
           system_hash, started_at)
         values ($office_id, $agent, $run, $role, $model, $effort, $session, $hash, $at)`,
        {
          agent,
          run: runId,
          role: DEVELOPER_ROLE,
          model: caps.model,
          effort: prepared === null ? null : caps.effort,
          session,
          // The L1+L2 hash a resume compares (DIPO-51).
          hash: prepared?.systemHash ?? null,
          at,
        },
      );
      // The context pack and input paths the nudges check (0014 section 8, DIPO-60).
      if (prepared !== null) {
        const { nudgeSources } = prepared.promptSources;
        writeNudgeSources(handle, runId, agent, nudgeSources, at);
        // The prompt parts of the session's text, measured for the run (0014 section 2).
        recordPromptParts(handle, runId, agent, prepared.parts, ctx.clock);
        // The prompt text itself, with `privacy.storePrompts` on (DIPO-137).
        recordPromptTexts(handle, runId, agent, prepared.texts, c.config, ctx.clock);
      }
      const marker = markPhase(handle, runId, "setup", at);
      return withWorkViews(handle, [
        { type: "work.assigned", key, run: runId, delta: { work } },
        ...marker,
        { type: "work.phase", key, run: runId, delta: { work, phase: "setup", progress } },
      ]);
    });
    // The claim commit set In Progress on the branch: the story view reads it from there now. A
    // read that fails leaves the next pass to do it.
    await this.#deps.stories.refreshStory?.(office, key).catch(() => undefined);
    if (launcher !== undefined && prepared !== null) {
      const startedRun = await launcher.start(ctx, {
        facts,
        prepared,
        claim: outcome.claim,
        work,
        progress,
      });
      if (!startedRun.ok) return "pickupCheckFailed";
    }
    c.started.push({ story, key, run: runId });
    return null;
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
        await lane.journal({
          kind: EDIT_KIND,
          key: candidate.key,
          subject: candidate.story,
          target: { from: [READY_STATUS], status: REFINED_STATUS },
        });
      } catch (error) {
        if (!(error instanceof LaneError)) throw error;
        why = error.message;
      }
      if (why === null) {
        // A failed flush leaves the move journaled; the lane put its own notice on the office.
        await lane.flush().catch((error: unknown) => {
          if (!(error instanceof LaneFlushError)) throw error;
        });
      }
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
    const hold = deps.adapterHeld(config.worker.adapter);
    // As in `work.run`: a run that names its stories repeats the launch checks, so the hold is
    // information then, not a refusal.
    const notes: string[] = [];
    // `notes` only when there is one, so the usual reply keeps the shape 0005 names.
    const info = () => (notes.length === 0 ? { refusals } : { refusals, notes });
    if (hold !== null) {
      if (args.stories !== undefined && deps.launcher !== undefined) {
        notes.push(`${holdMessage(hold)} The launch checks will be repeated for the named story.`);
      } else {
        refusals.push({ check: "adapter", message: holdMessage(hold) });
      }
    }
    const planLimit = deps.planLimitHeld?.(config.worker.adapter, null) ?? null;
    if (planLimit !== null) refusals.push({ check: PLAN_LIMIT_CHECK, message: planLimit });
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
    const busy = workerPlaceTaken(handle);
    for (const candidate of candidates) {
      const checked = this.#precheck(handle, {
        candidate,
        status: read.statuses.get(candidate.story),
        view: views.get(candidate.story),
        unparsed: read.unparsed.includes(candidate.story),
        checkout: read.checkout,
        full: busy || chosen !== null,
        config,
      });
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
    const noSlot = slotsRefusal(deps.liveSlots, office, candidate.story, config.worktree.maxSlots);
    if (noSlot !== null) {
      refusals.push({ check: SLOTS_CHECK, message: noSlot });
      return { ...info(), story: null, skipped, launch: null, problem: null };
    }
    const launcher = deps.launcher;
    if (launcher === undefined) {
      return { ...info(), story, skipped, launch: null, problem: "this daemon starts no workers" };
    }
    if (launcher.adapterId !== config.worker.adapter) {
      return {
        ...info(),
        story,
        skipped,
        launch: null,
        problem: `worker.adapter ${config.worker.adapter} is not available; this daemon has ${launcher.adapterId}`,
      };
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
        ...verifyOf(handle),
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

  /** The command `work.run`, the read `work.preview` and the active-run check of `office.forget`. */
  get feature(): FeatureModule {
    return {
      name: "run",
      register: (registry) => {
        registry.addAsyncOfficeCommand({
          definition: workRun,
          handle: (ctx, args) => this.run(ctx, args),
        });
        registry.addAsyncRead({
          definition: workPreview,
          handle: (ctx, args) => this.preview(ctx, args),
        });
        registry.registerActiveWorkCheck(RUNS_CHECK, hasActiveRun);
      },
    };
  }
}

/** `RunBase` on the office's git and the Backlog CLI in `_base`. */
export function cliRunBase(deps: {
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  readonly cli: BacklogCli;
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
        const listed = parseList(
          (await runBacklog(deps.cli, checkout.path, ["task", "list", "--plain"])).stdout,
        );
        const statuses = new Map(listed.entries.map((entry) => [entry.id, entry.group]));
        const wanted = (
          ids ?? listed.entries.filter((e) => e.group === READY_STATUS).map((e) => e.id)
        ).filter((id) => statuses.has(id));
        const unparsed: string[] = [];
        const views = await mapLimited(wanted, VIEW_CONCURRENCY, async (id) => {
          try {
            const { stdout } = await runBacklog(deps.cli, checkout.path, [
              "task",
              "view",
              id,
              "--plain",
            ]);
            return parseView(stdout);
          } catch (error) {
            if (!(error instanceof BacklogParseError)) throw error;
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
  };
}
