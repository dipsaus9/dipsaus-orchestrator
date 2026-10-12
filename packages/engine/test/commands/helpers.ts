// Shared setup for the executor, registry and change-log tests: a migrated state database on the
// manual clock, ids with deterministic randomness, and registered offices.

import { join } from "node:path";

import { type IdSource, OfficeId } from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import { newLogState } from "../../src/changelog/log";
import { openStateDatabase, type StateDatabase } from "../../src/db/database";
import type { OfficeHandle } from "../../src/db/office";
import { createSystemIds } from "../../src/platform/ids";
import { localMounts, memoryLogger } from "../db/helpers";

/** Randomness that counts up, so ids and epochs repeat from run to run. */
export function countingFill(): (bytes: Uint8Array) => void {
  let n = 0;
  return (bytes) => {
    for (let i = 0; i < bytes.length; i++) bytes[i] = (n + i) & 0xff;
    n += 1;
  };
}

export interface TestState {
  readonly state: StateDatabase;
  readonly clock: ManualClock;
  readonly ids: IdSource;
  readonly fill: (bytes: Uint8Array) => void;
}

export async function openTestState(dir: string): Promise<TestState> {
  const clock = new ManualClock();
  const fill = countingFill();
  const state = await openStateDatabase({
    stateDir: join(dir, "state"),
    logger: memoryLogger(),
    readMounts: localMounts,
    clock,
    engineVersion: "0.0.0-test",
  });
  return { state, clock, ids: createSystemIds(clock, fill), fill };
}

/** Registers an office row as `office.open` (DIPO-27) will, and returns its handle. */
export function addOffice(t: TestState, name = "demo"): OfficeHandle {
  const office = OfficeId.parse(t.ids.next("off"));
  const log = newLogState(t.fill);
  t.state.connection.immediate(() =>
    t.state.connection.run(
      `insert into offices (office_id, path, display_name, added_at, epoch, next_seq, replay_floor_seq)
       values ($office, $path, $name, $at, $epoch, $next, $floor)`,
      {
        office,
        path: `/repos/${name}`,
        name,
        at: t.clock.now(),
        epoch: log.epoch,
        next: log.nextSeq,
        floor: log.replayFloorSeq,
      },
    ),
  );
  return t.state.office(office);
}

/** A table of test facts; office-scoped like every real fact table. */
export function createFactTable(t: TestState): void {
  t.state.connection.immediate(() =>
    t.state.connection.exec(
      "create table facts (office_id text not null, n integer not null, note text not null, primary key (office_id, n)) strict",
    ),
  );
}

export function countRows(office: OfficeHandle, table: string): number {
  return (
    office.get<{ n: number }>(`select count(*) as n from ${table} where office_id = $office_id`)
      ?.n ?? 0
  );
}
