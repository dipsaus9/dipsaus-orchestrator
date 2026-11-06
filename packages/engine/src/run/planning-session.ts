// The maintainer's planning session (DIPO-447, 0008, 0002): a model session in a read-only box that the
// maintainer talks to turn by turn, until they end it. It implements `planning.start`,
// `planning.message` and `planning.end` through the worker port only, so nothing here names the model:
//
// - `planning.start { kind, goal }` opens it: a `runs` row of kind `session`, role `planner`, with
//   no story, branch or key, then a box made as a reviewer's (`BoxWorkers.planning`): a read-only
//   copy of the base branch's tip with the backlog, nothing mounted, the box firewall and web
//   proxy, and the model proxy. The worker port plans kind `planning`, which has only the reading,
//   search and web tools, the office `planning` block's model and effort, and no structured
//   output. Its first message is the kind and goal with the facts code knows: the open drafts, the
//   desk and the recent story runs (`planningFirstMessage`). The reply comes once its host started.
// - An office has at most one open planning session (`planning.open` while one is open or
//   starting), and it holds no run slot: it is a session run, which the places never count (0002).
// - `planning.message { text }` sends the maintainer's text to the open session's stdin: its next
//   turn. Ingestion streams each answer as `planning.output` events and the spend as
//   `planning.updated` (usage at most once a second, and at each turn end), with the planning view,
//   since the session has no story and so no `WorkRef`. The model proxy counts the box's requests
//   against the run, with no cap (`proxied-usage.ts`), so the spend counts in the office's usage.
// - Waiting for the maintainer is no stall: at each turn end the watchdog's quiet and stuck waits
//   stop (`Watchdog.waiting`) until the next message starts them again (`Watchdog.working`), and the
//   session has no minute or token cap. A session that waits `planning.idleHours` for a message ends
//   by itself (`idle`).
// - `planning.end` ends it (`maintainer`): a waiting session gets its stdin closed, a working one
//   the stop, and the run ends once its exit is read, or two minutes later without one. Its box is
//   deleted then, and `planning.ended` and `run.ended` follow. At daemon stop every open session
//   gets the stop and ends `daemon-stopped`; at daemon start a planning run a stopped daemon left
//   open is ended (`recover`).

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  AgentId,
  type Clock,
  type DeskItem,
  type IdSource,
  type OfficeId,
  type PlanningEndReason,
  type PlanningKind,
  planningEnd,
  planningMessage,
  planningStart,
  type PlanningState,
  type PlanningView,
  RunId,
  type UsageTotals,
} from "@dipsaus-orchestrator/contract";
import type { z } from "zod";

import { baseCommit } from "../box/image";
import { REVIEW_CODE_DIR } from "../box/review-box";
import type { BoxSession, BoxWorkers } from "../box/workers";
import { appendEntries, type NewEntry } from "../changelog/log";
import { CommandError } from "../commands/errors";
import type { AsyncCommandContext, CommandOutcome, FeatureModule } from "../commands/registry";
import type { OfficeConfig } from "../config";
import { configHash } from "../config/merge";
import type { OfficeHandle } from "../db/office";
import type { OfficeGit } from "../git/office";
import { Ingestor, type IngestAdapter, type IngestedExit } from "../ingest/ingestor";
import type { StorylessEvents } from "../ingest/pending";
import { ensurePrivateDir } from "../platform/paths";
import { promptParts, recordPromptParts, recordPromptTexts } from "../prompts/parts";
import { renderSystemFile } from "../prompts/system";
import { rendered, renderTemplate, TASK_TEMPLATES } from "../prompts/templates";
import { recordAgent } from "../records/agents";
import { PLANNER_ROLE } from "../records/caps";
import type { RunEnd } from "../records/lifecycle";
import { currentProfileId, endRun, insertRun, recordConfigSnapshot } from "../records/run-records";
import { activeSignals } from "../records/signals";
import { readUsage } from "../records/usage";
import type { LaunchedHost } from "../records/worker-hosts";
import { activeStoryViews } from "../views/story";
import type { RunLaunchPaths, WorkerPort } from "../workers/port";
import { PlanError, type HostOp, type WorkerEvent, type WorkerSpec } from "../workers/types";

import type { RunSteering } from "./control-types";
import { claimHost, connectWhenBound } from "./hosts";
import { type HostStarter, runLaunchPaths } from "./launch";
import { sessionUuid } from "./prompts";
import { prepareRunTempDirs } from "./temp-dirs";
import { Watchdog, type WatchdogTimeouts } from "./watchdog";

type StartArgs = z.output<typeof planningStart.args>;
type StartResult = z.input<typeof planningStart.result>;
type MessageArgs = z.output<typeof planningMessage.args>;
type MessageResult = z.input<typeof planningMessage.result>;
type EndResult = z.input<typeof planningEnd.result>;

/** The session's system file in its run directory. */
export const PLANNING_SYSTEM_FILE = "system-planning.md";
/** How long after the end dipo waits for the session's exit before it ends the run anyway. */
export const PLANNING_EXIT_GRACE_MS = 2 * 60_000;
/** Milliseconds from an end to SIGTERM and to SIGKILL, when closing stdin did not end it. */
export const PLANNING_SIGTERM_AFTER_MS = 10_000;
export const PLANNING_SIGKILL_AFTER_MS = 30_000;
/** The daemon's recovery step that ends the planning runs a stopped daemon left open. */
export const PLANNING_RECOVERY_STEP = "planning-recover";
/** The most story runs the first message lists. */
export const PLANNING_RECENT_RUNS = 10;

const HOUR_MS = 60 * 60_000;

/** One story run as the first message lists it. */
export interface RecentRun {
  readonly story: string;
  readonly tier: string | null;
  /** How it ended (done, parked, dropped), or null while it runs. */
  readonly ending: string | null;
  readonly startedAt: number;
  /** Input plus output plus cache-creation tokens (0008). */
  readonly tokens: number;
}

/** The facts the first message gives the session (DIPO-447). */
export interface PlanningFacts {
  readonly kind: PlanningKind;
  readonly goal: string;
  readonly drafts: readonly { readonly story: string; readonly title: string }[];
  readonly desk: readonly Pick<DeskItem, "kind" | "story" | "detail">[];
  readonly runs: readonly RecentRun[];
  /** The base branch's commit the read-only copy holds. */
  readonly commit: string;
}

const listOr = (lines: readonly string[], none: string): string =>
  lines.length === 0 ? none : lines.join("\n");

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Pure: the session's first message, as text, from the facts code knows. */
export function planningFirstMessage(facts: PlanningFacts): string {
  return renderTemplate(TASK_TEMPLATES.planning, {
    kind: facts.kind,
    goal: facts.goal,
    drafts: listOr(
      facts.drafts.map((draft) => `- ${draft.story}: ${draft.title}`),
      "No open drafts.",
    ),
    desk: listOr(
      facts.desk.map(
        (item) =>
          `- ${item.kind}${item.story === undefined ? "" : ` ${item.story}`}: ${item.detail}`,
      ),
      "Nothing waits on the maintainer.",
    ),
    runs: listOr(
      facts.runs.map(
        (run) =>
          `- ${run.story}${run.tier === null ? "" : ` (${run.tier})`}: ${run.ending ?? "running"}, ${run.tokens.toLocaleString("en-US")} tokens, started ${day(run.startedAt)}`,
      ),
      "No story runs yet.",
    ),
    commit: rendered(facts.commit),
    dir: rendered(REVIEW_CODE_DIR),
  });
}

/** The latest story runs of `office`, newest first, with their spend. */
export function recentStoryRuns(office: OfficeHandle, limit = PLANNING_RECENT_RUNS): RecentRun[] {
  return office
    .all<{
      story_id: string;
      tier: string | null;
      end_kind: string | null;
      started_at: number;
      tokens: number;
    }>(
      `select r.story_id, r.tier, r.end_kind, r.started_at,
         coalesce((select sum(u.input + u.output + u.cache_create) from usage_totals u
                    where u.office_id = r.office_id and u.run_id = r.run_id), 0) as tokens
       from runs r
       where r.office_id = $office_id and r.kind = 'story' and r.story_id is not null
       order by r.started_at desc, r.rowid desc limit $limit`,
      { limit },
    )
    .map((row) => ({
      story: row.story_id,
      tier: row.tier,
      ending: row.end_kind,
      startedAt: row.started_at,
      tokens: row.tokens,
    }));
}

export interface PlanningSessionsDeps {
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly offices: {
    get(office: OfficeId): OfficeHandle | undefined;
    config(office: OfficeId): OfficeConfig | undefined;
  };
  readonly worker: WorkerPort;
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  /** The planning boxes (`BoxWorkers`); without them no planning session starts. */
  readonly boxes?: Pick<BoxWorkers, "planning" | "endPlanning">;
  readonly hosts: HostStarter;
  /** Sends host ops to the running session: each message, the end. */
  readonly steering: RunSteering;
  /** The desk of the office now (`office.desk`), for the first message; none without it. */
  readonly desk?: (office: OfficeHandle, now: number) => readonly DeskItem[];
  /** The base branch's tip the copy holds; `baseCommit` by default. */
  readonly baseCommit?: (git: OfficeGit) => Promise<string>;
  readonly runtimeDir: string;
  /** dipo's temp root: the run temp directories. */
  readonly tmpRoot: string;
  readonly tempOwner?: () => string | undefined;
  readonly onChanged?: (office: OfficeId) => void;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

/** One open planning session of this daemon. */
interface Open {
  readonly office: OfficeId;
  readonly handle: OfficeHandle;
  readonly run: RunId;
  readonly agent: AgentId;
  readonly kind: PlanningKind;
  readonly goal: string;
  readonly model: string;
  readonly startedAt: number;
  state: PlanningState;
  turns: number;
  lastOutputAt: number | null;
  /** Why it ends, once its end was asked for or decided. */
  ending: { readonly reason: PlanningEndReason; readonly detail?: string } | null;
  idle: ReturnType<Clock["setTimeout"]> | null;
  grace: ReturnType<Clock["setTimeout"]> | null;
  ingestor: Ingestor | null;
  settled: boolean;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const ZERO_TOTALS: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreateTokens: 0,
  cacheReadTokens: 0,
  turns: 0,
  elapsedMs: 0,
};

const iso = (ms: number) => new Date(ms).toISOString();

function notOpen(why: string): CommandError {
  return new CommandError("planning.notOpen", `There is no open planning session: ${why}.`);
}

/** The planning sessions of every office: at most one open per office. */
export class PlanningSessions {
  readonly #deps: PlanningSessionsDeps;
  /** The open session of each office, from its start until it ended. */
  readonly #open = new Map<OfficeId, Open>();
  /** The offices whose session start is under way. */
  readonly #starting = new Set<OfficeId>();
  readonly #watchdog: Watchdog;

  constructor(deps: PlanningSessionsDeps) {
    this.#deps = deps;
    this.#watchdog = new Watchdog({
      clock: deps.clock,
      timeouts: (office): WatchdogTimeouts | undefined => deps.offices.config(office)?.timeouts,
      onAppended: (office) => deps.onChanged?.(office),
      // Quiet and stuck while it works on an answer: the planning view's health says so.
      storyless: (handle, run) => {
        const open = [...this.#open.values()].find((candidate) => candidate.run === run);
        return open === undefined || open.handle !== handle ? [] : [this.#updated(open)];
      },
    });
  }

  /** `planning.start`, `planning.message` and `planning.end` on the waiting command path. */
  get feature(): FeatureModule {
    return {
      name: "run",
      register: (registry) => {
        registry.addAsyncOfficeCommand({
          definition: planningStart,
          handle: (ctx, args) => this.start(ctx, args),
        });
        registry.addAsyncOfficeCommand({
          definition: planningMessage,
          handle: (ctx, args) => this.message(ctx, args),
        });
        registry.addAsyncOfficeCommand({
          definition: planningEnd,
          handle: (ctx) => this.end(ctx),
        });
      },
    };
  }

  /** The view of the open planning session of `office`; null without one. */
  view(office: OfficeId): PlanningView | null {
    const open = this.#open.get(office);
    return open === undefined ? null : open.handle.deferred(() => this.#viewOf(open));
  }

  /** The run ids of the planning sessions this daemon follows now. */
  liveRuns(): string[] {
    return [...this.#open.values()].map((open) => open.run);
  }

  async start(ctx: AsyncCommandContext, args: StartArgs): Promise<CommandOutcome<StartResult>> {
    const office = ctx.office.officeId as OfficeId;
    const open = this.#open.get(office);
    if (open !== undefined || this.#starting.has(office)) {
      throw new CommandError(
        "planning.open",
        `The office has an open planning session${open === undefined ? "" : ` (${open.run})`}: end it with planning.end first.`,
        open === undefined ? {} : { run: open.run },
      );
    }
    this.#starting.add(office);
    try {
      const view = await this.#start(ctx.office, office, args);
      return { result: { run: view.run, view }, changed: true };
    } finally {
      this.#starting.delete(office);
    }
  }

  async message(
    ctx: AsyncCommandContext,
    args: MessageArgs,
  ): Promise<CommandOutcome<MessageResult>> {
    const office = ctx.office.officeId as OfficeId;
    const open = this.#open.get(office);
    if (open === undefined) throw notOpen("start one with planning.start");
    if (open.ending !== null || open.settled) throw notOpen(`${open.run} is ending`);
    // The maintainer's text is the next user message: read after the answer in progress, if any.
    const sent = await this.#send(
      open,
      this.#deps.worker.encode({ kind: "answer", text: args.text }),
    );
    if (!sent) throw notOpen(`${open.run} could not be reached`);
    this.#clearIdle(open);
    this.#watchdog.working(open.run);
    open.state = "working";
    this.#append(open, () => [this.#updated(open)]);
    return { result: { run: open.run, delivered: "next-turn" }, changed: true };
  }

  async end(ctx: AsyncCommandContext): Promise<CommandOutcome<EndResult>> {
    const office = ctx.office.officeId as OfficeId;
    const open = this.#open.get(office);
    if (open === undefined) throw notOpen("none was started");
    const reason = open.ending?.reason ?? "maintainer";
    await this.#stop(open, { reason });
    return { result: { run: open.run, ended: reason }, changed: true };
  }

  /**
   * Daemon stop: every open session gets the stop and ends `daemon-stopped` at once, since no
   * daemon reads its exit after the stop. Never rejects.
   */
  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.#open.values()].map(async (open) => {
        await this.#stop(open, { reason: "daemon-stopped" });
        await this.#finish(open, null);
      }),
    );
    this.#watchdog.close();
  }

  /**
   * Daemon start: a planning run of the loaded `offices` that a stopped daemon left open is ended
   * dropped; its box went with that daemon's stop or goes with the start sweep. Returns how many.
   */
  recover(offices: readonly OfficeId[]): number {
    let ended = 0;
    const at = this.#deps.clock.now();
    for (const office of offices) {
      const handle = this.#deps.offices.get(office);
      if (handle === undefined) continue;
      const followed = new Set(this.liveRuns());
      const left = handle
        .all<{ run_id: string }>(
          `select run_id from runs where office_id = $office_id and kind = 'session'
             and role = $role and ended_at is null`,
          { role: PLANNER_ROLE },
        )
        .filter((row) => !followed.has(row.run_id));
      for (const row of left) {
        handle.immediate(() => endRun(handle, RunId.parse(row.run_id), at, "dropped"));
        ended += 1;
      }
      if (left.length > 0) this.#deps.onChanged?.(office);
    }
    return ended;
  }

  // ---- start ---------------------------------------------------------------------------------

  async #start(handle: OfficeHandle, office: OfficeId, args: StartArgs): Promise<PlanningView> {
    const deps = this.#deps;
    const boxes = deps.boxes;
    const config = deps.offices.config(office);
    const git = deps.git(office);
    if (config === undefined || git === undefined) {
      throw new CommandError("planning.startFailed", `Office ${office} is not loaded.`);
    }
    if (boxes === undefined) {
      throw new CommandError(
        "planning.startFailed",
        "This daemon has no box backend, and a planning session runs only in a read-only box of its own (0008).",
      );
    }
    const run = RunId.parse(deps.ids.next("run"));
    const agent = AgentId.parse(deps.ids.next("agt"));
    const settings = config.planning;
    const startedAt = deps.clock.now();
    const open: Open = {
      office,
      handle,
      run,
      agent,
      kind: args.kind,
      goal: args.goal,
      model: settings.model,
      startedAt,
      state: "starting",
      turns: 0,
      lastOutputAt: null,
      ending: null,
      idle: null,
      grace: null,
      ingestor: null,
      settled: false,
    };
    const hash = configHash(config);
    handle.immediate(() => {
      recordConfigSnapshot(handle, hash, config, startedAt);
      insertRun(handle, {
        runId: run,
        kind: "session",
        key: null,
        story: null,
        tier: null,
        role: PLANNER_ROLE,
        model: settings.model,
        startSha: null,
        branch: null,
        budgetUnit: "tokens",
        // No run cap (DIPO-447): the session ends when the maintainer ends it.
        budgetLimit: 0,
        loopCap: 0,
        maxTurns: settings.maxTurns,
        maxMinutes: null,
        reviewRoundCap: null,
        configHash: hash,
        overrideKeys: null,
        runProfileId: currentProfileId(handle),
        startedAt,
      });
    });
    this.#open.set(office, open);
    this.#append(open, () => [
      { type: "planning.started", run, delta: { run, view: this.#viewOf(open) } },
    ]);
    try {
      await this.#launch(open, config, git, boxes);
    } catch (error) {
      const detail = error instanceof CommandError ? error.message : messageOf(error);
      open.ending = { reason: "start-failed", detail };
      await this.#finish(open, null);
      if (error instanceof CommandError) throw error;
      throw new CommandError(
        "planning.startFailed",
        `The planning session did not start: ${detail}`,
        { run },
      );
    }
    return handle.deferred(() => this.#viewOf(open));
  }

  /** The session's spec and system file: its first message holds the facts code knows. */
  #spec(
    open: Open,
    config: OfficeConfig,
    paths: RunLaunchPaths,
    commit: string,
  ): { readonly spec: WorkerSpec; readonly systemFile: string } {
    const deps = this.#deps;
    const { handle, run, agent } = open;
    const settings = config.planning;
    const now = deps.clock.now();
    const taskMessage = planningFirstMessage(
      handle.deferred(() => ({
        kind: open.kind,
        goal: open.goal,
        drafts: activeStoryViews(handle)
          .filter((view) => view.lifecycle === "Draft")
          .map((view) => ({ story: view.story, title: view.title })),
        desk: deps.desk?.(handle, now) ?? [],
        runs: recentStoryRuns(handle),
        commit,
      })),
    );
    const systemFile = renderSystemFile("planning-box", "planner");
    const spec: WorkerSpec = {
      run,
      agent,
      kind: "planning",
      workdir: paths.runDir,
      model: settings.model,
      effort: settings.effort,
      // Only the turns of one answer: no token or minute cap holds a planning session (DIPO-447).
      caps: { budgetTokens: 0, maxTurns: settings.maxTurns, maxMinutes: 0 },
      systemFile: join(paths.runDir, PLANNING_SYSTEM_FILE),
      taskMessage,
      web: false,
      session: { id: sessionUuid(agent) },
      // A planning session answers in text: its plan passes no schema.
      reportSchema: {},
    };
    return { spec, systemFile };
  }

  async #launch(
    open: Open,
    config: OfficeConfig,
    git: OfficeGit,
    boxes: NonNullable<PlanningSessionsDeps["boxes"]>,
  ): Promise<void> {
    const deps = this.#deps;
    const { handle, run, agent } = open;
    const paths = runLaunchPaths(git, deps, run);
    const commit = await (deps.baseCommit ?? defaultBaseCommit)(git);
    const { spec, systemFile } = this.#spec(open, config, paths, commit);
    try {
      ensurePrivateDir(paths.runDir);
      prepareRunTempDirs(paths, run, deps.tempOwner?.());
      writeFileSync(spec.systemFile, systemFile, { mode: 0o600 });
    } catch (error) {
      throw new Error(`the run directory could not be prepared: ${messageOf(error)}`, {
        cause: error,
      });
    }
    let place: BoxSession;
    try {
      place = await boxes.planning({
        office: open.office,
        runId: run,
        agent,
        git,
        commit,
        systemFile: spec.systemFile,
      });
    } catch (error) {
      throw new Error(`its box could not be made: ${messageOf(error)}`, { cause: error });
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
      throw new Error(
        error instanceof PlanError
          ? `the launch plan refused it: ${error.message}`
          : messageOf(error),
        { cause: error },
      );
    }
    if (!prepared.ok) {
      throw new Error(
        `a launch check holds the adapter: ${prepared.pause.failures.map((f) => f.detail).join("; ")}`,
      );
    }
    let host: LaunchedHost;
    try {
      host = await deps.hosts.start(handle, {
        runId: run,
        agentId: agent,
        officeDir: paths.officeDir,
        plan: prepared.plan,
        record: () => this.#record(open, spec, systemFile, config),
      });
    } catch (error) {
      throw new Error(`its host did not start: ${messageOf(error)}`, { cause: error });
    }
    open.state = "working";
    this.#follow(open, spec, paths, config, host);
    this.#append(open, () => [this.#updated(open)]);
  }

  /** The session's agent and prompt parts, in the transaction that records its host. */
  #record(open: Open, spec: WorkerSpec, systemFile: string, config: OfficeConfig): void {
    const deps = this.#deps;
    const { handle, run, agent } = open;
    const settings = config.planning;
    const { taskMessage } = spec;
    recordAgent(handle, {
      agentId: agent,
      runId: run,
      role: PLANNER_ROLE,
      model: settings.model,
      effort: settings.effort,
      sessionId: spec.session.id,
      startedAt: deps.clock.now(),
    });
    recordPromptParts(handle, run, agent, promptParts(systemFile, taskMessage, []), deps.clock);
    recordPromptTexts(
      handle,
      run,
      agent,
      [
        { part: "system", text: systemFile },
        { part: "message", text: taskMessage },
      ],
      config,
      deps.clock,
    );
  }

  // ---- following -----------------------------------------------------------------------------

  /** Ingests the session's events until its exit; claims its host (DIPO-386). */
  #follow(
    open: Open,
    spec: WorkerSpec,
    paths: RunLaunchPaths,
    config: OfficeConfig,
    host: LaunchedHost,
  ): void {
    const deps = this.#deps;
    const { handle, run, agent } = open;
    const storyless: StorylessEvents = {
      output: (range) => {
        open.lastOutputAt = deps.clock.now();
        return { type: "planning.output", run, delta: { run, ...range, view: this.#viewOf(open) } };
      },
      usage: () => this.#updated(open),
    };
    const ingestor = new Ingestor({
      office: handle,
      clock: deps.clock,
      hooks: {
        onLines: () => this.#watchdog.lineSeen(run),
        onWorkerEvents: (_run, _agent, events: readonly WorkerEvent[]) => {
          for (const event of events) {
            if (event.t === "initRejected" || event.t === "startRefused") {
              void this.#stop(open, {
                reason: open.turns === 0 ? "start-failed" : "exited",
                detail: event.reason,
              });
            }
            if (event.t === "turn") this.#turnEnded(open);
          }
        },
        onEnded: (_run, _agent, end) => void this.#finish(open, end),
        onAppended: () => deps.onChanged?.(open.office),
      },
      warn: (message, fields) => deps.warn?.(message, fields),
    });
    open.ingestor = ingestor;
    this.#watchdog.track(handle, run);
    void this.#claim(host, () => open.settled);
    try {
      ingestor.track({
        run,
        agent,
        role: PLANNER_ROLE,
        tier: "",
        budgetLimit: 0,
        model: spec.model,
        adapter: deps.worker.adapter(paths, config) as IngestAdapter,
        initialState: deps.worker.initialState(spec),
        storyless,
      });
    } catch (error) {
      deps.warn?.("ingesting a planning session failed", { run, reason: messageOf(error) });
      void this.#stop(open, { reason: "exited", detail: "its events could not be ingested" });
    }
  }

  /** An answer ended: the session waits for the maintainer, with no watchdog wait running. */
  #turnEnded(open: Open): void {
    if (open.settled) return;
    open.turns += 1;
    if (open.ending !== null) return;
    open.state = "waiting";
    this.#watchdog.waiting(open.run);
    this.#clearIdle(open);
    const settings = this.#deps.offices.config(open.office)?.planning;
    const hours = settings?.idleHours ?? 24;
    open.idle = this.#deps.clock.setTimeout(() => {
      open.idle = null;
      void this.#stop(open, { reason: "idle" });
    }, hours * HOUR_MS);
    this.#append(open, () => [this.#updated(open)]);
  }

  /**
   * Ends the session's worker: a waiting one by closing its stdin, a working one with the stop,
   * then signals if it does not exit. The run ends once its exit is read, or after
   * `PLANNING_EXIT_GRACE_MS`. Once per session.
   */
  async #stop(
    open: Open,
    ending: { readonly reason: PlanningEndReason; readonly detail?: string },
  ): Promise<void> {
    if (open.settled || open.ending !== null) return;
    open.ending = ending;
    this.#clearIdle(open);
    this.#watchdog.untrack(open.run);
    open.grace = this.#deps.clock.setTimeout(() => {
      open.grace = null;
      void this.#finish(open, null);
    }, PLANNING_EXIT_GRACE_MS);
    const ops: readonly HostOp[] =
      open.state === "waiting"
        ? [
            { closeStdin: true },
            { signal: "SIGTERM", afterMs: PLANNING_SIGTERM_AFTER_MS },
            { signal: "SIGKILL", afterMs: PLANNING_SIGKILL_AFTER_MS },
          ]
        : this.#deps.worker.encode({ kind: "stop" });
    await this.#send(open, ops);
  }

  /** Sends `ops` to the session's host; false when they did not reach it. */
  async #send(open: Open, ops: readonly HostOp[]): Promise<boolean> {
    try {
      const sent = await this.#deps.steering.send(open.handle, open.run, ops);
      if (!sent.ok) {
        this.#deps.warn?.("sending to a planning session failed", {
          run: open.run,
          reason: sent.reason,
        });
      }
      return sent.ok;
    } catch (error) {
      this.#deps.warn?.("sending to a planning session failed", {
        run: open.run,
        reason: messageOf(error),
      });
      return false;
    }
  }

  /**
   * The session is over: its run ends (done when the maintainer, the idle end or a clean exit
   * ended it, else dropped), its box is deleted, and `planning.ended` follows. Once per session.
   */
  async #finish(open: Open, end: IngestedExit | null): Promise<void> {
    if (open.settled) return;
    open.settled = true;
    this.#clearIdle(open);
    if (open.grace !== null) this.#deps.clock.clearTimeout(open.grace);
    open.grace = null;
    this.#watchdog.untrack(open.run);
    const ingestor = open.ingestor;
    // Stopped after the exit's pass committed, outside its hooks.
    if (ingestor !== null) queueMicrotask(() => ingestor.close());
    const clean = end !== null && end.exit.code === 0 && end.exit.signal === null;
    const ending = open.ending ?? {
      reason: "exited" as const,
      ...(end === null ? {} : { detail: `its worker exited with code ${end.exit.code}` }),
    };
    open.ending = ending;
    open.state = "ended";
    const done =
      ending.reason === "maintainer" ||
      ending.reason === "idle" ||
      (ending.reason === "exited" && clean);
    const runEnd: RunEnd = done ? "done" : "dropped";
    const at = this.#deps.clock.now();
    const { handle } = open;
    try {
      handle.immediate(() => {
        endRun(handle, open.run, at, runEnd);
        appendEntries(
          handle,
          [
            {
              type: "planning.ended",
              run: open.run,
              delta: { run: open.run, reason: ending.reason, view: this.#viewOf(open, at) },
            },
          ],
          { at },
        );
      });
    } catch (error) {
      this.#deps.warn?.("ending a planning run failed", {
        run: open.run,
        reason: messageOf(error),
      });
    }
    if (this.#open.get(open.office) === open) this.#open.delete(open.office);
    this.#deps.onChanged?.(open.office);
    await this.#deps.boxes?.endPlanning(open.agent);
  }

  #clearIdle(open: Open): void {
    if (open.idle !== null) this.#deps.clock.clearTimeout(open.idle);
    open.idle = null;
  }

  /** Connects to the session's new host and claims it; says so when it could not (DIPO-386). */
  async #claim(host: LaunchedHost, settled: () => boolean): Promise<void> {
    const deps = this.#deps;
    const unclaimed = (reason: string) =>
      deps.warn?.("the planning session's host was not claimed; it stops at its launch deadline", {
        run: host.runId,
        reason,
      });
    try {
      const connected = await connectWhenBound(host, deps.clock, settled);
      if (!connected.ok) {
        if (!settled()) unclaimed(connected.reason);
        return;
      }
      try {
        const refused = await claimHost(connected.client, host.pid);
        if (refused !== null) unclaimed(refused);
      } finally {
        connected.client.close();
      }
    } catch (error) {
      unclaimed(messageOf(error));
    }
  }

  // ---- views and entries ---------------------------------------------------------------------

  /** Appends the entries `build` returns in one transaction, and tells the subscribers. */
  #append(open: Open, build: () => readonly NewEntry[]): void {
    const at = this.#deps.clock.now();
    const { handle } = open;
    const appended = handle.immediate(() => {
      const entries = build();
      appendEntries(handle, entries, { at });
      return entries.length;
    });
    if (appended > 0) this.#deps.onChanged?.(open.office);
  }

  /** `planning.updated` with the view now; inside the caller's transaction. */
  #updated(open: Open): NewEntry {
    return {
      type: "planning.updated",
      run: open.run,
      delta: { run: open.run, view: this.#viewOf(open) },
    };
  }

  /** The planning view of `open`, from its state and the stored usage and signals. */
  #viewOf(open: Open, endedAt?: number): PlanningView {
    const { handle } = open;
    const usage =
      open.state === "starting"
        ? ZERO_TOTALS
        : readUsage(handle, {
            run: open.run,
            agent: open.agent,
            role: PLANNER_ROLE,
            tier: "",
            budgetLimit: 0,
          }).run;
    const noOutput = activeSignals(handle, open.run).find((fact) => fact.signal === "no-output");
    return {
      run: open.run,
      ...(open.state === "starting" ? {} : { agent: open.agent }),
      kind: open.kind,
      goal: open.goal,
      model: open.model,
      state: open.state,
      // Quiet or stuck only while it works on an answer, never while it waits (DIPO-447).
      ...(open.state === "working"
        ? {
            health: noOutput === undefined ? "busy" : noOutput.stuckAt === null ? "quiet" : "stuck",
          }
        : {}),
      turns: open.turns,
      usage,
      startedAt: iso(open.startedAt),
      ...(open.lastOutputAt === null ? {} : { lastOutputAt: iso(open.lastOutputAt) }),
      ...(endedAt === undefined ? {} : { endedAt: iso(endedAt) }),
      ...(open.ending === null || open.state !== "ended" ? {} : { ended: open.ending.reason }),
      ...(open.ending?.detail === undefined || open.state !== "ended"
        ? {}
        : { detail: open.ending.detail }),
    };
  }
}

/** The tip of `<remote>/<base>`, the commit the planning copy holds. */
async function defaultBaseCommit(git: OfficeGit): Promise<string> {
  const { commit } = await git.run((session) => baseCommit(git, session));
  return commit;
}
