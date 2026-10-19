// The story PR flow (DIPO-144 test plan) with a fake code host and a fake story git on a migrated
// state database: open, reuse after a crash, update only on change, a PR merged or closed on the
// host, the failed-create notice and its retry, StoryView.pr and the story.pr events.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { RunId, type StoryKey } from "@dipsaus-orchestrator/contract";

import { OFFICE_DEFAULTS } from "../../src/config";
import type { OfficeHandle } from "../../src/db/office";
import {
  CodeHostError,
  type CodeHost,
  type HostPr,
  type NewPr,
  type PrState,
} from "../../src/platform/host";
import { yieldToEventLoop } from "../../src/platform/clock";
import { endRun, IN_REVIEW_END, insertRun } from "../../src/run";
import {
  findStoryPr,
  type StoryPrFacts,
  type StoryPrGit,
  StoryPrs,
  STORY_PR_NOTICES,
  STORY_PR_STEP,
} from "../../src/story-pr";
import { storyView } from "../../src/views";
import type { TestState } from "../commands/helpers";
import { loggedEvents } from "../ingest/helpers";
import { pass, task, withOffice } from "../stories/helpers";

const REPO = "o/r";
const BRANCH = "DIPO-1/open-the-pr";

class FakeHost implements CodeHost {
  readonly creates: NewPr[] = [];
  readonly updates: { number: number; title: string; body: string }[] = [];
  open: HostPr | null = null;
  failCreate: CodeHostError | null = null;
  async checkVersion(): Promise<string> {
    return "2.50.0";
  }
  async findOpenPr(): Promise<HostPr | null> {
    return this.open;
  }
  async createPr(_repo: string, pr: NewPr): Promise<HostPr> {
    if (this.failCreate !== null) throw this.failCreate;
    this.creates.push(pr);
    this.open = hostPr(7, pr);
    return this.open;
  }
  async updatePr(
    _repo: string,
    number: number,
    change: { title: string; body: string },
  ): Promise<void> {
    this.updates.push({ number, ...change });
  }
  /** The state `viewPr` reports, and the PR numbers it was asked for. */
  hostState: PrState = "open";
  readonly views: number[] = [];
  async viewPr(_repo: string, number: number): Promise<HostPr> {
    this.views.push(number);
    return { ...hostPr(number, { base: "main", head: BRANCH, title: "t" }), state: this.hostState };
  }
  async closePr(): Promise<void> {}
  async squashMerge(): Promise<void> {}
  async requiredChecks(): Promise<[]> {
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
        worktree: join("/wt", "DIPO-1"),
        slot: 1,
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
      endRun(office, run, t.clock.now(), IN_REVIEW_END);
    });
    const host = new FakeHost();
    const world: World = {
      facts: FACTS,
      host,
      run,
      key,
      office,
      t,
      prs: new StoryPrs({
        host,
        git: { read: async () => world.facts } satisfies StoryPrGit,
        offices: {
          get: () => office,
          config: () => OFFICE_DEFAULTS,
        },
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
