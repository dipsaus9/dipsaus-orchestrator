// CI on the story PR (DIPO-147 test plan): the required checks of the pushed head are read by the
// PR poll, a final head is not read again, a stuck head raises one ci.stuck and slows down, a
// failed job becomes one CI item with its tail, locations and signature, the body's status block
// lists each check, and the red head that reaches the run's CI cap parks the story with cause ci.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { RunId, type StoryKey } from "@dipsaus-orchestrator/contract";

import { OFFICE_DEFAULTS, type OfficeConfig } from "../../src/config";
import type { OfficeHandle } from "../../src/db/office";
import { CI_STUCK_POLL_MS } from "../../src/story-pr";
import {
  type CheckBucket,
  type CodeHost,
  type HostPr,
  type NewPr,
  type PrCheck,
  type PrReviewHost,
  type RequiredCheck,
} from "../../src/platform/host";
import { endRun, IN_REVIEW_END, insertRun, recordGrant, runSteps } from "../../src/run";
import type { BranchPark, ParkBranchRequest, ParkWriter } from "../../src/run/park";
import { type StoryPrFacts, StoryPrs, STORY_PR_NOTICES, storyPrBody } from "../../src/story-pr";
import { insertClaim, updateClaim } from "../../src/worktree/records";
import type { TestState } from "../commands/helpers";
import { loggedEvents } from "../ingest/helpers";
import { pass, task, withOffice } from "../stories/helpers";

const REPO = "o/r";
const BRANCH = "DIPO-1/watch-ci";
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const HEAD_C = "c".repeat(40);

const FACTS: StoryPrFacts = {
  story: {
    id: "DIPO-1",
    title: "Watch CI.",
    type: "feature",
    outcome: "CI is watched",
    criteria: [{ index: 1, text: "It watches", checked: false }],
    testPlan: undefined,
    scope: ["packages/engine/src/story-pr/"],
    taskFile: "backlog/tasks/dipo-1 - Watch.md",
  },
  head: HEAD_A,
  remoteUrl: `git@github.com:${REPO}.git`,
  base: "main",
};

const link = (job: number, run = 100): string =>
  `https://github.com/${REPO}/actions/runs/${run}/job/${job}`;
const report = (name: string, bucket: CheckBucket): RequiredCheck => ({
  name,
  state: bucket,
  bucket,
});

/** A gh log of the failed step of a job, with a runner path and timestamps as gh prints them. */
const VERIFY_LOG = [
  "verify\tRun verify\t2026-10-20T10:00:00.0000000Z $ bun run verify",
  "verify\tRun verify\t2026-10-20T10:00:01.0000000Z /home/runner/work/r/r/src/a.ts:3:7: error TS2322: bad",
  "verify\tRun verify\t2026-10-20T10:00:02.0000000Z error: script exited with 1",
  "verify\tUpload logs\t2026-10-20T10:00:03.0000000Z upload failed",
].join("\n");

class CiHost implements CodeHost, PrReviewHost {
  readonly calls: string[] = [];
  readonly updates: { body: string }[] = [];
  /** What `requiredChecks` reports, and the head `viewPr` says the PR has. */
  required: RequiredCheck[] = [];
  all: PrCheck[] = [];
  head = HEAD_A;
  logs = new Map<string, string>();
  async checkVersion(): Promise<string> {
    return "2.50.0";
  }
  async findOpenPr(): Promise<HostPr | null> {
    return null;
  }
  async createPr(_repo: string, pr: NewPr): Promise<HostPr> {
    this.calls.push("createPr");
    return this.pr(pr.base, pr.head, pr.title);
  }
  async updatePr(_repo: string, _n: number, change: { title: string; body: string }) {
    this.calls.push("updatePr");
    this.updates.push({ body: change.body });
  }
  async viewPr(): Promise<HostPr> {
    this.calls.push("viewPr");
    return this.pr("main", BRANCH, "t");
  }
  async closePr(): Promise<void> {}
  async squashMerge(): Promise<void> {}
  async requiredChecks(): Promise<RequiredCheck[]> {
    this.calls.push("requiredChecks");
    return this.required;
  }
  async prLabels(): Promise<string[]> {
    return [];
  }
  async prChecks(): Promise<PrCheck[]> {
    this.calls.push("prChecks");
    return this.all;
  }
  async failedJobLog(_repo: string, jobLink: string): Promise<string | null> {
    this.calls.push(`failedJobLog ${jobLink}`);
    return this.logs.get(jobLink) ?? null;
  }
  async commentPr(): Promise<string> {
    return "";
  }
  count(call: string): number {
    return this.calls.filter((c) => c === call).length;
  }
  private pr(base: string, head: string, title: string): HostPr {
    return {
      number: 7,
      url: `https://github.com/${REPO}/pull/7`,
      state: "open",
      head,
      headSha: this.head,
      base,
      title,
      mergeCommit: null,
    };
  }
}

interface World {
  facts: StoryPrFacts;
  config: OfficeConfig;
  readonly host: CiHost;
  readonly parks: ParkBranchRequest[];
  readonly prs: StoryPrs;
  readonly run: RunId;
  readonly key: StoryKey;
  readonly office: OfficeHandle;
  readonly t: TestState;
}

async function inWorld(
  fn: (w: World) => Promise<void>,
  setup: { ciCap?: number | null; config?: OfficeConfig } = {},
): Promise<void> {
  await withOffice(async (t, office) => {
    pass(t, office, [task("DIPO-1", { status: "In Review" })]);
    const key = office.get<{ key: string }>("select key from stories where office_id = $office_id")
      ?.key as StoryKey;
    const run = RunId.parse(t.ids.next("run"));
    office.immediate(() => {
      insertRun(office, {
        runId: run,
        kind: "story",
        key,
        story: "DIPO-1",
        tier: "S",
        role: "developer",
        model: "haiku",
        startSha: "b".repeat(40),
        branch: BRANCH,
        worktree: join("/wt", "DIPO-1"),
        slot: 1,
        budgetUnit: "tokens",
        budgetLimit: 300_000,
        loopCap: 2,
        reviewRoundCap: null,
        ciCap: setup.ciCap === undefined ? 2 : setup.ciCap,
        configHash: "h",
        overrideKeys: null,
        runProfileId: null,
        startedAt: t.clock.now(),
        scope: ["packages/engine/src/story-pr/"],
      });
      insertClaim(office, {
        runId: run,
        key,
        story: "DIPO-1",
        branch: BRANCH,
        worktree: join("/wt", "DIPO-1"),
        base: "main",
        baseSha: "b".repeat(40),
        startSha: "b".repeat(40),
        claimSha: "c".repeat(40),
        reused: false,
        snapshot: { path: "/x", adminDir: "/x", commondir: "/x", gitdir: "/x", pointer: "/x" },
        firstFeedback: null,
        claimedAt: t.clock.now(),
      });
      t.clock.advance(60_000);
      updateClaim(office, run, { pushedAt: t.clock.now() });
      endRun(office, run, t.clock.now(), IN_REVIEW_END);
    });
    const host = new CiHost();
    const parks: ParkBranchRequest[] = [];
    const writer: ParkWriter = {
      write: async (_office, request): Promise<BranchPark> => {
        parks.push(request);
        return {
          commit: null,
          lastGoodCommit: HEAD_A,
          from: "In Review",
          pushed: true,
          pushError: null,
        };
      },
    };
    const world: World = {
      facts: FACTS,
      config: setup.config ?? OFFICE_DEFAULTS,
      host,
      parks,
      run,
      key,
      office,
      t,
      prs: new StoryPrs({
        host,
        review: host,
        park: { writer, implemented: () => false },
        git: { read: async () => world.facts },
        offices: { get: () => office, config: () => world.config },
        clock: t.clock,
      }),
    };
    try {
      await fn(world);
    } finally {
      world.prs.stop();
    }
  });
}

const notices = (office: OfficeHandle, code: string) =>
  loggedEvents(office).filter(
    (event) => event.type === "engine.notice" && (event.data as { code: string }).code === code,
  );
const parked = (office: OfficeHandle) =>
  office.all<{ reason: string; cause: string }>(
    "select reason, cause from parks where office_id = $office_id",
  );

/** Opens the PR, then pushes a new head the way an In Review push does. */
async function pushHead(w: World, head: string): Promise<void> {
  w.facts = { ...FACTS, head };
  w.host.head = head;
  await w.prs.sync(w.office.officeId, w.run);
}

const REDS: PrCheck[] = [
  { ...report("ci-ok", "fail"), link: link(1), workflow: "CI" },
  { ...report("verify", "fail"), link: link(2), workflow: "CI" },
  { ...report("pr-title", "pass"), link: "", workflow: "" },
];

function redHead(w: World): void {
  w.host.required = [report("ci-ok", "fail"), report("pr-title", "pass")];
  w.host.all = REDS;
  w.host.logs.set(link(2), VERIFY_LOG);
}

describe("the story PR body status block", () => {
  it("lists each required check with its state", () => {
    const body = storyPrBody(
      { ...FACTS.story },
      {
        head: HEAD_A,
        checks: [
          { name: "ci-ok", state: "pass" },
          { name: "pr-title", state: "pending" },
        ],
      },
    );
    expect(body).toContain("- required checks: `ci-ok` pass, `pr-title` pending\n");
    expect(storyPrBody({ ...FACTS.story }, { head: HEAD_A, checks: [] })).toContain(
      "- required checks: none",
    );
  });

  it("is written with the checks pending, and again when a check changes", async () => {
    await inWorld(async (w) => {
      const id = w.office.officeId;
      await w.prs.sync(id, w.run);
      expect(w.host.updates).toHaveLength(0);
      await w.prs.retry(id);
      // Nothing was reported: both checks stay pending, so the body is the same.
      expect(w.host.updates).toHaveLength(0);

      w.host.required = [report("ci-ok", "pass"), report("pr-title", "pending")];
      await w.prs.retry(id);
      expect(w.host.updates).toHaveLength(1);
      expect(w.host.updates[0]?.body).toContain(
        "- required checks: `ci-ok` pass, `pr-title` pending\n",
      );

      w.host.required = [report("ci-ok", "pass"), report("pr-title", "pass")];
      await w.prs.retry(id);
      expect(w.host.updates).toHaveLength(2);
      expect(w.host.updates[1]?.body).toContain("`ci-ok` pass, `pr-title` pass");
    });
  });
});

describe("the CI watch of the PR poll", () => {
  it("makes no checks call and builds no item with storyPr.open false", async () => {
    await inWorld(async (w) => {
      const id = w.office.officeId;
      await w.prs.sync(id, w.run);
      redHead(w);
      w.config = { ...OFFICE_DEFAULTS, storyPr: { open: false } };
      await w.prs.retry(id);
      expect(w.host.count("requiredChecks")).toBe(0);
      expect(w.host.count("prChecks")).toBe(0);
      expect(w.prs.ciItems(id, w.run)).toBeNull();
      expect(runSteps(w.office, w.run).filter((s) => s.kind === "ci")).toEqual([]);
    });
  });

  it("does not read a head whose checks are final until the head changes", async () => {
    await inWorld(async (w) => {
      const id = w.office.officeId;
      await w.prs.sync(id, w.run);
      w.host.required = [report("ci-ok", "pass"), report("pr-title", "pass")];
      await w.prs.retry(id);
      await w.prs.retry(id);
      await w.prs.retry(id);
      expect(w.host.count("requiredChecks")).toBe(1);
      // The PR itself is still read each time, so a merge or close is seen.
      expect(w.host.count("viewPr")).toBe(3);

      await pushHead(w, HEAD_B);
      w.host.required = [report("ci-ok", "pending")];
      await w.prs.retry(id);
      expect(w.host.count("requiredChecks")).toBe(2);
    });
  });

  it("reads no checks while the host's PR is on another head than the pushed one", async () => {
    await inWorld(async (w) => {
      const id = w.office.officeId;
      await w.prs.sync(id, w.run);
      w.host.head = HEAD_B;
      w.host.required = [report("ci-ok", "pass"), report("pr-title", "pass")];
      await w.prs.retry(id);
      expect(w.host.count("requiredChecks")).toBe(0);
    });
  });

  it("raises one ci.stuck after checksWaitMinutes and then reads every 10 minutes", async () => {
    await inWorld(async (w) => {
      const id = w.office.officeId;
      const wait = w.config.mergeSlot.checksWaitMinutes * 60_000;
      await w.prs.sync(id, w.run);
      w.host.required = [report("ci-ok", "pending")];
      await w.prs.retry(id);
      expect(notices(w.office, STORY_PR_NOTICES.ciStuck)).toHaveLength(0);

      w.t.clock.advance(wait);
      await w.prs.retry(id);
      expect(notices(w.office, STORY_PR_NOTICES.ciStuck)).toHaveLength(1);
      const reads = w.host.count("requiredChecks");

      // Polls inside the 10 minutes read nothing; the next one after them reads, with no second notice.
      w.t.clock.advance(60_000);
      await w.prs.retry(id);
      w.t.clock.advance(60_000);
      await w.prs.retry(id);
      expect(w.host.count("requiredChecks")).toBe(reads);
      w.t.clock.advance(CI_STUCK_POLL_MS);
      await w.prs.retry(id);
      expect(w.host.count("requiredChecks")).toBe(reads + 1);
      expect(notices(w.office, STORY_PR_NOTICES.ciStuck)).toHaveLength(1);
    });
  });

  it("builds one item for a failed job with its tail, locations and signature, and no log for ci-ok", async () => {
    await inWorld(async (w) => {
      const id = w.office.officeId;
      await w.prs.sync(id, w.run);
      redHead(w);
      await w.prs.retry(id);

      const got = w.prs.ciItems(id, w.run);
      expect(got?.head).toBe(HEAD_A);
      const items = got?.items ?? [];
      expect(items.map((item) => item.check)).toEqual(["ci-ok", "verify"]);
      const [aggregate, verify] = items;
      expect(aggregate?.text).toContain("other jobs of its workflow run failed (verify)");
      expect(aggregate?.steps).toEqual([]);
      expect(verify).toMatchObject({
        kind: "ci",
        job: "verify",
        steps: ["Run verify", "Upload logs"],
        link: link(2),
      });
      expect(verify?.locations).toEqual([{ file: "src/a.ts", line: 3, column: 7 }]);
      expect(verify?.tail).toContain("src/a.ts:3:7: error TS2322: bad");
      expect(verify?.tail).not.toContain("/home/runner");
      expect(verify?.tail).not.toContain("2026-10-20T");
      expect(verify?.signature).toMatch(/^[0-9a-f]{64}$/);
      expect(verify?.text.length).toBeLessThanOrEqual(3_000);

      // The logs are read once per failed head: a job log only for verify, the list once.
      expect(w.host.calls.filter((c) => c.startsWith("failedJobLog"))).toEqual([
        `failedJobLog ${link(2)}`,
      ]);
      expect(w.host.count("prChecks")).toBe(1);
      await w.prs.retry(id);
      expect(w.host.count("prChecks")).toBe(1);
      expect(w.host.count("requiredChecks")).toBe(1);
    });
  });
});

describe("the run's CI cap", () => {
  it("parks verify-failing with cause ci at the second red head with a cap of 2", async () => {
    await inWorld(async (w) => {
      const id = w.office.officeId;
      await w.prs.sync(id, w.run);
      redHead(w);
      await w.prs.retry(id);
      expect(runSteps(w.office, w.run).filter((s) => s.kind === "ci")).toHaveLength(1);
      expect(parked(w.office)).toEqual([]);

      // A config edit after the run started changes nothing: the cap is the run's snapshot.
      w.config = { ...OFFICE_DEFAULTS, mergeSlot: { ...OFFICE_DEFAULTS.mergeSlot, ciAttempts: 9 } };
      await pushHead(w, HEAD_B);
      await w.prs.retry(id);
      const steps = runSteps(w.office, w.run).filter((s) => s.kind === "ci");
      expect(steps.map((s) => s.value)).toEqual([HEAD_A, HEAD_B]);
      expect(parked(w.office)).toEqual([{ reason: "verify-failing", cause: "ci" }]);
      expect(w.parks).toHaveLength(1);
      expect(w.parks[0]?.reason).toBe("verify-failing");
      // A later poll neither counts the head again nor parks again.
      await w.prs.retry(id);
      expect(runSteps(w.office, w.run).filter((s) => s.kind === "ci")).toHaveLength(2);
      expect(parked(w.office)).toHaveLength(1);
    });
  });

  it("parks at the third red head with one ciAttempt grant", async () => {
    await inWorld(async (w) => {
      const id = w.office.officeId;
      recordGrant(w.office, w.run, {
        kind: "ciAttempt",
        amount: 1,
        grantId: "g1",
        note: null,
        origin: "test",
        client: null,
        at: w.t.clock.now(),
      });
      await w.prs.sync(id, w.run);
      redHead(w);
      await w.prs.retry(id);
      await pushHead(w, HEAD_B);
      await w.prs.retry(id);
      expect(parked(w.office)).toEqual([]);
      await pushHead(w, HEAD_C);
      await w.prs.retry(id);
      expect(runSteps(w.office, w.run).filter((s) => s.kind === "ci")).toHaveLength(3);
      expect(parked(w.office)).toEqual([{ reason: "verify-failing", cause: "ci" }]);
    });
  });
});
