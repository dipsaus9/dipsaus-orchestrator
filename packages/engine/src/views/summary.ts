// The office summary (0005 sections 5 and 7, 0009 section 3): the stories in each queue column,
// the active runs and what waits on the maintainer, derived from the office's rows. `engine.hello`
// and the software stream's `office.summary` take it from `officeSummarySource`. Open questions
// count from DIPO-59; test sessions arrive with M1 and count none until then. The day usage is M1.

import {
  GateId,
  OfficeId,
  type GateView,
  type OfficeSummary,
  type PrivacySetting,
  type QueueColumn,
  RunId,
} from "@dipsaus-orchestrator/contract";

import { type OfficeConfig, PRIVACY_KEYS, privacyOptIns } from "../config";
import type { StateDatabase } from "../db/database";
import type { OfficeHandle } from "../db/office";
import { openQuestions } from "../questions/questions";
import { activeRuns } from "../run/records";

import { activeStoryViews } from "./story";
import type { SummaryUsage } from "./usage";
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
 * What the summary takes from an office's configuration: the privacy opt-ins that are on and the
 * stored-output retention period in days, absent without a valid configuration.
 */
export interface SummarySettings {
  readonly optIns: readonly string[];
  readonly outputRetentionDays?: number;
  /** Each privacy setting with its value and source, absent without a valid configuration. */
  readonly privacy?: readonly PrivacySetting[];
  /** Today's and this month's tokens with the all-office limits (`UsageMeter.of`, DIPO-311). */
  readonly usage?: SummaryUsage;
}

/** The summary settings of an office, from its configuration in force (`summarySettings`). */
export type SummarySettingsOf = (office: OfficeId) => SummarySettings;

const noSettings: SummarySettingsOf = () => ({ optIns: [] });

/**
 * The summary settings of a configuration: `privacyOptIns`, `retention.days` and each privacy
 * setting with its source, `office.local.yaml` when `localOverrideKeys` names it, else `default`.
 */
export function summarySettings(
  config: OfficeConfig | undefined,
  localOverrideKeys: readonly string[] = [],
): SummarySettings {
  return {
    optIns: privacyOptIns(config),
    ...(config === undefined
      ? {}
      : {
          outputRetentionDays: config.retention.days,
          privacy: PRIVACY_KEYS.map((name) => ({
            key: `privacy.${name}`,
            value: config.privacy[name],
            source: localOverrideKeys.includes(`privacy.${name}`)
              ? ("office.local.yaml" as const)
              : ("default" as const),
          })),
        }),
  };
}

/**
 * The summary of one office: `running` counts active runs, `parked` the stories in the `desk`
 * column, and `waitingOnMaintainer` the parked stories, the open gates waiting on the maintainer and
 * the open questions (DIPO-59; tests count from M1), `ready` the stories in the `ready` column
 * (DIPO-81), `optIns` the privacy opt-ins that are on (0007 section 8, DIPO-83) and
 * `outputRetentionDays` the stored-output retention period (0007 section 7, DIPO-97).
 */
export function deriveOfficeSummary(
  identity: OfficeIdentity,
  office: OfficeHandle,
  settings: SummarySettings = { optIns: [] },
): OfficeSummary {
  const { optIns, outputRetentionDays, privacy, usage } = settings;
  const counts = columnCounts(office);
  const desk = counts.desk ?? 0;
  const gates = openGateViews(office).filter((gate) => gate.waitingOn === "maintainer").length;
  return {
    office: identity.office,
    name: identity.name,
    path: identity.path,
    running: activeRunCount(office),
    parked: desk,
    waitingOnMaintainer: desk + gates + openQuestions(office).length,
    ready: counts.ready ?? 0,
    ...(optIns.length === 0 ? {} : { optIns: [...optIns] }),
    ...(outputRetentionDays === undefined ? {} : { outputRetentionDays }),
    ...(privacy === undefined ? {} : { privacy: [...privacy] }),
    ...(usage === undefined
      ? {}
      : { dayUsage: usage.dayUsage, monthUsage: usage.monthUsage, evidence: usage.evidence }),
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
export function officeSummaries(
  database: StateDatabase,
  settingsOf: SummarySettingsOf = noSettings,
): OfficeSummary[] {
  return officeRows(database).map((row) => {
    const office = OfficeId.parse(row.office_id);
    return deriveOfficeSummary(
      { office, name: row.display_name, path: row.path },
      database.office(office),
      settingsOf(office),
    );
  });
}

/** The summary of one listed office, or undefined when it is not listed (forgotten or unknown). */
export function officeSummaryOf(
  database: StateDatabase,
  office: OfficeId,
  settingsOf: SummarySettingsOf = noSettings,
): OfficeSummary | undefined {
  const row = database.connection.get<OfficeListRow>(
    "select office_id, path, display_name from offices where office_id = $office and forgotten_at is null",
    { office },
  );
  if (row === null) return undefined;
  return database.connection.deferred(() =>
    deriveOfficeSummary(
      { office, name: row.display_name, path: row.path },
      database.office(office),
      settingsOf(office),
    ),
  );
}

/**
 * The summary of one office for the debounced `office.summary` (DIPO-52): only the office that
 * changed is derived. Undefined before the state database is open.
 */
export function officeSummaryOfSource(
  database: () => StateDatabase | null,
  settingsOf: SummarySettingsOf = noSettings,
): (office: OfficeId) => OfficeSummary | undefined {
  return (office) => {
    const db = database();
    return db === null ? undefined : officeSummaryOf(db, office, settingsOf);
  };
}

/**
 * The office summary source `engine.hello` and the software stream use (`OfficeSummarySource` in
 * `reads/hello.ts`): every listed office's summary, or none before the state database is open.
 */
export function officeSummarySource(
  database: () => StateDatabase | null,
  settingsOf: SummarySettingsOf = noSettings,
): () => OfficeSummary[] {
  return () => {
    const db = database();
    return db === null ? [] : db.connection.deferred(() => officeSummaries(db, settingsOf));
  };
}
