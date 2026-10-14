// Presentational pieces of the TUI (0009 sections 4, 7 and 9): the header, the banners, the
// office body, the office switcher, the narrow list and the footer. They render store state as
// the engine sent it; every state is a word plus an ASCII glyph, colour is extra.

import type { OfficeEntry, OfficeStoreState } from "@dipsaus-orchestrator/client";
import type { StoryView, WorkView } from "@dipsaus-orchestrator/contract";
import { Box, Text } from "ink";
import type { ReactNode } from "react";

import type { Display } from "./options";

/** Below either size the TUI shows one list (0009 section 9). */
export const NARROW_COLUMNS = 60;
export const NARROW_ROWS = 16;

export function glyphs(ascii: boolean) {
  return { dot: ascii ? "-" : "·", dash: ascii ? "-" : "–", ellipsis: ascii ? "..." : "…" };
}

/** Health words and glyphs (0009 section 3); an unknown state shows as its plain word. */
const HEALTH_LABEL: Readonly<Record<string, string>> = {
  lost: "LOST !!",
  asking: "ASKING ?",
  limited: "limited %",
  paused: "paused =",
  looping: "looping @",
  stuck: "stuck ~",
  quiet: "quiet .",
  busy: "busy >",
};

export function healthLabel(health: string): string {
  return HEALTH_LABEL[health] ?? health;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `HH:MM` in the local time zone. */
export function clockTime(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The connection as one word for the header. */
function connectionWord(state: OfficeStoreState, ascii: boolean): string {
  if (state.connection === "idle" || state.connection === "connecting") {
    return `connecting${glyphs(ascii).ellipsis}`;
  }
  if (state.offlineSince !== null && state.connection === "open") return "catching up";
  if (state.connection !== "open") return "offline";
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
export function bannerLines(state: OfficeStoreState, ascii: boolean): string[] {
  const { dash } = glyphs(ascii);
  const lines: string[] = [];
  // While offline the header carries the OFFLINE line, and the last daemon state is stale.
  if (offlineBanner(state, ascii) !== null) return lines;
  switch (state.daemon) {
    case "starting":
    case "recovering":
      lines.push(`Daemon recovering ${dash} office data after reconcile`);
      break;
    case "draining":
      lines.push(`Daemon stopping ${dash} will reconnect`);
      break;
    case "safe":
      lines.push(`Scheduling off after repeated crashes ${dash} [S] resume scheduling`);
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

const COLUMN_ORDER = ["running", "review", "desk", "ready", "waiting", "refined", "draft", "held"];

function columnCounts(stories: readonly StoryView[], dot: string): string {
  const counts = new Map<string, number>();
  for (const story of stories) counts.set(story.column, (counts.get(story.column) ?? 0) + 1);
  const known = COLUMN_ORDER.filter((column) => counts.has(column));
  const rest = [...counts.keys()]
    .filter((c) => !COLUMN_ORDER.includes(c) && c !== "done")
    .toSorted();
  return [...known, ...rest].map((column) => `${column} ${counts.get(column)}`).join(` ${dot} `);
}

function workRow(view: WorkView): string {
  const { work } = view;
  return ` ${work.story.padEnd(10)} ${work.role.padEnd(10)} ${work.tier} ${view.phase.padEnd(7)} ${healthLabel(view.health)}`;
}

/** The home screen of the selected office for this story: who runs what, and the queue counts. */
export function OfficeBody(props: { state: OfficeStoreState; display: Display }) {
  const { state, display } = props;
  const { dot, ellipsis } = glyphs(display.ascii);
  if (state.office === null) {
    return <Text>{" No office selected. Press o to choose one."}</Text>;
  }
  if (state.loading && state.stories.length === 0) {
    return <Text>{` Loading${ellipsis}`}</Text>;
  }
  const summary = state.offices.find((entry) => entry.office === state.office)?.summary;
  return (
    <Box flexDirection="column">
      <Text>
        {` ${state.work.length} running ${dot} desk ${summary?.waitingOnMaintainer ?? "?"} ${dot} held ${summary?.onHold ?? "?"}`}
      </Text>
      {state.work.length === 0 ? (
        <Text>{" No story is running."}</Text>
      ) : (
        <>
          <Text>{` ${"STORY".padEnd(10)} ${"ROLE".padEnd(10)} T ${"PHASE".padEnd(7)} HEALTH`}</Text>
          {state.work.map((view) => (
            <Text key={view.work.run} wrap="truncate-end">
              {workRow(view)}
            </Text>
          ))}
        </>
      )}
      {state.stories.length === 0 ? null : (
        <Text wrap="truncate-end">{` ${columnCounts(state.stories, dot)}`}</Text>
      )}
    </Box>
  );
}

function switcherRow(entry: OfficeEntry): string {
  const summary = entry.summary;
  if (summary === undefined) return `${entry.name}  ? running  desk ?  held ?`;
  const day =
    summary.dayUsage?.share === undefined
      ? ""
      : `  day ${Math.round(summary.dayUsage.share * 100)}%`;
  const alert = summary.dayUsage?.alert === true ? `  ALERT day usage` : "";
  return `${summary.name}  ${summary.running} running  desk ${summary.waitingOnMaintainer}  held ${summary.onHold}${day}${alert}`;
}

/** The office switcher (0009 section 4), built from `engine.hello` and `office.summary`. */
export function SwitcherBody(props: {
  state: OfficeStoreState;
  display: Display;
  index: number;
  now: number;
}) {
  const { state, display, index } = props;
  return (
    <Box flexDirection="column">
      <Text>{` Offices ${glyphs(display.ascii).dot} ${isOffline(state) ? "offline" : `daemon ${state.daemon ?? "?"}`}  ${clockTime(props.now)}`}</Text>
      {state.offices.length === 0 ? (
        <Text>{" No office is registered yet. Press n to open a repository."}</Text>
      ) : (
        state.offices.map((entry, i) => (
          <SwitcherRow
            key={entry.office}
            entry={entry}
            selected={i === index}
            current={entry.office === state.office}
            display={display}
          />
        ))
      )}
    </Box>
  );
}

function SwitcherRow(props: {
  entry: OfficeEntry;
  selected: boolean;
  current: boolean;
  display: Display;
}) {
  const marker = props.selected ? ">" : " ";
  const text = ` ${marker} ${switcherRow(props.entry)}${props.current ? "  (open)" : ""}`;
  return props.selected && props.display.color ? (
    <Text color="cyan" wrap="truncate-end">
      {text}
    </Text>
  ) : (
    <Text wrap="truncate-end">{text}</Text>
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
