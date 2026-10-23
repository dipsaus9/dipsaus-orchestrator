// `dipo desk [--office <id>] [--json]` (0020 section 12, DIPO-158): reads `office.desk` for the office
// from `--office` or the current directory and prints what waits on the maintainer in plain text: a
// count line, then one line per item in the engine's order with an indented line holding the
// command to type, and the stories held by the maintainer apart at the end. `--json` prints the
// read's result. An empty desk prints `Nothing waits on you.`. The order, the details and the
// command lines all come from the engine; this file only lays them out. Read only: it never starts
// the daemon, and never offers to open a folder that is not an office.

import { basename } from "node:path";

import { usageParts } from "@dipsaus-orchestrator/client";
import { type DeskItem, officeDesk } from "@dipsaus-orchestrator/contract";

import { engineFailure, usage } from "./daemon-commands";
import { type OfficeCommandDeps, parseOptions, withOffice } from "./office-commands";

export const EMPTY_DESK = "Nothing waits on you.";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long an item has waited: `6m`, `9h`, `2d`. */
export function age(sinceMs: number, nowMs: number): string {
  const waited = Math.max(0, nowMs - sinceMs);
  if (waited < HOUR) return `${Math.floor(waited / MINUTE)}m`;
  if (waited < DAY) return `${Math.floor(waited / HOUR)}h`;
  return `${Math.floor(waited / DAY)}d`;
}

/** What to type for an item: its command lines joined, else what to do by hand. */
function commandLine(item: DeskItem): string {
  const lines = [
    ...item.actions.map((action) => action.cli),
    ...(item.hand === undefined ? [] : [item.hand]),
  ];
  return lines.length === 0 ? "(no command in this dipo yet)" : lines.join(" | ");
}

/**
 * The desk as plain-text lines; `label` names the office on the count line, which ends with
 * `usageText`, today's and this month's tokens (DIPO-311).
 */
export function formatDesk(
  label: string,
  items: readonly DeskItem[],
  nowMs: number,
  usageText: readonly string[] = [],
): string[] {
  if (items.length === 0) return [EMPTY_DESK];
  const held = items.filter((item) => item.kind === "HELD");
  const open = items.filter((item) => item.kind !== "HELD");
  const lines = [
    [`${label} · desk ${open.length} · held ${held.length}`, ...usageText].join(" · "),
  ];
  const kindWidth = Math.max(0, ...open.map((item) => item.kind.length));
  const storyWidth = Math.max(0, ...open.map((item) => (item.story ?? "").length));
  for (const item of open) {
    const since = age(Date.parse(item.since), nowMs);
    const story = (item.story ?? "").padEnd(storyWidth);
    const reason =
      item.reason === undefined
        ? ""
        : `${item.reason}${item.cause === undefined ? "" : `/${item.cause}`} · `;
    lines.push(`${item.kind.padEnd(kindWidth)} ${story}  ${reason}${item.detail}  ${since}`);
    lines.push(`${" ".repeat(kindWidth + 1)}${commandLine(item)}`);
  }
  const heldStoryWidth = Math.max(0, ...held.map((item) => (item.story ?? "").length));
  held.forEach((item, at) => {
    const head = at === 0 ? `Held by you (${held.length})` : "";
    const note = item.detail === "" ? "" : `${JSON.stringify(item.detail)}   `;
    const story = (item.story ?? "").padEnd(heldStoryWidth);
    lines.push(
      `${head.padEnd(`Held by you (${held.length})`.length)}  ${story} ${note}${commandLine(item)}`.trimEnd(),
    );
  });
  return lines;
}

interface DeskOptions {
  readonly json: boolean;
  readonly rest: readonly string[];
}

function splitJson(args: readonly string[]): DeskOptions {
  return {
    json: args.includes("--json"),
    rest: args.filter((arg) => arg !== "--json"),
  };
}

export async function deskCommand(
  args: readonly string[],
  deps: OfficeCommandDeps,
): Promise<number> {
  const { json, rest } = splitJson(args);
  const options = parseOptions(rest, false);
  if (typeof options === "string") return usage(deps, `desk: ${options}`);
  return withOffice(
    deps,
    options.office,
    async (session, office, main) => {
      const outcome = await session.read(officeDesk, { office });
      if (!outcome.ok) {
        return outcome.error.code === "office.unknown"
          ? "unknown"
          : engineFailure(deps, outcome.error);
      }
      if (json) {
        deps.writeLine(JSON.stringify(outcome.result));
        return 0;
      }
      const label = main === undefined ? office : basename(main);
      const now = deps.clock.now();
      const summary = session.hello?.offices.find((entry) => entry.office === office);
      for (const line of formatDesk(label, outcome.result, now, usageParts(summary, now))) {
        deps.writeLine(line);
      }
      return 0;
    },
    undefined,
    undefined,
    "running",
    // Read only: a folder that is not an office is named, never offered to open.
    false,
  );
}
