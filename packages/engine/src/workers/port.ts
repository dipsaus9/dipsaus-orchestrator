// What a run needs from a worker adapter (DIPO-74), adapter-neutral: the adapter for one run,
// its launch checks and the parser state ingestion starts from. The daemon supplies the Claude
// CLI one (`claude-cli/adapter.ts`); tests supply fakes. Nothing here names a CLI.

import type { OfficeConfig } from "../config";
import type { AdapterHold } from "./hold";
import type { LaunchPlan, ParseState, WorkerAdapter, WorkerSpec } from "./types";

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
  /** The parser state ingestion of a new session starts from. */
  initialState(spec: WorkerSpec): ParseState;
}
