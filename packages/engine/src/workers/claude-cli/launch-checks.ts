// The Claude CLI launch checks (0008 section 2 and its amendments): probe, project settings
// check, the engine-side credential check under srt and the session self-test, run before every
// launch and every resume. `prepareLaunch` is the one way to get a
// launch plan the host may start: it plans, runs the checks through the adapter hold's gate and
// returns the plan only when they pass; a refusal is `startFailed` with the hold set (DIPO-74
// rolls back the claim, DIPO-51 resumes through the same function). The npm token check
// (DIPO-172) runs first and refuses with a `PlanError`, which holds no adapter.

import type { Clock, Spawn } from "@dipsaus-orchestrator/contract";

import {
  gateLaunch,
  type AdapterHold,
  type AdapterHolds,
  type LaunchCheckFailure,
  type LaunchCheckOutcome,
} from "../hold";
import type { SafeChainProxies } from "../../sandbox/safe-chain-proxies";
import type { DipoPlatform } from "../../platform/paths";
import type { LaunchPlan, WorkerSpec } from "../types";
import { CLAUDE_CLI_ADAPTER_ID, plan, SETTINGS_FILE, type ClaudeLaunchContext } from "./plan";
import { checkNpmTokens } from "./npm-token-check";
import { probe } from "./probe";
import { safeChainCaFile } from "./safe-chain";
import { checkProjectSettings, type ReadOptionalText } from "./settings-check";
import { engineCredentialCheck, type RunStep } from "../credential-check";
import {
  nodeSelfTestFs,
  resolveSelfTestTools,
  runSelfTest,
  selfTestFailure,
  workerWritableRoots,
  type SelfTestFs,
} from "./self-test";

export interface ClaudeLaunchCheckDeps {
  readonly spawn: Spawn;
  readonly clock: Clock;
  /** An engine-made UUID for the self-test session (a new one per check). */
  readonly selfTestSessionId: string;
  /** `worker.allowProjectSettings` of the office. */
  readonly allowProjectSettings: readonly string[];
  readonly readText?: ReadOptionalText;
  readonly fs?: SelfTestFs;
  readonly probeTimeoutMs?: number;
  readonly selfTestTimeoutMs?: number;
  /** Decides whether the Keychain lookup runs (macOS only). */
  readonly platform: DipoPlatform;
  /** Runs one engine step inside srt (`runSandboxedStep` with its deps bound). */
  readonly runStep: RunStep;
  /** The user id, for the step policy. */
  readonly uid: number;
  /**
   * The daemon's Safe-Chain proxies (DIPO-84). With Safe-Chain detected, a launch starts its run's
   * proxy here; without it such a launch is refused.
   */
  readonly safeChainProxies?: Pick<SafeChainProxies, "start" | "stop" | "awaitHost">;
}

/**
 * Tools that load project agents or skills. 0008 section 2 asks for a frontmatter check of
 * `.claude/agents/*.md` and the skills for such roles; until it exists they are refused.
 */
export const UNCHECKED_TOOLS: readonly string[] = ["Agent", "Task", "Skill"];

function settingsOf(launch: LaunchPlan): string {
  const file = launch.files.find((entry) => entry.name === SETTINGS_FILE);
  if (file === undefined) throw new Error("the launch plan has no run settings file");
  return file.content;
}

/**
 * The three checks in order; a later one runs only when the earlier ones pass, because the
 * self-test starts a Claude Code session and is pointless on a refused login or settings.
 */
export async function claudeLaunchChecks(
  spec: WorkerSpec,
  ctx: ClaudeLaunchContext,
  launch: LaunchPlan,
  deps: ClaudeLaunchCheckDeps,
): Promise<LaunchCheckOutcome> {
  const unchecked = spec.tools.allow.filter((tool) => UNCHECKED_TOOLS.includes(tool));
  if (unchecked.length > 0) {
    return {
      ok: false,
      failures: unchecked.map((tool) => ({
        check: "tools",
        key: tool,
        detail:
          "a role with this tool loads .claude/agents and skills, whose frontmatter can set permissionMode and hooks, and that check does not exist yet (0008 section 2)",
        fix: "Remove the tool from the role until the agents and skills check is built.",
      })),
    };
  }
  const status = await probe({
    spawn: deps.spawn,
    clock: deps.clock,
    claudePath: launch.argv[0],
    env: launch.env,
    ...(deps.probeTimeoutMs === undefined ? {} : { timeoutMs: deps.probeTimeoutMs }),
  });
  if (!status.ok) {
    return {
      ok: false,
      failures: [{ check: "probe", detail: status.reason ?? "Claude Code failed the probe" }],
    };
  }
  const settings = await checkProjectSettings(
    spec.workdir,
    deps.allowProjectSettings,
    deps.readText,
  );
  if (settings.length > 0) return { ok: false, failures: settings };

  // The engine runs the credential commands itself, under srt, with no model (0008 amendment).
  const fs = deps.fs ?? nodeSelfTestFs;
  const tools = await resolveSelfTestTools(
    {
      daemonPath: ctx.env["PATH"] ?? "",
      workerPath: ctx.env["PATH"] ?? "",
      writable: workerWritableRoots(spec.workdir, ctx.tmpDir, ctx.shortTmpDir, ctx.home),
    },
    fs,
  );
  if (!tools.ok) {
    return { ok: false, failures: [{ check: "self-test", detail: tools.reason }] };
  }
  const credentials = await engineCredentialCheck(deps.runStep, {
    platform: deps.platform,
    gh: tools.tools.gh,
    worktree: spec.workdir,
    mainCheckout: ctx.mainCheckout,
    home: ctx.home,
    uid: deps.uid,
    env: ctx.env,
  });
  if (!credentials.ok) return { ok: false, failures: [credentials.failure] };

  const report = await runSelfTest(
    { spec, ctx, runSettings: settingsOf(launch), runFiles: launch.files },
    {
      spawn: deps.spawn,
      clock: deps.clock,
      sessionId: deps.selfTestSessionId,
      ...(deps.fs === undefined ? {} : { fs: deps.fs }),
      ...(deps.selfTestTimeoutMs === undefined ? {} : { timeoutMs: deps.selfTestTimeoutMs }),
    },
  );
  const failure = selfTestFailure(report);
  return failure === null ? { ok: true } : { ok: false, failures: [failure] };
}

export type PreparedLaunch =
  | { readonly ok: true; readonly plan: LaunchPlan }
  | { readonly ok: false; readonly outcome: "startFailed"; readonly hold: AdapterHold };

/**
 * Plans a launch or a resume (`spec.session.resume`) and runs the launch checks first. Throws
 * `PlanError` when the spec cannot be planned (DIPO-74 AC #7), and when an npm config file the
 * worker sandbox can read holds an auth key (DIPO-172): that is this office's read paths, so it
 * holds no adapter. A failed check holds the adapter in every office; a pass lifts the hold.
 */
export async function prepareLaunch(
  spec: WorkerSpec,
  ctx: ClaudeLaunchContext,
  holds: AdapterHolds,
  deps: ClaudeLaunchCheckDeps,
): Promise<PreparedLaunch> {
  const launch = plan(spec, ctx);
  await checkNpmTokens(ctx);
  const safeChain = ctx.safeChain;
  if (safeChain === undefined) {
    const gate = await gateLaunch(CLAUDE_CLI_ADAPTER_ID, holds, () =>
      claudeLaunchChecks(spec, ctx, launch, deps),
    );
    return gate.ok ? { ok: true, plan: launch } : gate;
  }
  // Safe-Chain (DIPO-84): the run's proxy runs and passes its check before the plan names its
  // port; without it the run is refused, never started with unchecked or no installs.
  let routed: LaunchPlan = launch;
  const proxies = deps.safeChainProxies;
  const gate = await gateLaunch(CLAUDE_CLI_ADAPTER_ID, holds, async () => {
    const started =
      proxies === undefined
        ? { ok: false as const, reason: "this dipo has no Safe-Chain proxy" }
        : await proxies.start(spec.run, safeChainCaFile(safeChain.shellDir));
    if (!started.ok) {
      return { ok: false, failures: [safeChainProxyFailure(safeChain.root, started.reason)] };
    }
    const withRoute: ClaudeLaunchContext = {
      ...ctx,
      safeChain: { ...safeChain, route: { port: started.proxy.port, dir: started.proxy.dir } },
    };
    routed = plan(spec, withRoute);
    return claudeLaunchChecks(spec, withRoute, routed, deps);
  });
  if (!gate.ok) {
    await proxies?.stop(spec.run);
    return gate;
  }
  proxies?.awaitHost(spec.run);
  return { ok: true, plan: routed };
}

/** The launch check failure of a Safe-Chain proxy that did not start or failed its check. */
export function safeChainProxyFailure(root: string, reason: string): LaunchCheckFailure {
  return {
    check: "safe-chain",
    key: "proxy",
    detail: `Safe-Chain is installed at ${root}, but dipo's Safe-Chain proxy for worker installs cannot run: ${reason}. Installs would not be checked, so the run is refused.`,
    fix: "Check the official Safe-Chain install (~/.safe-chain/bin/safe-chain), the network to registry.npmjs.org, pypi.org and malware-list.aikido.dev, and that the sandbox runs (`dipo self-check`); `dipo run --dry-run` shows the proxy plan in safe-chain/proxy.json. Then start a run again.",
  };
}
