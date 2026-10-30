// The one retention rule (0007): one pass over one office's rows deletes everything about a run
// that ended more than `retention.days` ago and may not reopen (`records/retired.ts`: done, dropped,
// or parked with no live claim and no open park), and every other row of run detail older than
// that: change-log entries, output, steps, verdicts, feedback and the rest. The run's outcome row
// and the daily usage rollup are kept, and so are the office's own facts (story identity, the
// backlog cache, run profiles, confirmations). Each delete is a batch of at most 5,000 rows in its
// own immediate transaction, sized to the 50 ms budget, with the event loop running between
// batches. A subscriber whose cursor is older than the oldest change-log row left gets
// `stream.resetRequired` (0005).
//
// `runs`, `parks`, `agents`, `worker_hosts` and `run_signals` are deleted through their one writer
// (0001).

import type { Clock } from "@dipsaus-orchestrator/contract";

import { appendEntries } from "../changelog/log";
import { REQUEST_TTL_MS } from "../commands/requests";
import type { OfficeHandle } from "../db/office";
import type { SqlParams } from "../platform/sqlite";
import { deleteParksResolvedBefore } from "../run/park-records";
import { deleteRetiredRuns } from "../records/run-records";
import { ofNoOpenRun, retiredRun } from "../records/retired";
import { deleteRetiredSignals } from "../records/signals";
import { deleteRetiredAgents } from "../records/agents";
import { deleteRetiredHosts } from "../records/worker-hosts";

import { cleanRunDirectories, runSummaryExists, type SummaryCheck } from "./run-files";
import { Slicer, type SliceOptions } from "./slices";

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionOptions extends Omit<SliceOptions, "clock"> {
  readonly office: OfficeHandle;
  readonly clock: Clock;
  /** `retention.days` from `office.local.yaml` or its default. */
  readonly days: number;
  /** Run directories to clean; left out, only rows are deleted. */
  readonly runFiles?: {
    readonly commonDir: string;
    readonly keepRawEvents: boolean;
    readonly summarised?: SummaryCheck;
  };
}

export interface RetentionReport {
  /** Rows deleted per table; tables with none are left out. */
  readonly deleted: Readonly<Record<string, number>>;
  readonly eventFiles: number;
  readonly runDirectories: number;
  /** Engine notices appended to the office's change log. */
  readonly notices: number;
  /** The slowest batch, in milliseconds. */
  readonly slowestMs: number;
}

const CLOSED_JOURNAL = "state in ('merged', 'dropped', 'withdrawn')";
/** The rows of agents that ended before the cutoff, of a run that may not reopen. */
const ENDED_AGENT = `agent_id in (select agent_id from agents where office_id = $office_id
  and ended_at < $cutoff and ${ofNoOpenRun("agents")})`;

/** The rows of `table` whose run is retired (`retiredRun`): a parked or In Review run stays. */
const endedRun = (table: string): string =>
  `exists (select 1 from runs r where r.office_id = $office_id and r.run_id = ${table}.run_id
     and ${retiredRun("r")})`;

/** Tables whose rows go with their run. */
const RUN_DETAIL = [
  "run_steps",
  "run_grants",
  "run_intents",
  "feedback_items",
  "catch_ups",
  "questions",
  "run_summaries",
  "done_reports",
  "report_sendbacks",
] as const;

const PROFILE_CHILDREN = ["run_capabilities", "run_env_files", "run_extra_scripts"] as const;

/**
 * The run profiles to keep: the current one and its previous one, or the two newest when none is
 * current. Null when the office has no profile.
 */
function keptProfiles(office: OfficeHandle): number[] | null {
  const current = office.get<{ id: number; previous: number | null }>(
    `select profile_id as id, previous_profile_id as previous from run_profiles
      where office_id = $office_id and current = 1`,
  );
  if (current !== null) {
    return current.previous === null ? [current.id] : [current.id, current.previous];
  }
  const newest = office
    .all<{ id: number }>(
      `select profile_id as id from run_profiles where office_id = $office_id
        order by profile_id desc limit 2`,
    )
    .map((row) => row.id);
  return newest.length === 0 ? null : newest;
}

/** Runs one pass; the caller keeps passes of one office from overlapping. */
export async function runRetention(options: RetentionOptions): Promise<RetentionReport> {
  const { office, clock, days } = options;
  const now = clock.now();
  const cutoff = now - days * DAY_MS;
  const slicer = new Slicer({ ...options, clock });
  const deleted: Record<string, number> = {};

  /** Deletes in batches until a batch comes back short. */
  const batches = async (table: string, batch: (limit: number) => number) => {
    for (;;) {
      const { result, limit } = await slicer.slice((size) => office.immediate(() => batch(size)));
      if (result > 0) deleted[table] = (deleted[table] ?? 0) + result;
      if (result < limit) return;
    }
  };
  const rows = (table: string, where: string, params: SqlParams = { cutoff }) =>
    batches(
      table,
      (limit) =>
        office.run(
          `delete from ${table} where rowid in (
             select rowid from ${table} where office_id = $office_id and ${where} limit $limit)`,
          { ...params, limit },
        ).changes,
    );

  // Run directories first: which runs ended, and when, is read from their worker host rows,
  // which this pass deletes below.
  let eventFiles = 0;
  let runDirectories = 0;
  let notices = 0;
  if (options.runFiles !== undefined) {
    const files = cleanRunDirectories({
      office,
      commonDir: options.runFiles.commonDir,
      cutoff,
      keepRawEvents: options.runFiles.keepRawEvents,
      summarised: options.runFiles.summarised ?? runSummaryExists,
    });
    eventFiles = files.eventFiles;
    runDirectories = files.runDirectories;
    if (files.unprocessed.length > 0) {
      const at = clock.now();
      office.immediate(() =>
        appendEntries(
          office,
          files.unprocessed.map((run) => ({
            type: "engine.notice",
            delta: {
              level: "warn",
              code: "retention.eventsUnprocessed",
              text: `The raw event file of run ${run.run} was deleted ${days} days after the run ended, before it was fully processed (offset ${run.processed} of ${run.final ?? "unknown"}); usage and output after that offset were not recorded.`,
            },
          })),
          { at },
        ),
      );
      notices = files.unprocessed.length;
    }
  }

  // Stored replies of commands, after a day.
  await rows("requests", "at <= $cutoff", { cutoff: now - REQUEST_TTL_MS });
  // Detail with its own time.
  await rows("change_log", "at < $cutoff");
  await rows("output_chunks", "at < $cutoff");
  await rows("prompt_texts", "recorded_at < $cutoff");
  // The agents that ended before the cutoff, of runs that may not reopen, their rows first: a
  // parked run keeps its usage for its caps when it resumes.
  await rows("usage_messages", ENDED_AGENT);
  await rows("ingest_cursors", ENDED_AGENT);
  await rows("usage_totals", ENDED_AGENT);
  await rows("compactions", ENDED_AGENT);
  // Prompt part hashes of a run with no agent still running.
  await rows(
    "prompt_parts",
    `recorded_at < $cutoff and not exists (select 1 from agents a where a.office_id = $office_id
       and a.run_id = prompt_parts.run_id and a.ended_at is null) and ${ofNoOpenRun("prompt_parts")}`,
  );
  await batches("agents", (limit) => deleteRetiredAgents(office, cutoff, limit));
  // The retired runs, their rows first; their outcome rows stay.
  for (const table of RUN_DETAIL) await rows(table, endedRun(table));
  await batches("run_signals", (limit) => deleteRetiredSignals(office, cutoff, limit));
  await rows("acceptance_tests", `ended_at is not null and ${endedRun("acceptance_tests")}`);
  await batches("runs", (limit) => deleteRetiredRuns(office, cutoff, limit));
  // What the maintainer decided; an open note, proposal or park is kept.
  await rows("decision_notes", "state <> 'open' and updated_at < $cutoff");
  await rows("proposals", "state <> 'open' and updated_at < $cutoff");
  await batches("parks", (limit) => deleteParksResolvedBefore(office, cutoff, limit));
  // Leftovers of a story Done elsewhere stay until `dipo discard` cleared them (DIPO-161).
  await rows("done_elsewhere", "cleared_at < $cutoff");
  await rows(
    "config_snapshots",
    `first_seen < $cutoff and not exists (select 1 from runs r where r.office_id = $office_id
       and r.config_hash = config_snapshots.config_hash)`,
  );
  // Released claims; a live claim has no release time.
  await rows("claims", "released_at < $cutoff");
  await rows("scans", "finished_at < $cutoff");
  // A released branch stays until reclaimed (0010); the reclaim record is history.
  await rows("released_branches", "reclaimed_at < $cutoff");
  // Gate decisions and review verdicts, then the gates they leave without a decision; a gate
  // still waiting is kept.
  await rows("gate_decisions", "decided_at < $cutoff");
  await rows("review_verdicts", "decided_at < $cutoff");
  await rows(
    "gates",
    `opened_at < $cutoff and waiting_on is null and not exists (select 1 from gate_decisions d
       where d.office_id = $office_id and d.gate_id = gates.gate_id)`,
  );
  // Only the current run profile and its previous one are kept (0007); older profiles go with
  // their capability, env-file and extra-script rows.
  const profiles = keptProfiles(office);
  if (profiles !== null) {
    const kept = { kept: JSON.stringify(profiles) };
    const older = "profile_id not in (select value from json_each($kept))";
    for (const table of PROFILE_CHILDREN) await rows(table, older, kept);
    await rows("run_profiles", older, kept);
  }
  await batches("worker_hosts", (limit) => deleteRetiredHosts(office, cutoff, limit));
  await rows("backlog_journal", `${CLOSED_JOURNAL} and closed_at < $cutoff`);
  // Backlog and story PRs merged or closed, and blocks a later backlog PR cleared; an open PR or
  // a block in force is kept.
  await rows("backlog_prs", "closed_at < $cutoff");
  await rows("story_prs", "closed_at < $cutoff");
  await rows("backlog_pr_blocks", "cleared_at < $cutoff");

  return { deleted, eventFiles, runDirectories, notices, slowestMs: slicer.slowestMs };
}
