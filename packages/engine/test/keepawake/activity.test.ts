// Where keep-awake reads active work (DIPO-63 AC #1): a run with a live worker host, a running
// verify, and a confirmed batch whose claimed story has no worker yet, across every office of the
// state database. Liveness is PID plus start time through a fake probe. A claim without a host
// counts only within CLAIM_START_WINDOW_MS, so an orphan claim does not hold the assertion.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { openStateDatabase } from "../../src/db/database";
import { CLAIM_START_WINDOW_MS, readWorkActivity, WorkTracker } from "../../src/keepawake/index";
import type { ProcessProbe } from "../../src/platform/process";
import type { SqlRunner } from "../../src/platform/sqlite";
import { localMounts, memoryLogger } from "../db/helpers";

const OFFICE_A = "off_01JZ0000000000000000000001" as OfficeId;
const OFFICE_B = "off_01JZ0000000000000000000002" as OfficeId;
const START = 1_767_225_600_000;

/** PIDs below 200 are alive with start time START; 150 is a zombie. */
const probe: ProcessProbe = async (pid) =>
  pid < 200 ? { pid, startTimeMs: START, zombie: pid === 150, command: "dipo" } : null;

function host(
  db: SqlRunner,
  office: string,
  run: string,
  agent: string,
  pid: number,
  ended = false,
) {
  db.run(
    `insert into worker_hosts (office_id, run_id, agent_id, pid, start_time_ms, socket_path,
       protocol_version, run_dir, event_file, started_at, ended_at)
     values ($office, $run, $agent, $pid, $start, '/s', 1, '/d', '/e', 0, $ended)`,
    { office, run, agent, pid, start: START, ended: ended ? 1 : null },
  );
}

/** Claims are made at NOW unless `claimedAt` says otherwise. */
const NOW = 1_767_225_600_000;

function claim(
  db: SqlRunner,
  office: string,
  run: string,
  key: string,
  released: boolean,
  claimedAt: number = NOW,
) {
  db.run(
    `insert into claims (office_id, run_id, key, story_id, branch, worktree, base, base_sha,
       start_sha, reused, admin_dir, snap_commondir, snap_gitdir, snap_pointer, claimed_at,
       released_at)
     values ($office, $run, $key, 'X-1', $key, '/w', 'main', 'a', 'a', 0, '/a', 'c', 'g',
       'p', $at, $released)`,
    { office, run, key, at: claimedAt, released: released ? 1 : null },
  );
}

describe("readWorkActivity", () => {
  it("counts live hosts, running verifies and claims whose worker has not started", () =>
    withTempDir(async (dir) => {
      const clock = new ManualClock();
      const state = await openStateDatabase({
        stateDir: join(dir, "state"),
        logger: memoryLogger(),
        readMounts: localMounts,
        clock,
        engineVersion: "0.0.0-test",
      });
      try {
        const db = state.connection;
        const tracker = new WorkTracker();
        expect(await readWorkActivity(db, probe, tracker, NOW)).toEqual({
          runs: 0,
          verifies: 0,
          waiting: 0,
        });
        db.immediate(() => {
          for (const id of [OFFICE_A, OFFICE_B]) {
            db.run(
              `insert into offices (office_id, path, display_name, added_at, epoch, next_seq, replay_floor_seq)
               values ($id, $path, 'repo', 0, 'e', 1, 0)`,
              { id, path: `/repo/${id}` },
            );
          }
          // Live: run 1 in A (two agents, counted once) and run 1 in B.
          host(db, OFFICE_A, "run_1", "agt_1", 101);
          host(db, OFFICE_A, "run_1", "agt_2", 102);
          host(db, OFFICE_B, "run_1", "agt_1", 103);
          // Not live: ended, dead PID, zombie.
          host(db, OFFICE_A, "run_2", "agt_1", 104, true);
          host(db, OFFICE_A, "run_3", "agt_1", 500);
          host(db, OFFICE_B, "run_4", "agt_1", 150);
          // Waiting: a live claim with no host. Not waiting: one with a host, one released.
          claim(db, OFFICE_A, "run_9", "k9", false);
          claim(db, OFFICE_A, "run_1", "k1", false);
          claim(db, OFFICE_B, "run_8", "k8", true);
          // An orphan: claimed longer than the start window ago, still without a host.
          claim(db, OFFICE_B, "run_7", "k7", false, NOW - CLAIM_START_WINDOW_MS);
        });
        const endVerify = tracker.beginVerify();
        expect(await readWorkActivity(db, probe, tracker, NOW)).toEqual({
          runs: 2,
          verifies: 1,
          waiting: 1,
        });
        // The claim of run_9 holds only within the window too.
        expect(
          (await readWorkActivity(db, probe, tracker, NOW + CLAIM_START_WINDOW_MS - 1)).waiting,
        ).toBe(1);
        expect(
          (await readWorkActivity(db, probe, tracker, NOW + CLAIM_START_WINDOW_MS)).waiting,
        ).toBe(0);
        endVerify();
        endVerify();
        expect(tracker.verifies).toBe(0);
      } finally {
        state.close();
      }
    }));
});
