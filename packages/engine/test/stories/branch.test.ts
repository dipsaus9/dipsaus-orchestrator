// A claimed story is read on its story branch (DIPO-56 AC #2, 0007 section 6 step 3): from the
// claim commit until the claim is released, the story view and the snapshot take its lifecycle,
// park record (F16), criteria and tier as committed at the branch tip, not from `_base` and not
// from uncommitted edits in the claim's worktree. The maintainer
// saw `dipo watch TASK-1` say Ready after `dipo stop` parked it on the branch; these cases pin the
// fix with a scripted Backlog CLI, real git and the real index.

import { describe, expect, it } from "bun:test";

import { readFileSync, writeFileSync } from "node:fs";

import { TASK_FIELD_ERROR } from "../../src/story-store/errors";
import { GitError } from "../../src/git";
import { releaseClaim } from "../../src/worktree/records";
import { snapshot } from "../../src/overview/feature";
import { storyView } from "../../src/views/story";
import { backlogPark } from "../../src/records/park-state";
import { BRANCH_UNREAD_NOTICE } from "../../src/stories/index-stories";
import {
  claim,
  editWorktree,
  keyOf,
  noticesAfter,
  setBranch,
  withReconcileOffice,
} from "../reconcile/helpers";
import { lastSeq } from "./helpers";
import { backlogLayout } from "../story-store/backlog";

const PARK = 'park: { reason: "stopped", from: "In Progress", note: "Stopped by the maintainer." }';
const PARK_NOW =
  'park: { reason: "by-maintainer", from: "In Progress", note: "Stopped by the maintainer." }';

function mirrorSource(o: { office: Parameters<typeof keyOf>[0] }, key: string): string | null {
  return (
    o.office.get<{ source: string }>(
      "select source from backlog_mirror where office_id = $office_id and key = $key",
      { key },
    )?.source ?? null
  );
}

describe("claimed stories read on their branch", () => {
  it("a claimed story reads In Progress from its branch while the base still says Ready", () =>
    withReconcileOffice({}, async (o) => {
      const key = keyOf(o.office, "TASK-1");
      expect(storyView(o.office, key)?.lifecycle).toBe("Ready");
      await claim(o, o.office, "TASK-1", key, {
        task: { id: "TASK-1", status: "In Progress", criteria: [[true, "It works"]] },
      });

      await o.index.indexStories(o.officeId);
      const view = storyView(o.office, key);
      expect(view?.lifecycle).toBe("In Progress");
      expect(view?.column).toBe("running");
      expect(mirrorSource(o, key)).toBe("TASK-1/a-story");
      expect(snapshot(o.office).stories.find((s) => s.key === key)?.lifecycle).toBe("In Progress");
    }));

  it("an uncommitted edit of the task file in the worktree changes nothing until it is committed", () =>
    withReconcileOffice({}, async (o) => {
      const key = keyOf(o.office, "TASK-1");
      const claimed = await claim(o, o.office, "TASK-1", key);
      editWorktree(claimed, { id: "TASK-1", status: "Done", fields: [PARK] });
      await o.index.indexStories(o.officeId);
      await o.index.refreshStory(o.officeId, key);
      const view = storyView(o.office, key);
      expect(view?.lifecycle).toBe("In Progress");
      expect(view?.parked).toBeUndefined();

      await setBranch(o, claimed, { id: "TASK-1", status: "Done" });
      await o.index.refreshStory(o.officeId, key);
      expect(storyView(o.office, key)?.lifecycle).toBe("Done");
    }));

  it("a parked story's view and snapshot read Parked with its reason right after the park commit", () =>
    withReconcileOffice({}, async (o) => {
      const key = keyOf(o.office, "TASK-1");
      const claimed = await claim(o, o.office, "TASK-1", key);
      await o.index.refreshStory(o.officeId, key);
      expect(storyView(o.office, key)?.lifecycle).toBe("In Progress");

      // The park commit on the branch (`TASK-1: status Parked`), then the single re-read.
      await setBranch(o, claimed, { id: "TASK-1", status: "Parked", fields: [PARK] });
      await o.index.refreshStory(o.officeId, key, { quiet: true });
      const view = storyView(o.office, key);
      expect(view?.lifecycle).toBe("Parked");
      expect(view?.column).toBe("desk");
      expect(view?.parked?.reason).toBe("stopped");
      expect(view?.parked?.detail).toBe("Stopped by the maintainer.");
      expect(snapshot(o.office).stories.find((s) => s.key === key)?.parked?.reason).toBe("stopped");

      // A later full pass keeps reading the branch; once the claim is released the base decides.
      await o.index.indexStories(o.officeId);
      expect(storyView(o.office, key)?.lifecycle).toBe("Parked");
      o.office.immediate(() =>
        releaseClaim(o.office, claimed.runId, {
          at: 1,
          reason: "test",
          ending: "dropped",
          keepBranch: true,
        }),
      );
      await o.index.indexStories(o.officeId);
      expect(storyView(o.office, key)?.lifecycle).toBe("Ready");
      expect(mirrorSource(o, key)).toBe("base");
    }));
});

describe("the base status of a claimed story (DIPO-216)", () => {
  it("is kept next to the branch read: In Progress on the branch, Done on _base", () =>
    withReconcileOffice({ base: [{ id: "TASK-1", status: "Done" }] }, async (o) => {
      const key = keyOf(o.office, "TASK-1");
      await claim(o, o.office, "TASK-1", key, { task: { id: "TASK-1", status: "In Progress" } });

      const pass = await o.index.indexStories(o.officeId);

      expect(pass.read.find((story) => story.story === "TASK-1")?.status).toBe("In Progress");
      expect(pass.baseStatus.get(key)).toBe("Done");
    }));

  it("has no entry for a story that is not claimed", () =>
    withReconcileOffice({}, async (o) => {
      const pass = await o.index.indexStories(o.officeId);
      expect(pass.baseStatus.size).toBe(0);
    }));
});

describe("a branch task file holding fields dipo does not know (DIPO-270)", () => {
  it("is never read with the CLI: the pass keeps the base view and lists it unread, a refresh fails with the coded error", () =>
    withReconcileOffice({}, async (o) => {
      const key = keyOf(o.office, "TASK-1");
      const claimed = await claim(o, o.office, "TASK-1", key, {
        task: { id: "TASK-1", status: "In Progress" },
      });
      const path = editWorktree(claimed, { id: "TASK-1", status: "In Progress" });
      writeFileSync(
        path,
        readFileSync(path, "utf8").replace("\n---\n", "\nunknown_field: 1\n---\n"),
      );
      for (const args of [
        ["git", "add", "--", path],
        ["git", "commit", "--quiet", "--no-verify", "-m", "add a field"],
      ] as const) {
        expect((await o.repo.run(args, claimed.worktree)).exitCode).toBe(0);
      }

      const pass = await o.index.indexStories(o.officeId);
      expect(pass.read.find((story) => story.story === "TASK-1")?.status).toBe("Ready");
      expect(pass.branchUnread.map((unread) => unread.story)).toEqual(["TASK-1"]);
      expect(pass.branchUnread[0]?.reason).toContain("fields dipo does not know");

      const error = await o.index.refreshStory(o.officeId, key).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(GitError);
      expect((error as GitError).code).toBe(TASK_FIELD_ERROR);
    }));
});

describe("a claimed story whose branch stops reading (DIPO-360)", () => {
  it("keeps its last branch read, its park included, with one notice until the branch reads again", () =>
    withReconcileOffice({}, async (o) => {
      const key = keyOf(o.office, "TASK-1");
      const claimed = await claim(o, o.office, "TASK-1", key, {
        task: { id: "TASK-1", status: "In Progress" },
      });
      await setBranch(o, claimed, { id: "TASK-1", status: "Parked", fields: [PARK_NOW] });
      await o.index.indexStories(o.officeId);
      expect(storyView(o.office, key)?.lifecycle).toBe("Parked");
      expect(backlogPark(backlogLayout, o.office, key)?.reason).toBe("by-maintainer");

      // The branch's task file now holds a field dipo does not know: the branch cannot be read.
      const path = editWorktree(claimed, { id: "TASK-1", status: "Parked", fields: [PARK_NOW] });
      writeFileSync(
        path,
        readFileSync(path, "utf8").replace("\n---\n", "\nunknown_field: 1\n---\n"),
      );
      for (const args of [
        ["git", "add", "--", path],
        ["git", "commit", "--quiet", "--no-verify", "-m", "add a field"],
      ] as const) {
        expect((await o.repo.run(args, claimed.worktree)).exitCode).toBe(0);
      }
      const seq = lastSeq(o.office);
      const pass = await o.index.indexStories(o.officeId);
      expect(pass.branchUnread.map((unread) => unread.story)).toEqual(["TASK-1"]);
      // Not the base's Ready: the last branch read stays, and the park with it.
      expect(storyView(o.office, key)?.lifecycle).toBe("Parked");
      expect(backlogPark(backlogLayout, o.office, key)?.reason).toBe("by-maintainer");
      expect(mirrorSource(o, key)).not.toBe("base");
      await o.index.indexStories(o.officeId);
      expect(
        noticesAfter(o.office, seq).filter((notice) => notice.code === BRANCH_UNREAD_NOTICE),
      ).toHaveLength(1);
    }));
});
