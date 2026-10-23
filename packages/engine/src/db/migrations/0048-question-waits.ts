// Migration 48 (DIPO-159): the live wait of a worker's question (0020 section 7, 0021 section 11).
//
// `questions.wait_until` is when the live wait of a worker question asked while a TUI was connected
// ends (`asked_at` plus `timeouts.questionWaitMinutes`): the desk shows the time left from it, and
// the run's minute cap leaves the wait out. Null for a question never asked live (a permission
// question, or a question its park asked).
//
// The trigger closes, as `expired`, every open question a park carried once that park is resolved
// in any way (resume, drop, discard, reconcile, done elsewhere, override): such a question waits for
// nothing any more. A resume that answers its park's question closes it as `answered` first, in
// the same transaction, so the trigger finds it closed.

import type { SqlMigration } from "../migrations";

export const questionWaits: SqlMigration = {
  version: 48,
  name: "question waits",
  sql: `
alter table questions add column wait_until integer;

create trigger questions_expire_with_park after update of resolved_at on parks
when old.resolved_at is null and new.resolved_at is not null
begin
  update questions set closed_at = new.resolved_at, closed_how = 'expired'
   where office_id = new.office_id and park_id = new.park_id and closed_at is null;
end;
`,
};
