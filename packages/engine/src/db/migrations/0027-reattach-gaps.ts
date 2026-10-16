// Migration 27 (DIPO-93): the re-attach gaps after a daemon restart.
//
// - `worker_hosts.pending`: 1 while the row was written before its host was spawned and the PID
//   is not known yet (`pid` and `start_time_ms` are 0 then). A restart that finds a pending row
//   reads the host's PID marker, or revokes its launch, so it never starts a second host.
// - `worker_hosts.signal_stop`: 1 when the host handles SIGTERM by stopping its worker and still
//   writing `exit.json`. Only such a host is ever stopped by signal when it is followed only; a
//   host an older binary started is 0 and is never signalled.
// - `runs.backstop_snapshot`: the DIPO-49 backstop's run-start snapshot as JSON, so a run
//   re-attached after a restart keeps its backstop. It is cleared when the run ends, because the
//   engine's own commit at the end (In Review, park) moves what it compares.

import type { SqlMigration } from "../migrations";

export const reattachGaps: SqlMigration = {
  version: 27,
  name: "re-attach gaps",
  sql: `
alter table worker_hosts add column pending integer not null default 0
  check (pending in (0, 1));
alter table worker_hosts add column signal_stop integer not null default 0
  check (signal_stop in (0, 1));
alter table runs add column backstop_snapshot text;
`,
};
