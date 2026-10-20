// The Claude CLI launch checks (0008 section 2 and its amendments): probe, project settings
// check, the engine-side credential check under srt and the session self-test, run before every
// launch and every resume. `prepareLaunch` is the one way to get a
// launch plan the host may start: it plans, runs the checks through the adapter hold's gate and
// returns the plan only when they pass; a refusal is `startFailed` with the hold set (DIPO-74
// rolls back the claim, DIPO-51 resumes through the same function). The npm token check
// (DIPO-172) runs first and refuses with a `PlanError`, which holds no adapter.

import { randomUUID } from "node:crypto";

import type { Clock, Spawn } from "@dipsaus-orchestrator/contract";

import {
  gateLaunch,
  type AdapterHold,
  type AdapterHolds,
  type HoldScope,
  type LaunchCheckFailure,
  type LaunchCheckOutcome,
} from "../hold";
import type { SafeChainProxies } from "../../sandbox/safe-chain-proxies";
import type { DipoPlatform } from "../../platform/paths";
import type { LaunchPlan, WorkerSpec } from "../types";
import {
  CLAUDE_CLI_ADAPTER_ID,
  kindContext,
  plan,
  SETTINGS_FILE,
  type ClaudeLaunchContext,
} from "./plan";
import { checkNpmTokens } from "./npm-token-check";
import { checkVerifyTools } from "./verify-tools";
import type { VerifyCommands } from "../port";
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
  type StartHostStandIn,
} from "./self-test";

export interface ClaudeLaunchCheckDeps {
  readonly spawn: Spawn;
  readonly clock: Clock;
  /** An engine-made UUID for the self-test session (a new one per check). */
  readonly selfTestSessionId: string;
  /** The self-test session id of each recheck of a held launch kind; a new UUID by default. */
  readonly nextSelfTestSessionId?: () => string;
  /** `worker.allowProjectSettings` of the office. */
  readonly allowProjectSettings: readonly string[];
  readonly readText?: ReadOptionalText;
  readonly fs?: SelfTestFs;
  /** Starts the self-test's stand-in host at the session's host socket (DIPO-231); a test seam. */
  readonly standIn?: StartHostStandIn;
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
  /** Writes the warn line of a session refused for the Bash command it ran (DIPO-230). */
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
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
      ...(deps.standIn === undefined ? {} : { standIn: deps.standIn }),
      ...(deps.selfTestTimeoutMs === undefined ? {} : { timeoutMs: deps.selfTestTimeoutMs }),
    },
  );
  const failure = selfTestFailure(report);
  const verdict = report.verdict;
  if (!verdict.ok && verdict.bash === true) {
    deps.warn?.("the launch self-test session ran another Bash command", {
      run: spec.run,
      reason: verdict.reason,
      commands: report.evidence?.bash.commands ?? [],
    });
  }
  if (failure === null) return { ok: true };
  // A verdict that is not `unsafe` is a self-test that could not run: it holds one launch kind in
  // one office. An unsafe one (a probe write or read got through) holds every office (DIPO-257).
  return {
    ok: false,
    failures: [verdict.ok || verdict.unsafe ? failure : { ...failure, couldNotRun: true }],
  };
}

export type PreparedLaunch =
  | { readonly ok: true; readonly plan: LaunchPlan }
  | { readonly ok: false; readonly outcome: "startFailed"; readonly hold: AdapterHold };

/**
 * Plans a launch or a resume (`spec.session.resume`) and runs the launch checks first. Throws
 * `PlanError` when the spec cannot be planned (DIPO-74 AC #7), and when an npm config file the
 * worker sandbox can read holds an auth key (DIPO-172) or a verify program's interpreter is out
 * of its reach (DIPO-173): that is this office's read paths, so it holds no adapter. A failed check holds the adapter in every office, except a self-test that could not run, which holds only this office's launch kind, worker or reviewer (DIPO-257); a pass lifts the hold.
 */
export async function prepareLaunch(
  spec: WorkerSpec,
  launchContext: ClaudeLaunchContext,
  holds: AdapterHolds,
  deps: ClaudeLaunchCheckDeps,
  verify?: VerifyCommands,
): Promise<PreparedLaunch> {
  // A review session has no Safe-Chain proxy and allows no plugin (0019 section 4); its checks
  // and self-test run with the same context its plan has.
  const ctx = kindContext(spec, launchContext);
  const launch = plan(spec, ctx);
  await checkNpmTokens(ctx);
  if (verify !== undefined) await checkVerifyTools(ctx, spec.workdir, verify);
  // A self-test that could not run holds only this office's launch kind, which its recheck
  // repeats with this launch's context and a new self-test session (DIPO-257).
  const scope: HoldScope = {
    office: ctx.mainCheckout,
    kind: spec.kind === "review" ? "reviewer" : "worker",
  };
  const again = (): ClaudeLaunchCheckDeps => ({
    ...deps,
    selfTestSessionId: (deps.nextSelfTestSessionId ?? randomUUID)(),
  });
  const safeChain = ctx.safeChain;
  if (safeChain === undefined) {
    const gate = await gateLaunch(
      CLAUDE_CLI_ADAPTER_ID,
      holds,
      () => claudeLaunchChecks(spec, ctx, launch, deps),
      { scope, recheck: () => claudeLaunchChecks(spec, ctx, launch, again()) },
    );
    return gate.ok ? { ok: true, plan: launch } : gate;
  }
  // Safe-Chain (DIPO-84): the run's proxy runs and passes its check before the plan names its
  // port; without it the run is refused, never started with unchecked or no installs.
  let routed: LaunchPlan = launch;
  const proxies = deps.safeChainProxies;
  const routedChecks = async (checkDeps: ClaudeLaunchCheckDeps): Promise<LaunchCheckOutcome> => {
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
    return claudeLaunchChecks(spec, withRoute, routed, checkDeps);
  };
  const gate = await gateLaunch(CLAUDE_CLI_ADAPTER_ID, holds, () => routedChecks(deps), {
    scope,
    // The run's proxy runs only for the check: no worker starts from a recheck.
    recheck: async () => {
      try {
        return await routedChecks(again());
      } finally {
        await proxies?.stop(spec.run);
      }
    },
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
