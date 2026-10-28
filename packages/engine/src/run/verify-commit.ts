// The end of a developer's turn and In Review (DIPO-49, DIPO-273, DIPO-299; 0010 section 7, 0013
// section 5, 0007 section 4, 0021 sections 8 and 13 and its amendment of 2026-10-22). Run control
// (DIPO-50) calls `afterTurn` once per worker turn, one at a time per run, unless the turn already
// ended the run (a cap or a blocked report). Only a turn whose report is `done` goes on.
//
// Every developer works in its story's box (DIPO-240): dipo runs no backstop and no scope check,
// and the only check of what a part changes is the protected-file and secret scan of each part
// (`box/parts.ts`). dipo runs the office's verify in the box at done (0002, DIPO-346), and CI on
// the story PR is the final gate. A run without a box (none starts any more; one parked before
// the change has its box made at its next session, `box/lifetime.ts`) that reports done parks
// `worker-failed`.
//
// At done, in one held turn of the run's parts (`BoxParts.finishLast`), so no part moves the branch
// meanwhile: the last part is delivered (a hit, a refused part or a rejected push parks; one dipo
// cannot take out is tried again at the door's pace, `DOOR_POLL_MS`, for up to `PART_STUCK_MIN_MS`
// before the story parks `worker-failed`, DIPO-290), the office's verify runs in the box as the box
// user with its deadline (`VerifyCommitDeps.verify`, DIPO-346): red is one feedback item with its
// command, exit and output tail as evidence (`verifyFeedback`), counted as one loop as a report
// gate refusal is, and the refusal that reaches the run's loop cap parks `verify-failing` (0002); a
// verify dipo cannot run parks `worker-failed`. Then the gate changes of the branch are recorded for
// the review, and the run's end is claimed while the parts are still held, so a part or catch-up
// queued meanwhile finds the run not live and stays in the box. Before the end is claimed, in the
// same held turn, the conflict check (DIPO-149, `run/conflicts.ts`): what dipo's conflicted merges
// left unresolved (markers, untouched binary or delete conflicts) goes back to the worker as a
// feedback turn (or parks at the conflict cap), then the fetch and the sync with the base: a
// riskier story merges the base, any other only on a conflict, which goes to the worker as one
// conflict item; a clean merge moves the commit In Review is written at. Just before In Review the
// branch must still be at that commit, else the story parks (`BOX_TIP_MOVED`). Then:
//
// - The code tree key is recorded, the Backlog CLI checks off the criteria the report marks met and
//   sets In Review, committed alone as `<ID>: status In Review`; the branch is pushed without
//   force. In one transaction the run ends at In Review with its outcome row (`endRun`) and
//   summary, a push that reached the remote is recorded on the claim (`claims.pushed_at`), and
//   `story.state` moves the story to In Review. A non-fast-forward push rejection parks `conflict`
//   (0010); any other push failure is a notice and the story stays In Review with the branch local.
//   A failure in the commit steps parks `worker-failed` with the error. Dependency files the parts
//   changed (manifests, lockfiles, `requirements*.txt`) raise `verify.dependenciesChanged`.
// - The story PR (DIPO-144; 0019 section 3): after a push that reached the remote, `storyPr.sync`
//   opens the story's ready PR, or updates the one it has; the review (a pending review of the
//   reviewer place) and CI (the PR poll's watch of the pushed head) start together on that head
//   (0019 section 7). Red CI goes back to the worker through the CI loop of 0019 section 8.
//
// The report gate (DIPO-186; 0002, 0014), for every done report before the steps above: the
// report's test-plan entries and deviations are stored for the run (`done_reports`). Then code
// checks two things, and one feedback item that names each miss goes back to the worker, with no
// commit and the run going on:
// - an automated entry of the story's test plan (read on the office base) that the report does not
//   mark done, or gives no entry; every such report is refused, manual entries never block, and a
//   story without a test plan is unchanged;
// - a decision note whose file is missing at the story branch, or holds no section with that
//   heading; sent back once per file and section, then left out. Each note that passes is stored in
//   `decision_notes` with its story and run, also from a report that ends the run (`summarize`).
// dipo reads none of the worker's tool calls to see whether it ran verify: dipo runs it (DIPO-346).
// A done turn that crossed a cap has no turn left: its test-plan miss parks `budget-exceeded`,
// and the send-once check is skipped. Each refusal is one loop (a `loop` step), the cap 0002
// gives the report gate; the refusal that reaches the run's loop cap parks `verify-failing`.

import {
  type Clock,
  type FieldBlock,
  type OfficeId,
  type ParkReason,
  type RunId,
  StoryId,
  type StoryKey,
  type WorkRef,
} from "@dipsaus-orchestrator/contract";

import { TASK_FIELD_ERROR } from "../backlog/runner";
import type { NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import { GitError } from "../git/runner";
import {
  decisionNoteFeedback,
  FEEDBACK_LOG_LINES_DEFAULT,
  testPlanFeedback,
  verifyFeedback,
} from "../prompts/feedback";
import { shownSpec } from "../scan/diff";
import type { CapabilityName, RunProfile } from "../scan/detect";
import { LOCKFILES, parseManifest } from "../scan/detect/manifest";
import { deriveStoryView, storyView } from "../views/story";
import type { WorkerDecisionNote, WorkerReport } from "../workers/types";
import { DOOR_POLL_MS } from "../box/door";
import {
  type LastPartAccess,
  type LastPartFinish,
  PART_ARCHIVE_LIMITS,
  PART_REFUSED,
  PART_STUCK_MIN_MS,
  partPark,
  refusedDetail,
} from "../box/parts";
import { BoxError } from "../box/port";
import { BOX_WORKDIR } from "../box/code";
import type { BoxVerifyResult } from "../box/verify";
import { recordBranchPush } from "../story-pr/records";
import { findClaim } from "../worktree/records";

import type { BackstopSnapshot } from "./backstop";
import { runBudgetFacts } from "./budget-line";
import { runConfigOf } from "./config-snapshot";
import type { DoneConflictDecision } from "./conflicts";
import { endRunMarked } from "./markers";
import { type FiredCap, runCaps } from "./caps";
import {
  appendRunStep,
  IN_REVIEW_END,
  recordGateChanges,
  type StoredRun,
  VERIFY_LOOP,
} from "./records";
import {
  type NoteMiss,
  noteMiss,
  noteSignature,
  recordSendBack,
  sentBack,
  storeDecisionNotes,
  storeDoneReport,
  testPlanGaps,
} from "./report-data";
import type { StoryGit } from "./story-git";
import { storeRunSummary } from "./verify-records";

/**
 * The park detail when the story branch moved off the last part's commit after a box run claimed
 * its end at done: In Review is written only at the commit the last part left.
 */
export const BOX_TIP_MOVED =
  "the story branch moved off the last part's commit before In Review, so dipo did not move the story to review; In Review is written only at the commit the last part left.";

/** The park detail of a run without a box that reports done (DIPO-240). */
export const NO_BOX_AT_DONE =
  "the run has no box, so dipo cannot take its work as parts; resume the story, and dipo makes its box from the start commit and the delivered parts first.";

/** `engine.notice` codes of In Review. */
export const VERIFY_NOTICES = {
  pushFailed: "verify.pushFailed",
  dependenciesChanged: "verify.dependenciesChanged",
} as const;

/**
 * Dependency files (DIPO-84): manifests and lockfiles of the package managers workers may install
 * with. A run that changes one raises `verify.dependenciesChanged`, so the maintainer sees new
 * packages at review.
 */
export const DEPENDENCY_FILES: readonly string[] = [
  "package.json",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "pyproject.toml",
  "poetry.lock",
  "uv.lock",
];

/** Pure: the dependency files among repo-relative paths, sorted; `requirements*.txt` included. */
export function dependencyFiles(paths: readonly string[]): string[] {
  return [
    ...new Set(
      paths.filter((path) => {
        const name = path.slice(path.lastIndexOf("/") + 1);
        return DEPENDENCY_FILES.includes(name) || /^requirements.*\.txt$/.test(name);
      }),
    ),
  ].toSorted();
}

/** Pure: the notice text of a run that changed dependency files. */
export function dependenciesChangedText(story: string, files: readonly string[]): string {
  return `${story} changed dependency files: ${files.join(", ")}. Review the added or changed packages before you merge.`;
}

/** Gate capabilities whose change the review is told about (0013 section 5). */
export const GATE_CAPABILITIES: readonly CapabilityName[] = ["test", "lint", "typecheck", "verify"];

/** Lockfile names paired with manifests (0014 section 3, 0010 amendment); the scope nudge's. */
export const DEFAULT_LOCKFILES: readonly string[] = LOCKFILES.map(([name]) => name);

/** True when the scope path `scope` covers `path`: equal, or `path` lies under it. */
export function scopeCovers(scope: string, path: string): boolean {
  const dir = scope.endsWith("/") ? scope : `${scope}/`;
  return path === scope || path.startsWith(dir);
}

function shownCapability(profile: RunProfile, name: CapabilityName): string {
  const capability = profile.capabilities[name];
  if (capability.status === "resolved") return shownSpec(capability.value);
  return capability.status;
}

function shownScript(value: string | undefined): string {
  return value === undefined ? "none" : JSON.stringify(value);
}

/**
 * Pure: the gate changes of a branch against the base (0013 section 5), one line each: the root
 * `package.json` gate scripts that differ, then the gate capabilities whose commands differ.
 */
export function gateChanges(input: {
  readonly baseScripts: Readonly<Record<string, string>>;
  readonly branchScripts: Readonly<Record<string, string>>;
  readonly base: RunProfile | null;
  readonly branch: RunProfile;
}): string[] {
  const lines: string[] = [];
  for (const name of GATE_CAPABILITIES) {
    const before = input.baseScripts[name];
    const after = input.branchScripts[name];
    if (before !== after)
      lines.push(`scripts.${name}: ${shownScript(before)} -> ${shownScript(after)}`);
  }
  if (input.base !== null) {
    for (const name of GATE_CAPABILITIES) {
      const before = shownCapability(input.base, name);
      const after = shownCapability(input.branch, name);
      if (before !== after) lines.push(`${name}: ${before} -> ${after}`);
    }
  }
  return lines;
}

// ---- the flow ------------------------------------------------------------------------------------

/** What run control decides after a turn. */
export type TurnDecision =
  | { readonly kind: "continue" }
  | {
      readonly kind: "park";
      readonly reason: ParkReason;
      readonly detail: string;
      readonly endKind: string;
    }
  | {
      readonly kind: "feedback";
      readonly text: string;
      /** What the feedback is, for the notice when it cannot be sent; verify feedback by default. */
      readonly what?: string;
    }
  /** The run ended at In Review; run control closes the worker's stdin. */
  | { readonly kind: "ended" };

/** What run control gives one turn. */
export interface TurnContext {
  readonly office: OfficeHandle;
  readonly run: StoredRun;
  readonly work: WorkRef;
  readonly report: WorkerReport | null;
  /**
   * The cap this turn crossed while it carried a done report (DIPO-205): its cap step is written
   * with the run's end.
   */
  readonly capped?: FiredCap | null;
  /** The run-start snapshot run control tracks; a box run is checked by its parts instead. */
  readonly snapshot: BackstopSnapshot | null;
  /** True while no other decision (a cap, a stop) ended the run. */
  readonly live: () => boolean;
  /** Claims the run's end before the commit steps; false when another decision came first. */
  readonly claimEnd: () => boolean;
  /** Runs `fn` in one transaction, appends its entries with their work views. */
  readonly write: (fn: () => readonly NewEntry[]) => void;
  /** Writes the worker's pending `work.output` before a state change. */
  readonly flushOutput: () => void;
}

/** The story facts the report gate reads on the office base (`baseStoryFacts`, DIPO-186). */
export interface ReportGateFacts {
  readonly fields: FieldBlock;
  readonly view: { readonly type?: string };
}

/** What run control asks at the end of a turn. */
export interface RunFinisher {
  afterTurn(ctx: TurnContext): Promise<TurnDecision>;
  /** Stores the run summary of a run that ended outside `afterTurn` (a park). */
  summarize(office: OfficeHandle, run: StoredRun, report: WorkerReport | null): Promise<void>;
}

export interface VerifyCommitDeps {
  readonly clock: Clock;
  readonly story: StoryGit;
  /** The office's stored run profile (the base profile), for the gate changes. */
  readonly profile: (office: OfficeHandle) => RunProfile | null;
  /**
   * The story PR (DIPO-144): called right after an In Review push that reached the remote, to open
   * or update the story's PR. It never throws; a failure is its own notice.
   */
  readonly storyPr?: {
    sync(office: OfficeId, runId: RunId): Promise<void>;
    /** The In Review push failed (DIPO-315): its review waits for the PR poll to push again. */
    pushHeld?(office: OfficeId, runId: RunId): void;
  };
  /**
   * The box runs' parts (DIPO-273): whether a run's developer works in a box, and its last part at
   * done (`BoxParts.finishLast`). Without them no run reaches In Review here.
   */
  readonly parts?: {
    isBoxRun(office: OfficeId, run: StoredRun): boolean;
    finishLast<T>(
      runId: string,
      message: string,
      finish: (last: LastPartAccess) => Promise<T>,
    ): Promise<LastPartFinish<T>>;
  };
  /**
   * Conflicts with the base before In Review (DIPO-149, `run/conflicts.ts`): in a box run's held
   * turn after the last part, the marker check of the recorded conflicted paths and the sync with
   * the base. Without it a box run goes to In Review at the last part's commit.
   */
  readonly conflicts?: {
    atDone(input: {
      readonly office: OfficeHandle;
      readonly run: StoredRun;
      readonly tip: string;
      readonly capped: boolean;
    }): Promise<DoneConflictDecision>;
  };
  /**
   * The story facts on the office base, for the report gate's test-plan check (DIPO-186). Without
   * it the test plan is not checked.
   */
  readonly storyFacts?: (office: OfficeId, run: StoredRun) => Promise<ReportGateFacts>;
  /**
   * The office's verify in the run's box at done (0002, DIPO-346), run in the held turn after the
   * last part. Without it a box run goes to In Review with CI as its only check.
   */
  readonly verify?: (office: OfficeHandle, run: StoredRun) => Promise<BoxVerifyResult>;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function scriptsOf(text: string | null): Record<string, string> {
  return text === null ? {} : { ...parseManifest(text)?.scripts };
}

export class VerifyCommit implements RunFinisher {
  readonly #deps: VerifyCommitDeps;

  constructor(deps: VerifyCommitDeps) {
    this.#deps = deps;
  }

  async afterTurn(ctx: TurnContext): Promise<TurnDecision> {
    const { run } = ctx;
    if (run.kind !== "story" || run.worktree === null || run.story === null) {
      return { kind: "continue" };
    }
    if (ctx.report?.status !== "done" || !ctx.live()) return { kind: "continue" };
    if (this.#deps.parts?.isBoxRun(ctx.office.officeId, run) !== true) {
      return {
        kind: "park",
        reason: "worker-failed",
        detail: NO_BOX_AT_DONE,
        endKind: "interrupted",
      };
    }
    const report = ctx.report;
    // The report gate (DIPO-186): stored, then its test plan and decision notes.
    const gate = await this.#reportGate(ctx, report);
    if (gate !== null || !ctx.live()) return gate ?? { kind: "continue" };
    return this.#boxDone(ctx, report);
  }

  /**
   * The report gate of a done report (DIPO-186): stores its test-plan entries and deviations, then
   * checks its test plan and its decision notes. Null when the report goes on; else the one
   * feedback item, or the park of a capped turn.
   */
  async #reportGate(ctx: TurnContext, report: WorkerReport): Promise<TurnDecision | null> {
    const { run } = ctx;
    const office = ctx.office;
    const at = this.#deps.clock.now();
    office.immediate(() =>
      storeDoneReport(office, run.runId, {
        ...(report.testPlan === undefined ? {} : { testPlan: report.testPlan }),
        ...(report.deviations === undefined ? {} : { deviations: report.deviations }),
        at,
      }),
    );
    const items: string[] = [];

    // The test plan, read on the office base; a base that cannot be read leaves it unchecked.
    const facts = await this.#deps.storyFacts?.(office.officeId, run).catch((error: unknown) => {
      this.#deps.warn?.("the story's test plan could not be read; it is not checked", {
        run: run.runId,
        reason: messageOf(error),
      });
      return undefined;
    });
    const plan = facts?.fields.test_plan;
    const type = facts?.view.type;
    const gaps = testPlanGaps(plan, report.testPlan, type);
    if (gaps.length > 0) {
      const text = testPlanFeedback(gaps);
      if (ctx.capped != null) {
        // The done turn crossed a cap, so no turn is left for the feedback: only a top-up resumes.
        return { kind: "park", reason: "budget-exceeded", detail: text, endKind: "capped" };
      }
      items.push(text);
    }

    // Decision notes: the checked ones are stored now, a miss is sent back once.
    const checked = await this.#checkNotes(office, run, report.decisionNotes ?? []);
    const misses =
      ctx.capped != null
        ? []
        : checked.misses.filter(
            (miss) => !sentBack(office, run.runId, "decision-note", noteSignature(miss.note)),
          );
    if (misses.length > 0) {
      items.push(
        decisionNoteFeedback(
          misses.map((miss) => ({
            file: miss.note.file,
            section: miss.note.section,
            miss: miss.miss,
          })),
        ),
      );
    }

    if (items.length === 0) return null;
    return this.#loop(ctx, {
      step: REPORT_GATE_LOOP,
      what: "the report gate refused the done report",
      items,
      record: () => {
        for (const miss of misses) {
          recordSendBack(office, run.runId, "decision-note", noteSignature(miss.note), at);
        }
      },
    });
  }

  /**
   * One refusal of a done report, by the report gate or a red verify in the box: one loop (a
   * `loop` step), the cap 0002 gives both. The refusal that reaches the run's loop cap parks
   * `verify-failing` instead of another turn; any other goes back as one feedback item.
   */
  #loop(
    ctx: TurnContext,
    input: {
      readonly step: string;
      readonly what: string;
      readonly items: readonly string[];
      readonly record?: () => void;
      readonly feedback?: string;
    },
  ): TurnDecision {
    const { office, run } = ctx;
    const at = this.#deps.clock.now();
    const cap = runCaps(office, run).loopCap;
    const loops = loopsOf(office, run.runId) + 1;
    office.immediate(() => {
      appendRunStep(office, run.runId, "loop", input.step, at);
      input.record?.();
    });
    if (loops >= cap) {
      return {
        kind: "park",
        reason: "verify-failing",
        detail: `${input.what} ${loops} time${loops === 1 ? "" : "s"} (the loop cap is ${cap}). ${input.items.join(" ")}`,
        endKind: "verify-failing",
      };
    }
    if (!ctx.live()) return { kind: "continue" };
    return {
      kind: "feedback",
      text: input.items.join("\n\n"),
      ...(input.feedback === undefined ? {} : { what: input.feedback }),
    };
  }

  /**
   * The office's verify in the box at done (0002, DIPO-346): null when it is green or the office
   * names none; else what the turn decides: a red verify is one loop with its evidence (a park at
   * a capped turn, which has no turn left), a verify dipo could not run parks `worker-failed`.
   */
  async #verifyInBox(ctx: TurnContext): Promise<TurnDecision | null> {
    const verify = this.#deps.verify;
    if (verify === undefined) return null;
    const { run } = ctx;
    const result = await verify(ctx.office, run).catch((error: unknown): BoxVerifyResult => ({
      kind: "failed",
      reason: `dipo could not run the verify in the box (${codeOf(error)})`,
    }));
    switch (result.kind) {
      case "none":
      case "green":
        return null;
      case "failed":
        return {
          kind: "park",
          reason: "worker-failed",
          detail: `${result.reason}; the story did not move to review.`,
          endKind: "interrupted",
        };
      default:
        break;
    }
    const exit =
      result.timedOutMinutes !== null
        ? `none: dipo stopped it at its ${result.timedOutMinutes}-minute deadline`
        : result.exitCode === null
          ? `none: it ended by ${result.signal ?? "a signal"}`
          : String(result.exitCode);
    // The tier's item budget and the budget line, as a CI item gets them (`StoryPrs`), less the
    // intro line before it.
    const budgets = runConfigOf(ctx.office, run).prompt.budgets.feedbackItem as Readonly<
      Record<string, number>
    >;
    const itemMax = (run.tier === null ? undefined : budgets[run.tier]) ?? budgets["M"] ?? 3_000;
    const item = verifyFeedback(
      { step: "verify", command: result.command, exitCode: exit, output: result.output },
      {
        root: BOX_WORKDIR,
        itemMax: itemMax - VERIFY_IN_BOX_INTRO.length - 2,
        logLines: FEEDBACK_LOG_LINES_DEFAULT,
        budget: runBudgetFacts(ctx.office, run, this.#deps.clock.now()),
      },
    ).text;
    const text = `${VERIFY_IN_BOX_INTRO}\n\n${item}`;
    if (ctx.capped != null) {
      // The done turn crossed a cap, so no turn is left for the feedback: only a top-up resumes.
      return { kind: "park", reason: "budget-exceeded", detail: text, endKind: "capped" };
    }
    return this.#loop(ctx, {
      step: VERIFY_LOOP,
      what: "dipo's verify in the box was red",
      items: [text],
      feedback: "verify feedback",
    });
  }

  /**
   * Checks each decision note against its file at the story branch (the start commit when the run
   * has no branch) and stores the notes that pass, with the story and the run (DIPO-186).
   */
  async #checkNotes(
    office: OfficeHandle,
    run: StoredRun,
    notes: readonly WorkerDecisionNote[],
  ): Promise<{ misses: { note: WorkerDecisionNote; miss: NoteMiss }[] }> {
    const misses: { note: WorkerDecisionNote; miss: NoteMiss }[] = [];
    if (notes.length === 0 || run.key === null || run.worktree === null) return { misses };
    const ref = run.branch !== null ? `refs/heads/${run.branch}` : run.startSha;
    const passed: WorkerDecisionNote[] = [];
    for (const note of notes) {
      const text =
        ref === null
          ? null
          : await this.#deps.story
              .showAt(office.officeId, run.worktree, ref, note.file)
              .catch(() => null);
      const miss = noteMiss(note, text);
      if (miss === null) passed.push(note);
      else misses.push({ note, miss });
    }
    if (passed.length > 0) {
      const key = run.key;
      const at = this.#deps.clock.now();
      office.immediate(() =>
        storeDecisionNotes(office, { key, runId: run.runId, notes: passed, at }),
      );
    }
    return { misses };
  }

  /**
   * A box run at done (DIPO-273, DIPO-346; 0002, 0008). In one held turn of the run's parts
   * (`parts.finishLast`): the parts still queued and then what changed since are delivered as the
   * last part; the office's verify runs in the box (`#verifyInBox`), and a red one is the turn's
   * decision; then the branch's gate changes are recorded and the run's end is claimed while the
   * parts are still held. A hit, a refused part or a rejected push parks. The story moves to review
   * at the last part's commit, and the push starts the review and CI on it. A failure to take the last part is tried again every
   * `DOOR_POLL_MS` while the run goes on, for up to `PART_STUCK_MIN_MS` from the first failure
   * (DIPO-290); then it parks `worker-failed` with a fixed text and the error's code: its message may
   * quote the box's output. A part dipo refuses (`PART_REFUSED`) parks `part-refused` at once, and
   * a run that parked or stopped during the tries keeps that decision.
   */
  async #boxDone(ctx: TurnContext, report: WorkerReport): Promise<TurnDecision> {
    const { run } = ctx;
    const parts = this.#deps.parts as NonNullable<VerifyCommitDeps["parts"]>;
    // What `finish` threw is kept apart from a failure to take the last part.
    let thrown: { readonly error: unknown } | null = null;
    // What the conflict check decided instead of In Review (DIPO-149).
    const conflict: { decided: DoneConflictDecision | null } = { decided: null };
    // What the verify in the box decided instead of In Review (DIPO-346).
    const verified: { decided: TurnDecision | null } = { decided: null };
    let done: LastPartFinish<LastPartAccess | null>;
    const clock = this.#deps.clock;
    let firstFailure: number | null = null;
    for (;;) {
      try {
        done = await parts.finishLast(run.runId, report.commitSubject, async (last) => {
          try {
            if (!ctx.live()) return null;
            // The office's verify in the box, on exactly the last part (0002, DIPO-346).
            verified.decided = await this.#verifyInBox(ctx);
            if (verified.decided !== null || !ctx.live()) return null;
            await this.#boxGateChanges(ctx, this.#deps.profile(ctx.office));
            // Markers left from a catch-up, then the sync with the base (DIPO-149): a clean
            // merge moves the tip In Review is written at; anything else decides the turn.
            let tip = last.tip;
            const checked = await this.#deps.conflicts?.atDone({
              office: ctx.office,
              run,
              tip: last.tip,
              capped: ctx.capped != null,
            });
            if (checked !== undefined && checked.kind !== "go") {
              conflict.decided = checked;
              return null;
            }
            if (checked !== undefined) tip = checked.tip;
            // Claimed while the parts are still held, so a part the door queued meanwhile, or a
            // catch-up, finds the run not live and stays queued in the box.
            return ctx.claimEnd() ? { tip, branchTip: () => last.branchTip() } : null;
          } catch (error) {
            thrown = { error };
            return null;
          }
        });
        break;
      } catch (error) {
        if (error instanceof BoxError && error.code === PART_REFUSED) {
          // What dipo does not take is the same on every try: refused at once, as a part is.
          this.#deps.warn?.("the last part was refused", {
            run: run.runId,
            reason: messageOf(error),
          });
          const refused = partPark({
            kind: "refused",
            detail: refusedDetail("archive", PART_ARCHIVE_LIMITS.maxArchiveBytes),
          }) as NonNullable<ReturnType<typeof partPark>>;
          return { kind: "park", ...refused, endKind: refused.reason };
        }
        // The run parked or stopped meanwhile: that decision stands, and no part park is added.
        if (!ctx.live()) return { kind: "continue" };
        firstFailure ??= clock.now();
        if (clock.now() - firstFailure < PART_STUCK_MIN_MS) {
          // Tried again at the door's pace: a short failure never parks the story (DIPO-290).
          this.#deps.warn?.("the last part could not be delivered; trying again", {
            run: run.runId,
            reason: messageOf(error),
          });
          await new Promise<void>((resolve) => clock.setTimeout(resolve, DOOR_POLL_MS));
          continue;
        }
        this.#deps.warn?.("the last part could not be delivered", {
          run: run.runId,
          reason: messageOf(error),
        });
        const code = (error as { code?: unknown } | null)?.code;
        return {
          kind: "park",
          reason: "worker-failed",
          detail: `dipo could not take the last part out of the box (${typeof code === "string" ? code : "error"}); nothing of it was committed.`,
          endKind: "interrupted",
        };
      }
    }
    if (thrown !== null) throw (thrown as { readonly error: unknown }).error;
    const red = verified.decided as TurnDecision | null;
    if (red !== null) return red;
    const decided = conflict.decided as DoneConflictDecision | null;
    if (decided !== null) {
      switch (decided.kind) {
        case "feedback":
          return { kind: "feedback", text: decided.text, what: "conflict feedback" };
        case "park":
          return {
            kind: "park",
            reason: decided.reason,
            detail: decided.detail,
            endKind: decided.reason,
          };
        default:
          return { kind: "continue" };
      }
    }
    const park = partPark(done.outcome);
    if (park !== null) return { kind: "park", ...park, endKind: park.reason };
    const last = done.finished?.result ?? null;
    if (last === null) return { kind: "continue" };

    let view: Awaited<ReturnType<StoryGit["story"]>>;
    try {
      view = await this.#deps.story.story(ctx.office.officeId, run.worktree as string, run.story!);
    } catch (error) {
      if (isTaskFieldError(error)) return scopePark(error.message);
      throw error;
    }
    // A second layer: the branch must still be at the last part's commit. Run control sends no
    // feedback once the end is claimed, so a moved tip parks; nothing moves it in the held turn.
    const now = await last.branchTip().catch(() => null);
    if (now !== last.tip) {
      return {
        kind: "park",
        reason: "worker-failed",
        detail: BOX_TIP_MOVED,
        endKind: "interrupted",
      };
    }
    return this.#commit(ctx, {
      report,
      view,
      loop: loopsOf(ctx.office, run.runId),
    });
  }

  /**
   * The gate changes of a box run (0013 section 5), recorded on the run: the root `package.json`
   * gate scripts of the delivered branch tip against the base, read from git's objects. A changed
   * script shows at review.
   */
  async #boxGateChanges(ctx: TurnContext, base: RunProfile | null): Promise<void> {
    const { run } = ctx;
    if (base === null || run.branch === null) return;
    const officeId = ctx.office.officeId;
    const worktree = run.worktree as string;
    const baseSha = findClaim(ctx.office, run.runId)?.baseSha ?? run.startSha;
    const show = (sha: string) =>
      this.#deps.story.showAt(officeId, worktree, sha, "package.json").catch(() => null);
    const baseScripts = baseSha === null ? {} : scriptsOf(await show(baseSha));
    const branchScripts = scriptsOf(await show(`refs/heads/${run.branch}`));
    const changes = gateChanges({ baseScripts, branchScripts, base, branch: base });
    ctx.office.immediate(() => recordGateChanges(ctx.office, run.runId, changes));
  }

  async summarize(
    office: OfficeHandle,
    run: StoredRun,
    report: WorkerReport | null,
  ): Promise<void> {
    const diffstat = await this.#diffstat(office.officeId, run);
    office.immediate(() =>
      storeRunSummary(office, run.runId, { report, diffstat, at: this.#deps.clock.now() }),
    );
    // The decision notes of the report that ended the run: those that check out are kept for the
    // maintainer; no turn is left to send a miss back (DIPO-186).
    const notes = report?.decisionNotes ?? [];
    if (notes.length > 0) {
      const { misses } = await this.#checkNotes(office, run, notes);
      if (misses.length > 0) {
        this.#deps.warn?.("decision notes that do not check out were left out", {
          run: run.runId,
          notes: misses.length,
        });
      }
    }
  }

  async #diffstat(office: OfficeId, run: StoredRun): Promise<string> {
    if (run.worktree === null || run.startSha === null) return "";
    try {
      // The run's changes are its part commits on the branch; its Mac worktree holds none of them.
      return await this.#deps.story.diffstat(
        office,
        run.worktree,
        run.startSha,
        run.branch ?? undefined,
      );
    } catch (error) {
      this.#deps.warn?.("the run diffstat could not be read", {
        run: run.runId,
        reason: messageOf(error),
      });
      return "";
    }
  }

  /** The steps at In Review once the last part is in; the run's end is claimed. */
  async #commit(
    ctx: TurnContext,
    input: {
      readonly report: WorkerReport;
      readonly view: { taskFile: string; title: string; criteria: readonly number[] };
      readonly loop: number;
    },
  ): Promise<TurnDecision> {
    const { run } = ctx;
    const officeId = ctx.office.officeId;
    const worktree = run.worktree as string;
    const story = run.story as string;
    const git = this.#deps.story;
    try {
      const known = new Set(input.view.criteria);
      const met = [
        ...new Set(input.report.criteria.filter((c) => c.met && known.has(c.n)).map((c) => c.n)),
      ].toSorted((a, b) => a - b);
      await git.markInReview(officeId, {
        worktree,
        story,
        taskFile: input.view.taskFile,
        criteria: met,
      });
    } catch (error) {
      if (isTaskFieldError(error)) return scopePark(error.message);
      return {
        kind: "park",
        reason: "worker-failed",
        detail: `dipo could not commit the verified work: ${messageOf(error)}`,
        endKind: "interrupted",
      };
    }
    const push = await git
      .push(officeId, run.branch as string)
      .catch((error: unknown) => ({ pushed: false, rejected: false, error: messageOf(error) }));
    if (push.rejected) {
      return {
        kind: "park",
        reason: "conflict",
        detail: `${push.error ?? "the push was rejected"}; the remote branch has commits the story branch lacks`,
        endKind: "conflict",
      };
    }
    // The dependency files the run committed (DIPO-84), from its parts on the branch.
    const committed =
      run.startSha === null
        ? []
        : await git.changedFiles(officeId, run.branch as string, run.startSha).catch(() => []);
    const diffstat = await this.#diffstat(officeId, run);
    ctx.flushOutput();
    ctx.write(() => {
      const office = ctx.office;
      const at = this.#deps.clock.now();
      storeRunSummary(office, run.runId, { report: input.report, diffstat, at });
      // The In Review push on the remote, at the run's end, or no remote to push to (DIPO-315): the
      // review starts only then, and the PR poll pushes again a run without either.
      recordBranchPush(office, run.branch as string, push, at);
      // A done turn that crossed a cap: its cap step is written with the run's end (DIPO-222).
      if (ctx.capped != null) {
        appendRunStep(office, run.runId, "cap", `${ctx.capped.cap}: ${ctx.capped.detail}`, at);
      }
      endRunMarked(office, run.runId, at, IN_REVIEW_END);
      const key = run.key as StoryKey;
      const current = storyView(office, key);
      const view = deriveStoryView({
        key,
        story: current?.story ?? StoryId.parse(story),
        title: current?.title ?? input.view.title,
        lifecycle: "In Review",
        ...(current?.tier === undefined ? {} : { tier: current.tier }),
        ...(current?.pr === undefined ? {} : { pr: current.pr }),
      });
      const entries: NewEntry[] = [
        {
          type: "story.state",
          key,
          run: run.runId,
          delta: { story, key, from: "In Progress", to: "In Review", view },
        },
      ];
      // Dependency files the run committed (DIPO-84), from the committed paths; no model involved.
      const dependencies = dependencyFiles(committed);
      if (dependencies.length > 0) {
        entries.push({
          type: "engine.notice",
          key,
          run: run.runId,
          delta: {
            level: "warn",
            code: VERIFY_NOTICES.dependenciesChanged,
            text: dependenciesChangedText(story, dependencies),
          },
        });
      }
      if (push.error !== null) {
        entries.push({
          type: "engine.notice",
          key,
          run: run.runId,
          delta: {
            level: "warn",
            code: VERIFY_NOTICES.pushFailed,
            text: `${story} is In Review, but ${push.error}; the branch is on this machine only until a later push succeeds.`,
          },
        });
      }
      return entries;
    });
    // 6. The story PR: opened, or updated when an earlier push already opened it (0019 section 3).
    if (push.pushed) await this.#deps.storyPr?.sync(officeId, run.runId);
    else if (push.error !== null) this.#deps.storyPr?.pushHeld?.(officeId, run.runId);
    return { kind: "ended" };
  }
}

/** True when the story's task file was refused for fields dipo does not know (0021 section 14). */
function isTaskFieldError(error: unknown): error is GitError {
  return error instanceof GitError && error.code === TASK_FIELD_ERROR;
}

function scopePark(detail: string): TurnDecision {
  return { kind: "park", reason: "scope-violation", detail, endKind: "scope-violation" };
}

/** Loops started so far in the run (0-based index of the current verify pass). */
function loopsOf(office: OfficeHandle, runId: RunId): number {
  return (
    office.get<{ n: number }>(
      `select count(*) as n from run_steps where office_id = $office_id and run_id = $run
        and kind = 'loop'`,
      { run: runId },
    )?.n ?? 0
  );
}

/** The value of the `loop` step a report gate refusal writes (0002). */
export const REPORT_GATE_LOOP = "report-gate";

export { VERIFY_LOOP };

/** The line before a red verify's evidence. */
export const VERIFY_IN_BOX_INTRO =
  "dipo ran the project's verify in your box after your done report, and it failed. Fix what it shows, then report done again.";

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "error";
}
