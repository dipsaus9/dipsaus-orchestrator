// A failed In Review push (DIPO-315): the PR poll pushes the story branch again until the push
// reaches the remote, records `claims.pushed_at` (or `no_remote_at` for an office without a
// remote), and the review is held until then (`pendingReviews`). A fake code host and a fake story
// git with a scripted push on a migrated state database.

import { describe, expect, it } from "bun:test";

import { RunId, type StoryKey } from "@dipsaus-orchestrator/contract";

import { OFFICE_DEFAULTS, type OfficeConfig } from "../../src/config";
import type { OfficeHandle } from "../../src/db/office";
import type { PushResult } from "../../src/git/write";
import type { CodeHost, HostPr, NewPr } from "../../src/platform/host";
import { appendRunStep, insertRun, pendingReviews, stopAtInReview } from "../../src/run";
import {
  findStoryPr,
  recordBranchPush,
  runsToPush,
  type StoryPrFacts,
  StoryPrs,
  STORY_PR_NOTICES,
} from "../../src/story-pr";
import { findClaim, insertClaim, updateClaim } from "../../src/worktree/records";
import type { TestState } from "../commands/helpers";
import { loggedEvents } from "../ingest/helpers";
import { pass, task, withOffice } from "../stories/helpers";
import { backlogLayout } from "../story-store/backlog";

const REPO = "o/r";
const BRANCH = "DIPO-1/push-again";

class FakeHost implements CodeHost {
  open: HostPr | null = null;
  readonly creates: NewPr[] = [];
  async checkVersion(): Promise<string> {
    return "2.50.0";
  }
  async findOpenPr(): Promise<HostPr | null> {
    return this.open;
  }
  async createPr(_repo: string, pr: NewPr): Promise<HostPr> {
    this.creates.push(pr);
    this.open = {
      number: 7,
      url: `https://github.com/${REPO}/pull/7`,
      state: "open",
      head: pr.head,
      headSha: "x",
      base: pr.base,
      title: pr.title,
      mergeCommit: null,
    };
    return this.open;
  }
  async updatePr(): Promise<void> {}
  async viewPr(_repo: string, number: number): Promise<HostPr> {
    return { ...(this.open as HostPr), number };
  }
  async closePr(): Promise<void> {}
  async requiredChecks(): Promise<[]> {
    return [];
  }
}

const FACTS: StoryPrFacts = {
  story: {
    id: "DIPO-1",
    title: "Push again.",
    type: "feature",
    outcome: "the branch reaches the remote",
    criteria: [{ index: 1, text: "It is pushed", checked: true }],
    testPlan: undefined,
    scope: ["packages/engine/src/story-pr/"],
    taskFile: "backlog/tasks/dipo-1 - Push.md",
  },
  head: "a".repeat(40),
  remoteUrl: `git@github.com:${REPO}.git`,
  base: "main",
};

interface World {
  readonly t: TestState;
  readonly office: OfficeHandle;
  readonly run: RunId;
  readonly key: StoryKey;
  readonly host: FakeHost;
  readonly prs: StoryPrs;
  /** The branches pushed, in order. */
  readonly pushes: string[];
  /** What the next push does. */
  push: PushResult;
  /** The office configuration in force. */
  config: OfficeConfig;
}

const FAILED: PushResult = {
  pushed: false,
  rejected: false,
  error: "pushing DIPO-1/push-again to origin failed (could not resolve host)",
};

/** A story run open at In Review whose In Review push did not reach the remote. */
async function inWorld(fn: (w: World) => Promise<void>): Promise<void> {
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
        reviewRoundCap: 3,
        configHash: "h",
        overrideKeys: null,
        runProfileId: null,
        startedAt: t.clock.now(),
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
      // The claim push reached the remote; the In Review push at the end did not.
      updateClaim(office, run, { pushedAt: t.clock.now() });
      t.clock.advance(60_000);
      stopAtInReview(office, run, t.clock.now());
    });
    const host = new FakeHost();
    const world: World = {
      t,
      office,
      run,
      key,
      host,
      pushes: [],
      push: FAILED,
      config: OFFICE_DEFAULTS,
      prs: new StoryPrs({
        stories: backlogLayout,
        host,
        git: {
          read: async () => FACTS,
          push: async (_office, branch) => {
            world.pushes.push(branch);
            return world.push;
          },
        },
        offices: { get: () => office, config: () => world.config },
        clock: t.clock,
        checkout: () => undefined,
      }),
    };
    try {
      await fn(world);
    } finally {
      world.prs.stop();
    }
  });
}

const noticesOf = (office: OfficeHandle, code: string) =>
  loggedEvents(office).filter(
    (event) => event.type === "engine.notice" && (event.data as { code: string }).code === code,
  );

const pending = (w: World) => pendingReviews(backlogLayout, w.office).map((start) => start.runId);

describe("a failed In Review push (DIPO-315)", () => {
  it("is pushed again by the PR poll until it reaches the remote, with the review held till then", async () => {
    await inWorld(async (w) => {
      expect(runsToPush(w.office).map((run) => run.runId)).toEqual([w.run]);
      // The head is not on the remote: no review, no PR.
      expect(pending(w)).toEqual([]);

      await w.prs.retry(w.office.officeId);
      await w.prs.retry(w.office.officeId);
      expect(w.pushes).toEqual([BRANCH, BRANCH]);
      expect(findStoryPr(w.office, w.run)).toBeNull();
      expect(pending(w)).toEqual([]);
      // One notice per cause, however often it fails the same way.
      const failed = noticesOf(w.office, STORY_PR_NOTICES.pushFailed);
      expect(failed).toHaveLength(1);
      expect((failed[0]?.data as { text: string } | undefined)?.text).toContain("Its review waits");

      w.push = { pushed: true, rejected: false, error: null };
      w.t.clock.advance(1_000);
      await w.prs.retry(w.office.officeId);
      const run = w.office.get<{ ended_at: number }>(
        "select ended_at from runs where office_id = $office_id and run_id = $run",
        { run: w.run },
      );
      expect(findClaim(w.office, w.run)?.pushedAt).toBe(w.t.clock.now());
      expect(findClaim(w.office, w.run)?.pushedAt ?? 0).toBeGreaterThanOrEqual(run?.ended_at ?? 1);
      expect(noticesOf(w.office, STORY_PR_NOTICES.pushedAgain)).toHaveLength(1);
      // The same poll opens the PR on the pushed head, and the review may start.
      expect(w.host.creates).toHaveLength(1);
      expect(pending(w)).toEqual([w.run]);
      // Nothing is pushed again once the head is on the remote.
      expect(runsToPush(w.office)).toEqual([]);
      await w.prs.retry(w.office.officeId);
      expect(w.pushes).toHaveLength(3);
    });
  });

  it("never forces a rejected push: it is told, and the review stays held", async () => {
    await inWorld(async (w) => {
      w.push = {
        pushed: false,
        rejected: true,
        error: "pushing DIPO-1/push-again to origin failed (! [rejected] non-fast-forward)",
      };
      await w.prs.retry(w.office.officeId);
      const [told] = noticesOf(w.office, STORY_PR_NOTICES.pushFailed);
      expect((told?.data as { text: string } | undefined)?.text).toContain("never forces");
      expect(findClaim(w.office, w.run)?.pushedAt).not.toBeNull();
      expect(pending(w)).toEqual([]);
    });
  });

  it("does not hold the review of an office with no remote", async () => {
    await inWorld(async (w) => {
      w.push = { pushed: false, rejected: false, error: null };
      await w.prs.retry(w.office.officeId);
      expect(pending(w)).toEqual([w.run]);
      expect(noticesOf(w.office, STORY_PR_NOTICES.pushFailed)).toEqual([]);
    });
  });

  it("records a push of the branch on its live claim, a failed one not at all", async () => {
    await inWorld(async (w) => {
      const before = findClaim(w.office, w.run)?.pushedAt;
      w.office.immediate(() => recordBranchPush(w.office, BRANCH, FAILED, w.t.clock.now() + 5));
      expect(findClaim(w.office, w.run)?.pushedAt).toBe(before ?? -1);
      w.office.immediate(() =>
        recordBranchPush(w.office, "other/branch", { pushed: true, error: null }, 1),
      );
      expect(findClaim(w.office, w.run)?.pushedAt).toBe(before ?? -1);
      const at = w.t.clock.now() + 10;
      w.office.immediate(() =>
        recordBranchPush(w.office, BRANCH, { pushed: true, error: null }, at),
      );
      expect(findClaim(w.office, w.run)?.pushedAt).toBe(at);
      expect(pending(w)).toEqual([w.run]);
    });
  });
});

describe("what the push retry leaves alone (DIPO-315 review)", () => {
  it("never pushes a reviewed run whose In Review push reached the remote, after its review period", async () => {
    await inWorld(async (w) => {
      // The In Review push reached the remote at the run's end; the review period then reopened
      // the run and ended it later, past its review (phase merge), with no push of its own.
      w.office.immediate(() => {
        updateClaim(w.office, w.run, { pushedAt: w.t.clock.now() });
        w.office.run(
          `update runs set ended_at = $at where office_id = $office_id and run_id = $run`,
          { at: w.t.clock.now() + 5 * 60_000, run: w.run },
        );
        appendRunStep(w.office, w.run, "phase", "merge", w.t.clock.now() + 5 * 60_000);
      });
      w.t.clock.advance(10 * 60_000);
      expect(runsToPush(w.office)).toEqual([]);
      await w.prs.retry(w.office.officeId);
      expect(w.pushes).toEqual([]);
      expect(noticesOf(w.office, STORY_PR_NOTICES.pushedAgain)).toEqual([]);
      expect(noticesOf(w.office, STORY_PR_NOTICES.pushFailed)).toEqual([]);
    });
  });

  it("checks an office without a remote once, not at every poll", async () => {
    await inWorld(async (w) => {
      w.push = { pushed: false, rejected: false, error: null };
      await w.prs.retry(w.office.officeId);
      await w.prs.retry(w.office.officeId);
      expect(w.pushes).toEqual([BRANCH]);
      expect(runsToPush(w.office)).toEqual([]);
      expect(pending(w)).toEqual([w.run]);
    });
  });

  it("says once why a held review waits when the PR poll is off, and nothing with it on", async () => {
    await inWorld(async (w) => {
      w.prs.pushHeld(w.office.officeId, w.run);
      expect(noticesOf(w.office, STORY_PR_NOTICES.pushHeld)).toEqual([]);
      w.config = { ...OFFICE_DEFAULTS, polling: { ...OFFICE_DEFAULTS.polling, prStateSeconds: 0 } };
      w.prs.pushHeld(w.office.officeId, w.run);
      w.prs.pushHeld(w.office.officeId, w.run);
      const held = noticesOf(w.office, STORY_PR_NOTICES.pushHeld);
      expect(held).toHaveLength(1);
      expect((held[0]?.data as { text: string } | undefined)?.text).toContain(
        "polling.prStateSeconds is 0",
      );
      expect(w.pushes).toEqual([]);
    });
  });
});
