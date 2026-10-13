// Shared setup for the backlog PR tests: the planning lane on a temporary repository with a bare
// `origin` that git reaches under a GitHub URL (`url.<path>.insteadOf`), and an in-memory code host
// in place of `gh`. No test reaches GitHub.

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import type { TempRepoWithRemote } from "@dipsaus-orchestrator/testkit";

import { OfficeLane } from "../../../src/backlog/lane";
import { BacklogPrs } from "../../../src/backlog/pr";
import {
  type CodeHost,
  CodeHostError,
  type CodeHostErrorCode,
  type HostPr,
  type NewPr,
  type RequiredCheck,
} from "../../../src/platform/host";
import { laneSetup, type LaneSetup } from "../lane/helpers";

export const REPO = "o/r";
export const REMOTE_URL = `https://github.com/${REPO}.git`;

/** A code host that keeps its PRs in memory and records every call. */
export class FakeHost implements CodeHost {
  readonly prs = new Map<number, HostPr>();
  readonly calls: string[] = [];
  /** When set, every call fails with this code. */
  failWith: CodeHostErrorCode | null = null;
  #next = 1;

  #enter(call: string): void {
    this.calls.push(call);
    if (this.failWith !== null) throw new CodeHostError(this.failWith, `fake ${this.failWith}`);
  }

  async checkVersion(): Promise<string> {
    this.#enter("version");
    return "2.50.0";
  }

  async findOpenPr(repo: string, branch: string): Promise<HostPr | null> {
    this.#enter(`find ${repo} ${branch}`);
    return [...this.prs.values()].find((pr) => pr.head === branch && pr.state === "open") ?? null;
  }

  async createPr(repo: string, pr: NewPr): Promise<HostPr> {
    this.#enter(`create ${repo} ${pr.head} -> ${pr.base}: ${pr.title}`);
    const number = this.#next++;
    const created: HostPr = {
      number,
      url: `https://github.com/${repo}/pull/${number}`,
      state: "open",
      head: pr.head,
      headSha: "",
      base: pr.base,
      title: pr.title,
    };
    this.prs.set(number, created);
    return created;
  }

  async updatePr(repo: string, number: number, change: { title: string }): Promise<void> {
    this.#enter(`update ${repo} #${number}: ${change.title}`);
    const pr = this.prs.get(number);
    if (pr !== undefined) this.prs.set(number, { ...pr, title: change.title });
  }

  async viewPr(repo: string, number: number): Promise<HostPr> {
    this.#enter(`view ${repo} #${number}`);
    const pr = this.prs.get(number);
    if (pr === undefined) throw new CodeHostError("failed", `no PR #${number}`);
    return pr;
  }

  async closePr(repo: string, number: number): Promise<void> {
    this.#enter(`close ${repo} #${number}`);
    const pr = this.prs.get(number);
    if (pr !== undefined) this.prs.set(number, { ...pr, state: "closed" });
  }

  async squashMerge(repo: string, number: number): Promise<void> {
    this.#enter(`merge ${repo} #${number}`);
  }

  async requiredChecks(): Promise<RequiredCheck[]> {
    return [];
  }

  /** Marks the PR merged by hand at `headSha`, as the host would report it. */
  mergedByHand(number: number, headSha: string): void {
    const pr = this.prs.get(number);
    if (pr === undefined) throw new Error(`no PR #${number}`);
    this.prs.set(number, { ...pr, state: "merged", headSha });
  }
}

export interface PrSetup extends LaneSetup {
  readonly host: FakeHost;
  readonly prs: BacklogPrs;
  readonly lane: () => OfficeLane;
  readonly officeId: OfficeId;
}

/** The lane with the PR hook on a repository whose `origin` git reaches as `REMOTE_URL`. */
export async function prSetup(repo: TempRepoWithRemote | null, base: LaneSetup): Promise<PrSetup> {
  if (repo !== null) {
    await repo.git("config", `url.${repo.remote}.insteadOf`, REMOTE_URL);
    await repo.git("remote", "set-url", "origin", REMOTE_URL);
  }
  const host = new FakeHost();
  const officeId = base.office.officeId;
  let lane: OfficeLane | undefined;
  const prs = new BacklogPrs({
    host,
    lane: () => lane,
    cli: base.cli,
    offices: { get: () => base.office },
    clock: base.t.clock,
  });
  lane = new OfficeLane({
    officeId,
    office: base.office,
    git: base.git,
    cli: base.cli,
    clock: base.t.clock,
    kinds: base.kinds,
    onFlushed: (office, report) => prs.afterFlush(office, report),
  });
  const made = lane;
  return { ...base, host, prs, lane: () => made, officeId };
}

export { laneSetup };
