// Run directories (0007 sections 2, 7 and 8). `events.ndjson` holds tool inputs, so it exists only
// while the run needs it: it is deleted once every worker host of the run has ended, the engine has
// processed it up to each host's final offset and the run summary exists. Fallback: once the run
// ended longer ago than the short tier, the whole run directory (`events.ndjson`, `host.log`,
// `exit.json`) is deleted in every case, with an `engine.notice` when the stream was never fully
// processed. With `privacy.keepRawEvents` the stream is kept for the short tier too.

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { OfficeHandle } from "../db/office";
import { EVENTS_FILE, RUN_ID_PATTERN } from "../host/protocol";
import { officeDirectory } from "../office/marker";
import { runDirectory } from "../runs/worker-hosts";

/** Whether the run summary of `run` exists (0005, 0007 section 4 `run_summaries`). */
export type SummaryCheck = (office: OfficeHandle, run: string) => boolean;

/**
 * The default check: a `run_summaries` row for the run. Until the story that writes run summaries
 * (DIPO-49) adds the table there is none, so a processed event file waits for the fallback.
 */
export const runSummaryExists: SummaryCheck = (office, run) => {
  const table = office.get(
    `select 1 as found from sqlite_schema s join offices o on o.office_id = $office_id
      where s.type = 'table' and s.name = 'run_summaries'`,
  );
  if (table === null) return false;
  return (
    office.get(
      "select 1 as found from run_summaries where office_id = $office_id and run_id = $run",
      {
        run,
      },
    ) !== null
  );
};

export interface RunFilesOptions {
  readonly office: OfficeHandle;
  /** `<git-common-dir>` of the office; run directories live in `<git-common-dir>/dipo/runs/`. */
  readonly commonDir: string;
  /** Runs that ended before this time are past the short tier. */
  readonly shortCutoff: number;
  readonly keepRawEvents: boolean;
  readonly summarised: SummaryCheck;
}

/** A run whose event file was deleted before it was fully processed. */
export interface UnprocessedRun {
  readonly run: string;
  /** The lowest processed offset over its hosts, and the final offset that host recorded. */
  readonly processed: number;
  readonly final: number | null;
}

export interface RunFilesReport {
  readonly eventFiles: number;
  readonly runDirectories: number;
  readonly unprocessed: readonly UnprocessedRun[];
}

interface HostRow {
  run_id: string;
  processed_offset: number;
  final_offset: number | null;
  ended_at: number | null;
}

/** Deletes the event files and run directories that are due; returns what it deleted. */
export function cleanRunDirectories(options: RunFilesOptions): RunFilesReport {
  const { office } = options;
  const rows = office.all<HostRow>(
    `select run_id, processed_offset, final_offset, ended_at from worker_hosts
      where office_id = $office_id order by run_id`,
  );
  const runs = new Map<string, HostRow[]>();
  for (const row of rows) {
    const hosts = runs.get(row.run_id);
    if (hosts === undefined) runs.set(row.run_id, [row]);
    else hosts.push(row);
  }

  const officeDir = officeDirectory(options.commonDir);
  let eventFiles = 0;
  let runDirectories = 0;
  const unprocessed: UnprocessedRun[] = [];
  for (const [run, hosts] of runs) {
    // Only directories the engine names itself: a bad id never becomes a path to delete.
    if (!RUN_ID_PATTERN.test(run)) continue;
    // A host still running, or not yet seen to exit: the run has not ended.
    if (hosts.some((host) => host.ended_at === null)) continue;
    const dir = runDirectory(officeDir, run);
    const events = join(dir, EVENTS_FILE);
    const processed = hosts.every(
      (host) => host.final_offset !== null && host.processed_offset >= host.final_offset,
    );
    const endedAt = Math.max(...hosts.map((host) => host.ended_at ?? 0));

    if (endedAt < options.shortCutoff) {
      if (!existsSync(dir)) continue;
      const hadEvents = existsSync(events);
      rmSync(dir, { recursive: true, force: true });
      runDirectories += 1;
      if (hadEvents) {
        eventFiles += 1;
        if (!processed) {
          const lowest = hosts.reduce((a, b) => (b.processed_offset < a.processed_offset ? b : a));
          unprocessed.push({ run, processed: lowest.processed_offset, final: lowest.final_offset });
        }
      }
      continue;
    }
    if (options.keepRawEvents || !processed || !existsSync(events)) continue;
    if (!options.summarised(office, run)) continue;
    rmSync(events, { force: true });
    eventFiles += 1;
  }
  return { eventFiles, runDirectories, unprocessed };
}
