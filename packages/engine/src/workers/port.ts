// What a run needs from a worker adapter (DIPO-74), adapter-neutral: the adapter for one run,
// its launch checks and the parser state ingestion starts from. The daemon supplies the Claude
// CLI one (`claude-cli/adapter.ts`); tests supply fakes. Nothing here names a CLI.

import type { OfficeConfig } from "../config";
import type { AdapterHold } from "./hold";
import type {
  ExitRecord,
  HostOp,
  LaunchPlan,
  ParseState,
  SteerOp,
  WorkerAdapter,
  WorkerReport,
  WorkerResult,
  WorkerSpec,
} from "./types";

/** Where one run lives; every path is absolute. */
export interface RunLaunchPaths {
  /** The story worktree; the worker's working directory. */
  readonly workdir: string;
  /** The repository's main checkout. */
  readonly mainCheckout: string;
  /** `<git-common-dir>/dipo/runs/<run-id>`, where the host writes the plan's files. */
  readonly runDir: string;
  /** The worker host's socket. */
  readonly hostSocket: string;
  /** The temp directory the worker's sandboxed commands may write. */
  readonly tmpDir: string;
}

export type PreparedWorker =
  | { readonly ok: true; readonly plan: LaunchPlan }
  | { readonly ok: false; readonly outcome: "startFailed"; readonly hold: AdapterHold };

export interface WorkerPort {
  /** The adapter id, as `worker.adapter` names it (for example `claude-cli`). */
  readonly id: string;
  /** The adapter for one run, its `plan` bound to the run's launch context (0008 section 1). */
  adapter(paths: RunLaunchPaths, config: OfficeConfig): WorkerAdapter;
  /**
   * Plans the launch and runs the adapter's launch checks before it (0008 section 2). A refused
   * check holds the adapter and returns `startFailed`; a spec or path that cannot be planned
   * throws `PlanError`.
   */
  prepare(
    spec: WorkerSpec,
    paths: RunLaunchPaths,
    config: OfficeConfig,
    checkSession: string,
  ): Promise<PreparedWorker>;
  /**
   * The parser state ingestion of a session starts from. For the run's next session (DIPO-51)
   * `previous` is the previous session's stored state: recorded classifier switches carry over,
   * and a resume (`spec.session.resume`) starts from its usage baseline, so restored spend is
   * not counted twice.
   */
  initialState(spec: WorkerSpec, previous?: ParseState): ParseState;
  /** Pure: a steering op as host ops (the adapter's `encode`, DIPO-50); needs no run paths. */
  encode(op: SteerOp): HostOp[];
  /** Pure: the run's result from a session's parser state and exit (the adapter's `result`). */
  result(state: ParseState, exit: ExitRecord): WorkerResult;
  /** Pure: what a session's parser state says for a resume or a handoff (DIPO-51). */
  sessionFacts(state: ParseState): SessionFacts;
}

/** What a session's parser state says for its next session (DIPO-51). */
export interface SessionFacts {
  /** Context tokens of the last request; null when unknown. */
  readonly contextTokens: number | null;
  /** The model's context window; null when unknown. */
  readonly contextWindow: number | null;
  /** The last valid report of the session; null when there is none. */
  readonly lastReport: WorkerReport | null;
}
