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

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
import type { LaunchedHost } from "../runs/worker-hosts";
import { runDirectory } from "../runs/worker-hosts";
import { holdMessage } from "../workers/hold";
import type { RunLaunchPaths, WorkerPort } from "../workers/port";
import { PlanError, type Caps, type LaunchPlan, type WorkerSpec } from "../workers/types";
import { WORKER_REPORT_JSON_SCHEMA } from "../workers/claude-cli/report-schema";
import type { ClaimSetupDone, ClaimSetupFailed } from "../worktree/claim";
import type { ClaimRecord } from "../worktree/records";
import type { SetupOutcome } from "../worktree/setup";

import { appendRunStep } from "./records";
import { renderRunPrompts, sessionUuid, SYSTEM_FILE } from "./prompts";

/** The tools of the developer role (0008 section 2, "Tools and rules"). */
export const DEVELOPER_TOOLS: readonly string[] = ["Read", "Edit", "Write", "Glob", "Grep", "Bash"];

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

/** Starts a worker host for a run and records it in `worker_hosts` (DIPO-44). */
export interface HostStarter {
  start(
    office: OfficeHandle,
    options: {
      readonly runId: string;
      readonly agentId: string;
      readonly officeDir: string;
      readonly plan: LaunchPlan;
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
  readonly hosts: HostStarter;
  readonly ingest: RunIngest;
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
}

export type StartOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

function capsOf(caps: TierCaps): Caps {
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
    const officeDir = officeDirectory(git.commonDir);
    return {
      workdir: worktree,
      mainCheckout: git.mainWorktree,
      runDir: runDirectory(officeDir, runId),
      hostSocket: hostSocketPath(this.#deps.runtimeDir, runId),
      tmpDir: join(this.#deps.tmpRoot, `dipo-run-${runId}`),
      officeDir,
    };
  }

  #spec(
    facts: Pick<RunFacts, "runId" | "agent" | "caps">,
    paths: RunLaunchPaths,
    taskMessage: string,
    session: string,
  ): WorkerSpec {
    return {
      run: facts.runId,
      agent: facts.agent,
      kind: "implement",
      workdir: paths.workdir,
      model: facts.caps.model,
      effort: facts.caps.effort,
      caps: capsOf(facts.caps),
      systemFile: join(paths.runDir, SYSTEM_FILE),
      taskMessage,
      tools: { allow: [...DEVELOPER_TOOLS], deny: [] },
      session: { id: session, resume: false },
      reportSchema: WORKER_REPORT_JSON_SCHEMA,
      hookRelay: false,
    };
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
    };
    const fail = (reason: string): ClaimSetupFailed => {
      setup.release();
      cleanup();
      return { ok: false, reason, log: [...setup.log, `launch: ${reason}`].join("\n") };
    };
    let spec: WorkerSpec;
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
      ensurePrivateDir(paths.tmpDir);
      spec = this.#spec(facts, paths, prompts.taskMessage, RunLauncher.sessionOf(facts.agent));
      writeFileSync(spec.systemFile, prompts.systemFile, { mode: 0o600 });
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
      appendRunStep(handle, facts.runId, "phase", "build", at);
      return [
        {
          type: "work.phase",
          key: work.key,
          run: facts.runId,
          delta: { work, phase: "build", progress: run.progress },
        },
      ];
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
  }): Promise<WorkerLaunchPreview> {
    const git = this.#git(input.office);
    const worktree = join(git.worktreeRoot(), input.story);
    const paths = this.#paths(git, worktree, PREVIEW_RUN);
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
