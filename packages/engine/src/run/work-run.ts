// `work.run` (DIPO-48; 0005 section 4, 0012 sections 2 and 3, 0010 sections 2 and 7, 0013 section 2,
// 0014 section 4, 0008 section 9): pick one Ready story from `origin/<base>` (or the named ones),
// re-check it at pickup, claim it and record the run. Starting the worker is DIPO-74.
//
// Order:
// 1. Refusals of the whole command, each with the predicate's message: `maxAgents` above 1
//    (`args.invalid`, M0 runs one story at a time), an invalid configuration (`config.invalid`,
//    `configBlocksRuns`), an adapter hold (`run.refused`, `adapterHeld`), a failed fetch (the
//    retryable `git.fetchFailed`), statuses the base lacks (`run.refused`, `officeStatusesReady`)
//    and an unresolved verify (`run.refused`, `verifyResolved`). The daemon answers the retryable
//    `scheduling.off` in `safe` before the command reaches the engine.
// 2. The stories are indexed (DIPO-32) and the run profile refreshed (DIPO-72).
// 3. Without `stories`, the candidates are the Ready stories on the base in pickup order; with
//    `stories`, only those, in the order given.
// 4. Each candidate not started is a skip: its status (`notReady`, `parked`, `notRunnable`), a
//    live claim, a pending lane-b operation or a failed backlog PR check (`notRunnable`), the one
//    active run per office (`capacity`), a dependency not Done (`dependency`), or a failed pickup
//    check (`pickupCheckFailed`).
// 5. Before the claim the story contract is assembled (DIPO-47); `prompt.contractTooLarge` moves
//    the story to Refined like a failed pickup re-check.
// 6. The claim (DIPO-38) runs the pickup re-check (the Ready gate in `pickup` mode, stored through
//    DIPO-71) first inside its git queue item. A failed re-check moves the story to Refined through
//    the backlog lane and emits `story.state` with the gate messages in `detail`.
// 7. A claimed story gets its run row, its developer agent, the configuration snapshot and the
//    `setup` phase, and `work.assigned` and `work.phase setup` in the same transaction.

import { relative } from "node:path";

import {
  type AgentId,
  type ConfigError,
  type OfficeId,
  type Progress,
  RoleId,
  RunId,
  type SkipReason,
  StoryId,
  type StoryKey,
  type WorkRef,
  workRun,
} from "@dipsaus-orchestrator/contract";
import type { z } from "zod";

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
import type { AsyncCommandContext, CommandOutcome, FeatureModule } from "../commands/registry";
import type { OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import type { BaseCheckout } from "../gate/store/feature";
import type { GateMode, GateResult } from "../gate/types";
import type { OfficeGit } from "../git/office";
import { GitError } from "../git/runner";
import { assembleContract, ContractTooLargeError } from "../prompts/contract";
import { promptStoryOf } from "../prompts/story";
import { resolveStoryRef } from "../stories/keys";
import { mapLimited, VIEW_CONCURRENCY } from "../stories/read";
import { deriveStoryView, storyView } from "../views/story";
import { type AdapterHold, holdMessage } from "../workers/hold";
import type { ClaimOutcome, ClaimRequest } from "../worktree/claim";
import { liveClaimOf } from "../worktree/records";

import {
  activeRuns,
  appendRunStep,
  currentProfileId,
  hasActiveRun,
  insertRun,
  recordConfigSnapshot,
} from "./records";
import { openDependencies, pickupOrder, READY_STATUS, statusSkip } from "./select";

/** The role every M0 run starts with (0012 F12). */
export const DEVELOPER_ROLE = RoleId.parse("developer");

/** The status a failed pickup check moves a story back to (0012 section 3). */
export const REFINED_STATUS = "Refined";

/** The error code of a run refused by an office check (`details.check` names it). */
export const RUN_REFUSED = "run.refused";

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
  /** One story index pass (DIPO-32). */
  readonly stories: { indexStories(office: OfficeId): Promise<unknown> };
  /** The run profile (DIPO-72): refreshed before each run, then its verify refusal read. */
  readonly profiles: {
    ensureFreshProfile(office: OfficeId): Promise<unknown>;
    verifyResolved(office: OfficeHandle): string | null;
  };
  /** `officeStatusesReady` (DIPO-36): the refusal while the base lacks the run statuses. */
  readonly statuses: (office: OfficeId) => Promise<string | null>;
  /** `adapterHeld` (DIPO-43). */
  readonly adapterHeld: (adapter: string) => AdapterHold | null;
  readonly claims: { claim(office: OfficeId, request: ClaimRequest): Promise<ClaimOutcome> };
  readonly gates: {
    recordGateDecision(
      office: OfficeId,
      key: StoryKey,
      mode: GateMode,
      checkout?: BaseCheckout,
    ): Promise<{ readonly passed: boolean; readonly result: GateResult }>;
  };
  readonly lane: (office: OfficeId) => RunLane | undefined;
}

type Args = z.output<typeof workRun.args>;
type Result = z.input<typeof workRun.result>;
type Started = Result["started"][number];
type Skipped = Result["skipped"][number];

interface Candidate {
  readonly story: StoryId;
  readonly key: StoryKey;
}

/** `git.fetchFailed` and other git refusals as command errors; anything else as it is. */
function commandErrorOf(error: unknown): unknown {
  if (error instanceof GitError) return new CommandError(error.code, error.message, error.details);
  return error;
}

function refused(office: OfficeId, check: string, message: string): CommandError {
  return new CommandError(RUN_REFUSED, message, { office, check });
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
    const hold = deps.adapterHeld(config.worker.adapter);
    if (hold !== null) throw refused(office, "adapter", holdMessage(hold));

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
    const busy = activeRuns(handle).length > 0;
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
    // Not on the base: a draft, or a story archived or completed since the last index.
    if (c.status === undefined) return "notRunnable";
    const byStatus = statusSkip(c.status);
    if (byStatus !== null) return byStatus;
    if (liveClaimOf(handle, key) !== null) return "notRunnable";
    if (c.full) return "capacity";
    if (pendingLaneOp(handle, key) !== null) return "notRunnable";
    if (backlogCheckBlocked(handle, key) !== null) return "notRunnable";
    const view = c.view;
    if (view === undefined || c.unparsed) return this.#gateOutsideClaim(ctx, c.candidate);
    if (openDependencies(view).length > 0) return "dependency";

    let fields;
    try {
      fields = parseFieldBlock(view.description).fields;
    } catch {
      return this.#gateOutsideClaim(ctx, c.candidate);
    }
    const branch = fields.branch;
    const tier = readLabels(view.labels).tiers[0];
    const caps =
      tier === undefined ? undefined : c.config.tiers[tier as keyof OfficeConfig["tiers"]];
    if (typeof branch !== "string" || !branch.startsWith(`${story}/`) || caps === undefined) {
      return this.#gateOutsideClaim(ctx, c.candidate);
    }
    try {
      assembleContract(
        promptStoryOf(view, {
          dependencies: [],
          fields,
          taskFile: relative(c.checkout.path, view.file),
        }),
        c.config.prompt.contractMax,
      );
    } catch (error) {
      if (!(error instanceof ContractTooLargeError)) throw error;
      await this.#toRefined(ctx, c.candidate, [
        `${story} cannot start: ${error.code}: ${error.message}`,
      ]);
      return "pickupCheckFailed";
    }

    const runId = RunId.parse(ctx.ids.next("run"));
    let failures: string[] | null = null;
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
          failures = decision.result.failures.map((failure) => failure.message);
          return { ok: false, reason: "pickupCheckFailed", notice: null, code: null };
        },
      });
    } catch (error) {
      throw commandErrorOf(error);
    }
    if (!outcome.ok) {
      if (failures !== null) await this.#toRefined(ctx, c.candidate, failures);
      return outcome.reason;
    }

    const agent = ctx.ids.next("agt") as AgentId;
    const work: WorkRef = {
      story,
      key,
      run: runId,
      agent,
      role: DEVELOPER_ROLE,
      tier: tier as string,
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
        tier: tier as string,
        role: DEVELOPER_ROLE,
        model: caps.model,
        startSha: outcome.claim.startSha,
        branch: outcome.claim.branch,
        worktree: outcome.claim.worktree,
        slot: null,
        budgetUnit: "tokens",
        budgetLimit: caps.budgetTokens,
        loopCap: caps.loops,
        reviewRoundCap: null,
        configHash: c.configHash,
        overrideKeys: null,
        runProfileId: currentProfileId(handle),
        startedAt: at,
      });
      handle.run(
        `insert into agents (office_id, agent_id, run_id, role, model, started_at)
         values ($office_id, $agent, $run, $role, $model, $at)`,
        { agent, run: runId, role: DEVELOPER_ROLE, model: caps.model, at },
      );
      appendRunStep(handle, runId, "phase", "setup", at);
      return [
        { type: "work.assigned", key, run: runId, delta: { work } },
        { type: "work.phase", key, run: runId, delta: { work, phase: "setup", progress } },
      ];
    });
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
    await this.#toRefined(
      ctx,
      candidate,
      decision.result.failures.map((failure) => failure.message),
    );
    return "pickupCheckFailed";
  }

  /**
   * Moves a story back to Refined through the backlog lane (journaled, then flushed into the
   * office's backlog PR) and emits `story.state` with `detail`. A lane that refuses the move puts
   * a notice on the office instead.
   */
  async #toRefined(
    ctx: AsyncCommandContext,
    candidate: Candidate,
    detail: readonly string[],
  ): Promise<void> {
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

  /** The command `work.run` and the active-run check of `office.forget`. */
  get feature(): FeatureModule {
    return {
      name: "run",
      register: (registry) => {
        registry.addAsyncOfficeCommand({
          definition: workRun,
          handle: (ctx, args) => this.run(ctx, args),
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
