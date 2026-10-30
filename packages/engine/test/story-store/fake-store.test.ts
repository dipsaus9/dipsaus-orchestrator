// The engine with a fake StoryStore in place of Backlog.md (DIPO-356, 0010): the story index, the
// Ready gate's read, the pickup read of `_base`, the steps at done and the close-out read and write
// stories only through the store, so an in-memory store is enough to run them.

import { describe, expect, it } from "bun:test";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { withBareRemote } from "@dipsaus-orchestrator/testkit";

import { StoryNotFoundError, readGateInput } from "../../src/gate-decisions/read";
import { EngineGit } from "../../src/git";
import type { OfficeGit } from "../../src/git/office";
import { closeOutFields } from "../../src/merge/close-out";
import { systemSpawn } from "../../src/platform/process";
import { gitStoryOps } from "../../src/run/story-git";
import { storyRunBase } from "../../src/run/work-run";
import { StoryIndex } from "../../src/stories/feature";
import { parseFieldBlock } from "../../src/story-store/fields/block";
import { DEFAULT_CONFIG } from "../gate/fixtures";
import { BACKLOG_FIXTURE, officeSetup, resultOf, send } from "../office/helpers";
import { storyRows } from "../stories/helpers";
import { fakeStory, FakeStoryStore } from "./fake";

const OFFICE = "office-1" as OfficeId;
const BRANCH = "DIPO-1/story";

/** A git that runs every queue item at once and has a `_base` at `/base`; no git runs. */
const fakeGit = {
  run: <T>(fn: (session: never) => Promise<T>) => fn({} as never),
  ensureBaseWorktree: async () => ({ path: "/base", base: "main" }),
} as unknown as OfficeGit;

const PARKED = [
  "Outcome: DIPO-1 works.",
  "",
  "```dipo",
  'branch: "DIPO-1/story"',
  "park:",
  '  reason: "ambiguous-spec"',
  '  from: "In Progress"',
  '  note: "Which one?"',
  "```",
].join("\n");

describe("the engine on a fake StoryStore", () => {
  it("indexes an office's stories from the store", () =>
    withBareRemote(
      async (repo) => {
        await repo.commitAll("fixture");
        await repo.git("push", "--quiet", "-u", "origin", "main");
        await repo.git("remote", "set-head", "origin", "main");
        const stories = new FakeStoryStore()
          .put(fakeStory("DIPO-1", { status: "Ready", labels: ["tier:M"] }))
          .put(fakeStory("DIPO-2"))
          .putUnparsed("DIPO-3", "Story DIPO-3", "Refined");
        const engineGit = new EngineGit({ spawn: systemSpawn, env: repo.env });
        const index = new StoryIndex({ git: engineGit, stories });
        const s = await officeSetup(repo.root, { features: [engineGit.feature, index.feature] });
        try {
          const { office: officeId } = resultOf<{ office: OfficeId }>(
            await send(s, "office.open", { path: repo.dir }),
          );
          const access = await s.manager.load(officeId);
          if (!access.ok) throw new Error(`${access.error.code}: ${access.error.message}`);
          expect(storyRows(access.office).map((row) => [row.story_id, row.removed])).toEqual([
            ["DIPO-1", false],
            ["DIPO-2", false],
            ["DIPO-3", false],
          ]);
          const tiers = access.office.all<{ story_id: string; tier: string | null }>(
            `select s.story_id, m.tier from stories s join backlog_mirror m using (office_id, key)
              where s.office_id = $office_id order by s.story_id`,
          );
          expect(tiers).toEqual([
            { story_id: "DIPO-1", tier: "M" },
            { story_id: "DIPO-2", tier: null },
            { story_id: "DIPO-3", tier: null },
          ]);
        } finally {
          index.stop();
          s.state.close();
        }
      },
      { fixture: BACKLOG_FIXTURE },
    ));

  it("reads the Ready gate's input, and a story the store does not have", async () => {
    const stories = new FakeStoryStore()
      .put(fakeStory("DIPO-1", { status: "Ready", milestone: "m-1" }))
      .put(fakeStory("DIPO-2", { status: "Done" }));
    stories.milestoneNames.push("m-1", "M1");
    const input = await readGateInput(stories, "/base", "DIPO-1", DEFAULT_CONFIG);
    expect(input.story.id).toBe("DIPO-1");
    expect(input.activeTasks.map((task) => task.id)).toEqual(["DIPO-1", "DIPO-2"]);
    expect(input.milestones).toEqual(["m-1", "M1"]);
    await expect(readGateInput(stories, "/base", "DIPO-9", DEFAULT_CONFIG)).rejects.toBeInstanceOf(
      StoryNotFoundError,
    );
  });

  it("reads `_base` for pickup, with the stories that do not parse apart", async () => {
    const stories = new FakeStoryStore()
      .put(fakeStory("DIPO-1", { status: "Ready" }))
      .put(fakeStory("DIPO-2", { status: "Refined" }))
      .putUnparsed("DIPO-3", "Story DIPO-3", "Ready");
    const read = await storyRunBase({ git: () => fakeGit, stories }).read(OFFICE, null);
    expect([...read.statuses]).toEqual([
      ["DIPO-1", "Ready"],
      ["DIPO-2", "Refined"],
      ["DIPO-3", "Ready"],
    ]);
    expect(read.views.map((view) => view.id)).toEqual(["DIPO-1"]);
    expect(read.unparsed).toEqual(["DIPO-3"]);
    expect(read.checkout).toEqual({ path: "/base", base: "main" });
  });

  it("marks a story In Review on its branch in one commit, and nothing when it already is", async () => {
    const stories = new FakeStoryStore().put(fakeStory("DIPO-1", { status: "In Progress" }));
    const ops = gitStoryOps({ git: () => fakeGit, stories });
    const input = { branch: BRANCH, story: "DIPO-1", taskFile: "", criteria: [1] };
    expect(await ops.markInReview(OFFICE, input)).toBe("fake-commit-1");
    expect(await ops.markInReview(OFFICE, input)).toBeNull();
    const shown = await ops.story(OFFICE, BRANCH, "DIPO-1");
    expect(shown).toEqual({
      taskFile: "backlog/tasks/dipo-1 - Story-DIPO-1.md",
      title: "Story DIPO-1",
      status: "In Review",
      criteria: [1],
    });
    expect(stories.branches.get(BRANCH)?.acceptanceCriteria[0]?.checked).toBe(true);
    expect(stories.commits).toEqual([{ branch: BRANCH, message: "DIPO-1: status In Review" }]);
    // The base is not touched: the story lane writes only the branch.
    expect(stories.base.get("DIPO-1")?.story?.status).toBe("In Progress");
  });

  it("closes a parked story out: the park removed and status Done, in one commit", async () => {
    const stories = new FakeStoryStore().put(
      fakeStory("DIPO-1", { status: "Parked", description: PARKED }),
    );
    const { commit } = await stories.editOnBranch(
      fakeGit,
      {} as never,
      { story: "DIPO-1", branch: BRANCH },
      "DIPO-1: status Done",
      async (story) => {
        await story.setFinalSummary("Done.");
        await closeOutFields(story);
      },
    );
    expect(commit).toBe("fake-commit-1");
    const closed = stories.branches.get(BRANCH);
    expect(closed?.status).toBe("Done");
    expect(closed?.finalSummary).toBe("Done.");
    expect(parseFieldBlock(closed?.description ?? "").fields).toEqual({ branch: BRANCH });
  });
});
