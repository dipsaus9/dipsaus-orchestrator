// The per-reason resume policy of `resumption.ts` (ADR 0020 sections 1 and 2, DIPO-138, DIPO-155):
// which command resumes a run standing still for a reason, and, for a park `work.resume` resumes,
// what the resume needs from the maintainer, which session follows, what its first message says
// and which grant a noted resume records. Code reads the park's cause, never its detail.
//
// - `PARK_RESUME_POLICY` is keyed by reason: `needs-permission` resumes through its question's
//   answer, `plan-limit` and `paused` (not parks) and every park reason with a matrix row through
//   `work.resume`, and `on-hold` (a park with no run) through the planning lane (DIPO-160).
// - `PARK_RESUME_MATRIX` is keyed by `reason/cause`, or by the reason alone for a row that holds
//   for every cause with no own row. A row either refuses (`notResumable`, `decisionRequired`) or
//   says how the resume goes. A reason or cause with no row is not resumed here: `work.resume`
//   answers `story.notPausedOrParked` for it, as before (a question park waits for DIPO-159's
//   answer). The box parks of a protected file, a secret, a refused part and a task file dipo
//   does not know are never resumable (maintainer decision, DIPO-155 review): `dipo discard`.
// - Box runs (0021 sections 6 and 7): every developer session of a box run is a new session in the
//   story's box with a handoff, never a native resume, so `developer` means a handoff there.

/** The command that resumes a run standing still for a reason. */
export type ResumeVia = "permission-answer" | "work.resume";

export interface ResumePolicyRow {
  readonly via: ResumeVia;
}

/** The park reasons `work.resume` resumes through the matrix (0020 section 2). */
const MATRIX_REASONS = [
  "stopped",
  "interrupted",
  "worker-failed",
  "verify-failing",
  "scope-violation",
  "review-blocked",
  "budget-exceeded",
  "conflict",
  "ambiguous-spec",
] as const;

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
  ...Object.fromEntries(MATRIX_REASONS.map((reason) => [reason, { via: "work.resume" }])),
};

/** The command that resumes a run standing still for `reason`, or null without a row. */
export function resumeVia(reason: string): ResumeVia | null {
  return Object.hasOwn(PARK_RESUME_POLICY, reason)
    ? (PARK_RESUME_POLICY[reason]?.via ?? null)
    : null;
}

/**
 * The session a resume starts (0020 section 1 step 5 and section 2):
 * - `developer`: the developer's native session when the 0014 section 6 checks pass, else a new
 *   session with a handoff (always a handoff for a box run);
 * - `handoff`: always a new developer session with a handoff;
 * - `review`: a fresh reviewer session of the same round on the same head, in the reviewer place;
 * - `fix-round`: back to In Review, then a fix round with the last verdict's blocking findings;
 * - `none`: no model session.
 */
export type ResumeSession = "developer" | "handoff" | "review" | "fix-round" | "none";

/**
 * The first message's delta before the note (0020 section 3): `resume` is `feedback/resume.md`
 * with the park's detail, `detail` the detail in `feedback/parked.md`, `verify-item` and `ci-item`
 * the run's last stored verify or CI feedback item (the detail when none was stored), `topup`
 * `feedback/topup.md` after the round's undelivered feedback, `none` nothing.
 */
export type ResumeDelta = "resume" | "detail" | "verify-item" | "ci-item" | "topup" | "none";

/**
 * The grant a resume records (0020 decision 6b and section 4): one more round of the limit that
 * fired, the reviewer's cap that fired grown by half (`reviewCap`), or all three developer caps
 * grown by half of the starting caps as one budget grant (`budgetHalf`, the `capped` row).
 */
export type ResumeGrantRule =
  | "loop"
  | "ciAttempt"
  | "conflictHandoff"
  | "reviewRound"
  | "reviewCap"
  | "budgetHalf";

/** A matrix row that resumes. */
export interface ParkResumeRow {
  readonly kind: "resume";
  /** Whether `work.resume` needs a note (decision 6a). */
  readonly note: "required" | "optional";
  readonly session: ResumeSession;
  readonly delta: ResumeDelta;
  /** The `why` of the session's notice and of `feedback/resume.md`; the park's detail otherwise. */
  readonly why?: string;
  readonly grant?: ResumeGrantRule;
  /** A `budget-exceeded` park: resumed only with a top-up (`budget`) and its why (section 4). */
  readonly topUp?: true;
  /** The git links are checked and a new backstop snapshot taken first (decision 7). */
  readonly gitCheck?: true;
  /** Refused while the adapter hold that caused it is set, naming the hold. */
  readonly holdCheck?: true;
  /**
   * The rest of the resume belongs to another story's port: the 0019 conflict hand-off
   * (`conflict`, DIPO-149), the merge slot (`slot`, DIPO-150) or a new story PR (`pr`).
   */
  readonly port?: "conflict" | "slot" | "pr";
}

/** A matrix row that refuses: never resumable, or resumed by a decision instead. */
export interface ParkRefusalRow {
  readonly kind: "refuse";
  readonly code: "resume.notResumable" | "resume.decisionRequired";
  /** A box part's park (0021 section 8) that the maintainer decided is never resumable. */
  readonly box?: true;
}

export type ParkMatrixRow = ParkResumeRow | ParkRefusalRow;

function optional(
  session: ResumeSession,
  delta: ResumeDelta,
  extra: Partial<Omit<ParkResumeRow, "kind" | "note" | "session" | "delta">> = {},
): ParkResumeRow {
  return { kind: "resume", note: "optional", session, delta, ...extra };
}

function required(
  session: ResumeSession,
  delta: ResumeDelta,
  extra: Partial<Omit<ParkResumeRow, "kind" | "note" | "session" | "delta">> = {},
): ParkResumeRow {
  return { kind: "resume", note: "required", session, delta, ...extra };
}

/**
 * The resume matrix (0020 section 2 and its 2026-10-19 amendment), keyed by `reason/cause`, or by
 * the reason for a row that holds for every cause with no own row.
 */
export const PARK_RESUME_MATRIX: Readonly<Record<string, ParkMatrixRow>> = {
  "stopped/maintainer": optional("developer", "resume", { why: "the maintainer stopped it" }),
  "stopped/review": optional("review", "none"),
  "stopped/pr-closed": optional("none", "none", { port: "pr" }),
  interrupted: optional("developer", "resume"),
  "worker-failed/review": optional("review", "none"),
  "worker-failed/review-cap": optional("review", "none", { grant: "reviewCap" }),
  "worker-failed": optional("developer", "resume", { holdCheck: true }),
  "verify-failing/refused": optional("developer", "resume"),
  "verify-failing/loops": required("developer", "verify-item", { grant: "loop" }),
  "verify-failing/ci": required("developer", "ci-item", { grant: "ciAttempt" }),
  "verify-failing/capped": required("developer", "detail", { grant: "budgetHalf" }),
  "scope-violation/paths": required("developer", "detail"),
  "scope-violation/tampered": { kind: "refuse", code: "resume.notResumable" },
  // The box parks (0021 section 8): never resumable, by the maintainer's decision.
  "scope-violation/protected-file": { kind: "refuse", code: "resume.notResumable", box: true },
  "scope-violation/secret": { kind: "refuse", code: "resume.notResumable", box: true },
  "scope-violation/part-refused": { kind: "refuse", code: "resume.notResumable", box: true },
  "scope-violation/task-file": { kind: "refuse", code: "resume.notResumable", box: true },
  "scope-violation/backstop": required("handoff", "detail", { gitCheck: true }),
  "scope-violation/hand-change": required("handoff", "detail", { gitCheck: true }),
  "review-blocked/rounds": required("fix-round", "none", { grant: "reviewRound" }),
  "budget-exceeded/review": required("review", "none", { topUp: true }),
  "budget-exceeded": required("developer", "topup", { topUp: true }),
  "conflict/merge-in-progress": required("developer", "none", {
    grant: "conflictHandoff",
    port: "conflict",
  }),
  "conflict/unwritable-path": required("developer", "none", { port: "conflict" }),
  "conflict/push-rejected": required("developer", "none", { port: "conflict" }),
  "conflict/slot-refused": required("none", "none", { port: "slot" }),
  "ambiguous-spec/no-report": required("handoff", "none"),
  "ambiguous-spec/rule-conflict": required("developer", "detail"),
  "needs-permission": { kind: "refuse", code: "resume.decisionRequired" },
};

/** The matrix row of a park's reason and cause, or null when `work.resume` has none for it. */
export function parkResumeRow(reason: string, cause: string | null): ParkMatrixRow | null {
  const exact = cause === null ? undefined : `${reason}/${cause}`;
  if (exact !== undefined && Object.hasOwn(PARK_RESUME_MATRIX, exact)) {
    return PARK_RESUME_MATRIX[exact] ?? null;
  }
  return Object.hasOwn(PARK_RESUME_MATRIX, reason) ? (PARK_RESUME_MATRIX[reason] ?? null) : null;
}
