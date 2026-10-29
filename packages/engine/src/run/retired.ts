// Which runs the one retention rule may age out (0007, DIPO-354). A run ends done, parked or
// dropped (0020); until then it is open, also at In Review, where its active period has an end
// time. A parked run reopens on resume. So an end time alone is not enough: a run is retired once
// its active period ended before the cutoff and it ended done or dropped, or it ended parked and
// has no live claim and no open park left to bring it back.

/**
 * SQL true when the run `alias` (a `runs` row) is retired at `$cutoff`; never null, so its negation
 * holds for an active run (no end time) and an open one (no ending).
 */
export function retiredRun(alias: string): string {
  return `coalesce(${alias}.ended_at < $cutoff and (${alias}.end_kind in ('done', 'dropped')
    or (${alias}.end_kind = 'parked'
        and not exists (select 1 from claims c where c.office_id = ${alias}.office_id
          and c.run_id = ${alias}.run_id and c.released_at is null)
        and not exists (select 1 from parks p where p.office_id = ${alias}.office_id
          and p.run_id = ${alias}.run_id and p.resolved_at is null))), 0)`;
}

/**
 * SQL true when the row `alias` with a `run_id` belongs to no run that may still reopen: its run
 * is retired at `$cutoff`, or has no row any more.
 */
export function ofNoOpenRun(alias: string): string {
  return `not exists (select 1 from runs r where r.office_id = ${alias}.office_id
    and r.run_id = ${alias}.run_id and not ${retiredRun("r")})`;
}
