// Migration 60 (DIPO-361): every message dipo sends a developer session is one `steer` intent of
// the one feedback path (0002), with the detail `feedback <source> <key> <text>`, where `text` is
// the message as the worker reads it. The three tags it replaces become it:
//
// | Old detail                          | New detail                                              |
// |-------------------------------------|---------------------------------------------------------|
// | `maintainer-steer <request> <text>` | `feedback steer <request> The maintainer says: <text>`  |
// | `held-feedback <text>`              | `feedback resume - <text>`                              |
// | `report-feedback <agent> <why>`     | `feedback report <agent> <the report correction text>`  |
//
// So a steer or a held note stored before the upgrade still goes with the next session's first
// message, a retried steer request still finds its steer, and a run's one report correction is
// still counted. The wrapped texts are those of `feedback/steer.md` and `feedback/report.md` as
// they were on 2026-10-28.

import type { SqlMigration } from "../migrations";

export const oneFeedbackTag: SqlMigration = {
  version: 60,
  name: "one feedback tag",
  sql: `
update run_intents
   set detail = case
     when instr(substr(detail, 18), ' ') = 0
       then 'feedback steer ' || substr(detail, 18) || ' The maintainer says: '
     else 'feedback steer '
       || substr(substr(detail, 18), 1, instr(substr(detail, 18), ' ') - 1)
       || ' The maintainer says: '
       || substr(substr(detail, 18), instr(substr(detail, 18), ' ') + 1)
   end
 where kind = 'steer' and detail like 'maintainer-steer %';

update run_intents
   set detail = 'feedback resume - ' || substr(detail, 15)
 where kind = 'steer' and detail like 'held-feedback %';

update run_intents
   set detail = case
     when instr(substr(detail, 17), ' ') = 0
       then 'feedback report ' || substr(detail, 17) || ' Your last turn ended without a valid report: .'
         || char(10) || 'Return the report in the schema now, through the structured output: status, criteria with evidence, summary and commit subject. Do not change files for it.'
     else 'feedback report '
       || substr(substr(detail, 17), 1, instr(substr(detail, 17), ' ') - 1)
       || ' Your last turn ended without a valid report: '
       || substr(substr(detail, 17), instr(substr(detail, 17), ' ') + 1) || '.'
       || char(10) || 'Return the report in the schema now, through the structured output: status, criteria with evidence, summary and commit subject. Do not change files for it.'
   end
 where kind = 'steer' and detail like 'report-feedback %';
`,
};
