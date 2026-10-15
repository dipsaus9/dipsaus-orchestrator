// Migration 23 (DIPO-75): the permission question of a `needs-permission` park (0008 section 5).
//
// A story parked `needs-permission` carries a permission question (`kind` permission, `tool` and
// `input` the recorded tool and action, `hook` null since no hook call waits) whose `park_id`
// names the park it belongs to; a question asked through a waiting hook call has none. The
// maintainer answers it with `work.answer` and a decision, which resumes the run's session. An
// allow lets through, for that run only, the first permission request whose tool and exact
// command or path equal the recorded ones: `allow_used_at` is when that request came, so the
// allow is spent and never matches again. Nothing is kept as a rule or for later runs; the row
// leaves with its run (tier S retention, as migration 22).
//
// `runs.parked_ms` is the time a run stood parked before such an answer reopened it, summed over
// its parks: the run's caps and its `run_outcomes.minutes` count the time it worked, not these.

import type { SqlMigration } from "../migrations";

export const parkQuestions: SqlMigration = {
  version: 23,
  name: "park questions",
  sql: `
alter table questions add column park_id integer;
alter table questions add column allow_used_at integer;
alter table runs add column parked_ms integer not null default 0;

create index questions_allow_once on questions (office_id, run_id)
  where park_id is not null and decision = 'allow' and allow_used_at is null;
`,
};
