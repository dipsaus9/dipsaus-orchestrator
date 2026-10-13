// Migration 15 (DIPO-35): the office's backlog PRs and the stories a failed check blocks (0010
// section 2, lane b). `backlog_prs` holds each backlog-only PR the engine opened: its number, URL
// and branch, whether it is open, merged or closed, and the last structural check: the head it ran
// on, the base commit it diffed against (so a merge by hand is checked against the same base,
// whatever kind of merge the host made), passed or failed, every failure as JSON, and the keys of
// the tasks it touched.
// `backlog_pr_blocks` holds the stories a failed check on a merged PR blocks from `work.run` until a
// later backlog PR that touches them merges with a passing check (`cleared_at`).

import type { SqlMigration } from "../migrations";

export const backlogPrs: SqlMigration = {
  version: 15,
  name: "backlog_prs",
  sql: `
create table backlog_prs (
  office_id text not null references offices (office_id),
  pr_number integer not null,
  url text not null,
  branch text not null,
  title text not null,
  state text not null check (state in ('open', 'merged', 'closed')),
  checked_head text,
  checked_base text,
  check_state text not null check (check_state in ('pending', 'passed', 'failed')),
  failures text not null,
  touched text not null,
  opened_at integer not null,
  updated_at integer not null,
  checked_at integer,
  closed_at integer,
  primary key (office_id, pr_number)
) strict;

create index backlog_prs_by_state on backlog_prs (office_id, state, closed_at);

create table backlog_pr_blocks (
  office_id text not null references offices (office_id),
  key text not null,
  pr_number integer not null,
  failures text not null,
  blocked_at integer not null,
  cleared_at integer,
  cleared_by integer,
  primary key (office_id, key, pr_number)
) strict;

create index backlog_pr_blocks_open on backlog_pr_blocks (office_id, key, cleared_at);
`,
};
