// The Claude CLI launch checks of a `session` on the Mac (0008, DIPO-310): the tools check, the
// probe and the project settings check, run before every launch of one. `prepareLaunch` is the one
// way to get such a plan the host may start: it plans, runs the checks through the adapter hold's
// gate and returns the plan only when they pass; a refusal is `startFailed` with the hold set.
//
// A developer and a reviewer run only in a box (DIPO-240, DIPO-347): the box is the boundary, and
// dipo's post-run token check (`box/token-check.ts`) and the box checks of `adapter.ts` hold the
// adapter. The checks that proved the developer's Bash sandbox on the Mac went with that sandbox.

import { allowedTools } from "./tools";
import type { Clock, Spawn } from "@dipsaus-orchestrator/contract";

import { gateLaunch, type AdapterHold, type AdapterHolds, type LaunchCheckOutcome } from "../hold";
import type { LaunchPlan, WorkerSpec } from "../types";
import { CLAUDE_CLI_ADAPTER_ID, kindContext, plan, type ClaudeLaunchContext } from "./plan";
import { probe } from "./probe";
import { checkProjectSettings, type ReadOptionalText } from "./settings-check";

export interface ClaudeLaunchCheckDeps {
  readonly spawn: Spawn;
  readonly clock: Clock;
  /** `worker.allowProjectSettings` of the office. */
  readonly allowProjectSettings: readonly string[];
  readonly readText?: ReadOptionalText;
  readonly probeTimeoutMs?: number;
}

/**
 * Tools that load project agents or skills. 0008 section 2 asks for a frontmatter check of
 * `.claude/agents/*.md` and the skills for such roles; until it exists they are refused.
 */
export const UNCHECKED_TOOLS: readonly string[] = ["Agent", "Task", "Skill"];

/** The tools among `tools` that would load project agents or skills; none passes the checks. */
export function uncheckedTools(tools: readonly string[]): string[] {
  return tools.filter((tool) => UNCHECKED_TOOLS.includes(tool));
}

/**
 * The checks in order; a later one runs only when the earlier ones pass: the tools, the probe
 * (version and login), then the project settings of the session's folder.
 */
export async function claudeLaunchChecks(
  spec: WorkerSpec,
  launch: LaunchPlan,
  deps: ClaudeLaunchCheckDeps,
): Promise<LaunchCheckOutcome> {
  const unchecked = uncheckedTools(allowedTools(spec));
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
