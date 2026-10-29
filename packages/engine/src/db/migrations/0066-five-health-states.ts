// Migration 66 (DIPO-352): health is one of five states and the watchdog facts behind it are its
// evidence (0009), and the phase `verify` is gone (0002).
//
// - `run_signals` keeps only the evidence words. `quiet` and `no-output` were two signals for one
//   fact, no output; they become one `no-output` row, and `stuck_at` says when the stall wait
//   passed (null while the run is only quiet). An old `no-output` row was raised at the stall wait,
//   so it is stuck from its `since`. A `quiet` row in effect next to a `no-output` row in effect is
//   dropped, so a run has at most one such row in effect; any other `quiet` row becomes
//   `no-output`, unless a `no-output` row with the same key exists. `input-wait` rows (a live
//   question, which shows no health of its own) go. A `plan-limit` row stays for the office load
//   that parks a run held before DIPO-359 (`run/outcome-restart.ts`).
// - A `phase` step `verify` becomes `build`: verify runs in the box at the end of `build`.

import type { SqlMigration } from "../migrations";

export const fiveHealthStates: SqlMigration = {
  version: 66,
  name: "five health states",
  sql: `
alter table run_signals add column stuck_at integer;
update run_signals set stuck_at = since where signal = 'no-output';
delete from run_signals
  where signal = 'quiet' and cleared_at is null and exists (
    select 1 from run_signals other
      where other.office_id = run_signals.office_id and other.run_id = run_signals.run_id
        and other.signal = 'no-output' and other.cleared_at is null);
update or ignore run_signals set signal = 'no-output' where signal = 'quiet';
delete from run_signals where signal in ('quiet', 'input-wait');

update run_steps set value = 'build' where kind = 'phase' and value = 'verify';
`,
};
