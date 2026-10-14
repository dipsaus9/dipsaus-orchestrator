// Text pieces of the overview and the queue (0009 sections 3, 4 and 9): the budget bar, elapsed
// time, short roles, evidence markers, the rule id of a Ready gate message and the words for
// `work.run` skip reasons. Pure functions of the views the engine sent; nothing here derives a
// status.

import type { Evidence, EvidenceMap, Usage } from "@dipsaus-orchestrator/contract";

/** The overview drops columns below these widths (0009 section 9). */
export const FULL_COLUMNS = 120;
export const MEDIUM_COLUMNS = 80;

export type Width = "full" | "medium" | "cards";

/** The layout for `columns`; below 60 the App shows the narrow list instead. */
export function widthOf(columns: number): Width {
  if (columns >= FULL_COLUMNS) return "full";
  if (columns >= MEDIUM_COLUMNS) return "medium";
  return "cards";
}

/** `text` cut to `width` characters, ending in the ellipsis when it was cut. */
export function truncate(text: string, width: number, ellipsis: string): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width <= ellipsis.length) return text.slice(0, width);
  return text.slice(0, width - ellipsis.length) + ellipsis;
}

/** Roles shortened for 80 to 119 columns (`dev`, `rev`); others keep their first three letters. */
const SHORT_ROLES: Readonly<Record<string, string>> = {
  developer: "dev",
  reviewer: "rev",
  tester: "test",
};

export function shortRole(role: string): string {
  return SHORT_ROLES[role] ?? role.slice(0, 3);
}

/**
 * A value with its evidence marker (0009 section 3): `claimed` gets a trailing `*`, `estimated` a
 * leading `~`, `none` shows `?`. Without the `evidence` capability the value is plain.
 */
export function marked(value: string, evidence: Evidence | undefined): string {
  switch (evidence) {
    case "claimed":
      return `${value}*`;
    case "estimated":
      return `~${value}`;
    case "none":
      return "?";
    default:
      return value;
  }
}

/** The evidence label for `path`, or undefined when the engine sent none or the flag is off. */
export function evidenceOf(
  map: EvidenceMap | undefined,
  path: string,
  enabled: boolean,
): Evidence | undefined {
  return enabled ? map?.[path] : undefined;
}

/** The share as a whole percentage, `52%`. */
export function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** An eight-cell bar of the budget share, `[####----]`, full past 100%. */
export function budgetBar(usage: Usage): string {
  const cells = 8;
  const filled = Math.max(0, Math.min(cells, Math.round(usage.budgetShare * cells)));
  return `[${"#".repeat(filled)}${"-".repeat(cells - filled)}]`;
}

/** Elapsed time as `38m` under an hour, else `1h05`. */
export function elapsed(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}

/** An age as `3d`, `5h` or `12m`. */
export function age(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** Token counts as `1.2M`, `340k` or `950`. */
export function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.round(value));
}

/**
 * A Ready gate message as the queue shows it: its rule id first, then what failed. The engine
 * writes them as `ready DIPO-33 failed R15: 2 unknowns open…` (0012); another shape shows as is.
 */
export function gateLine(message: string): string {
  const match = /\b(R\d+[a-z]?):\s*(.*)$/.exec(message);
  return match === null ? message : `${match[1]} ${match[2]}`;
}

/** What each `work.run` skip reason means (0005 section 4); an unknown one shows as its word. */
const SKIP_REASONS: Readonly<Record<string, string>> = {
  notReady: "not Ready",
  parked: "parked",
  notRunnable: "not runnable (already claimed, past Ready, or a backlog change is pending)",
  dependency: "a dependency is not Done",
  collision: "its branch or worktree path is taken",
  capacity: "the office runs as many stories as it may",
  pickupCheckFailed: "it failed its pickup check or its setup",
};

export function skipReason(reason: string): string {
  return SKIP_REASONS[reason] ?? reason;
}
