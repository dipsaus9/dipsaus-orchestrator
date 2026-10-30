// Presentational pieces of the TUI (0009 sections 4, 7 and 9): the header, the banners, the
// office switcher, the narrow list and the footer. They render store state as
// the engine sent it; every state is a word plus an ASCII glyph, colour is extra.

import {
  healthLabel,
  type OfficeEntry,
  type OfficeStoreState,
  percent,
} from "@dipsaus-orchestrator/client";
import type { DatabaseUnavailableDetails } from "@dipsaus-orchestrator/contract";
import { Box, Text } from "ink";
import type { ReactNode } from "react";

import type { Display } from "./options";

/** Below either size the TUI shows one list (0009 section 9). */
export const NARROW_COLUMNS = 60;
export const NARROW_ROWS = 16;

export function glyphs(ascii: boolean) {
  return { dot: ascii ? "-" : "·", dash: ascii ? "-" : "–", ellipsis: ascii ? "..." : "…" };
}

/** The privacy opt-ins on for the selected office, from its `office.summary` (DIPO-83). */
export function officeOptIns(state: OfficeStoreState): readonly string[] {
  return state.offices.find((entry) => entry.office === state.office)?.summary?.optIns ?? [];
}

/** The stored data each privacy setting names (0007 section 8, DIPO-135). */
const STORED_WORDS: Readonly<Record<string, string>> = {
  "privacy.storeCommandBodies": "stores commands",
  "privacy.storePrompts": "stores prompts",
  "privacy.keepRawEvents": "keeps raw events",
};

/**
 * What the privacy settings that are on store, as words such as `stores commands`, so the
 * maintainer sees what is kept beyond the summary (0007 section 8); "" when none is on. Commands
 * are stored by default (DIPO-135), so this label shows on a default office.
 */
export function storedLabel(optIns: readonly string[]): string {
  if (optIns.length === 0) return "";
  return optIns.map((key) => STORED_WORDS[key] ?? key.replace(/^privacy\./, "")).join(", ");
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `HH:MM` in the local time zone. */
export function clockTime(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The connection as one word for the header; a stream the daemon ended with an error that does
 * not retry says so with its code and message, since it no longer catches up (DIPO-327).
 */
function connectionWord(state: OfficeStoreState, ascii: boolean): string {
  if (state.connection === "idle" || state.connection === "connecting") {
    return `connecting${glyphs(ascii).ellipsis}`;
  }
  if (state.connection !== "open") return "offline";
  const ended = state.streamError;
  if (ended !== null) return `stream ended: ${ended.code}: ${ended.message}`;
  if (state.offlineSince !== null) return "catching up";
  return state.live ? "live" : "catching up";
}

export function isOffline(state: OfficeStoreState): boolean {
  return state.connection === "reconnecting" || state.connection === "closed";
}

function Colored(props: { display: Display; color: string; children: ReactNode }) {
  return props.display.color ? (
    <Text color={props.color}>{props.children}</Text>
  ) : (
    <Text>{props.children}</Text>
  );
}

export function officeName(state: OfficeStoreState): string | null {
  if (state.office === null) return null;
  return state.offices.find((entry) => entry.office === state.office)?.name ?? state.office;
}

export function Header(props: { state: OfficeStoreState; display: Display; title?: string }) {
  const { state, display } = props;
  const { dot } = glyphs(display.ascii);
  const title = props.title ?? officeName(state) ?? "no office";
  const offline = offlineBanner(state, display.ascii);
  // Disconnected, the daemon state is not known: the header says so instead (0009 section 7).
  if (offline !== null) {
    return display.color ? (
      <Text color="red" wrap="truncate-end">{` ${title} ${dot} ${offline}`}</Text>
    ) : (
      <Text wrap="truncate-end">{` ${title} ${dot} ${offline}`}</Text>
    );
  }
  return (
    <Text wrap="truncate-end">
      {` ${title} ${dot} daemon ${state.daemon ?? "?"} ${dot} ${connectionWord(state, display.ascii)}`}
    </Text>
  );
}

/** `OFFLINE since <time> – view frozen` while disconnected, else null (0009 section 7). */
export function offlineBanner(state: OfficeStoreState, ascii: boolean): string | null {
  if (!isOffline(state) || state.offlineSince === null) return null;
  return `OFFLINE since ${clockTime(state.offlineSince)} ${glyphs(ascii).dash} view frozen`;
}

/** The banner lines for the connection and the daemon state (0009 section 7). */
/**
 * The banner line of a daemon held in `recovering` because its state database is unavailable
 * (DIPO-111, 0009 section 7 as amended by DIPO-120): the reason, and the newest backup when there is one.
 */
function databaseLine(database: DatabaseUnavailableDetails, dash: string): string {
  const backup = database.backup === undefined ? "" : `; newest backup ${database.backup}`;
  return `Database unavailable ${dash} reason: ${database.reason}${backup}`;
}

export function bannerLines(state: OfficeStoreState, ascii: boolean): string[] {
  const { dash } = glyphs(ascii);
  const lines: string[] = [];
  // While offline the header carries the OFFLINE line, and the last daemon state is stale.
  if (offlineBanner(state, ascii) !== null) return lines;
  switch (state.daemon) {
    case "starting":
    case "recovering":
      lines.push(
        state.database === null
          ? `Daemon recovering ${dash} office data after reconcile`
          : databaseLine(state.database, dash),
      );
      break;
    case "draining":
      lines.push(`Daemon stopping ${dash} will reconnect`);
      break;
    default:
      break;
  }
  return lines;
}

export function Banners(props: { state: OfficeStoreState; display: Display }) {
  const lines = bannerLines(props.state, props.display.ascii);
  return (
    <>
      {lines.map((line) => (
        <Colored
          key={line}
          display={props.display}
          color={line.startsWith("OFFLINE") ? "red" : "yellow"}
        >
          {` ${line}`}
        </Colored>
      ))}
    </>
  );
}

/** The switcher's column titles (0009): running, needs you, Ready and today's tokens. */
const SWITCHER_TITLES = ["OFFICE", "RUNNING", "NEEDS YOU", "READY", "TODAY"];

/**
 * One office's cells under the switcher titles, from its `OfficeSummary`; `?` before the first
 * summary arrives, or for READY from an engine that does not send it. At 120 columns and wider an
 * alert reads `84%  ALERT day usage`, narrower `84% !`.
 */
export function switcherCells(entry: OfficeEntry, full: boolean): string[] {
  const summary = entry.summary;
  if (summary === undefined) return [entry.name, "?", "?", "?", ""];
  const day = summary.dayUsage;
  const share = day?.share === undefined ? "" : percent(day.share);
  const alert = day?.alert === true ? (full ? "  ALERT day usage" : " !") : "";
  return [
    summary.name,
    String(summary.running),
    String(summary.waitingOnMaintainer),
    summary.ready === undefined ? "?" : String(summary.ready),
    `${share}${alert}`.trim(),
  ];
}

/** The switcher's title line and one line per office, aligned under the titles. */
export function switcherLines(
  offices: readonly OfficeEntry[],
  current: string | null,
  index: number,
  columns: number,
): string[] {
  const rows = offices.map((entry) => switcherCells(entry, columns >= FULL_SWITCHER_COLUMNS));
  const widths = SWITCHER_TITLES.map((title, i) =>
    Math.max(title.length, ...rows.map((row) => row[i]?.length ?? 0)),
  );
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join("  ")
      .trimEnd();
  const texts = rows.map((row, i) => ` ${i === index ? ">" : " "} ${line(row)}`);
  // `(open)` lines up after the longest row when the line has room for it.
  const longest = Math.max(0, ...texts.map((text) => text.length));
  const openAt = longest + 8 <= columns ? longest : 0;
  return [
    `   ${line(SWITCHER_TITLES)}`,
    ...texts.map((text, i) =>
      offices[i]?.office === current ? `${text.padEnd(openAt)}  (open)` : text,
    ),
  ];
}

/** At this width and wider the switcher spells out a day usage alert. */
const FULL_SWITCHER_COLUMNS = 120;

/** The office switcher (0009 section 4), built from `engine.hello` and `office.summary`. */
export function SwitcherBody(props: {
  state: OfficeStoreState;
  display: Display;
  index: number;
  now: number;
  columns: number;
}) {
  const { state, display, index } = props;
  const [title, ...rows] = switcherLines(state.offices, state.office, index, props.columns);
  return (
    <Box flexDirection="column">
      <Text>{` Offices ${glyphs(display.ascii).dot} ${isOffline(state) ? "offline" : `daemon ${state.daemon ?? "?"}`}  ${clockTime(props.now)}`}</Text>
      {state.offices.length === 0 ? (
        <Text>{" No office is registered yet. Press n to open a repository."}</Text>
      ) : (
        <>
          <Text wrap="truncate-end">{title}</Text>
          {rows.map((text, i) =>
            i === index && display.color ? (
              <Text key={state.offices[i]?.office ?? i} color="cyan" wrap="truncate-end">
                {text}
              </Text>
            ) : (
              <Text key={state.offices[i]?.office ?? i} wrap="truncate-end">
                {text}
              </Text>
            ),
          )}
        </>
      )}
    </Box>
  );
}

/** Below 60 columns or 16 rows: one list of story, health and the desk count (0009 section 9). */
export function NarrowBody(props: {
  state: OfficeStoreState;
  display: Display;
  switcher: { index: number } | null;
}) {
  const { state, display, switcher } = props;
  const offline = isOffline(state) && state.offlineSince !== null;
  const lines: string[] = [];
  if (switcher !== null) {
    state.offices.forEach((entry, i) => {
      lines.push(
        `${i === switcher.index ? ">" : " "} ${entry.name} desk ${entry.summary?.waitingOnMaintainer ?? "?"}`,
      );
    });
  } else {
    for (const view of state.work) lines.push(`${view.work.story} ${healthLabel(view.health)}`);
    const summary = state.offices.find((entry) => entry.office === state.office)?.summary;
    lines.push(`desk ${summary?.waitingOnMaintainer ?? "?"}`);
  }
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        {`${officeName(state) ?? "no office"}${offline ? ` ${glyphs(display.ascii).dot} OFFLINE` : ""}`}
      </Text>
      {lines.map((line, i) => (
        <Text key={i} wrap="truncate-end">
          {line}
        </Text>
      ))}
      <Text>widen for detail</Text>
    </Box>
  );
}

export function Footer(props: { keys: string; message: string | null; display: Display }) {
  return (
    <Box flexDirection="column">
      {props.message === null ? null : (
        <Colored display={props.display} color="yellow">
          {` ${props.message}`}
        </Colored>
      )}
      <Text wrap="truncate-end">{` ${props.keys}`}</Text>
    </Box>
  );
}
