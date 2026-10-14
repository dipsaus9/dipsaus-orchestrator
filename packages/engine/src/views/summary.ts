// The office summary (0005 sections 5 and 7, 0009 section 3): the stories in each queue column,
// the active runs and what waits on the maintainer, derived from the office's rows. `engine.hello`
// and the software stream's `office.summary` take it from `officeSummarySource`. Open questions
// arrive with DIPO-59 and test sessions with M1; until then they count none. The day usage is M1.

import {
  GateId,
  OfficeId,
  type GateView,
  type OfficeSummary,
  type QueueColumn,
  RunId,
} from "@dipsaus-orchestrator/contract";

import type { StateDatabase } from "../db/database";
import type { OfficeHandle } from "../db/office";
import { activeRuns } from "../run/records";

import { activeStoryViews } from "./story";
import { workRefOf } from "./work";

/** How many stories that are not removed show in each column; columns with none are absent. */
export function columnCounts(office: OfficeHandle): Partial<Record<QueueColumn, number>> {
  const counts: Partial<Record<QueueColumn, number>> = {};
  for (const view of activeStoryViews(office)) {
    counts[view.column] = (counts[view.column] ?? 0) + 1;
  }
  return counts;
}

/** The office's active runs (`run/records.ts`). */
export function activeRunCount(office: OfficeHandle): number {
  return activeRuns(office).length;
}

interface OpenGateRow {
  gate_id: string;
  kind: string;
  run_id: string;
  waiting_on: "maintainer" | "rule";
  summary: string;
}

/**
 * Gates of a run that wait for a decision (no `gate_decisions` row), oldest first. The Ready gate
 * and its pickup re-check are decided as they open and have no run, so they never show here.
 */
export function openGateViews(office: OfficeHandle): GateView[] {
  const rows = office.all<OpenGateRow>(
    `select g.gate_id, g.kind, g.run_id, g.waiting_on, g.summary from gates g
      where g.office_id = $office_id and g.run_id is not null and g.waiting_on is not null
        and not exists (select 1 from gate_decisions d
                         where d.office_id = g.office_id and d.gate_id = g.gate_id)
      order by g.opened_at, g.gate_id`,
  );
  return rows.flatMap((row) => {
    const work = workRefOf(office, RunId.parse(row.run_id));
    if (work === null) return [];
    return [
      {
        gate: GateId.parse(row.gate_id),
        work,
        kind: row.kind,
        waitingOn: row.waiting_on,
        summary: row.summary,
      },
    ];
  });
}

export interface OfficeIdentity {
  readonly office: OfficeId;
  readonly name: string;
  readonly path: string;
}

/**
 * The summary of one office: `running` counts active runs, `parked` the stories in the `desk` and
 * `held` columns, `onHold` those in `held`, and `waitingOnMaintainer` the parked stories other than
 * on-hold plus the open gates waiting on the maintainer (open questions and tests count from
 * DIPO-59 and M1).
 */
export function deriveOfficeSummary(identity: OfficeIdentity, office: OfficeHandle): OfficeSummary {
  const counts = columnCounts(office);
  const desk = counts.desk ?? 0;
  const held = counts.held ?? 0;
  const gates = openGateViews(office).filter((gate) => gate.waitingOn === "maintainer").length;
  return {
    office: identity.office,
    name: identity.name,
    path: identity.path,
    running: activeRunCount(office),
    parked: desk + held,
    onHold: held,
    waitingOnMaintainer: desk + gates,
  };
}

interface OfficeListRow {
  office_id: string;
  path: string;
  display_name: string;
}

function officeRows(database: StateDatabase): OfficeListRow[] {
  return database.connection.all<OfficeListRow>(
    "select office_id, path, display_name from offices where forgotten_at is null order by added_at, office_id",
  );
}

/** The summary of every office in the office list, in the order offices were added. */
export function officeSummaries(database: StateDatabase): OfficeSummary[] {
  return officeRows(database).map((row) => {
    const office = OfficeId.parse(row.office_id);
    return deriveOfficeSummary(
      { office, name: row.display_name, path: row.path },
      database.office(office),
    );
  });
}

/**
 * The office summary source `engine.hello` and the software stream use (`OfficeSummarySource` in
 * `reads/hello.ts`): every listed office's summary, or none before the state database is open.
 */
export function officeSummarySource(database: () => StateDatabase | null): () => OfficeSummary[] {
  return () => {
    const db = database();
    return db === null ? [] : db.connection.deferred(() => officeSummaries(db));
  };
}
