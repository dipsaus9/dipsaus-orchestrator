// What a run needs from a worker adapter (DIPO-74), adapter-neutral: the adapter for one run,
// its launch checks, the parser state ingestion starts from, the report schema and the local
// settings file worktree setup copies (DIPO-113). The daemon supplies the Claude CLI one
// (`claude-cli/adapter.ts`); tests supply fakes. Nothing here names a CLI.

import type { OfficeConfig } from "../config";
import type { AdapterHold } from "./hold";
import type {
  ExitRecord,
  HostOp,
  JsonSchema,
  LaunchPlan,
  ParseState,
  SchemaKind,
  SteerOp,
  TranscriptRead,
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
  /**
   * The run's short temp root (DIPO-118), the worker's `DIPO_TMP`: also writable by its sandboxed
   * commands, and short enough for testkit's Unix socket path limit.
   */
  readonly shortTmpDir: string;
}

/** The resolved verify of an office: argument lists run in order, from `cwd` below the checkout. */
export interface VerifyCommands {
  readonly commands: readonly (readonly string[])[];
  /** Repo-relative working directory; `"."` is the root. */
  readonly cwd: string;
}

export type PreparedWorker =
  | { readonly ok: true; readonly plan: LaunchPlan }
  | { readonly ok: false; readonly outcome: "startFailed"; readonly hold: AdapterHold };

/**
 * The adapter's local settings file that worktree setup copies from the main checkout, filtered
 * (0010 section 8 and its 0008 amendment; for Claude `.claude/settings.local.json` without its
 * permission-widening and MCP keys).
 */
export interface LocalSettingsCopy {
  /** The repo-relative path of the file. */
  readonly file: string;
  /** Pure: the parsed file as the setup copy writes it. */
  strip(settings: Record<string, unknown>): Record<string, unknown>;
}

export interface WorkerPort {
  /** The adapter id, as `worker.adapter` names it (for example `claude-cli`). */
  readonly id: string;
  /**
   * The JSON Schema a run puts in `WorkerSpec.reportSchema`, per kind (0008 section 1 and its
   * amendment of 2026-10-16): `WorkerReport` for `implement`, `ReviewReport` for `review`.
   */
  readonly reportSchema: Readonly<Record<SchemaKind, JsonSchema>>;
  /** What worktree setup copies as the adapter's local settings (DIPO-39, DIPO-113). */
  readonly localSettings: LocalSettingsCopy;
  /** The adapter for one run, its `plan` bound to the run's launch context (0008 section 1). */
  adapter(paths: RunLaunchPaths, config: OfficeConfig): WorkerAdapter;
  /**
   * Plans the launch and runs the adapter's launch checks before it (0008 section 2). A refused
   * check holds the adapter and returns `startFailed`; a spec or path that cannot be planned
   * throws `PlanError`. A developer session is planned only in its run's box (DIPO-240, 0021).
   */
  prepare(
    spec: WorkerSpec,
    paths: RunLaunchPaths,
    config: OfficeConfig,
    checkSession: string,
  ): Promise<PreparedWorker>;
  /**
   * The dry run's plan of a developer session in a box (DIPO-240): what the worker host would run,
   * with placeholders for the box a real run makes. An adapter without it shows none.
   */
  previewBox?(spec: WorkerSpec, paths: RunLaunchPaths): LaunchPlan;
  /**
   * The parser state ingestion of a session starts from. For the run's next session (DIPO-51)
   * `previous` is the previous session's stored state: recorded classifier switches carry over,
   * and a resume (`spec.session.resume`) starts from its usage baseline, so restored spend is
   * not counted twice. The spec's kind decides which report the state parses.
   */
  initialState(spec: WorkerSpec, previous?: ParseState): ParseState;
  /** Pure: a steering op as host ops (the adapter's `encode`, DIPO-50); needs no run paths. */
  encode(op: SteerOp): HostOp[];
  /** Pure: the run's result from a session's parser state and exit (the adapter's `result`). */
  result(state: ParseState, exit: ExitRecord): WorkerResult;
  /** Pure: what a session's parser state says for a resume or a handoff (DIPO-51). */
  sessionFacts(state: ParseState): SessionFacts;
  /**
   * Pure: the usage messages of a worker transcript's lines (0008 section 4, DIPO-134), for a host
   * that died without `exit.json`. Refused when the adapter version's transcript format is not
   * covered. An adapter without a transcript leaves it out.
   */
  readTranscript?(lines: readonly string[], version: string | null): TranscriptRead;
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
