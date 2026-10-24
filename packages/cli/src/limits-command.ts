// `dipo limits [--office <id>] [--json]` and `dipo limits allow --until <time> --note <why>` /
// `dipo limits allow --clear` (DIPO-338; 0008 section 7). The first reads `office.limits` and prints
// one line per plan-limit hold (scope, warning or rejected, the plan's utilization, when it ends,
// and whether the office's allowance lifts it) and the allowance. `allow` sends `limits.allow`:
// the office's new sessions go on past the plan's warnings until `--until` (cut to the reset the
// warnings name), or `--clear` ends the allowance now. Neither asks for confirmation. `--until`
// takes any date and time JavaScript reads, such as `2026-10-27T09:00Z`.

import {
  limitsAllow,
  officeLimits,
  type PlanLimitAllowance,
  type PlanLimitHold,
} from "@dipsaus-orchestrator/contract";

import { engineFailure, usage } from "./daemon-commands";
import { type OfficeCommandDeps, parseOptions, withOffice } from "./office-commands";

export const NO_HOLDS = "No plan-limit hold is in force.";

/** One hold as a line. */
function holdLine(hold: PlanLimitHold): string {
  const kind = hold.rejected ? "rejected" : "warning";
  const used =
    hold.utilization === undefined ? "" : ` · ${Math.round(hold.utilization * 100)}% used`;
  const state = hold.allowed ? "allowed: new sessions go on" : "holds new sessions";
  return `${hold.scope} ${kind}${used} · until ${hold.until} · ${state}`;
}

/** The allowance as a line. */
export function allowanceLine(allowance: PlanLimitAllowance): string {
  return `allowance until ${allowance.until} · set ${allowance.at} by ${allowance.by} · ${JSON.stringify(allowance.note)}`;
}

/** The `office.limits` result as lines. */
export function formatLimits(
  holds: readonly PlanLimitHold[],
  allowance: PlanLimitAllowance | undefined,
): string[] {
  const lines = holds.length === 0 ? [NO_HOLDS] : holds.map(holdLine);
  if (allowance !== undefined) lines.push(allowanceLine(allowance));
  return lines;
}

interface AllowOptions {
  readonly until?: string;
  readonly note?: string;
  readonly clear: boolean;
  readonly rest: string[];
}

/** Takes `--until`, `--note` and `--clear` out of `args`; a string is a usage error. */
function allowOptions(args: readonly string[]): AllowOptions | string {
  let until: string | undefined;
  let note: string | undefined;
  let clear = false;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--until" || arg === "--note") {
      const value = args[i + 1];
      if (value === undefined) return `${arg} needs a value`;
      if (arg === "--until") until = value;
      else note = value;
      i += 1;
    } else if (arg === "--clear") {
      clear = true;
    } else {
      rest.push(arg);
    }
  }
  return {
    ...(until === undefined ? {} : { until }),
    ...(note === undefined ? {} : { note }),
    clear,
    rest,
  };
}

/** The `limits.allow` args, or a usage error. */
function allowArgs(
  options: AllowOptions,
): { until: string; note: string } | { clear: true } | string {
  if (options.clear) {
    if (options.until !== undefined || options.note !== undefined) {
      return "--clear takes no --until or --note";
    }
    return { clear: true };
  }
  if (options.until === undefined) return "needs --until <time>, or --clear";
  if (options.note === undefined || options.note.trim() === "") return "needs --note <why>";
  const until = Date.parse(options.until);
  if (!Number.isFinite(until)) return `${JSON.stringify(options.until)} is not a date and time`;
  return { until: new Date(until).toISOString(), note: options.note };
}

async function allowCommand(args: readonly string[], deps: OfficeCommandDeps): Promise<number> {
  const options = allowOptions(args);
  if (typeof options === "string") return usage(deps, `limits allow: ${options}`);
  const sent = allowArgs(options);
  if (typeof sent === "string") return usage(deps, `limits allow: ${sent}`);
  const parsed = parseOptions(options.rest, false);
  if (typeof parsed === "string") return usage(deps, `limits allow: ${parsed}`);
  return withOffice(deps, parsed.office, async (session, office) => {
    const outcome = await session.command(limitsAllow, sent, { office });
    if (!outcome.ok) {
      return outcome.error.code === "office.unknown"
        ? "unknown"
        : engineFailure(deps, outcome.error);
    }
    const allowance = outcome.result.allowance;
    if (allowance === undefined) {
      deps.writeLine(
        outcome.changed
          ? "allowance ended: the plan's warnings hold new sessions again"
          : "no allowance was in force",
      );
      return 0;
    }
    deps.writeLine(
      `new sessions go on past the plan's warnings until ${allowance.until}; a rejected limit and the five-hour window still hold`,
    );
    return 0;
  });
}

export async function limitsCommand(
  args: readonly string[],
  deps: OfficeCommandDeps,
): Promise<number> {
  if (args[0] === "allow") return allowCommand(args.slice(1), deps);
  const json = args.includes("--json");
  const options = parseOptions(
    args.filter((arg) => arg !== "--json"),
    false,
  );
  if (typeof options === "string") return usage(deps, `limits: ${options}`);
  return withOffice(
    deps,
    options.office,
    async (session, office) => {
      const outcome = await session.read(officeLimits, { office });
      if (!outcome.ok) {
        return outcome.error.code === "office.unknown"
          ? "unknown"
          : engineFailure(deps, outcome.error);
      }
      if (json) {
        deps.writeLine(JSON.stringify(outcome.result));
        return 0;
      }
      for (const line of formatLimits(outcome.result.holds, outcome.result.allowance)) {
        deps.writeLine(line);
      }
      return 0;
    },
    undefined,
    undefined,
    "running",
    false,
  );
}
