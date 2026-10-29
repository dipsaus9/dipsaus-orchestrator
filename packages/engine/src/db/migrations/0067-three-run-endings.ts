// Migration 67 (DIPO-373): a run ends done, parked or dropped (0020), and a run at In Review is not
// ended: it stays open, in phase review, test or merge, until its story is Done.
//
// - Phases first. A story run with a live claim that ended `in-review` waits for its review: it
//   enters phase `review` at its end, unless it is in it. One that ended `reviewed` is past its
//   review: from phase `review` it enters `merge` when its latest verdict is approved or
//   overridden, else `build` (a blocked verdict waits for its fix round). This holds for such a
//   run whose story parked meanwhile too, so a resume with no session lifts it into that phase.
// - `runs.end_kind` holds the ending. A session run ends done when it answered, dropped otherwise.
//   A story run: `done` stays done; a released claim ends it done when it was released as done or
//   done elsewhere, dropped otherwise (drop, discard, a failed start, an orphaned or rolled-back
//   claim); an open park ends it parked; `in-review` and `reviewed` become open (null), keeping
//   `ended_at`; `reconciled` follows the story's status (Done done, Parked parked, else dropped);
//   every other kind was a park's (`capped`, `blocked`, `stopped`, ...) and ends it parked.
// - `run_outcomes` keeps one row per ended run, its `outcome` the ending. The provisional row of a
//   run that is open again goes; a row whose run is gone maps by its outcome (done, reconciled,
//   answered and done elsewhere done; parked parked; anything else dropped, since its run's fate is
//   not known any more). A done row is final. `end_kind` goes: the outcome says it.

import type { SqlMigration } from "../migrations";

/** SQL: the newest phase of the run aliased `r`. */
const PHASE = `(select s.value from run_steps s where s.office_id = r.office_id
  and s.run_id = r.run_id and s.kind = 'phase' order by s.step desc limit 1)`;

/** SQL: the run aliased `r` has a live claim. */
const LIVE_CLAIM = `exists (select 1 from claims c where c.office_id = r.office_id
  and c.run_id = r.run_id and c.released_at is null)`;

/** SQL: the next step number of the run aliased `r`. */
const NEXT_STEP = `(select coalesce(max(s.step), 0) + 1 from run_steps s
  where s.office_id = r.office_id and s.run_id = r.run_id)`;

export const threeRunEndings: SqlMigration = {
  version: 67,
  name: "three run endings",
  sql: `
insert into run_steps (office_id, run_id, step, kind, value, at)
  select r.office_id, r.run_id, ${NEXT_STEP}, 'phase', 'review', r.ended_at from runs r
   where r.kind = 'story' and r.end_kind = 'in-review' and r.ended_at is not null
     and ${LIVE_CLAIM} and coalesce(${PHASE}, '') <> 'review';

insert into run_steps (office_id, run_id, step, kind, value, at)
  select r.office_id, r.run_id, ${NEXT_STEP}, 'phase',
      coalesce((select case when v.verdict = 'blocked' and v.override_at is null then 'build'
          else 'merge' end from review_verdicts v
          where v.office_id = r.office_id and v.run_id = r.run_id
          order by v.decided_at desc, v.rowid desc limit 1), 'merge'),
      r.ended_at
    from runs r
   where r.kind = 'story' and r.end_kind = 'reviewed' and r.ended_at is not null
     and ${LIVE_CLAIM} and ${PHASE} = 'review';

update runs set end_kind = case
    when kind = 'session' then case when end_kind = 'answered' then 'done' else 'dropped' end
    when end_kind = 'done' then 'done'
    when exists (select 1 from claims c where c.office_id = runs.office_id
        and c.run_id = runs.run_id and c.released_at is not null
        and c.release_reason in ('done', 'done-elsewhere')) then 'done'
    when exists (select 1 from claims c where c.office_id = runs.office_id
        and c.run_id = runs.run_id and c.released_at is not null) then 'dropped'
    when exists (select 1 from parks p where p.office_id = runs.office_id
        and p.run_id = runs.run_id and p.resolved_at is null) then 'parked'
    when end_kind in ('in-review', 'reviewed') then null
    when end_kind = 'reconciled' then
      case (select m.status from backlog_mirror m where m.office_id = runs.office_id
          and m.key = runs.key and m.kind = 'task')
        when 'Done' then 'done' when 'Parked' then 'parked' else 'dropped' end
    else 'parked'
  end
  where end_kind is not null;

delete from run_outcomes where final = 0 and exists (select 1 from runs r
  where r.office_id = run_outcomes.office_id and r.run_id = run_outcomes.run_id
    and r.end_kind is null);
update run_outcomes set outcome = coalesce(
    (select r.end_kind from runs r where r.office_id = run_outcomes.office_id
      and r.run_id = run_outcomes.run_id),
    case when outcome in ('done', 'reconciled', 'answered', 'done-elsewhere') then 'done'
      when outcome = 'parked' then 'parked' else 'dropped' end);
update run_outcomes set final = 1 where outcome = 'done';
alter table run_outcomes drop column end_kind;
`,
};
