// The 0012 status list and the `statuses:` line of `backlog/config.yml` (0010 sections 1 and 6).
// The status list is the one thing the engine reads from a Backlog.md file directly; it is written
// by rewriting that one line, because the CLI refuses `config set statuses` (0010 fact 6). Pure.

import { parseYamlDocument } from "../../platform/yaml";

/** The lifecycle statuses office init sets, in board order (0012 section 2). */
export const LIFECYCLE_STATUSES: readonly string[] = [
  "Refined",
  "Ready",
  "In Progress",
  "In Review",
  "Parked",
  "Done",
];

/** The status existing tasks migrate from (0010 section 6). */
export const LEGACY_STATUS = "To Do";

/** The default status office init sets (0012 section 2). */
export const DEFAULT_STATUS = "Refined";

/** Statuses a run needs on the base: a story it runs moves to them (0012 section 2, DIPO-48). */
export const RUN_STATUSES: readonly string[] = ["In Review", "Parked"];

/** `backlog/config.yml`, relative to the repository root. */
export const CONFIG_FILE = "backlog/config.yml";

export type StatusesRead =
  | { readonly ok: true; readonly statuses: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/** The `statuses` of a `backlog/config.yml` text. */
export function readStatuses(text: string): StatusesRead {
  const parsed = parseYamlDocument(text);
  if (!parsed.ok)
    return { ok: false, reason: `${CONFIG_FILE} is not valid YAML: ${parsed.message}` };
  const value: unknown =
    typeof parsed.value === "object" && parsed.value !== null
      ? (parsed.value as Record<string, unknown>)["statuses"]
      : undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return { ok: false, reason: `${CONFIG_FILE} has no \`statuses\` list` };
  }
  return { ok: true, statuses: value };
}

/** The statuses of `required` that `statuses` lacks, in `required` order. */
export function missingStatuses(
  statuses: readonly string[],
  required: readonly string[] = LIFECYCLE_STATUSES,
): string[] {
  return required.filter((status) => !statuses.includes(status));
}

/**
 * The status list step 1 writes, or null when `current` needs no change.
 *
 * - While some task still uses a status outside the 0012 list (`To Do` above all), the list holds
 *   both: the old statuses outside the 0012 list, in their order, then the 0012 list. A list that
 *   already holds every 0012 status is left as it is.
 * - Once no task uses `To Do` (`final`), the list is the 0012 list alone, keeping only those other
 *   statuses `inUse` still names, so no task is left with a status the board does not show
 *   (0010 section 6 step 4).
 */
export function targetStatuses(
  current: readonly string[],
  options: { readonly final: boolean; readonly inUse: readonly string[] },
): string[] | null {
  const extras = current.filter((status) => !LIFECYCLE_STATUSES.includes(status));
  if (!options.final) {
    if (missingStatuses(current).length === 0) return null;
    return [...extras, ...LIFECYCLE_STATUSES];
  }
  const kept = extras.filter((status) => options.inUse.includes(status));
  const target = [...kept, ...LIFECYCLE_STATUSES];
  const same = target.length === current.length && target.every((s, i) => s === current[i]);
  return same ? null : target;
}

/** A status list as Backlog.md writes it: `["To Do", "In Progress", "Done"]`. */
export function formatStatuses(statuses: readonly string[]): string {
  return `[${statuses.map((status) => JSON.stringify(status)).join(", ")}]`;
}

/**
 * `text` with only its `statuses:` line replaced by `statuses: <list>`; null when the file has no
 * one-line `statuses:` entry at the top level (a block list over several lines is not rewritten).
 */
export function rewriteStatusesLine(text: string, statuses: readonly string[]): string | null {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.startsWith("statuses:"));
  if (index < 0) return null;
  const line = lines[index] ?? "";
  const value = line.slice("statuses:".length).trim();
  if (!value.startsWith("[") || !value.endsWith("]")) return null;
  lines[index] = `statuses: ${formatStatuses(statuses)}${line.endsWith("\r") ? "\r" : ""}`;
  return lines.join("\n");
}

/**
 * The refusal a run gets while the base's statuses lack `In Review` or `Parked`, naming `dipo office
 * init`; null when both are there (DIPO-48 refuses `work.run` with it).
 */
export function statusesRefusal(statuses: readonly string[]): string | null {
  const missing = missingStatuses(statuses, RUN_STATUSES);
  if (missing.length === 0) return null;
  return `The office's base branch has no Backlog.md status ${missing.map((s) => `\`${s}\``).join(" or ")}, so dipo runs no story yet: run \`dipo office init\` and let its backlog PR merge.`;
}
