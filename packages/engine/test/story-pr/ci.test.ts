// CI on the story PR (DIPO-147 test plan): the required checks of the pushed head are read by the
// PR poll, a final head is not read again, a stuck head raises one ci.stuck and slows down, a
// failed job becomes one CI item with its tail, locations and signature, the body's status block
// lists each check, and the red head that reaches the run's CI cap parks the story verify-failing.
// For a box run (DIPO-299) CI is the verify: red CI takes the same loop, and a head the host
// reports no check for at all is final with no CI after the bounded wait.

import { describe, expect, it } from "bun:test";

import { RunId, type StoryKey } from "@dipsaus-orchestrator/contract";

import { OFFICE_DEFAULTS, type OfficeConfig } from "../../src/config";
import type { OfficeHandle } from "../../src/db/office";
import type { Logger } from "../../src/log/logger";
import {
  type CheckBucket,
  type CodeHost,
  type HostPr,
  type NewPr,
  type PrCheck,
  type PrReviewHost,
  type RequiredCheck,
} from "../../src/platform/host";
import {
  appendRunStep,
  insertRun,
  recordGrant,
  runRoundCounts,
  runSteps,
  stopAtInReview,
} from "../../src/run";
import type { BranchPark, ParkBranchRequest, ParkWriter } from "../../src/run/park";
import {
  CI_STUCK_POLL_MS,
  NO_CI_WAIT_MS,
  noCiRan,
  type StoryPrFacts,
  StoryPrs,
  STORY_PR_NOTICES,
  storyPrBody,
} from "../../src/story-pr";
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
  prs: StoryPrs;
  /** How many more park writes fail, and what the engine logged. */
  failParks: number;
  /** The checks the base requires on GitHub; ci-ok and pr-title by default. */
  requiredNames: string[];
  /** When set, reading the base's required checks fails with it. */
  namesError: Error | null;
  readonly logged: { level: string; message: string }[];
  /** A new poller on the same database, as after a daemon restart. */
  restart(): void;
  readonly run: RunId;
  readonly key: StoryKey;
  readonly office: OfficeHandle;
  readonly t: TestState;
}

async function inWorld(
  fn: (w: World) => Promise<void>,
  setup: { ciCap?: number | null; config?: OfficeConfig; box?: boolean } = {},
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
        base: "main",
        baseSha: "b".repeat(40),
        startSha: "b".repeat(40),
        claimSha: "c".repeat(40),
        reused: false,
        claimedAt: t.clock.now(),
      });
      t.clock.advance(60_000);
      updateClaim(office, run, { pushedAt: t.clock.now() });
      stopAtInReview(office, run, t.clock.now());
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
    const logged: { level: string; message: string }[] = [];
    const record = (level: string) => (message: string) => {
      logged.push({ level, message });
    };
    const logger = {
      error: record("error"),
      warn: record("warn"),
      info: record("info"),
      debug: record("debug"),
      trace: record("trace"),
    } as unknown as Logger;
    const poller = (): StoryPrs =>
      new StoryPrs({
        host,
        review: host,
        park: {
          writer,
          // The park's database write runs this; a throw there makes the park fail.
          implemented: () => {
            if (world.failParks > 0) {
              world.failParks -= 1;
              throw new Error("database is locked");
            }
            return false;
          },
        },
        git: { read: async () => world.facts },
        offices: { get: () => office, config: () => world.config },
        clock: t.clock,
        checkout: () => undefined,
        logger,
        boxRun: () => setup.box === true,
        // The base requires ci-ok and pr-title on GitHub unless a test says otherwise.
        required: {
          requiredCheckNames: async () => {
            if (world.namesError !== null) throw world.namesError;
            return [...world.requiredNames];
          },
        },
      });
    const world: World = {
      facts: FACTS,
      config: setup.config ?? OFFICE_DEFAULTS,
      host,
      parks,
      run,
      key,
      office,
      t,
      failParks: 0,
      requiredNames: ["ci-ok", "pr-title"],
      namesError: null,
      logged,
      restart: () => {
        world.prs.stop();
        world.prs = poller();
      },
      prs: poller(),
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
  office.all<{ reason: string }>("select reason from parks where office_id = $office_id");

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
      // The first poll reads the checks the base requires on GitHub: both pending.
      expect(w.host.updates).toHaveLength(1);
      expect(w.host.updates[0]?.body).toContain(
        "- required checks: `ci-ok` pending, `pr-title` pending\n",
      );
      await w.prs.retry(id);
      // Nothing new was reported: the body is the same.
      expect(w.host.updates).toHaveLength(1);

      w.host.required = [report("ci-ok", "pass"), report("pr-title", "pending")];
      await w.prs.retry(id);
      expect(w.host.updates).toHaveLength(2);
      expect(w.host.updates[1]?.body).toContain(
        "- required checks: `ci-ok` pass, `pr-title` pending\n",
      );

      w.host.required = [report("ci-ok", "pass"), report("pr-title", "pass")];
      await w.prs.retry(id);
      expect(w.host.updates).toHaveLength(3);
      expect(w.host.updates[2]?.body).toContain("`ci-ok` pass, `pr-title` pass");
    });
  });
});

describe("the CI watch of the PR poll", () => {
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

  it("keeps watching a story the merge slot closed out, Done on its branch until its PR merges (DIPO-150)", async () => {
    await inWorld(async (w) => {
      const id = w.office.officeId;
      await w.prs.sync(id, w.run);
      w.office.immediate(() =>
        w.office.run("update backlog_mirror set status = 'Done' where office_id = $office_id"),
      );
      w.host.required = [report("ci-ok", "pending")];
      await w.prs.retry(id);
      expect(w.host.count("requiredChecks")).toBe(1);
      expect(w.prs.ciState(id, w.run)?.kind).toBe("pending");
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
      const wait = w.config.merge.checksWaitMinutes * 60_000;
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
      w.t.clock.advance(10 * 60_000);
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
      expect(aggregate?.job).toBe("ci-ok");
      expect(aggregate?.text).toContain(
        "no log: it failed because other jobs of its workflow run failed (verify).",
      );
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

describe("the CI state a fix round waits for (DIPO-148)", () => {
  it("tells each listener once when a head's CI stops being pending: green, stuck, then red", async () => {
    await inWorld(
      async (w) => {
        const id = w.office.officeId;
        const told: string[] = [];
        w.prs.onCiFinal((office, run) => told.push(`${office}/${run}`));
        await w.prs.sync(id, w.run);
        expect(w.prs.ciState(id, w.run)).toBeNull();
        w.host.required = [report("ci-ok", "pending")];
        await w.prs.retry(id);
        expect(w.prs.ciState(id, w.run)).toEqual({ kind: "pending", head: HEAD_A });
        expect(told).toEqual([]);
        w.host.required = [report("ci-ok", "pass"), report("pr-title", "pass")];
        await w.prs.retry(id);
        expect(w.prs.ciState(id, w.run)).toEqual({ kind: "green", head: HEAD_A });
        await w.prs.retry(id);
        expect(told).toEqual([`${id}/${w.run}`]);

        // A new head: pending, then stuck past the wait cap, then red.
        await pushHead(w, HEAD_B);
        w.host.required = [report("ci-ok", "pending")];
        await w.prs.retry(id);
        expect(w.prs.ciState(id, w.run)).toEqual({ kind: "pending", head: HEAD_B });
        w.t.clock.advance(w.config.merge.checksWaitMinutes * 60_000);
        await w.prs.retry(id);
        expect(w.prs.ciState(id, w.run)).toEqual({ kind: "stuck", head: HEAD_B });
        expect(told).toHaveLength(2);
        redHead(w);
        w.t.clock.advance(10 * 60_000);
        await w.prs.retry(id);
        const red = w.prs.ciState(id, w.run);
        expect(red).toMatchObject({ kind: "red", head: HEAD_B });
        expect(red?.kind === "red" ? red.items.map((item) => item.check) : []).toEqual([
          "ci-ok",
          "verify",
        ]);
        expect(told).toHaveLength(3);
        await w.prs.retry(id);
        expect(told).toHaveLength(3);
      },
      { ciCap: 5 },
    );
  });
});

describe("the CI watch after a restart and a failing park", () => {
  it("rebuilds the items of a recorded red head, reading each log once, with no second step", async () => {
    await inWorld(
      async (w) => {
        const id = w.office.officeId;
        await w.prs.sync(id, w.run);
        redHead(w);
        await w.prs.retry(id);
        expect(w.host.count(`failedJobLog ${link(2)}`)).toBe(1);

        w.restart();
        expect(w.prs.ciItems(id, w.run)).toBeNull();
        await w.prs.retry(id);
        const got = w.prs.ciItems(id, w.run);
        expect(got?.head).toBe(HEAD_A);
        expect(got?.items.map((item) => item.check)).toEqual(["ci-ok", "verify"]);
        expect(w.host.count(`failedJobLog ${link(2)}`)).toBe(2);
        expect(runSteps(w.office, w.run).filter((s) => s.kind === "ci")).toHaveLength(1);

        await w.prs.retry(id);
        expect(w.host.count(`failedJobLog ${link(2)}`)).toBe(2);
      },
      { ciCap: 5 },
    );
  });

  it("warns once per head when the park keeps failing, then parks when it succeeds", async () => {
    await inWorld(
      async (w) => {
        const id = w.office.officeId;
        await w.prs.sync(id, w.run);
        redHead(w);
        w.failParks = 3;
        for (let i = 0; i < 3; i++) {
          await w.prs.retry(id);
          w.t.clock.advance(60_000);
        }
        const failures = w.logged.filter((l) => l.message.includes("parking the story"));
        expect(failures.map((l) => l.level)).toEqual(["warn", "debug", "debug"]);
        expect(parked(w.office)).toEqual([]);

        await w.prs.retry(id);
        expect(parked(w.office)).toEqual([{ reason: "verify-failing" }]);
        expect(runSteps(w.office, w.run).filter((s) => s.kind === "ci")).toHaveLength(1);
      },
      { ciCap: 1 },
    );
  });
});

describe("the run's CI cap", () => {
  it("parks verify-failing at the second red head with a cap of 2", async () => {
    await inWorld(async (w) => {
      const id = w.office.officeId;
      await w.prs.sync(id, w.run);
      redHead(w);
      await w.prs.retry(id);
      expect(runSteps(w.office, w.run).filter((s) => s.kind === "ci")).toHaveLength(1);
      expect(parked(w.office)).toEqual([]);

      // A config edit after the run started changes nothing: the cap is the run's snapshot.
      w.config = { ...OFFICE_DEFAULTS, caps: { ...OFFICE_DEFAULTS.caps, ciAttempts: 9 } };
      await pushHead(w, HEAD_B);
      await w.prs.retry(id);
      const steps = runSteps(w.office, w.run).filter((s) => s.kind === "ci");
      expect(steps.map((s) => s.value)).toEqual([HEAD_A, HEAD_B]);
      expect(parked(w.office)).toEqual([{ reason: "verify-failing" }]);
      expect(w.parks).toHaveLength(1);
      expect(w.parks[0]?.reason).toBe("verify-failing");
      // A later poll neither counts the head again nor parks again.
      await w.prs.retry(id);
      expect(runSteps(w.office, w.run).filter((s) => s.kind === "ci")).toHaveLength(2);
      expect(parked(w.office)).toHaveLength(1);
    });
  });

  it("parks at the third red head with one CI attempt round grant", async () => {
    await inWorld(async (w) => {
      const id = w.office.officeId;
      recordGrant(w.office, w.run, {
        kind: "round",
        amount: { cap: "ciAttempts", count: 1 },
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
      expect(parked(w.office)).toEqual([{ reason: "verify-failing" }]);
    });
  });
});

// ---- CI as the verify of a box run (DIPO-299) ---------------------------------------------------

const ciSteps = (w: World) => runSteps(w.office, w.run).filter((s) => s.kind === "ci");
const noneSteps = (w: World) => runSteps(w.office, w.run).filter((s) => s.kind === "ci-none");

describe("CI as the verify of a box run", () => {
  it("says in the body that CI checks the head, as no verify of dipo's ran", async () => {
    await inWorld(
      async (w) => {
        const id = w.office.officeId;
        await w.prs.sync(id, w.run);
        w.host.required = [report("ci-ok", "pass"), report("pr-title", "pending")];
        await w.prs.retry(id);
        const body = w.host.updates.at(-1)?.body ?? "";
        expect(body).toContain(
          "- verify: CI on `aaaaaaaa`, after dipo's verify in the box at done when the office names one",
        );
        expect(body).not.toContain("verify: passed");
        expect(body).toContain("- merge: the maintainer merges; dipo does not merge story PRs yet");
      },
      { box: true },
    );
    // A Mac run's body keeps the verify dipo ran.
    expect(storyPrBody(FACTS.story, { head: HEAD_A })).toContain("- verify: passed at `aaaaaaaa`");
  });

  it("sends red CI back through the CI loop: items for the fix round, one ci step per head, parked at the cap", async () => {
    await inWorld(
      async (w) => {
        const id = w.office.officeId;
        await w.prs.sync(id, w.run);
        redHead(w);
        await w.prs.retry(id);
        const got = w.prs.ciItems(id, w.run);
        expect(got?.head).toBe(HEAD_A);
        expect(got?.items.map((item) => item.check)).toEqual(["ci-ok", "verify"]);
        expect(got?.items[1]?.tail).toContain("src/a.ts:3:7: error TS2322: bad");
        expect(ciSteps(w).map((s) => s.value)).toEqual([HEAD_A]);
        expect(parked(w.office)).toEqual([]);

        // The worker's fix is a new head; red again reaches the run's CI cap of 2.
        await pushHead(w, HEAD_B);
        await w.prs.retry(id);
        expect(ciSteps(w).map((s) => s.value)).toEqual([HEAD_A, HEAD_B]);
        expect(parked(w.office)).toEqual([{ reason: "verify-failing" }]);
        expect(
          w.office.get<{ detail: string }>("select detail from parks where office_id = $office_id")
            ?.detail,
        ).toContain("required checks were red on 2 pushed heads");
        expect(noneSteps(w)).toEqual([]);
      },
      { box: true },
    );
  });

  it("keeps one ci step and the items of a head the reviewer blocked too: one round's feedback", async () => {
    await inWorld(
      async (w) => {
        const id = w.office.officeId;
        await w.prs.sync(id, w.run);
        // The review of the same head was blocked (DIPO-219 writes this step).
        w.office.immediate(() =>
          appendRunStep(w.office, w.run, "review-failed", "1", w.t.clock.now()),
        );
        redHead(w);
        await w.prs.retry(id);
        await w.prs.retry(id);
        expect(ciSteps(w)).toHaveLength(1);
        expect(runRoundCounts(w.office, w.run)).toMatchObject({
          ciAttempts: 1,
          reviewRoundsFailed: 1,
        });
        expect(w.prs.ciItems(id, w.run)?.head).toBe(HEAD_A);
        expect(parked(w.office)).toEqual([]);
      },
      { box: true },
    );
  });

  it("does not count red checks of an earlier head once done pushed a new one", async () => {
    await inWorld(
      async (w) => {
        const id = w.office.officeId;
        await w.prs.sync(id, w.run);
        w.host.required = [report("ci-ok", "pending")];
        await w.prs.retry(id);
        // A done report pushes head B while A's CI still runs; the host still shows A, now red.
        w.facts = { ...FACTS, head: HEAD_B };
        await w.prs.sync(id, w.run);
        redHead(w);
        w.host.head = HEAD_A;
        await w.prs.retry(id);
        expect(ciSteps(w)).toEqual([]);
        expect(w.prs.ciItems(id, w.run)).toBeNull();

        // The host moves to B, whose checks pass: nothing red was ever counted.
        w.host.head = HEAD_B;
        w.host.required = [report("ci-ok", "pass"), report("pr-title", "pass")];
        w.host.all = [];
        await w.prs.retry(id);
        expect(ciSteps(w)).toEqual([]);
        expect(parked(w.office)).toEqual([]);
        expect(noneSteps(w)).toEqual([]);
      },
      { box: true },
    );
  });
});

describe("an office whose story PRs get no CI", () => {
  it("is not held waiting: after the bounded wait the head is final with no CI, recorded on the run", async () => {
    await inWorld(
      async (w) => {
        const id = w.office.officeId;
        await w.prs.sync(id, w.run);
        await w.prs.retry(id);
        w.t.clock.advance(NO_CI_WAIT_MS - 60_000);
        await w.prs.retry(id);
        expect(noneSteps(w)).toEqual([]);

        w.t.clock.advance(60_000);
        await w.prs.retry(id);
        expect(noneSteps(w).map((s) => s.value)).toEqual([HEAD_A]);
        expect(noCiRan(w.office, w.run, HEAD_A)).toBe(true);
        const told = notices(w.office, STORY_PR_NOTICES.ciNone).map(
          (event) => (event.data as { text: string }).text,
        );
        expect(told).toHaveLength(1);
        expect(told[0]).toContain("No CI checks were reported for the PR of");
        expect(told[0]).toContain("the review decides");
        // Not a CI attempt, no park, and never stuck.
        expect(runRoundCounts(w.office, w.run).ciAttempts).toBe(0);
        expect(parked(w.office)).toEqual([]);
        // The body says so.
        expect(w.host.updates.at(-1)?.body).toContain(
          "- required checks: none reported for `aaaaaaaa`, so no CI ran; the review decides",
        );
        expect(w.host.updates.at(-1)?.body).toContain(
          "- merge: the maintainer merges; dipo does not merge story PRs yet; no CI ran",
        );

        // Final: no more check reads, no ci.stuck, also past the checks wait.
        const reads = w.host.count("requiredChecks");
        w.t.clock.advance(w.config.merge.checksWaitMinutes * 60_000);
        await w.prs.retry(id);
        expect(w.host.count("requiredChecks")).toBe(reads);
        expect(notices(w.office, STORY_PR_NOTICES.ciStuck)).toHaveLength(0);

        // After a restart the record holds: no second step and no new wait.
        w.restart();
        await w.prs.retry(id);
        expect(noneSteps(w)).toHaveLength(1);
        expect(w.host.count("requiredChecks")).toBe(reads);
        expect(notices(w.office, STORY_PR_NOTICES.ciNone)).toHaveLength(1);
      },
      { box: true },
    );
  });

  it("watches a new head again, with its own wait", async () => {
    await inWorld(
      async (w) => {
        const id = w.office.officeId;
        await w.prs.sync(id, w.run);
        await w.prs.retry(id);
        w.t.clock.advance(NO_CI_WAIT_MS);
        await w.prs.retry(id);
        await pushHead(w, HEAD_B);
        await w.prs.retry(id);
        expect(noneSteps(w).map((s) => s.value)).toEqual([HEAD_A]);
        w.t.clock.advance(NO_CI_WAIT_MS);
        await w.prs.retry(id);
        expect(noneSteps(w).map((s) => s.value)).toEqual([HEAD_A, HEAD_B]);
      },
      { box: true },
    );
  });

  it("is not decided while the host lists any check for the head, required or not", async () => {
    await inWorld(
      async (w) => {
        const id = w.office.officeId;
        await w.prs.sync(id, w.run);
        // The base requires no check, but the office's CI runs one.
        w.host.all = [{ ...report("ci-ok", "pending"), link: link(1), workflow: "CI" }];
        await w.prs.retry(id);
        w.t.clock.advance(NO_CI_WAIT_MS);
        await w.prs.retry(id);
        expect(noneSteps(w)).toEqual([]);
        expect(w.host.count("prChecks")).toBe(1);
      },
      { box: true },
    );
  });

  it("is not decided when the full check list cannot be read; the next poll asks again", async () => {
    await inWorld(
      async (w) => {
        const id = w.office.officeId;
        await w.prs.sync(id, w.run);
        await w.prs.retry(id);
        w.t.clock.advance(NO_CI_WAIT_MS);
        const prChecks = w.host.prChecks.bind(w.host);
        w.host.prChecks = async () => {
          throw new Error("gh failed");
        };
        await w.prs.retry(id);
        expect(noneSteps(w)).toEqual([]);
        w.host.prChecks = prChecks;
        await w.prs.retry(id);
        expect(noneSteps(w)).toHaveLength(1);
      },
      { box: true },
    );
  });

  it("waits the full NO_CI_WAIT_MS even when the checks wait is shorter, so a late red check is read", async () => {
    const config: OfficeConfig = {
      ...OFFICE_DEFAULTS,
      merge: { ...OFFICE_DEFAULTS.merge, checksWaitMinutes: 3 },
    };
    await inWorld(
      async (w) => {
        const id = w.office.officeId;
        await w.prs.sync(id, w.run);
        await w.prs.retry(id);
        // Past the 3-minute checks wait, but before NO_CI_WAIT_MS: no decision yet.
        for (let minute = 1; minute < NO_CI_WAIT_MS / 60_000; minute++) {
          w.t.clock.advance(60_000);
          await w.prs.retry(id);
        }
        expect(noneSteps(w)).toEqual([]);
        expect(notices(w.office, STORY_PR_NOTICES.ciNone)).toHaveLength(0);

        // A slow CI reports late, and red: it is read and counted, never taken for no CI.
        redHead(w);
        w.t.clock.advance(CI_STUCK_POLL_MS);
        await w.prs.retry(id);
        expect(ciSteps(w).map((s) => s.value)).toEqual([HEAD_A]);
        expect(noneSteps(w)).toEqual([]);
      },
      { box: true, config },
    );
  });

  it("decides no CI only once NO_CI_WAIT_MS passed, also with a shorter checks wait", async () => {
    const config: OfficeConfig = {
      ...OFFICE_DEFAULTS,
      merge: { ...OFFICE_DEFAULTS.merge, checksWaitMinutes: 3 },
    };
    await inWorld(
      async (w) => {
        const id = w.office.officeId;
        await w.prs.sync(id, w.run);
        await w.prs.retry(id);
        w.t.clock.advance(3 * 60_000);
        await w.prs.retry(id);
        expect(noneSteps(w)).toEqual([]);
        w.t.clock.advance(CI_STUCK_POLL_MS);
        await w.prs.retry(id);
        expect(noneSteps(w).map((s) => s.value)).toEqual([HEAD_A]);
        const told = notices(w.office, STORY_PR_NOTICES.ciNone).map(
          (event) => (event.data as { text: string }).text,
        );
        expect(told[0]).toContain(`within ${NO_CI_WAIT_MS / 60_000} minutes`);
      },
      { box: true, config },
    );
  });

  it("is not decided for a Mac run, whose verify ran on the Mac: it keeps waiting for its checks", async () => {
    await inWorld(async (w) => {
      const id = w.office.officeId;
      await w.prs.sync(id, w.run);
      await w.prs.retry(id);
      w.t.clock.advance(w.config.merge.checksWaitMinutes * 60_000);
      await w.prs.retry(id);
      expect(noneSteps(w)).toEqual([]);
      expect(notices(w.office, STORY_PR_NOTICES.ciStuck)).toHaveLength(1);
      expect(notices(w.office, STORY_PR_NOTICES.ciNone)).toHaveLength(0);
    });
  });
});

describe("the checks the base requires on GitHub", () => {
  it("leaves the head pending while the required check list cannot be read, and reads it again", async () => {
    await inWorld(async (w) => {
      const id = w.office.officeId;
      await w.prs.sync(id, w.run);
      w.host.required = [report("ci-ok", "pass"), report("pr-title", "pass")];
      w.namesError = new Error("gh api: HTTP 502");
      await w.prs.retry(id);
      expect(w.prs.ciState(id, w.run)?.kind).toBe("pending");
      expect(w.logged.some((line) => line.message.includes("required checks failed"))).toBe(true);
      w.namesError = null;
      await w.prs.retry(id);
      expect(w.prs.ciState(id, w.run)?.kind).toBe("green");
    });
  });

  it("never counts a head green before CI starts when the base requires no check", async () => {
    await inWorld(async (w) => {
      const id = w.office.officeId;
      w.requiredNames = [];
      await w.prs.sync(id, w.run);
      // Nothing reported yet: not green, not final.
      await w.prs.retry(id);
      expect(w.prs.ciState(id, w.run)?.kind).toBe("pending");
      // A check shows up and passes: green.
      w.host.required = [report("lint", "pass")];
      await w.prs.retry(id);
      expect(w.prs.ciState(id, w.run)?.kind).toBe("green");
    });
  });
});

// DIPO-382 (0002): a merge decided by rule closes out on the approved verdict, while the reviewed
// head's checks still run; the close-out push cancels that run (ci.yml's cancel-in-progress).
describe("the checks of a close-out head", () => {
  it("never take a check the close-out push cancelled on the reviewed head, and count a red close-out head once", async () => {
    await inWorld(
      async (w) => {
        const id = w.office.officeId;
        await w.prs.sync(id, w.run);
        w.host.required = [report("ci-ok", "pending"), report("pr-title", "pass")];
        await w.prs.retry(id);
        expect(w.prs.ciState(id, w.run)).toEqual({ kind: "pending", head: HEAD_A });
        // The close-out commit C is pushed; GitHub still shows A, whose ci-ok run was cancelled.
        w.facts = { ...FACTS, head: HEAD_C };
        await w.prs.sync(id, w.run);
        w.host.required = [report("ci-ok", "cancel"), report("pr-title", "pass")];
        await w.prs.retry(id);
        expect(w.prs.ciState(id, w.run)).toEqual({ kind: "pending", head: HEAD_C });
        expect(ciSteps(w)).toEqual([]);
        // GitHub moves to C: its checks run once, and a red ci-ok there is one CI attempt of C.
        w.host.head = HEAD_C;
        w.host.required = [report("ci-ok", "pending"), report("pr-title", "pass")];
        await w.prs.retry(id);
        expect(w.prs.ciState(id, w.run)).toEqual({ kind: "pending", head: HEAD_C });
        redHead(w);
        await w.prs.retry(id);
        expect(w.prs.ciState(id, w.run)).toMatchObject({ kind: "red", head: HEAD_C });
        expect(ciSteps(w).map((step) => step.value)).toEqual([HEAD_C]);
        expect(parked(w.office)).toEqual([]);
      },
      { box: true },
    );
  });
});
