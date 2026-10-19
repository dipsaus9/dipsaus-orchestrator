// Migration 37 (DIPO-164): the web calls of a run, counted by tool (0020 section 11b).
//
// `runs.web_searches` and `runs.web_fetches` count the run's WebSearch and WebFetch calls as the
// worker's tool activity shows them, a call the PreToolUse hook refused included; they live on the
// run so the retention tier of `runs` covers them. `run_outcomes.web_searches` and
// `run_outcomes.web_fetches` copy them when the run ends, so retro reads how much research a story
// took. A run from before this migration has 0 and 0.

import type { SqlMigration } from "../migrations";

export const webCalls: SqlMigration = {
  version: 37,
  name: "web call counts",
  sql: `
alter table runs add column web_searches integer not null default 0;
alter table runs add column web_fetches integer not null default 0;
alter table run_outcomes add column web_searches integer not null default 0;
alter table run_outcomes add column web_fetches integer not null default 0;
`,
};
