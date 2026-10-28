// Shared setup for the fast auto-merge tests of backlog PRs: an in-memory code host with auto-merge,
// a scripted backlog git, and a planning lane whose git is never reached (operations are only
// journaled while auto-merge holds the branch). No test here runs git, the Backlog CLI or `gh`.

import { join } from "node:path";

import { type OfficeId, StoryId, type StoryKey } from "@dipsaus-orchestrator/contract";

import { EDIT_KIND, editKind, type FlushReport, OfficeLane } from "../../src/backlog/lane";
import { updateEntry } from "../../src/backlog/lane/journal";
import { insertPr, recordCheck } from "../../src/backlog/pr/records";
import { OFFICE_DEFAULTS, type OfficeConfig } from "../../src/config";
import type { OfficeHandle } from "../../src/db/office";
import type { GitSession, OfficeGit } from "../../src/git/office";
import { AutoMerge, type BacklogMergeGit } from "../../src/merge";
import { CodeHostError, type HostPr, type RequiredCheck } from "../../src/platform/host";
import { addStory } from "../../src/stories/keys";
import { FakeHost, REPO } from "../backlog/pr/helpers";
import { addOffice, openTestState, type TestState } from "../commands/helpers";

export const BRANCH = "dipo/backlog-20260101T000000";
export const HEAD = "1".repeat(40);
export const GREEN: RequiredCheck[] = [
  { name: "ci-ok", state: "SUCCESS", bucket: "pass" },
  { name: "pr-title", state: "SUCCESS", bucket: "pass" },
];
export const PENDING: RequiredCheck[] = [
  { name: "ci-ok", state: "IN_PROGRESS", bucket: "pending" },
  { name: "pr-title", state: "SUCCESS", bucket: "pass" },
];
export const RED: RequiredCheck[] = [
  { name: "ci-ok", state: "FAILURE", bucket: "fail" },
  { name: "pr-title", state: "SUCCESS", bucket: "pass" },
];

/**
 * A code host with auto-merge, labels and required checks the test sets. `githubMerges` merges a
 * PR whose auto-merge is on, as GitHub does once its checks pass on the head it was given.
 */
export class MergeHost extends FakeHost {
  checks: RequiredCheck[] = PENDING;
  /** The labels of each PR; none by default. */
  readonly prLabelsOf = new Map<number, string[]>();
  /** Every head auto-merge was turned on at, by PR, in order. */
  readonly armedAt: { readonly number: number; readonly head: string }[] = [];
  /** The squash subject of each auto-merge turned on, in order. */
  readonly subjects: string[] = [];
  /** Every `--disable-auto`, by PR. */
  readonly disarmed: number[] = [];
  /** When set, `--disable-auto` fails with it. */
  disableError: CodeHostError | null = null;
  /** When set, turning auto-merge on fails with it. */
  enableError: CodeHostError | null = null;

  async prLabels(_repo: string, number: number): Promise<string[]> {
    return this.prLabelsOf.get(number) ?? [];
  }

  override async requiredChecks(): Promise<RequiredCheck[]> {
    return this.checks;
  }

  override async enableAutoMerge(
    repo: string,
    number: number,
    merge: { readonly headSha: string; readonly subject: string },
  ): Promise<void> {
    if (this.enableError !== null) throw this.enableError;
    await super.enableAutoMerge(repo, number, merge);
    this.armedAt.push({ number, head: merge.headSha });
    this.subjects.push(merge.subject);
  }

  override async disableAutoMerge(repo: string, number: number): Promise<void> {
    if (this.disableError !== null) throw this.disableError;
    await super.disableAutoMerge(repo, number);
    this.disarmed.push(number);
  }

  /** Sets fields of the PR as GitHub would report them. */
  set(number: number, change: Partial<HostPr>): void {
    const pr = this.prs.get(number);
    if (pr === undefined) throw new Error(`no PR #${number}`);
    this.prs.set(number, { ...pr, ...change });
  }

  /** GitHub merges the PR whose auto-merge is on, at the head it was turned on at. */
  githubMerges(number: number): void {
    const pr = this.prs.get(number);
    const armed = this.armedAt.findLast((entry) => entry.number === number);
    if (pr?.autoMerge !== true || armed === undefined) throw new Error(`#${number} is not armed`);
    this.prs.set(number, {
      ...pr,
      state: "merged",
      headSha: armed.head,
      autoMerge: false,
      mergeCommit: "m".repeat(40),
    });
  }
}

/** A backlog git whose answers the test scripts; every call is logged. */
export class FakeBacklogGit implements BacklogMergeGit {
  readonly calls: string[] = [];
  readonly heads = new Map<string, string>();
  /** Commits the merged head does not contain; every other commit is in it. */
  readonly notInHead = new Set<string>();
  /** What `deleteBranch` reports about the remote branch; null when it is gone. */
  deleteProblem: string | null = null;
  /** The release paths each head changes; null: git cannot tell. None by default. */
  readonly release = new Map<string, readonly string[] | null>();

  async releasePaths(head: string): Promise<readonly string[] | null> {
    const paths = this.release.get(head);
    return paths === undefined ? [] : paths;
  }

  async head(branch: string): Promise<string | null> {
    return this.heads.get(branch) ?? null;
  }

  async inHead(commit: string): Promise<boolean> {
    return !this.notInHead.has(commit);
  }

  async deleteBranch(branch: string): Promise<string | null> {
    this.calls.push(`deleteBranch ${branch}`);
    return this.deleteProblem;
  }
}

export interface BacklogSetup {
  readonly t: TestState;
  readonly office: OfficeHandle;
  readonly officeId: OfficeId;
  readonly host: MergeHost;
  readonly git: FakeBacklogGit;
  readonly merge: AutoMerge;
  /** The planning lane, held while auto-merge is on; its git is never reached. */
  readonly lane: OfficeLane;
  /** Flushes the auto-merge asked of the lane, with the branch held at that moment. */
  readonly flushes: { rebuild: string | undefined; heldThen: string | null }[];
  /** The office configuration the auto-merge reads. */
  config: OfficeConfig;
  readonly keys: { readonly one: StoryKey; readonly two: StoryKey };
}

/**
 * One loaded office, as the daemon's `OfficeManager` gives it: methods that read the instance's own
 * private fields, so a caller that calls one detached from the directory throws as it would there.
 */
export class OneOffice {
  readonly #office: OfficeHandle;
  readonly #config: () => OfficeConfig;

  constructor(office: OfficeHandle, config: () => OfficeConfig) {
    this.#office = office;
    this.#config = config;
  }

  get(office: OfficeId): OfficeHandle | undefined {
    return office === this.#office.officeId ? this.#office : undefined;
  }

  config(office: OfficeId): OfficeConfig | undefined {
    return office === this.#office.officeId ? this.#config() : undefined;
  }
}

/** A git that only answers what journaling asks: the office has a configured base. */
function journalOnlyGit(): OfficeGit {
  return {
    run: <T>(fn: (git: GitSession) => Promise<T>) =>
      fn({
        repository: { kind: "repository", commonDir: "/repo/.git" },
        base: async () => "main",
        step: () => Promise.reject(new Error("no git in this test")),
        ok: () => Promise.reject(new Error("no git in this test")),
      }),
    settings: { remote: "origin", base: "main" },
  } as unknown as OfficeGit;
}

export async function backlogSetup(dir: string): Promise<BacklogSetup> {
  const t = await openTestState(join(dir, "state"));
  const office = addOffice(t);
  const officeId = office.officeId as OfficeId;
  const host = new MergeHost();
  const git = new FakeBacklogGit();
  const flushes: BacklogSetup["flushes"] = [];
  let merge: AutoMerge | undefined;
  const setup = {} as { -readonly [K in keyof BacklogSetup]: BacklogSetup[K] };
  const laneForMerge = {
    flush: async (options?: { rebuild?: string }): Promise<FlushReport> => {
      flushes.push({ rebuild: options?.rebuild, heldThen: merge?.holding(officeId) ?? null });
      return {
        branch: null,
        committed: [],
        merged: [],
        dropped: [],
        rebuiltFrom: null,
        pushed: false,
        waiting: null,
      };
    },
  } as unknown as OfficeLane;
  merge = new AutoMerge({
    host,
    labels: host,
    lane: () => laneForMerge,
    offices: new OneOffice(office, () => setup.config),
    clock: t.clock,
    backlogGit: () => git,
  });
  const made = merge;
  const lane = new OfficeLane({
    officeId,
    office,
    git: journalOnlyGit(),
    cli: { spawn: () => Promise.reject(new Error("no CLI in this test")) as never },
    clock: t.clock,
    kinds: new Map([[EDIT_KIND, editKind(EDIT_KIND)]]),
    held: (id) => made.holding(id),
  });
  Object.assign(setup, {
    t,
    office,
    officeId,
    host,
    git,
    merge: made,
    lane,
    flushes,
    config: OFFICE_DEFAULTS,
    keys: {
      one: addStory(office, t.ids, { story: StoryId.parse("TASK-1") }, 0).key,
      two: addStory(office, t.ids, { story: StoryId.parse("TASK-2") }, 0).key,
    },
  });
  return setup;
}

/**
 * An open backlog PR #1 for `BRANCH` at `HEAD` whose structural check passed, with one pushed
 * journal entry for TASK-1, as the planning lane and `BacklogPrs` leave it.
 */
export async function openBacklogPr(s: BacklogSetup): Promise<void> {
  const entry = await s.lane.journal({
    kind: "edit",
    key: s.keys.one,
    subject: "TASK-1",
    target: { status: "Refined" },
  });
  const pr = await s.host.createPr(REPO, {
    base: "main",
    head: BRANCH,
    title: "chore(backlog): edit TASK-1",
    body: "",
  });
  s.host.set(pr.number, { headSha: HEAD });
  const now = s.t.clock.now();
  s.office.immediate(() => {
    updateEntry(
      s.office,
      entry.opId,
      { state: "pushed", branch: BRANCH, commit: HEAD, prRef: pr.url },
      now,
    );
    insertPr(s.office, { number: pr.number, url: pr.url, branch: BRANCH, title: pr.title }, now);
    recordCheck(
      s.office,
      pr.number,
      { head: HEAD, base: "b".repeat(40), passed: true, failures: [], touched: [] },
      now,
    );
  });
  s.git.heads.set(BRANCH, HEAD);
}

/** The `engine.notice` texts of `code`, oldest first. */
export function noticeTexts(office: OfficeHandle, code: string): string[] {
  return office
    .all<{ delta: string }>(
      "select delta from change_log where office_id = $office_id and type = 'engine.notice' order by seq",
    )
    .map((row) => JSON.parse(row.delta) as { code: string; text: string })
    .filter((delta) => delta.code === code)
    .map((delta) => delta.text);
}
