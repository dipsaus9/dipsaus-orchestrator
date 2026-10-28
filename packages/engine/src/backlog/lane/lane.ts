// The planning lane (0010 section 2, lane b). Changes that belong to no story PR are journaled,
// applied through the Backlog CLI in the engine's backlog worktree `<root>/_backlog`, committed one
// by one as `backlog: <op> <ID>` on an engine branch `dipo/backlog-<UTC yyyymmddThhmmss>`, and
// pushed. Later operations append to the open branch until its changes are on the base.
//
// Order and atomicity (0010 section 2a "Ordering in the office git queue"):
// - Journaling, with its live-claim check, is one item of the office git queue and one database
//   transaction, before any CLI call. From then on `pendingLaneOp` covers the story.
// - A flush is one queue item from the first git step to the push: every CLI write (status,
//   `writeFields`, `editLabels`) and every git step of the lane runs inside it, so nothing else of
//   the office interleaves. Before it, when the office has a remote, `OfficeGit.fetch` runs as its
//   own item and moves `_base` as usual.
//
// Updating the open branch after the base moved: an operation whose changed files all have, on the
// base, the blob the engine's branch holds has merged. When every operation merged the branch is
// closed. When only some did, or the branch no longer merges cleanly into the base
// (`git merge-tree --write-tree`), the branch is rebuilt: the worktree resets to the base and the
// unmerged operations are re-applied, on a new branch name. A pushed branch is never force-pushed,
// and the old branch is left as it is. An operation that no longer applies is dropped with an
// `engine.notice`.
//
// A branch adopted from an open backlog PR after a lost database (DIPO-80) is journaled with
// `ADOPTED_TARGET`: its commits are known, their target states are not. Later operations append
// to it as usual. When it needs a rebuild, its adopted operations cannot be applied again and are
// dropped with a notice; a branch holding nothing else is let go of (`abandoned`), never closed.
//
// While the open branch's PR has GitHub's auto-merge on (`held`, 0002), a flush does nothing: new
// operations stay journaled and go to the next backlog PR, or onto the branch once auto-merge is off.
//
// Each commit carries the trailer `Dipo-Op: <op id>`, so after a crash between a commit and its
// journal update the commit is found again instead of applied twice.
//
// Steps that may wait on something outside the engine (the commit, which signs as the maintainer
// configured, and the push) are killed after `EXTERNAL_STEP_TIMEOUT_MS` on the injected clock, so
// the office queue never hangs; the operation stays journaled and a `backlog.lane.commitStuck`
// notice names the likely cause. Every failed flush puts an `engine.notice` on the office.

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Clock, OfficeId, StoryKey } from "@dipsaus-orchestrator/contract";

import { appendEntries, type NewEntry } from "../../changelog/log";
import type { OfficeHandle } from "../../db/office";
import { backupStamp } from "../../db/migrations";
import {
  BASE_CHECKOUT_CONFIG,
  BASE_CHECKOUT_ENV,
  type GitLocation,
  WORKTREE_ADD_CONFIG,
} from "../../git/hardened";
import type { GitSession, OfficeGit } from "../../git/office";
import {
  EXTERNAL_STEP_TIMEOUT_MS,
  GitError,
  type GitStepOptions,
  isTimedOut,
} from "../../git/runner";
import {
  commitStaged,
  createBranch,
  deleteBranch,
  pushRef,
  resetWorktree,
  statusPaths,
} from "../../git/write";
import { findStoryByKey } from "../../stories/keys";
import type { BacklogCli } from "../runner";

import {
  type EntryChange,
  findEntry,
  insertEntry,
  isAdoptedTarget,
  type JournalEntry,
  type LaneOp,
  openEntries,
  updateEntry,
} from "./journal";
import type { LaneOpKind } from "./ops";

/** The engine's backlog worktree under the worktree root (0010 section 7). */
export const LANE_WORKTREE = "_backlog";
/** Engine branches of the planning lane: `dipo/backlog-<UTC yyyymmddThhmmss>`. */
export const LANE_BRANCH_PREFIX = "dipo/backlog-";
/** The commit trailer naming the journal entry a commit applies. */
export const OP_TRAILER = "Dipo-Op";

const CHECKOUT: GitStepOptions = { config: BASE_CHECKOUT_CONFIG, env: BASE_CHECKOUT_ENV };

/** `engine.notice` codes of the lane. */
export const LANE_NOTICES = {
  dropped: "backlog.lane.dropped",
  rebuilt: "backlog.lane.rebuilt",
  waiting: "backlog.lane.waiting",
  replayFailed: "backlog.lane.replayFailed",
  flushFailed: "backlog.lane.flushFailed",
  commitStuck: "backlog.lane.commitStuck",
  baseUnset: "backlog.lane.baseUnset",
  adoptedAbandoned: "backlog.lane.adoptedAbandoned",
} as const;

/** Why a commit made by the engine may fail or wait: config the maintainer controls. */
const COMMIT_CAUSE =
  "commit signing (`commit.gpgsign`, `user.signingkey`, `gpg.program`) waiting for a passphrase or a pinentry, or a missing commit identity (`user.name`, `user.email`)";
/** Why a push may wait. */
const PUSH_CAUSE =
  "the remote waiting for credentials (an ssh passphrase or a credential helper prompt)";

/** stderr of a commit that failed on its identity or its signature. */
const COMMIT_CONFIG_FAILURE =
  /Please tell me who you are|unable to auto-detect email|empty ident|gpg failed to sign|failed to write commit object|error: (?:gpg|ssh-keygen|signing)/i;

/** A flush failure that already put its `engine.notice` on the office. */
export class LaneFlushError extends Error {
  constructor(
    readonly code: string,
    message: string,
    override readonly cause: unknown,
  ) {
    super(message);
    this.name = "LaneFlushError";
  }
}

/** An engine commit that timed out, or failed on its identity or signature. */
class StuckCommitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StuckCommitError";
  }
}

/** `text` as one sentence ending in a full stop. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** A lane refusal: the operation was not journaled. */
export class LaneError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "LaneError";
  }
}

/** Why committed operations still wait on the engine branch. */
export type WaitingReason = "noRemote" | "fetchFailed" | "pushFailed";

export interface Waiting {
  readonly branch: string;
  readonly reason: WaitingReason;
  readonly detail: string;
  /** The waiting commits' messages, oldest first. */
  readonly ops: readonly { readonly opId: number; readonly message: string }[];
}

export interface FlushReport {
  /** The open engine branch after the flush, or null when none is open. */
  readonly branch: string | null;
  /** Operations committed in this flush, in order. */
  readonly committed: readonly number[];
  /** Operations found merged on the base, or already in effect there. */
  readonly merged: readonly number[];
  /** Operations that no longer apply, or were already in effect on the open branch. */
  readonly dropped: readonly number[];
  /** The branch this flush replaced with a new one, or null. */
  readonly rebuiltFrom: string | null;
  /** True when the branch was pushed in this flush. */
  readonly pushed: boolean;
  /** What waits for a remote, a fetch or a push; null when nothing does. */
  readonly waiting: Waiting | null;
  /**
   * True when the flush did nothing because the open branch's PR has auto-merge on (0002): new
   * operations stay journaled and go to the next backlog PR, or onto the branch once it is off.
   */
  readonly held?: boolean;
  /**
   * An adopted branch (DIPO-80) that needed a rebuild, which the lane cannot do: its operations'
   * target states were lost with the database. The lane let go of it without a new branch; its PR
   * stays open on the host for the maintainer. Absent or null otherwise.
   */
  readonly abandoned?: string | null;
}

export interface OfficeLaneOptions {
  readonly officeId: OfficeId;
  readonly office: OfficeHandle;
  readonly git: OfficeGit;
  readonly cli: BacklogCli;
  readonly clock: Clock;
  readonly kinds: ReadonlyMap<string, LaneOpKind>;
  /** True when the story has a live claim; such a story belongs to lane a (0010 section 2). */
  readonly liveClaim?: (office: OfficeHandle, key: StoryKey) => boolean;
  /** Called after the lane appended change-log entries outside a command. */
  readonly onChanged?: (office: OfficeId) => void;
  /**
   * Called after each successful flush, outside the git queue item (DIPO-35 opens or updates the
   * backlog PR here and looks for merged ones). It reports its own failures; the flush ignores them.
   */
  readonly onFlushed?: (office: OfficeId, report: FlushReport) => Promise<void>;
  /**
   * The engine branch whose PR has auto-merge on, or null (0002). While a branch is held, a flush
   * applies nothing: operations are journaled and wait until auto-merge is off or the PR merged.
   */
  readonly held?: (office: OfficeId) => string | null;
  /**
   * Reads a story again on the base (the story index's `refreshStory`), for each story whose
   * operation the flush found merged (DIPO-360): the operation stops counting as the story's
   * pending state then (`backlogPark`), so the mirror must hold the base's read at once.
   */
  readonly refreshStory?: (office: OfficeId, key: StoryKey) => Promise<unknown>;
}

export interface BaseRef {
  readonly name: string;
  readonly sha: string;
}

interface RemoteState {
  readonly has: boolean;
  readonly fetched: boolean;
  readonly detail: string;
}

function messageOf(entry: Pick<JournalEntry, "kind" | "subject">): string {
  return `backlog: ${entry.kind} ${entry.subject}`;
}

/** True when `path` lies under `backlog/` or is one of `extra`. */
function inLane(path: string, extra: readonly string[]): boolean {
  return path.startsWith("backlog/") || extra.includes(path);
}

export class OfficeLane {
  readonly officeId: OfficeId;
  readonly #office: OfficeHandle;
  readonly #git: OfficeGit;
  readonly #cli: BacklogCli;
  readonly #clock: Clock;
  readonly #kinds: ReadonlyMap<string, LaneOpKind>;
  readonly #liveClaim: (office: OfficeHandle, key: StoryKey) => boolean;
  readonly #onChanged: (office: OfficeId) => void;
  readonly #onFlushed: ((office: OfficeId, report: FlushReport) => Promise<void>) | undefined;
  readonly #held: (office: OfficeId) => string | null;
  readonly #refreshStory: ((office: OfficeId, key: StoryKey) => Promise<unknown>) | undefined;
  #waiting: Waiting | null = null;

  constructor(options: OfficeLaneOptions) {
    this.officeId = options.officeId;
    this.#office = options.office;
    this.#git = options.git;
    this.#cli = options.cli;
    this.#clock = options.clock;
    this.#kinds = options.kinds;
    this.#liveClaim = options.liveClaim ?? (() => false);
    this.#onChanged = options.onChanged ?? (() => {});
    this.#onFlushed = options.onFlushed;
    this.#held = options.held ?? (() => null);
    this.#refreshStory = options.refreshStory;
  }

  get git(): OfficeGit {
    return this.#git;
  }

  /** `<root>/_backlog`. */
  worktreePath(): string {
    return join(this.#git.worktreeRoot(), LANE_WORKTREE);
  }

  /** What waits on the open branch since the last flush, or null. */
  waiting(): Waiting | null {
    return this.#waiting;
  }

  /**
   * Journals `op` as `pending`, in one queue item and one transaction with its live-claim check,
   * before any CLI call. Throws `LaneError` when the kind is unknown or the story has a live claim.
   */
  journal(op: LaneOp): Promise<JournalEntry> {
    if (!this.#kinds.has(op.kind)) {
      return Promise.reject(
        new LaneError("backlog.lane.unknownKind", `No lane operation kind ${op.kind} is known.`, {
          kind: op.kind,
        }),
      );
    }
    return this.#git.run(async (git) => {
      await this.#assertBase(git);
      return this.#office.immediate(() => {
        if (
          op.releasesClaim !== true &&
          op.key !== undefined &&
          this.#liveClaim(this.#office, op.key)
        ) {
          throw new LaneError(
            "backlog.lane.liveClaim",
            `${op.subject} has a live claim, so its changes travel in its story PR; park it with \`story.park\` first.`,
            { key: op.key, subject: op.subject },
          );
        }
        return insertEntry(this.#office, op, this.#clock.now());
      });
    });
  }

  /**
   * Refuses the lane, with an `engine.notice`, when the office has neither a remote nor a
   * configured `base`: the main checkout's HEAD is the maintainer's, not a base to apply to.
   */
  async #assertBase(git: GitSession): Promise<void> {
    if (this.#git.settings.base !== undefined || (await this.#hasRemote(git))) return;
    const text = `The backlog lane is refused: the office has no remote ${this.#git.settings.remote} and .dipo/office.yaml sets no \`base\`, so the lane has no base branch to apply to. Set \`base\` in .dipo/office.yaml.`;
    this.#write(() => [this.#notice("error", LANE_NOTICES.baseUnset, text)]);
    throw new LaneError(LANE_NOTICES.baseUnset, text, { remote: this.#git.settings.remote });
  }

  /** Journals `op`, then flushes: apply, commit and push every open operation. */
  async submit(
    op: LaneOp,
  ): Promise<{ readonly entry: JournalEntry; readonly report: FlushReport }> {
    const entry = await this.journal(op);
    const report = await this.flush();
    return { entry, report };
  }

  /**
   * Brings the open branch up to date and applies every open operation: fetch (when the office
   * has a remote), drop merged operations, rebuild when needed, apply, commit, push. `rebuild`
   * names a branch GitHub found conflicting with the base: when it is still the open branch, it is
   * rebuilt from the journal. While a branch is held, the flush does nothing and reports `held`;
   * the hold is read again inside the flush item, so a flush that started before auto-merge went
   * on applies nothing once it has.
   */
  async flush(
    options: { readonly replay?: boolean; readonly rebuild?: string } = {},
  ): Promise<FlushReport> {
    const held = this.#heldReport();
    if (held !== null) return held;
    let report: FlushReport;
    try {
      const has = await this.#git.run((git) => this.#hasRemote(git));
      let remote: RemoteState = { has, fetched: false, detail: "" };
      if (has) {
        const outcome = await this.#git.fetch();
        remote = outcome.ok
          ? { has, fetched: true, detail: "" }
          : { has, fetched: false, detail: outcome.error.message };
      }
      report = await this.#git.run(
        async (git) => this.#heldReport() ?? this.#flush(git, remote, options.rebuild ?? null),
      );
    } catch (error) {
      throw this.#failed(error, options.replay === true);
    }
    if (report.held === true) return report;
    await this.#refreshMerged(report.merged);
    // The hook reports its own failures as notices; a failure there is no failed flush.
    await this.#onFlushed?.(this.officeId, report).catch(() => undefined);
    return report;
  }

  /**
   * The stories of the operations a flush found merged, read again on the base (DIPO-360). A read
   * that fails (a dropped story is archived) leaves the next index pass to it.
   */
  async #refreshMerged(merged: readonly number[]): Promise<void> {
    if (this.#refreshStory === undefined) return;
    const keys = new Set<StoryKey>();
    for (const opId of merged) {
      const key = findEntry(this.#office, opId)?.key;
      if (key != null) keys.add(key);
    }
    for (const key of keys) {
      await this.#refreshStory(this.officeId, key).catch(() => undefined);
    }
  }

  /**
   * Puts a failed flush on the office as an `engine.notice`, so it is visible whoever called the
   * flush, and returns the error to throw. The open operations stay journaled.
   */
  #failed(error: unknown, replay: boolean): LaneFlushError {
    if (error instanceof LaneFlushError) return error;
    const message = error instanceof Error ? error.message : String(error);
    let code: string = replay ? LANE_NOTICES.replayFailed : LANE_NOTICES.flushFailed;
    let text = `${replay ? "Replaying the open backlog operations" : "Applying the open backlog operations"} failed: ${sentence(message)} They stay journaled and are applied at the next backlog change.`;
    if (error instanceof LaneError && error.code === LANE_NOTICES.baseUnset) {
      // `#assertBase` put its own notice on the office already.
      return new LaneFlushError(error.code, error.message, error);
    }
    if (error instanceof StuckCommitError) {
      code = LANE_NOTICES.commitStuck;
      text = `The backlog lane could not commit: ${sentence(message)} The likely cause is ${COMMIT_CAUSE}. The operation stays journaled and is applied at the next backlog change; dipo does not change that configuration.`;
    }
    this.#write(() => [this.#notice("error", code, text)]);
    return new LaneFlushError(code, text, error);
  }

  /**
   * Reads the base the lane applies to (DIPO-36, office init): fetches when the office has a remote
   * (a failed fetch reads the last fetched base), then, in one queue item, checks the backlog
   * worktree out detached at the base and runs `read` there. `read` must not write: the next flush
   * checks out its own branch before it applies anything, and drops whatever is left.
   */
  async atBase<T>(
    read: (ctx: {
      readonly git: GitSession;
      readonly cwd: string;
      readonly base: BaseRef;
      readonly hasRemote: boolean;
    }) => Promise<T>,
  ): Promise<T> {
    const has = await this.#git.run((git) => this.#hasRemote(git));
    if (has) await this.#git.fetch();
    return this.#git.run(async (git) => {
      await this.#assertBase(git);
      const base = await this.#base(git, has);
      const location = await this.#ensureWorktree(git, base.sha);
      await this.#checkout(git, location, base.sha, true);
      return read({ git, cwd: location.workTree, base, hasRemote: has });
    });
  }

  /** The report of a flush that did nothing because the branch is held, or null. */
  #heldReport(): FlushReport | null {
    const held = this.#held(this.officeId);
    if (held === null) return null;
    return {
      branch: held,
      committed: [],
      merged: [],
      dropped: [],
      rebuiltFrom: null,
      pushed: false,
      waiting: null,
      held: true,
    };
  }

  // ---- the flush item ------------------------------------------------------------------------

  async #flush(
    git: GitSession,
    remote: RemoteState,
    rebuildBranch: string | null,
  ): Promise<FlushReport> {
    const committed: number[] = [];
    const merged: number[] = [];
    const dropped: number[] = [];
    let rebuiltFrom: string | null = null;
    let abandoned: string | null = null;
    let open = openEntries(this.#office);
    if (open.length === 0) {
      this.#waiting = null;
      return {
        branch: null,
        committed,
        merged,
        dropped,
        rebuiltFrom,
        pushed: false,
        waiting: null,
      };
    }

    await this.#assertBase(git);
    const base = await this.#base(git, remote.has);
    const location = await this.#ensureWorktree(git, base.sha);
    let branch = open.findLast((entry) => entry.branch !== null)?.branch ?? null;

    if (branch !== null) {
      const tip = await this.#revParse(git, `refs/heads/${branch}`);
      if (tip !== null) await this.#recover(git, branch, tip, base.sha, open);
      open = openEntries(this.#office);
      const onBranch = open.filter(
        (entry) =>
          entry.branch === branch && (entry.state === "committed" || entry.state === "pushed"),
      );
      let rebuild = tip === null;
      let close = false;
      if (tip !== null && onBranch.length > 0) {
        const done = await this.#mergedOf(git, tip, base.sha, onBranch);
        if (done.length > 0) {
          this.#write(() => {
            for (const opId of done) this.#update(opId, { state: "merged" });
          });
          merged.push(...done);
        }
        if (done.length === onBranch.length) close = true;
        else if (done.length > 0) rebuild = true;
        else rebuild = branch === rebuildBranch || (await this.#conflicts(git, base.sha, tip));
      } else if (tip !== null) {
        // The branch was cut but nothing was committed on it before a crash: start afresh.
        close = true;
      }
      if (close || rebuild) {
        await this.#checkout(git, location, base.sha, true);
        if (close && tip !== null) {
          const deleted = await deleteBranch(git, branch, tip);
          if (deleted.code !== 0) {
            throw new GitError(
              "git.failed",
              `deleting the backlog branch ${branch} at ${tip} failed: ${deleted.stderr.trim() || `exit ${deleted.code}`}`,
            );
          }
        }
      }
      if (rebuild) {
        const old = branch;
        const moved = openEntries(this.#office).filter((entry) => entry.branch === old);
        const withCommit = moved.filter((entry) => entry.commit !== null);
        // Only operations the lane can apply again move to a new branch. An adopted branch
        // (DIPO-80) with nothing else on it has none: the lane lets go of it and its PR stays open.
        const replayable = withCommit.some((entry) => !isAdoptedTarget(entry.target));
        if (tip !== null && withCommit.length > 0) {
          if (replayable) rebuiltFrom = old;
          else abandoned = old;
        }
        const adopted = moved.filter((entry) => isAdoptedTarget(entry.target));
        this.#write(() => {
          // Adopted operations (DIPO-80) cannot be applied again: they are dropped here, with a
          // notice that says where their change is, before their PR reference is cleared.
          const drops = adopted.map((entry) => {
            const pr = prName(entry.prRef, old);
            const where =
              rebuiltFrom !== null
                ? `its change is in ${pr}, which dipo closes as it rebuilds the other operations on a new branch, and it was not applied again there`
                : abandoned !== null
                  ? `its change stays on ${old} in ${pr}, which stays open`
                  : "it was not applied again";
            const text = `The backlog operation \`${messageOf(entry)}\` was dropped: it was adopted after the state database was lost, so dipo does not know its target state; ${where}. Run the operation again if you still want it.`;
            this.#update(entry.opId, { state: "dropped", notice: text });
            dropped.push(entry.opId);
            return this.#notice("warn", LANE_NOTICES.dropped, text, entry.key);
          });
          for (const entry of moved) {
            if (isAdoptedTarget(entry.target)) continue;
            this.#update(entry.opId, { state: "pending", branch: null, commit: null, prRef: null });
          }
          if (abandoned !== null) {
            return [
              ...drops,
              this.#notice(
                "warn",
                LANE_NOTICES.adoptedAbandoned,
                `The adopted backlog branch ${old} no longer merges into ${base.name}, and dipo cannot rebuild it: its operations were journaled in the lost database. dipo lets go of it; its PR stays open for you to merge or close by hand, and ${old} is left as it is.`,
              ),
            ];
          }
          if (rebuiltFrom === null) return drops;
          return [
            ...drops,
            this.#notice(
              "info",
              LANE_NOTICES.rebuilt,
              `The backlog branch ${old} no longer merges into ${base.name}; its unmerged operations are applied again on a new branch, and ${old} is left as it is.`,
            ),
          ];
        });
      }
      if (close || rebuild) branch = null;
    }

    open = openEntries(this.#office);
    // Everything not committed on the open branch is applied (again), in journal order.
    const toApply = open.filter(
      (entry) =>
        branch === null ||
        entry.branch !== branch ||
        (entry.state !== "committed" && entry.state !== "pushed"),
    );
    // Every write starts from an explicit checkout of the open branch (or of the base for a new
    // one), so a worktree another item left elsewhere (the backlog PR check, DIPO-35) is never
    // written to.
    if (toApply.length > 0) {
      await this.#checkout(git, location, branch ?? base.sha, branch === null);
    }

    for (const entry of toApply) {
      if (isAdoptedTarget(entry.target)) {
        // Adopted from an open backlog PR after a lost database (DIPO-80): no target to apply.
        this.#drop(
          entry,
          "it was adopted from an open backlog PR after the state database was lost, so dipo does not know its target state and cannot apply it again; run the operation again if you still want it",
        );
        dropped.push(entry.opId);
        continue;
      }
      const kind = this.#kinds.get(entry.kind);
      if (kind === undefined) {
        this.#drop(entry, `no lane operation kind ${entry.kind} is known`);
        dropped.push(entry.opId);
        continue;
      }
      const story =
        entry.key === null
          ? entry.subject
          : (findStoryByKey(this.#office, entry.key)?.story ?? entry.subject);
      const before = (await git.ok(location, ["rev-parse", "--verify", "HEAD"])).trim();
      let outcome;
      try {
        outcome = await kind.apply(
          { cli: this.#cli, cwd: location.workTree, story, entry, office: this.#office },
          entry.target,
        );
      } catch (error) {
        await this.#discard(git, location, before);
        throw error;
      }
      // Only the engine commits in `_backlog`. A CLI that committed by itself (Backlog.md
      // `auto_commit: true`) made a commit without the trailer and outside the journal: undo it.
      const after = (await git.ok(location, ["rev-parse", "--verify", "HEAD"])).trim();
      if (after !== before) {
        await this.#discard(git, location, before);
        this.#drop(
          entry,
          "the Backlog CLI committed by itself while applying it (Backlog.md `auto_commit` is on; set `auto_commit: false` in backlog/config.yml)",
        );
        dropped.push(entry.opId);
        continue;
      }
      if (!outcome.applies) {
        await this.#discard(git, location);
        this.#drop(entry, outcome.reason);
        dropped.push(entry.opId);
        continue;
      }
      const paths = statusPaths(
        await git.ok(location, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      );
      if (paths.length === 0) {
        if (branch === null) {
          // The target state is on the base already.
          this.#write(() => this.#update(entry.opId, { state: "merged", branch: null }));
          merged.push(entry.opId);
        } else {
          this.#drop(entry, `its target state is already on the open branch ${branch}`, "info");
          dropped.push(entry.opId);
        }
        continue;
      }
      const outside = paths.filter((path) => !inLane(path, kind.paths ?? []));
      if (outside.length > 0) {
        await this.#discard(git, location);
        this.#drop(entry, `it changed paths outside backlog/: ${outside.join(", ")}`);
        dropped.push(entry.opId);
        continue;
      }
      if (branch === null) {
        branch = await this.#newBranchName(git);
        const head = (await git.ok(location, ["rev-parse", "--verify", "HEAD"])).trim();
        if (!(await createBranch(git, branch, head))) {
          throw new GitError(
            "git.failed",
            `the backlog branch ${branch} appeared while dipo created it`,
          );
        }
        await git.ok(location, ["checkout", "--quiet", branch]);
      }
      const onto = branch;
      this.#write(() => this.#update(entry.opId, { state: "applied", branch: onto }));
      await git.ok(location, ["add", "--all", "--", ...paths]);
      const sha = await this.#commit(git, location, entry);
      this.#write(() => this.#update(entry.opId, { state: "committed", commit: sha }));
      committed.push(entry.opId);
    }

    const pushed = await this.#push(
      git,
      branch,
      base,
      remote,
      committed.length > 0 || rebuiltFrom !== null,
    );
    return {
      branch,
      committed,
      merged,
      dropped,
      rebuiltFrom,
      pushed,
      waiting: this.#waiting,
      abandoned,
    };
  }

  /**
   * Commits the staged operation as `backlog: <op> <ID>` with its trailer and returns the commit.
   * A plain `git commit`, so signing follows the maintainer's own configuration; since it may wait
   * on something outside the engine (a signing program asking for a passphrase), it runs with a
   * timeout, and a commit that times out, or fails on its identity or signature, throws
   * `StuckCommitError`.
   */
  async #commit(git: GitSession, location: GitLocation, entry: JournalEntry): Promise<string> {
    let result;
    try {
      result = await commitStaged(git, location, {
        subject: messageOf(entry),
        body: [`${OP_TRAILER}: ${entry.opId}`],
      });
    } catch (error) {
      if (isTimedOut(error)) throw new StuckCommitError(error.message);
      throw error;
    }
    if (result.code !== 0) {
      const detail = `git commit failed: ${result.stderr.trim() || `exit ${result.code}`}`;
      if (COMMIT_CONFIG_FAILURE.test(result.stderr)) throw new StuckCommitError(detail);
      throw new GitError("git.failed", detail, false, { code: result.code });
    }
    return (await git.ok(location, ["rev-parse", "--verify", "HEAD"])).trim();
  }

  /** Pushes the open branch when it has unpushed commits; records and reports what waits. */
  async #push(
    git: GitSession,
    branch: string | null,
    base: BaseRef,
    remote: RemoteState,
    changed: boolean,
  ): Promise<boolean> {
    const unpushed =
      branch === null
        ? []
        : openEntries(this.#office).filter(
            (entry) => entry.branch === branch && entry.state === "committed",
          );
    if (branch === null || unpushed.length === 0) {
      this.#waiting = null;
      return false;
    }
    let reason: WaitingReason | null = null;
    let detail = "";
    let stuck = false;
    if (!remote.has) {
      reason = "noRemote";
      detail = `the office has no remote ${this.#git.settings.remote}; merge ${branch} into ${base.name} by hand`;
    } else if (!remote.fetched) {
      reason = "fetchFailed";
      detail = `the push waits until a fetch of ${this.#git.settings.remote} succeeds (${remote.detail})`;
    } else {
      // A push waiting on a credential prompt is killed (`code` null); the commits wait for the
      // next flush.
      const result = await pushRef(git, this.#git.settings.remote, branch);
      stuck = result.code === null;
      if (result.code === 0) {
        this.#write(() => {
          for (const entry of unpushed) this.#update(entry.opId, { state: "pushed" });
        });
        this.#waiting = null;
        return true;
      }
      reason = "pushFailed";
      detail =
        result.code === null
          ? `pushing to ${this.#git.settings.remote} was killed after ${EXTERNAL_STEP_TIMEOUT_MS / 1000} s; the likely cause is ${PUSH_CAUSE}`
          : `pushing to ${this.#git.settings.remote} failed: ${result.stderr.trim() || `exit ${result.code}`}`;
      changed = true;
    }
    const ops = unpushed.map((entry) => ({ opId: entry.opId, message: messageOf(entry) }));
    this.#waiting = { branch, reason, detail, ops };
    if (changed) {
      this.#write(() => [
        this.#notice(
          stuck ? "error" : "warn",
          stuck ? LANE_NOTICES.commitStuck : LANE_NOTICES.waiting,
          `The backlog branch ${branch} waits: ${detail}. Waiting: ${ops.map((op) => op.message).join("; ")}.`,
        ),
      ]);
    }
    return false;
  }

  // ---- journal writes ------------------------------------------------------------------------

  /** Runs `fn` in one transaction and appends the notices it returns. */
  #write(fn: () => NewEntry[] | void): void {
    const now = this.#clock.now();
    const notices = this.#office.immediate(() => {
      const entries = fn() ?? [];
      appendEntries(this.#office, entries, { at: now });
      return entries.length;
    });
    if (notices > 0) this.#onChanged(this.officeId);
  }

  #update(opId: number, change: EntryChange): void {
    updateEntry(this.#office, opId, change, this.#clock.now());
  }

  #notice(
    level: "info" | "warn" | "error",
    code: string,
    text: string,
    key?: StoryKey | null,
  ): NewEntry {
    return {
      type: "engine.notice",
      ...(key === null || key === undefined ? {} : { key }),
      delta: { level, code, text },
    };
  }

  #drop(entry: JournalEntry, reason: string, level: "info" | "warn" = "warn"): void {
    const text = `The backlog operation \`${messageOf(entry)}\` was dropped: ${reason}.`;
    this.#write(() => {
      this.#update(entry.opId, { state: "dropped", notice: text });
      return [this.#notice(level, LANE_NOTICES.dropped, text, entry.key)];
    });
  }

  // ---- git -----------------------------------------------------------------------------------

  async #hasRemote(git: GitSession): Promise<boolean> {
    const result = await git.step(git.repository, [
      "config",
      "--get",
      `remote.${this.#git.settings.remote}.url`,
    ]);
    return result.code === 0 && result.stdout.trim() !== "";
  }

  /**
   * The base and the commit operations apply to: `<remote>/<base>` with a remote, the local
   * `<base>` without one (0010 section 7, start point).
   */
  async #base(git: GitSession, hasRemote: boolean): Promise<BaseRef> {
    const { remote } = this.#git.settings;
    // The office's base rule (`git.baseUnknown` when it names none). Without a remote
    // `#assertBase` refused the lane unless `base` is set; the main checkout's HEAD is never taken
    // as the base.
    const name = await this.#git.resolveBaseIn(git);
    const ref = hasRemote ? `refs/remotes/${remote}/${name}` : `refs/heads/${name}`;
    const sha = await this.#revParse(git, ref);
    if (sha === null) {
      throw new GitError(
        "git.baseMissing",
        `${ref} does not exist, so the backlog lane has no base to apply to.`,
        false,
        { ref },
      );
    }
    return { name, sha };
  }

  async #revParse(git: GitSession, ref: string): Promise<string | null> {
    const result = await git.step(git.repository, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${ref}^{commit}`,
    ]);
    return result.code === 0 ? result.stdout.trim() : null;
  }

  /** Creates `<root>/_backlog`, detached at `sha`, when it is missing; returns its location. */
  async #ensureWorktree(
    git: GitSession,
    sha: string,
  ): Promise<Extract<GitLocation, { kind: "worktree" }>> {
    const path = this.worktreePath();
    const registered = this.#git.adminDirOf(path);
    if (registered === null && existsSync(path)) {
      throw new GitError(
        "git.lanePathTaken",
        `${path} exists but is not a worktree of this repository; dipo leaves it alone. Move it away so the engine can create its backlog worktree there.`,
        false,
        { path },
      );
    }
    if (registered === null || !existsSync(path)) {
      await git.ok(
        git.repository,
        ["worktree", "add", ...(registered === null ? [] : ["--force"]), "--detach", path, sha],
        { config: [...WORKTREE_ADD_CONFIG, ...BASE_CHECKOUT_CONFIG], env: BASE_CHECKOUT_ENV },
      );
    }
    const location = this.#git.worktreeLocation(path);
    if (location.kind !== "worktree") throw new Error("expected a worktree location");
    return location;
  }

  /** Checks out `target` (a branch, or a commit detached) and removes untracked files. */
  async #checkout(
    git: GitSession,
    location: GitLocation,
    target: string,
    detach: boolean,
  ): Promise<void> {
    await git.ok(
      location,
      [
        "checkout",
        "--quiet",
        "--force",
        "--no-recurse-submodules",
        ...(detach ? ["--detach"] : []),
        target,
      ],
      CHECKOUT,
    );
    await git.ok(location, ["clean", "-fdq"]);
  }

  /** Throws away what an operation left in the worktree. */
  async #discard(git: GitSession, location: GitLocation, to = "HEAD"): Promise<void> {
    await resetWorktree(git, location, to, CHECKOUT);
    await git.ok(location, ["clean", "-fdq"]);
  }

  /** A branch name no local or remote-tracking ref has yet. */
  async #newBranchName(git: GitSession): Promise<string> {
    const stem = `${LANE_BRANCH_PREFIX}${backupStamp(this.#clock.now())}`;
    const { remote } = this.#git.settings;
    for (let n = 1; ; n++) {
      const name = n === 1 ? stem : `${stem}-${n}`;
      const local = await this.#revParse(git, `refs/heads/${name}`);
      const tracking = await this.#revParse(git, `refs/remotes/${remote}/${name}`);
      if (local === null && tracking === null) return name;
    }
  }

  /** Marks open entries whose commit is on the branch (found by trailer) as committed. */
  async #recover(
    git: GitSession,
    branch: string,
    tip: string,
    base: string,
    open: readonly JournalEntry[],
  ): Promise<void> {
    const uncommitted = open.filter(
      (entry) => entry.state === "pending" || entry.state === "applied",
    );
    if (uncommitted.length === 0) return;
    const log = await git.ok(git.repository, [
      "log",
      `--format=%H%x1f%(trailers:key=${OP_TRAILER},valueonly,separator=%x2c)%x1e`,
      tip,
      `^${base}`,
    ]);
    const byOp = new Map<number, string>();
    for (const record of log.split("\x1e")) {
      const [sha, ops] = record.trim().split("\x1f");
      if (sha === undefined || sha === "" || ops === undefined) continue;
      for (const op of ops.split(",")) {
        const id = Number(op.trim());
        if (Number.isInteger(id) && id > 0 && !byOp.has(id)) byOp.set(id, sha);
      }
    }
    const found = uncommitted.filter((entry) => byOp.has(entry.opId));
    if (found.length === 0) return;
    this.#write(() => {
      for (const entry of found) {
        this.#update(entry.opId, {
          state: "committed",
          branch,
          commit: byOp.get(entry.opId) ?? null,
        });
      }
    });
  }

  /** The blob of each of `paths` in `commit`; a missing path has no entry. */
  async #blobs(
    git: GitSession,
    commit: string,
    paths: readonly string[],
  ): Promise<Map<string, string>> {
    const blobs = new Map<string, string>();
    if (paths.length === 0) return blobs;
    const out = await git.ok(git.repository, ["ls-tree", "-r", "-z", commit, "--", ...paths]);
    for (const record of out.split("\0")) {
      const tab = record.indexOf("\t");
      if (tab < 0) continue;
      const [, , sha] = record.slice(0, tab).split(" ");
      if (sha !== undefined) blobs.set(record.slice(tab + 1), sha);
    }
    return blobs;
  }

  /**
   * The operations on the branch whose changed files all hold, on the base, the blob the branch
   * tip holds: their changes have merged (0010 section 2).
   */
  async #mergedOf(
    git: GitSession,
    tip: string,
    base: string,
    entries: readonly JournalEntry[],
  ): Promise<number[]> {
    const files = new Map<number, string[]>();
    for (const entry of entries) {
      if (entry.commit === null) continue;
      const out = await git.ok(git.repository, [
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        "-z",
        "--root",
        entry.commit,
      ]);
      files.set(
        entry.opId,
        out.split("\0").filter((path) => path !== ""),
      );
    }
    const paths = [...new Set([...files.values()].flat())];
    const [atTip, atBase] = await Promise.all([
      this.#blobs(git, tip, paths),
      this.#blobs(git, base, paths),
    ]);
    return entries
      .filter((entry) => {
        const changed = files.get(entry.opId);
        return (
          changed !== undefined && changed.every((path) => atTip.get(path) === atBase.get(path))
        );
      })
      .map((entry) => entry.opId);
  }

  /** True when the branch no longer merges cleanly into the base (0010 section 7). */
  async #conflicts(git: GitSession, base: string, tip: string): Promise<boolean> {
    const result = await git.step(git.repository, ["merge-tree", "--write-tree", base, tip]);
    if (result.code === 0) return false;
    if (result.code === 1 && /^[0-9a-f]{40,64}\b/.test(result.stdout)) return true;
    throw new GitError(
      "git.failed",
      `git merge-tree --write-tree failed: ${result.stderr.trim() || `exit ${result.code}`}`,
      false,
      { code: result.code },
    );
  }
}

export interface BacklogLaneDeps {
  /** How the CLI starts in the `_backlog` worktree. */
  readonly cli: BacklogCli;
  /** The office's git, attached by the `git.version` load step (DIPO-31). */
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  /** Kinds beyond the built-in `edit`. */
  readonly kinds?: readonly LaneOpKind[];
  readonly liveClaim?: (office: OfficeHandle, key: StoryKey) => boolean;
  readonly onChanged?: (office: OfficeId) => void;
  /** Called after each successful flush (DIPO-35, the backlog PR). */
  readonly onFlushed?: (office: OfficeId, report: FlushReport) => Promise<void>;
  /** The branch whose PR has auto-merge on (0002). */
  readonly held?: (office: OfficeId) => string | null;
  /** Reads a story whose operation merged again on the base (DIPO-360). */
  readonly refreshStory?: (office: OfficeId, key: StoryKey) => Promise<unknown>;
}

/** The load step that replays open journal entries (0007 section 6 step 2). */
export const LANE_REPLAY_STEP = "backlog.lane.replay";

/** `the backlog PR #n` from a PR URL, else the PR of `branch`. */
function prName(prRef: string | null, branch: string): string {
  const number = /\/pull\/(\d+)$/.exec(prRef ?? "")?.[1];
  return number === undefined ? `the backlog PR of ${branch}` : `the backlog PR #${number}`;
}
