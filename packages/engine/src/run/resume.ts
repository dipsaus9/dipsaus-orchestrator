// The next session of a run (DIPO-51; 0008 sections 7 and 8, 0014 section 6). After a crash, a
// full context or a missing report the engine starts one more session of the same run, never a
// new run: a new agent of the run with its own `worker_hosts` row, on the same worktree and
// branch.
//
// - Resume first. When the previous session can be resumed (`canResume`: transcript present, the
//   same Claude Code version and L1+L2 hash, under the context share, re-reading cheaper than the
//   re-read factor times a handoff) the new agent continues it with `--resume` and the full flag
//   set, with a short delta as first message (`prompts/feedback/resume.md`), or the message the
//   caller gives (the report feedback). A full context always starts a new session.
// - Otherwise a new session with an engine-made session id and a 0014 handoff: the story's task
//   message with the handoff block of the worktree (commits since the claim's base, uncommitted
//   changes, the last report's criteria, the last verify, the previous worker's notes).
// - The launch checks run again before every launch or resume (`WorkerPort.prepare`); a refused
//   check is `startFailed` with the adapter hold set, and the caller decides what follows.
// - Caps: the CLI's own caps get what remains of the run's budget, turns and minutes (at least
//   one each); run control keeps tracking the run's own caps from the original start.
// - No double ingestion: the run's event file is shared by its hosts, so the new host's row starts
//   at the file's size before the host started, and the new agent's parser starts from the
//   previous session's stored state (`WorkerPort.initialState(spec, previous)`), so a resume does
//   not count restored spend twice.
// - It records the agent (session, effort, system hash), emits `work.assigned` for the new agent
//   and an `engine.notice` `run.resumed` or `run.handoff`.

import { statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import type {
  AgentId,
  Clock,
  FieldBlock,
  IdSource,
  OfficeId,
  RunId,
  WorkRef,
} from "@dipsaus-orchestrator/contract";

import { parseFieldBlock } from "../backlog/fields/block";
import type { PlainTask } from "../backlog/plain";
import { appendEntries, type NewEntry } from "../changelog/log";
import type { OfficeConfig } from "../config";
import type { Workspace } from "../context/types";
import { gitWorkspace } from "../context/workspace";
import type { OfficeHandle } from "../db/office";
import type { GitLocation } from "../git/hardened";
import type { OfficeGit } from "../git/office";
import { EVENTS_FILE } from "../host/protocol";
import type { IngestAdapter } from "../ingest/ingestor";
import { ensurePrivateDir } from "../platform/paths";
import { CHARS_PER_TOKEN } from "../prompts/parts";
import { gatherHandoff, type HandoffFacts, type LastVerify } from "../prompts/handoff";
import { renderSystemFile } from "../prompts/system";
import { FEEDBACK_TEMPLATES, renderTemplate } from "../prompts/templates";
import { withWorkViews } from "../views/work";
import type { AdapterHold } from "../workers/hold";
import type { WorkerPort } from "../workers/port";
import { PlanError, type Caps, type ParseState, type WorkerReport } from "../workers/types";
import { findClaim } from "../worktree/records";

import type { BackstopSnapshot } from "./backstop";
import { runTotals } from "./caps";
import {
  capsOf,
  runLaunchPaths,
  runWorkerSpec,
  systemHashOf,
  type HostStarter,
  type RunIngest,
  type TierCaps,
} from "./launch";
import { renderRunPrompts, sessionUuid } from "./prompts";
import type { StoredRun } from "./records";
import { verifyResults } from "./verify-records";
import type { RunBase } from "./work-run";

/** 0014 section 6 until `office.yaml` version 2 (0014 amendment, DIPO-51): engine constants. */
export const RESUME_POLICY = { maxContextShare: 0.6, rereadFactor: 3 } as const;

/** `engine.notice` codes of a run's next session. */
export const RESUME_NOTICES = {
  resumed: "run.resumed",
  handoff: "run.handoff",
} as const;

/** The story facts a new session's task message is built from, read on the office base. */
export interface RunStoryFacts {
  readonly view: PlainTask;
  readonly fields: FieldBlock;
  /** Repo-relative path of the story's task file. */
  readonly taskFile: string;
  readonly dependencies: readonly PlainTask[];
}

export interface RunResumerDeps {
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly offices: {
    get(office: OfficeId): OfficeHandle | undefined;
    config(office: OfficeId): OfficeConfig | undefined;
  };
  readonly worker: WorkerPort;
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  readonly story: (office: OfficeId, run: StoredRun) => Promise<RunStoryFacts>;
  readonly runtimeDir: string;
  readonly tmpRoot: string;
  readonly hosts: HostStarter;
  readonly ingest: RunIngest;
  /** Run control: the new session is tracked before its ingestion starts. */
  readonly control: {
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
  readonly onChanged?: (office: OfficeId) => void;
  /** The checkout the context pack reads; `gitWorkspace` on the office git by default. */
  readonly workspace?: (git: OfficeGit, path: string) => Workspace;
  /** The handoff facts of the worktree; `gatherHandoff` on the office git by default. */
  readonly handoff?: (
    office: OfficeHandle,
    run: StoredRun,
    lastReport: WorkerReport | null,
  ) => Promise<HandoffFacts>;
}

export interface NextSessionRequest {
  readonly office: OfficeId;
  readonly run: StoredRun;
  /** Who worked on the run until now. */
  readonly work: WorkRef;
  /** `resume` when `canResume` allows it, else a handoff; `handoff` always starts a new session. */
  readonly mode: "resume" | "handoff";
  /** Why the previous session ended, for the notice and the resume message. */
  readonly why: string;
  /** The first message instead of the resume delta, added after the handoff block otherwise. */
  readonly message?: string;
  /** The run's caps as run control tracks them. */
  readonly caps: Caps;
  /** When the run's first worker started, on the engine clock. */
  readonly startedAt: number;
  readonly snapshot: BackstopSnapshot | null;
}

export type NextSessionOutcome =
  | {
      readonly kind: "started";
      readonly agent: AgentId;
      readonly resumed: boolean;
      /** Why a resume was not possible, for a handoff that was asked to resume first. */
      readonly notResumed?: string;
    }
  | { readonly kind: "startFailed"; readonly hold: AdapterHold }
  | { readonly kind: "failed"; readonly reason: string };

/** Starts a run's next session. */
export interface NextSession {
  next(request: NextSessionRequest): Promise<NextSessionOutcome>;
}

interface PreviousAgent {
  readonly sessionId: string | null;
  readonly version: string | null;
  readonly systemHash: string | null;
  readonly state: ParseState | undefined;
  readonly lastLineAt: number | null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The newest verify of the run as the handoff block names it; null before any. */
function lastVerifyOf(office: OfficeHandle, runId: RunId): LastVerify | null {
  const last = verifyResults(office, runId).at(-1);
  if (last === undefined) return null;
  if (last.passed) return { passed: true };
  return { passed: false, step: last.profile, exitCode: last.exitCode ?? -1 };
}

function previousAgent(office: OfficeHandle, runId: string, agent: string): PreviousAgent {
  const row = office.get<{
    session_id: string | null;
    claude_code_version: string | null;
    system_hash: string | null;
  }>(
    `select session_id, claude_code_version, system_hash from agents
      where office_id = $office_id and agent_id = $agent`,
    { agent },
  );
  const cursor = office.get<{ parse_state: string; updated_at: number }>(
    `select parse_state, updated_at from ingest_cursors
      where office_id = $office_id and run_id = $run and agent_id = $agent`,
    { run: runId, agent },
  );
  return {
    sessionId: row?.session_id ?? null,
    version: row?.claude_code_version ?? null,
    systemHash: row?.system_hash ?? null,
    state: cursor === null ? undefined : (JSON.parse(cursor.parse_state) as ParseState),
    lastLineAt: cursor?.updated_at ?? null,
  };
}

/** The real `NextSession`. */
export class RunResumer implements NextSession {
  readonly #deps: RunResumerDeps;

  constructor(deps: RunResumerDeps) {
    this.#deps = deps;
  }

  async next(request: NextSessionRequest): Promise<NextSessionOutcome> {
    const deps = this.#deps;
    const { run } = request;
    const office = deps.offices.get(request.office);
    const config = deps.offices.config(request.office);
    const git = deps.git(request.office);
    const tier =
      run.tier === null ? undefined : config?.tiers[run.tier as keyof OfficeConfig["tiers"]];
    if (office === undefined || config === undefined || git === undefined || tier === undefined) {
      return {
        kind: "failed",
        reason: `office ${request.office} is not loaded with a valid configuration`,
      };
    }
    if (run.worktree === null) return { kind: "failed", reason: `${run.runId} has no worktree` };
    const paths = runLaunchPaths(git, deps, run.worktree, run.runId);
    const previous = previousAgent(office, run.runId, request.work.agent);
    const facts = previous.state === undefined ? null : deps.worker.sessionFacts(previous.state);
    const systemFile = renderSystemFile("implement", "developer");
    const systemHash = systemHashOf(systemFile);

    // The handoff message: the new session's task message, and the size a resume is weighed with.
    let handoff: { text: string } | { error: string };
    try {
      handoff = {
        text: await this.#handoffMessage(office, git, run, config, facts?.lastReport ?? null),
      };
    } catch (error) {
      handoff = { error: messageOf(error) };
    }

    const adapter = deps.worker.adapter(paths, config);
    let resume = false;
    let notResumed: string | undefined;
    if (request.mode === "resume" && previous.sessionId !== null) {
      const version = await adapter.probe().then(
        (status) => status.version,
        () => null,
      );
      const check = adapter.canResume(
        {
          id: previous.sessionId,
          transcriptPath: null,
          version: previous.version,
          systemHash: previous.systemHash,
          contextTokens: facts?.contextTokens ?? null,
          contextWindow: facts?.contextWindow ?? null,
          lastRequestAt: previous.lastLineAt,
        },
        runWorkerSpec({ runId: run.runId, agent: request.work.agent, caps: tier }, paths, "", {
          id: previous.sessionId,
          resume: true,
        }),
        {
          now: deps.clock.now(),
          version,
          systemHash,
          handoffTokens:
            "text" in handoff
              ? Math.ceil(handoff.text.length / CHARS_PER_TOKEN)
              : Number.POSITIVE_INFINITY,
          ...RESUME_POLICY,
        },
      );
      resume = check.ok;
      if (!check.ok) notResumed = check.reason;
    } else if (request.mode === "resume") {
      notResumed = "the previous session never started";
    }
    if (!resume && "error" in handoff) {
      return { kind: "failed", reason: `the handoff could not be built: ${handoff.error}` };
    }

    const agent = deps.ids.next("agt") as AgentId;
    const session =
      resume && previous.sessionId !== null
        ? { id: previous.sessionId, resume: true }
        : { id: sessionUuid(agent), resume: false };
    const taskMessage = resume
      ? (request.message ?? renderTemplate(FEEDBACK_TEMPLATES.resume, { reason: request.why }))
      : [(handoff as { text: string }).text, request.message]
          .filter((part) => part !== undefined && part !== "")
          .join("\n\n");
    const spec = runWorkerSpec(
      { runId: run.runId, agent, caps: tier },
      paths,
      taskMessage,
      session,
      this.#remaining(office, run.runId, tier, request),
    );
    try {
      ensurePrivateDir(paths.runDir);
      ensurePrivateDir(paths.tmpDir);
      if (!resume) writeFileSync(spec.systemFile, systemFile, { mode: 0o600 });
    } catch (error) {
      return {
        kind: "failed",
        reason: `the run directory could not be prepared: ${messageOf(error)}`,
      };
    }

    // The launch checks run before every launch and resume (0008 section 2).
    let prepared;
    try {
      prepared = await deps.worker.prepare(
        spec,
        paths,
        config,
        sessionUuid(`${agent}:launch-check`),
      );
    } catch (error) {
      const why =
        error instanceof PlanError
          ? `the launch plan refused it: ${error.message}`
          : messageOf(error);
      return { kind: "failed", reason: why };
    }
    if (!prepared.ok) return { kind: "startFailed", hold: prepared.hold };

    // The new host appends to the run's event file: its ingestion starts after what is there.
    const eventFile = join(paths.runDir, EVENTS_FILE);
    let offset = 0;
    try {
      offset = statSync(eventFile).size;
    } catch {
      offset = 0;
    }
    let host;
    try {
      host = await deps.hosts.start(office, {
        runId: run.runId,
        agentId: agent,
        officeDir: paths.officeDir,
        plan: prepared.plan,
      });
    } catch (error) {
      return { kind: "failed", reason: `the worker host did not start: ${messageOf(error)}` };
    }
    const at = deps.clock.now();
    const work: WorkRef = { ...request.work, agent, model: tier.model };
    office.immediate(() => {
      office.run(
        `update worker_hosts set processed_offset = $offset
          where office_id = $office_id and run_id = $run and agent_id = $agent`,
        { offset, run: run.runId, agent },
      );
      office.run(
        `insert into agents (office_id, agent_id, run_id, role, model, effort, session_id,
           system_hash, started_at)
         values ($office_id, $agent, $run, $role, $model, $effort, $session, $hash, $at)`,
        {
          agent,
          run: run.runId,
          role: run.role,
          model: tier.model,
          effort: tier.effort,
          session: session.id,
          // A resume keeps the system file the session started with.
          hash: resume ? previous.systemHash : systemHash,
          at,
        },
      );
    });
    deps.control.track(request.office, {
      runId: run.runId,
      work,
      caps: request.caps,
      startedAt: request.startedAt,
      snapshot: request.snapshot,
    });
    deps.ingest.start(office, host, {
      run: run.runId,
      agent,
      role: run.role,
      tier: run.tier ?? "",
      budgetLimit: run.budgetLimit,
      model: tier.model,
      work,
      adapter: adapter as IngestAdapter,
      initialState: deps.worker.initialState(spec, previous.state),
    });
    const story = run.story ?? run.runId;
    const text = resume
      ? `${story}: dipo resumed the worker's session after ${request.why}.`
      : `${story}: dipo started a new session with a handoff after ${request.why}${notResumed === undefined ? "" : ` (no resume: ${notResumed})`}.`;
    this.#write(office, request.office, () => [
      { type: "work.assigned", key: work.key, run: run.runId, delta: { work } },
      {
        type: "engine.notice",
        key: work.key,
        run: run.runId,
        delta: {
          level: "info",
          code: resume ? RESUME_NOTICES.resumed : RESUME_NOTICES.handoff,
          text,
        },
      },
    ]);
    return {
      kind: "started",
      agent,
      resumed: resume,
      ...(notResumed === undefined ? {} : { notResumed }),
    };
  }

  /** What remains of the run's caps for the CLI's own caps; at least one of each. */
  #remaining(
    office: OfficeHandle,
    runId: RunId,
    tier: TierCaps,
    request: NextSessionRequest,
  ): Caps {
    const caps = capsOf(tier);
    const used = runTotals(office, runId, request.startedAt, this.#deps.clock.now());
    return {
      budgetTokens: Math.max(1, caps.budgetTokens - used.budgetTokens),
      maxTurns: Math.max(1, caps.maxTurns - used.turns),
      maxMinutes: Math.max(1, Math.ceil(caps.maxMinutes - used.elapsedMs / 60_000)),
    };
  }

  /** The task message of a new session: the story's task message with the handoff block. */
  async #handoffMessage(
    office: OfficeHandle,
    git: OfficeGit,
    run: StoredRun,
    config: OfficeConfig,
    lastReport: WorkerReport | null,
  ): Promise<string> {
    const deps = this.#deps;
    const worktree = run.worktree ?? "";
    const story = await deps.story(office.officeId, run);
    const handoff = await (deps.handoff ?? this.#gather.bind(this))(office, run, lastReport);
    const workspace = (deps.workspace ?? defaultWorkspace)(git, worktree);
    const claim = findClaim(office, run.runId);
    const prompts = await renderRunPrompts({
      view: story.view,
      fields: story.fields,
      dependencies: story.dependencies,
      taskFile: story.taskFile,
      workspace,
      baseSha: claim?.baseSha ?? run.startSha ?? (await workspace.headSha()),
      config,
      handoff,
    });
    return prompts.taskMessage;
  }

  async #gather(
    office: OfficeHandle,
    run: StoredRun,
    lastReport: WorkerReport | null,
  ): Promise<HandoffFacts> {
    const git = this.#deps.git(office.officeId);
    if (git === undefined) throw new Error(`office ${office.officeId} has no git attached`);
    const claim = findClaim(office, run.runId);
    return gatherHandoff({
      git,
      location: git.worktreeLocation(run.worktree ?? "") as Extract<
        GitLocation,
        { kind: "worktree" }
      >,
      base: claim?.baseSha ?? run.startSha ?? "HEAD",
      office,
      lastReport,
      lastVerify: lastVerifyOf(office, run.runId),
      openFeedback: [],
    });
  }

  #write(office: OfficeHandle, officeId: OfficeId, fn: () => readonly NewEntry[]): void {
    const at = this.#deps.clock.now();
    const appended = office.immediate(() => {
      const entries = withWorkViews(office, fn());
      appendEntries(office, entries, { at });
      return entries.length;
    });
    if (appended > 0) this.#deps.onChanged?.(officeId);
  }
}

function defaultWorkspace(git: OfficeGit, path: string): Workspace {
  return gitWorkspace({
    git,
    location: git.worktreeLocation(path) as Extract<GitLocation, { kind: "worktree" }>,
  });
}

/**
 * The story facts of a run read on the office base (the real `RunResumerDeps.story`): the view,
 * its field block, the task file and the dependencies' views, as `work.run` read them.
 */
export function baseStoryFacts(base: Pick<RunBase, "read">): RunResumerDeps["story"] {
  return async (office, run) => {
    if (run.story === null) throw new Error(`${run.runId} is not a story run`);
    const read = await base.read(office, [run.story]);
    const view =
      read.views.find((candidate) => candidate.id.toUpperCase() === run.story?.toUpperCase()) ??
      read.views[0];
    if (view === undefined) throw new Error(`${run.story} could not be read on the office base`);
    const ids = view.dependencies.map((dependency) => dependency.id);
    return {
      view,
      fields: parseFieldBlock(view.description).fields,
      taskFile: relative(read.checkout.path, view.file),
      dependencies: ids.length === 0 ? [] : (await base.read(office, ids)).views,
    };
  };
}
