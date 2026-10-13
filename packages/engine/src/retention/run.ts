// One retention pass over one office's rows (0007 section 7). Each delete is a batch of at most
// 5,000 rows in its own immediate transaction, sized to the 50 ms budget, with the event loop
// running between batches. Deleting change-log entries moves `offices.replay_floor_seq` in the
// same transaction, so a later subscribe below it gets `stream.resetRequired` (0005 section 8).

import type { Clock } from "@dipsaus-orchestrator/contract";

import { appendEntries } from "../changelog/log";
import { REQUEST_TTL_MS } from "../commands/requests";
import type { OfficeHandle } from "../db/office";
import type { SqlParams } from "../platform/sqlite";

import { cleanRunDirectories, runSummaryExists, type SummaryCheck } from "./run-files";
import { Slicer, type SliceOptions } from "./slices";

export const DAY_MS = 24 * 60 * 60 * 1000;

/** `retention.shortDays` and `retention.stateDays` from `office.local.yaml` or their defaults. */
export interface RetentionPeriods {
  readonly shortDays: number;
  readonly stateDays: number;
}

export interface RetentionOptions extends Omit<SliceOptions, "clock"> {
  readonly office: OfficeHandle;
  readonly clock: Clock;
  readonly periods: RetentionPeriods;
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
  readonly replayFloorSeq: number;
  readonly eventFiles: number;
  readonly runDirectories: number;
  /** Engine notices appended to the office's change log. */
  readonly notices: number;
  /** The slowest batch, in milliseconds. */
  readonly slowestMs: number;
}

const CLOSED_JOURNAL = "state in ('merged', 'dropped', 'withdrawn')";
const ENDED_AGENT =
  "agent_id in (select agent_id from agents where office_id = $office_id and ended_at < $cutoff)";

/** Runs one pass; the caller keeps passes of one office from overlapping. */
export async function runRetention(options: RetentionOptions): Promise<RetentionReport> {
  const { office, clock, periods } = options;
  const now = clock.now();
  const requestCutoff = now - REQUEST_TTL_MS;
  const shortCutoff = now - periods.shortDays * DAY_MS;
  const stateCutoff = now - periods.stateDays * DAY_MS;
  const slicer = new Slicer({ ...options, clock });
  const deleted: Record<string, number> = {};
  const count = (table: string, n: number) => {
    if (n > 0) deleted[table] = (deleted[table] ?? 0) + n;
  };

  const rows = async (table: string, where: string, params: SqlParams) => {
    for (;;) {
      const { result, limit } = await slicer.slice((batch) =>
        office.immediate(
          () =>
            office.run(
              `delete from ${table} where rowid in (
                 select rowid from ${table} where office_id = $office_id and ${where} limit $limit)`,
              { ...params, limit: batch },
            ).changes,
        ),
      );
      count(table, result);
      if (result < limit) return;
    }
  };

  const log = async (tier: "R" | "S", cutoff: number) => {
    for (;;) {
      const { result, limit } = await slicer.slice((batch) =>
        office.immediate(() => {
          const seqs = office
            .all<{ seq: number }>(
              `select seq from change_log where office_id = $office_id and tier = $tier and at < $cutoff
                order by at, seq limit $limit`,
              { tier, cutoff, limit: batch },
            )
            .map((row) => row.seq);
          if (seqs.length === 0) return 0;
          office.run(
            "delete from change_log where office_id = $office_id and seq in (select value from json_each($seqs))",
            { seqs: JSON.stringify(seqs) },
          );
          // Replay after any cursor at or above the newest deleted seq is still complete.
          office.run(
            "update offices set replay_floor_seq = max(replay_floor_seq, $floor) where office_id = $office_id",
            { floor: seqs.reduce((a, b) => Math.max(a, b)) },
          );
          return seqs.length;
        }),
      );
      count("change_log", result);
      if (result < limit) return;
    }
  };

  // D: idempotency records.
  await rows("requests", "at <= $cutoff", { cutoff: requestCutoff });
  // R: short-tier entries, stored output, per-message usage and cursors of ended runs.
  await log("R", shortCutoff);
  await rows("output_chunks", "at < $cutoff", { cutoff: shortCutoff });
  await rows("usage_messages", "at < $cutoff", { cutoff: shortCutoff });
  await rows("ingest_cursors", "ended_at < $cutoff", { cutoff: shortCutoff });
  // S: state entries and the rows of runs that ended before the cutoff. Rows that reference an
  // agent go before the agent.
  await log("S", stateCutoff);
  await rows("usage_messages", ENDED_AGENT, { cutoff: stateCutoff });
  await rows("ingest_cursors", ENDED_AGENT, { cutoff: stateCutoff });
  await rows("usage_totals", ENDED_AGENT, { cutoff: stateCutoff });
  // Prompt part hashes of a run with no agent still running.
  await rows(
    "prompt_parts",
    `recorded_at < $cutoff and not exists (select 1 from agents a where a.office_id = $office_id
       and a.run_id = prompt_parts.run_id and a.ended_at is null)`,
    { cutoff: stateCutoff },
  );
  await rows("agents", "ended_at < $cutoff", { cutoff: stateCutoff });
  // Released claims; a live claim has no release time.
  await rows("claims", "released_at < $cutoff", { cutoff: stateCutoff });
  await rows("scans", "finished_at < $cutoff", { cutoff: stateCutoff });
  await rows("worker_hosts", "ended_at < $cutoff", { cutoff: stateCutoff });
  await rows("backlog_journal", `${CLOSED_JOURNAL} and closed_at < $cutoff`, {
    cutoff: stateCutoff,
  });

  let eventFiles = 0;
  let runDirectories = 0;
  let notices = 0;
  if (options.runFiles !== undefined) {
    const files = cleanRunDirectories({
      office,
      commonDir: options.runFiles.commonDir,
      shortCutoff,
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
              text: `The raw event file of run ${run.run} was deleted ${periods.shortDays} days after the run ended, before it was fully processed (offset ${run.processed} of ${run.final ?? "unknown"}); usage and output after that offset were not recorded.`,
            },
          })),
          { at },
        ),
      );
      notices = files.unprocessed.length;
    }
  }

  const floor =
    office.get<{ floor: number }>(
      "select replay_floor_seq as floor from offices where office_id = $office_id",
    )?.floor ?? 0;
  return {
    deleted,
    replayFloorSeq: floor,
    eventFiles,
    runDirectories,
    notices,
    slowestMs: slicer.slowestMs,
  };
}
