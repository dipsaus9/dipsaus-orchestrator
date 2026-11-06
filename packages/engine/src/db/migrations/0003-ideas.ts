// Migration 3: incoming ideas (0022, DIPO-452). One row per idea, with its origin (a worker's
// proposal, a reviewer's advisory finding, a planning session's aside or a quick idea), its source
// story and run, and its audit: held until code or the audit session decides it, then passed with
// a proposed user story or rejected with its reason. Every worker proposal still open on the desk
// is held as an idea of its run, so it is audited once; the proposal itself stays on the desk.

import { ideaIdOf, proposalIdeaText } from "../idea-ids";
import type { CodeMigration, MigrationContext } from "../migrations";

const TABLE = `
create table ideas (
  office_id text not null references offices (office_id),
  idea_id text not null,
  origin text not null check (origin in ('proposal', 'finding', 'aside', 'quick')),
  story_key text,
  run_id text,
  title text not null,
  body text not null,
  state text not null default 'held' check (state in ('held', 'passed', 'rejected')),
  decided_by text check (decided_by in ('code', 'audit')),
  reason text,
  proposal text,
  attempts integer not null default 0 check (attempts >= 0),
  last_problem text,
  audit_run_id text,
  created_at integer not null,
  updated_at integer not null,
  decided_at integer,
  primary key (office_id, idea_id),
  check ((state = 'held') = (decided_by is null)),
  check ((state = 'passed') = (proposal is not null)),
  check ((state = 'rejected') = (reason is not null))
) strict;

create index ideas_state on ideas (office_id, state, created_at);
`;

interface OpenProposal {
  office_id: string;
  story_key: string;
  run_id: string;
  title: string;
  story_line: string;
  why: string;
  paths: string;
  created_at: number;
}

function holdOpenProposals(db: MigrationContext): void {
  const open = db.all<OpenProposal>(
    `select office_id, story_key, run_id, title, story_line, why, paths, created_at
       from proposals where state = 'open' order by created_at, hash`,
  );
  for (const row of open) {
    const paths = JSON.parse(row.paths) as string[];
    const text = proposalIdeaText(row.story_line, row.why, paths);
    db.run(
      `insert into ideas (office_id, idea_id, origin, story_key, run_id, title, body, created_at,
         updated_at)
       values ($office_id, $idea, 'proposal', $key, $run, $title, $body, $at, $at)
       on conflict (office_id, idea_id) do nothing`,
      {
        office_id: row.office_id,
        idea: ideaIdOf("proposal", row.run_id, row.title, text),
        key: row.story_key,
        run: row.run_id,
        title: row.title.trim(),
        body: text,
        at: row.created_at,
      },
    );
  }
}

export const ideas: CodeMigration = {
  version: 3,
  name: "ideas",
  source: `${TABLE}
-- then every open proposal: insert into ideas (origin 'proposal', its story key and run, its title,
-- its Story line, why and paths as the text, its time), idea_id = ideaIdOf('proposal', run, title, text)`,
  run: (db) => {
    db.exec(TABLE);
    holdOpenProposals(db);
  },
};
