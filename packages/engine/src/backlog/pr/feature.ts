// The office's one backlog PR (0010 section 2, lane b; 0016 rule 1). After each flush of the
// planning lane the engine opens a PR for the pushed engine branch `dipo/backlog-*`, or updates the
// one it has, through the code host (`platform/host.ts`, `gh` with the maintainer's own login), and
// stores the PR on the journal entries. Whenever the PR's head changes it runs the structural check
// (`check.ts`); a failure keeps the PR open, puts an `engine.notice` per failure on the office and
// leaves the PR not mergeable for the merge slot (DIPO-73, `backlogPrMergeable`).
//
// `sync` asks the host about the office's open backlog PRs: one merged by hand is checked again
// right away, against the head that merged; a failure is a notice and blocks the stories it names
// (`backlogCheckBlocked`) until a later backlog PR that touches them merges with a passing check.
// A PR closed on the host is recorded as closed. A lane rebuild (a new branch) closes the old PR.
//
// Without a remote, with a push or fetch waiting, or when `gh` is missing, too old or not logged in,
// no PR is opened: `waiting(office)` names the branch and why, and a notice says so once per cause.
//
// Work for one office runs one piece at a time. Git steps (the check's diff, reading refs) run as
// items of the office git queue; `gh` calls run outside it.

import type { Clock, OfficeId, StoryKey } from "@dipsaus-orchestrator/contract";

import { appendEntries, type NewEntry } from "../../changelog/log";
import type { OfficeHandle } from "../../db/office";
import { gateDecisionsOf } from "../../gate/store/decisions";
import type { GitSession } from "../../git/office";
import { type CodeHost, CodeHostError, type HostPr, repoOfRemoteUrl } from "../../platform/host";
import { resolveStoryRef } from "../../stories/keys";
import { hasLiveClaim } from "../../worktree/records";
import { openEntries, recordPrRef } from "../lane/journal";
import { type FlushReport, type OfficeLane } from "../lane/lane";
import type { BacklogCli } from "../runner";

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
} as const;

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
};

interface OfficeState {
  busy: Promise<unknown>;
  waiting: PrWaiting | null;
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
   * Runs the structural check on the open PR `number` at its current head and stores the result,
   * as the merge slot does right before it merges (DIPO-73). Returns the result.
   */
  recheck(office: OfficeId, number: number): Promise<CheckResult> {
    return this.#serial(office, async () => {
      const lane = this.#lane(office);
      const pr = findPr(this.#handle(office), number);
      if (pr === null) throw new Error(`Office ${office} has no backlog PR #${number}.`);
      const head = await lane.git.run((git) => this.#revParse(git, `refs/heads/${pr.branch}`));
      if (head === null) throw new Error(`The backlog branch ${pr.branch} no longer exists.`);
      return this.#check(office, lane, pr, head, "open");
    });
  }

  // ---- publish -------------------------------------------------------------------------------

  async #publish(office: OfficeId, report: FlushReport): Promise<void> {
    const handle = this.#handle(office);
    const lane = this.#lane(office);
    if (report.rebuiltFrom !== null) await this.#closeReplaced(office, report.rebuiltFrom, report);
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
    if (record.checkedHead !== where.head)
      await this.#check(office, lane, record, where.head, "open");
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
      if (pr.state === "open") continue;
      const now = this.#deps.clock.now();
      if (pr.state === "closed") {
        this.#write(office, () => closePrRecord(handle, record.number, "closed", now));
        continue;
      }
      this.#write(office, () => closePrRecord(handle, record.number, "merged", now));
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
        continue;
      }
      await this.#check(office, lane, record, head, "merged");
    }
  }

  // ---- the check -----------------------------------------------------------------------------

  async #check(
    office: OfficeId,
    lane: OfficeLane,
    record: BacklogPrRecord,
    head: string,
    mode: "open" | "merged",
  ): Promise<CheckResult> {
    const handle = this.#handle(office);
    let diff: PrDiff;
    try {
      diff = await lane.git.run(async (git) => {
        const baseName = await this.#baseName(git, lane);
        const baseRef = `refs/remotes/${lane.git.settings.remote}/${baseName}`;
        const mergeBase = (await git.ok(git.repository, ["merge-base", head, baseRef])).trim();
        const location = lane.git.worktreeLocation(lane.worktreePath());
        if (location.kind !== "worktree") throw new Error("expected the backlog worktree");
        return collectPrDiff({
          git,
          worktree: location,
          cli: this.#deps.cli,
          base: mergeBase,
          head,
        });
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.#write(office, () => [
        notice(
          "error",
          PR_NOTICES.checkError,
          `dipo could not run the structural check on the backlog PR #${record.number}: ${reason}. The PR stays unmerged by dipo.`,
        ),
      ]);
      throw error;
    }
    const result = checkBacklogPr(diff, factsFor(handle, diff));
    const now = this.#deps.clock.now();
    this.#write(office, () => {
      recordCheck(handle, record.number, { head, ...result }, now);
      if (mode === "merged") settleBlocks(handle, record.number, result, now);
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

  // ---- helpers -------------------------------------------------------------------------------

  async #baseName(git: GitSession, lane: OfficeLane): Promise<string> {
    const { base, remote } = lane.git.settings;
    if (base !== undefined) return base;
    const head = await git.step(git.repository, [
      "symbolic-ref",
      "--quiet",
      `refs/remotes/${remote}/HEAD`,
    ]);
    const prefix = `refs/remotes/${remote}/`;
    const target = head.stdout.trim();
    if (head.code !== 0 || !target.startsWith(prefix)) {
      throw new Error(`the office has no base branch: set \`base\` in .dipo/office.yaml`);
    }
    return target.slice(prefix.length);
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
      state = { busy: Promise.resolve(), waiting: null };
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
function repoOfUrl(url: string): string | null {
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
