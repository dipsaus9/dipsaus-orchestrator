// The one PR-state poll per office (DIPO-314): one timer per office runs the story-PR poll, the
// merge slot and the Done poll in that order, and within a round each open PR is read from the
// host once, whoever asks. The three consumers subscribe and arm no timer of their own.

import { describe, expect, it } from "bun:test";

import { OfficeId } from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import type { BacklogCli } from "../../src/backlog/runner";
import type { FeatureModule } from "../../src/commands/registry";
import { OFFICE_DEFAULTS, type OfficeConfig } from "../../src/config";
import type { OfficeHandle } from "../../src/db/office";
import type { OfficeLane } from "../../src/backlog/lane/lane";
import { MergeSlot } from "../../src/merge-slot/slot";
import type { OfficeLoadContext } from "../../src/office/steps";
import type { HostPr, PrState } from "../../src/platform/host";
import { CodeHostError } from "../../src/platform/host";
import { PR_STATE_CONSUMERS, PrStatePoll } from "../../src/platform/pr-state";
import type { StoryPrGit } from "../../src/story-pr/git";
import { StoryPrs } from "../../src/story-pr/prs";
import { StoryTeardown } from "../../src/worktree/done";

const OFFICE = OfficeId.parse("off_01J0000000000000000000000A");
const REPO = "o/r";

class Host {
  readonly views: number[] = [];
  readonly merged: string[] = [];
  readonly states = new Map<number, PrState>();
  readonly heads = new Map<number, string>();
  fail: number | null = null;

  async viewPr(_repo: string, number: number): Promise<HostPr> {
    this.views.push(number);
    if (this.fail === number) throw new CodeHostError("timedOut", "gh pr view timed out.");
    return {
      number,
      url: `https://github.com/${REPO}/pull/${number}`,
      state: this.states.get(number) ?? "open",
      head: `DIPO-${number}/story`,
      headSha: this.heads.get(number) ?? "a".repeat(40),
      base: "main",
      title: "t",
      mergeCommit: null,
    };
  }

  async findMergedPr(_repo: string, branch: string): Promise<HostPr | null> {
    this.merged.push(branch);
    return null;
  }
}

function config(seconds: number): OfficeConfig {
  return { ...OFFICE_DEFAULTS, polling: { ...OFFICE_DEFAULTS.polling, prStateSeconds: seconds } };
}

function poll(host: Host, clock = new ManualClock(), seconds = 30) {
  const loaded = new Set([OFFICE]);
  return {
    clock,
    loaded,
    poll: new PrStatePoll({
      host,
      clock,
      offices: {
        get: (office) => (loaded.has(office) ? {} : undefined),
        config: () => config(seconds),
      },
    }),
  };
}

describe("one round", () => {
  it("runs the story-PR poll, the merge slot and the Done poll in that order", async () => {
    const { poll: prState } = poll(new Host());
    const order: string[] = [];
    // Subscribed out of order on purpose: the round keeps its own order.
    prState.subscribe("done", async () => void order.push("done"));
    prState.subscribe("story-pr", async () => void order.push("story-pr"));
    prState.subscribe("merge-slot", async () => void order.push("merge-slot"));
    expect(await prState.round(OFFICE)).toBe(true);
    expect(order).toEqual([...PR_STATE_CONSUMERS]);
  });

  it("reads each open PR once and passes it to every consumer", async () => {
    const host = new Host();
    const { poll: prState } = poll(host);
    const seen: Record<string, (HostPr | null)[]> = { "story-pr": [], "merge-slot": [], done: [] };
    prState.subscribe("story-pr", async (office) => {
      const reads = prState.reads(office);
      seen["story-pr"]?.push(await reads.viewPr(REPO, 7), await reads.viewPr(REPO, 8));
    });
    prState.subscribe("merge-slot", async (office) => {
      seen["merge-slot"]?.push(
        await prState.reads(office).viewPr(REPO, 7, { head: "a".repeat(40) }),
      );
    });
    prState.subscribe("done", async (office) => {
      // Asked by branch: the story PR the round read answers it.
      seen.done?.push(await prState.reads(office).findMergedPr(REPO, "DIPO-7/story"));
    });
    await prState.round(OFFICE);
    expect(host.views).toEqual([7, 8]);
    expect(host.merged).toEqual([]);
    expect(seen["merge-slot"]?.[0]).toBe(seen["story-pr"]?.[0] ?? null);
    expect(seen.done).toEqual([null]);

    // The next round reads again.
    await prState.round(OFFICE);
    expect(host.views).toEqual([7, 8, 7, 8]);
  });

  it("answers the Done poll with a merged PR the round read, and asks the host for others", async () => {
    const host = new Host();
    host.states.set(7, "merged");
    const { poll: prState } = poll(host);
    const answers: (number | null)[] = [];
    prState.subscribe(
      "story-pr",
      async (office) => void (await prState.reads(office).viewPr(REPO, 7)),
    );
    prState.subscribe("done", async (office) => {
      const reads = prState.reads(office);
      answers.push((await reads.findMergedPr(REPO, "DIPO-7/story"))?.number ?? null);
      answers.push((await reads.findMergedPr(REPO, "DIPO-9/other"))?.number ?? null);
      answers.push((await reads.findMergedPr(REPO, "DIPO-9/other"))?.number ?? null);
    });
    await prState.round(OFFICE);
    expect(answers).toEqual([7, null, null]);
    // The branch no PR of the round answered is asked once.
    expect(host.merged).toEqual(["DIPO-9/other"]);
  });

  it("reads a PR again when the round's copy shows another head than the caller expects", async () => {
    const host = new Host();
    const { poll: prState } = poll(host);
    const heads: string[] = [];
    prState.subscribe(
      "story-pr",
      async (office) => void (await prState.reads(office).viewPr(REPO, 7)),
    );
    prState.subscribe("merge-slot", async (office) => {
      // The slot pushed a new head since the story-PR poll read the PR.
      host.heads.set(7, "b".repeat(40));
      heads.push((await prState.reads(office).viewPr(REPO, 7, { head: "b".repeat(40) })).headSha);
    });
    await prState.round(OFFICE);
    expect(host.views).toEqual([7, 7]);
    expect(heads).toEqual(["b".repeat(40)]);
  });

  it("shares a failed read with the round, and a failing consumer does not stop the next", async () => {
    const host = new Host();
    host.fail = 7;
    const { poll: prState } = poll(host);
    const errors: string[] = [];
    let doneRan = false;
    prState.subscribe("story-pr", async (office) => {
      await prState
        .reads(office)
        .viewPr(REPO, 7)
        .catch((error: CodeHostError) => {
          errors.push(error.code);
        });
    });
    prState.subscribe("merge-slot", async (office) => {
      await prState.reads(office).viewPr(REPO, 7);
    });
    prState.subscribe("done", async () => {
      doneRan = true;
    });
    await prState.round(OFFICE);
    expect(errors).toEqual(["timedOut"]);
    expect(host.views).toEqual([7]);
    expect(doneRan).toBe(true);
  });

  it("reads the host each time outside a round", async () => {
    const host = new Host();
    const { poll: prState } = poll(host);
    await prState.reads(OFFICE).viewPr(REPO, 7);
    await prState.reads(OFFICE).viewPr(REPO, 7);
    await prState.reads(OFFICE).findMergedPr(REPO, "DIPO-7/story");
    expect(host.views).toEqual([7, 7]);
    expect(host.merged).toEqual(["DIPO-7/story"]);
  });

  it("skips a round while the last one still runs", async () => {
    const { poll: prState } = poll(new Host());
    const gate = Promise.withResolvers<void>();
    let calls = 0;
    prState.subscribe("story-pr", () => {
      calls += 1;
      return gate.promise;
    });
    const first = prState.round(OFFICE);
    expect(prState.inRound(OFFICE)).toBe(true);
    expect(await prState.round(OFFICE)).toBe(false);
    gate.resolve();
    expect(await first).toBe(true);
    expect(calls).toBe(1);
    expect(prState.inRound(OFFICE)).toBe(false);
  });
});

describe("the timer", () => {
  it("runs one round every prStateSeconds, armed again once a round ends", async () => {
    const { poll: prState, clock } = poll(new Host(), new ManualClock(), 30);
    let rounds = 0;
    prState.subscribe("story-pr", async () => void (rounds += 1));
    prState.watch(OFFICE, clock, config(30));
    expect(clock.pendingTimers).toBe(1);
    clock.advance(29_999);
    expect(rounds).toBe(0);
    clock.advance(1);
    await Bun.sleep(0);
    expect(rounds).toBe(1);
    expect(clock.pendingTimers).toBe(1);
    clock.advance(30_000);
    await Bun.sleep(0);
    expect(rounds).toBe(2);
    prState.stop();
    expect(clock.pendingTimers).toBe(0);
  });

  it("arms nothing with the poll off, and ends for a forgotten office", async () => {
    const off = poll(new Host(), new ManualClock(), 0);
    off.poll.watch(OFFICE, off.clock, config(0));
    expect(off.clock.pendingTimers).toBe(0);

    const on = poll(new Host(), new ManualClock(), 30);
    let rounds = 0;
    on.poll.subscribe("done", async () => void (rounds += 1));
    on.poll.watch(OFFICE, on.clock, config(30));
    on.loaded.delete(OFFICE);
    on.clock.advance(30_000);
    await Bun.sleep(0);
    expect(rounds).toBe(0);
    expect(on.clock.pendingTimers).toBe(0);
  });
});

/** Runs the load step of each module with a context that needs no database. */
function load(modules: readonly FeatureModule[], clock: ManualClock, seconds: number): void {
  const steps: ((ctx: OfficeLoadContext) => unknown)[] = [];
  for (const module of modules) {
    module.register({
      registerLoadStep: (_name: string, run: (ctx: OfficeLoadContext) => unknown) => {
        steps.push(run);
      },
    } as never);
  }
  const ctx = {
    officeId: OFFICE,
    office: {} as OfficeHandle,
    path: "/nowhere",
    commonDir: "/nowhere/.git",
    config: config(seconds),
    clock,
    ids: { next: () => "x" },
  } as unknown as OfficeLoadContext;
  for (const step of steps) step(ctx);
}

describe("the consumers", () => {
  it("subscribe to the office's poll and arm no timer of their own", () => {
    const clock = new ManualClock();
    const host = new Host();
    const subscribed: string[] = [];
    const prState = new PrStatePoll({
      host,
      clock,
      offices: { get: () => ({}), config: () => config(30) },
    });
    const watched = {
      subscribe: (
        name: (typeof PR_STATE_CONSUMERS)[number],
        run: (o: OfficeId) => Promise<unknown>,
      ) => {
        subscribed.push(name);
        prState.subscribe(name, run);
      },
      reads: (office: OfficeId) => prState.reads(office),
    };
    const offices = { get: () => undefined, config: () => config(30) };
    const teardown = new StoryTeardown({
      git: () => undefined,
      host: host as never,
      cli: {} as BacklogCli,
      offices,
      prState: watched,
    });
    const storyPrs = new StoryPrs({
      host: host as never,
      git: {} as StoryPrGit,
      offices,
      clock,
      prState: watched,
    });
    const slot = new MergeSlot({
      host: host as never,
      prs: { recheck: async () => ({ passed: true }) as never },
      lane: () => undefined as OfficeLane | undefined,
      offices,
      clock,
      prState: watched,
    });
    expect(subscribed.toSorted()).toEqual([...PR_STATE_CONSUMERS].toSorted());

    load([teardown.feature, storyPrs.feature, slot.feature], clock, 30);
    expect(clock.pendingTimers).toBe(0);
    load([prState.feature], clock, 30);
    expect(clock.pendingTimers).toBe(1);
  });

  it("keep their own timers without the poll", () => {
    const clock = new ManualClock();
    const host = new Host();
    const offices = { get: () => undefined, config: () => config(30) };
    const teardown = new StoryTeardown({
      git: () => undefined,
      host: host as never,
      cli: {} as BacklogCli,
      offices,
    });
    const storyPrs = new StoryPrs({ host: host as never, git: {} as StoryPrGit, offices, clock });
    const slot = new MergeSlot({
      host: host as never,
      prs: { recheck: async () => ({ passed: true }) as never },
      lane: () => undefined,
      offices,
      clock,
    });
    load([teardown.feature, storyPrs.feature, slot.feature], clock, 30);
    expect(clock.pendingTimers).toBe(3);
  });
});
