// The maintainer's plan-limit allowance (DIPO-338; 0008 section 7). An `allowed_warning` holds new
// sessions until the reset it names (`plan-limit.ts`), and every new session reports the warning
// again, so without this the hold would last until the reset. The maintainer lets the office's new
// sessions go on past it:
//
// - `limits.allow { until, note }` stores one row per office (`plan_limit_allowances`, migration
//   55) with the command's origin as `by`, its time, `until` and the note. `until` is cut to the
//   latest end of the warning holds in force that an allowance lifts; with none in force the
//   command is refused `limits.noWarning`, so an allowance is always bounded by a reset. A second
//   `limits.allow` replaces the first. `limits.allow { clear: true }` deletes the row.
// - While `until` is ahead, `PlanLimits.held` asked for the office skips the warning holds on the
//   weekly, model-family and unknown scopes, the ones in force and any that arrive. It never skips
//   a rejected limit (a worker's wait fact, a reviewer's rejected limit, credits) or a warning on
//   the five-hour window (`session`): those hold as before. The allowance ends by itself at
//   `until`; a row whose time passed is deleted by the next `limits.allow` or office load.
// - `office.limits` lists the holds with the plan's utilization and whether the allowance lifts
//   each, and the allowance; the desk shows an allowance in force as one `ALLOWANCE` row.
//
// A failure reading the row counts as no allowance, so the holds stay (fail closed).

import { limitsAllow, officeLimits } from "@dipsaus-orchestrator/contract";
import type { z } from "zod";

import { CommandError } from "../commands/errors";
import type { CommandContext, CommandOutcome, FeatureRegistry } from "../commands/registry";
import type { OfficeHandle } from "../db/office";

/** The office code of an allowance with nothing to allow. */
export const LIMITS_NO_WARNING = "limits.noWarning";

/** The CLI line that ends an allowance early, as the desk offers it. */
export const CLEAR_ALLOWANCE_CLI = "dipo limits allow --clear";

/** A stored allowance (`plan_limit_allowances`). */
export interface StoredAllowance {
  readonly by: string;
  readonly at: number;
  readonly until: number;
  readonly note: string;
}

/** A hold on new sessions as `office.limits` shows it, times in ms. */
export interface LimitHold {
  readonly scope: string;
  readonly until: number;
  readonly utilization?: number;
  readonly rejected: boolean;
}

/** What `limits.allow` and `office.limits` read of the plan-limit schedule (`PlanLimits`). */
export interface LimitHoldSource {
  /** The holds in force now, every office's, one per scope and kind. */
  holds(now: number): readonly LimitHold[];
}

/**
 * True when an allowance lifts a hold of `scope`: a warning on the weekly, model-family or unknown
 * scope. A rejected limit and the five-hour window (`session`) are never lifted.
 */
export function allowanceLifts(scope: string, rejected: boolean): boolean {
  return !rejected && scope !== "session" && scope !== "credits";
}

/** The office's allowance in force at `now`, or null; a read failure is null (the holds stay). */
export function allowanceInForce(office: OfficeHandle, now: number): StoredAllowance | null {
  try {
    const row = office.get<{ by: string; allowed_at: number; until_at: number; note: string }>(
      `select by, allowed_at, until_at, note from plan_limit_allowances
        where office_id = $office_id and until_at > $now`,
      { now },
    );
    return row === null
      ? null
      : { by: row.by, at: row.allowed_at, until: row.until_at, note: row.note };
  } catch {
    return null;
  }
}

/** Deletes the office's allowance whose time passed; inside the caller's transaction. */
export function deleteEndedAllowance(office: OfficeHandle, now: number): void {
  office.run(
    "delete from plan_limit_allowances where office_id = $office_id and until_at <= $now",
    { now },
  );
}

const iso = (ms: number) => new Date(ms).toISOString();

type AllowArgs = z.output<typeof limitsAllow.args>;
type AllowResult = z.input<typeof limitsAllow.result>;
type LimitsResult = z.input<typeof officeLimits.result>;

function allowanceView(allowance: StoredAllowance): NonNullable<AllowResult["allowance"]> {
  return {
    by: allowance.by,
    at: iso(allowance.at),
    until: iso(allowance.until),
    note: allowance.note,
  };
}

/** `limits.allow`: see the file comment. Runs in the command's write transaction. */
export function allowLimits(
  ctx: CommandContext,
  args: AllowArgs,
  source: LimitHoldSource,
): CommandOutcome<AllowResult> {
  const office = ctx.office;
  deleteEndedAllowance(office, ctx.now);
  if (args.clear === true) {
    const done = office.run("delete from plan_limit_allowances where office_id = $office_id");
    return { result: {}, changed: done.changes > 0 };
  }
  const lifted = source.holds(ctx.now).filter((hold) => allowanceLifts(hold.scope, hold.rejected));
  if (lifted.length === 0) {
    throw new CommandError(
      LIMITS_NO_WARNING,
      "No plan-limit warning that an allowance lifts is in force (a weekly, model or unknown limit); a rejected limit and the five-hour window cannot be allowed.",
    );
  }
  const reset = Math.max(...lifted.map((hold) => hold.until));
  const asked = Date.parse(args.until ?? "");
  if (!(asked > ctx.now)) {
    throw new CommandError("args.invalid", "limits.allow needs an until time in the future.", {
      until: args.until,
    });
  }
  const allowance: StoredAllowance = {
    by: ctx.origin,
    at: ctx.now,
    until: Math.min(asked, reset),
    note: (args.note ?? "").trim(),
  };
  office.run(
    `insert into plan_limit_allowances (office_id, until_at, note, by, allowed_at)
     values ($office_id, $until, $note, $by, $at)
     on conflict (office_id) do update
       set until_at = excluded.until_at, note = excluded.note, by = excluded.by,
           allowed_at = excluded.allowed_at`,
    { until: allowance.until, note: allowance.note, by: allowance.by, at: allowance.at },
  );
  return { result: { allowance: allowanceView(allowance) }, changed: true };
}

/** `office.limits`: the holds, latest end first, and the office's allowance. */
export function readLimits(
  office: OfficeHandle,
  now: number,
  source: LimitHoldSource,
): LimitsResult {
  const allowance = allowanceInForce(office, now);
  const holds = source
    .holds(now)
    .toSorted((a, b) => b.until - a.until || a.scope.localeCompare(b.scope))
    .map((hold) => ({
      scope: hold.scope,
      until: iso(hold.until),
      ...(hold.utilization === undefined ? {} : { utilization: hold.utilization }),
      rejected: hold.rejected,
      allowed: allowance !== null && allowanceLifts(hold.scope, hold.rejected),
    }));
  return { holds, ...(allowance === null ? {} : { allowance: allowanceView(allowance) }) };
}

/** Registers `limits.allow` and `office.limits` over `source`. */
export function registerLimits(registry: FeatureRegistry, source: LimitHoldSource): void {
  registry.addOfficeCommand({
    definition: limitsAllow,
    handle: (ctx, args) => allowLimits(ctx, args, source),
  });
  registry.addRead({
    definition: officeLimits,
    handle: (ctx) => {
      if (ctx.office === undefined) throw new CommandError("office.unknown", "No such office.");
      return readLimits(ctx.office, ctx.clock.now(), source);
    },
  });
}

/** The desk's row of an allowance in force (group 4, no story), or null. */
export function allowanceDeskItem(
  office: OfficeHandle,
  now: number,
): { readonly detail: string; readonly since: number; readonly cli: string } | null {
  const allowance = allowanceInForce(office, now);
  if (allowance === null) return null;
  return {
    detail: `new sessions go on past plan-limit warnings until ${iso(allowance.until)} (set by ${allowance.by}: ${allowance.note}); a rejected limit and the five-hour window still hold`,
    since: allowance.at,
    cli: CLEAR_ALLOWANCE_CLI,
  };
}
