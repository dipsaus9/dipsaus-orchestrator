// The office's one backlog PR (0010 section 2, lane b; 0016 rule 1). After each flush of the
// planning lane the engine opens a PR for the pushed engine branch `dipo/backlog-*`, or updates the
// one it has, through the code host (`platform/host.ts`, `gh` with the maintainer's own login), and
// stores the PR on the journal entries. Whenever the PR's head changes it runs the structural check
// (`check.ts`); a failure keeps the PR open, puts an `engine.notice` per failure on the office and
// leaves the PR without auto-merge (`merge.ts`).
//
// `sync` asks the host about the office's open backlog PRs: one merged by hand is checked again
// right away, against the head that merged; a failure is a notice and blocks the stories it names
// (`backlogCheckBlocked`) until a later backlog PR that touches them merges with a passing check.
// A PR closed on the host is recorded as closed. A lane rebuild (a new branch) closes the old PR.
// An open PR whose check failed for want of a Ready gate decision is checked again once that gate
// passes (DIPO-80).
//
// `adopt` (DIPO-80, called by reconcile) takes over the office's open backlog PR after the state
// database was lost: it lists the open `dipo/backlog-*` PRs on the host and, when exactly one is
// unknown and the office has none of its own, journals the lane commits of its branch and records
// the PR, then checks it. Anything else is a notice; it never closes, edits or pushes a PR.
//
// Without a remote, with a push or fetch waiting, or when `gh` is missing, too old or not logged in,
// no PR is opened: `waiting(office)` names the branch and why, and a notice says so once per cause.
//
// Work for one office runs one piece at a time. Git steps (the check's diff, reading refs) run as
// items of the office git queue; `gh` calls run outside it.

import type { Clock, OfficeId, StoryKey } from "@dipsaus-orchestrator/contract";

import { appendEntries, type NewEntry } from "../../changelog/log";
import type { OfficeHandle } from "../../db/office";
import { gateDecisionsOf } from "../../gate-decisions/decisions";
import type { GitSession } from "../../git/office";
import { GitError } from "../../git/runner";
import {
  type CodeHost,
  CodeHostError,
  type HostPr,
  type PrListHost,
  repoOfRemoteUrl,
} from "../../platform/host";
import { resolveStoryRef } from "../../stories/keys";
import { hasLiveClaim } from "../../worktree/records";
import {
  type AdoptedOp,
  insertAdoptedEntry,
  openEntries,
  recordPrRef,
  takenOpIds,
} from "../lane/journal";
import { type FlushReport, LANE_BRANCH_PREFIX, type OfficeLane } from "../lane/lane";
import type { BacklogCli } from "../runner";

import { placeBranch, readBranch } from "./adopt";
import { checkBacklogPr, type CheckResult, type PrDiff, type PrFacts } from "./check";
import { collectPrDiff } from "./diff";
import {
  type BacklogPrRecord,
  blockStories,
  clearBlocks,
  closePrRecord,
  findPr,
  insertPr,
  openPrs,
  recordCheck,
  recordCheckError,
  setTitle,
} from "./records";
import { prBody, prTitle } from "./title";

/** `engine.notice` codes of the backlog PR. */
export const PR_NOTICES = {
  opened: "backlog.pr.opened",
  checkFailed: "backlog.pr.checkFailed",
  mergedCheckFailed: "backlog.pr.mergedCheckFailed",
  checkError: "backlog.pr.checkError",
  waiting: "backlog.pr.waiting",
  closed: "backlog.pr.closed",
  adopted: "backlog.pr.adopted",
  notAdopted: "backlog.pr.notAdopted",
  letGo: "backlog.pr.letGo",
} as const;

/** What `adopt` did with the open `dipo/backlog-*` PRs the office's database does not know. */
export interface AdoptReport {
  /** The PR adopted, or null. */
  readonly adopted: number | null;
  /** The PRs left as they are, each with why. */
  readonly refused: readonly { readonly number: number; readonly reason: string }[];
}

export type PrWaitingReason =
  | "noRemote"
  | "fetchFailed"
  | "pushFailed"
  | "noHostRepo"
  | "ghMissing"
  | "ghTooOld"
  | "ghUnauthenticated"
  | "hostFailed";

/** An engine branch whose PR is not open, and why. */
export interface PrWaiting {
  readonly branch: string;
  readonly reason: PrWaitingReason;
  readonly detail: string;
}

export interface BacklogPrsDeps {
  readonly host: CodeHost;
  /**
   * Lists open PRs by head-branch prefix (DIPO-80); without it `adopt` finds nothing. The daemon
   * passes its `GhHost`.
   */
  readonly list?: PrListHost;
  /** The office's planning lane once the office loaded. */
  readonly lane: (office: OfficeId) => OfficeLane | undefined;
  readonly cli: BacklogCli;
  readonly offices: { get(office: OfficeId): OfficeHandle | undefined };
  readonly clock: Clock;
  readonly onChanged?: (office: OfficeId) => void;
}

const HOST_REASONS: Record<CodeHostError["code"], PrWaitingReason> = {
  missing: "ghMissing",
  tooOld: "ghTooOld",
  unauthenticated: "ghUnauthenticated",
  failed: "hostFailed",
  // A call killed at its deadline (DIPO-314) waits like any other failed host call.
  timedOut: "hostFailed",
};

interface OfficeState {
  busy: Promise<unknown>;
  waiting: PrWaiting | null;
  /** The reason last noticed for each PR `adopt` left alone, so a rescan does not repeat it. */
  readonly notAdopted: Map<number, string>;
}

export class BacklogPrs {
  readonly #deps: BacklogPrsDeps;
  readonly #state = new Map<OfficeId, OfficeState>();

  constructor(deps: BacklogPrsDeps) {
    this.#deps = deps;
  }

  /** The engine branch waiting for its PR, or null when none waits. */
  waiting(office: OfficeId): PrWaiting | null {
    return this.#stateOf(office).waiting;
  }

  /** The lane's flush hook: look for merged PRs, then open or update the branch's PR and check it. */
  afterFlush(office: OfficeId, report: FlushReport): Promise<void> {
    return this.#serial(office, async () => {
      await this.#sync(office);
      await this.#publish(office, report);
    });
  }

  /** Asks the host about the office's open backlog PRs; checks one merged by hand again. */
  sync(office: OfficeId): Promise<void> {
    return this.#serial(office, () => this.#sync(office));
  }

  /**
   * Adopts the office's open backlog PR after a lost or replaced database (DIPO-80; 0007 section
   * 6): lists the open PRs whose head starts with `dipo/backlog-` and takes over the one the
   * database does not know, into `backlog_prs` and the lane's journal, then runs its structural
   * check. It adopts nothing, with a notice per PR, while the office has an open backlog PR or
   * lane branch of its own, when more than one such PR is open, or when the lane cannot take the
   * branch over (`readBranch`). It never closes, edits or pushes a PR. Reconcile calls it at
   * daemon start and on `office.rescan`; a host it cannot reach makes it do nothing.
   */
  adopt(office: OfficeId): Promise<AdoptReport> {
    return this.#serial(office, () => this.#adopt(office));
  }

  // ---- publish -------------------------------------------------------------------------------

  async #publish(office: OfficeId, report: FlushReport): Promise<void> {
    const handle = this.#handle(office);
    const lane = this.#lane(office);
    if (report.rebuiltFrom !== null) await this.#closeReplaced(office, report.rebuiltFrom, report);
    if (report.abandoned !== undefined && report.abandoned !== null) {
      this.#letGo(office, report.abandoned);
    }
    const branch = report.branch;
    if (branch === null) {
      this.#setWaiting(office, null);
      return;
    }
    if (report.waiting !== null) {
      // The lane put its own notice on the office.
      this.#stateOf(office).waiting = {
        branch,
        reason: report.waiting.reason,
        detail: report.waiting.detail,
      };
      return;
    }
    const where = await lane.git.run(async (git) => ({
      url: await this.#remoteUrl(git, lane),
      head: await this.#revParse(git, `refs/heads/${branch}`),
    }));
    const repo = where.url === null ? null : repoOfRemoteUrl(where.url);
    if (repo === null) {
      this.#setWaiting(office, {
        branch,
        reason: "noHostRepo",
        detail: `the remote ${lane.git.settings.remote} (${where.url ?? "no URL"}) is not a GitHub repository dipo can open a PR on; merge ${branch} by hand`,
      });
      return;
    }
    if (where.head === null) return;
    const ops = openEntries(handle)
      .filter((entry) => entry.branch === branch)
      .map((entry) => ({ kind: entry.kind, subject: entry.subject }));
    const title = prTitle(ops);
    const body = prBody(ops);
    let record: BacklogPrRecord | null;
    try {
      record = await this.#ensurePr(office, repo, branch, title, body, lane);
    } catch (error) {
      if (!(error instanceof CodeHostError)) throw error;
      this.#setWaiting(office, {
        branch,
        reason: HOST_REASONS[error.code],
        detail: error.message,
      });
      return;
    }
    this.#setWaiting(office, null);
    if (record.checkedHead !== where.head) await this.#check(office, lane, record, where.head);
  }

  /** The open PR of `branch`: the stored one, one the host has open, or a new one. */
  async #ensurePr(
    office: OfficeId,
    repo: string,
    branch: string,
    title: string,
    body: string,
    lane: OfficeLane,
  ): Promise<BacklogPrRecord> {
    const handle = this.#handle(office);
    const now = () => this.#deps.clock.now();
    const stored = openPrs(handle).find((pr) => pr.branch === branch);
    if (stored !== undefined) {
      if (stored.title !== title) {
        await this.#deps.host.updatePr(repo, stored.number, { title, body });
        this.#write(office, () => setTitle(handle, stored.number, title, now()));
      }
      this.#write(office, () => {
        recordPrRef(handle, branch, stored.url, now());
      });
      return findPr(handle, stored.number) ?? stored;
    }
    let pr: HostPr | null = await this.#deps.host.findOpenPr(repo, branch);
    if (pr !== null && pr.title !== title) {
      await this.#deps.host.updatePr(repo, pr.number, { title, body });
    }
    if (pr === null) {
      const base = await lane.git.resolveBase();
      pr = await this.#deps.host.createPr(repo, { base, head: branch, title, body });
    }
    const opened = pr;
    this.#write(office, () => {
      insertPr(handle, { number: opened.number, url: opened.url, branch, title }, now());
      recordPrRef(handle, branch, opened.url, now());
      return [
        notice(
          "info",
          PR_NOTICES.opened,
          `dipo opened the backlog PR #${opened.number} for ${branch}: ${opened.url}`,
        ),
      ];
    });
    const record = findPr(handle, opened.number);
    if (record === null) throw new Error(`backlog PR #${opened.number} vanished after its insert`);
    return record;
  }

  /** Closes the open PR of a branch the lane replaced with a new one (0010 section 2). */
  async #closeReplaced(office: OfficeId, old: string, report: FlushReport): Promise<void> {
    const handle = this.#handle(office);
    const stored = openPrs(handle).find((pr) => pr.branch === old);
    if (stored === undefined) return;
    const repo = repoOfUrl(stored.url);
    try {
      if (repo !== null) {
        await this.#deps.host.closePr(
          repo,
          stored.number,
          `dipo rebuilt these backlog changes on ${report.branch ?? "a new branch"}, because ${old} no longer merges into the base.`,
        );
      }
    } catch (error) {
      if (!(error instanceof CodeHostError)) throw error;
      this.#write(office, () => [
        notice(
          "warn",
          PR_NOTICES.closed,
          `dipo could not close the replaced backlog PR #${stored.number}: ${error.message}`,
        ),
      ]);
      return;
    }
    this.#write(office, () =>
      closePrRecord(handle, stored.number, "closed", this.#deps.clock.now()),
    );
  }

  // ---- sync ----------------------------------------------------------------------------------

  async #sync(office: OfficeId): Promise<void> {
    const handle = this.#deps.offices.get(office);
    const lane = this.#deps.lane(office);
    if (handle === undefined || lane === undefined) return;
    for (const record of openPrs(handle)) {
      const repo = repoOfUrl(record.url);
      if (repo === null) continue;
      let pr: HostPr;
      try {
        pr = await this.#deps.host.viewPr(repo, record.number);
      } catch (error) {
        // The host is unreachable or gh is unusable: the next sync asks again.
        if (error instanceof CodeHostError) continue;
        throw error;
      }
      if (pr.state === "open") {
        // A Ready gate that passed again since a check failed for want of it (DIPO-80): check
        // the PR again, so it can get auto-merge.
        if (this.#gatePassedSince(handle, record)) {
          const head = await lane.git.run((git) =>
            this.#revParse(git, `refs/heads/${record.branch}`),
          );
          if (head !== null) await this.#check(office, lane, record, head).catch(() => undefined);
        }
        continue;
      }
      const now = this.#deps.clock.now();
      if (pr.state === "closed") {
        this.#write(office, () => closePrRecord(handle, record.number, "closed", now));
        continue;
      }
      const head = pr.headSha !== "" ? pr.headSha : record.checkedHead;
      const present =
        head !== null && (await lane.git.run((git) => this.#revParse(git, head))) !== null;
      if (head === null || !present) {
        this.#write(office, () => [
          notice(
            "error",
            PR_NOTICES.checkError,
            `The backlog PR #${record.number} merged, but its head ${head ?? "(unknown)"} is not in the local repository, so dipo could not check it again.`,
          ),
        ]);
        this.#write(office, () => closePrRecord(handle, record.number, "merged", now));
        continue;
      }
      // The PR is recorded merged only together with its check result: a check that throws leaves
      // it open, so the next sync checks it again.
      await this.#check(office, lane, record, head, { mergeCommit: pr.mergeCommit });
    }
  }

  // ---- adopt ---------------------------------------------------------------------------------

  async #adopt(office: OfficeId): Promise<AdoptReport> {
    const none: AdoptReport = { adopted: null, refused: [] };
    const handle = this.#deps.offices.get(office);
    const lane = this.#deps.lane(office);
    const list = this.#deps.list;
    if (handle === undefined || lane === undefined || list === undefined) return none;
    const url = await lane.git.run((git) => this.#remoteUrl(git, lane));
    const repo = url === null ? null : repoOfRemoteUrl(url);
    if (repo === null) return none;
    let listed: HostPr[];
    try {
      listed = await list.listOpenPrs(repo, LANE_BRANCH_PREFIX);
    } catch (error) {
      // The host is unreachable or gh is unusable: the next reconcile asks again.
      if (error instanceof CodeHostError) return none;
      throw error;
    }
    const unknown = listed.filter((pr) => findPr(handle, pr.number) === null);
    if (unknown.length === 0) return none;

    const refused: { number: number; reason: string }[] = [];
    const refuse = (pr: HostPr, reason: string) => {
      refused.push({ number: pr.number, reason });
      this.#noticeNotAdopted(office, pr, reason);
    };
    const mine = ownOpen(handle);
    if (mine !== null) {
      for (const pr of unknown) refuse(pr, mine);
      return { adopted: null, refused };
    }
    if (unknown.length > 1) {
      const all = unknown.map((pr) => `#${pr.number}`).join(", ");
      for (const pr of unknown) {
        refuse(
          pr,
          `${unknown.length} open backlog PRs (${all}) are unknown to dipo, and an office has at most one; close all but one by hand, then run \`dipo office rescan\``,
        );
      }
      return { adopted: null, refused };
    }

    const pr = unknown[0] as HostPr;
    // The remote has a URL (the repo came from it): fetch, so the PR's head is here. A failed
    // fetch reads the local refs, as reconcile does offline.
    await lane.git.fetch();
    const outcome = await lane.git.run(async (git) => {
      const base = await this.#baseName(git, lane).catch(() => null);
      if (base === null) return { ok: false as const, reason: "the office has no base branch" };
      const read = await readBranch(git, {
        branch: pr.head,
        hostHead: pr.headSha,
        prBase: pr.base,
        remote: lane.git.settings.remote,
        base,
      });
      if (!read.ok) return read;
      // Again inside the queue item: a flush queued since the look above may have cut a lane
      // branch of the office's own, and the office keeps at most one.
      const since = ownOpen(handle);
      if (since !== null) return { ok: false as const, reason: since };
      const taken = takenOpIds(
        handle,
        read.ops.map((op) => op.opId),
      );
      if (taken.length > 0) {
        return {
          ok: false as const,
          reason: `the lane's journal already has the operations ${taken.join(", ")} its commits name`,
        };
      }
      await placeBranch(git, pr.head, read.tip, read.local);
      const ops: AdoptedOp[] = read.ops.map((op) => {
        const resolved = resolveStoryRef(handle, op.subject);
        return {
          opId: op.opId,
          kind: op.kind,
          subject: op.subject,
          key: resolved.ok ? resolved.key : null,
          commit: op.commit,
          state: op.pushed ? "pushed" : "committed",
        };
      });
      this.#write(office, () => {
        const now = this.#deps.clock.now();
        for (const op of ops) insertAdoptedEntry(handle, op, pr.head, pr.url, now);
        insertPr(handle, { number: pr.number, url: pr.url, branch: pr.head, title: pr.title }, now);
        return [
          notice(
            "info",
            PR_NOTICES.adopted,
            `dipo adopted the open backlog PR #${pr.number} (${pr.head}) after its state database was lost or replaced: ${ops.length} ${ops.length === 1 ? "operation" : "operations"} (${ops.map((op) => `${op.kind} ${op.subject}`).join("; ")}). It merges once its structural check passes; a new Ready needs its Ready gate to pass again.`,
          ),
        ];
      });
      return { ok: true as const, tip: read.tip };
    });
    if (!outcome.ok) {
      refuse(pr, outcome.reason);
      return { adopted: null, refused };
    }
    this.#stateOf(office).notAdopted.delete(pr.number);
    const record = findPr(handle, pr.number);
    if (record !== null) {
      // The check notices its own failures and errors; a check that could not run runs again
      // when the next flush asks.
      await this.#check(office, lane, record, outcome.tip).catch(() => undefined);
    }
    return { adopted: pr.number, refused };
  }

  /** One notice per PR and reason: a PR left alone is not noticed again on every rescan. */
  #noticeNotAdopted(office: OfficeId, pr: HostPr, reason: string): void {
    const noticed = this.#stateOf(office).notAdopted;
    if (noticed.get(pr.number) === reason) return;
    noticed.set(pr.number, reason);
    this.#write(office, () => [
      notice(
        "warn",
        PR_NOTICES.notAdopted,
        `dipo did not adopt the open backlog PR #${pr.number} (${pr.head}): ${reason}. dipo leaves it as it is and merges nothing from it: ${pr.url}`,
      ),
    ]);
  }

  /**
   * Lets go of the open PR of an adopted branch the lane could not rebuild (DIPO-80): the record
   * is closed here only; the PR stays open on the host for the maintainer.
   */
  #letGo(office: OfficeId, branch: string): void {
    const handle = this.#handle(office);
    const stored = openPrs(handle).find((pr) => pr.branch === branch);
    if (stored === undefined) return;
    this.#write(office, () => {
      closePrRecord(handle, stored.number, "closed", this.#deps.clock.now());
      return [
        notice(
          "warn",
          PR_NOTICES.letGo,
          `dipo no longer manages the adopted backlog PR #${stored.number}: ${branch} no longer merges into the base and cannot be rebuilt. It stays open; merge or close it by hand: ${stored.url}`,
        ),
      ];
    });
  }

  /**
   * True when the open PR's last check failed on a missing Ready gate decision and a story it named
   * has a passing decision stored since (DIPO-80: decisions lost with the database).
   */
  #gatePassedSince(handle: OfficeHandle, record: BacklogPrRecord): boolean {
    if (record.check !== "failed") return false;
    const since = record.checkedAt ?? 0;
    return record.failures.some(
      (failure) =>
        failure.rule === "ready-decision" &&
        failure.key !== undefined &&
        gateDecisionsOf(handle, failure.key).some(
          (decision) => decision.passed && decision.decidedAt > since,
        ),
    );
  }

  // ---- the check -----------------------------------------------------------------------------

  async #check(
    office: OfficeId,
    lane: OfficeLane,
    record: BacklogPrRecord,
    head: string,
    merged: { readonly mergeCommit: string | null } | null = null,
  ): Promise<CheckResult> {
    const mode = merged === null ? "open" : "merged";
    const handle = this.#handle(office);
    let diff: PrDiff;
    let base = "";
    try {
      diff = await lane.git.run(async (git) => {
        base = await this.#diffBase(git, lane, record, head, merged);
        const location = lane.git.worktreeLocation(lane.worktreePath());
        if (location.kind !== "worktree") throw new Error("expected the backlog worktree");
        return collectPrDiff({
          git,
          worktree: location,
          cli: this.#deps.cli,
          base,
          head,
        });
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // One notice per PR and cause: a check that keeps failing the same way (a merged PR is
      // retried on every poll) stays quiet until the cause changes or a check succeeds.
      this.#write(office, () =>
        recordCheckError(handle, record.number, reason, this.#deps.clock.now())
          ? [
              notice(
                "error",
                PR_NOTICES.checkError,
                `dipo could not run the structural check on the backlog PR #${record.number}: ${reason}. The PR stays unmerged by dipo, and dipo tries again without another notice until the cause changes.`,
              ),
            ]
          : [],
      );
      throw error;
    }
    const result = checkBacklogPr(diff, factsFor(handle, diff));
    const now = this.#deps.clock.now();
    this.#write(office, () => {
      recordCheck(handle, record.number, { head, base, ...result }, now);
      if (mode === "merged") {
        settleBlocks(handle, record.number, result, now);
        closePrRecord(handle, record.number, "merged", now);
      }
      if (result.passed) return [];
      return result.failures.map((failure) =>
        notice(
          mode === "merged" ? "error" : "warn",
          mode === "merged" ? PR_NOTICES.mergedCheckFailed : PR_NOTICES.checkFailed,
          mode === "merged"
            ? `The backlog PR #${record.number} was merged by hand but fails the structural check [${failure.rule}]${failure.task === undefined ? "" : ` on ${failure.task}`}: ${failure.message}. dipo does not run the affected stories until a new backlog PR fixes them.`
            : `The backlog PR #${record.number} fails the structural check [${failure.rule}]${failure.task === undefined ? "" : ` on ${failure.task}`}: ${failure.message}. dipo keeps it open and does not merge it.`,
          failure.key,
        ),
      );
    });
    return result;
  }

  /**
   * The commit the head is diffed against. An open PR: the merge base of the head and
   * `<remote>/<base>`. A merged PR: the base the last check of this head used; else, for a head
   * never checked, the merge base of the head and the merge commit's first parent (the base before
   * the merge, for a merge commit, a squash or a rebase alike); else the merge base with
   * `<remote>/<base>`. After a merge commit that last one is the head itself, which would check an
   * empty diff, so that case throws instead.
   */
  async #diffBase(
    git: GitSession,
    lane: OfficeLane,
    record: BacklogPrRecord,
    head: string,
    merged: { readonly mergeCommit: string | null } | null,
  ): Promise<string> {
    const mergeBase = async (other: string) =>
      (await git.ok(git.repository, ["merge-base", head, other])).trim();
    const baseRef = `refs/remotes/${lane.git.settings.remote}/${await this.#baseName(git, lane)}`;
    if (merged === null) return mergeBase(baseRef);
    if (record.checkedBase !== null && record.checkedHead === head) return record.checkedBase;
    if (merged.mergeCommit !== null) {
      const parent = await this.#revParse(git, `${merged.mergeCommit}^1`);
      if (parent !== null) {
        const base = await mergeBase(parent);
        if (base !== head) return base;
      }
    }
    const base = await mergeBase(baseRef);
    if (base === head) {
      throw new Error(
        `the merged head ${head} is already on ${baseRef} and dipo has no record of the base it was cut from, so the PR's own changes cannot be told apart`,
      );
    }
    return base;
  }

  // ---- helpers -------------------------------------------------------------------------------

  /** The office's base (`OfficeGit.resolveBaseIn`), failing with the text the PR notices show. */
  async #baseName(git: GitSession, lane: OfficeLane): Promise<string> {
    return lane.git.resolveBaseIn(git).catch((error: unknown) => {
      if (error instanceof GitError && error.code === "git.baseUnknown") {
        throw new Error(`the office has no base branch: set \`base\` in .dipo/office.yaml`);
      }
      throw error;
    });
  }

  async #remoteUrl(git: GitSession, lane: OfficeLane): Promise<string | null> {
    const result = await git.step(git.repository, [
      "config",
      "--get",
      `remote.${lane.git.settings.remote}.url`,
    ]);
    const url = result.stdout.trim();
    return result.code === 0 && url !== "" ? url : null;
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

  #setWaiting(office: OfficeId, waiting: PrWaiting | null): void {
    const state = this.#stateOf(office);
    const before = state.waiting;
    state.waiting = waiting;
    if (waiting === null) return;
    if (before?.branch === waiting.branch && before.reason === waiting.reason) return;
    this.#write(office, () => [
      notice(
        "warn",
        PR_NOTICES.waiting,
        `The backlog branch ${waiting.branch} waits; dipo opened no PR for it: ${waiting.detail}`,
      ),
    ]);
  }

  #write(office: OfficeId, fn: () => NewEntry[] | void): void {
    const handle = this.#handle(office);
    const now = this.#deps.clock.now();
    const count = handle.immediate(() => {
      const entries = fn() ?? [];
      appendEntries(handle, entries, { at: now });
      return entries.length;
    });
    if (count > 0) this.#deps.onChanged?.(office);
  }

  #stateOf(office: OfficeId): OfficeState {
    let state = this.#state.get(office);
    if (state === undefined) {
      state = { busy: Promise.resolve(), waiting: null, notAdopted: new Map() };
      this.#state.set(office, state);
    }
    return state;
  }

  #serial<T>(office: OfficeId, fn: () => Promise<T>): Promise<T> {
    const state = this.#stateOf(office);
    const run = state.busy.then(fn, fn);
    state.busy = run.catch(() => undefined);
    return run;
  }

  #handle(office: OfficeId): OfficeHandle {
    const handle = this.#deps.offices.get(office);
    if (handle === undefined) throw new Error(`Office ${office} has not loaded.`);
    return handle;
  }

  #lane(office: OfficeId): OfficeLane {
    const lane = this.#deps.lane(office);
    if (lane === undefined) throw new Error(`Office ${office} has no planning lane yet.`);
    return lane;
  }
}

function notice(
  level: "info" | "warn" | "error",
  code: string,
  text: string,
  key?: StoryKey,
): NewEntry {
  return {
    type: "engine.notice",
    ...(key === undefined ? {} : { key }),
    delta: { level, code, text },
  };
}

/** `[HOST/]OWNER/REPO` of a PR URL such as `https://github.com/o/r/pull/7`. */
export function repoOfUrl(url: string): string | null {
  const match = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/\d+$/.exec(url);
  if (match === null) return null;
  const [, host, owner, name] = match;
  return host === "github.com" ? `${owner}/${name}` : `${host}/${owner}/${name}`;
}

/** The stored facts the check reads for the tasks of `diff`. */
export function factsFor(office: OfficeHandle, diff: PrDiff): PrFacts {
  const keys: Record<string, StoryKey> = {};
  const passing: Record<string, string[]> = {};
  const claimed: StoryKey[] = [];
  for (const task of diff.tasks) {
    const resolved = resolveStoryRef(office, task.id);
    if (!resolved.ok) continue;
    keys[task.id] = resolved.key;
    if (hasLiveClaim(office, resolved.key)) claimed.push(resolved.key);
    passing[resolved.key] = gateDecisionsOf(office, resolved.key)
      .filter((decision) => decision.passed)
      .map((decision) => decision.contentHash);
  }
  return { keys, claimed, passing };
}

/**
 * After a merge: blocks the stories a failure names (a PR-wide failure blocks every touched
 * story) and clears older blocks of touched stories this PR fixed.
 */
function settleBlocks(
  office: OfficeHandle,
  number: number,
  result: CheckResult,
  now: number,
): void {
  const wide = result.failures.filter((failure) => failure.key === undefined);
  const blocked = new Map<StoryKey, CheckResult["failures"][number][]>();
  for (const failure of result.failures) {
    if (failure.key !== undefined)
      blocked.set(failure.key, [...(blocked.get(failure.key) ?? []), failure]);
  }
  if (wide.length > 0) {
    for (const key of result.touched) blocked.set(key, [...(blocked.get(key) ?? []), ...wide]);
  }
  blockStories(
    office,
    number,
    [...blocked].map(([key, failures]) => ({ key, failures })),
    now,
  );
  clearBlocks(
    office,
    number,
    result.touched.filter((key) => !blocked.has(key)),
    now,
  );
}

/**
 * Why the office cannot adopt a backlog PR because it has one of its own: an open backlog PR or an
 * open lane branch (DIPO-80); null when it has neither.
 */
function ownOpen(office: OfficeHandle): string | null {
  const own = openPrs(office)[0];
  const branch = openEntries(office).findLast((entry) => entry.branch !== null)?.branch;
  if (own === undefined && branch === undefined) return null;
  const mine = own !== undefined ? `backlog PR #${own.number}` : `backlog branch ${branch}`;
  return `the office already has its own ${mine} open, and an office has at most one backlog PR`;
}
