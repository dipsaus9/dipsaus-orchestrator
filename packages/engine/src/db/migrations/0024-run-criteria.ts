// Migration 24 (DIPO-85): the acceptance criteria a story run knows and the ones its worker
// report marks met (0007 section 4, 0008 section 3: the report feeds `work.progress`).
//
// `criteria_known` lists the criterion numbers the story had when the run started and
// `criteria_checked` the ones already checked then, both as JSON arrays of numbers. Each turn
// report the engine accepts replaces `criteria_reported` with the numbers it marks met; it is null
// before the first report. `backlog_mirror.criteria_numbers` keeps the story's current criterion
// numbers as the index last read them. The run's `Progress.criteriaMet` counts checked and
// reported together among those current numbers, so it moves while the run is live instead of
// waiting for the merge to reach the base index, and a removed or renumbered criterion never
// counts. Older runs keep nulls and read their count from `backlog_mirror` as before.

import type { SqlMigration } from "../migrations";

export const runCriteria: SqlMigration = {
  version: 24,
  name: "run criteria",
  sql: `
alter table runs add column criteria_known text;
alter table runs add column criteria_checked text;
alter table runs add column criteria_reported text;
alter table backlog_mirror add column criteria_numbers text;
`,
};
