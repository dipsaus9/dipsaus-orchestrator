// Text pieces of the overview and the queue (0009): the budget bar, elapsed
// time, short roles, the first Ready gate failure of a story and the words for
// `work.run` skip reasons. Pure functions of the views the engine sent; nothing here derives a
// status. The percentage, token counts and health words every view shares are the client's.

import type { StoryView, Usage } from "@dipsaus-orchestrator/contract";

/** The overview drops columns below these widths (0009). */
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

/**
 * The first Ready gate failure of a story as the queue shows it: its rule id first, then what
 * failed (`R15 2 unknowns open…`), both from `gateFailures` (DIPO-97). A message no rule gave
 * shows as is; undefined when the story has neither.
 */
export function gateLine(
  view: Pick<StoryView, "gateFailures" | "gateMessages">,
): string | undefined {
  const failure = view.gateFailures?.[0];
  return failure === undefined ? view.gateMessages?.[0] : `${failure.rule} ${failure.text}`;
}

/** What each `work.run` skip reason means (0005); an unknown one shows as its word. */
const SKIP_REASONS: Readonly<Record<string, string>> = {
  notReady: "not Ready",
  parked: "parked",
  notRunnable: "not runnable (already claimed, past Ready, or a backlog change is pending)",
  dependency: "a dependency is not Done",
  collision: "its branch or worktree path is taken",
  capacity: "the office runs as many stories as it may",
  pickupCheckFailed: "it failed its pickup check or its setup",
  starting: "already starting: its claim and box are under way",
};

export function skipReason(reason: string): string {
  return SKIP_REASONS[reason] ?? reason;
}

/**
 * `text` wrapped at `width` columns on its spaces, never cut (spec.md: a decision is never
 * truncated); a word longer than the width is broken across lines. Line breaks in `text` stay.
 */
export function wrapWords(text: string, width: number): string[] {
  const size = Math.max(1, width);
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      if (word === "") continue;
      if (line === "") line = word;
      else if (line.length + 1 + word.length <= size) line = `${line} ${word}`;
      else {
        out.push(line);
        line = word;
      }
      while (line.length > size) {
        out.push(line.slice(0, size));
        line = line.slice(size);
      }
    }
    out.push(line);
  }
  return out;
}

/** A count as the previews print caps: `2.0M`, `150k`, `400`. */
export function compactCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 10_000) return `${Math.round(count / 1_000)}k`;
  return String(count);
}
