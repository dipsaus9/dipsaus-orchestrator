// The minimal office summary (0005 sections 5 and 7, 0009 section 3): the stories in each queue
// column and the active runs, derived from the office's rows. `engine.hello` and the software
// stream's `office.summary` take it from `officeSummarySource`. The column counts come from the
// lifecycle alone, as in the minimal story view; DIPO-52 adds open gates, questions and tests to
// `waitingOnMaintainer`, separates on-hold parks into the `held` column, and the day usage.

import { OfficeId, type OfficeSummary, type QueueColumn } from "@dipsaus-orchestrator/contract";

import type { StateDatabase } from "../db/database";
import type { OfficeHandle } from "../db/office";

import { activeStoryViews } from "./story";

/** How many stories that are not removed show in each column; columns with none are absent. */
export function columnCounts(office: OfficeHandle): Partial<Record<QueueColumn, number>> {
  const counts: Partial<Record<QueueColumn, number>> = {};
  for (const view of activeStoryViews(office)) {
    counts[view.column] = (counts[view.column] ?? 0) + 1;
  }
  return counts;
}

/** Runs with a worker host that has not ended (0006 decision 8). */
export function activeRunCount(office: OfficeHandle): number {
  return (
    office.get<{ n: number }>(
      "select count(distinct run_id) as n from worker_hosts where office_id = $office_id and ended_at is null",
    )?.n ?? 0
  );
}

export interface OfficeIdentity {
  readonly office: OfficeId;
  readonly name: string;
  readonly path: string;
}

/**
 * The summary of one office: `running` counts active runs, `parked` the stories in the `desk` and
 * `held` columns, `onHold` those in `held`, and `waitingOnMaintainer` those in `desk`.
 */
export function deriveOfficeSummary(identity: OfficeIdentity, office: OfficeHandle): OfficeSummary {
  const counts = columnCounts(office);
  const desk = counts.desk ?? 0;
  const held = counts.held ?? 0;
  return {
    office: identity.office,
    name: identity.name,
    path: identity.path,
    running: activeRunCount(office),
    parked: desk + held,
    onHold: held,
    waitingOnMaintainer: desk,
  };
}

interface OfficeListRow {
  office_id: string;
  path: string;
  display_name: string;
}

/** The summary of every office in the office list, in the order offices were added. */
export function officeSummaries(database: StateDatabase): OfficeSummary[] {
  const rows = database.connection.all<OfficeListRow>(
    "select office_id, path, display_name from offices where forgotten_at is null order by added_at, office_id",
  );
  return rows.map((row) => {
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
