// The Claude CLI `WorkerAdapter`, built per run (DIPO-74; 0008 section 1). `plan(spec)` closes
// over the run's `ClaudeLaunchContext`, so the engine calls the 0008 signature while DIPO-40's
// `plan(spec, ctx)` stays pure. `claudeWorkerPort` is what the daemon hands the run code: the
// adapter for a run's paths, the launch checks through the adapter hold, and the parser state.

import type { Clock, Spawn } from "@dipsaus-orchestrator/contract";

import type { OfficeConfig } from "../../config";
import type { DipoPlatform } from "../../platform/paths";
import type { RunStep } from "../credential-check";
import type { AdapterHolds } from "../hold";
import type { RunLaunchPaths, WorkerPort } from "../port";
import type {
  AdapterStatus,
  ExitRecord,
  HostLine,
  ParseState,
  ResumeCheck,
  SessionRef,
  WorkerAdapter,
  WorkerSpec,
} from "../types";
import { PlanError } from "../types";
import { encode } from "./encode";
import { initialState, interpret, type ClaudeParseState } from "./interpret";
import { prepareLaunch } from "./launch-checks";
import { CLAUDE_CLI_ADAPTER_ID, ENV_ALLOWLIST, plan, type ClaudeLaunchContext } from "./plan";
import { probe } from "./probe";
import { result } from "./result";

export interface ClaudeCliAdapterDeps {
  readonly spawn: Spawn;
  readonly clock: Clock;
  readonly probeTimeoutMs?: number;
}

/** The environment `probe` runs with: the worker's allowlist, so it sees the worker's login. */
function probeEnv(ctx: ClaudeLaunchContext): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ENV_ALLOWLIST) {
    const value = ctx.env[name];
    if (value !== undefined) env[name] = value;
  }
  env["HOME"] = ctx.home;
  return env;
}

/** The Claude CLI adapter for one run. */
export function claudeCliAdapter(
  ctx: ClaudeLaunchContext,
  deps: ClaudeCliAdapterDeps,
): WorkerAdapter {
  return {
    id: CLAUDE_CLI_ADAPTER_ID,
    probe: (): Promise<AdapterStatus> =>
      probe({
        spawn: deps.spawn,
        clock: deps.clock,
        claudePath: ctx.claudePath,
        env: probeEnv(ctx),
        ...(deps.probeTimeoutMs === undefined ? {} : { timeoutMs: deps.probeTimeoutMs }),
      }),
    plan: (spec: WorkerSpec) => plan(spec, ctx),
    encode,
    interpret: (line: HostLine, state: ParseState) =>
      interpret(line, state as unknown as ClaudeParseState) as unknown as {
        readonly events: ReturnType<typeof interpret>["events"];
        readonly state: ParseState;
      },
    result: (state: ParseState, exit: ExitRecord) =>
      result(state as unknown as ClaudeParseState, exit),
    // The version and prompt hash checks belong to the resume (DIPO-51); a session without a
    // transcript can never resume.
    canResume: (ref: SessionRef): ResumeCheck =>
      ref.transcriptPath === null
        ? { ok: false, reason: `session ${ref.id} has no transcript to resume` }
        : { ok: true },
  };
}

export interface ClaudeWorkerPortDeps extends ClaudeCliAdapterDeps {
  /** The `claude` the daemon resolved on its PATH at start; undefined when none was found. */
  readonly claudePath: string | undefined;
  readonly home: string;
  /** The daemon's environment; the plan takes only allowlisted names from it. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly holds: AdapterHolds;
  readonly platform: DipoPlatform;
  /** Runs one engine step inside srt (the credential check). */
  readonly runStep: RunStep;
  readonly uid: number;
}

/** The launch context of one run from its paths, the office configuration and the daemon. */
export function claudeLaunchContext(
  deps: Pick<ClaudeWorkerPortDeps, "claudePath" | "home" | "env">,
  paths: RunLaunchPaths,
  config: OfficeConfig,
): ClaudeLaunchContext {
  if (deps.claudePath === undefined) {
    throw new PlanError(
      "claude was not found on the daemon's PATH; install Claude Code and restart the daemon with it on PATH",
    );
  }
  return {
    claudePath: deps.claudePath,
    home: deps.home,
    env: deps.env,
    toolVariables: [],
    mainCheckout: paths.mainCheckout,
    runDir: paths.runDir,
    hostSocket: paths.hostSocket,
    tmpDir: paths.tmpDir,
    sandbox: config.sandbox,
  };
}

/** The Claude CLI as a run's worker. */
export function claudeWorkerPort(deps: ClaudeWorkerPortDeps): WorkerPort {
  return {
    id: CLAUDE_CLI_ADAPTER_ID,
    adapter: (paths, config) => claudeCliAdapter(claudeLaunchContext(deps, paths, config), deps),
    prepare: (spec, paths, config, checkSession) =>
      prepareLaunch(spec, claudeLaunchContext(deps, paths, config), deps.holds, {
        spawn: deps.spawn,
        clock: deps.clock,
        selfTestSessionId: checkSession,
        allowProjectSettings: config.worker.allowProjectSettings,
        platform: deps.platform,
        runStep: deps.runStep,
        uid: deps.uid,
      }),
    initialState: (spec) => initialState({ plannedModel: spec.model }) as unknown as ParseState,
  };
}
