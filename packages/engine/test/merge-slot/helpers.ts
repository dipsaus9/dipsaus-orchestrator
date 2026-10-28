// Shared setup for the fast merge slot tests: an in-memory code host, a scripted slot git, a fake
// structural check and a planning lane whose git is never reached (operations are only journaled
// while the slot holds the branch). No test here runs git, the Backlog CLI or `gh`.

import { join } from "node:path";

import { type OfficeId, StoryId, type StoryKey } from "@dipsaus-orchestrator/contract";

import { EDIT_KIND, editKind, type FlushReport, OfficeLane } from "../../src/backlog/lane";
import { updateEntry } from "../../src/backlog/lane/journal";
import type { CheckResult } from "../../src/backlog/pr";
import { findPr, insertPr, recordCheck } from "../../src/backlog/pr/records";
import { OFFICE_DEFAULTS, type OfficeConfig } from "../../src/config";
import type { OfficeHandle } from "../../src/db/office";
import type { GitSession, OfficeGit } from "../../src/git/office";
import { type BaseSync, MergeSlot, type PushOutcome, type SlotGit } from "../../src/merge-slot";
import { CodeHostError, type RequiredCheck } from "../../src/platform/host";
import { createLogger } from "../../src/log/logger";
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

/** A code host whose required checks and merge refusals the test sets. */
export class SlotHost extends FakeHost {
  checks: RequiredCheck[] = PENDING;
  /** Merges still to refuse; each refusal first calls `onRefuse`. */
  refusals = 0;
  onRefuse: () => void = () => {};
  readonly merges: { number: number; headSha: string | undefined }[] = [];
  checkReads = 0;
  /** When set, reading the required checks fails with it. */
  checksError: CodeHostError | null = null;
  /** The labels of each PR (`PrReviewHost.prLabels`, DIPO-150's guard); none by default. */
  readonly prLabelsOf = new Map<number, string[]>();

  async prLabels(_repo: string, number: number): Promise<string[]> {
    return this.prLabelsOf.get(number) ?? [];
  }

  override async requiredChecks(): Promise<RequiredCheck[]> {
    this.checkReads += 1;
    if (this.checksError !== null) throw this.checksError;
    return this.checks;
  }

  override async squashMerge(
    repo: string,
    number: number,
    merge?: { headSha: string; subject: string },
  ): Promise<void> {
    this.calls.push(`merge ${repo} #${number} at ${merge?.headSha}`);
    this.merges.push({ number, headSha: merge?.headSha });
    if (this.refusals > 0) {
      this.refusals -= 1;
      this.onRefuse();
      throw new CodeHostError("failed", "`gh pr merge` failed: Base branch was modified.");
    }
    const pr = this.prs.get(number);
    if (pr !== undefined) this.prs.set(number, { ...pr, state: "merged" });
  }
}

/** A slot git whose answers the test scripts; every call is logged. */
export class FakeSlotGit implements SlotGit {
  readonly calls: string[] = [];
  readonly heads = new Map<string, string>();
  /** Answers of the next `syncBase` calls, in order; then `contained`. */
  syncs: BaseSync[] = [];
  containsBaseAnswer = true;
  fetchOk = true;
  pushAnswer: PushOutcome = { ok: true, pushed: true };

  async fetch(): Promise<boolean> {
    this.calls.push("fetch");
    return this.fetchOk;
  }

  async head(branch: string): Promise<string | null> {
    return this.heads.get(branch) ?? null;
  }

  async containsBase(branch: string): Promise<boolean> {
    this.calls.push(`containsBase ${branch}`);
    return this.containsBaseAnswer;
  }

  async syncBase(branch: string): Promise<BaseSync> {
    this.calls.push(`syncBase ${branch}`);
    const next = this.syncs.shift();
    if (next === undefined) return { kind: "contained", head: this.heads.get(branch) ?? "" };
    if (next.kind !== "conflict") this.heads.set(branch, next.head);
    return next;
  }

  async push(branch: string): Promise<PushOutcome> {
    this.calls.push(`push ${branch}`);
    return this.pushAnswer;
  }

  /** Commits the merged head does not contain; every other commit is in it. */
  readonly notInHead = new Set<string>();

  async inHead(commit: string): Promise<boolean> {
    return !this.notInHead.has(commit);
  }

  /** What `deleteBranch` reports about the remote branch; null when it is gone. */
  deleteProblem: string | null = null;

  async deleteBranch(branch: string): Promise<string | null> {
    this.calls.push(`deleteBranch ${branch}`);
    return this.deleteProblem;
  }
}

export interface SlotSetup {
  readonly t: TestState;
  readonly office: OfficeHandle;
  readonly officeId: OfficeId;
  readonly host: SlotHost;
  readonly git: FakeSlotGit;
  readonly slot: MergeSlot;
  /** The planning lane, holding while the slot does; its git is never reached. */
  readonly lane: OfficeLane;
  /** Flushes the slot asked of the lane, with the branch held at that moment. */
  readonly flushes: { rebuild: string | undefined; heldThen: string | null }[];
  /** Heads the structural check ran on. */
  readonly rechecks: string[];
  /** The structural check's next verdict. */
  recheckPasses: boolean;
  /** The office configuration the slot reads. */
  config: OfficeConfig;
  readonly keys: { readonly one: StoryKey; readonly two: StoryKey };
  /** The slot's log lines, from trace up, as `level msg` with the outcome and PR when given. */
  readonly logs: string[];
}

/**
 * One loaded office, as the daemon's `OfficeManager` gives it: methods that read the instance's own
 * private fields, so a slot that calls one detached from the directory throws as it would there.
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

function logLine(line: string): string {
  const { level, msg, outcome, pr } = JSON.parse(line) as Record<string, unknown>;
  return [level, msg, outcome, pr === undefined ? undefined : `#${String(pr)}`]
    .filter((part) => part !== undefined)
    .join(" ");
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

export async function slotSetup(dir: string): Promise<SlotSetup> {
  const t = await openTestState(join(dir, "state"));
  const office = addOffice(t);
  const officeId = office.officeId as OfficeId;
  const host = new SlotHost();
  const git = new FakeSlotGit();
  const flushes: SlotSetup["flushes"] = [];
  const rechecks: string[] = [];
  const logs: string[] = [];
  let slot: MergeSlot | undefined;
  const setup = {} as { -readonly [K in keyof SlotSetup]: SlotSetup[K] };
  const laneForSlot = {
    flush: async (options?: { rebuild?: string }): Promise<FlushReport> => {
      flushes.push({ rebuild: options?.rebuild, heldThen: slot?.holding(officeId) ?? null });
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
  slot = new MergeSlot({
    host,
    labels: host,
    prs: {
      recheck: async (_office, number): Promise<CheckResult> => {
        const pr = findPr(office, number);
        const head = git.heads.get(pr?.branch ?? "") ?? "";
        rechecks.push(head);
        const result = { passed: setup.recheckPasses, failures: [], touched: [] };
        office.immediate(() =>
          recordCheck(office, number, { head, base: "b".repeat(40), ...result }, t.clock.now()),
        );
        return result;
      },
    },
    lane: () => laneForSlot,
    offices: new OneOffice(office, () => setup.config),
    clock: t.clock,
    git: () => git,
    logger: createLogger({
      clock: t.clock,
      sinks: [(line) => logs.push(logLine(line))],
      level: "trace",
      component: "merge-slot",
    }),
  });
  const made = slot;
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
    slot: made,
    lane,
    flushes,
    rechecks,
    logs,
    recheckPasses: true,
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
 * journal entry for TASK-1, as DIPO-34 and DIPO-35 leave it.
 */
export async function openBacklogPr(s: SlotSetup): Promise<void> {
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
