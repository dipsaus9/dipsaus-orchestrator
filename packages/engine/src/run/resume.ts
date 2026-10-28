// The next session of a run (DIPO-51; 0008 sections 7 and 8, 0014 section 6). After a crash, a
// full context or a missing report the engine starts one more session of the same run, never a
// new run: a new agent of the run with its own `worker_hosts` row, on the same worktree and
// branch.
//
// - Resume first. When the previous session can be resumed (`canResume`: transcript present, the
//   same Claude Code version and L1+L2 hash, under the context share, re-reading cheaper than the
//   re-read factor times a handoff) the new agent continues it with `--resume` and the full flag
//   set, with a short delta as first message (`prompts/feedback/resume.md`). A full context always
//   starts a new session.
// - Otherwise a new session with an engine-made session id and a 0014 handoff: the story's task
//   message with the handoff block of the worktree (commits since the claim's base, uncommitted
//   changes, the last report's criteria, the last verify, the run's open feedback from
//   `feedback_items`, the previous worker's notes; 0020 section 6). The context pack the task
//   message was built from is recorded for the worktree (`recordContextPack`) when the new
//   session starts with it.
// - The one feedback path (0002): every message held for the run's next developer session
//   (`heldFeedback`: a fix round's findings, a resumed park's reason and note, a steer) follows the
//   delta or the task message, and is marked delivered in the transaction that records the new
//   agent. The caller passes no text of its own.
// - The launch checks run again before every launch or resume (`WorkerPort.prepare`), with the
//   office's resolved verify for the verify tools check (DIPO-173); a refused check is
//   `startFailed` with the adapter hold set, a refused verify tool `failed` with the plan's
//   refusal and no hold, and the caller decides what follows.
// - Caps: the CLI's own caps get what remains of the run's budget, turns and minutes (at least
//   one each); run control keeps tracking the run's own caps from the original start.
// - No double ingestion: the run's event file is shared by its hosts, so the new host's row starts
//   at the file's size before the host started, and the new agent's parser starts from the
//   previous session's stored state (`WorkerPort.initialState(spec, previous)`), so a resume does
//   not count restored spend twice.
// - It records the agent (session, effort, system hash), emits `work.assigned` for the new agent
//   and an `engine.notice` `run.resumed` or `run.handoff`. The old host's signals end in the
//   transaction that records the agent.

import { existsSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import type {
  AgentId,
  Clock,
  FieldBlock,
  IdSource,
  OfficeId,
  RetryableErrorCode,
  RunId,
  WorkRef,
} from "@dipsaus-orchestrator/contract";

import { parseFieldBlock } from "../backlog/fields/block";
import type { PlainTask } from "../backlog/plain";
import { appendEntries, type NewEntry } from "../changelog/log";
import type { OfficeConfig } from "../config";
import { recordContextPack } from "../context/pack";
import type { ContextPack, Workspace } from "../context/types";
import { gitWorkspace } from "../context/workspace";
import type { OfficeHandle } from "../db/office";
import type { GitLocation } from "../git/hardened";
import type { OfficeGit } from "../git/office";
import { EVENTS_FILE } from "../host/protocol";
import type { IngestAdapter } from "../ingest/ingestor";
import { ensurePrivateDir } from "../platform/paths";
import type { ProcessProbe } from "../platform/process";
import {
  CHARS_PER_TOKEN,
  measurePart,
  promptParts,
  recordPromptParts,
  recordPromptTexts,
  TASK_PART,
} from "../prompts/parts";
import { BOX_RUN_FILE } from "../box/workers";
import { BOX_LIFETIME_NOTICES, BoxLifetime, boxRebuiltText, type RunBoxes } from "../box/lifetime";
import type { RunProfile } from "../scan/detect";
import { capNote, gatherHandoff, type HandoffFacts } from "../prompts/handoff";
import { renderSystemFile } from "../prompts/system";
import maintainerNoteTemplate from "../prompts/feedback/maintainer-note.md" with { type: "text" };
import { FEEDBACK_TEMPLATES, renderTemplate } from "../prompts/templates";
import { withWorkViews } from "../views/work";
import type { AdapterHold } from "../workers/hold";
import type { WorkerPort } from "../workers/port";
import { PlanError, type Caps, type ParseState, type WorkerReport } from "../workers/types";
import { findClaim } from "../worktree/records";
import { hostAlive, workerHostsOf } from "../runs/worker-hosts";

import type { BackstopSnapshot } from "./backstop";
import { runBudgetFacts } from "./budget-line";
import { runCaps, runTotals } from "./caps";
import { deliverHeld, type HeldFeedback, heldFeedback } from "./feedback";
import {
  capsOf,
  LAUNCH_NOTICES,
  packageCacheSkippedText,
  runLaunchPaths,
  runWorkerSpec,
  systemHashOf,
  type HostStarter,
  type RunIngest,
  type TierCaps,
} from "./launch";
import { openFeedbackOf } from "./open-feedback";
import { placeOfRun } from "./places";
import { renderRunPrompts, sessionUuid } from "./prompts";
import type { StoredRun } from "./records";
import { clearSignals } from "./signals";
import type { RunBase } from "./work-run";

/**
 * The maintainer's note as the worker reads it (`feedback/maintainer-note.md`, 0020 section 3): never
 * sent verbatim, so maintainer text never starts a message, and capped with a marker (`capNote`).
 */
export function noteText(note: string): string {
  return renderTemplate(maintainerNoteTemplate, { text: capNote(note) });
}

/**
 * The messages held for the run's next session (`heldFeedback`); none for a reviewer session
 * (0002), so they wait for the developer's.
 */
export function sessionFeedback(office: OfficeHandle, run: StoredRun): HeldFeedback {
  return placeOfRun(office, run) === "reviewer"
    ? { ids: [], texts: [] }
    : heldFeedback(office, run.runId);
}

/** 0014 section 6 until `office.yaml` version 2 (0014 amendment, DIPO-51): engine constants. */
export const RESUME_POLICY = { maxContextShare: 0.6, rereadFactor: 3 } as const;

/** How long a run's next session waits for an earlier host of the run to end (0006 decision 8). */
export const HOST_EXIT_WAIT_MS = 30_000;
const HOST_EXIT_POLL_MS = 250;

/** The signals a run's new session clears: what a restart observed of the old host (DIPO-57). */
const HOST_SIGNALS = ["host-lost", "follow-only"] as const;

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
  /**
   * Liveness of the run's earlier hosts (DIPO-57, 0006 decision 8): no new host starts while one
   * of them still runs. Without it nothing is checked.
   */
  readonly probe?: ProcessProbe;
  /** How long the next session waits for an earlier host to end; `HOST_EXIT_WAIT_MS` by default. */
  readonly hostExitWaitMs?: number;
  /** The checkout the context pack reads; `gitWorkspace` on the office git by default. */
  readonly workspace?: (git: OfficeGit, path: string) => Workspace;
  /**
   * The box workers (DIPO-278, DIPO-240): every developer session of a run with them runs in the
   * run's box, which is rebuilt from the start commit and the delivered parts when it was lost
   * (`BoxLifetime.ensure`). Without them no box is made or checked.
   */
  readonly boxes?: RunBoxes;
  /**
   * Copies into the run's box the merges dipo committed on its branch outside the box (the merge
   * slot's, DIPO-324), before the next developer session; throws when that fails, and the session
   * does not start (the caller parks the story). Nothing is copied without it.
   */
  readonly boxSync?: (office: OfficeId, run: StoredRun) => Promise<void>;
  /** The office's current run profile, whose install a rebuilt box gets (DIPO-294). */
  readonly profile?: (office: OfficeId) => RunProfile | null;
  /** The handoff facts of the worktree; `gatherHandoff` on the office git by default. */
  readonly handoff?: (
    office: OfficeHandle,
    run: StoredRun,
    lastReport: WorkerReport | null,
    /** A box run. */
    extra?: HandoffExtra,
  ) => Promise<HandoffFacts>;
}

/** What a handoff reads besides the run: a box run. */
export interface HandoffExtra {
  readonly box: boolean;
}

/** A new session's task message with its handoff block, and what it was built from. */
interface HandoffMessage {
  readonly text: string;
  readonly pack: ContextPack;
  readonly headSha: string;
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
  /**
   * Only a resume will do (DIPO-57: a host lost while the daemon was down): when the session
   * cannot be resumed nothing starts and the outcome is `notResumed`.
   */
  readonly requireResume?: boolean;
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
  | { readonly kind: "notResumed"; readonly reason: string }
  /**
   * An earlier host of the run still runs after the wait (0006 decision 8): nothing started. The
   * code is 0005's retryable `run.hostAlive`.
   */
  | {
      readonly kind: "hostAlive";
      readonly code: Extract<RetryableErrorCode, "run.hostAlive">;
      readonly pid: number;
    }
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

/**
 * The tier a run's sessions use: the office tier in force with the model the run row started with
 * and the effort of the run's first developer agent, so a tier edit never changes a parked or live
 * story's session (DIPO-207). A first agent without a recorded effort leaves the tier's effort.
 */
export function startTierOf(office: OfficeHandle, run: StoredRun, tier: TierCaps): TierCaps {
  const first = office.get<{ effort: string | null }>(
    `select effort from agents
      where office_id = $office_id and run_id = $run and role = 'developer'
      order by started_at, rowid limit 1`,
    { run: run.runId },
  );
  return {
    ...tier,
    model: run.model,
    effort: (first?.effort ?? tier.effort) as TierCaps["effort"],
  };
}

function previousAgent(office: OfficeHandle, runId: string, agent: string): PreviousAgent {
  const row = office.get<{
    session_id: string | null;
    adapter_version: string | null;
    system_hash: string | null;
  }>(
    `select session_id, adapter_version, system_hash from agents
      where office_id = $office_id and agent_id = $agent`,
    { agent },
  );
  const cursor = office.get<{ parse_state: string; updated_at: number }>(
    `select parse_state, updated_at from ingest_cursors
      where office_id = $office_id and run_id = $run and agent_id = $agent and source_kind = 'host-events'`,
    { run: runId, agent },
  );
  return {
    sessionId: row?.session_id ?? null,
    version: row?.adapter_version ?? null,
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
    const inForce =
      run.tier === null ? undefined : config?.tiers[run.tier as keyof OfficeConfig["tiers"]];
    if (
      office === undefined ||
      config === undefined ||
      git === undefined ||
      inForce === undefined
    ) {
      return {
        kind: "failed",
        reason: `office ${request.office} is not loaded with a valid configuration`,
      };
    }
    if (run.worktree === null) return { kind: "failed", reason: `${run.runId} has no worktree` };
    const tier = startTierOf(office, run, inForce);
    const paths = runLaunchPaths(git, deps, run.worktree, run.runId);
    const previous = previousAgent(office, run.runId, request.work.agent);
    const facts = previous.state === undefined ? null : deps.worker.sessionFacts(previous.state);
    // Every developer session reads the box contract (DIPO-272, DIPO-342); with box workers every
    // developer session is a box worker's, a run from before them included, whose box is made below.
    const box = deps.boxes !== undefined || existsSync(join(paths.runDir, BOX_RUN_FILE));
    const systemFile = renderSystemFile("implement-box", "developer");
    const systemHash = systemHashOf(systemFile);

    // The handoff message: the new session's task message, and the size a resume is weighed with.
    let handoff: HandoffMessage | { error: string };
    try {
      handoff = await this.#handoffMessage(office, git, run, config, facts?.lastReport ?? null, {
        box,
      });
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
        runWorkerSpec(
          deps.worker,
          { runId: run.runId, agent: request.work.agent, caps: tier, web: config.worker.web },
          paths,
          "",
          {
            id: previous.sessionId,
            resume: true,
          },
        ),
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
    if (request.requireResume === true && !resume) {
      return { kind: "notResumed", reason: notResumed ?? "the session cannot be resumed" };
    }
    if (!resume && "error" in handoff) {
      return { kind: "failed", reason: `the handoff could not be built: ${handoff.error}` };
    }

    const agent = deps.ids.next("agt") as AgentId;
    const session =
      resume && previous.sessionId !== null
        ? { id: previous.sessionId, resume: true }
        : { id: sessionUuid(agent), resume: false };
    // The messages of the one feedback path that waited for this session follow the resume delta
    // or the task message.
    const held = sessionFeedback(office, run);
    const taskMessage = [
      resume
        ? renderTemplate(FEEDBACK_TEMPLATES.resume, { reason: request.why })
        : (handoff as { text: string }).text,
      ...held.texts,
    ]
      .filter((part) => part !== "")
      .join("\n\n");
    const spec = runWorkerSpec(
      deps.worker,
      { runId: run.runId, agent, caps: tier, web: config.worker.web },
      paths,
      taskMessage,
      session,
      this.#remaining(office, run, tier, request),
    );
    try {
      // The developer's temp files live in its box: no run temp directory on the Mac (DIPO-240).
      ensurePrivateDir(paths.runDir);
      if (!resume) writeFileSync(spec.systemFile, systemFile, { mode: 0o600 });
    } catch (error) {
      return {
        kind: "failed",
        reason: `the run directory could not be prepared: ${messageOf(error)}`,
      };
    }

    // The run's box lives from claim to merge; one that was lost is rebuilt first (DIPO-278).
    const ensured = await this.#ensureBox(office, request, run, paths.runDir, git, config);
    if (ensured !== null) return { kind: "failed", reason: ensured };
    // The worker never starts on a box that lacks a merge dipo made on its branch (DIPO-324).
    if (deps.boxSync !== undefined) {
      try {
        await deps.boxSync(request.office, run);
      } catch (error) {
        return {
          kind: "failed",
          reason: `dipo's merge on the story branch could not be copied into the box: ${messageOf(error)}`,
        };
      }
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

    // Never a new host while an earlier host of the run still runs (0006 decision 8).
    const alive = await this.#earlierHostAlive(office, run.runId);
    if (alive !== null) return { kind: "hostAlive", code: "run.hostAlive", pid: alive };

    // The new host appends to the run's event file: its ingestion starts after what is there.
    const eventFile = join(paths.runDir, EVENTS_FILE);
    let offset = 0;
    try {
      offset = statSync(eventFile).size;
    } catch {
      offset = 0;
    }
    // The host row, its start offset and the new agent are one transaction (DIPO-57), so a daemon
    // that stops while the host starts finds the new agent at its restart and follows its host
    // instead of starting another session. The same transaction ends what the restart observed of
    // the old host (DIPO-57), before the new session's first ingestion pass can raise it again.
    const work: WorkRef = { ...request.work, agent, model: tier.model };
    let recorded = false;
    const recordAgent = () => {
      office.run(
        `insert or ignore into agents (office_id, agent_id, run_id, role, model, effort,
           session_id, system_hash, started_at)
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
          at: deps.clock.now(),
        },
      );
      // The held messages went with this session, in the transaction that records it.
      deliverHeld(office, run.runId, held.ids, deps.clock.now());
      // The prompt parts this session sent (0014 section 2): a handoff sends the system file and
      // the task message; a resume sends only its task message, the system file being the
      // session's own.
      recordPromptParts(
        office,
        run.runId,
        agent,
        resume ? [measurePart(TASK_PART, taskMessage)] : promptParts(systemFile, taskMessage, []),
        deps.clock,
      );
      // The prompt text, with `privacy.storePrompts` on (DIPO-137): a resume stores only its
      // message, the session keeping the system file it started with.
      recordPromptTexts(
        office,
        run.runId,
        agent,
        resume
          ? [{ part: "message", text: taskMessage }]
          : [
              { part: "system", text: systemFile },
              { part: "message", text: taskMessage },
            ],
        config,
        deps.clock,
      );
      const at = deps.clock.now();
      // The pack a new session's task message was built from (0020 section 6); a resume sends none.
      if (!resume && "pack" in handoff && run.worktree !== null) {
        recordContextPack(office, run.worktree, handoff.headSha, handoff.pack, deps.clock);
      }
      const cleared = clearSignals(office, run.runId, HOST_SIGNALS, at);
      if (cleared.length === 0) return;
      appendEntries(
        office,
        withWorkViews(
          office,
          cleared.map((signal): NewEntry => ({
            type: "work.observed",
            key: work.key,
            run: run.runId,
            delta: {
              work,
              signal: signal.signal,
              since: new Date(signal.since).toISOString(),
              clearedAt: new Date(at).toISOString(),
            },
          })),
        ),
        { at },
      );
    };
    let host;
    try {
      host = await deps.hosts.start(office, {
        runId: run.runId,
        agentId: agent,
        officeDir: paths.officeDir,
        plan: prepared.plan,
        processedOffset: offset,
        record: () => {
          recordAgent();
          recorded = true;
        },
      });
    } catch (error) {
      return { kind: "failed", reason: `the worker host did not start: ${messageOf(error)}` };
    }
    if (!recorded) {
      // A host starter that does not take the extras: the same writes, after the start.
      office.immediate(() => {
        office.run(
          `update worker_hosts set processed_offset = $offset
            where office_id = $office_id and run_id = $run and agent_id = $agent`,
          { offset, run: run.runId, agent },
        );
        recordAgent();
      });
    }
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
      // The usage share counts against the start budget plus its grants (DIPO-143).
      budgetLimit: runCaps(office, run).budgetTokens,
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

  /**
   * Makes sure the run's box is there before its next developer session (DIPO-278): null when it
   * is, or was rebuilt (the maintainer is told what it was made from and that undelivered work is
   * lost), else why it could not be. Without box workers there is nothing to check.
   */
  async #ensureBox(
    office: OfficeHandle,
    request: NextSessionRequest,
    run: StoredRun,
    runDir: string,
    git: OfficeGit,
    config: OfficeConfig,
  ): Promise<string | null> {
    const boxes = this.#deps.boxes;
    if (boxes === undefined) return null;
    const story = run.story ?? run.runId;
    if (run.branch === null || run.startSha === null) {
      return `${story}'s run has no branch or start commit to make its box from`;
    }
    const notices: NewEntry[] = [];
    const lifetime = new BoxLifetime({
      boxes,
      ...(this.#deps.profile === undefined ? {} : { profile: this.#deps.profile }),
      tmpRoot: this.#deps.tmpRoot,
    });
    const ensured = await lifetime.ensure(
      {
        office: request.office,
        runId: run.runId,
        runDir,
        story,
        branch: run.branch,
        startSha: run.startSha,
        slot: run.slot,
        git,
        config,
      },
      (reason, fallback) =>
        notices.push({
          type: "engine.notice",
          key: request.work.key,
          run: run.runId,
          delta: {
            level: "warn",
            code: LAUNCH_NOTICES.packageCacheSkipped,
            text: packageCacheSkippedText(story, reason, fallback),
          },
        }),
    );
    if (ensured.kind === "rebuilt") {
      notices.push({
        type: "engine.notice",
        key: request.work.key,
        run: run.runId,
        delta: {
          level: "warn",
          code: BOX_LIFETIME_NOTICES.rebuilt,
          text: boxRebuiltText(story, ensured),
        },
      });
    }
    if (notices.length > 0) this.#write(office, request.office, () => notices);
    return ensured.kind === "failed"
      ? `the run's box could not be made ready: ${ensured.reason}`
      : null;
  }

  /**
   * The PID of an earlier host of the run that still runs after waiting up to the host exit wait,
   * or null. A host whose exit was just ingested writes `exit.json` and ends within moments.
   */
  async #earlierHostAlive(office: OfficeHandle, runId: RunId): Promise<number | null> {
    const probe = this.#deps.probe;
    if (probe === undefined) return null;
    const deadline = this.#deps.clock.now() + (this.#deps.hostExitWaitMs ?? HOST_EXIT_WAIT_MS);
    for (;;) {
      let alive: number | null = null;
      for (const host of workerHostsOf(office, runId)) {
        if (await hostAlive(host, probe)) {
          alive = host.pid;
          break;
        }
      }
      if (alive === null || this.#deps.clock.now() >= deadline) return alive;
      await new Promise<void>((resolve) => {
        this.#deps.clock.setTimeout(resolve, HOST_EXIT_POLL_MS);
      });
    }
  }

  /** What remains of the run's caps for the CLI's own caps; at least one of each. */
  #remaining(
    office: OfficeHandle,
    run: StoredRun,
    tier: TierCaps,
    request: NextSessionRequest,
  ): Caps {
    const caps = runCaps(office, run, capsOf(tier));
    const used = runTotals(office, run.runId, request.startedAt, this.#deps.clock.now());
    return {
      budgetTokens: Math.max(1, caps.budgetTokens - used.budgetTokens),
      maxTurns: Math.max(1, caps.maxTurns - used.turns),
      maxMinutes: Math.max(1, Math.ceil(caps.maxMinutes - used.elapsedMs / 60_000)),
    };
  }

  /**
   * The task message of a new session (the story's task message with the handoff block) and the
   * context pack and input paths it was built from.
   */
  async #handoffMessage(
    office: OfficeHandle,
    git: OfficeGit,
    run: StoredRun,
    config: OfficeConfig,
    lastReport: WorkerReport | null,
    /** A box worker's run: the box scope section (DIPO-272) and the box handoff. */
    extra: HandoffExtra = { box: false },
  ): Promise<HandoffMessage> {
    const deps = this.#deps;
    const worktree = run.worktree ?? "";
    const box = extra.box;
    const story = await deps.story(office.officeId, run);
    const handoff = await (deps.handoff ?? this.#gather.bind(this))(office, run, lastReport, extra);
    const workspace = (deps.workspace ?? defaultWorkspace)(git, worktree);
    const claim = findClaim(office, run.runId);
    const baseSha = claim?.baseSha ?? run.startSha ?? (await workspace.headSha());
    const prompts = await renderRunPrompts({
      view: story.view,
      fields: story.fields,
      dependencies: story.dependencies,
      taskFile: story.taskFile,
      workspace,
      baseSha,
      config,
      handoff,
      ...(box ? { box: true } : {}),
    });
    return {
      text: prompts.taskMessage,
      pack: prompts.pack,
      headSha: prompts.headSha,
    };
  }

  async #gather(
    office: OfficeHandle,
    run: StoredRun,
    lastReport: WorkerReport | null,
    extra: HandoffExtra = { box: false },
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
      // dipo stores no verify result of its own: the box worker runs verify, CI checks (DIPO-342).
      lastVerify: null,
      // The items no later approval answered (0020 section 6).
      openFeedback: openFeedbackOf(office, run.runId),
      ...(extra.box ? { box: true } : {}),
      budget: runBudgetFacts(office, run, this.#deps.clock.now()),
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
