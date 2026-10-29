// The story PR flow (DIPO-144 test plan) with a fake code host and a fake story git on a migrated
// state database: open, reuse after a crash, update only on change, a PR merged or closed on the
// host, the failed-create notice and its retry, StoryView.pr and the story.pr events.

import { describe, expect, it } from "bun:test";

import { RunId, type StoryKey } from "@dipsaus-orchestrator/contract";

import { OFFICE_DEFAULTS, type OfficeConfig } from "../../src/config";
import type { OfficeHandle } from "../../src/db/office";
import {
  CodeHostError,
  type CodeHost,
  type HostPr,
  type NewPr,
  type PrState,
} from "../../src/platform/host";
import { yieldToEventLoop } from "../../src/platform/clock";
import {
  findRun,
  insertRun,
  openAtInReview,
  recordConfigSnapshot,
  stopAtInReview,
} from "../../src/run";
import {
  findStoryPr,
  type StoryPrFacts,
  type StoryPrGit,
  StoryPrs,
  STORY_PR_NOTICES,
  STORY_PR_STEP,
} from "../../src/story-pr";
import { storyView } from "../../src/views";
import { insertClaim, updateClaim } from "../../src/worktree/records";
import type { TestState } from "../commands/helpers";
import { loggedEvents } from "../ingest/helpers";
import { pass, task, withOffice } from "../stories/helpers";

const REPO = "o/r";
const BRANCH = "DIPO-1/open-the-pr";

class FakeHost implements CodeHost {
  /** Every host method called, by name, in order. */
  readonly calls: string[] = [];
  readonly creates: NewPr[] = [];
  readonly updates: { number: number; title: string; body: string }[] = [];
  open: HostPr | null = null;
  failCreate: CodeHostError | null = null;
  /** The number the next created PR gets. */
  number = 7;
  async checkVersion(): Promise<string> {
    this.calls.push("checkVersion");
    return "2.50.0";
  }
  async findOpenPr(): Promise<HostPr | null> {
    this.calls.push("findOpenPr");
    return this.open;
  }
  async createPr(_repo: string, pr: NewPr): Promise<HostPr> {
    this.calls.push("createPr");
    if (this.failCreate !== null) throw this.failCreate;
    this.creates.push(pr);
    this.open = hostPr(this.number, pr);
    return this.open;
  }
  async updatePr(
    _repo: string,
    number: number,
    change: { title: string; body: string },
  ): Promise<void> {
    this.calls.push("updatePr");
    this.updates.push({ number, ...change });
  }
  /** The state `viewPr` reports, and the PR numbers it was asked for. */
  hostState: PrState = "open";
  /** The head commit `viewPr` reports; "x" by default. */
  hostHead = "x";
  /** The state of one PR number, over `hostState`. */
  readonly states = new Map<number, PrState>();
  readonly views: number[] = [];
  async viewPr(_repo: string, number: number): Promise<HostPr> {
    this.calls.push("viewPr");
    this.views.push(number);
    return {
      ...hostPr(number, { base: "main", head: BRANCH, title: "t" }),
      state: this.states.get(number) ?? this.hostState,
      headSha: this.hostHead,
    };
  }
  async closePr(): Promise<void> {
    this.calls.push("closePr");
  }
  async requiredChecks(): Promise<[]> {
    this.calls.push("requiredChecks");
    return [];
  }
}

function hostPr(number: number, pr: Pick<NewPr, "base" | "head" | "title">): HostPr {
  return {
    number,
    url: `https://github.com/${REPO}/pull/${number}`,
    state: "open",
    head: pr.head,
    headSha: "x",
    base: pr.base,
    title: pr.title,
    mergeCommit: null,
  };
}

interface World {
  facts: StoryPrFacts;
  /** The office configuration in force; the defaults (story PRs on) unless a test changes it. */
  config: OfficeConfig;
  /** How often StoryPrs read the story's git facts. */
  gitReads: number;
  /** The checks the base requires on GitHub; none by default. */
  requiredNames: string[];
  readonly host: FakeHost;
  readonly prs: StoryPrs;
  readonly run: RunId;
  readonly key: StoryKey;
  readonly office: OfficeHandle;
  readonly t: TestState;
}

const FACTS: StoryPrFacts = {
  story: {
    id: "DIPO-1",
    title: "Open the PR.",
    type: "feature",
    outcome: "a PR opens",
    criteria: [{ index: 1, text: "It opens", checked: true }],
    testPlan: undefined,
    scope: ["packages/engine/src/story-pr/"],
    taskFile: "backlog/tasks/dipo-1 - Open.md",
  },
  head: "a".repeat(40),
  remoteUrl: `git@github.com:${REPO}.git`,
  base: "main",
};

interface WorldSetup {
  /** The story's Backlog.md status; In Review by default. */
  readonly status?: string;
  /**
   * The last push of the claim: the In Review push at the run's end (the default), only the claim
   * push before it, or none.
   */
  readonly pushed?: "in-review" | "claim" | "none";
}

async function inWorld(fn: (w: World) => Promise<void>, setup: WorldSetup = {}): Promise<void> {
  await withOffice(async (t, office) => {
    pass(t, office, [task("DIPO-1", { status: setup.status ?? "In Review" })]);
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
      const pushed = setup.pushed ?? "in-review";
      if (pushed === "claim") updateClaim(office, run, { pushedAt: t.clock.now() });
      t.clock.advance(60_000);
      // The In Review push is recorded in the transaction that ends the run, at the same time.
      if (pushed === "in-review") updateClaim(office, run, { pushedAt: t.clock.now() });
      stopAtInReview(office, run, t.clock.now());
    });
    const host = new FakeHost();
    const world: World = {
      facts: FACTS,
      config: OFFICE_DEFAULTS,
      gitReads: 0,
      requiredNames: [],
      host,
      run,
      key,
      office,
      t,
      prs: new StoryPrs({
        host,
        git: {
          read: async () => {
            world.gitReads += 1;
            return world.facts;
          },
        } satisfies StoryPrGit,
        offices: {
          get: () => office,
          config: () => world.config,
        },
        clock: t.clock,
        checkout: () => undefined,
        required: { requiredCheckNames: async () => [...world.requiredNames] },
      }),
    };
    try {
      await fn(world);
    } finally {
      world.prs.stop();
    }
  });
}

const storyPrEvents = (office: OfficeHandle) =>
  loggedEvents(office).filter((event) => event.type === "story.pr");
const notices = (office: OfficeHandle, code: string) =>
  loggedEvents(office).filter(
    (event) => event.type === "engine.notice" && (event.data as { code: string }).code === code,
  );

describe("the story PR", () => {
  it("creates a ready PR with a code-built title and records it", async () => {
    await inWorld(async (w) => {
      await w.prs.sync(w.office.officeId, w.run);
      expect(w.host.creates).toHaveLength(1);
      const created = w.host.creates[0] as NewPr;
      expect(created.title).toBe("feat(DIPO-1): open the PR");
      expect(created).toMatchObject({ base: "main", head: BRANCH });
      expect(created.body).toContain("- [x] #1 It opens");
      const row = findStoryPr(w.office, w.run);
      expect(row).toMatchObject({
        key: w.key,
        number: 7,
        url: `https://github.com/${REPO}/pull/7`,
        branch: BRANCH,
        base: "main",
        headSha: FACTS.head,
        state: "open",
        closedAt: null,
      });
      expect(row?.bodyHash).toHaveLength(64);
      expect(storyView(w.office, w.key)?.pr).toEqual({
        number: 7,
        url: `https://github.com/${REPO}/pull/7`,
        state: "open",
      });
      expect(storyPrEvents(w.office)).toHaveLength(1);
    });
  });

  it("reuses the open PR a crash between push and create left", async () => {
    await inWorld(async (w) => {
      w.host.open = hostPr(3, { base: "main", head: BRANCH, title: "old" });
      await w.prs.sync(w.office.officeId, w.run);
      expect(w.host.creates).toHaveLength(0);
      expect(w.host.updates).toHaveLength(1);
      expect(findStoryPr(w.office, w.run)?.number).toBe(3);
    });
  });

  it("updates the same PR on a later push, only when the body changed, and says story.pr on a new head only", async () => {
    await inWorld(async (w) => {
      const id = w.office.officeId;
      await w.prs.sync(id, w.run);
      // The same facts: nothing is written to the host and no event is sent.
      await w.prs.sync(id, w.run);
      expect(w.host.updates).toHaveLength(0);
      expect(storyPrEvents(w.office)).toHaveLength(1);
      // A changed outcome on the same head: the body is updated, no story.pr.
      w.facts = { ...FACTS, story: { ...FACTS.story, outcome: "a PR opens and updates" } };
      await w.prs.sync(id, w.run);
      expect(w.host.updates).toHaveLength(1);
      expect(storyPrEvents(w.office)).toHaveLength(1);
      // A new head: updated and story.pr.
      w.facts = { ...w.facts, head: "b".repeat(40) };
      await w.prs.sync(id, w.run);
      expect(w.host.creates).toHaveLength(1);
      expect(w.host.updates).toHaveLength(2);
      expect(findStoryPr(w.office, w.run)?.headSha).toBe("b".repeat(40));
      expect(storyPrEvents(w.office)).toHaveLength(2);
    });
  });

  it("records the head the host reports when the PR merged, and keeps its own on a close (DIPO-332)", async () => {
    for (const closed of ["merged", "closed"] as const) {
      await inWorld(async (w) => {
        const id = w.office.officeId;
        await w.prs.sync(id, w.run);
        const before = findStoryPr(w.office, w.run)?.headSha;
        w.host.hostHead = "c".repeat(40);
        w.host.hostState = closed;
        w.t.clock.advance(60_000);
        await w.prs.retry(id);
        expect(findStoryPr(w.office, w.run)).toMatchObject({
          state: closed,
          headSha: closed === "merged" ? "c".repeat(40) : before,
        });
      });
    }
  });

  for (const closed of ["merged", "closed"] as const) {
    it(`writes the state and close time of a PR ${closed} on the host and says story.pr once`, async () => {
      await inWorld(async (w) => {
        const id = w.office.officeId;
        await w.prs.sync(id, w.run);
        expect(storyPrEvents(w.office)).toHaveLength(1);
        // Still open on the host: nothing changes.
        await w.prs.retry(id);
        expect(w.host.views).toEqual([7]);
        expect(findStoryPr(w.office, w.run)).toMatchObject({ state: "open", closedAt: null });
        expect(storyPrEvents(w.office)).toHaveLength(1);

        w.host.hostState = closed;
        w.t.clock.advance(60_000);
        await w.prs.retry(id);
        expect(findStoryPr(w.office, w.run)).toMatchObject({
          state: closed,
          closedAt: w.t.clock.now(),
        });
        expect(storyView(w.office, w.key)?.pr).toEqual({
          number: 7,
          url: `https://github.com/${REPO}/pull/7`,
          state: closed,
        });
        const events = storyPrEvents(w.office);
        expect(events).toHaveLength(2);
        expect(events[1]?.data).toEqual({
          story: "DIPO-1",
          key: w.key,
          pr: { number: 7, url: `https://github.com/${REPO}/pull/7`, state: closed },
        });

        // A second poll sees no change: no host read of a PR that is no longer open, no event.
        await w.prs.retry(id);
        expect(w.host.views).toEqual([7, 7]);
        expect(storyPrEvents(w.office)).toHaveLength(2);
      });
    });
  }

  it("retries no run of a story that is Done, though its run still stands open at In Review", async () => {
    // Its teardown, which ends the run done, has not run yet.
    await inWorld(
      async (w) => {
        expect(openAtInReview(findRun(w.office, w.run)!)).toBe(true);
        expect(storyView(w.office, w.key)?.lifecycle).toBe("Done");
        expect(await w.prs.retry(w.office.officeId)).toEqual([]);
        expect(w.host.creates).toHaveLength(0);
        expect(findStoryPr(w.office, w.run)).toBeNull();
        expect(storyPrEvents(w.office)).toHaveLength(0);
      },
      { status: "Done" },
    );
  });

  for (const pushed of ["none", "claim"] as const) {
    it(`retries no In Review run whose In Review push never reached the remote (last push: ${pushed})`, async () => {
      await inWorld(
        async (w) => {
          expect(storyView(w.office, w.key)?.lifecycle).toBe("In Review");
          expect(await w.prs.retry(w.office.officeId)).toEqual([]);
          expect(w.host.creates).toHaveLength(0);
          expect(findStoryPr(w.office, w.run)).toBeNull();
        },
        { pushed },
      );
    });
  }

  it("retries no run whose claim was released", async () => {
    await inWorld(async (w) => {
      w.office.run(
        `update claims set released_at = $at, release_reason = 'dropped'
          where office_id = $office_id and run_id = $run`,
        { at: w.t.clock.now(), run: w.run },
      );
      expect(await w.prs.retry(w.office.officeId)).toEqual([]);
      expect(w.host.creates).toHaveLength(0);
    });
  });

  it("retries an In Review run whose In Review push reached the remote", async () => {
    await inWorld(async (w) => {
      expect(await w.prs.retry(w.office.officeId)).toEqual([w.run]);
      expect(w.host.creates).toHaveLength(1);
    });
  });

  it("keeps the story In Review on a failed create, notices once and creates on the retry poll", async () => {
    await inWorld(async (w) => {
      const id = w.office.officeId;
      w.host.failCreate = new CodeHostError("failed", "gh: network is down");
      await w.prs.sync(id, w.run);
      expect(findStoryPr(w.office, w.run)).toBeNull();
      expect(storyView(w.office, w.key)?.lifecycle).toBe("In Review");
      expect(notices(w.office, STORY_PR_NOTICES.openFailed)).toHaveLength(1);

      // The poll arms from the load step and retries every polling.prStateSeconds.
      let step: ((ctx: unknown) => unknown) | undefined;
      w.prs.feature.register({
        registerLoadStep: (name: string, run: (ctx: unknown) => unknown) => {
          expect(name).toBe(STORY_PR_STEP);
          step = run;
        },
      } as never);
      step?.({ officeId: id, office: w.office, clock: w.t.clock, config: OFFICE_DEFAULTS });
      const seconds = OFFICE_DEFAULTS.polling.prStateSeconds;

      // Still failing: the retry is silent.
      w.t.clock.advance(seconds * 1000);
      await w.prs.retry(id).catch(() => undefined);
      expect(notices(w.office, STORY_PR_NOTICES.openFailed)).toHaveLength(1);
      expect(findStoryPr(w.office, w.run)).toBeNull();

      w.host.failCreate = null;
      w.t.clock.advance(seconds * 1000);
      for (let n = 0; n < 20 && findStoryPr(w.office, w.run) === null; n++) {
        await yieldToEventLoop();
      }
      expect(findStoryPr(w.office, w.run)?.number).toBe(7);
      expect(w.host.creates).toHaveLength(1);
      expect(storyPrEvents(w.office)).toHaveLength(1);
    });
  });
});

// DIPO-210: an office with storyPr.open false gets no story PR (0019 amendment of 2026-10-19).
const PRS_OFF: OfficeConfig = { ...OFFICE_DEFAULTS, storyPr: { open: false } };

/** Arms the poll from the load step, as the daemon does when the office loads. */
function armPoll(w: World): void {
  let step: ((ctx: unknown) => unknown) | undefined;
  w.prs.feature.register({
    registerLoadStep: (_name: string, run: (ctx: unknown) => unknown) => {
      step = run;
    },
  } as never);
  step?.({ officeId: w.office.officeId, office: w.office, clock: w.t.clock, config: w.config });
}

/** Lets the poll timer fire `times` times and its retries finish. */
async function pollIntervals(w: World, times: number): Promise<void> {
  for (let n = 0; n < times; n++) {
    w.t.clock.advance(w.config.polling.prStateSeconds * 1000);
    for (let i = 0; i < 20; i++) await yieldToEventLoop();
  }
}

describe("the story PR switched off with storyPr.open false", () => {
  it("calls the host zero times across an In Review push, a later push and a poll, and raises no pr.openFailed", async () => {
    await inWorld(async (w) => {
      const id = w.office.officeId;
      w.config = PRS_OFF;
      // A create would fail: with the switch on this run would get a pr.openFailed notice.
      w.host.failCreate = new CodeHostError("failed", "gh: network is down");
      armPoll(w);

      // The In Review push.
      await w.prs.sync(id, w.run);
      // A later push on a new head.
      w.facts = { ...FACTS, head: "b".repeat(40) };
      await w.prs.sync(id, w.run);
      expect(w.host.calls).toEqual([]);
      // The poll, called directly and from its timer.
      const tried = await w.prs.retry(id);
      await pollIntervals(w, 2);

      expect(w.host.calls).toEqual([]);
      expect(tried).toEqual([]);
      expect(w.gitReads).toBe(0);
      expect(findStoryPr(w.office, w.run)).toBeNull();
      expect(storyPrEvents(w.office)).toHaveLength(0);
      expect(notices(w.office, STORY_PR_NOTICES.openFailed)).toHaveLength(0);
      expect(notices(w.office, STORY_PR_NOTICES.opened)).toHaveLength(0);
      expect(storyView(w.office, w.key)?.lifecycle).toBe("In Review");
      expect(storyView(w.office, w.key)?.pr).toBeUndefined();
    });
  });

  it("neither updates nor polls a PR opened before the office switched it off", async () => {
    await inWorld(async (w) => {
      const id = w.office.officeId;
      await w.prs.sync(id, w.run);
      expect(w.host.calls).toEqual(["findOpenPr", "createPr"]);
      const before = w.host.calls.length;

      w.config = PRS_OFF;
      armPoll(w);
      w.facts = { ...FACTS, story: { ...FACTS.story, outcome: "changed" }, head: "b".repeat(40) };
      await w.prs.sync(id, w.run);
      w.host.hostState = "merged";
      expect(await w.prs.retry(id)).toEqual([]);
      await pollIntervals(w, 2);

      expect(w.host.calls).toHaveLength(before);
      expect(w.host.updates).toHaveLength(0);
      expect(w.host.views).toEqual([]);
      expect(findStoryPr(w.office, w.run)).toMatchObject({ headSha: FACTS.head, state: "open" });
      expect(storyPrEvents(w.office)).toHaveLength(1);
    });
  });

  it("picks the office up again once the key is back on", async () => {
    await inWorld(async (w) => {
      const id = w.office.officeId;
      w.config = PRS_OFF;
      armPoll(w);
      await w.prs.sync(id, w.run);
      await pollIntervals(w, 1);
      expect(w.host.calls).toEqual([]);

      w.config = { ...OFFICE_DEFAULTS, storyPr: { open: true } };
      await pollIntervals(w, 1);
      expect(w.host.creates).toHaveLength(1);
      expect(findStoryPr(w.office, w.run)?.number).toBe(7);
    });
  });
});

// DIPO-150 (the DIPO-303 review): a run's stages after its start read its configuration snapshot,
// not the configuration in force, which a base change now reloads at the next poll.
const snapshot = (w: World, config: OfficeConfig): void =>
  w.office.immediate(() => recordConfigSnapshot(w.office, "h", config, w.t.clock.now()));

describe("the story PR of a run with a configuration snapshot", () => {
  it("opens the PR of a run that started with story PRs on, after the office switched them off", async () => {
    await inWorld(async (w) => {
      snapshot(w, OFFICE_DEFAULTS);
      w.config = PRS_OFF;
      await w.prs.sync(w.office.officeId, w.run);
      expect(w.host.creates).toHaveLength(1);
    });
  });

  it("opens no PR for a run that started with story PRs off, after the office switched them on", async () => {
    await inWorld(async (w) => {
      snapshot(w, PRS_OFF);
      w.config = OFFICE_DEFAULTS;
      await w.prs.sync(w.office.officeId, w.run);
      expect(await w.prs.retry(w.office.officeId)).toEqual([]);
      expect(w.host.calls).toEqual([]);
    });
  });

  it("lists the checks the base requires on GitHub in the body, never mergeSlot.requiredChecks", async () => {
    await inWorld(async (w) => {
      snapshot(w, {
        ...OFFICE_DEFAULTS,
        mergeSlot: { ...OFFICE_DEFAULTS.mergeSlot, requiredChecks: ["office-check"] },
      });
      w.requiredNames = ["base-check"];
      w.host.hostHead = w.facts.head;
      await w.prs.sync(w.office.officeId, w.run);
      await w.prs.retry(w.office.officeId);
      const bodies = [w.host.creates[0]?.body ?? "", ...w.host.updates.map((u) => u.body)];
      expect(bodies.at(-1)).toContain("base-check");
      expect(bodies.join("\n")).not.toContain("office-check");
    });
  });
});

/** The `by-maintainer` park of the closed PR, resolved by a maintainer resume. */
function resumedPrClosedPark(w: World): void {
  const at = w.t.clock.now();
  w.office.immediate(() =>
    w.office.run(
      `insert into parks (office_id, park_id, key, story_id, run_id, reason, detail, at,
         resolved_at, resolved_how)
       values ($office_id, 1, $key, 'DIPO-1', $run, 'by-maintainer', 'PR #7 closed on GitHub',
         $at, $at, 'resume')`,
      { key: w.key, run: w.run, at },
    ),
  );
}

describe("a story PR closed on the host, replaced on resume (DIPO-324)", () => {
  it("opens a new PR for the same run and branch whose body names the closed one, and keeps naming it", async () => {
    await inWorld(async (w) => {
      const id = w.office.officeId;
      await w.prs.sync(id, w.run);
      w.host.hostState = "closed";
      w.t.clock.advance(60_000);
      await w.prs.retry(id);
      expect(findStoryPr(w.office, w.run)).toMatchObject({ number: 7, state: "closed" });

      // GitHub keeps the closed PR; the new one is another number for the same branch.
      w.host.open = null;
      w.host.number = 8;
      w.host.states.set(7, "closed");
      w.host.hostState = "open";
      await w.prs.replace(id, w.run);
      expect(w.host.creates).toHaveLength(2);
      const created = w.host.creates[1] as NewPr;
      expect(created).toMatchObject({ base: "main", head: BRANCH });
      expect(created.body).toContain("- replaces #7, which was closed on the host without a merge");
      expect(findStoryPr(w.office, w.run)).toMatchObject({
        number: 8,
        url: `https://github.com/${REPO}/pull/8`,
        state: "open",
        headSha: FACTS.head,
        closedAt: null,
        replaces: 7,
      });
      expect(storyView(w.office, w.key)?.pr).toMatchObject({ number: 8, state: "open" });
      expect(
        notices(w.office, STORY_PR_NOTICES.opened).map(
          (event) => (event.data as { text: string }).text,
        ),
      ).toContain(
        `dipo opened PR #8 for ${w.key} in place of PR #7, which was closed on the host: https://github.com/${REPO}/pull/8`,
      );

      // A later push rebuilds the body, which still names the closed PR.
      w.facts = { ...FACTS, head: "f".repeat(40) };
      await w.prs.sync(id, w.run);
      expect(w.host.updates.at(-1)).toMatchObject({ number: 8 });
      expect(w.host.updates.at(-1)?.body).toContain("- replaces #7");
      // Replaced already: a retry of the resume opens nothing more.
      await w.prs.replace(id, w.run);
      expect(w.host.creates).toHaveLength(2);
    });
  });

  it("replaces a PR the host closed before the PR poll recorded it", async () => {
    await inWorld(async (w) => {
      const id = w.office.officeId;
      await w.prs.sync(id, w.run);
      // The merge slot read the host and parked; the record still says open.
      w.host.hostState = "closed";
      w.host.open = null;
      w.host.number = 8;
      await w.prs.replace(id, w.run);
      expect(w.host.creates).toHaveLength(2);
      expect(findStoryPr(w.office, w.run)).toMatchObject({ number: 8, replaces: 7 });
    });
  });

  it("tries a replacement whose create failed again from the PR poll", async () => {
    await inWorld(async (w) => {
      const id = w.office.officeId;
      await w.prs.sync(id, w.run);
      w.host.hostState = "closed";
      w.t.clock.advance(60_000);
      await w.prs.retry(id);
      resumedPrClosedPark(w);
      w.host.open = null;
      w.host.number = 8;
      w.host.failCreate = new CodeHostError("failed", "gh: network is down");
      await w.prs.replace(id, w.run);
      expect(findStoryPr(w.office, w.run)).toMatchObject({ number: 7, state: "closed" });
      expect(notices(w.office, STORY_PR_NOTICES.openFailed)).toHaveLength(1);

      w.host.failCreate = null;
      expect(await w.prs.retry(id)).toEqual([w.run]);
      expect(findStoryPr(w.office, w.run)).toMatchObject({ number: 8, state: "open", replaces: 7 });
      // Done: the next poll tries nothing.
      w.host.hostState = "open";
      expect(await w.prs.retry(id)).toEqual([]);
    });
  });
});

describe("a closed story PR the maintainer reopened before the resume (DIPO-324)", () => {
  it("is updated as the run's PR, never recorded as its own replacement", async () => {
    await inWorld(async (w) => {
      const id = w.office.officeId;
      await w.prs.sync(id, w.run);
      w.host.hostState = "closed";
      w.t.clock.advance(60_000);
      await w.prs.retry(id);
      expect(findStoryPr(w.office, w.run)).toMatchObject({ number: 7, state: "closed" });
      // Reopened on GitHub: open again, and the open PR of the branch.
      w.host.hostState = "open";
      const updates = w.host.updates.length;
      await w.prs.replace(id, w.run);
      expect(w.host.creates).toHaveLength(1);
      expect(findStoryPr(w.office, w.run)).toMatchObject({
        number: 7,
        state: "open",
        closedAt: null,
        replaces: null,
      });
      expect(storyView(w.office, w.key)?.pr).toMatchObject({ number: 7, state: "open" });
      // Its body is the run's own, unchanged, so it is not written again; none names a replacement.
      expect(w.host.updates.slice(updates)).toEqual([]);
      expect(w.host.updates.some((update) => update.body.includes("replaces #"))).toBe(false);
    });
  });

  it("is never its own replacement when the host's open PR of the branch is the closed one", async () => {
    await inWorld(async (w) => {
      const id = w.office.officeId;
      await w.prs.sync(id, w.run);
      w.host.hostState = "closed";
      w.t.clock.advance(60_000);
      await w.prs.retry(id);
      // The view still says closed, but the branch's open PR is #7 again (reopened meanwhile).
      w.host.open = { ...(w.host.open as HostPr), number: 7 };
      await w.prs.replace(id, w.run);
      expect(w.host.creates).toHaveLength(1);
      expect(findStoryPr(w.office, w.run)).toMatchObject({
        number: 7,
        state: "open",
        replaces: null,
        bodyHash: "",
      });
    });
  });
});
