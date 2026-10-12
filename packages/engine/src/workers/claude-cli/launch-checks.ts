// The Claude CLI launch checks (0008 section 2): probe, project settings check and sandbox
// self-test, run before every launch and every resume. `prepareLaunch` is the one way to get a
// launch plan the host may start: it plans, runs the checks through the adapter hold's gate and
// returns the plan only when they pass; a refusal is `startFailed` with the hold set (DIPO-74
// rolls back the claim, DIPO-51 resumes through the same function).

import type { Clock, Spawn } from "@dipsaus-orchestrator/contract";

import { gateLaunch, type AdapterHold, type AdapterHolds, type LaunchCheckOutcome } from "../hold";
import type { LaunchPlan, WorkerSpec } from "../types";
import { CLAUDE_CLI_ADAPTER_ID, plan, SETTINGS_FILE, type ClaudeLaunchContext } from "./plan";
import { probe } from "./probe";
import { checkProjectSettings, type ReadOptionalText } from "./settings-check";
import { runSelfTest, selfTestFailure, type SelfTestFs } from "./self-test";

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
}

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

  const report = await runSelfTest(
    { spec, ctx, runSettings: settingsOf(launch) },
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
 * `PlanError` when the spec cannot be planned (DIPO-74 AC #7). A failed check holds the adapter
 * in every office; a pass lifts the hold.
 */
export async function prepareLaunch(
  spec: WorkerSpec,
  ctx: ClaudeLaunchContext,
  holds: AdapterHolds,
  deps: ClaudeLaunchCheckDeps,
): Promise<PreparedLaunch> {
  const launch = plan(spec, ctx);
  const gate = await gateLaunch(CLAUDE_CLI_ADAPTER_ID, holds, () =>
    claudeLaunchChecks(spec, ctx, launch, deps),
  );
  return gate.ok ? { ok: true, plan: launch } : gate;
}
