// Shared setup for the story merge slot tests (DIPO-150): a migrated state database built from
// fixtures under DIPO_TMP with one office and one story run waiting In Review (ended as reviewed,
// live claim, a developer agent), its open story PR #7, an approved verdict on its pushed head, an
// in-memory code host with labels, a scripted story slot git, the CI state of the PR poll as a
// map, and a fake park writer. No test here runs git, the Backlog CLI or `gh`.

import { type OfficeId, type RunId, type StoryKey } from "@dipsaus-orchestrator/contract";

import type { StoryTarget } from "../../src/backlog/fields/write";
import type { CatchUpMerged } from "../../src/box/collisions";
import type { OfficeLane } from "../../src/backlog/lane";
import { OFFICE_DEFAULTS, type OfficeConfig } from "../../src/config";
import {
  type BaseSync,
  MergeSlot,
  type PushOutcome,
  type SlotGit,
  type StorySlotGit,
  type StorySlotRun,
  type StorySync,
} from "../../src/merge-slot";
import type { HostPr } from "../../src/platform/host";
import type { FixItem } from "../../src/prompts/feedback";
import { recordReviewVerdict, type StoredReviewVerdict } from "../../src/review/store";
import type { JudgedReview } from "../../src/review/verdict";
import type { ParkBranchRequest } from "../../src/run/park";
import { endRun, REVIEWED_END } from "../../src/run/records";
import type { CiHeadState } from "../../src/story-pr/prs";
import { insertStoryPr, updateStoryPr } from "../../src/story-pr/records";
import { REPO } from "../backlog/pr/helpers";
import {
  addAgent,
  type RoundsWorld,
  roundsWorld,
  type StoryRun,
  storyRun,
} from "../run/rounds-helpers";

import { GREEN, SlotHost } from "./helpers";

export const H1 = "1".repeat(40);
/** The close-out commit on top of H1 (a task-file commit: the same code tree). */
export const C1 = "c".repeat(40);
export const TREE = "tree-1";
export const PR = 7;
export const PR_URL = `https://github.com/${REPO}/pull/${PR}`;
export const TITLE = "feat(DIPO-7): add the greeting";

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

/** A code host with labels per PR (`PrReviewHost.prLabels`). */
export class StoryHost extends SlotHost {
  readonly labels = this.prLabelsOf;
}

/** A story slot git whose answers the test scripts; every call is logged. */
export class FakeStoryGit implements StorySlotGit {
  readonly calls: string[] = [];
  readonly heads = new Map<string, string>();
  /** The code tree key of each head; a head not listed has its own. */
  readonly trees = new Map<string, string>();
  /** What the next close-out commits; null: the story was Done already. */
  closeOutCommit: string | null = C1;
  /** Answers of the next `sync` calls, in order; then `none`. */
  syncs: StorySync[] = [];
  fetchOk = true;
  containsBaseAnswer = true;
  pushAnswer: PushOutcome = { ok: true, pushed: true };
  /** The summaries the close-out wrote, by story. */
  readonly summaries: string[] = [];

  async fetch(): Promise<boolean> {
    this.calls.push("fetch");
    return this.fetchOk;
  }

  async head(_office: OfficeId, branch: string): Promise<string | null> {
    return this.heads.get(branch) ?? null;
  }

  async containsBase(_office: OfficeId, branch: string): Promise<boolean> {
    this.calls.push(`containsBase ${branch}`);
    return this.containsBaseAnswer;
  }

  async closeOut(
    _office: OfficeId,
    run: StorySlotRun,
    summary: (target: StoryTarget) => Promise<unknown>,
  ): Promise<string | null> {
    this.calls.push(`closeOut ${run.branch}`);
    const commit = this.closeOutCommit;
    if (commit === null) return null;
    await summary({
      cli: { spawn: () => Promise.reject(new Error("no CLI")) as never },
      cwd: "/x",
      id: run.story,
    });
    this.summaries.push(run.story);
    const tip = this.heads.get(run.branch);
    if (tip !== undefined) this.trees.set(commit, this.trees.get(tip) ?? `tree-${tip}`);
    this.heads.set(run.branch, commit);
    // Run again after a restart, the story is Done: nothing more is committed.
    this.closeOutCommit = null;
    return commit;
  }

  async sync(_office: OfficeId, run: StorySlotRun, mode: string): Promise<StorySync> {
    this.calls.push(`sync ${run.branch} ${mode}`);
    const next = this.syncs.shift();
    if (next === undefined) return { kind: "none" };
    if (next.kind === "merged") this.heads.set(run.branch, next.head);
    return next;
  }

  async push(_office: OfficeId, branch: string): Promise<PushOutcome> {
    this.calls.push(`push ${branch}`);
    return this.pushAnswer;
  }

  async treeKey(_office: OfficeId, _story: string, head: string): Promise<string | null> {
    return this.trees.get(head) ?? `tree-${head}`;
  }
}

/** A backlog slot git that is never reached (no lane in these tests). */
export const NO_BACKLOG_GIT: SlotGit = {
  fetch: () => Promise.reject(new Error("no backlog git")),
  head: async () => null,
  containsBase: () => Promise.reject(new Error("no backlog git")),
  syncBase: (): Promise<BaseSync> => Promise.reject(new Error("no backlog git")),
  push: () => Promise.reject(new Error("no backlog git")),
  inHead: async () => false,
  deleteBranch: async () => {},
};

export interface StoryWorld {
  readonly w: RoundsWorld;
  readonly officeId: OfficeId;
  readonly story: StoryRun;
  readonly run: RunId;
  readonly key: StoryKey;
  readonly host: StoryHost;
  readonly git: FakeStoryGit;
  readonly ci: Map<string, CiHeadState>;
  readonly parks: ParkBranchRequest[];
  readonly conflicts: { run: RunId; head: string; item: FixItem }[];
  readonly merges: CatchUpMerged[];
  readonly prSyncs: RunId[];
  config: OfficeConfig;
  /** The verdict on H1. */
  readonly verdict: StoredReviewVerdict;
  /** A new merge slot on the same database: a daemon restart. */
  slot: MergeSlot;
  restart(): MergeSlot;
  close(): void;
}

/** The PR #7 the host shows for the story, open at `headSha`. */
export function hostPr(headSha: string, state: HostPr["state"] = "open"): HostPr {
  return {
    number: PR,
    url: PR_URL,
    state,
    head: "DIPO-7/a-story",
    headSha,
    base: "main",
    title: TITLE,
    mergeCommit: null,
  };
}

export async function storyWorld(
  options: {
    readonly judged?: JudgedReview;
    /** A backlog PR lane and its git, for the slot both kinds share; none by default. */
    readonly backlog?: { readonly lane: OfficeLane; readonly git: SlotGit };
  } = {},
): Promise<StoryWorld> {
  const w = await roundsWorld("story-slot-");
  const officeId = w.office.officeId as OfficeId;
  const story = storyRun(w, { story: "DIPO-7", reviewRoundCap: 3 });
  addAgent(w, story.run, "developer", false);
  const now = w.t.clock.now();
  let verdict: StoredReviewVerdict | null = null;
  w.office.immediate(() => {
    endRun(w.office, story.run, now, REVIEWED_END);
    insertStoryPr(w.office, {
      runId: story.run,
      key: story.key,
      number: PR,
      url: PR_URL,
      branch: "DIPO-7/a-story",
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
  const host = new StoryHost();
  host.prs.set(PR, hostPr(H1));
  host.checks = GREEN;
  const git = new FakeStoryGit();
  git.heads.set("DIPO-7/a-story", H1);
  git.trees.set(H1, TREE);
  const ci = new Map<string, CiHeadState>([[story.run, { kind: "green", head: H1 }]]);
  const parks: ParkBranchRequest[] = [];
  const conflicts: StoryWorld["conflicts"] = [];
  const merges: CatchUpMerged[] = [];
  const prSyncs: RunId[] = [];
  const self = {} as { -readonly [K in keyof StoryWorld]: StoryWorld[K] };
  const make = (): MergeSlot =>
    new MergeSlot({
      host,
      prs: { recheck: () => Promise.reject(new Error("no backlog PR in these tests")) },
      lane: () => options.backlog?.lane,
      offices: {
        get: (id) => (id === officeId ? w.office : undefined),
        config: () => self.config,
      },
      clock: w.t.clock,
      git: () => options.backlog?.git ?? NO_BACKLOG_GIT,
      stories: {
        git,
        ids: w.t.ids,
        labels: host,
        ci: (_office, runId) => ci.get(runId) ?? null,
        prSync: async (_office, runId) => {
          prSyncs.push(runId);
          // As `StoryPrs.sync` does: the PR follows the branch's pushed head.
          const head = git.heads.get("DIPO-7/a-story") ?? H1;
          w.office.immediate(() =>
            updateStoryPr(w.office, runId, { headSha: head, title: TITLE, bodyHash: "hash" }),
          );
          const pr = host.prs.get(PR);
          if (pr !== undefined) host.prs.set(PR, { ...pr, headSha: head });
        },
        summary: async () => "summary",
        recordMerge: async (_office, _run, merged) => {
          merges.push(merged);
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
    verdict: verdict as unknown as StoredReviewVerdict,
    slot: make(),
    restart: () => {
      self.slot = make();
      return self.slot;
    },
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

/** The `engine.notice` texts of `code`, oldest first. */
export function noticeTexts(office: RoundsWorld["office"], code: string): string[] {
  return office
    .all<{ delta: string }>(
      "select delta from change_log where office_id = $office_id and type = 'engine.notice' order by seq",
    )
    .map((row) => JSON.parse(row.delta) as { code: string; text: string })
    .filter((delta) => delta.code === code)
    .map((delta) => delta.text);
}
