// Reconcile (DIPO-56; 0007 section 6, 0001 "Data ownership", 0010 section 7): after an index pass
// read every story (claimed ones on their branch), the engine compares its database with what
// Backlog.md and git say and writes each mismatch as facts with an `engine.notice`, in one
// transaction per mismatch. Nothing changes silently. In order:
//
// 1. At daemon start only: a live claim whose run is active but never got a worker host (the
//    daemon stopped between the claim and the worker start) is released as `orphaned`, its branch
//    kept for the next claim, and the stories are indexed again. One whose run directory holds a
//    launch file may have a host that started without its row: it only gets a notice.
// 1b. A live claim whose story is Done on `_base` (finished through another branch, DIPO-161): one
//    with a live worker is flagged and released at its run's next end; a parked or idle one is
//    released as `done-elsewhere`, its PR closed, its branch deleted when it adds nothing to the
//    base, else kept as a leftover (`done-on-base.ts`).
//    The stories are indexed again after a release; a claim skipped because `_base` moved is
//    retried once after a reindex.
// 2. Git: `git worktree list` and the claimed branches. A running story whose branch changed by
//    hand (gone, or no longer holding the commits dipo recorded, `git-facts.ts`) parks
//    `scope-violation` with the evidence; a claimed story that is not running gets a notice.
//    Prunable worktrees get a notice; `git worktree prune` runs only after the maintainer confirms
//    it by running it.
// 3. Lifecycle (branch while claimed, base otherwise): an active run whose story is no longer
//    In Progress or In Review, or was removed, is stopped. A story In Progress with no claim is an
//    unknown run: a notice, and it is never started.
// 4. Park state, Backlog.md's (DIPO-360, 0001, 0007): whether a story is parked, why and from
//    where is what Backlog.md holds (`backlogPark`: status Parked with an F16 record, or an open
//    planning-lane operation's), never the `parks` table, which is run detail and history. An
//    open `parks` row of a story Backlog.md does not hold as Parked is closed `reconcile`, with a
//    notice; Backlog.md is not touched. A park Backlog.md holds with no open row is recorded with
//    detail "recorded by hand". An F16 record on any other status is a stale fact, not a park
//    (0012 F16 and 0010 section 3 allow it only while Parked; DIPO-190): no park row, and one warn
//    `reconcile.parkStale` notice per pass naming the story, its status and the park reason.
// 5. Ready: a Ready story with no passing gate decision for its current content gets a notice;
//    the pickup re-check decides.

import {
  type Clock,
  FieldBlockPark,
  type OfficeId,
  type StoryKey,
} from "@dipsaus-orchestrator/contract";

import { existsSync } from "node:fs";
import { join } from "node:path";

import { appendEntries, type NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import { findPassingDecision } from "../gate/store/decisions";
import type { OfficeGit } from "../git/office";
import type { CodeHost, PrStateHost } from "../platform/host";
import { LAUNCH_FILE } from "../host/protocol";
import { officeDirectory } from "../office/marker";
import { type BacklogPark, backlogPark, openParkIds, resolvePark } from "../run/park";
import { insertPark, parkedRunOf } from "../run/park-records";
import { type ParkStore, parksBeingResumed } from "../run/park-state";
import type { RunEnd } from "../run/lifecycle";
import { endRunMarked } from "../run/markers";
import { activeRuns, findRun, parkedFromInReview, type StoredRun, unparkRun } from "../run/records";
import { runDirectory } from "../runs/worker-hosts";
import type { IndexResult } from "../stories/index-stories";
import { readsOnBranch } from "../stories/index-stories";
import { lifecycleOf } from "../views/story";
import { type ClaimRecord, liveClaims } from "../worktree/records";

import { releaseDoneOnBase } from "./done-on-base";
import { clearCommands, goneWorktrees, readGitFacts } from "./git-facts";

/** The launch file a run's worker host is started with (DIPO-44), in its run directory. */
function launchFileOf(git: OfficeGit, runId: string): string {
  return join(runDirectory(officeDirectory(git.commonDir), runId), LAUNCH_FILE);
}

/** `engine.notice` codes of reconcile. */
export const RECONCILE_NOTICES = {
  orphanClaim: "reconcile.orphanClaim",
  branchUnread: "reconcile.branchUnread",
  handChanged: "reconcile.handChanged",
  prunable: "reconcile.prunable",
  runStopped: "reconcile.runStopped",
  unknownRun: "reconcile.unknownRun",
  parkClosed: "reconcile.parkClosed",
  parkRecorded: "reconcile.parkRecorded",
  /** An F16 park record on a story that is not Parked (DIPO-190). */
  parkStale: "reconcile.parkStale",
  readyUngated: "reconcile.readyUngated",
  markerMismatch: "reconcile.markerMismatch",
  adoptFailed: "reconcile.adoptFailed",
  failed: "reconcile.failed",
} as const;

/** The park detail of an F16 record reconcile finds without a park row (0007 section 6). */
export const RECORDED_BY_HAND = "recorded by hand";

/** The release reason of an orphaned claim. */
export const ORPHANED = "orphaned";

/** Lifecycles in which a run may be active. */
const RUNNING_LIFECYCLES: ReadonlySet<string> = new Set(["In Progress", "In Review"]);

export type ReconcileTrigger = "start" | "rescan";

/** How reconcile acts on runs (the run control, DIPO-50). */
export interface ReconcileRuns {
  /** True while the run control is already ending the run (a cap, a report, `story.park`). */
  isEnding(run: string): boolean;
  stopForReconcile(
    office: OfficeHandle,
    run: StoredRun,
    notice: { readonly code: string; readonly text: string },
    ending: RunEnd,
  ): Promise<void>;
  parkForReconcile(
    office: OfficeHandle,
    run: StoredRun,
    detail: string,
    notice: { readonly code: string; readonly text: string },
  ): Promise<unknown>;
}

export interface ReconcileDeps {
  /** The story store: the park a pending planning change writes (`plannedPark`, 0010). */
  readonly stories: ParkStore;
  readonly officeId: OfficeId;
  readonly office: OfficeHandle;
  readonly git: OfficeGit;
  readonly clock: Clock;
  /** Without it, a run to stop is ended in the database only and nothing is parked. */
  readonly runs?: ReconcileRuns;
  /** Releases an orphaned claim (`StoryClaims.releaseUnstarted`); without it none is released. */
  readonly releaseClaim?: (claim: ClaimRecord, reason: string) => Promise<void>;

  /** Closes dipo's open story PR of a story Done elsewhere (DIPO-161); without it a notice says so. */
  readonly host?: Pick<CodeHost, "closePr"> | null;
  /**
   * Where the one Done check reads the merged PR of a claim's branch, as the Done poll does
   * (`claimPr`, DIPO-363); without it dipo's record of the story PR answers.
   */
  readonly prs?: PrStateHost | null;
  /** Checks and deletes the boxes of ended runs after a release (0021 section 6). */
  readonly finishBoxes?: () => Promise<unknown>;
}

export interface ReconcileInput {
  readonly trigger: ReconcileTrigger;
  /** The index pass reconcile compares with. */
  readonly pass: IndexResult;
  /** One more index pass, after reconcile released a claim. */
  readonly reindex: () => Promise<IndexResult>;
}

/** One notice reconcile wrote. */
export interface ReconcileFinding {
  readonly code: string;
  readonly key?: StoryKey;
  readonly text: string;
}

export interface ReconcileReport {
  readonly trigger: ReconcileTrigger;
  readonly findings: readonly ReconcileFinding[];
}

interface StoryRow {
  key: string;
  story_id: string;
  removed_at: number | null;
  kind: "task" | "draft" | null;
  status: string | null;
  park: string | null;
}

interface Story {
  readonly key: StoryKey;
  readonly story: string;
  readonly removed: boolean;
  /** The lifecycle the mirror holds, or null when no pass mirrored the story. */
  readonly lifecycle: string | null;
  readonly park: FieldBlockPark | null;
}

function storiesOf(office: OfficeHandle): Map<StoryKey, Story> {
  const rows = office.all<StoryRow>(
    `select s.key as key, s.story_id as story_id, s.removed_at as removed_at, m.kind as kind,
            m.status as status, m.park as park
       from stories s left join backlog_mirror m on m.office_id = s.office_id and m.key = s.key
      where s.office_id = $office_id
      order by s.story_id, s.key`,
  );
  const stories = new Map<StoryKey, Story>();
  for (const row of rows) {
    const parsed = row.park === null ? null : FieldBlockPark.safeParse(JSON.parse(row.park));
    stories.set(row.key as StoryKey, {
      key: row.key as StoryKey,
      story: row.story_id,
      removed: row.removed_at !== null,
      lifecycle:
        row.kind === null || row.status === null ? null : lifecycleOf(row.kind, row.status),
      park: parsed?.success === true ? parsed.data : null,
    });
  }
  return stories;
}

function hasHost(office: OfficeHandle, run: string): boolean {
  return (
    office.get<{ one: number }>(
      "select 1 as one from worker_hosts where office_id = $office_id and run_id = $run limit 1",
      { run },
    ) !== null
  );
}

/** Reconciles one office; see the file comment. */
export async function reconcileOffice(
  deps: ReconcileDeps,
  input: ReconcileInput,
): Promise<ReconcileReport> {
  const { office } = deps;
  const findings: ReconcileFinding[] = [];
  /** Writes `facts` and the notice in one transaction. */
  const record = (
    finding: ReconcileFinding,
    facts: () => readonly NewEntry[] | void = () => {},
    level: "info" | "warn" = "warn",
  ): void => {
    const at = deps.clock.now();
    office.immediate(() => {
      const written = facts() ?? [];
      const entry: NewEntry = {
        type: "engine.notice",
        ...(finding.key === undefined ? {} : { key: finding.key }),
        delta: { level, code: finding.code, text: finding.text },
      };
      appendEntries(office, [...written, entry], { at });
    });
    findings.push(finding);
  };
  const found = (finding: ReconcileFinding): void => {
    findings.push(finding);
  };
  const runNotice = (finding: ReconcileFinding): { code: string; text: string } => {
    findings.push(finding);
    return { code: finding.code, text: finding.text };
  };

  // 1. Orphaned claims, at daemon start only: no run of this office can be starting now.
  let pass = input.pass;
  if (input.trigger === "start" && deps.releaseClaim !== undefined) {
    let released = 0;
    for (const claim of liveClaims(office)) {
      if (!readsOnBranch(claim)) continue;
      const run = findRun(office, claim.runId);
      if (run === null || run.endedAt !== null || hasHost(office, claim.runId)) continue;
      // A launch file means the host may have started just before the daemon stopped, without
      // its row: its claim is left alone, so a worker that may run keeps it.
      if (existsSync(launchFileOf(deps.git, claim.runId))) {
        record({
          code: RECONCILE_NOTICES.orphanClaim,
          key: claim.key,
          text: `${claim.story} was claimed and its worker host may have started just before the daemon stopped, but dipo has no record of it; dipo leaves the claim alone. Park it with \`dipo park ${claim.story} --note <why>\` if no worker runs.`,
        });
        continue;
      }
      await deps.releaseClaim(claim, ORPHANED);
      released += 1;
      record({
        code: RECONCILE_NOTICES.orphanClaim,
        key: claim.key,
        text: `${claim.story} was claimed, but its worker never started (the daemon stopped first); dipo released the claim and kept ${claim.branch} for the next run.`,
      });
    }
    if (released > 0) pass = await input.reindex();
  }

  // 1b. Claims of stories Done on `_base` (DIPO-216), at start and on every rescan. A claim skipped
  // because `_base` moved since the pass is tried once more after one reindex (DIPO-226).
  const first = await releaseDoneOnBase(deps, pass, record, undefined, found);
  if (first.released > 0 || first.baseMoved > 0) pass = await input.reindex();
  if (first.baseMoved > 0) {
    // Only the claims the first pass skipped: the others were already looked at, and a kept one
    // would otherwise get its notice a second time.
    const retry = await releaseDoneOnBase(deps, pass, record, new Set(first.skippedRuns), found);
    if (retry.released > 0) pass = await input.reindex();
  }

  // 2. Git facts of the live claims.
  const claims = liveClaims(office).filter(readsOnBranch);
  const facts = await readGitFacts(deps.git, office, claims);
  const unread = new Set<string>(pass.branchUnread.map((u) => u.key));
  for (const u of pass.branchUnread) {
    if (facts.changed.has(claimOfKey(claims, u.key)?.runId ?? "")) continue;
    record({
      code: RECONCILE_NOTICES.branchUnread,
      key: u.key as StoryKey,
      text: `dipo could not read ${u.story} on its branch ${u.branch} (${u.reason}); dipo keeps its last read, its status and park included, until the branch reads again.`,
    });
  }
  const gone = goneWorktrees(facts.worktrees);
  if (gone.length > 0) {
    record(
      {
        code: RECONCILE_NOTICES.prunable,
        text: `git lists worktrees whose directories are gone: ${gone
          .map((w) => `${w.path} (${w.reason})`)
          .join(
            "; ",
          )}. dipo does not unlock or prune them on its own; once you have checked them, run in the repository: \`${clearCommands(gone)}\`.`,
      },
      undefined,
      "info",
    );
  }

  // 2 and 3. Runs: hand changes park, a lifecycle that no longer runs stops.
  let stories = storiesOf(office);
  const handChanged = new Set<string>();
  for (const claim of claims) {
    const evidence = facts.changed.get(claim.runId);
    if (evidence === undefined) continue;
    handChanged.add(claim.key);
    const run = activeRuns(office).find((r) => r.runId === claim.runId);
    const what = `${evidence.join("; ")}`;
    if (run === undefined) {
      record({
        code: RECONCILE_NOTICES.handChanged,
        key: claim.key,
        text: `${claim.story} is claimed but not running, and ${what}. Git wins on these facts; dipo leaves the story where it is.`,
      });
      continue;
    }
    if (deps.runs?.isEnding(run.runId) === true) continue;
    const detail = `Changed by hand: ${what}.`;
    const notice = runNotice({
      code: RECONCILE_NOTICES.handChanged,
      key: claim.key,
      text: `${claim.story} is running, but ${what}; dipo stopped its worker and parked it as scope-violation.`,
    });
    if (deps.runs === undefined) {
      endWithNotice(deps, run, notice, "parked");
    } else {
      await deps.runs.parkForReconcile(office, run, detail, notice);
    }
  }

  for (const run of activeRuns(office)) {
    if (run.kind !== "story" || run.key === null) continue;
    if (handChanged.has(run.key) || unread.has(run.key)) continue;
    if (deps.runs?.isEnding(run.runId) === true) continue;
    const story = stories.get(run.key);
    if (story === undefined) continue;
    let why: string | null = null;
    if (story.removed) {
      why = `${story.story} was removed from Backlog.md (archived, completed or deleted)`;
    } else if (story.lifecycle !== null && !RUNNING_LIFECYCLES.has(story.lifecycle)) {
      why = `${story.story} is ${story.lifecycle} in Backlog.md, no longer In Progress or In Review`;
    }
    if (why === null) continue;
    const notice = runNotice({
      code: RECONCILE_NOTICES.runStopped,
      key: run.key,
      text: `${why}, but its run ${run.runId} was still active; dipo stopped the run.`,
    });
    const ending = reconciledEnding(story);
    if (deps.runs === undefined) endWithNotice(deps, run, notice, ending);
    else await deps.runs.stopForReconcile(office, run, notice, ending);
  }

  stories = storiesOf(office);
  const claimed = new Map(liveClaims(office).map((claim) => [claim.key as string, claim]));
  const running = new Set(
    activeRuns(office)
      .map((run) => run.key)
      .filter((key): key is StoryKey => key !== null),
  );
  for (const story of stories.values()) {
    if (story.removed || story.lifecycle === null) continue;
    const claim = claimed.get(story.key);
    // A claimed story whose branch could not be read, or changed by hand, has no lifecycle to trust.
    if (claim !== undefined && (unread.has(story.key) || handChanged.has(story.key))) continue;

    // 3. In Progress with no claim: an unknown run, never started.
    if (story.lifecycle === "In Progress" && claim === undefined) {
      record({
        code: RECONCILE_NOTICES.unknownRun,
        key: story.key,
        text: `${story.story} is In Progress in Backlog.md, but dipo has no claim for it, so it shows as an unknown run. dipo never starts it on its own; finish it by hand, or set it back to Ready.`,
      });
    }

    // 4. Park state: F16 in Backlog.md against the open park row.
    if (!running.has(story.key)) reconcilePark(deps, story, record);

    // 5. Ready without a passing gate decision for the current content.
    if (story.lifecycle === "Ready" && claim === undefined) {
      const gateHash = pass.read.find((read) => read.story === story.story)?.gateHash;
      if (
        gateHash !== undefined &&
        findPassingDecision(office, story.key, gateHash) === undefined
      ) {
        record(
          {
            code: RECONCILE_NOTICES.readyUngated,
            key: story.key,
            text: `${story.story} is Ready, but dipo has no passing Ready gate decision for its current content; the pickup re-check decides when a run picks it.`,
          },
          undefined,
          "info",
        );
      }
    }
  }

  return { trigger: input.trigger, findings };
}

function claimOfKey(claims: readonly ClaimRecord[], key: string): ClaimRecord | undefined {
  return claims.find((claim) => claim.key === key);
}

/**
 * How a run ends that reconcile stops because its story left In Progress and In Review (0020): its
 * story's status decides. Done (finished outside dipo, also when completed and so removed) ends it
 * done, Parked parked, and a story removed otherwise or moved back before In Progress dropped.
 */
export function reconciledEnding(story: {
  readonly removed: boolean;
  readonly lifecycle: string | null;
}): RunEnd {
  if (story.lifecycle === "Done") return "done";
  if (story.removed) return "dropped";
  return story.lifecycle === "Parked" ? "parked" : "dropped";
}

/** Ends a run in the database only, with its notice, when no run control is wired. */
function endWithNotice(
  deps: ReconcileDeps,
  run: StoredRun,
  notice: { readonly code: string; readonly text: string },
  ending: RunEnd,
): void {
  const at = deps.clock.now();
  deps.office.immediate(() => {
    endRunMarked(deps.office, run.runId, at, ending);
    appendEntries(
      deps.office,
      [
        {
          type: "engine.notice",
          ...(run.key === null ? {} : { key: run.key }),
          run: run.runId,
          delta: { level: "warn", code: notice.code, text: notice.text },
        },
      ],
      { at },
    );
  });
}

/**
 * Inside the caller's transaction: reconcile closes the open park `parkId` that Backlog.md no
 * longer holds. When the story is In Review again and the park's run stood open at In Review when
 * it parked, the run stands open at In Review again (0020, DIPO-373), so the review, the PR poll
 * and the merge take it up as before the park.
 */
export function closePark(
  office: OfficeHandle,
  story: Pick<Story, "lifecycle">,
  parkId: number,
  at: number,
): NewEntry[] {
  const parked = parkedRunOf(office, parkId);
  const entries = resolvePark(office, parkId, "reconcile", at);
  if (parked === null || story.lifecycle !== "In Review") return entries;
  const run = findRun(office, parked.runId as StoredRun["runId"]);
  if (run !== null && parkedFromInReview(run, parked.at)) unparkRun(office, run.runId);
  return entries;
}

/** What reconcile does about a story's park state (step 4). */
export type ParkStateAction = "close" | "record" | "stale" | null;

/**
 * Step 4 decided, pure: an open park row of a story Backlog.md does not hold as Parked is closed;
 * a park Backlog.md holds with no open row is recorded by hand; an F16 record the mirror holds on a
 * story that is not Parked is stale (DIPO-190); else nothing. `current` is `backlogPark`'s answer.
 */
export function parkStateAction(
  story: { readonly park: FieldBlockPark | null },
  current: BacklogPark | null,
  hasOpenPark: boolean,
): ParkStateAction {
  if (hasOpenPark) return current === null ? "close" : null;
  if (current !== null) return "record";
  return story.park === null ? null : "stale";
}

function reconcilePark(
  deps: ReconcileDeps,
  story: Story,
  record: (finding: ReconcileFinding, facts?: () => readonly NewEntry[] | void) => void,
): void {
  const { office } = deps;
  // A park an unfinished maintainer resume is lifting is the resume's to finish (DIPO-360).
  const resuming = parksBeingResumed(office);
  const open = openParkIds(office, story.key).filter((parkId) => !resuming.has(parkId));
  if (open.length === 0 && openParkIds(office, story.key).length > 0) return;
  const current = backlogPark(deps.stories, office, story.key);
  const action = parkStateAction(story, current, open.length > 0);
  if (action === "stale" && story.park !== null) {
    record({
      code: RECONCILE_NOTICES.parkStale,
      key: story.key,
      text: `${story.story} is ${story.lifecycle ?? "not Parked"} in Backlog.md, but its task file still holds a park record (${story.park.reason}); a park record belongs only to a Parked story, so dipo recorded no park. Remove the park block from the task file.`,
    });
    return;
  }
  if (action === "close") {
    record(
      {
        code: RECONCILE_NOTICES.parkClosed,
        key: story.key,
        text: `${story.story} has an open park in dipo's database, but Backlog.md holds it as ${story.lifecycle ?? "unknown"} with no park record; Backlog.md wins, so dipo closed its park.`,
      },
      () => open.flatMap((parkId) => closePark(office, story, parkId, deps.clock.now())),
    );
    return;
  }
  if (action === "record" && current !== null) {
    record(
      {
        code: RECONCILE_NOTICES.parkRecorded,
        key: story.key,
        text: `${story.story} has a park record (${current.reason}) in Backlog.md that dipo did not write; dipo recorded the park as ${RECORDED_BY_HAND}.`,
      },
      () => {
        // The park's history row: the reason it was recorded with (0007), never read as current.
        insertPark(office, {
          key: story.key,
          story: story.story,
          runId: null,
          reason: current.reason,
          detail: RECORDED_BY_HAND,
          at: deps.clock.now(),
        });
      },
    );
  }
}
