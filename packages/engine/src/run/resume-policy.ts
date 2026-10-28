// The resume table of 0020: per park reason, what `work.resume` requires and what the first
// message of the next session says. The reason is the only thing it reads; a park's detail is text
// no code decides from.
//
// | Reason            | Resume requires                                | First message                  |
// |-------------------|------------------------------------------------|--------------------------------|
// | `ambiguous-spec`  | the answer: `--note`, or `dipo answer --text`  | the question and the answer    |
// | `review-blocked`  | `--note` with a direction (or `dipo approve`)  | the blocking findings          |
// | `budget-exceeded` | `--budget` and `--note`                        | the raised budget              |
// | `verify-failing`  | nothing                                        | the last red check or verify   |
// | `conflict`        | nothing                                        | the conflicting paths          |
// | `scope-violation` | not resumable: `dipo discard`                  | none                           |
// | `by-maintainer`   | nothing                                        | "resumed by the maintainer"    |
// | `worker-failed`   | nothing                                        | the last error                 |
//
// The maintainer's note follows the reason's message. Which session the resume starts comes from
// the run's own facts (`resumeSession`), never from the park's detail.

/** What `work.resume` needs for a park: a resume, or a refusal. */
export type ResumeNeed =
  | {
      readonly kind: "resume";
      /** `answer`: the note is the answer of the park's question, which may be held already. */
      readonly note: "required" | "optional" | "answer";
      /** A `budget-exceeded` park resumes only with a top-up (`--budget`). */
      readonly budget?: true;
    }
  | { readonly kind: "refuse"; readonly code: "resume.notResumable" };

/**
 * The first message's part before the note: `answer` the park's question and the answer,
 * `findings` the last verdict's blocking findings (a fix round), `topup` the raised budget,
 * `check` the last red check or verify output, `conflict` what the conflict hand-off prepares,
 * `maintainer` that the maintainer resumed it, `detail` the park's detail as the last error.
 */
export type ResumeDelta =
  | "answer"
  | "findings"
  | "topup"
  | "check"
  | "conflict"
  | "maintainer"
  | "detail";

interface ResumeRow {
  readonly need: ResumeNeed;
  readonly delta: ResumeDelta;
}

/** The share a top-up the desk and the refusals suggest grows the caps by. */
export const SUGGESTED_SHARE = 50;

const OPTIONAL: ResumeNeed = { kind: "resume", note: "optional" };

/** The table of 0020, one row per reason of 0001. */
export const RESUME_TABLE: Readonly<Record<string, ResumeRow>> = {
  "ambiguous-spec": { need: { kind: "resume", note: "answer" }, delta: "answer" },
  "review-blocked": { need: { kind: "resume", note: "required" }, delta: "findings" },
  "budget-exceeded": {
    need: { kind: "resume", note: "required", budget: true },
    delta: "topup",
  },
  "verify-failing": { need: OPTIONAL, delta: "check" },
  conflict: { need: OPTIONAL, delta: "conflict" },
  "scope-violation": { need: { kind: "refuse", code: "resume.notResumable" }, delta: "detail" },
  "by-maintainer": { need: OPTIONAL, delta: "maintainer" },
  "worker-failed": { need: OPTIONAL, delta: "detail" },
};

const FALLBACK = "worker-failed";

/**
 * The row of a reason. A reason outside the eight (a park record written by hand in Backlog.md)
 * resumes as `worker-failed` does: nothing is required, and its detail is the first message.
 */
export function resumeRow(reason: string): ResumeRow {
  return (
    (Object.hasOwn(RESUME_TABLE, reason) ? RESUME_TABLE[reason] : undefined) ??
    (RESUME_TABLE[FALLBACK] as ResumeRow)
  );
}

/** What `work.resume` needs for a park of `reason`. */
export function parkResumeNeed(reason: string): ResumeNeed {
  return resumeRow(reason).need;
}

/**
 * The session a resume starts:
 * - `developer`: a new developer session of the same run in the story's box, with a handoff;
 * - `review`: a fresh reviewer session of the same round on the same head;
 * - `fix-round`: back to In Review, then a fix round with the last verdict's blocking findings;
 * - `none`: no session; the story waits In Review again.
 */
export type ResumeSession = "developer" | "review" | "fix-round" | "none";

/** The run facts the session of a resume follows from. */
export interface ResumeFacts {
  /** The run's last session was the reviewer, and the park stopped it (0020, 0002). */
  readonly reviewerStopped: boolean;
  /**
   * The run waited In Review when it parked (no session was live): the park did not end it, so its
   * end kind is still the one of a run waiting for its review or merge.
   */
  readonly waitingInReview: boolean;
}

/**
 * The session a resume of `reason` starts (0020): a `review-blocked` park returns through a fix
 * round with its findings; a park that stopped the reviewer (its budget, a failed reviewer session
 * or the maintainer) starts a fresh review of the same head; a story the maintainer parked while
 * it waited In Review waits there again (0002: a PR closed on GitHub gets a new PR); every other
 * resume is a new developer session.
 */
export function resumeSession(reason: string, facts: ResumeFacts): ResumeSession {
  if (reason === "review-blocked") return "fix-round";
  const stoppable =
    reason === "budget-exceeded" || reason === "worker-failed" || reason === "by-maintainer";
  if (stoppable && facts.reviewerStopped) return "review";
  if (reason === "by-maintainer" && facts.waitingInReview) return "none";
  return "developer";
}
