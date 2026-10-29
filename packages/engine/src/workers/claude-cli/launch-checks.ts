// The Claude CLI launch checks of a `session` on the Mac (0008, DIPO-310): the tools check, the
// probe and the project settings check, run before every launch of one. `prepareLaunch` is the one
// way to get such a plan the host may start: it plans, runs the checks through the adapter hold's
// gate and returns the plan only when they pass; a refusal is `startFailed` with the hold set.
//
// A developer and a reviewer run only in a box (DIPO-240, DIPO-347): the box is the boundary, and
// dipo's post-run token check (`box/token-check.ts`) and the box checks of `adapter.ts` hold the
// adapter. The checks that proved the developer's Bash sandbox on the Mac went with that sandbox.

import type { Clock, Spawn } from "@dipsaus-orchestrator/contract";

import { gateLaunch, type AdapterHold, type AdapterHolds, type LaunchCheckOutcome } from "../hold";
import type { LaunchPlan, WorkerSpec } from "../types";
import { CLAUDE_CLI_ADAPTER_ID, kindContext, plan, type ClaudeLaunchContext } from "./plan";
import { probe } from "./probe";
import { checkProjectSettings, type ReadOptionalText } from "./settings-check";

export interface ClaudeLaunchCheckDeps {
  readonly spawn: Spawn;
  readonly clock: Clock;
  readonly readText?: ReadOptionalText;
  readonly probeTimeoutMs?: number;
}

/**
 * The checks in order; a later one runs only when the earlier ones pass: the probe (version and
 * login), then the project settings of the session's folder. No kind's tools load project agents
 * or skills (`allowedTools`, DIPO-318), so no tools check is left to run.
 */
export async function claudeLaunchChecks(
  spec: WorkerSpec,
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
  const settings = await checkProjectSettings(spec.workdir, deps.readText);
  return settings.length > 0 ? { ok: false, failures: settings } : { ok: true };
}

export type PreparedLaunch =
  | { readonly ok: true; readonly plan: LaunchPlan }
  | { readonly ok: false; readonly outcome: "startFailed"; readonly hold: AdapterHold };

/**
 * Plans a session's launch and runs the launch checks first. Throws `PlanError` when the spec
 * cannot be planned, a developer's or reviewer's included (each runs only in a box). A failed check holds the
 * adapter in every office; a pass lifts the hold.
 */
export async function prepareLaunch(
  spec: WorkerSpec,
  launchContext: ClaudeLaunchContext,
  holds: AdapterHolds,
  deps: ClaudeLaunchCheckDeps,
): Promise<PreparedLaunch> {
  // A session allows no plugin; its checks run with its plan's context.
  const ctx = kindContext(spec, launchContext);
  const launch = plan(spec, ctx);
  const gate = await gateLaunch(CLAUDE_CLI_ADAPTER_ID, holds, () =>
    claudeLaunchChecks(spec, launch, deps),
  );
  return gate.ok ? { ok: true, plan: launch } : gate;
}
