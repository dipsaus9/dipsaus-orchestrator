// Migration 25 (DIPO-88): whether a worker host's `exit_signal` was inferred. A worker that
// handles SIGTERM and exits with a code (Claude Code exits 143) reports no signal, so the host
// records the signal it sent last and marks it inferred in `exit.json` and the exit line; this
// column keeps that mark on the host's row. 1 only when `exit_signal` holds an inferred signal.

import type { SqlMigration } from "../migrations";

export const exitSignalInferred: SqlMigration = {
  version: 25,
  name: "exit signal inferred",
  sql: `
alter table worker_hosts add column exit_signal_inferred integer not null default 0
  check (exit_signal_inferred in (0, 1));
`,
};
