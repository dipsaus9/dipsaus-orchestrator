// The Claude CLI `WorkerAdapter`, built per run (DIPO-74; 0008 section 1). `plan(spec)` closes
// over the run's `ClaudeLaunchContext`, so the engine calls the 0008 signature while DIPO-40's
// `plan(spec, ctx)` stays pure. `claudeWorkerPort` is what the daemon hands the run code: the
// adapter for a run's paths, the launch checks through the adapter hold, and the parser state.

import type { Clock, Spawn } from "@dipsaus-orchestrator/contract";

import type { OfficeConfig } from "../../config";
import type { DipoPlatform } from "../../platform/paths";
import type { RunStep } from "../credential-check";
import type { AdapterHolds } from "../hold";
import type { RunLaunchPaths, SessionFacts, WorkerPort } from "../port";
import type {
  AdapterStatus,
  ExitRecord,
  HostLine,
  LaunchPlan,
  LineScrub,
  ParseState,
  ResumeCheck,
  ResumeFacts,
  SessionRef,
  WorkerAdapter,
  WorkerSpec,
} from "../types";
import { PlanError } from "../types";
import { encode } from "./encode";
import { initialState, interpret, nextSessionOptions, type ClaudeParseState } from "./interpret";
import { prepareLaunch, type ClaudeLaunchCheckDeps } from "./launch-checks";
import { checkVerifyTools } from "./verify-tools";
import { CLAUDE_CLI_ADAPTER_ID, ENV_ALLOWLIST, plan, type ClaudeLaunchContext } from "./plan";
import { readInstalledPlugins, type PluginFiles } from "./plugins";
import { probe } from "./probe";
import { REPORT_JSON_SCHEMAS } from "./report-schema";
import { CLAUDE_LOCAL_SETTINGS } from "./settings-check";
import { expandHome } from "../../sandbox/policy";
import { SAFE_CHAIN_SHELL_DIR, type SafeChainInput, type SafeChainLaunch } from "./safe-chain";
import { checkResume } from "./resume-check";
import { result } from "./result";
import { readTranscript } from "./transcript";

export interface ClaudeCliAdapterDeps {
  readonly spawn: Spawn;
  readonly clock: Clock;
  readonly probeTimeoutMs?: number;
}

/**
 * What the host removes from each stdout line (DIPO-105): the text, signature and redacted data of
 * every thinking block, in assistant lines and in stream events. The block's `type` and the
 * duration and token fields stay, so ingestion still counts the thinking.
 */
export const CLAUDE_LINE_SCRUB: LineScrub = {
  blockTypes: ["thinking", "redacted_thinking", "thinking_delta", "signature_delta"],
  fields: ["thinking", "signature", "data"],
};

/** The plan with the Claude line scrub attached; the host applies it before it appends a line. */
function scrubbed(launch: LaunchPlan): LaunchPlan {
  return { ...launch, lineScrub: CLAUDE_LINE_SCRUB };
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

/**
 * The parser state with the `system/init` checks of this launch switched on. The engine's
 * `initialState` has no configuration; the adapter of the launch (or resume) has, so it sets them
 * on every line, whatever the stored state held, a null included:
 *
 * - the office's `worker.plugins` and the plugin ids of this launch (DIPO-108); a reviewer's state
 *   allows no plugin whatever `worker.plugins` says (0019 section 4, in the parser);
 * - the skills check (DIPO-130), always: `plan` passes `--disable-slash-commands` to every session.
 */
function withInitChecks(state: ClaudeParseState, ctx: ClaudeLaunchContext): ClaudeParseState {
  const checked = { ...state, refuseSkills: true };
  if (ctx.plugins === undefined) return checked;
  const installed = ctx.plugins.installed;
  return {
    ...checked,
    allowedPlugins: ctx.plugins.allowed,
    knownPlugins: Array.isArray(installed) ? installed : [],
  };
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
    plan: (spec: WorkerSpec) => scrubbed(plan(spec, ctx)),
    encode,
    interpret: (line: HostLine, state: ParseState) =>
      interpret(line, withInitChecks(state as unknown as ClaudeParseState, ctx)) as unknown as {
        readonly events: ReturnType<typeof interpret>["events"];
        readonly state: ParseState;
      },
    result: (state: ParseState, exit: ExitRecord) =>
      result(state as unknown as ClaudeParseState, exit),
    // Transcript, version, prompt hash, context share and re-read cost (DIPO-51).
    canResume: (ref: SessionRef, _spec: WorkerSpec, facts: ResumeFacts): ResumeCheck =>
      checkResume(ref, { ...facts, home: ctx.home }),
    readTranscript,
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
  /**
   * How to run this `dipo` (`selfCommand()`), for the run settings file's hooks (DIPO-59). Without
   * it the hooks are not registered, so a spec that asks for the hook relay cannot be planned.
   */
  readonly dipoCommand?: readonly [string, ...string[]];
  /**
   * Finds Safe-Chain at launch (DIPO-82; `detectSafeChain` in the daemon). Without it, or when it
   * returns null, the launch is as on a machine without Safe-Chain.
   */
  readonly detectSafeChain?: (input: SafeChainInput) => SafeChainLaunch | null;
  /**
   * The daemon's Safe-Chain checking proxies (DIPO-84): a launch on a machine with Safe-Chain
   * starts its run's proxy through them; without them such a launch is refused.
   */
  readonly safeChainProxies?: ClaudeLaunchCheckDeps["safeChainProxies"];
  /**
   * Reads Claude Code's plugin lists (DIPO-108); a test seam. Defaults to the files under
   * `home`.
   */
  readonly pluginFiles?: PluginFiles;
  /**
   * The launch checks' file system and settings reader (DIPO-105); a test seam. Default to the
   * real ones.
   */
  readonly launchCheckSeams?: Pick<ClaudeLaunchCheckDeps, "fs" | "readText">;
}

/** The launch context of one run from its paths, the office configuration and the daemon. */
export function claudeLaunchContext(
  deps: Pick<
    ClaudeWorkerPortDeps,
    "claudePath" | "home" | "env" | "dipoCommand" | "detectSafeChain" | "pluginFiles"
  >,
  paths: RunLaunchPaths,
  config: OfficeConfig,
): ClaudeLaunchContext {
  if (deps.claudePath === undefined) {
    throw new PlanError(
      "claude was not found on the daemon's PATH; install Claude Code and restart the daemon with it on PATH",
    );
  }
  const safeChain = deps.detectSafeChain?.({
    home: deps.home,
    env: deps.env,
    readPaths: [...config.sandbox.toolchainReadPaths, ...config.sandbox.allowRead].map((path) =>
      expandHome(path, deps.home),
    ),
  });
  return {
    claudePath: deps.claudePath,
    home: deps.home,
    env: deps.env,
    toolVariables: [],
    mainCheckout: paths.mainCheckout,
    runDir: paths.runDir,
    hostSocket: paths.hostSocket,
    tmpDir: paths.tmpDir,
    shortTmpDir: paths.shortTmpDir,
    sandbox: config.sandbox,
    // Read per launch, so a plugin installed since the last run is switched off too (DIPO-108).
    plugins: {
      installed: readInstalledPlugins(deps.home, deps.pluginFiles),
      allowed: config.worker.plugins,
    },
    ...(deps.dipoCommand === undefined ? {} : { hookCommand: deps.dipoCommand }),
    permissionWaitSeconds: config.timeouts.permissionWaitSeconds,
    ...(safeChain === null || safeChain === undefined
      ? {}
      : { safeChain: { ...safeChain, shellDir: `${paths.runDir}/${SAFE_CHAIN_SHELL_DIR}` } }),
  };
}

/** The Claude CLI as a run's worker. */
export function claudeWorkerPort(deps: ClaudeWorkerPortDeps): WorkerPort {
  return {
    id: CLAUDE_CLI_ADAPTER_ID,
    reportSchema: REPORT_JSON_SCHEMAS,
    localSettings: CLAUDE_LOCAL_SETTINGS,
    adapter: (paths, config) => claudeCliAdapter(claudeLaunchContext(deps, paths, config), deps),
    checkVerify: (paths, config, verify, root) =>
      checkVerifyTools(claudeLaunchContext(deps, paths, config), root, verify),
    prepare: async (spec, paths, config, checkSession, verify) => {
      const prepared = await prepareLaunch(
        spec,
        claudeLaunchContext(deps, paths, config),
        deps.holds,
        {
          spawn: deps.spawn,
          clock: deps.clock,
          selfTestSessionId: checkSession,
          allowProjectSettings: config.worker.allowProjectSettings,
          platform: deps.platform,
          runStep: deps.runStep,
          uid: deps.uid,
          ...deps.launchCheckSeams,
          ...(deps.safeChainProxies === undefined
            ? {}
            : { safeChainProxies: deps.safeChainProxies }),
        },
        verify,
      );
      return prepared.ok ? { ok: true, plan: scrubbed(prepared.plan) } : prepared;
    },
    initialState: (spec, previous) =>
      initialState({
        ...(previous === undefined
          ? { plannedModel: spec.model }
          : nextSessionOptions(
              previous as unknown as ClaudeParseState,
              spec.session.resume,
              spec.model,
            )),
        // A reviewer's result carries a `ReviewReport` (0019 section 5).
        ...(spec.kind === "review" ? { reportKind: "review" as const } : {}),
      }) as unknown as ParseState,
    encode,
    result: (state, exit) => result(state as unknown as ClaudeParseState, exit),
    sessionFacts: (state) => claudeSessionFacts(state as unknown as ClaudeParseState),
    readTranscript,
  };
}

/** What a Claude session's parser state says for its next session (DIPO-51). */
export function claudeSessionFacts(state: Partial<ClaudeParseState>): SessionFacts {
  return {
    contextTokens: state.contextTokens ?? null,
    contextWindow: state.contextWindow ?? null,
    lastReport: state.lastTurn?.report ?? null,
  };
}
