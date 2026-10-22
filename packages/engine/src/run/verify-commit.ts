// Verify and commit at In Review (DIPO-49; 0010 section 7, 0014 sections 3 and 7, 0008 section 2,
// 0013 section 5, 0007 section 4). Run control (DIPO-50) calls `afterTurn` once per worker turn,
// one at a time per run, unless the turn already ended the run (a cap or a blocked report):
//
// 1. Backstop. The worktree's HEAD, checked-out branch, the stash and
//    `git status --porcelain -- backlog .dipo` are compared with the run-start snapshot
//    (`backstop.ts`); any change parks `scope-violation` with the evidence.
// 2. Only a turn whose report is `done` goes on. Scope check: every modified, staged and untracked
//    path from `git status --porcelain=v1 -z --untracked-files=all` must be covered by the run's
//    declared scope (a scope path covers a path it equals or that lies under it), be the story's
//    own task file, or be a lockfile paired with an in-scope manifest: a lockfile beside an in-scope
//    `package.json`, and the root lockfile for an in-scope workspace manifest. Any other path parks
//    `scope-violation` with the paths and the declared scope (0014 section 7).
// 3. Verify. The branch's verify comes from a code-only scan of the worktree (the stored base
//    profile when the fingerprints match). When the branch changed a gate script (`test`, `lint`,
//    `typecheck`, `verify`: the root `package.json` script or the resolved command list) against
//    the base, the changes are recorded on the run and the base profile's verify also runs when its
//    commands differ. Each command list runs through DIPO-37's sandboxed step with the verify policy
//    (network closed) and the run environment; `work.phase verify` is emitted first, keep-awake
//    holds while it runs, its output is stored as source `verify` and emitted as `work.output`
//    while it arrives, and each list gets a `verify_results` row (exit code, duration, output range).
// 4. Red. A verify feedback item (DIPO-47) with the failing command, exit code, output tail and
//    parsed `file:line` locations is returned for run control to send as the next user message; a
//    loop step is recorded, so `Progress.loop` increases and `verify` shows `failing`. When the red
//    verifies of the run reach the tier loop cap, the story parks `verify-failing` instead. A done
//    turn that crossed a run cap (DIPO-205) has no turn left for feedback: its red verify parks
//    `verify-failing` with cause `capped` and the failure as detail, also at the loop cap. A verify
//    that could not start in the sandbox parks `verify-failing` at once: it never runs unsandboxed.
// 5. Green. The run claims its end (a cap or `work.stop` after this waits for it). Exactly the
//    scope paths and paired lockfiles are staged and committed with the worker's subject plus the
//    story id; the code tree key is recorded on the green results; the Backlog CLI checks off the
//    criteria the report marks met and sets In Review, committed alone as `<ID>: status In Review`;
//    the branch is pushed without force. Then, in one transaction, the run ends at In Review with
//    its outcome row (`endRun`) and summary, a push that reached the remote is recorded on the
//    claim at the run's end (`claims.pushed_at`), and `story.state` moves the story to In Review. A
//    non-fast-forward push rejection parks `conflict` (0010); any other push failure is a notice and
//    the story stays In Review with the branch local. A failure in the commit steps parks
//    `interrupted` with the error. A commit that holds dependency files (manifests, lockfiles,
//    `requirements*.txt`) raises `verify.dependenciesChanged` naming them (DIPO-84).
// 6. The story PR (DIPO-144; 0019 section 3). After a push that reached the remote, `storyPr.sync`
//    opens the story's ready PR, or updates the one it has. It never fails the commit: a failed
//    create is a `pr.openFailed` notice and a retry poll, and the story stays In Review.
//
// A box run (DIPO-273; 0021 sections 8 and 13) has no backstop and no scope check, and dipo runs
// no verify for it (0021 amendment of 2026-10-22, DIPO-299): the worker runs the office's verify in
// its box before it reports done, and CI on the story PR is the verify. At done, in one held turn
// of the run's parts (`BoxParts.finishLast`), so no part moves the branch meanwhile: the last part
// is delivered (a hit, a refused part or a rejected push parks), the gate changes of the branch are
// recorded for the review, and the run's end is claimed while the parts are still held, so a part
// or catch-up queued meanwhile finds the run not live and stays in the box. Just before In Review
// the branch must still be at the last part's commit, else the story parks (`BOX_TIP_MOVED`). Then
// step 5 with nothing staged (the parts are the commits) and step 6: the push opens or updates the
// story PR, and the review (a pending review of the reviewer place) and CI (the PR poll's watch of
// the pushed head, `StoryPrs`) start together on that head (0019 section 7). Red CI goes back to
// the worker through the CI loop of 0019 section 8 (`mergeSlot.ciAttempts`, parked `verify-failing`
// with cause `ci` at the cap). No verify loop step is written, so the tier's loop cap never parks a
// box run.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type Clock,
  type OfficeId,
  type ParkReason,
  type Progress,
  type RunId,
  StoryId,
  type StoryKey,
  type WorkRef,
} from "@dipsaus-orchestrator/contract";

import { TASK_FIELD_ERROR } from "../backlog/runner";
import type { NewEntry } from "../changelog/log";
import type { OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import { GitError } from "../git/runner";
import { verifyFeedback } from "../prompts/feedback";
import type { StepRequest, StepResult } from "../sandbox/step";
import { shownSpec } from "../scan/diff";
import {
  type CapabilityName,
  type CommandSpec,
  detect,
  fingerprint,
  readProbe,
  type RunProfile,
} from "../scan/detect";
import { LOCKFILES, parseManifest } from "../scan/detect/manifest";
import { deriveStoryView, storyView } from "../views/story";
import { runProgress } from "../views/work";
import type { WorkerReport } from "../workers/types";
import { type LastPartAccess, type LastPartFinish, partPark } from "../box/parts";
import { findClaim, updateClaim } from "../worktree/records";
import { buildRunEnv } from "../worktree/run-env";

import { type BackstopSnapshot, backstopDetail, backstopEvidence } from "./backstop";
import { endRunMarked, markPhase } from "./markers";
import { type FiredCap, runCaps } from "./caps";
import { PARK_CAUSES } from "./park";
import { appendRunStep, IN_REVIEW_END, recordGateChanges, type StoredRun } from "./records";
import type { StoryGit } from "./story-git";
import {
  appendVerifyOutput,
  insertVerifyResult,
  recordCodeTreeKey,
  storeRunSummary,
  verifyOutputEnd,
  type VerifyProfile,
} from "./verify-records";

/** The verify deadline shown in the timeout text when `timeouts.scriptMinutes` names none. */
export const VERIFY_MINUTES_DEFAULT = 20;

/**
 * The park detail when the story branch moved off the last part's commit after a box run claimed
 * its end at done: In Review is written only at the commit the last part left.
 */
export const BOX_TIP_MOVED =
  "the story branch moved off the last part's commit before In Review, so dipo did not move the story to review; In Review is written only at the commit the last part left.";

/** How verify runs its commands: on the Mac in the sandboxed step. */
interface VerifyRunner {
  run(command: [string, ...string[]], onOutput: (text: string) => void): Promise<StepResult>;
  /** The verify deadline in minutes, for the timeout text. */
  readonly minutes: number;
}

/** `engine.notice` codes of verify and commit. */
export const VERIFY_NOTICES = {
  pushFailed: "verify.pushFailed",
  dependenciesChanged: "verify.dependenciesChanged",
} as const;

/**
 * Dependency files (DIPO-84): manifests and lockfiles of the package managers workers may install
 * with. A commit that changes one raises `verify.dependenciesChanged`, so the maintainer sees new
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

/** Pure: the notice text of a commit that changed dependency files. */
export function dependenciesChangedText(story: string, files: readonly string[]): string {
  return `${story} changed dependency files: ${files.join(", ")}. Review the added or changed packages before you merge.`;
}

/** Gate capabilities whose change makes the base verify run too (0013 section 5). */
export const GATE_CAPABILITIES: readonly CapabilityName[] = ["test", "lint", "typecheck", "verify"];

/** Lockfile names paired with manifests (0014 section 3, 0010 amendment). */
export const DEFAULT_LOCKFILES: readonly string[] = LOCKFILES.map(([name]) => name);

/** How long verify output is buffered before it is stored and emitted. */
export const OUTPUT_FLUSH_MS = 500;

// ---- pure rules ----------------------------------------------------------------------------------

/** True when the scope path `scope` covers `path`: equal, or `path` lies under it. */
export function scopeCovers(scope: string, path: string): boolean {
  const dir = scope.endsWith("/") ? scope : `${scope}/`;
  return path === scope || path.startsWith(dir);
}

function dirOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export interface ScopeInput {
  /** Changed paths, repo-relative. */
  readonly paths: readonly string[];
  readonly scope: readonly string[];
  /** The story's own task file, repo-relative. */
  readonly taskFile: string;
  readonly lockfiles?: readonly string[];
  /** Workspace package directories of the run profile; their manifests pair the root lockfile. */
  readonly workspaceDirs?: readonly string[];
}

export interface ScopeResult {
  /** In-scope paths and paired lockfiles: what the code commit stages, sorted. */
  readonly code: readonly string[];
  /** Paths outside scope, sorted. */
  readonly outside: readonly string[];
}

/** Pure: the scope check at `done` (0010 section 7, 0014 section 3 with lockfile pairing). */
export function checkScope(input: ScopeInput): ScopeResult {
  const lockfiles = new Set(input.lockfiles ?? DEFAULT_LOCKFILES);
  const inScope = (path: string) => input.scope.some((scope) => scopeCovers(scope, path));
  const manifestIn = (dir: string) => inScope(dir === "" ? "package.json" : `${dir}/package.json`);
  const paired = (path: string): boolean => {
    if (!lockfiles.has(baseName(path))) return false;
    const dir = dirOf(path);
    if (manifestIn(dir)) return true;
    // Bun workspaces have one root lockfile: it pairs with any in-scope workspace manifest.
    return dir === "" && (input.workspaceDirs ?? []).some((ws) => manifestIn(ws));
  };
  const code: string[] = [];
  const outside: string[] = [];
  for (const path of new Set(input.paths)) {
    // Only the story's own task file is exempt: dipo writes it, so it is never a scope path.
    if (path === input.taskFile) continue;
    if (inScope(path) || paired(path)) code.push(path);
    else outside.push(path);
  }
  return { code: code.toSorted(), outside: outside.toSorted() };
}

/** The park detail of a scope violation at `done` (0014 section 7, scope feedback). */
export function scopeDetail(outside: readonly string[], scope: readonly string[]): string {
  return `Paths written outside the declared scope: ${outside.join(", ")}. Declared scope: ${scope.length === 0 ? "none" : scope.join(", ")}. The story's own task file, written by dipo, is exempt from scope.`;
}

function shownCapability(profile: RunProfile, name: CapabilityName): string {
  const capability = profile.capabilities[name];
  if (capability.status === "resolved") return shownSpec(capability.value);
  return capability.status;
}

function shownScript(value: string | undefined): string {
  return value === undefined ? "none" : JSON.stringify(value);
}

function resolvedVerify(profile: RunProfile | null): CommandSpec | null {
  const verify = profile?.capabilities.verify;
  return verify?.status === "resolved" ? verify.value : null;
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

/** One command list verify runs. */
export interface VerifyStep {
  readonly profile: VerifyProfile;
  readonly spec: CommandSpec;
}

/**
 * Pure: the command lists verify runs. The branch's resolved verify, else the base's; with gate
 * changes also the base's verify when its commands differ from the branch's.
 */
export function verifyPlan(input: {
  readonly base: RunProfile | null;
  readonly branch: RunProfile;
  readonly changed: boolean;
}): VerifyStep[] {
  const branch = resolvedVerify(input.branch);
  const base = resolvedVerify(input.base);
  const steps: VerifyStep[] = [];
  if (branch !== null) steps.push({ profile: "branch", spec: branch });
  if (
    base !== null &&
    (branch === null || (input.changed && shownSpec(base) !== shownSpec(branch)))
  )
    steps.push({ profile: "base", spec: base });
  return steps;
}

/** Pure: the code commit message, the worker's subject plus the story id. */
export function commitMessage(story: string, subject: string, title: string): string {
  const first = subject.split("\n")[0]?.trim() ?? "";
  const prefix = `${story}:`;
  const clean = (first.startsWith(prefix) ? first.slice(prefix.length) : first).trim();
  return `${story}: ${clean === "" ? title : clean}`;
}

// ---- the flow ------------------------------------------------------------------------------------

/** What run control decides after a turn. */
export type TurnDecision =
  | { readonly kind: "continue" }
  | {
      readonly kind: "park";
      readonly reason: ParkReason;
      /** Which of the reason's causes parks it (`PARK_CAUSES`, 0020 section 2). */
      readonly cause: string;
      readonly detail: string;
      readonly endKind: string;
    }
  | { readonly kind: "feedback"; readonly text: string }
  /** The run ended at In Review; run control closes the worker's stdin. */
  | { readonly kind: "ended" };

/** What run control gives one turn. */
export interface TurnContext {
  readonly office: OfficeHandle;
  readonly run: StoredRun;
  readonly work: WorkRef;
  readonly report: WorkerReport | null;
  /**
   * The cap this turn crossed while it carried a done report (DIPO-205): no turn is left for
   * verify feedback, so a red verify parks `verify-failing` with cause `capped`.
   */
  readonly capped?: FiredCap | null;
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

/** What run control asks of verify and commit. */
export interface RunFinisher {
  afterTurn(ctx: TurnContext): Promise<TurnDecision>;
  /** Stores the run summary of a run that ended outside `afterTurn` (a park). */
  summarize(office: OfficeHandle, run: StoredRun, report: WorkerReport | null): Promise<void>;
}

export interface VerifyCommitDeps {
  readonly clock: Clock;
  readonly story: StoryGit;
  /** The office's main checkout, whose shared `.git` a step may not write. */
  readonly mainCheckout: (office: OfficeId) => string;
  /** Runs one sandboxed step (`runSandboxedStep` with the daemon's step dependencies). */
  readonly runStep: (request: StepRequest) => Promise<StepResult>;
  readonly config: (office: OfficeId) => OfficeConfig | undefined;
  /** The office's stored run profile (the base profile). */
  readonly profile: (office: OfficeHandle) => RunProfile | null;
  /** A code-only scan of a worktree; `detect(readProbe(dir))` by default. */
  readonly scanWorktree?: (dir: string, base: RunProfile | null) => Promise<RunProfile>;
  readonly host: {
    readonly home: string;
    readonly uid: number;
    readonly env: Readonly<Record<string, string | undefined>>;
  };
  /** Keep-awake: verify registers while it runs (DIPO-63). */
  readonly work?: { beginVerify(): () => void };
  /**
   * The story PR (DIPO-144): called right after an In Review push that reached the remote, to open
   * or update the story's PR. It never throws; a failure is its own notice.
   */
  readonly storyPr?: { sync(office: OfficeId, runId: RunId): Promise<void> };
  /**
   * Box runs (DIPO-273 and DIPO-299, 0021 sections 8 and 13 and its amendment of 2026-10-22): a
   * run whose developer works in a box has no backstop, no scope check and no verify; at done its
   * undelivered changes become a last part, a part hit parks, and the run's end is claimed while
   * the run's parts are held (`BoxParts.finishLast`). Without it every run takes the Mac path.
   */
  readonly parts?: {
    isBoxRun(office: OfficeId, run: StoredRun): boolean;
    finishLast<T>(
      runId: string,
      message: string,
      finish: (last: LastPartAccess) => Promise<T>,
    ): Promise<LastPartFinish<T>>;
  };
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

/** The default worktree scan: the base profile when the fingerprints match, else `detect`. */
export async function scanWorktree(dir: string, base: RunProfile | null): Promise<RunProfile> {
  const probe = await readProbe(dir);
  if (base !== null && base.fingerprint === fingerprint(probe)) return base;
  return detect(probe);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function scriptsOf(text: string | null): Record<string, string> {
  return text === null ? {} : { ...parseManifest(text)?.scripts };
}

interface PassResult {
  readonly passed: boolean;
  /** The failing command and its output, for the feedback item. */
  readonly failure: { command: string; exitCode: number; output: string } | null;
  /** Why verify could not run at all; parks at once. */
  readonly refused: string | null;
}

export class VerifyCommit implements RunFinisher {
  readonly #deps: VerifyCommitDeps;

  constructor(deps: VerifyCommitDeps) {
    this.#deps = deps;
  }

  async afterTurn(ctx: TurnContext): Promise<TurnDecision> {
    const { run } = ctx;
    const officeId = ctx.office.officeId;
    const worktree = run.worktree;
    const story = run.story;
    if (run.kind !== "story" || worktree === null || story === null) return { kind: "continue" };
    // A box worker never reaches the story's Mac worktree, and dipo's part commits move its HEAD.
    const box = this.#deps.parts?.isBoxRun(officeId, run) === true;

    // 1. The backstop after every turn, for a worker on the Mac.
    if (ctx.snapshot !== null && !box) {
      try {
        const now = await this.#deps.story.snapshot(officeId, worktree);
        const evidence = backstopEvidence(ctx.snapshot, now);
        if (evidence.length > 0) return scopePark(PARK_CAUSES.backstop, backstopDetail(evidence));
      } catch (error) {
        if (error instanceof GitError && error.code === "git.worktreeTampered") {
          return scopePark(PARK_CAUSES.tampered, error.message);
        }
        throw error;
      }
    }
    if (ctx.report?.status !== "done" || !ctx.live()) return { kind: "continue" };
    const report = ctx.report;

    // 1b. A box run: its last part, then In Review with no verify of dipo's (DIPO-299).
    if (box) return this.#boxDone(ctx, report);

    // 2. The scope check over every changed path, for a worker on the Mac; a box run has none
    // (0021 section 13), only the protected-file check of its parts.
    const scope = run.scope ?? [];
    const base = this.#deps.profile(ctx.office);
    // The branch scan comes first: a workspace package the story adds pairs the root lockfile too.
    // A failed scan never hides a scope violation: pairing then uses the base workspaces, and
    // the scan error surfaces only once the paths are in scope.
    const scanned = await (this.#deps.scanWorktree ?? scanWorktree)(worktree, base).then(
      (profile) => ({ profile, error: null }),
      (error: unknown) => ({ profile: null, error }),
    );
    let view: Awaited<ReturnType<StoryGit["story"]>>;
    try {
      view = await this.#deps.story.story(officeId, worktree, story);
    } catch (error) {
      if (isTaskFieldError(error)) return scopePark(PARK_CAUSES.taskFile, error.message);
      throw error;
    }
    let code: readonly string[] = [];
    if (!box) {
      const paths = await this.#deps.story.changedPaths(officeId, worktree);
      const checked = checkScope({
        paths,
        scope,
        taskFile: view.taskFile,
        workspaceDirs:
          scanned.profile === null
            ? (base?.toolchain.workspaces.map((ws) => ws.dir) ?? [])
            : workspaceDirsOf(base, scanned.profile),
      });
      if (checked.outside.length > 0) {
        return scopePark(PARK_CAUSES.paths, scopeDetail(checked.outside, scope));
      }
      code = checked.code;
    }
    if (!ctx.live()) return { kind: "continue" };

    // 3. Verify.
    const config = this.#deps.config(officeId);
    if (config === undefined) throw new Error(`office ${officeId} has no configuration loaded`);
    if (scanned.profile === null) throw scanned.error;
    const steps = await this.#plan(ctx, base, scanned.profile);
    const loop = loopsOf(ctx.office, run.runId);
    ctx.flushOutput();
    ctx.write(() => {
      const marker = markPhase(ctx.office, run.runId, "verify", this.#deps.clock.now());
      return [...marker, phaseEntry(ctx, "verify")];
    });
    const done = this.#deps.work?.beginVerify();
    let pass: PassResult;
    try {
      pass = await this.#verify(ctx, config, steps, loop, this.#macRunner(ctx, config));
    } finally {
      done?.();
    }
    const red = this.#red(ctx, config, pass, loop, worktree);
    if (red !== null) return red;

    // 5. Green.
    if (!ctx.claimEnd()) return { kind: "continue" };
    return this.#commit(ctx, { report, view, code, loop, box });
  }

  /**
   * The red side of a verify pass (step 4), or null for a green one: a verify that could not run
   * parks at once; a red one is the next message to the worker, or parks at a cap or the loop cap.
   * `root` is where the output's paths are relative to.
   */
  #red(
    ctx: TurnContext,
    config: OfficeConfig,
    pass: PassResult,
    loop: number,
    root: string,
  ): TurnDecision | null {
    const { run } = ctx;
    if (pass.refused !== null) {
      return {
        kind: "park",
        reason: "verify-failing",
        cause: PARK_CAUSES.refused,
        detail: `verify could not run: ${pass.refused}`,
        endKind: "verify-failing",
      };
    }
    if (!ctx.live()) return { kind: "continue" };
    if (pass.passed) return null;
    const failure = pass.failure ?? { command: "verify", exitCode: 1, output: "" };
    const item = verifyFeedback(
      {
        step: "verify",
        command: failure.command,
        exitCode: failure.exitCode,
        output: failure.output,
      },
      { root, itemMax: feedbackItemMax(config, run.tier) },
    );
    // A done turn that crossed a cap has no turn left for feedback; `capped` wins over `loops`.
    if (ctx.capped != null) {
      return {
        kind: "park",
        reason: "verify-failing",
        cause: PARK_CAUSES.capped,
        detail: item.text,
        endKind: "verify-failing",
      };
    }
    const loopCap = runCaps(ctx.office, run).loopCap;
    if (loop + 1 >= loopCap) {
      return {
        kind: "park",
        reason: "verify-failing",
        cause: PARK_CAUSES.loops,
        detail: `verify failed ${loop + 1} of ${loopCap} times (the tier loop cap). ${item.text}`,
        endKind: "verify-failing",
      };
    }
    ctx.write(() => {
      const at = this.#deps.clock.now();
      appendRunStep(ctx.office, run.runId, "loop", String(loop + 1), at);
      const marker = markPhase(ctx.office, run.runId, "build", at);
      return [...marker, phaseEntry(ctx, "build")];
    });
    return { kind: "feedback", text: item.text };
  }

  /**
   * A box run at done (DIPO-273 and DIPO-299; 0021 section 8 and its amendment of 2026-10-22). In
   * one held turn of the run's parts (`parts.finishLast`): the parts still queued and then what
   * changed since are delivered as the last part; then the branch's gate changes are recorded and
   * the run's end is claimed while the parts are still held. A hit, a refused part or a rejected
   * push parks. dipo runs no verify: the story moves to review at the last part's commit, and the
   * push starts the review and CI on it. A failure to take the last part parks `interrupted` with a
   * fixed text and the error's code: its message may quote the box's output.
   */
  async #boxDone(ctx: TurnContext, report: WorkerReport): Promise<TurnDecision> {
    const { run } = ctx;
    const parts = this.#deps.parts as NonNullable<VerifyCommitDeps["parts"]>;
    // What `finish` threw is kept apart from a failure to take the last part.
    let thrown: { readonly error: unknown } | null = null;
    let done: LastPartFinish<LastPartAccess | null>;
    try {
      done = await parts.finishLast(run.runId, report.commitSubject, async (last) => {
        try {
          if (!ctx.live()) return null;
          await this.#boxGateChanges(ctx, this.#deps.profile(ctx.office));
          // Claimed while the parts are still held, so a part the door queued meanwhile, or a
          // catch-up, finds the run not live and stays queued in the box.
          return ctx.claimEnd() ? last : null;
        } catch (error) {
          thrown = { error };
          return null;
        }
      });
    } catch (error) {
      this.#deps.warn?.("the last part could not be delivered", {
        run: run.runId,
        reason: messageOf(error),
      });
      const code = (error as { code?: unknown } | null)?.code;
      return {
        kind: "park",
        reason: "interrupted",
        cause: PARK_CAUSES.build,
        detail: `dipo could not take the last part out of the box (${typeof code === "string" ? code : "error"}); nothing of it was committed.`,
        endKind: "interrupted",
      };
    }
    if (thrown !== null) throw (thrown as { readonly error: unknown }).error;
    const park = partPark(done.outcome);
    if (park !== null) return { kind: "park", ...park, endKind: park.reason };
    const last = done.finished?.result ?? null;
    if (last === null) return { kind: "continue" };

    let view: Awaited<ReturnType<StoryGit["story"]>>;
    try {
      view = await this.#deps.story.story(ctx.office.officeId, run.worktree as string, run.story!);
    } catch (error) {
      if (isTaskFieldError(error)) return scopePark(PARK_CAUSES.taskFile, error.message);
      throw error;
    }
    // A second layer: the branch must still be at the last part's commit. Run control sends no
    // feedback once the end is claimed, so a moved tip parks; nothing moves it in the held turn.
    const now = await last.branchTip().catch(() => null);
    if (now !== last.tip) {
      return {
        kind: "park",
        reason: "interrupted",
        cause: PARK_CAUSES.build,
        detail: BOX_TIP_MOVED,
        endKind: "interrupted",
      };
    }
    return this.#commit(ctx, {
      report,
      view,
      code: [],
      loop: loopsOf(ctx.office, run.runId),
      box: true,
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

  /** Verify on the Mac: DIPO-37's sandboxed step with the verify policy, in the worktree. */
  #macRunner(ctx: TurnContext, config: OfficeConfig): VerifyRunner {
    const { run } = ctx;
    const worktree = run.worktree as string;
    let env: Readonly<Record<string, string>> | null = null;
    return {
      // Without a `verify` entry the step does not start, so it never times out.
      minutes: config.timeouts.scriptMinutes["verify"] ?? VERIFY_MINUTES_DEFAULT,
      run: (command, onOutput) => {
        env ??= this.#runEnv(ctx, config, worktree);
        return this.#deps.runStep({
          kind: "verify",
          script: "verify",
          command,
          worktree,
          mainCheckout: this.#deps.mainCheckout(ctx.office.officeId),
          home: this.#deps.host.home,
          uid: this.#deps.host.uid,
          sandbox: {
            installCachePaths: config.sandbox.installCachePaths,
            registryHosts: config.sandbox.registryHosts,
          },
          scriptMinutes: config.timeouts.scriptMinutes,
          env: this.#deps.host.env,
          extraEnv: env,
          onOutput,
        });
      },
    };
  }

  #runEnv(ctx: TurnContext, config: OfficeConfig, worktree: string): Record<string, string> {
    const { run } = ctx;
    return buildRunEnv({
      slot: run.slot ?? 0,
      stride: config.worktree.ports.stride,
      story: run.story as string,
      worktree,
      named: config.worktree.ports.named,
      devPort: devPortOf(this.#deps.profile(ctx.office)),
      env: config.worktree.env,
    });
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
  }

  async #diffstat(office: OfficeId, run: StoredRun): Promise<string> {
    if (run.worktree === null || run.startSha === null) return "";
    try {
      // A box run's changes are its part commits; its Mac worktree holds none of them.
      const box = this.#deps.parts?.isBoxRun(office, run) === true;
      return await this.#deps.story.diffstat(
        office,
        run.worktree,
        run.startSha,
        box && run.branch !== null ? run.branch : undefined,
      );
    } catch (error) {
      this.#deps.warn?.("the run diffstat could not be read", {
        run: run.runId,
        reason: messageOf(error),
      });
      return "";
    }
  }

  /** The verify steps and the gate changes, recorded on the run. */
  async #plan(
    ctx: TurnContext,
    base: RunProfile | null,
    branch: RunProfile,
  ): Promise<VerifyStep[]> {
    const { run } = ctx;
    const worktree = run.worktree as string;
    const officeId = ctx.office.officeId;
    const claim = findClaim(ctx.office, run.runId);
    const baseSha = claim?.baseSha ?? run.startSha;
    const baseScripts =
      baseSha === null
        ? {}
        : scriptsOf(await this.#deps.story.showAt(officeId, worktree, baseSha, "package.json"));
    const branchScripts = scriptsOf(
      await readFile(join(worktree, "package.json"), "utf8").catch(() => null),
    );
    const changes = gateChanges({ baseScripts, branchScripts, base, branch });
    ctx.office.immediate(() => recordGateChanges(ctx.office, run.runId, changes));
    return verifyPlan({ base, branch, changed: changes.length > 0 });
  }

  /** Runs every verify step through `runner`; stops at the first failing command. */
  async #verify(
    ctx: TurnContext,
    config: OfficeConfig,
    steps: readonly VerifyStep[],
    loop: number,
    runner: VerifyRunner,
  ): Promise<PassResult> {
    const { run } = ctx;
    if (steps.length === 0) {
      return { passed: false, failure: null, refused: "the run profile has no resolved verify" };
    }
    for (const step of steps) {
      if (step.spec.cwd !== ".") {
        return {
          passed: false,
          failure: null,
          refused: `verify runs in ${step.spec.cwd}, but dipo runs verify only at the worktree root`,
        };
      }
      const sink = new OutputSink(ctx, this.#deps.clock);
      const started = this.#deps.clock.now();
      let exited: (StepResult & { outcome: "exited" }) | null = null;
      let failure: PassResult["failure"] = null;
      for (const command of step.spec.commands) {
        const [program, ...args] = command;
        if (program === undefined) continue;
        const shown = shownSpec({ commands: [command], cwd: "." });
        sink.write(`$ ${shown}\n`);
        const result = await runner.run([program, ...args], (text) => sink.write(text));
        if (result.outcome === "startFailed") {
          sink.write(`dipo: verify did not start: ${result.reason}\n`);
          sink.close();
          return { passed: false, failure: null, refused: result.reason };
        }
        exited = result;
        if (result.timedOut || result.code !== 0) {
          const why = result.timedOut ? `\n[dipo: timed out after ${runner.minutes} min]` : "";
          failure = {
            command: shown,
            exitCode: result.code ?? -1,
            output: `${result.stdout.text}${result.stderr.text}${why}`,
          };
          break;
        }
      }
      const range = sink.close();
      const passed = failure === null;
      ctx.write(() => {
        insertVerifyResult(ctx.office, run.runId, {
          loop,
          profile: step.profile,
          commands: step.spec.commands,
          exitCode: exited?.code ?? (passed ? 0 : null),
          signal: exited?.signal ?? null,
          timedOut: exited?.timedOut ?? false,
          passed,
          durationMs: this.#deps.clock.now() - started,
          outputFrom: range.from,
          outputTo: range.to,
          at: this.#deps.clock.now(),
        });
        return [progressEntry(ctx)];
      });
      if (failure !== null) return { passed: false, failure, refused: null };
    }
    return { passed: true, failure: null, refused: null };
  }

  /** The commit steps of a green verify; the run's end is claimed. */
  async #commit(
    ctx: TurnContext,
    input: {
      readonly report: WorkerReport;
      readonly view: { taskFile: string; title: string; criteria: readonly number[] };
      readonly code: readonly string[];
      readonly loop: number;
      /** A box run: its code arrived in parts, so nothing is staged here. */
      readonly box: boolean;
    },
  ): Promise<TurnDecision> {
    const { run } = ctx;
    const officeId = ctx.office.officeId;
    const worktree = run.worktree as string;
    const story = run.story as string;
    const git = this.#deps.story;
    try {
      if (!input.box) {
        await git.commitPaths(
          officeId,
          worktree,
          input.code,
          commitMessage(story, input.report.commitSubject, input.view.title),
        );
      }
      const key = await git.codeTreeKey(officeId, worktree, input.view.taskFile);
      ctx.office.immediate(() => recordCodeTreeKey(ctx.office, run.runId, input.loop, key));
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
      if (isTaskFieldError(error)) return scopePark(PARK_CAUSES.taskFile, error.message);
      return {
        kind: "park",
        reason: "interrupted",
        cause: PARK_CAUSES.build,
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
        cause: PARK_CAUSES.pushRejected,
        detail: `${push.error ?? "the push was rejected"}; the remote branch has commits the story branch lacks`,
        endKind: "conflict",
      };
    }
    // The dependency files the run committed (DIPO-84): a box run's from its parts on the branch.
    const committed =
      input.box && run.startSha !== null
        ? await git.changedFiles(officeId, run.branch as string, run.startSha).catch(() => [])
        : input.code;
    const diffstat = await this.#diffstat(officeId, run);
    ctx.flushOutput();
    ctx.write(() => {
      const office = ctx.office;
      const at = this.#deps.clock.now();
      storeRunSummary(office, run.runId, { report: input.report, diffstat, at });
      // The In Review push on the remote, at the run's end: the PR poll retries only such a run.
      if (push.pushed) updateClaim(office, run.runId, { pushedAt: at });
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
    return { kind: "ended" };
  }
}

/** Workspace package directories of the base and the branch profile, each once. */
export function workspaceDirsOf(base: RunProfile | null, branch: RunProfile): string[] {
  const dirs = [...(base?.toolchain.workspaces ?? []), ...branch.toolchain.workspaces];
  return [...new Set(dirs.map((ws) => ws.dir))];
}

/** The feedback item budget of the run's tier, the `M` entry when the tier has none. */
export function feedbackItemMax(config: Pick<OfficeConfig, "prompt">, tier: string | null): number {
  const budgets = config.prompt.budgets.feedbackItem as Readonly<Record<string, number>>;
  return (tier === null ? undefined : budgets[tier]) ?? config.prompt.budgets.feedbackItem.M;
}

/** True when the story's task file was refused for fields dipo does not know (0021 section 14). */
function isTaskFieldError(error: unknown): error is GitError {
  return error instanceof GitError && error.code === TASK_FIELD_ERROR;
}

function scopePark(cause: string, detail: string): TurnDecision {
  return { kind: "park", reason: "scope-violation", cause, detail, endKind: "scope-violation" };
}

function devPortOf(profile: RunProfile | null): number | null {
  const ports = profile?.devPorts ?? [];
  return (ports.find((port) => port.dir === ".") ?? ports[0])?.port ?? null;
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

function progressOf(ctx: TurnContext): Progress {
  const progress = runProgress(ctx.office, ctx.run.runId);
  if (progress === null) throw new Error(`run ${ctx.run.runId} is not recorded`);
  return progress;
}

function phaseEntry(ctx: TurnContext, phase: "verify" | "build"): NewEntry {
  return {
    type: "work.phase",
    key: ctx.work.key,
    run: ctx.run.runId,
    delta: { work: ctx.work, phase, progress: progressOf(ctx) },
  };
}

function progressEntry(ctx: TurnContext): NewEntry {
  return {
    type: "work.progress",
    key: ctx.work.key,
    run: ctx.run.runId,
    delta: { work: ctx.work, progress: progressOf(ctx) },
  };
}

/**
 * Verify output on its way to `output_chunks` and `work.output`: buffered for `OUTPUT_FLUSH_MS`,
 * then stored and emitted in one transaction, so a client sees it while verify runs.
 */
class OutputSink {
  readonly #ctx: TurnContext;
  readonly #clock: VerifyCommitDeps["clock"];
  #buffer = "";
  #timer: ReturnType<Clock["setTimeout"]> | null = null;
  #from: number | null = null;
  #to: number | null = null;

  constructor(ctx: TurnContext, clock: VerifyCommitDeps["clock"]) {
    this.#ctx = ctx;
    this.#clock = clock;
  }

  write(text: string): void {
    this.#buffer += text;
    if (this.#timer === null) {
      this.#timer = this.#clock.setTimeout(() => {
        this.#timer = null;
        this.#flush();
      }, OUTPUT_FLUSH_MS);
    }
  }

  #flush(): void {
    const text = this.#buffer;
    if (text === "") return;
    this.#buffer = "";
    const ctx = this.#ctx;
    ctx.write(() => {
      const range = appendVerifyOutput(ctx.office, ctx.run.runId, text, this.#clock.now());
      this.#from ??= range.from;
      this.#to = range.to;
      return [
        {
          type: "work.output",
          key: ctx.work.key,
          run: ctx.run.runId,
          delta: { work: ctx.work, source: "verify", from: range.from, to: range.to, text },
        },
      ];
    });
  }

  /** Stores what is left and returns the byte range of everything written. */
  close(): { readonly from: number; readonly to: number } {
    if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
    this.#flush();
    const end = this.#to ?? verifyOutputEnd(this.#ctx.office, this.#ctx.run.runId);
    return { from: this.#from ?? end, to: end };
  }
}
