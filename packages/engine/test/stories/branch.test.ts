// A claimed story is read on its story branch (DIPO-56 AC #2, 0007 section 6 step 3): from the
// claim commit until the claim is released, the story view and the snapshot take its lifecycle,
// park record (F16), criteria and tier as committed at the branch tip, not from `_base` and not
// from uncommitted edits in the claim's worktree. The maintainer
// saw `dipo watch TASK-1` say Ready after `dipo stop` parked it on the branch; these cases pin the
// fix with a scripted Backlog CLI, real git and the real index.

import { describe, expect, it } from "bun:test";

import { releaseClaim } from "../../src/worktree/records";
import { snapshot } from "../../src/views/feature";
import { storyView } from "../../src/views/story";
import { claim, editWorktree, keyOf, setBranch, withReconcileOffice } from "../reconcile/helpers";

const PARK = 'park: { reason: "stopped", from: "In Progress", note: "Stopped by the maintainer." }';

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
        releaseClaim(o.office, claimed.runId, { at: 1, reason: "test", keepBranch: true }),
      );
      await o.index.indexStories(o.officeId);
      expect(storyView(o.office, key)?.lifecycle).toBe("Ready");
      expect(mirrorSource(o, key)).toBe("base");
    }));
});
