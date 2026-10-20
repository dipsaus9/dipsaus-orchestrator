// The per-reason resume policy of `resumption.ts` (ADR 0020 section 1, DIPO-138): which command
// resumes a run standing still for a reason. The rows of M0 are `needs-permission` (the
// permission answer) and `plan-limit` (`work.resume` of the held run), and `on-hold` (`work.resume`
// of a park with no run, DIPO-160); later rows extend this
// table, not the run outcomes.

/** The command that resumes a run standing still for a reason. */
export type ResumeVia = "permission-answer" | "work.resume";

export interface ResumePolicyRow {
  readonly via: ResumeVia;
}

/**
 * The per-reason resume policy. Keyed by the park reason; a run held by a plan limit is not parked
 * and stands under the reason `plan-limit`. A reason with no row cannot be resumed here yet.
 */
export const PARK_RESUME_POLICY: Readonly<Record<string, ResumePolicyRow>> = {
  "needs-permission": { via: "permission-answer" },
  "plan-limit": { via: "work.resume" },
  // A run the maintainer paused (0020 section 9, DIPO-163): not a park, like `plan-limit`.
  paused: { via: "work.resume" },
  // A park without a run: the planning lane lifts it (0020 section 8, DIPO-160).
  "on-hold": { via: "work.resume" },
};

/** The command that resumes a run standing still for `reason`, or null without a row. */
export function resumeVia(reason: string): ResumeVia | null {
  return Object.hasOwn(PARK_RESUME_POLICY, reason)
    ? (PARK_RESUME_POLICY[reason]?.via ?? null)
    : null;
}
