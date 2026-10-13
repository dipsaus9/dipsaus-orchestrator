// Where the active work comes from (0006 decision 12), read across every office from the one
// state database (0007), never from daemon memory alone, so a restarted daemon sees the hosts that
// outlived the previous one:
//
// - a run with a live worker host: a `worker_hosts` row without `ended_at` whose PID and start time
//   still match a running process (0006 decision 8);
// - a confirmed batch waiting to start: a live claim (`claims.released_at` null) whose run has no
//   worker host yet, only within `CLAIM_START_WINDOW_MS` of the claim, so an orphan claim (a run
//   that died between claim and host start) cannot keep the machine awake for ever. Releasing such
//   claims is reconcile's job at daemon start (DIPO-56);
// - a running verify: verify steps register here while they run (`WorkTracker`).

import type { SqlRunner } from "../platform/sqlite";
import { isSameProcess, type ProcessProbe } from "../platform/process";
import type { WorkActivity } from "./keepawake";

/** A claimed story counts as waiting to start for this long after its claim, then no longer. */
export const CLAIM_START_WINDOW_MS = 5 * 60_000;

/** Work the database does not record while it runs: the verify step (DIPO-49) calls `beginVerify`. */
export class WorkTracker {
  #verifies = 0;

  /** Marks one verify as running; call the returned function when it ends (once). */
  beginVerify(): () => void {
    this.#verifies++;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.#verifies--;
    };
  }

  get verifies(): number {
    return this.#verifies;
  }
}

interface OpenHostRow {
  office_id: string;
  run_id: string;
  pid: number;
  start_time_ms: number;
}

/** Reads the activity of every office. */
export async function readWorkActivity(
  db: SqlRunner,
  probe: ProcessProbe,
  tracker: WorkTracker,
  /** Now, from the injected clock. */
  now: number,
): Promise<WorkActivity> {
  const hosts = db.all<OpenHostRow>(
    "select office_id, run_id, pid, start_time_ms from worker_hosts where ended_at is null",
  );
  const live = new Set<string>();
  for (const host of hosts) {
    const key = `${host.office_id}/${host.run_id}`;
    if (live.has(key)) continue;
    if (isSameProcess({ pid: host.pid, startTimeMs: host.start_time_ms }, await probe(host.pid))) {
      live.add(key);
    }
  }
  const waiting =
    db.get<{ n: number }>(
      `select count(*) as n from claims c
        where c.released_at is null
          and c.claimed_at > $since
          and not exists (select 1 from worker_hosts h
                           where h.office_id = c.office_id and h.run_id = c.run_id)`,
      { since: now - CLAIM_START_WINDOW_MS },
    )?.n ?? 0;
  return { runs: live.size, verifies: tracker.verifies, waiting };
}
