// The adapter-neutral Worker contract (0008 section 1). An adapter has a launch half (`plan`,
// `encode`), run by the worker host, and an interpret half (`interpret`, `result`), a pure parser
// the engine runs over `events.ndjson`. Nothing here names a CLI flag or a stream format; those
// stay inside the adapter's own directory (for Claude, `workers/claude-cli/`).

import type { OpenEnum, ParkReason } from "@dipsaus-orchestrator/contract";

import type { HookEvent, HookReply } from "../hooks/types";

/** Run kinds an adapter may know (0008 amendment of 2026-10-12, D12). M0 plans only `implement`. */
export const KNOWN_WORKER_KINDS = ["implement", "review", "session"] as const;
/** An open string: a later kind needs no contract change; an adapter refuses kinds it cannot plan. */
export type WorkerKind = OpenEnum<(typeof KNOWN_WORKER_KINDS)[number]>;

/** Caps per run, from the tier (0008 section 9). Loops stay in the engine. */
export interface Caps {
  /** Input plus output plus cache-creation tokens (0008 section 4). */
  readonly budgetTokens: number;
  readonly maxTurns: number;
  readonly maxMinutes: number;
}

/** A JSON Schema document, passed to the adapter as data. */
export type JsonSchema = Readonly<Record<string, unknown>>;

export interface WorkerSpec {
  /** Run id (`run-...`). */
  readonly run: string;
  /** Agent id (`agt-...`). */
  readonly agent: string;
  readonly kind: WorkerKind;
  /** Absolute working directory: the story worktree for `implement` and `review`. */
  readonly workdir: string;
  readonly model: string;
  readonly effort: string;
  readonly caps: Caps;
  /** Absolute path of the rendered L1+L2 system file (0014 section 1). */
  readonly systemFile: string;
  /** The L4 task message (0014 section 1); the first user message, never on argv. */
  readonly taskMessage: string;
  /** `allow`: the role's tool names; `deny`: extra deny rules of the role. */
  readonly tools: { readonly allow: readonly string[]; readonly deny: readonly string[] };
  /** Engine-made session id; `resume` continues that session instead of starting it. */
  readonly session: { readonly id: string; readonly resume: boolean };
  /** The schema the worker's report must follow (`WorkerReport`). */
  readonly reportSchema: JsonSchema;
  /** Relay the adapter's hooks to the worker host (0008 section 5). */
  readonly hookRelay: boolean;
}

/** A file the worker host writes into the run directory before it starts the worker. */
export interface LaunchFile {
  /** File name relative to the run directory; it may hold one subdirectory (`safe-chain/zsh`). */
  readonly name: string;
  readonly content: string;
  /** Written with mode 0700 instead of 0600 (the Safe-Chain shell wrapper, DIPO-82). */
  readonly executable?: boolean;
}

/** Everything the worker host needs to start one worker (0008 section 1, 0006 decision 8). */
export interface LaunchPlan {
  /** Program and arguments; `argv[0]` is an absolute path, never looked up on `PATH`. */
  readonly argv: readonly [string, ...string[]];
  /** The complete environment of the worker; nothing else is inherited. */
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  /** Files written into the run directory before the spawn. */
  readonly files: readonly LaunchFile[];
  /** Lines written to the worker's stdin right after the spawn, each ending in a newline. */
  readonly stdin: readonly string[];
}

/** What the engine asks of a running worker (0008 section 6). */
export type SteerOp =
  | { readonly kind: "steer" | "answer"; readonly text: string }
  | { readonly kind: "pause" | "stop" | "kill" }
  /** The engine's reply to a waiting hook call (0008 section 5), adapter-neutral. */
  | { readonly kind: "hookReply"; readonly reply: HookReply }
  | NudgeOp;

/**
 * A 0014 section 8 nudge (0008 amendment of 2026-10-12, DIPO-60): `text` for the worker, added to
 * the reply of the pending hook call `hook`, a tool use or a session start. The adapter decides how
 * its CLI shows it (Claude: `additionalContext`).
 */
export interface NudgeOp {
  readonly kind: "nudge";
  readonly text: string;
  /** The waiting hook call (`HookCall.id`). */
  readonly hook: number;
  /** The neutral hook event the call relayed. */
  readonly on: Extract<HookEvent["kind"], "toolUsed" | "sessionStarted">;
}

export type HostSignal = "SIGINT" | "SIGTERM" | "SIGKILL";

/**
 * One action of the worker host. The ops of one `encode` call run in order; a signal with
 * `afterMs` is sent that many milliseconds after the first op of the call, and only while the
 * worker still runs.
 */
export type HostOp =
  | { readonly write: string }
  | { readonly signal: HostSignal; readonly afterMs?: number }
  | { readonly closeStdin: true }
  /** Answers the waiting hook call `hookReply` with `output`, which the hook prints (DIPO-59). */
  | { readonly hookReply: number; readonly output: string };

/** Tokens of one model, cumulative over the run. */
export interface ModelUsageTotals {
  readonly input: number;
  readonly output: number;
  readonly cacheCreate: number;
  readonly cacheRead: number;
}
/** Keyed by the model id the adapter reports. */
export type UsageTotalsByModel = Readonly<Record<string, ModelUsageTotals>>;

export interface WorkerReportCriterion {
  /** The criterion number as in Backlog.md. */
  readonly n: number;
  readonly met: boolean;
  readonly evidence: string;
}

/** The report a worker returns at the end of a turn (0008 section 1, 0014). */
export interface WorkerReport {
  readonly status: "done" | "blocked";
  readonly criteria: readonly WorkerReportCriterion[];
  readonly summary: string;
  readonly commitSubject: string;
  readonly question?: string;
  readonly notes?: string;
  /** Blocked on a denied call (0008 section 5). */
  readonly needsPermission?: { readonly tool: string; readonly action: string };
}

export type WaitingOn = "permission" | "question" | "plan-limit" | "retry" | "auth";

/** Facts an adapter reads from a worker's output (0008 section 3). */
export type WorkerEvent =
  | {
      readonly t: "started";
      readonly sessionId: string;
      readonly model: string;
      readonly version: string;
      readonly permissionMode: string;
      readonly tools: readonly string[];
    }
  | {
      readonly t: "activity";
      readonly kind: "text" | "tool" | "subagent" | "thinking";
      readonly tool?: string;
      readonly path?: string;
      /**
       * The tool call's input beyond its path, as the adapter reads it (a shell command, a search
       * pattern, a URL). It may hold secrets: ingestion stores it only with the machine-local
       * opt-in `privacy.storeCommandBodies` (0007 section 8, DIPO-83).
       */
      readonly input?: string;
      /**
       * `thinking` only (DIPO-96): how long one finished thinking block took, in milliseconds, when
       * the adapter knows it. Counts only: no thinking text or signature ever travels.
       */
      readonly ms?: number;
      /** `thinking` only: the adapter's estimate of the block's thinking tokens, when it has one. */
      readonly tokens?: number;
      readonly agentId?: string;
    }
  | { readonly t: "output"; readonly text: string }
  | {
      readonly t: "usage";
      readonly messageId: string;
      readonly model: string;
      readonly agentId?: string;
      readonly input: number;
      /**
       * Output as the message reports it. It may be a placeholder until the turn ends, so run
       * totals take output only from `turn`; the per-message number is stored as reported.
       */
      readonly output: number;
      /** Cache creation, the sum of the two parts below (0008 section 4). */
      readonly cacheCreate: number;
      /** Cache creation for the 5 minute cache; all of it when the source gives no split. */
      readonly cacheCreate5m: number;
      /** Cache creation for the 1 hour cache. */
      readonly cacheCreate1h: number;
      readonly cacheRead: number;
    }
  | {
      readonly t: "turn";
      readonly report: WorkerReport | null;
      readonly totals: UsageTotalsByModel;
      /**
       * The adapter's own cost estimate in USD per model, run totals as of this turn end, when
       * the adapter reports one; the engine checks its pricing catalog against it (0008
       * section 4).
       */
      readonly costUsd?: Readonly<Record<string, number>>;
      readonly numTurns: number;
      readonly terminal: string;
      /**
       * Set when this turn ended at the adapter's own turn cap (the CLI backstop, 0008 section 7):
       * what fired, for the park detail. The engine stops the worker at this turn (DIPO-50).
       */
      readonly capped?: string;
      /**
       * Set when the turn ended without what the engine needs from it (DIPO-51, 0008 section 7):
       * no valid report, a full context, an execution error, a start failure or a plan limit.
       * Adapter-neutral; the engine decides what follows.
       */
      readonly problem?: TurnProblem;
    }
  | {
      readonly t: "waiting";
      readonly on: WaitingOn;
      readonly detail: string;
      readonly until?: string;
    }
  | { readonly t: "denied"; readonly tool: string; readonly reason: string }
  | {
      readonly t: "limit";
      readonly status: string;
      readonly utilization?: number;
      readonly resetsAt?: string;
      readonly creditsRequired?: boolean;
      /**
       * Which plan limit the event is about, when the adapter can tell (0008 section 7, DIPO-61):
       * `session`, `weekly` or `model:<family>`; absent when it cannot.
       */
      readonly scope?: PlanLimitScope;
    }
  /** A relayed hook, adapter-neutral (0008 section 5, DIPO-59). */
  | { readonly t: "hook"; readonly hook: HookEvent }
  | { readonly t: "compacted"; readonly preTokens: number }
  | { readonly t: "modelSwitched"; readonly from: string; readonly to: string }
  /**
   * The worker failed its start checks (0008 section 2: key source, model). Emitted once, before
   * any `started` of that init, so the engine can stop the worker at once instead of treating it
   * as a live start; the result is `initRejected`.
   */
  | { readonly t: "initRejected"; readonly reason: string };

/**
 * The scope of a plan limit an adapter can name (0008 section 7): `session` and `weekly` cover
 * every model, `model:<family>` only that family. The engine's wait facts add `credits` and
 * `unknown` (treated as `session`).
 */
export type PlanLimitScope = "session" | "weekly" | `model:${string}`;

/** What was wrong with a turn (0008 section 7); `detail` is one line for a park or a notice. */
export interface TurnProblem {
  readonly kind: TurnProblemKind;
  readonly detail: string;
}

export type TurnProblemKind = "report" | "contextFull" | "error" | "startFailed" | "planLimit";

export type WorkerOutcome =
  | "done"
  | "blocked"
  | "capped"
  | "plan-limit"
  | "stopped"
  | "reassigned"
  | "crashed"
  | "startFailed"
  | "initRejected";

/** How a run ended, as the adapter reads it; the engine decides what follows (0008 section 7). */
export interface WorkerResult {
  readonly outcome: WorkerOutcome;
  readonly report: WorkerReport | null;
  readonly usage: UsageTotalsByModel;
  readonly sessionId: string;
  readonly resumable: boolean;
  /** A proposed park; the engine decides. */
  readonly park?: { readonly reason: ParkReason; readonly detail: string };
  /**
   * The one recovery step 0008 section 7 asks for before the proposed park: `handoff` starts a
   * new session with a handoff, `report-feedback` sends one turn asking for a valid report.
   */
  readonly retry?: WorkerRetry;
  /** What failed, for a start failure that proposes no park (DIPO-51). */
  readonly detail?: string;
}

/** A recovery step the engine tries once before the proposed park (0008 section 7). */
export type WorkerRetry = "handoff" | "report-feedback";

/** Result of `probe`: version, login kind and capabilities (0008 sections 2 and 11). */
export interface AdapterStatus {
  readonly ok: boolean;
  readonly version: string | null;
  readonly login: string | null;
  readonly capabilities: readonly string[];
  /** Why the adapter refuses to run, when `ok` is false. */
  readonly reason?: string;
}

/** One line of `events.ndjson` as the worker host wrote it (0017 format). */
export interface HostLine {
  readonly t: number;
  readonly ch: string;
  readonly data: string;
  /**
   * The byte offset in `events.ndjson` after this line, when ingestion read it from the file. A
   * hook line's offset is the id the worker host holds a waiting hook call under (DIPO-59).
   */
  readonly end?: number;
}

/** Parser state an adapter threads through `interpret`; opaque to the engine. */
export type ParseState = Readonly<Record<string, unknown>>;

/** What `exit.json` records when the worker ends. */
export interface ExitRecord {
  readonly code: number | null;
  readonly signal: string | null;
  /** True when the host inferred `signal` from the one it sent last (DIPO-88). */
  readonly signalInferred?: boolean;
}

/** The native session a resume would continue. */
export interface SessionRef {
  readonly id: string;
  /** The transcript file when known; null lets the adapter look for it. */
  readonly transcriptPath: string | null;
  /** The adapter version the session ran on; null when it never started. */
  readonly version: string | null;
  /** The L1+L2 hash the session ran with; null when it was never recorded. */
  readonly systemHash: string | null;
  /** The context tokens of the session's last request; null or absent when unknown. */
  readonly contextTokens?: number | null;
  /** The model's context window; null or absent when unknown. */
  readonly contextWindow?: number | null;
  /** When the session's last request was made (engine clock, ms); null or absent when unknown. */
  readonly lastRequestAt?: number | null;
}

/** What a resume would run with now (0008 section 8, 0014 section 6). */
export interface ResumeFacts {
  /** The engine clock now. */
  readonly now: number;
  /** The adapter version a resume would run; null when the probe gave none. */
  readonly version: string | null;
  /** The L1+L2 hash a resume would run with. */
  readonly systemHash: string;
  /** The estimated tokens of the handoff task message a new session would get instead. */
  readonly handoffTokens: number;
  /** Resume only under this share of the context window (0014 section 6; 0.6 in M0). */
  readonly maxContextShare: number;
  /** Resume only when re-reading costs at most this many handoffs (0014 section 6; 3 in M0). */
  readonly rereadFactor: number;
}

export type ResumeCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface WorkerAdapter {
  /** For example `claude-cli`. */
  readonly id: string;
  /** Version, login kind, capabilities; refuses below the minimum. */
  probe(): Promise<AdapterStatus>;
  /** Pure: argv, env, files for the run dir, first stdin lines. */
  plan(spec: WorkerSpec): LaunchPlan;
  /** Pure: steer, answer, pause, stop, kill to stdin writes and signals. */
  encode(op: SteerOp): HostOp[];
  /** Pure parser over one host line. */
  interpret(
    line: HostLine,
    state: ParseState,
  ): { readonly events: WorkerEvent[]; readonly state: ParseState };
  /** Pure: the run's result once `exit.json` exists. */
  result(state: ParseState, exit: ExitRecord): WorkerResult;
  /**
   * Transcript present, version and prompt hash unchanged, and resuming cheaper than a handoff
   * (0008 section 8, 0014 section 6).
   */
  canResume(ref: SessionRef, spec: WorkerSpec, facts: ResumeFacts): ResumeCheck;
}

/** What a refused path is about, when `plan` refused a path (DIPO-74 AC #7). */
export interface PlanErrorPath {
  /** The refused absolute path. */
  readonly path: string;
  /** The character it refused, when a character was the reason. */
  readonly character?: string;
}

/** Thrown by `plan` when a spec or its launch context cannot be planned safely. */
export class PlanError extends Error {
  override readonly name = "PlanError";
  /** The refused path, when a path was the reason. */
  readonly refused: PlanErrorPath | undefined;

  constructor(message: string, refused?: PlanErrorPath) {
    super(message);
    this.refused = refused;
  }
}
