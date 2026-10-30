// The plain-text wording of the token usage in an office summary (DIPO-311, 0009 section 8), shared
// by the TUI and the CLI so every view says the same: `today 1.2M of 4M tokens (30%, resets 00:00
// UTC)` and `this month 20M of 90M tokens (22%, ALERT, resets 1 Nov 00:00 UTC)`. The windows are the
// UTC calendar day and month; the reset time always says UTC. Without a limit only the tokens show.
// The percentage and the token counts are the ones every view prints (DIPO-320).

import type { DayUsage, OfficeSummary } from "@dipsaus-orchestrator/contract";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A share as a percentage: one decimal under 10% (`0.5%`, `4.2%`), else whole (`52%`). */
export function percent(share: number): string {
  const value = share * 100;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
}

/** Tokens as `812`, `45k` or `1.2M`. */
export function usageTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.round(value));
}

function two(value: number): string {
  return String(value).padStart(2, "0");
}

/** The next reset of the window after `nowMs`: `00:00 UTC` for the day, `1 Nov 00:00 UTC`. */
export function resetText(window: "day" | "month", nowMs: number): string {
  const now = new Date(nowMs);
  const next =
    window === "day"
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
      : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const time = `${two(next.getUTCHours())}:${two(next.getUTCMinutes())} UTC`;
  return window === "day" ? time : `${next.getUTCDate()} ${MONTHS[next.getUTCMonth()]} ${time}`;
}

/** One window: `today 1.2M of 4M tokens (30%, ALERT, resets 00:00 UTC) ~$1.20`. */
export function usageWindowText(
  label: string,
  window: "day" | "month",
  usage: DayUsage,
  nowMs: number,
): string {
  const limit = usage.limit === undefined ? "" : ` of ${usageTokens(usage.limit)}`;
  const details =
    usage.limit === undefined
      ? []
      : [
          ...(usage.share === undefined ? [] : [percent(usage.share)]),
          ...(usage.alert ? ["ALERT"] : []),
          `resets ${resetText(window, nowMs)}`,
        ];
  const detail = details.length === 0 ? "" : ` (${details.join(", ")})`;
  const cost = usage.estimatedCost === undefined ? "" : ` ~$${usage.estimatedCost.toFixed(2)}`;
  return `${label} ${usageTokens(usage.tokens)}${limit} tokens${detail}${cost}`;
}

/** The usage of an office's summary as count-line parts: today, then this month; none without. */
export function usageParts(summary: OfficeSummary | undefined, nowMs: number): string[] {
  if (summary === undefined) return [];
  return [
    ...(summary.dayUsage === undefined
      ? []
      : [usageWindowText("today", "day", summary.dayUsage, nowMs)]),
    ...(summary.monthUsage === undefined
      ? []
      : [usageWindowText("this month", "month", summary.monthUsage, nowMs)]),
  ];
}
