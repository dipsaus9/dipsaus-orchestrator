// The office overview (`1`, 0009 sections 4 and 9): one row per `WorkView` with story, role,
// tier, phase, health word and glyph, criteria, loop, verify, budget bar with its share and
// elapsed time, and a summary line with the Ready, waiting and held counts. At 120 columns or more
// the model and turns show too; from 80 to 119 they drop and the role is shortened; from 60 to 79
// each run is a two-line card. Rows are memoised by run, and each line is cut to the width. The
// selected run is marked with `>` in the first column; Enter opens its live detail (DIPO-55).

import type { OfficeStoreState } from "@dipsaus-orchestrator/client";
import type { StoryView, WorkView } from "@dipsaus-orchestrator/contract";
import { Box, Text } from "ink";
import { memo } from "react";

import {
  budgetBar,
  elapsed,
  evidenceOf,
  marked,
  percent,
  shortRole,
  tokens,
  truncate,
  type Width,
} from "./format";
import type { Display } from "./options";
import { glyphs, healthLabel } from "./views";

/** The legend for evidence markers, shown in the footer with the `evidence` capability. */
export const EVIDENCE_LEGEND = "* claimed ~ estimated ? none";

export function evidenceEnabled(state: OfficeStoreState): boolean {
  return state.capabilities.includes("evidence");
}

/** The cells of one run, as the engine sent them, with evidence markers when enabled. */
function cells(view: WorkView, evidence: boolean) {
  const { progress, usage } = view;
  const mark = (value: string, path: string) =>
    marked(value, evidenceOf(view.evidence, path, evidence));
  return {
    story: String(view.work.story),
    role: view.work.role,
    tier: view.work.tier,
    phase: view.phase,
    health: healthLabel(view.health),
    ac: mark(`${progress.criteriaMet}/${progress.criteriaTotal}`, "progress.criteriaMet"),
    loop: mark(`${progress.loop}/${progress.loopCap}`, "progress.loop"),
    verify: mark(progress.verify, "progress.verify"),
    share: mark(percent(usage.budgetShare), "usage.budgetShare"),
    bar: budgetBar(usage),
    time: mark(elapsed(usage.run.elapsedMs), "usage.run.elapsedMs"),
    model: view.work.model,
    turns: mark(String(usage.run.turns), "usage.run.turns"),
  };
}

type Cells = ReturnType<typeof cells>;
type Column = { readonly title: string; readonly cell: (c: Cells) => string; width: number };

function columnsFor(width: Width): Column[] {
  const role = width === "full" ? (c: Cells) => c.role : (c: Cells) => shortRole(c.role);
  const columns: Column[] = [
    { title: "STORY", cell: (c) => c.story, width: 0 },
    { title: "ROLE", cell: role, width: 0 },
    { title: "T", cell: (c) => c.tier, width: 0 },
    { title: "PHASE", cell: (c) => c.phase, width: 0 },
    { title: "HEALTH", cell: (c) => c.health, width: 0 },
    { title: "AC", cell: (c) => c.ac, width: 0 },
    { title: "LOOP", cell: (c) => c.loop, width: 0 },
    { title: "VERIFY", cell: (c) => c.verify, width: 0 },
    { title: "BUDGET", cell: (c) => `${c.bar}${c.share.padStart(4)}`, width: 0 },
    { title: "TIME", cell: (c) => c.time, width: 0 },
  ];
  if (width === "full") {
    columns.push(
      { title: "MODEL", cell: (c) => c.model, width: 0 },
      { title: "TURNS", cell: (c) => c.turns, width: 0 },
    );
  }
  return columns;
}

/** The overview table: column widths fit the widest cell, so rows line up under the titles. */
function layout(rows: readonly Cells[], width: Width): Column[] {
  const columns = columnsFor(width);
  for (const column of columns) {
    column.width = Math.max(column.title.length, ...rows.map((row) => column.cell(row).length));
  }
  return columns;
}

function line(values: readonly string[], columns: readonly Column[]): string {
  return ` ${values.map((value, i) => value.padEnd(columns[i]?.width ?? 0)).join(" ")}`.trimEnd();
}

/** Memoised by run: a row renders again only when its view, the evidence flag or the widths change. */
const TableRow = memo(
  function TableRow(props: {
    view: WorkView;
    columns: readonly Column[];
    evidence: boolean;
    columnsKey: string;
    selected: boolean;
  }) {
    const row = cells(props.view, props.evidence);
    const text = line(
      props.columns.map((column) => column.cell(row)),
      props.columns,
    );
    return <Text wrap="truncate-end">{props.selected ? `>${text.slice(1)}` : text}</Text>;
  },
  (prev, next) =>
    prev.view === next.view &&
    prev.evidence === next.evidence &&
    prev.columnsKey === next.columnsKey &&
    prev.selected === next.selected,
);

const Card = memo(function Card(props: { view: WorkView; evidence: boolean; selected: boolean }) {
  const row = cells(props.view, props.evidence);
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">{`${props.selected ? ">" : " "}${row.story}  ${row.health}  ${row.phase}`}</Text>
      <Text wrap="truncate-end">{`   AC ${row.ac}  loop ${row.loop}  budget ${row.share}`}</Text>
    </Box>
  );
});

/** `Ready 4 · waiting 2 (on DIPO-21) · held 1 · desk 2 · today 1.2M of 4M tokens`. */
export function summaryLine(state: OfficeStoreState, dot: string): string {
  const count = (column: string) => state.stories.filter((s) => s.column === column).length;
  const waiting = state.stories.filter((story) => story.column === "waiting");
  const on = [...new Set(waiting.flatMap((story: StoryView) => story.waitingOn ?? []))];
  const summary = state.offices.find((entry) => entry.office === state.office)?.summary;
  const parts = [
    `Ready ${count("ready")}`,
    `waiting ${waiting.length}${on.length === 0 ? "" : ` (on ${on.join(", ")})`}`,
    `held ${count("held")}`,
    `desk ${summary?.waitingOnMaintainer ?? "?"}`,
  ];
  const day = summary?.dayUsage;
  if (day !== undefined) {
    const limit = day.limit === undefined ? "" : ` of ${tokens(day.limit)}`;
    const cost = day.estimatedCost === undefined ? "" : ` (~$${day.estimatedCost.toFixed(2)})`;
    parts.push(`today ${tokens(day.tokens)}${limit} tokens${cost}`);
  }
  return ` ${parts.join(` ${dot} `)}`;
}

export function Overview(props: {
  state: OfficeStoreState;
  display: Display;
  width: Width;
  columns: number;
  /** The selected run, marked with `>`; Enter opens its detail. */
  selected?: string | null;
}) {
  const { state, display, width } = props;
  const { dot, ellipsis } = glyphs(display.ascii);
  if (state.office === null) {
    return <Text>{" No office selected. Press o to choose one."}</Text>;
  }
  if (state.loading && state.stories.length === 0) {
    return <Text>{` Loading${ellipsis}`}</Text>;
  }
  const evidence = evidenceEnabled(state);
  const summary = <Text wrap="truncate-end">{summaryLine(state, dot)}</Text>;
  if (state.work.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>{" No story is running. Press 2 for the queue, then u to run one."}</Text>
        {summary}
      </Box>
    );
  }
  if (width === "cards") {
    return (
      <Box flexDirection="column">
        {state.work.map((view) => (
          <Card
            key={view.work.run}
            view={view}
            evidence={evidence}
            selected={view.work.run === props.selected}
          />
        ))}
        {summary}
      </Box>
    );
  }
  const columns = layout(
    state.work.map((view) => cells(view, evidence)),
    width,
  );
  const columnsKey = `${width}:${columns.map((column) => column.width).join(",")}`;
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        {truncate(
          line(
            columns.map((column) => column.title),
            columns,
          ),
          props.columns,
          ellipsis,
        )}
      </Text>
      {state.work.map((view) => (
        <TableRow
          key={view.work.run}
          view={view}
          columns={columns}
          evidence={evidence}
          columnsKey={columnsKey}
          selected={view.work.run === props.selected}
        />
      ))}
      {summary}
    </Box>
  );
}
