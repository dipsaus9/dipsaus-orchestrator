// Shared setup for the executor, registry and change-log tests: a migrated state database on the
// manual clock, ids with deterministic randomness, and registered offices. The database is migrated
// once per test process and copied for each test (DIPO-225): the migrations ran in about 30 ms for
// every one of the many tests that open one.

import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { type IdSource, OfficeId } from "@dipsaus-orchestrator/contract";
import { makeTempDir, ManualClock } from "@dipsaus-orchestrator/testkit";

import { openStateDatabase, type StateDatabase } from "../../src/db/database";
import type { OfficeHandle } from "../../src/db/office";
import { createSystemIds } from "../../src/platform/ids";
import { localMounts, memoryLogger } from "../db/helpers";

/** Randomness that counts up, so ids repeat from run to run. */
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

function openWith(stateDir: string, clock: ManualClock): Promise<StateDatabase> {
  return openStateDatabase({
    stateDir,
    logger: memoryLogger(),
    readMounts: localMounts,
    clock,
    engineVersion: "0.0.0-test",
  });
}

let template: Promise<string> | undefined;

/**
 * A state folder migrated once in this test process on a fresh manual clock, so a copy holds what
 * a fresh migration on the test's own clock would. It sits next to the test process's own state
 * folder (`DIPO_HOME`, set by the test preload), which goes when the process ends.
 */
function migratedTemplate(): Promise<string> {
  template ??= (async () => {
    const home = process.env["DIPO_HOME"];
    const root = home !== undefined && existsSync(home) ? dirname(home) : makeTempDir();
    const stateDir = join(root, `state-template-${process.pid}`);
    const state = await openWith(stateDir, new ManualClock());
    state.close();
    return stateDir;
  })();
  return template;
}

export async function openTestState(dir: string): Promise<TestState> {
  const clock = new ManualClock();
  const fill = countingFill();
  const stateDir = join(dir, "state");
  // A reopen (a restart in the test) keeps the folder it finds.
  if (!existsSync(stateDir)) cpSync(await migratedTemplate(), stateDir, { recursive: true });
  const state = await openWith(stateDir, clock);
  return { state, clock, ids: createSystemIds(clock, fill), fill };
}

/** Registers an office row as `office.open` (DIPO-27) will, and returns its handle. */
export function addOffice(t: TestState, name = "demo"): OfficeHandle {
  const office = OfficeId.parse(t.ids.next("off"));
  t.state.connection.immediate(() =>
    t.state.connection.run(
      `insert into offices (office_id, path, display_name, added_at, next_seq)
       values ($office, $path, $name, $at, 1)`,
      { office, path: `/repos/${name}`, name, at: t.clock.now() },
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
