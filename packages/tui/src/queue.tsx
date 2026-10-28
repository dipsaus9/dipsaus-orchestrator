// The queue by lifecycle (`2`, 0009 sections 4 and 9): one section per engine-derived column with
// its count, in the order of the 0009 layout. `waiting` rows name the dependencies that are not
// Done, Refined rows show the first Ready gate message with its rule id, and the stories the
// maintainer parked their note.
// The first row is "next Ready story": `u` on it lets the engine pick, `u` on a story runs that one.
// Done stories show only after `.`. Rows are memoised by story key, and each is cut to the width.

import type { StoryView } from "@dipsaus-orchestrator/contract";
import { Box, Text } from "ink";
import { memo } from "react";

import { age, gateLine, truncate } from "./format";
import type { Display } from "./options";
import { glyphs } from "./views";

/** Section order of the 0009 queue layout; an unknown column follows, then done when shown. */
export const QUEUE_ORDER = ["ready", "waiting", "refined", "draft", "running", "review", "desk"];

export type QueueRow =
  | { readonly kind: "next" }
  | { readonly kind: "story"; readonly view: StoryView; readonly label: string | null };

/** The selectable rows: "next Ready story", then each section's stories in the engine's order. */
export function queueRows(stories: readonly StoryView[], showDone: boolean): QueueRow[] {
  const byColumn = new Map<string, StoryView[]>();
  for (const story of stories) {
    const list = byColumn.get(story.column) ?? [];
    list.push(story);
    byColumn.set(story.column, list);
  }
  const unknown = [...byColumn.keys()]
    .filter((column) => !QUEUE_ORDER.includes(column) && column !== "done")
    .toSorted();
  const order = [...QUEUE_ORDER, ...unknown, ...(showDone ? ["done"] : [])];
  const rows: QueueRow[] = [{ kind: "next" }];
  for (const column of order) {
    const list = byColumn.get(column) ?? [];
    list.forEach((view, i) => {
      rows.push({
        kind: "story",
        view,
        label: i === 0 ? `${column.toUpperCase()} (${list.length})` : null,
      });
    });
  }
  return rows;
}

/** What a row says after its title: dependencies, the first gate message, a hold or a park. */
export function rowNote(view: StoryView, now: number): string {
  if (view.column === "waiting" && view.waitingOn !== undefined && view.waitingOn.length > 0) {
    return `needs ${view.waitingOn.join(", ")}`;
  }
  const gate = gateLine(view);
  if (gate !== undefined) return gate;
  if (view.parked !== undefined) {
    const since = age(now - Date.parse(view.parked.since));
    return view.parked.reason === "by-maintainer"
      ? `"${view.parked.detail}" (parked by you ${since})`
      : `parked ${view.parked.reason} (${since})`;
  }
  return "";
}

interface Widths {
  readonly label: number;
  readonly story: number;
  readonly tier: number;
  readonly title: number;
  readonly total: number;
}

function widths(rows: readonly QueueRow[], columns: number): Widths {
  const stories = rows.flatMap((row) => (row.kind === "story" ? [row] : []));
  const label = Math.max(0, ...stories.map((row) => row.label?.length ?? 0));
  const story = Math.max(5, ...stories.map((row) => String(row.view.story).length));
  const tier = Math.max(1, ...stories.map((row) => row.view.tier?.length ?? 0));
  const longest = Math.max(0, ...stories.map((row) => row.view.title.length));
  // Marker, label, id and tier first; the title takes up to 45% of the rest, the note the remainder.
  const fixed = 3 + label + 1 + story + 1 + tier + 2;
  const title = Math.min(longest, Math.max(12, Math.floor((columns - fixed) * 0.45)));
  return { label, story, tier, title, total: columns };
}

function storyLine(
  row: Extract<QueueRow, { kind: "story" }>,
  w: Widths,
  now: number,
  ellipsis: string,
  selected: boolean,
): string {
  const { view } = row;
  const head = ` ${selected ? ">" : " "} ${(row.label ?? "").padEnd(w.label)} ${String(view.story).padEnd(w.story)} ${(view.tier ?? "").padEnd(w.tier)}  ${truncate(view.title, w.title, ellipsis).padEnd(w.title)}`;
  const note = rowNote(view, now);
  if (note === "") return truncate(head.trimEnd(), w.total, ellipsis);
  return truncate(
    `${head}  ${truncate(note, Math.max(0, w.total - head.length - 2), ellipsis)}`,
    w.total,
    ellipsis,
  );
}

/** Memoised by story key: a row renders again only when its view, selection or widths change. */
const StoryRow = memo(
  function StoryRow(props: {
    row: Extract<QueueRow, { kind: "story" }>;
    widths: Widths;
    selected: boolean;
    now: number;
    display: Display;
  }) {
    const text = storyLine(
      props.row,
      props.widths,
      props.now,
      glyphs(props.display.ascii).ellipsis,
      props.selected,
    );
    return props.selected && props.display.color ? (
      <Text color="cyan" wrap="truncate-end">
        {text}
      </Text>
    ) : (
      <Text wrap="truncate-end">{text}</Text>
    );
  },
  (prev, next) =>
    prev.row.view === next.row.view &&
    prev.row.label === next.row.label &&
    prev.selected === next.selected &&
    prev.widths.label === next.widths.label &&
    prev.widths.story === next.widths.story &&
    prev.widths.tier === next.widths.tier &&
    prev.widths.title === next.widths.title &&
    prev.widths.total === next.widths.total &&
    prev.display === next.display &&
    Math.floor(prev.now / 60_000) === Math.floor(next.now / 60_000),
);

/** Rows shown around the selection when the queue is taller than `height`. */
function visible(count: number, selected: number, height: number): [number, number] {
  if (count <= height) return [0, count];
  const start = Math.max(0, Math.min(count - height, selected - Math.floor(height / 2)));
  return [start, start + height];
}

export function Queue(props: {
  rows: readonly QueueRow[];
  selected: number;
  display: Display;
  columns: number;
  height: number;
  now: number;
}) {
  const { rows, selected, display } = props;
  const w = widths(rows, props.columns);
  const [start, end] = visible(rows.length, selected, Math.max(3, props.height));
  return (
    <Box flexDirection="column">
      {rows.slice(start, end).map((row, offset) => {
        const index = start + offset;
        if (row.kind === "next") {
          const text = ` ${index === selected ? ">" : " "} next Ready story (the engine picks)`;
          return index === selected && display.color ? (
            <Text key="next" color="cyan" wrap="truncate-end">
              {text}
            </Text>
          ) : (
            <Text key="next" wrap="truncate-end">
              {text}
            </Text>
          );
        }
        return (
          <StoryRow
            key={row.view.key}
            row={row}
            widths={w}
            selected={index === selected}
            now={props.now}
            display={display}
          />
        );
      })}
      {rows.length === 1 ? <Text>{" The queue is empty."}</Text> : null}
    </Box>
  );
}
