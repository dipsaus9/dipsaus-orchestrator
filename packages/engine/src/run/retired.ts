// Which runs the one retention rule may age out (0007, DIPO-354). A run's `ended_at` is also set
// at a park, at In Review and after a review, and such a run reopens later (0020), so an end time
// alone is not enough: a run is retired once it ended before the cutoff and is done, or has no live
// claim and no open park left to bring it back.

/** SQL true when the run `alias` (a `runs` row) is retired at `$cutoff`. */
export function retiredRun(alias: string): string {
  return `(${alias}.ended_at < $cutoff and (${alias}.end_kind = 'done'
    or (not exists (select 1 from claims c where c.office_id = ${alias}.office_id
          and c.run_id = ${alias}.run_id and c.released_at is null)
        and not exists (select 1 from parks p where p.office_id = ${alias}.office_id
          and p.run_id = ${alias}.run_id and p.resolved_at is null))))`;
}

/**
 * SQL true when the row `alias` with a `run_id` belongs to no run that may still reopen: its run
 * is retired at `$cutoff`, or has no row any more.
 */
export function ofNoOpenRun(alias: string): string {
  return `not exists (select 1 from runs r where r.office_id = ${alias}.office_id
    and r.run_id = ${alias}.run_id and not ${retiredRun("r")})`;
}
