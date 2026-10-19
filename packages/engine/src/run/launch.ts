// Starting the worker of a claimed run (DIPO-74; 0010 sections 7 and 8, 0008 sections 2, 7 and 9,
// 0014 section 1, 0006 decision 8). `work.run` (DIPO-48) claims; this file does the rest:
//
// 1. `prepare` is the claim's setup (`ClaimRequest.setup`), so it runs after the worktree, its lock
//    and the claim record and before the claim commit. It runs DIPO-39's setup (files, port slot,
//    install), renders the system file and the task message (DIPO-47) into the run directory,
//    builds the `WorkerSpec` from the tier (model, effort, caps) with an engine-made session id,
//    and plans the launch through the adapter's launch checks (DIPO-43). A failed setup, a
//    refused launch check (the adapter hold stays) or a plan that refuses a path fails the setup,
//    so the claim is rolled back as for a setup failure: worktree removed, a new branch deleted at
//    its start, the story still Ready, a `pickupCheckFailed` skip. A refused path also puts a
//    `run.planRefused` notice on the office that names the path and the character.
// 2. `start` runs after the claim commit and the run row: it starts the worker host with the plan,
//    starts ingestion of the host's events (DIPO-45) and records the `build` phase with
//    `work.phase build`. A host that does not start ends the run as `start-failed`.
// 3. `preview` builds the same spec and plan for `work.preview` (the dry run), on `_base`, with
//    placeholders for the run id and session, and writes nothing.

import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type {
  AgentId,
  FieldBlock,
  OfficeId,
  Progress,
  RunId,
  WorkerLaunchPreview,
  WorkRef,
} from "@dipsaus-orchestrator/contract";

import type { PlainTask } from "../backlog/plain";
import type { NewEntry } from "../changelog/log";
import type { AsyncCommandContext } from "../commands/registry";
import type { OfficeConfig } from "../config";
import type { Workspace } from "../context/types";
import { gitWorkspace } from "../context/workspace";
import type { OfficeHandle } from "../db/office";
import type { GitLocation } from "../git/hardened";
import type { OfficeGit } from "../git/office";
import { hostSocketPath } from "../host/protocol";
import type { IngestAdapter, IngestTarget } from "../ingest/ingestor";
import { officeDirectory } from "../office/marker";
import { ensurePrivateDir } from "../platform/paths";
import { type PromptPart, type PromptText, promptParts } from "../prompts/parts";
import type { LaunchedHost } from "../runs/worker-hosts";
import { runDirectory } from "../runs/worker-hosts";
import { holdMessage } from "../workers/hold";
import type { RunLaunchPaths, VerifyCommands, WorkerPort } from "../workers/port";
import { PlanError, type Caps, type LaunchPlan, type WorkerSpec } from "../workers/types";
import type { ClaimSetupDone, ClaimSetupFailed } from "../worktree/claim";
import type { ClaimRecord } from "../worktree/records";
import type { SetupOutcome } from "../worktree/setup";

import { withWorkViews } from "../views/work";

import type { BackstopSnapshot } from "./backstop";
import { markPhase } from "./markers";
import { type RunPrompts, renderRunPrompts, sessionUuid, SYSTEM_FILE } from "./prompts";
import { storeBackstopSnapshot } from "./records";
import {
  prepareRunTempDirs,
  removeShortTempDir,
  runTempDir,
  SHORT_TEMP_PREFIX,
  shortTempDir,
} from "./temp-dirs";

/** The tools of the developer role (0008 section 2, "Tools and rules"). */
export const DEVELOPER_TOOLS: readonly string[] = ["Read", "Edit", "Write", "Glob", "Grep", "Bash"];

/** The tools of the reviewer role (0019 section 4, option B): read-only, no web tools. */
export const REVIEWER_TOOLS: readonly string[] = ["Read", "Glob", "Grep", "Bash"];

/**
 * The reviewer's system file in the run directory: a name of its own, so a review never replaces
 * the developer's `system.md`, which a resumed developer session passes again.
 */
export const REVIEW_SYSTEM_FILE = "system-review.md";

/** `engine.notice` codes of the worker start. */
export const LAUNCH_NOTICES = {
  planRefused: "run.planRefused",
  startFailed: "run.startFailed",
} as const;

/** The end kind of a run whose worker host did not start. */
export const START_FAILED_END = "start-failed";

/** Placeholders in the dry run for what only a real run makes. */
export const PREVIEW_RUN = "<run-id>";
const PREVIEW_SESSION = "00000000-0000-4000-8000-000000000000";

/** A tier's caps as the office configuration holds them. */
export type TierCaps = OfficeConfig["tiers"]["S"];

/**
 * A reviewer session's model, effort and session caps (0019 sections 4 and 16): the office's
 * `review` block, or the values the run snapshot of it at its start.
 */
export type ReviewerSettings = Pick<
  OfficeConfig["review"],
  "model" | "effort" | "maxTurns" | "maxMinutes"
>;

/** Starts a worker host for a run and records it in `worker_hosts` (DIPO-44). */
export interface HostStarter {
  start(
    office: OfficeHandle,
    options: {
      readonly runId: string;
      readonly agentId: string;
      readonly officeDir: string;
      readonly plan: LaunchPlan;
      /**
       * Where the host's ingestion starts, recorded on its row (DIPO-57); 0 by default. A run's
       * next session starts after what earlier hosts wrote.
       */
      readonly processedOffset?: number;
      /** Writes made in the transaction that records the host (DIPO-57: the new agent's row). */
      readonly record?: () => void;
    },
  ): Promise<LaunchedHost>;
}

/** Starts ingesting a started host's events (DIPO-45). */
export interface RunIngest {
  start(office: OfficeHandle, host: LaunchedHost, target: IngestTarget): void;
}

export interface RunLauncherDeps {
  readonly worker: WorkerPort;
  /** The office's git, attached by its load step. */
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  /** DIPO-39's setup of a claimed worktree, with the daemon's slots, step runner and profile. */
  readonly setup: (office: OfficeId, claim: ClaimRecord) => Promise<SetupOutcome>;
  /** The views of `ids` on the office's base, in that order; ids it cannot read are left out. */
  readonly dependencies: (
    office: OfficeId,
    ids: readonly string[],
  ) => Promise<readonly PlainTask[]>;
  /** The daemon's runtime directory; host sockets live in it. */
  readonly runtimeDir: string;
  /** Where each run's sandbox temp directory is made. */
  readonly tmpRoot: string;
  /**
   * The owner written into each new run temp directory (`RunTempDirs.owner`, DIPO-102), so the
   * daemon-start sweep tells its own directories from another daemon's; none by default.
   */
  readonly tempOwner?: () => string | undefined;
  readonly hosts: HostStarter;
  readonly ingest: RunIngest;
  /**
   * Caps, report parks and `work.stop` of started runs (DIPO-50); told about each run before its
   * ingestion starts, so no event is missed.
   */
  readonly control?: {
    track(
      office: OfficeId,
      run: {
        runId: RunId;
        work: WorkRef;
        caps: Caps;
        startedAt: number;
        snapshot?: BackstopSnapshot | null;
      },
    ): void;
  };
  /**
   * Takes the backstop snapshot of a story worktree (DIPO-49), before its worker starts; without
   * it no backstop runs after the turns.
   */
  readonly snapshot?: (office: OfficeId, worktree: string) => Promise<BackstopSnapshot>;
  /** Ends a live claim whose worker did not start: worktree removed, branch kept as released. */
  readonly release: (office: OfficeId, claim: ClaimRecord, reason: string) => Promise<void>;
  /** Logs what the launcher could not do (the daemon's logger); nothing by default. */
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
  /** The checkout the context pack reads; `gitWorkspace` on the office git by default. */
  readonly workspace?: (git: OfficeGit, path: string) => Workspace;
}

/** A `Workspace` over an engine worktree (the story worktree or `_base`). */
function defaultWorkspace(git: OfficeGit, path: string): Workspace {
  return gitWorkspace({
    git,
    location: git.worktreeLocation(path) as Extract<GitLocation, { kind: "worktree" }>,
  });
}

/** What one story run starts with, from `work.run`. */
export interface RunFacts {
  readonly office: OfficeId;
  readonly runId: RunId;
  readonly agent: AgentId;
  readonly view: PlainTask;
  readonly fields: FieldBlock;
  readonly caps: TierCaps;
  readonly config: OfficeConfig;
  /** Repo-relative path of the story's task file. */
  readonly taskFile: string;
  /** The office's resolved verify (DIPO-173); the launch refuses a tool that cannot start. */
  readonly verify?: VerifyCommands;
}

/** A setup that passed with a launch plan the host may start. */
export interface PreparedRun extends ClaimSetupDone {
  readonly ok: true;
  /** The port slot setup took; null when setup takes none. */
  readonly slot: number | null;
  readonly spec: WorkerSpec;
  readonly plan: LaunchPlan;
  readonly paths: RunLaunchPaths;
  readonly officeDir: string;
  /** sha256 of the system file (L1+L2), stored on the agent for `canResume` (DIPO-51). */
  readonly systemHash: string;
  /** The context pack and input paths of the first session, stored for the nudges (DIPO-60). */
  readonly promptSources: Pick<RunPrompts, "nudgeSources">;
  /** The measured prompt parts of the first session: system, task and each task section. */
  readonly parts: readonly PromptPart[];
  /** The system file and task message texts, stored when `privacy.storePrompts` is on (DIPO-137). */
  readonly texts: readonly PromptText[];
}

export type StartOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** sha256 of a system file's text: the L1+L2 hash a resume compares (0008 section 8). */
export function systemHashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The paths of a run; the run directory sits in `<git-common-dir>/dipo/runs`. */
export function runLaunchPaths(
  git: OfficeGit,
  dirs: { readonly runtimeDir: string; readonly tmpRoot: string },
  worktree: string,
  runId: string,
): RunLaunchPaths & { officeDir: string } {
  const officeDir = officeDirectory(git.commonDir);
  return {
    workdir: worktree,
    mainCheckout: git.mainWorktree,
    runDir: runDirectory(officeDir, runId),
    hostSocket: hostSocketPath(dirs.runtimeDir, runId),
    tmpDir: runTempDir(dirs.tmpRoot, runId),
    shortTmpDir: shortTempDir(dirs.tmpRoot, runId),
    officeDir,
  };
}

/**
 * The `WorkerSpec` of one session of a run (DIPO-74; DIPO-51 for the later sessions). The report
 * schema comes from the worker port, never from an adapter module (DIPO-113), for the session's
 * kind. With `facts.reviewer` the session is a reviewer's (0019 section 4): kind `review`, model
 * and effort from the review settings, the reviewer's tools, its own turn and minute caps, the
 * `ReviewReport` schema, and always a fresh session. Otherwise it is the developer's `implement`
 * session with the tier's model, effort and caps.
 */
export function runWorkerSpec(
  worker: Pick<WorkerPort, "reportSchema">,
  facts: {
    readonly runId: string;
    readonly agent: string;
    readonly caps: TierCaps;
    readonly reviewer?: ReviewerSettings;
  },
  paths: RunLaunchPaths,
  taskMessage: string,
  session: { readonly id: string; readonly resume: boolean },
  caps: Caps = capsOf(facts.caps),
): WorkerSpec {
  const reviewer = facts.reviewer;
  const common = {
    run: facts.runId,
    agent: facts.agent,
    workdir: paths.workdir,
    systemFile: join(paths.runDir, reviewer === undefined ? SYSTEM_FILE : REVIEW_SYSTEM_FILE),
    taskMessage,
    // The adapter relays its hooks to the worker host (0008 section 5, DIPO-59).
    hookRelay: true,
  };
  if (reviewer !== undefined) {
    return {
      ...common,
      kind: "review",
      model: reviewer.model,
      effort: reviewer.effort,
      // The reviewer's turns and minutes count only toward its own caps (0019 section 13); the
      // tokens are the story's budget.
      caps: { ...caps, maxTurns: reviewer.maxTurns, maxMinutes: reviewer.maxMinutes },
      tools: { allow: [...REVIEWER_TOOLS], deny: [] },
      // The reviewer never resumes (0008 section 8).
      session: { id: session.id, resume: false },
      reportSchema: worker.reportSchema.review,
    };
  }
  return {
    ...common,
    kind: "implement",
    model: facts.caps.model,
    effort: facts.caps.effort,
    caps,
    tools: { allow: [...DEVELOPER_TOOLS], deny: [] },
    session,
    reportSchema: worker.reportSchema.implement,
  };
}

export function capsOf(caps: TierCaps): Caps {
  return { budgetTokens: caps.budgetTokens, maxTurns: caps.maxTurns, maxMinutes: caps.maxMinutes };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The notice text of a path the plan refused (AC #7). */
export function planRefusedText(story: string, error: PlanError): string {
  const refused = error.refused;
  if (refused === undefined)
    return `${story} was not started: the launch plan refused it: ${error.message}.`;
  const why =
    refused.character === undefined
      ? `${error.message}`
      : `it holds the character ${JSON.stringify(refused.character)}, which has a meaning in Claude Code permission rules`;
  return `${story} was not started: the launch plan refused the path ${refused.path}: ${why}. Move the checkout, or set worktree.root in .dipo/office.yaml, to a path without it, outside the home directory itself and not at /.`;
}

export class RunLauncher {
  readonly #deps: RunLauncherDeps;

  constructor(deps: RunLauncherDeps) {
    this.#deps = deps;
  }

  get adapterId(): string {
    return this.#deps.worker.id;
  }

  #workspace(git: OfficeGit, path: string): Workspace {
    return (this.#deps.workspace ?? defaultWorkspace)(git, path);
  }

  #git(office: OfficeId): OfficeGit {
    const git = this.#deps.git(office);
    if (git === undefined) throw new Error(`Office ${office} has no git attached.`);
    return git;
  }

  /** The run's paths; the run directory sits in `<git-common-dir>/dipo/runs`. */
  #paths(git: OfficeGit, worktree: string, runId: string): RunLaunchPaths & { officeDir: string } {
    return runLaunchPaths(git, this.#deps, worktree, runId);
  }

  #spec(
    facts: Pick<RunFacts, "runId" | "agent" | "caps">,
    paths: RunLaunchPaths,
    taskMessage: string,
    session: string,
  ): WorkerSpec {
    return runWorkerSpec(this.#deps.worker, facts, paths, taskMessage, {
      id: session,
      resume: false,
    });
  }

  /** The session id of a run's first session (AC #3). */
  static sessionOf(agent: string): string {
    return sessionUuid(agent);
  }

  /**
   * The claim's setup: DIPO-39's setup, the prompts and the launch checks. Never throws for a
   * setup or launch failure; it returns `ClaimSetupFailed`, and `claimStory` rolls back.
   */
  async prepare(
    facts: RunFacts,
    claim: ClaimRecord,
    notify: (entry: NewEntry) => void,
  ): Promise<PreparedRun | ClaimSetupFailed> {
    const setup = await this.#deps.setup(facts.office, claim);
    if (!setup.ok) return setup;
    const git = this.#git(facts.office);
    const paths = this.#paths(git, claim.worktree, facts.runId);
    const cleanup = (): void => {
      rmSync(paths.runDir, { recursive: true, force: true });
      rmSync(paths.tmpDir, { recursive: true, force: true });
      // Never through a link, and never another run's root with the same hash.
      removeShortTempDir(dirname(paths.shortTmpDir), facts.runId);
    };
    const fail = (reason: string): ClaimSetupFailed => {
      setup.release();
      cleanup();
      return { ok: false, reason, log: [...setup.log, `launch: ${reason}`].join("\n") };
    };
    let spec: WorkerSpec;
    let systemHash: string;
    let promptSources: PreparedRun["promptSources"];
    let parts: PromptPart[];
    let texts: PromptText[];
    try {
      const dependencies = await this.#deps.dependencies(
        facts.office,
        facts.view.dependencies.map((dependency) => dependency.id),
      );
      const prompts = await renderRunPrompts({
        view: facts.view,
        fields: facts.fields,
        dependencies,
        taskFile: facts.taskFile,
        workspace: this.#workspace(git, claim.worktree),
        baseSha: claim.baseSha,
        config: facts.config,
      });
      ensurePrivateDir(paths.runDir);
      prepareRunTempDirs(paths, facts.runId, this.#deps.tempOwner?.());
      spec = this.#spec(facts, paths, prompts.taskMessage, RunLauncher.sessionOf(facts.agent));
      writeFileSync(spec.systemFile, prompts.systemFile, { mode: 0o600 });
      systemHash = systemHashOf(prompts.systemFile);
      promptSources = { nudgeSources: prompts.nudgeSources };
      parts = promptParts(prompts.systemFile, prompts.taskMessage, prompts.sections);
      texts = [
        { part: "system", text: prompts.systemFile },
        { part: "message", text: prompts.taskMessage },
      ];
    } catch (error) {
      return fail(`the prompts could not be rendered: ${messageOf(error)}`);
    }
    let prepared;
    try {
      prepared = await this.#deps.worker.prepare(
        spec,
        paths,
        facts.config,
        sessionUuid(`${facts.agent}:launch-check`),
        facts.verify,
      );
    } catch (error) {
      if (!(error instanceof PlanError))
        return fail(`the launch could not be planned: ${messageOf(error)}`);
      notify({
        type: "engine.notice",
        key: claim.key,
        delta: {
          level: "error",
          code: LAUNCH_NOTICES.planRefused,
          text: planRefusedText(claim.story, error),
        },
      });
      return fail(`the launch plan refused it: ${error.message}`);
    }
    if (!prepared.ok) return fail(`the launch checks refused it: ${holdMessage(prepared.hold)}`);
    return {
      ok: true,
      slot: setup.slot,
      spec,
      plan: prepared.plan,
      paths,
      officeDir: paths.officeDir,
      systemHash,
      promptSources,
      parts,
      texts,
      release: () => {
        setup.release();
        cleanup();
      },
    };
  }

  /**
   * Starts the worker host of a claimed run, starts ingesting its events and records the `build`
   * phase. A host that does not start releases the claim (the branch is kept as released, so the
   * next claim reuses it) and ends the run as `start-failed`.
   */
  async start(
    ctx: AsyncCommandContext,
    run: {
      readonly facts: RunFacts;
      readonly prepared: PreparedRun;
      readonly claim: ClaimRecord;
      readonly work: WorkRef;
      readonly progress: Progress;
    },
  ): Promise<StartOutcome> {
    const { facts, prepared, claim, work } = run;
    const handle = ctx.office;
    // The backstop's run-start snapshot, before the worker can change anything (DIPO-49).
    let snapshot: BackstopSnapshot | null = null;
    if (this.#deps.snapshot !== undefined) {
      try {
        snapshot = await this.#deps.snapshot(facts.office, claim.worktree);
      } catch (error) {
        this.#deps.warn?.("the backstop snapshot could not be taken; no backstop runs", {
          run: facts.runId,
          story: claim.story,
          reason: messageOf(error),
        });
      }
    }
    // Stored with the run, so a re-attach after a restart restores it (DIPO-93).
    if (snapshot !== null) {
      const taken = snapshot;
      handle.immediate(() => storeBackstopSnapshot(handle, facts.runId, taken));
    }
    let host: LaunchedHost;
    try {
      host = await this.#deps.hosts.start(handle, {
        runId: facts.runId,
        agentId: facts.agent,
        officeDir: prepared.officeDir,
        plan: prepared.plan,
      });
    } catch (error) {
      const reason = `the worker host did not start: ${messageOf(error)}`;
      let released = `dipo removed the worktree and kept the branch ${claim.branch} for the next run`;
      try {
        await this.#deps.release(facts.office, claim, START_FAILED_END);
      } catch (releaseError) {
        const why = messageOf(releaseError);
        this.#deps.warn?.("releasing the claim after a failed host start failed", {
          run: facts.runId,
          story: claim.story,
          reason: why,
        });
        released = `releasing its claim also failed (${why}), so the worktree ${claim.worktree} and the claim may still be there; check them`;
      }
      prepared.release();
      ctx.commit((): NewEntry[] => [
        {
          type: "engine.notice",
          key: claim.key,
          delta: {
            level: "error",
            code: LAUNCH_NOTICES.startFailed,
            text: `${claim.story} was claimed but not started: ${reason}. ${released}; the story stays Ready.`,
          },
        },
      ]);
      return { ok: false, reason };
    }
    this.#deps.control?.track(facts.office, {
      runId: facts.runId,
      work,
      caps: capsOf(facts.caps),
      startedAt: ctx.clock.now(),
      snapshot,
    });
    const adapter = this.#deps.worker.adapter(prepared.paths, facts.config);
    this.#deps.ingest.start(handle, host, {
      run: facts.runId,
      agent: facts.agent,
      role: work.role,
      tier: work.tier,
      budgetLimit: facts.caps.budgetTokens,
      model: facts.caps.model,
      work,
      adapter: adapter as IngestAdapter,
      initialState: this.#deps.worker.initialState(prepared.spec),
    });
    const at = ctx.clock.now();
    ctx.commit((): NewEntry[] => {
      const marker = markPhase(handle, facts.runId, "build", at);
      return withWorkViews(handle, [
        ...marker,
        {
          type: "work.phase",
          key: work.key,
          run: facts.runId,
          delta: { work, phase: "build", progress: run.progress },
        },
      ]);
    });
    return { ok: true };
  }

  /**
   * The dry run's launch for a story on `_base`: branch, worktree, the plan with placeholders for
   * the run, and the prompts. Writes nothing; throws `PlanError` when the plan refuses.
   */
  async preview(input: {
    readonly office: OfficeId;
    readonly story: string;
    readonly branch: string;
    readonly view: PlainTask;
    readonly fields: FieldBlock;
    readonly caps: TierCaps;
    readonly config: OfficeConfig;
    readonly taskFile: string;
    readonly base: { readonly path: string };
    /** The office's resolved verify (DIPO-173), checked as the real launch checks it. */
    readonly verify?: VerifyCommands;
  }): Promise<WorkerLaunchPreview> {
    const git = this.#git(input.office);
    const worktree = join(git.worktreeRoot(), input.story);
    // The short temp root's name is a hash of the run id, so the dry run shows a placeholder.
    const runPaths = this.#paths(git, worktree, PREVIEW_RUN);
    const paths = {
      ...runPaths,
      shortTmpDir: join(dirname(runPaths.shortTmpDir), `${SHORT_TEMP_PREFIX}<hash>`),
    };
    const dependencies = await this.#deps.dependencies(
      input.office,
      input.view.dependencies.map((dependency) => dependency.id),
    );
    const workspace = this.#workspace(git, input.base.path);
    const prompts = await renderRunPrompts({
      view: input.view,
      fields: input.fields,
      dependencies,
      taskFile: input.taskFile,
      workspace,
      baseSha: await workspace.headSha(),
      config: input.config,
    });
    const spec = this.#spec(
      { runId: PREVIEW_RUN as RunId, agent: "<agent-id>" as AgentId, caps: input.caps },
      paths,
      prompts.taskMessage,
      PREVIEW_SESSION,
    );
    const plan = this.#deps.worker.adapter(paths, input.config).plan(spec);
    // The worktree does not exist yet; the main checkout's node_modules stands for its install.
    if (input.verify !== undefined) {
      await this.#deps.worker.checkVerify?.(paths, input.config, input.verify, paths.mainCheckout);
    }
    return {
      adapter: this.#deps.worker.id,
      branch: input.branch,
      worktree,
      runDir: paths.runDir,
      cwd: plan.cwd,
      argv: [...plan.argv],
      model: spec.model,
      effort: spec.effort,
      caps: { ...spec.caps, loops: input.caps.loops },
      envNames: Object.keys(plan.env).toSorted(),
      files: plan.files.map((file) => ({ name: file.name, content: file.content })),
      systemFile: { path: spec.systemFile, text: prompts.systemFile },
      taskMessage: prompts.taskMessage,
    };
  }
}
