// Shared setup for the auto-merge tests of story PRs (0002): a migrated state database built from
// fixtures under DIPO_TMP with one office and one story run open at In Review in phase merge
// (past its review, live claim, a developer agent), its open story PR #7, an approved verdict on
// its pushed head, an in-memory code host with auto-merge and labels, a scripted story merge git,
// the CI state of the PR poll as a map, and a fake park writer. No test here runs git, the Backlog
// CLI or `gh`.

import { type OfficeId, type RunId, type StoryKey } from "@dipsaus-orchestrator/contract";

import { type CatchUpMerged, conflictFeedbackItem } from "../../src/box/collisions";
import { OFFICE_DEFAULTS, type OfficeConfig } from "../../src/config";
import {
  AutoMerge,
  type ConflictMerge,
  type PushOutcome,
  type StoryMergeGit,
  type StoryMergeRun,
} from "../../src/merge";
import type { HostPr } from "../../src/platform/host";
import type { FixItem } from "../../src/prompts/feedback";
import { recordReviewVerdict, type StoredReviewVerdict } from "../../src/review/store";
import type { JudgedReview } from "../../src/review/verdict";
import { recordCatchUp } from "../../src/run/conflicts";
import type { ParkBranchRequest } from "../../src/run/park";
import { reviewedAt } from "../run/in-review";
import type { CiHeadState } from "../../src/story-pr/prs";
import { insertStoryPr, updateStoryPr } from "../../src/story-pr/records";
import type { StoryEditor } from "../../src/story-store/store";
import { REPO } from "../backlog/pr/helpers";
import {
  addAgent,
  type RoundsWorld,
  roundsWorld,
  type StoryRun,
  storyRun,
} from "../run/rounds-helpers";

import { GREEN, MergeHost } from "./helpers";

export const H1 = "1".repeat(40);
/** The close-out commit on top of H1 (a task-file commit: the same code tree). */
export const C1 = "c".repeat(40);
export const TREE = "tree-1";
export const PR = 7;
export const PR_URL = `https://github.com/${REPO}/pull/${PR}`;
export const TITLE = "feat(DIPO-7): add the greeting";
export const BRANCH = "DIPO-7/a-story";

export const APPROVED: JudgedReview = {
  verdict: "approved",
  criteria: [
    { n: 1, status: "met", evidence: "src/greet.ts prints it." },
    { n: 2, status: "met", evidence: "the test checks it." },
  ],
  findings: [],
  summary: "Fine.",
  notes: [],
};

/** A story merge git whose answers the test scripts; every call is logged. */
/** Any read or write of `noStoreEditor`. */
const noStore = () => Promise.reject(new Error("no story store"));

/** A story lane edit whose every read and write fails: the fake only records the close-out. */
function noStoreEditor(id: string): StoryEditor {
  return {
    id,
    file: `backlog/tasks/${id.toLowerCase()} - story.md`,
    view: noStore,
    setStatus: noStore,
    writeFields: noStore,
    appendNotes: noStore,
    setFinalSummary: noStore,
    recordModifiedFiles: noStore,
  };
}

export class FakeStoryGit implements StoryMergeGit {
  readonly calls: string[] = [];
  readonly heads = new Map<string, string>();
  /** The code tree key of each head; a head not listed has its own. */
  readonly trees = new Map<string, string>();
  /** What the next close-out commits; null: the story was Done already. */
  closeOutCommit: string | null = C1;
  /** Answers of the next `conflictMerge` calls, in order; then `none`. */
  merges: ConflictMerge[] = [];
  fetchOk = true;
  pushAnswer: PushOutcome = { ok: true, pushed: true };
  /** The release paths each head changes; null: git cannot tell. None by default. */
  readonly release = new Map<string, readonly string[] | null>();

  async fetch(): Promise<boolean> {
    this.calls.push("fetch");
    return this.fetchOk;
  }

  async head(_office: OfficeId, branch: string): Promise<string | null> {
    return this.heads.get(branch) ?? null;
  }

  async closeOut(
    _office: OfficeId,
    run: StoryMergeRun,
    summary: (story: StoryEditor) => Promise<unknown>,
  ): Promise<string | null> {
    this.calls.push(`closeOut ${run.branch}`);
    const commit = this.closeOutCommit;
    if (commit === null) return null;
    await summary(noStoreEditor(run.story));
    const tip = this.heads.get(run.branch);
    if (tip !== undefined) this.trees.set(commit, this.trees.get(tip) ?? `tree-${tip}`);
    this.heads.set(run.branch, commit);
    // Run again, the story is Done: nothing more is committed.
    this.closeOutCommit = null;
    return commit;
  }

  async conflictMerge(_office: OfficeId, run: StoryMergeRun): Promise<ConflictMerge> {
    this.calls.push(`conflictMerge ${run.branch}`);
    return this.merges.shift() ?? { kind: "none" };
  }

  async conflictItem(_office: OfficeId, _run: StoryMergeRun, merged: CatchUpMerged) {
    this.calls.push(`conflictItem ${merged.commit}`);
    return conflictFeedbackItem({
      base: merged.base,
      onto: merged.onto,
      conflicts: merged.conflicts,
      hunks: [],
    });
  }

  async moveBranch(
    _office: OfficeId,
    branch: string,
    commit: string,
    tip: string,
  ): Promise<boolean> {
    this.calls.push(`moveBranch ${branch}`);
    if (this.heads.get(branch) !== tip) return false;
    this.heads.set(branch, commit);
    return true;
  }

  async push(_office: OfficeId, branch: string): Promise<PushOutcome> {
    this.calls.push(`push ${branch}`);
    return this.pushAnswer;
  }

  async treeKey(_office: OfficeId, _story: string, head: string): Promise<string | null> {
    return this.trees.get(head) ?? `tree-${head}`;
  }

  async releasePaths(_office: OfficeId, head: string): Promise<readonly string[] | null> {
    const paths = this.release.get(head);
    return paths === undefined ? [] : paths;
  }
}

export interface StoryWorld {
  readonly w: RoundsWorld;
  readonly officeId: OfficeId;
  readonly story: StoryRun;
  readonly run: RunId;
  readonly key: StoryKey;
  readonly host: MergeHost;
  readonly git: FakeStoryGit;
  readonly ci: Map<string, CiHeadState>;
  readonly parks: ParkBranchRequest[];
  readonly conflicts: { run: RunId; head: string; item: FixItem }[];
  readonly merges: CatchUpMerged[];
  readonly prSyncs: RunId[];
  /** The record of a merge dipo made fails (the fake `recordMerge` throws). */
  failRecord: boolean;
  config: OfficeConfig;
  /** The verdict on H1. */
  readonly verdict: StoredReviewVerdict;
  readonly merge: AutoMerge;
  /** One round of the office's auto-merge. */
  tick(): Promise<void>;
  close(): void;
}

/** The PR #7 the host shows for the story, open at `headSha`. */
export function hostPr(headSha: string, state: HostPr["state"] = "open"): HostPr {
  return {
    number: PR,
    url: PR_URL,
    state,
    head: BRANCH,
    headSha,
    base: "main",
    title: TITLE,
    mergeCommit: null,
    mergeable: "mergeable",
    autoMerge: false,
  };
}

export async function storyWorld(
  options: { readonly judged?: JudgedReview } = {},
): Promise<StoryWorld> {
  const w = await roundsWorld("story-merge-");
  const officeId = w.office.officeId as OfficeId;
  const story = storyRun(w, { story: "DIPO-7", reviewRoundCap: 3 });
  addAgent(w, story.run, "developer", false);
  const now = w.t.clock.now();
  let verdict: StoredReviewVerdict | null = null;
  w.office.immediate(() => {
    reviewedAt(w.office, story.run, now);
    insertStoryPr(w.office, {
      runId: story.run,
      key: story.key,
      number: PR,
      url: PR_URL,
      branch: BRANCH,
      base: "main",
      headSha: H1,
      state: "open",
      title: TITLE,
      bodyHash: "hash",
      openedAt: now,
      closedAt: null,
    });
    verdict = recordReviewVerdict(w.office, w.t.ids, {
      runId: story.run,
      key: story.key,
      round: 1,
      agent: null,
      model: "opus",
      commit: H1,
      codeTreeKey: TREE,
      judged: options.judged ?? APPROVED,
      at: now,
    });
  });
  const host = new MergeHost();
  host.prs.set(PR, hostPr(H1));
  host.checks = GREEN;
  const git = new FakeStoryGit();
  git.heads.set(BRANCH, H1);
  git.trees.set(H1, TREE);
  const ci = new Map<string, CiHeadState>([[story.run, { kind: "green", head: H1 }]]);
  const parks: ParkBranchRequest[] = [];
  const conflicts: StoryWorld["conflicts"] = [];
  const merges: CatchUpMerged[] = [];
  const prSyncs: RunId[] = [];
  const self = {} as { -readonly [K in keyof StoryWorld]: StoryWorld[K] };
  const merge = new AutoMerge({
    host,
    offices: {
      get: (id) => (id === officeId ? w.office : undefined),
      config: () => self.config,
    },
    clock: w.t.clock,
    stories: {
      git,
      ids: w.t.ids,
      labels: host,
      ci: (_office, runId) => ci.get(runId) ?? null,
      prSync: async (_office, runId) => {
        prSyncs.push(runId);
        // As `StoryPrs.sync` does: the PR follows the branch's pushed head.
        const head = git.heads.get(BRANCH) ?? H1;
        w.office.immediate(() =>
          updateStoryPr(w.office, runId, { headSha: head, title: TITLE, bodyHash: "hash" }),
        );
        const pr = host.prs.get(PR);
        if (pr !== undefined) host.prs.set(PR, { ...pr, headSha: head });
      },
      summary: async () => "summary",
      recordMerge: async (_office, stored, merged) => {
        if (self.failRecord) throw new Error("the database is locked");
        merges.push(merged);
        w.office.immediate(() => {
          recordCatchUp(
            w.office,
            stored.runId,
            { kind: "merged", ...merged, commit: merged.commit },
            w.t.clock.now(),
          );
        });
      },
      conflict: async (_office, runId, input) => {
        conflicts.push({ run: runId, ...input });
        return true;
      },
      park: {
        writer: {
          write: async (_office, request) => {
            parks.push(request);
            return {
              commit: "p".repeat(40),
              lastGoodCommit: H1,
              from: "In Review",
              pushed: true,
              pushError: null,
            };
          },
        },
        implemented: () => true,
      },
    },
  });
  Object.assign(self, {
    w,
    officeId,
    story,
    run: story.run,
    key: story.key,
    host,
    git,
    ci,
    parks,
    conflicts,
    merges,
    prSyncs,
    config: OFFICE_DEFAULTS,
    failRecord: false,
    verdict: verdict as unknown as StoredReviewVerdict,
    merge,
    tick: () => merge.tick(officeId),
    close: () => w.close(),
  });
  return self;
}

/** The `engine.notice` codes of the office, oldest first. */
export function noticeCodes(office: RoundsWorld["office"]): string[] {
  return office
    .all<{ delta: string }>(
      "select delta from change_log where office_id = $office_id and type = 'engine.notice' order by seq",
    )
    .map((row) => (JSON.parse(row.delta) as { code: string }).code);
}

export { noticeTexts } from "./helpers";
