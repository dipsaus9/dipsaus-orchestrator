// The code host of the review loop test (DIPO-153): an in-memory GitHub whose PRs read their head
// from the bare remote's branch, whose squash merge really merges on the remote at exactly the head
// it was given (`--match-head-commit`), and whose required checks, labels, failed job logs and
// comments a scenario scripts. Every call is logged. No `gh` runs.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { git, type TempRepoWithRemote } from "@dipsaus-orchestrator/testkit";

import {
  type CodeHost,
  CodeHostError,
  type HostPr,
  type NewPr,
  type PrCheck,
  type PrReviewHost,
  type PrStateHost,
  type RequiredCheck,
} from "../../src/platform/host";

export const REPO = "o/r";
export const REMOTE_URL = `https://github.com/${REPO}.git`;
/** The Actions job link of a failed `ci-ok` check, as `gh pr checks` reports it. */
export const JOB_LINK = `https://github.com/${REPO}/actions/runs/41/job/42`;

/** The checks the office requires by default (`mergeSlot.requiredChecks`), green. */
export const GREEN_CHECKS: readonly PrCheck[] = [
  { name: "ci-ok", state: "SUCCESS", bucket: "pass", link: JOB_LINK, workflow: "ci" },
  { name: "pr-title", state: "SUCCESS", bucket: "pass", link: "", workflow: "pr-title" },
];

/** `ci-ok` failed on its Actions job, `pr-title` green. */
export const RED_CHECKS: readonly PrCheck[] = [
  { name: "ci-ok", state: "FAILURE", bucket: "fail", link: JOB_LINK, workflow: "ci" },
  { name: "pr-title", state: "SUCCESS", bucket: "pass", link: "", workflow: "pr-title" },
];

/** Both checks queued. */
export const PENDING_CHECKS: readonly PrCheck[] = [
  { name: "ci-ok", state: "PENDING", bucket: "pending", link: JOB_LINK, workflow: "ci" },
  { name: "pr-title", state: "PENDING", bucket: "pending", link: "", workflow: "pr-title" },
];

/** The failed step's log tail of a red `ci-ok`, as `gh run view --log-failed` prints it. */
export const FAILED_LOG =
  "test\tRun bun test\t2026-10-23T10:00:00.0000000Z packages/export/csv.test.ts:3:5: expected 2 rows, got 1\n";

interface StoredPr {
  readonly number: number;
  readonly head: string;
  readonly base: string;
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  mergeCommit: string | null;
  /** The head when the PR merged or closed; GitHub keeps it as the PR's head commit. */
  lastHead: string | null;
}

export class LoopHost implements CodeHost, PrStateHost, PrReviewHost {
  readonly calls: string[] = [];
  readonly prs = new Map<number, StoredPr>();
  /** Every comment posted, in order. */
  readonly comments: { readonly number: number; readonly body: string }[] = [];
  /** Every squash merge the host made. */
  readonly merges: {
    readonly number: number;
    readonly headSha: string;
    readonly subject: string;
  }[] = [];
  readonly labels = new Map<number, string[]>();
  /** The checks of each head; a head not listed has `fallback`. */
  readonly checksOf = new Map<string, readonly PrCheck[]>();
  fallback: readonly PrCheck[] = GREEN_CHECKS;
  #next = 1;

  constructor(readonly repo: TempRepoWithRemote) {}

  /** The bare remote's tip of `branch`, or "" when the remote has no such branch. */
  async tip(branch: string): Promise<string> {
    const listed = await git(
      this.repo.remote,
      this.repo.home,
      "for-each-ref",
      "--format=%(objectname)",
      `refs/heads/${branch}`,
    );
    return listed.trim();
  }

  async #view(pr: StoredPr): Promise<HostPr> {
    return {
      number: pr.number,
      url: `https://github.com/${REPO}/pull/${pr.number}`,
      state: pr.state,
      head: pr.head,
      headSha: pr.state === "open" ? await this.tip(pr.head) : (pr.lastHead ?? ""),
      base: pr.base,
      title: pr.title,
      mergeCommit: pr.mergeCommit,
    };
  }

  #pr(number: number): StoredPr {
    const pr = this.prs.get(number);
    if (pr === undefined) throw new CodeHostError("failed", `no PR #${number}`);
    return pr;
  }

  /** The checks of the PR's head now. */
  async #checks(number: number): Promise<readonly PrCheck[]> {
    const head = await this.tip(this.#pr(number).head);
    return this.checksOf.get(head) ?? this.fallback;
  }

  async checkVersion(): Promise<string> {
    this.calls.push("version");
    return "2.60.0";
  }

  async findOpenPr(_repo: string, branch: string): Promise<HostPr | null> {
    this.calls.push(`find ${branch}`);
    const pr = [...this.prs.values()].find((p) => p.head === branch && p.state === "open");
    return pr === undefined ? null : this.#view(pr);
  }

  async findMergedPr(_repo: string, branch: string): Promise<HostPr | null> {
    const pr = [...this.prs.values()]
      .filter((p) => p.head === branch && p.state === "merged")
      .at(-1);
    return pr === undefined ? null : this.#view(pr);
  }

  async createPr(_repo: string, pr: NewPr): Promise<HostPr> {
    this.calls.push(`create ${pr.head}: ${pr.title}`);
    const number = this.#next++;
    const stored: StoredPr = {
      number,
      head: pr.head,
      base: pr.base,
      title: pr.title,
      body: pr.body,
      state: "open",
      mergeCommit: null,
      lastHead: null,
    };
    this.prs.set(number, stored);
    return this.#view(stored);
  }

  async updatePr(
    _repo: string,
    number: number,
    change: { title: string; body: string },
  ): Promise<void> {
    this.calls.push(`update #${number}`);
    const pr = this.#pr(number);
    pr.title = change.title;
    pr.body = change.body;
  }

  async viewPr(_repo: string, number: number): Promise<HostPr> {
    return this.#view(this.#pr(number));
  }

  async closePr(_repo: string, number: number): Promise<void> {
    this.calls.push(`close #${number}`);
    const pr = this.#pr(number);
    pr.lastHead = await this.tip(pr.head);
    pr.state = "closed";
  }

  async squashMerge(
    _repo: string,
    number: number,
    merge: { headSha: string; subject: string },
  ): Promise<void> {
    this.calls.push(`merge #${number} ${merge.headSha}`);
    const pr = this.#pr(number);
    if (pr.state !== "open") throw new CodeHostError("failed", `PR #${number} is ${pr.state}`);
    if ((await this.tip(pr.head)) !== merge.headSha) {
      throw new CodeHostError("failed", "Head branch was modified.");
    }
    // The squash of the head onto the remote's main, as GitHub's squash merge makes it.
    const other = join(this.repo.root, "host-merge");
    if (!existsSync(other)) {
      await git(this.repo.root, this.repo.home, "clone", "--quiet", this.repo.remote, other);
    }
    await git(other, this.repo.home, "fetch", "--quiet", "origin");
    await git(other, this.repo.home, "checkout", "--quiet", "-B", "main", "origin/main");
    await git(other, this.repo.home, "merge", "--quiet", "--squash", merge.headSha);
    await git(other, this.repo.home, "commit", "--quiet", "-m", merge.subject);
    await git(other, this.repo.home, "push", "--quiet", "origin", "HEAD:main");
    pr.mergeCommit = (await git(other, this.repo.home, "rev-parse", "HEAD")).trim();
    pr.lastHead = merge.headSha;
    pr.state = "merged";
    this.merges.push({ number, headSha: merge.headSha, subject: merge.subject });
  }

  async requiredChecks(_repo: string, number: number): Promise<RequiredCheck[]> {
    return (await this.#checks(number)).map(({ name, state, bucket }) => ({ name, state, bucket }));
  }

  async prLabels(_repo: string, number: number): Promise<string[]> {
    return [...(this.labels.get(number) ?? [])];
  }

  async prChecks(_repo: string, number: number): Promise<PrCheck[]> {
    return [...(await this.#checks(number))];
  }

  async failedJobLog(_repo: string, link: string): Promise<string | null> {
    this.calls.push(`log ${link}`);
    return link === JOB_LINK ? FAILED_LOG : null;
  }

  async commentPr(_repo: string, number: number, body: string): Promise<string> {
    this.comments.push({ number, body });
    return `https://github.com/${REPO}/pull/${number}#issuecomment-${this.comments.length}`;
  }
}
