// Migration 6: proposed user stories on the desk (0020, 0022, DIPO-454). An idea that passed the
// audit waits on the desk until the maintainer answers it: `answer` is `accepted` (filed as a
// Backlog draft, `draft_id`) or `dismissed`, kept for retro. A draft that a triage session refines
// into a story is promoted to a task with a new id: `stories.promoted_to` holds that id until the
// index sees it, so the story keeps its key (`story.renumbered`) instead of being removed and found
// again as a new story. Worker proposals are held as ideas only (DIPO-452 held the open ones), so
// the `proposals` table goes; before it goes, every answer the maintainer gave a proposal (accepted
// with its draft, or dismissed) is carried to the idea of that proposal, matched by the id
// migration 3 gives it, so an answered proposal never comes back on the desk.

import { ideaIdOf, proposalIdeaText } from "../idea-ids";
import type { CodeMigration, MigrationContext } from "../migrations";

const COLUMNS = `
alter table ideas add column answer text check (answer in ('accepted', 'dismissed'));
alter table ideas add column answered_at integer;
alter table ideas add column draft_id text;

alter table stories add column promoted_to text;
`;

const DROP = `
drop index proposals_state;
drop table proposals;
`;

interface AnsweredProposal {
  office_id: string;
  run_id: string;
  title: string;
  story_line: string;
  why: string;
  paths: string;
  state: "accepted" | "dismissed";
  draft_id: string | null;
  updated_at: number;
}

/** Carries each answered proposal's answer to its idea, when that idea is held. */
function carryAnswers(db: MigrationContext): void {
  const answered = db.all<AnsweredProposal>(
    `select office_id, run_id, title, story_line, why, paths, state, draft_id, updated_at
       from proposals where state in ('accepted', 'dismissed') order by created_at, hash`,
  );
  for (const row of answered) {
    const paths = JSON.parse(row.paths) as string[];
    const text = proposalIdeaText(row.story_line, row.why, paths);
    db.run(
      `update ideas set answer = $answer, answered_at = $at, draft_id = $draft
        where office_id = $office_id and idea_id = $idea and answer is null`,
      {
        office_id: row.office_id,
        idea: ideaIdOf("proposal", row.run_id, row.title, text),
        answer: row.state,
        at: row.updated_at,
        draft: row.state === "accepted" ? row.draft_id : null,
      },
    );
  }
}

export const proposedStories: CodeMigration = {
  version: 6,
  name: "proposed stories",
  source: `${COLUMNS}
-- then every proposal accepted or dismissed: update ideas set answer = its state, answered_at = its
-- updated_at, draft_id = its draft_id (accepted only) where idea_id =
-- ideaIdOf('proposal', run_id, title, proposalIdeaText(story_line, why, paths)) and answer is null
${DROP}`,
  run: (db) => {
    db.exec(COLUMNS);
    carryAnswers(db);
    db.exec(DROP);
  },
};
