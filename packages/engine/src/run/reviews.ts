// Review rounds (0019 sections 4, 6 and 12, DIPO-219): a story that reaches In Review gets its
// review in the office's reviewer place, its report is judged by code and its verdict stored by
// code tree key.
//
// - Start. A pending review (`pendingReviews`, fed to the places as `PlacesDeps.pending`) starts
//   through the review starter (`START_KINDS.review`) once the reviewer place is free, oldest In
//   Review first. The starter reads the head's code tree key first: a tree that already has a
//   verdict in the claim takes it without a round (commits that change only the task file never
//   start a review). Otherwise the run reopens for the review (phase `review`, at the start time,
//   while its wait counts from the In Review time), takes the reviewer place, starts or continues
//   its review round (`beginReviewRound`: a new round writes its `review` step, which grows no cap;
//   a fresh session after a failed one adds nothing) and starts a fresh
//   reviewer session with the review task message (`ReviewSessions`).
// - Report. A turn's report valid against the review schema is validated by code
//   (`validateReport`). An invalid report gets one correction turn in the same session
//   (`feedback/review-report.md`); still invalid, the session ends as a crash. Blocking findings
//   whose evidence fails get one correction turn naming them (`feedback/review-evidence.md`);
//   still failing, they are kept as advisory, marked unverified. The verdict is computed
//   (`judgeReview`) and stored as a review gate with its `review_verdicts` row (`gate.decided`); a
//   blocked verdict appends a `review-failed` step. The review period ends (`reviewed`) and the
//   session's stdin is closed. The failed round that reaches the run's review round cap parks
//   `review-blocked` with the blocking findings as detail instead.
// - Failures (section 4). The reviewer's own turn or minute cap parks `worker-failed` (run
//   control), and a worktree the review changed `scope-violation` (the finisher's backstop after
//   each turn). A resume of a park that stopped the reviewer starts a fresh review. A crash, a host
//   lost, or a report still invalid after its correction turn ends the agent `review-crashed` and
//   starts one fresh session for the same round; a second failure in the round parks
//   `worker-failed` with the reviewer's last error. The story's budget used up parks
//   `budget-exceeded` (run control). A plan limit stops the session and never parks: the review
//   waits for its place again, which the hold pauses until the reset, and a fresh session starts
//   then. A start failure or a refused launch check holds the adapter with an `engine.notice`; the
//   story stays In Review and the review waits. A launch plan that refuses the session (a
//   `PlanError`) raises the `run.planRefused` notice with `planRefusedText`, as the worker's launch
//   does, once per run and refusal (DIPO-247).
// - Done on the base (DIPO-239). The starter reads the story on the office base before it reopens
//   anything; a story Done there gets no round and no session: the run ends done (`#doneOnBase`)
//   with one `review.doneOnBase` notice, and the claim is left to reconcile's done-on-base release.
// - Caps (DIPO-247). The reviewer's turn and minute caps are the run's start snapshot; a run that
//   has none takes the office's current ones at its first review start (`snapshotReviewCaps`).
// - After the verdict. Once a reviewer session's exit is decided and its verdict or park ended the
//   review period, `onReviewed` hears it: the head's fix round decides then (DIPO-148).

import type { Clock, IdSource, OfficeId, RunId, StoryKey } from "@dipsaus-orchestrator/contract";

import { appendEntries, type NewEntry } from "../changelog/log";
import type { OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import type { IngestedExit } from "../ingest/ingestor";
import { reviewEvidenceFeedback, reviewReportFeedback } from "../prompts/feedback";
import { assembleReviewTaskMessage } from "../prompts/review";
import { promptStoryOf } from "../prompts/story";
import { parseStoryDiff, type StoryDiff } from "../review/diff";
import {
  recordReviewVerdict,
  reviewDecidedEntry,
  reviewVerdictForTree,
  type StoredReviewVerdict,
} from "../review/store";
import { evidenceProblems, type ReviewFacts, validateReport } from "../review/validate";
import { judgeReview } from "../review/verdict";
import { lifecycleOf } from "../views/story";
import { withWorkViews } from "../views/work";
import { holdMessage, type AdapterHold, type LaunchCheckFailure } from "../workers/hold";
import type {
  HostOp,
  PlanError,
  ReviewFinding,
  ReviewReport,
  SteerOp,
  TurnProblem,
} from "../workers/types";
import { findClaim } from "../worktree/records";

import { REVIEWER_ROLE, runCaps } from "./caps";
import { runConfigOf } from "./config-snapshot";
import type { RunSteering } from "./control-types";
import { resolveIntent, runIntents, sendAsIntent, type StoredIntent } from "./intents";
import {
  type ExitContext,
  type HostLostContext,
  INTENT_TAGS,
  intentRest,
  intentTag,
  OUTCOME_ENDS,
  OUTCOME_NOTICES,
  type PlanLimitHit,
  type PlanLimitWaits,
  type RunEnder,
  type RunOutcomesPort,
  type RunView,
} from "./outcome-types";
import { openPark } from "./park";
import { claimPlace, type PlaceStart, START_KINDS, waitForPlace } from "./places";
import { LAUNCH_NOTICES, planRefusedText } from "./launch";
import { endRunMarked } from "./markers";
import { appendRunStep, DONE_END, findRun, finishRun, type StoredRun } from "./records";
import { latestDoneReport } from "./report-data";
import type { RunStoryFacts } from "./resume";
import { type ReviewGit, type ReviewSessions, snapshotReviewCaps } from "./review-launch";
import {
  beginReviewRound,
  failedReviewRounds,
  openReviewRound,
  pendingReviews,
  type ReviewRound,
  takeVerdict,
} from "./review-rounds";
import { endReviewPeriod, reopenForRound, REVIEWED_END } from "./rounds";

/** The tags of the review rounds' intents, at the start of their detail. */
export const REVIEW_TAGS = {
  /** `steer` `review-report <agent> <why>`: the correction turn for an invalid report. */
  report: "review-report",
  /** `steer` `review-evidence <agent>`: the correction turn naming failed findings. */
  evidence: "review-evidence",
  /** `stop` `review-retry <why>`: a failed turn ends the session as a crash. */
  retry: "review-retry",
  /** `stop` `review-plan-limit <fact>`: a plan limit stopped the session; never a park. */
  planLimit: "review-plan-limit",
} as const;

/** `agents.end_reason` of a reviewer session that failed (section 4: crash, host lost, no report). */
export const REVIEW_CRASHED_END = "review-crashed";

/** The end kind of a run parked `review-blocked`. */
export const REVIEW_BLOCKED_END = "review-blocked";

/** `engine.notice` codes of the review rounds. */
export const REVIEW_NOTICES = {
  /** A reviewer session failed; a fresh one starts, or the review waits. */
  failed: "review.failed",
  startFailed: OUTCOME_NOTICES.startFailed,
  /** The reviewer's read-only copy of a head does not match its tree: the review cannot start. */
  copyMismatch: "review.copyMismatch",
  /** The story is Done on the office base: no review round starts and the run ends done. */
  doneOnBase: "review.doneOnBase",
} as const;

export interface ReviewsDeps {
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly offices: {
    get(office: OfficeId): OfficeHandle | undefined;
    config(office: OfficeId): OfficeConfig | undefined;
  };
  readonly git: ReviewGit;
  /** The story facts of a run, read on the office base (`baseStoryFacts`). */
  readonly story: (office: OfficeId, run: StoredRun) => Promise<RunStoryFacts>;
  readonly sessions: ReviewSessions;
  readonly steering: RunSteering;
  readonly encode: (op: SteerOp) => HostOp[];
  /** Run control; read when needed, since it is built before this. */
  readonly ender: () => RunEnder | undefined;
  /** The adapter's id, for its hold. */
  readonly adapter: string;
  /** DIPO-43's adapter hold, set for a start failure or a credits limit. */
  readonly holds?: {
    hold(adapter: string, failures: readonly LaunchCheckFailure[]): AdapterHold;
  };
  /** The plan-limit schedule: a review's limit holds new sessions on its scope until the reset. */
  readonly waits?: () => PlanLimitWaits | undefined;
  /**
   * Hears a run that ended reviewed: a reviewer session's exit once its verdict or park ended the
   * review period, with the agent that exited, or a head that took its tree's verdict without a
   * round, with none. The fix round of the head decides then (DIPO-148), as no reviewer runs.
   */
  readonly onReviewed?: (office: OfficeId, runId: RunId, agent?: string) => void;
  readonly onChanged?: (office: OfficeId) => void;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True for a reviewer session's view. */
export function reviewerView(view: RunView): boolean {
  return view.work.role === REVIEWER_ROLE;
}

/** The park detail of the failed round that reached the cap: its unmet criteria and findings. */
export function blockingDetail(stored: StoredReviewVerdict, failed: number, cap: number): string {
  const lines = [
    ...stored.criteria
      .filter((entry) => entry.status === "unmet")
      .map((entry) => `- criterion #${entry.n} unmet: ${entry.evidence.trim()}`),
    ...stored.findings
      .filter((finding) => finding.severity === "blocking")
      .map((finding) => {
        const where =
          finding.file === undefined
            ? finding.testEntry === undefined
              ? ""
              : ` (test-plan entry #${finding.testEntry})`
            : ` at ${finding.file}${finding.line === undefined ? "" : `:${finding.line}`}`;
        return `- blocking ${finding.kind}${where}: ${finding.text.trim()}`;
      }),
  ];
  return [
    `Review round ${stored.round} at ${stored.commit.slice(0, 7)} was blocked, the ${failed} of ${cap} failed rounds the review allows:`,
    ...lines,
  ].join("\n");
}

/** Why a reviewer session ended, from its exit record. */
function exitWhy(end: IngestedExit | null): string {
  if (end === null) return "the reviewer host died while the daemon was down";
  const { code, signal } = end.exit;
  if (signal !== null) return `the reviewer exited on ${signal}`;
  return code === null ? "the reviewer exited" : `the reviewer exited with code ${code}`;
}

export class Reviews {
  readonly #deps: ReviewsDeps;
  /** Runs whose reviewer exit is being decided now. */
  readonly #deciding = new Set<string>();
  /** `<run>:<head>` of each copy mismatch already noticed. */
  readonly #mismatched = new Set<string>();
  /** `<run>:<message>` of each refused launch plan already noticed. */
  readonly #refused = new Set<string>();

  constructor(deps: ReviewsDeps) {
    this.#deps = deps;
  }

  /** The office's pending reviews, oldest In Review first (`PlacesDeps.pending`). */
  pending(office: OfficeHandle): PlaceStart[] {
    return pendingReviews(office);
  }

  /**
   * The review starter (`START_KINDS.review`): see the file comment. True when a reviewer session
   * started; false leaves a reopened run waiting for its place again (`Places`), or a run ended
   * at In Review pending.
   */
  async start(officeId: OfficeId, run: StoredRun, start: PlaceStart): Promise<boolean> {
    const office = this.#deps.offices.get(officeId);
    if (office === undefined || run.worktree === null || run.story === null) return false;
    if (run.endKind === DONE_END) return false;
    // A story parked since its start was queued waits for its resume (`pendingReviews`).
    if (run.key !== null && openPark(office, run.key) !== null) return false;
    let facts: RunStoryFacts;
    let head: string;
    let tree: string;
    try {
      facts = await this.#deps.story(officeId, run);
      // The head is read once for the round: its tree key, diff, copy and verdict all use it.
      head = await this.#deps.git.head(officeId, run.worktree);
      tree = await this.#deps.git.codeTreeKey(officeId, run.worktree, facts.taskFile, head);
    } catch (error) {
      this.#deps.warn?.("reading a story before its review failed; the review waits", {
        run: run.runId,
        reason: messageOf(error),
      });
      return false;
    }
    // A story Done on the office base gets no review round (DIPO-239): the run ends done.
    if (lifecycleOf("task", facts.view.status) === "Done") {
      this.#doneOnBase(office, run);
      return false;
    }
    // A code tree with a verdict in the claim is never reviewed again (section 6).
    if (reviewVerdictForTree(office, run.runId, tree) !== null) {
      this.#write(office, () => {
        const at = this.#deps.clock.now();
        if (!takeVerdict(office, run.runId)) endReviewPeriod(office, run.runId, at);
        return [];
      });
      // The run ended reviewed with the tree's verdict: a blocked one gets its fix round (DIPO-148).
      if (findRun(office, run.runId)?.endKind === REVIEWED_END) {
        this.#deps.onReviewed?.(officeId, run.runId);
      }
      return false;
    }
    const at = this.#deps.clock.now();
    const round = this.#writeWith(
      office,
      (): { value: ReviewRound | null; entries: NewEntry[] } => {
        const current = findRun(office, run.runId);
        if (current === null) return { value: null, entries: [] };
        // A pending review reopens the run ended at In Review; its wait counts from that time.
        const entries =
          current.endedAt === null
            ? []
            : reopenForRound(office, current, "review", at, start.since);
        if (findRun(office, run.runId)?.endedAt !== null) return { value: null, entries: [] };
        claimPlace(office, run.runId, at);
        // The reviewer's caps are the run's start snapshot; a run started without them takes the
        // office's current ones at its first review start and keeps them (0020 section 5).
        const config = this.#deps.offices.config(officeId);
        if (config !== undefined) snapshotReviewCaps(office, run.runId, config);
        return { value: beginReviewRound(office, current, start.since, at).round, entries };
      },
    );
    if (round === null) return false;
    return this.#launch(office, findRun(office, run.runId) ?? run, facts, head);
  }

  /**
   * Builds the review task message at `head` (read now when not given, for a fresh session after a
   * failed one) and starts a fresh reviewer session on exactly that head; true when it started.
   */
  async #launch(
    office: OfficeHandle,
    run: StoredRun,
    facts: RunStoryFacts,
    given?: string,
  ): Promise<boolean> {
    const officeId = office.officeId as OfficeId;
    const inForce = this.#deps.offices.config(officeId);
    if (inForce === undefined || run.worktree === null) return false;
    // The prompt budgets the run started with (its configuration snapshot, DIPO-150).
    const config = runConfigOf(office, run, inForce);
    let taskMessage: string;
    let head: string;
    try {
      head = given ?? (await this.#deps.git.head(officeId, run.worktree));
      const base = findClaim(office, run.runId)?.baseSha ?? run.startSha ?? "HEAD";
      const { diff, changes } = await this.#deps.git.diff(officeId, run.worktree, base, head);
      const size = await this.#deps.git.sizeClass(officeId, run.worktree);
      const previous = this.#lastVerdict(office, run.runId);
      // The worker's test-plan statuses and deviations of its last done report (DIPO-254).
      const done = latestDoneReport(office, run.runId);
      taskMessage = assembleReviewTaskMessage({
        story: promptStoryOf(facts.view, {
          dependencies: facts.dependencies,
          fields: facts.fields,
          taskFile: facts.taskFile,
        }),
        base,
        changes,
        diff,
        gateChanges: run.gateChanges ?? [],
        // The stored findings are the reviewer's, judged by code, so their kinds are known.
        ...(previous === null
          ? {}
          : { previousFindings: previous.findings as readonly ReviewFinding[] }),
        ...(done === null
          ? {}
          : { workerReport: { testPlan: done.testPlan, deviations: done.deviations } }),
        diffBudget: config.prompt.budgets.diff[size],
        contractMax: config.prompt.contractMax,
      }).text;
    } catch (error) {
      this.#deps.warn?.("building a review task message failed; the review waits", {
        run: run.runId,
        reason: messageOf(error),
      });
      return false;
    }
    let outcome;
    try {
      outcome = await this.#deps.sessions.start({ office: officeId, run, taskMessage, head });
    } catch (error) {
      outcome = { kind: "failed" as const, reason: messageOf(error) };
    }
    switch (outcome.kind) {
      case "started":
        return true;
      case "startFailed":
        this.#startFailed(office, run, holdMessage(outcome.hold));
        return false;
      case "failed":
        this.#deps.warn?.("a reviewer session did not start; the review waits", {
          run: run.runId,
          reason: outcome.reason,
        });
        if (outcome.copyMismatch === true) this.#copyMismatch(office, run, head, outcome.reason);
        if (outcome.planRefused !== undefined) this.#planRefused(office, run, outcome.planRefused);
        return false;
    }
  }

  /**
   * A story Done on the office base (DIPO-239): no review round and no session. A run ended at In
   * Review takes the end kind `done` in one write (`finishRun`, with its final outcome row); a run
   * still open and waiting for the reviewer place ends through `endReviewPeriod` with end kind
   * `done`, its wait cleared and its place free. One info notice names the story and the run. The
   * claim stays live for reconcile's done-on-base release (DIPO-216).
   */
  #doneOnBase(office: OfficeHandle, run: StoredRun): void {
    const story = run.story ?? run.runId;
    this.#write(office, () => {
      const current = findRun(office, run.runId);
      if (current === null || current.endKind === DONE_END) return [];
      const at = this.#deps.clock.now();
      if (current.endedAt !== null) {
        if (!finishRun(office, run.runId)) return [];
      } else if (!endReviewPeriod(office, run.runId, at, DONE_END)) {
        // A wait a daemon from before review rounds left has no review phase: it ends all the same.
        endRunMarked(office, run.runId, at, DONE_END);
      }
      return [
        {
          type: "engine.notice",
          ...(run.key === null ? {} : { key: run.key }),
          run: run.runId,
          delta: {
            level: "info",
            code: REVIEW_NOTICES.doneOnBase,
            text: `${story} is Done on the office base, so dipo starts no review for run ${run.runId} and ends the run as done. Reconcile releases its claim once the worktree can go.`,
          },
        },
      ];
    });
  }

  /**
   * A copy that does not match its head's tree (DIPO-276), for example two paths that differ only
   * in case, which the Mac's file system folds into one: a notice for the maintainer, once per head
   * in this daemon, so a commit cannot stall its own review unseen. The story stays In Review.
   */
  #copyMismatch(office: OfficeHandle, run: StoredRun, head: string, why: string): void {
    const seen = `${run.runId}:${head}`;
    if (this.#mismatched.has(seen)) return;
    this.#mismatched.add(seen);
    const story = run.story ?? run.runId;
    this.#write(office, () => [
      {
        type: "engine.notice",
        ...(run.key === null ? {} : { key: run.key }),
        run: run.runId,
        delta: {
          level: "warn",
          code: REVIEW_NOTICES.copyMismatch,
          text: `${story}: the review cannot start: ${why}. The commit may hold paths that differ only in case, which this Mac's file system folds into one. The story stays In Review until its branch changes; check the commit.`,
        },
      },
    ]);
  }

  /**
   * A reviewer launch the plan refused (`PlanError`, DIPO-247): the `run.planRefused` notice on the
   * office with `planRefusedText`, as the worker's launch raises it, once per run and refusal in
   * this daemon, as the review is tried again at every drain. The story stays In Review.
   */
  #planRefused(office: OfficeHandle, run: StoredRun, error: PlanError): void {
    const seen = `${run.runId}:${error.message}`;
    if (this.#refused.has(seen)) return;
    this.#refused.add(seen);
    this.#write(office, () => [
      {
        type: "engine.notice",
        ...(run.key === null ? {} : { key: run.key }),
        run: run.runId,
        delta: {
          level: "error",
          code: LAUNCH_NOTICES.planRefused,
          text: planRefusedText(run.story ?? run.runId, error),
        },
      },
    ]);
  }

  /** The `startFailed` row of section 4: a notice; the story stays In Review, the review waits. */
  #startFailed(office: OfficeHandle, run: StoredRun, why: string): void {
    const story = run.story ?? run.runId;
    this.#write(office, () => [
      {
        type: "engine.notice",
        ...(run.key === null ? {} : { key: run.key }),
        run: run.runId,
        delta: {
          level: "error",
          code: REVIEW_NOTICES.startFailed,
          text: `${story}: the reviewer did not start (${why}). The story stays In Review and its review waits.`,
        },
      },
    ]);
  }

  /** The run's newest verdict, the previous round's on a re-review. */
  #lastVerdict(office: OfficeHandle, runId: RunId): StoredReviewVerdict | null {
    const row = office.get<{ code_tree_key: string }>(
      `select code_tree_key from review_verdicts where office_id = $office_id and run_id = $run
        order by decided_at desc, rowid desc limit 1`,
      { run: runId },
    );
    return row === null ? null : reviewVerdictForTree(office, runId, row.code_tree_key);
  }

  // ---- the session's turns ---------------------------------------------------------------------

  /** A reviewer turn's report valid against the schema: validate, correct once, judge, store. */
  async onReview(view: RunView, report: ReviewReport): Promise<void> {
    const office = this.#deps.offices.get(view.office);
    if (office === undefined) return;
    const run = findRun(office, view.runId);
    if (run === null || run.endedAt !== null || run.worktree === null) return;
    const agent = view.work.agent;
    let reviewed: { facts: ReviewFacts; commit: string; tree: string };
    try {
      reviewed = await this.#reviewed(view.office, run, agent);
    } catch (error) {
      this.#crash(view, `the reviewed commit could not be read: ${messageOf(error)}`);
      return;
    }
    const check = validateReport(report, reviewed.facts);
    if (!check.valid) {
      await this.#invalid(office, view, check.problems.join("; "));
      return;
    }
    const failed = evidenceProblems(check.findings);
    if (failed.length > 0 && this.#sent(office, view.runId, REVIEW_TAGS.evidence, agent) === null) {
      await this.#correct(office, view, REVIEW_TAGS.evidence, reviewEvidenceFeedback(failed));
      return;
    }
    const judged = judgeReview(report, check.findings);
    const at = this.#deps.clock.now();
    const decided = this.#writeWith(office, () => {
      const current = findRun(office, run.runId);
      if (current === null || current.endedAt !== null) return { value: null, entries: [] };
      const round = openReviewRound(office, run.runId)?.round ?? 1;
      const stored = recordReviewVerdict(office, this.#deps.ids, {
        runId: run.runId,
        key: run.key as StoryKey,
        round,
        agent,
        model: view.work.model,
        commit: reviewed.commit,
        codeTreeKey: reviewed.tree,
        judged,
        at,
      });
      if (judged.verdict === "blocked") {
        appendRunStep(office, run.runId, "review-failed", String(round), at);
      }
      const cap = runCaps(office, current).reviewRoundCap;
      const capped =
        judged.verdict === "blocked" &&
        cap !== null &&
        failedReviewRounds(office, run.runId) >= cap;
      if (!capped) endReviewPeriod(office, run.runId, at);
      return { value: { stored, capped }, entries: [reviewDecidedEntry(stored)] };
    });
    if (decided === null) return;
    if (decided.capped) {
      const cap = runCaps(office, run).reviewRoundCap ?? 0;
      this.#deps.ender()?.begin(view.runId, {
        intent: "park",
        ops: [{ closeStdin: true }],
        reason: "review-blocked",
        detail: blockingDetail(decided.stored, failedReviewRounds(office, run.runId), cap),
        endKind: REVIEW_BLOCKED_END,
      });
      return;
    }
    // The verdict explains the exit, as a done report does: stdin closes with no intent.
    await this.#deps.steering.send(office, view.runId, [{ closeStdin: true }]).catch(() => {
      // A reviewer that already exited needs nothing more.
    });
  }

  /**
   * The facts a report is judged against, at the reviewed commit: the head the session was given
   * (its copy's, `reviewedCommit`), else the worktree's HEAD. A branch that moved since the session
   * started throws, so the session ends as a crash and a fresh one reviews the new head.
   */
  async #reviewed(
    officeId: OfficeId,
    run: StoredRun,
    agent: string,
  ): Promise<{ facts: ReviewFacts; commit: string; tree: string }> {
    const office = this.#deps.offices.get(officeId);
    const worktree = run.worktree as string;
    const story = await this.#deps.story(officeId, run);
    const base =
      (office === undefined ? null : findClaim(office, run.runId)?.baseSha) ??
      run.startSha ??
      "HEAD";
    const now = await this.#deps.git.head(officeId, worktree);
    const commit = (await this.#deps.sessions.reviewedCommit?.(officeId, run.runId, agent)) ?? now;
    if (commit !== now) {
      throw new Error(`the story branch moved from ${commit} to ${now} during the review`);
    }
    const tree = await this.#deps.git.codeTreeKey(officeId, worktree, story.taskFile, commit);
    const { diff } = await this.#deps.git.diff(officeId, worktree, base, commit);
    const parsed = parseStoryDiff(diff);
    const files: StoryDiff = {
      files: new Map([...parsed.files].filter(([path]) => path !== story.taskFile)),
    };
    return {
      facts: {
        criteria: story.view.acceptanceCriteria.map((criterion) => criterion.index),
        testPlan: story.fields.test_plan,
        diff: files,
      },
      commit,
      tree,
    };
  }

  /** An invalid report: one correction turn in the same session; still invalid, as a crash. */
  async #invalid(office: OfficeHandle, view: RunView, why: string): Promise<void> {
    if (this.#sent(office, view.runId, REVIEW_TAGS.report, view.work.agent) !== null) {
      this.#crash(view, `no valid review report after the correction turn: ${why}`);
      return;
    }
    await this.#correct(office, view, REVIEW_TAGS.report, reviewReportFeedback(why), why);
  }

  /** The newest correction turn of `tag` sent to `agent`, or null. */
  #sent(office: OfficeHandle, runId: RunId, tag: string, agent: string): StoredIntent | null {
    return (
      runIntents(office, runId)
        .filter(
          (intent) =>
            intent.kind === "steer" &&
            intentTag(intent.detail) === tag &&
            intentRest(intent.detail).split(" ")[0] === agent,
        )
        .at(-1) ?? null
    );
  }

  /** Sends one correction turn, stored first as a `steer` intent. */
  async #correct(
    office: OfficeHandle,
    view: RunView,
    tag: string,
    text: string,
    why = "",
  ): Promise<void> {
    await sendAsIntent(office, this.#deps.steering, view.runId, {
      kind: "steer",
      detail: `${tag} ${view.work.agent}${why === "" ? "" : ` ${why}`}`,
      ops: this.#deps.encode({ kind: "steer", text }),
      clock: this.#deps.clock,
    }).done;
  }

  /** Ends the session as a crash: its exit starts one fresh session or parks (section 4). */
  #crash(view: RunView, why: string): void {
    this.#deps.ender()?.act(view.runId, {
      intent: "stop",
      detail: `${REVIEW_TAGS.retry} ${why}`,
      ops: [{ closeStdin: true }, { signal: "SIGTERM", afterMs: 10_000 }],
      retryAtTick: true,
    });
  }

  /** A turn's problem in a reviewer session (section 4). */
  async onTurnProblem(view: RunView, problem: TurnProblem): Promise<void> {
    const office = this.#deps.offices.get(view.office);
    if (office === undefined || this.#deps.ender()?.live(view.runId) !== true) return;
    switch (problem.kind) {
      case "report":
        await this.#invalid(office, view, problem.detail);
        return;
      case "planLimit":
        this.onPlanLimit(view, { credits: false });
        return;
      case "startFailed":
        this.#deps.ender()?.act(view.runId, {
          intent: "stop",
          detail: `${INTENT_TAGS.startFailed} ${problem.detail}`,
          ops: [{ closeStdin: true }, { signal: "SIGTERM", afterMs: 10_000 }],
          retryAtTick: true,
        });
        return;
      case "contextFull":
      case "error":
        this.#crash(view, problem.detail);
        return;
    }
  }

  /**
   * A plan limit in a review (sections 4 and 12): the session stops and never parks. New sessions
   * on its scope wait for the reset (a credits limit holds the adapter); at the exit the review
   * waits for its place again, and a fresh session starts after the reset.
   */
  onPlanLimit(view: RunView, limit: PlanLimitHit): void {
    const acted = this.#deps.ender()?.act(view.runId, {
      intent: "stop",
      detail: `${REVIEW_TAGS.planLimit} ${JSON.stringify(limit)}`,
      ops: [{ closeStdin: true }],
    });
    if (acted !== true) return;
    if (limit.credits) {
      this.#deps.holds?.hold(this.#deps.adapter, [
        {
          check: "credits",
          detail:
            "the plan reports credits_required, so no run can use it until the plan is dealt with",
        },
      ]);
      return;
    }
    this.#deps.waits?.()?.warned(view.office, {
      ...(limit.resetsAt === undefined ? {} : { resetsAt: limit.resetsAt }),
      ...(limit.scope === undefined ? {} : { scope: limit.scope }),
    });
  }

  // ---- the session's exit ----------------------------------------------------------------------

  /** A reviewer session exited: see the file comment. */
  async onExit(exit: ExitContext): Promise<void> {
    await exit.turns.catch(() => undefined);
    await exit.ending?.catch(() => undefined);
    await this.#finish(exit.view, exit.agent);
    await this.#decide(exit.view, exit.agent, exit.end);
  }

  /** A reviewer host found dead after a restart: as a crash. */
  async onHostLost(lost: HostLostContext): Promise<void> {
    await lost.ending?.catch(() => undefined);
    await this.#finish(lost.view, lost.agent);
    await this.#decide(lost.view, lost.agent, null);
  }

  /** The ended session's read-only copy goes (DIPO-276); a failure is left for the start sweep. */
  async #finish(view: RunView, agent: string): Promise<void> {
    await this.#deps.sessions.finish?.(view.office, view.runId, agent).catch((error: unknown) => {
      this.#deps.warn?.("a reviewer's read-only copy could not be removed", {
        run: view.runId,
        reason: messageOf(error),
      });
    });
  }

  async #decide(view: RunView, agent: string, end: IngestedExit | null): Promise<void> {
    if (this.#deciding.has(view.runId)) return;
    this.#deciding.add(view.runId);
    try {
      await this.#decideExit(view, agent, end);
    } finally {
      this.#deciding.delete(view.runId);
    }
  }

  async #decideExit(view: RunView, agent: string, end: IngestedExit | null): Promise<void> {
    const office = this.#deps.offices.get(view.office);
    if (office === undefined) return;
    const run = findRun(office, view.runId);
    if (run === null) return;
    const at = this.#deps.clock.now();
    const intent = explaining(office, view.runId);
    const tag = intent === null ? null : intentTag(intent.detail);
    if (run.endedAt !== null) {
      // A verdict, or a park, ended the run already.
      if (intent !== null) this.#resolve(office, view.runId, intent, intent.kind, at);
      // No reviewer runs any more: the fix round of this head may decide now (DIPO-148).
      this.#deps.onReviewed?.(view.office, view.runId, agent);
      return;
    }
    if (tag === REVIEW_TAGS.planLimit && intent !== null) {
      this.#resolve(office, view.runId, intent, "plan-limit", at);
      this.#waitAgain(office, run);
      return;
    }
    if (tag === INTENT_TAGS.startFailed && intent !== null) {
      this.#resolve(office, view.runId, intent, "startFailed", at);
      const why = intentRest(intent.detail);
      const hold = this.#deps.holds?.hold(this.#deps.adapter, [
        { check: "start-failed", detail: why },
      ]);
      this.#startFailed(office, run, hold === undefined ? why : holdMessage(hold));
      this.#waitAgain(office, run);
      return;
    }
    // A crash: no verdict and no decision that explains the exit (section 4).
    const why =
      tag === REVIEW_TAGS.retry && intent !== null ? intentRest(intent.detail) : exitWhy(end);
    if (intent !== null) this.#resolve(office, view.runId, intent, "crashed", at);
    const round = openReviewRound(office, run.runId);
    const crashes = office.immediate(() => {
      office.run(
        `update agents set ended_at = coalesce(ended_at, $at), end_reason = $reason
          where office_id = $office_id and agent_id = $agent`,
        { at, agent, reason: REVIEW_CRASHED_END },
      );
      return (
        office.get<{ n: number }>(
          `select count(*) as n from agents where office_id = $office_id and run_id = $run
            and role = $role and end_reason = $reason and started_at >= $since`,
          {
            run: run.runId,
            role: REVIEWER_ROLE,
            reason: REVIEW_CRASHED_END,
            since: round?.at ?? 0,
          },
        )?.n ?? 0
      );
    });
    const ender = this.#deps.ender();
    if (crashes >= 2 || ender === undefined) {
      await ender?.park(office, run, view.work, {
        intent: "park",
        ops: [],
        reason: "worker-failed",
        detail: `the reviewer failed twice in review round ${round?.round ?? 1}: ${why}`,
        endKind: OUTCOME_ENDS.crashed,
      });
      return;
    }
    // One fresh session for the same round; the round is not counted again.
    this.#write(office, () => [
      {
        type: "engine.notice",
        ...(run.key === null ? {} : { key: run.key }),
        run: run.runId,
        delta: {
          level: "warn",
          code: REVIEW_NOTICES.failed,
          text: `${run.story ?? run.runId}: the reviewer failed (${why}); dipo starts one fresh review session for review round ${round?.round ?? 1}.`,
        },
      },
    ]);
    let started = false;
    try {
      started = await this.#launch(office, run, await this.#deps.story(view.office, run));
    } catch (error) {
      this.#deps.warn?.("starting a fresh review session failed; the review waits", {
        run: run.runId,
        reason: messageOf(error),
      });
    }
    if (!started) this.#waitAgain(office, run);
  }

  /** The open review waits for the reviewer place again, from its In Review time. */
  #waitAgain(office: OfficeHandle, run: StoredRun): void {
    const since = openReviewRound(office, run.runId)?.since ?? this.#deps.clock.now();
    office.immediate(() => waitForPlace(office, run.runId, START_KINDS.review, since));
    this.#deps.onChanged?.(office.officeId as OfficeId);
  }

  #resolve(
    office: OfficeHandle,
    runId: RunId,
    intent: StoredIntent,
    outcome: string,
    at: number,
  ): void {
    office.immediate(() => resolveIntent(office, runId, intent.intentId, outcome, at));
  }

  /** Runs `fn` in one transaction and appends the entries it returns with their work views. */
  #write(office: OfficeHandle, fn: () => readonly NewEntry[]): void {
    this.#writeWith(office, () => ({ value: undefined, entries: fn() }));
  }

  /** `#write` for a step that also returns a value. */
  #writeWith<T>(
    office: OfficeHandle,
    fn: () => { readonly value: T; readonly entries: readonly NewEntry[] },
  ): T {
    const at = this.#deps.clock.now();
    const { value, appended } = office.immediate(() => {
      const out = fn();
      const entries = withWorkViews(office, out.entries);
      appendEntries(office, entries, { at });
      return { value: out.value, appended: entries.length };
    });
    if (appended > 0) this.#deps.onChanged?.(office.officeId as OfficeId);
    return value;
  }

  /**
   * Worker outcomes for both kinds of session: a reviewer session's turns and exit are decided
   * here, every other session's by `base`.
   */
  route(base: RunOutcomesPort): RunOutcomesPort {
    return {
      onTurnProblem: (view, problem) =>
        reviewerView(view) ? this.onTurnProblem(view, problem) : base.onTurnProblem(view, problem),
      onPlanLimit: (view, limit) =>
        reviewerView(view) ? this.onPlanLimit(view, limit) : base.onPlanLimit(view, limit),
      ...(base.onPlanWarning === undefined
        ? {}
        : { onPlanWarning: (view, warning) => base.onPlanWarning?.(view, warning) }),
      onModelSwitched: (view, model) => base.onModelSwitched(view, model),
      // A reviewer answers no report feedback of the developer's.
      answered: (view) => {
        if (!reviewerView(view)) base.answered(view);
      },
      onReview: (view, report) =>
        reviewerView(view) ? this.onReview(view, report) : Promise.resolve(),
      onExit: (exit) => (reviewerView(exit.view) ? this.onExit(exit) : base.onExit(exit)),
      onHostLost: (lost) =>
        reviewerView(lost.view)
          ? this.onHostLost(lost)
          : (base.onHostLost?.(lost) ?? Promise.resolve()),
    };
  }
}

/** The newest unresolved intent that explains a worker's exit. */
function explaining(office: OfficeHandle, runId: RunId): StoredIntent | null {
  return (
    runIntents(office, runId)
      .filter(
        (intent) =>
          intent.resolvedAt === null &&
          (intent.kind === "stop" ||
            intent.kind === "cap" ||
            intent.kind === "park" ||
            intent.kind === "reassign" ||
            intent.kind === "pause"),
      )
      .at(-1) ?? null
  );
}
