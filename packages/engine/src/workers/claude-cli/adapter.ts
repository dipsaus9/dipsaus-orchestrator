// The Claude CLI `WorkerAdapter`, built per run (DIPO-74; 0008 section 1). `plan(spec)` closes
// over the run's `ClaudeLaunchContext`, so the engine calls the 0008 signature while DIPO-40's
// `plan(spec, ctx)` stays pure. `claudeWorkerPort` is what the daemon hands the run code: the
// adapter for a run's paths, the launch checks through the adapter hold, and the parser state.
//
// A developer session runs only in its run's box (DIPO-240, 0021): `prepare` plans it there with
// `planInBox`, and refuses one whose run has no box as a plan (`PlanError`). A reviewer session
// runs on the Mac with its read-only plan and launch checks (`plan.ts`, `launch-checks.ts`).

import type { Clock, Spawn } from "@dipsaus-orchestrator/contract";

import type { OfficeConfig } from "../../config";
import { type AdapterHolds, gateLaunch } from "../hold";
import type { PreparedWorker, RunLaunchPaths, SessionFacts, WorkerPort } from "../port";
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
import { BOX_DIPO_DIR, BOX_WORKDIR } from "../../box/code";
import { BoxError } from "../../box/port";
import type { BoxSession, BoxWorkers } from "../../box/workers";
import { planInBox } from "./box-plan";
import { encode } from "./encode";
import { initialState, interpret, nextSessionOptions, type ClaudeParseState } from "./interpret";
import { prepareLaunch, type ClaudeLaunchCheckDeps } from "./launch-checks";
import {
  CLAUDE_CLI_ADAPTER_ID,
  DEVELOPER_ON_MAC_REFUSED,
  ENV_ALLOWLIST,
  plan,
  type ClaudeLaunchContext,
} from "./plan";
import { readInstalledPlugins, type PluginFiles } from "./plugins";
import { probe } from "./probe";
import { REPORT_JSON_SCHEMAS } from "./report-schema";
import { CLAUDE_LOCAL_SETTINGS } from "./settings-check";
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

/** The environment `probe` runs with: the session's allowlist, so it sees the session's login. */
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
 * - the skills check (DIPO-130), always: every session is planned with `--disable-slash-commands`.
 */
function withInitChecks(
  state: ClaudeParseState,
  ctx: ClaudeLaunchContext,
  boxWorker: boolean,
): ClaudeParseState {
  const checked = {
    ...state,
    refuseSkills: true,
    // A box worker has only the placeholder key, which the model proxy replaces (DIPO-271).
    ...(boxWorker ? { placeholderKey: true } : {}),
  };
  if (ctx.plugins === undefined) return checked;
  const installed = ctx.plugins.installed;
  return {
    ...checked,
    allowedPlugins: ctx.plugins.allowed,
    knownPlugins: Array.isArray(installed) ? installed : [],
  };
}

/** The Claude CLI adapter for one run; `boxWorker` when its developer runs in a box (DIPO-271). */
export function claudeCliAdapter(
  ctx: ClaudeLaunchContext,
  deps: ClaudeCliAdapterDeps,
  options: { readonly boxWorker?: boolean } = {},
): WorkerAdapter {
  const boxWorker = options.boxWorker === true;
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
      interpret(
        line,
        withInitChecks(state as unknown as ClaudeParseState, ctx, boxWorker),
      ) as unknown as {
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
  /**
   * How to run this `dipo` (`selfCommand()`), for the reviewer's run settings hooks (DIPO-59).
   * Without it the hooks are not registered, so a spec that asks for the hook relay cannot be
   * planned.
   */
  readonly dipoCommand?: readonly [string, ...string[]];
  /**
   * Reads Claude Code's plugin lists (DIPO-108); a test seam. Defaults to the files under
   * `home`.
   */
  readonly pluginFiles?: PluginFiles;
  /** The launch checks' settings reader (DIPO-105); a test seam. Defaults to the real one. */
  readonly launchCheckSeams?: Pick<ClaudeLaunchCheckDeps, "readText">;
  /**
   * The box workers (DIPO-271, DIPO-240): a run whose run directory records a box runs its
   * developer sessions in that box. Without them, or for a run without a box, no developer
   * session is planned.
   */
  readonly boxes?: ClaudeBoxWorkers;
}

/** What the Claude worker port needs of the box workers (`BoxWorkers`). */
export type ClaudeBoxWorkers = Pick<BoxWorkers, "isBoxRun" | "session">;

/**
 * Prepares a developer session in the run's box (DIPO-271): the adapter hold first (a sticky
 * box-token hold refuses here), then the box session, then the plan. A box that cannot be made
 * ready holds the adapter with the `box` check, as a failed launch check; a run whose box is gone
 * is refused as a plan (`PlanError`), holding nothing.
 */
async function prepareInBox(
  spec: WorkerSpec,
  paths: RunLaunchPaths,
  boxes: ClaudeBoxWorkers,
  holds: AdapterHolds,
): Promise<PreparedWorker> {
  const gate = await gateLaunch(CLAUDE_CLI_ADAPTER_ID, holds, async () => ({ ok: true }));
  if (!gate.ok) return gate;
  let session;
  try {
    // The run is open here: the launcher made it, or the resumer's caller reopened it, so no pass
    // stops this box while its session starts (`BoxWorkers.session`, DIPO-278).
    session = await boxes.session({
      runId: spec.run,
      runDir: paths.runDir,
      systemFile: spec.systemFile,
    });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    if (error instanceof BoxError && error.code === "box.gone") throw new PlanError(why);
    const hold = holds.hold(CLAUDE_CLI_ADAPTER_ID, [
      {
        check: BOX_CHECK,
        detail: `the worker's box could not be made ready: ${why}`,
        fix: "Check that Apple container runs (`container system status`) and the daemon log, then name the story again.",
      },
    ]);
    return { ok: false, outcome: "startFailed", hold };
  }
  return { ok: true, plan: scrubbed(planInBox(spec, session, paths.runDir)) };
}

/** The placeholder of the dry run's box, which a real run names after its run id. */
export const PREVIEW_BOX = "dipo-<run-id>";

/**
 * The box session of the dry run (DIPO-240): the plan shows the command Claude Code runs in the
 * box, with placeholders for the box and dipo's routes a real run makes.
 */
function previewSession(): BoxSession {
  return {
    box: PREVIEW_BOX,
    workdir: BOX_WORKDIR,
    env: {
      HTTPS_PROXY: "<dipo's web route for the box>",
      HTTP_PROXY: "<dipo's web route for the box>",
      NODE_EXTRA_CA_CERTS: `${BOX_DIPO_DIR}/safe-chain-ca.pem`,
      ANTHROPIC_BASE_URL: "<dipo's model proxy for the box>",
    },
    systemFile: `${BOX_DIPO_DIR}/system.md`,
    exec: (command, env) => ({ argv: command, env: { ...env } }),
    stop: { argv: ["<the box backend>", "stop", PREVIEW_BOX], env: {} },
  };
}

/** The launch check name of a box that could not be made ready for a session. */
export const BOX_CHECK = "box";

/** The launch context of one run from its paths, the office configuration and the daemon. */
export function claudeLaunchContext(
  deps: Pick<ClaudeWorkerPortDeps, "claudePath" | "home" | "env" | "dipoCommand" | "pluginFiles">,
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
    shortTmpDir: paths.shortTmpDir,
    sandbox: config.sandbox,
    // Read per launch, so a plugin installed since the last run is switched off too (DIPO-108).
    plugins: {
      installed: readInstalledPlugins(deps.home, deps.pluginFiles),
      allowed: config.worker.plugins,
    },
    ...(deps.dipoCommand === undefined ? {} : { hookCommand: deps.dipoCommand }),
  };
}

/** The Claude CLI as a run's worker. */
export function claudeWorkerPort(deps: ClaudeWorkerPortDeps): WorkerPort {
  return {
    id: CLAUDE_CLI_ADAPTER_ID,
    reportSchema: REPORT_JSON_SCHEMAS,
    localSettings: CLAUDE_LOCAL_SETTINGS,
    adapter: (paths, config) =>
      claudeCliAdapter(claudeLaunchContext(deps, paths, config), deps, {
        boxWorker: deps.boxes?.isBoxRun(paths.runDir) === true,
      }),
    previewBox: (spec, paths) => scrubbed(planInBox(spec, previewSession(), paths.runDir)),
    prepare: async (spec, paths, config) => {
      // A developer session goes into its run's box, never onto the Mac (0021); a reviewer stays on
      // the Mac (0021 section 10).
      if (spec.kind === "implement") {
        if (deps.boxes?.isBoxRun(paths.runDir) !== true) {
          throw new PlanError(
            deps.boxes === undefined
              ? `${DEVELOPER_ON_MAC_REFUSED}, and this daemon has no box backend: install Apple container and restart the daemon with it on its PATH`
              : `${DEVELOPER_ON_MAC_REFUSED}, and the run has no box`,
          );
        }
        return prepareInBox(spec, paths, deps.boxes, deps.holds);
      }
      const prepared = await prepareLaunch(
        spec,
        claudeLaunchContext(deps, paths, config),
        deps.holds,
        {
          spawn: deps.spawn,
          clock: deps.clock,
          allowProjectSettings: config.worker.allowProjectSettings,
          ...deps.launchCheckSeams,
        },
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
