// The merge slot's bounds (DIPO-73 review): a flush that started before the slot took the branch
// applies nothing once it has; only operations whose commit is in the merged head are marked
// merged; the wait for checks ends after `CHECKS_WAIT_MS`, also when the host cannot be read; a
// PR closed while in the slot leaves it; and the `entered` notice is shown once per PR and head.
// Fake host, scripted slot git, no git or CLI.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { allEntries, EDIT_KIND, editKind, OfficeLane, pendingLaneOp } from "../../src/backlog/lane";
import { updateEntry } from "../../src/backlog/lane/journal";
import type { GitSession, OfficeGit } from "../../src/git/office";
import { CHECKS_WAIT_MS, SLOT_NOTICES } from "../../src/merge-slot";
import { CodeHostError } from "../../src/platform/host";
import { notices } from "../backlog/lane/helpers";
import { addOffice, openTestState } from "../commands/helpers";

import { BRANCH, GREEN, openBacklogPr, slotSetup } from "./helpers";

const LATE = "9".repeat(40);

describe("the lane while the slot takes the branch", () => {
  it("applies nothing in a flush whose git item runs after the slot took the branch", async () => {
    await withTempDir(async (dir) => {
      const t = await openTestState(join(dir, "state"));
      const office = addOffice(t);
      let held: string | null = null;
      let taken = false;
      // Every step answers "not found": no remote, no refs. A flush that went on would throw.
      const session: GitSession = {
        repository: { kind: "repository", commonDir: "/repo/.git" },
        base: async () => "main",
        step: async () => ({ code: 1, stdout: "", stderr: "" }),
        ok: () => Promise.reject(new Error("the flush went on")),
      };
      const git = {
        run: async <T>(fn: (git: GitSession) => Promise<T>) => {
          const result = await fn(session);
          // The slot takes the branch right after the flush's first item (the remote check).
          if (taken) held = BRANCH;
          return result;
        },
        settings: { remote: "origin", base: "main" },
      } as unknown as OfficeGit;
      let hooked = 0;
      const lane = new OfficeLane({
        officeId: office.officeId as OfficeId,
        office,
        git,
        cli: { spawn: () => Promise.reject(new Error("no CLI")) as never },
        clock: t.clock,
        kinds: new Map([[EDIT_KIND, editKind(EDIT_KIND)]]),
        held: () => held,
        onFlushed: async () => {
          hooked += 1;
        },
      });
      await lane.journal({ kind: "edit", subject: "TASK-1", target: { status: "Refined" } });
      taken = true;
      const report = await lane.flush();
      expect(report.held).toBe(true);
      expect(hooked).toBe(0);
      expect(allEntries(office).map((entry) => entry.state)).toEqual(["pending"]);
    });
  });
});

describe("the merge slot's bounds", () => {
  it("marks merged only the operations whose commit is in the merged head", async () => {
    await withTempDir(async (dir) => {
      const s = await slotSetup(dir);
      await openBacklogPr(s);
      // A late operation reached the branch, but its commit is not in the head that merged.
      const late = await s.lane.journal({
        kind: "edit",
        key: s.keys.two,
        subject: "TASK-2",
        target: { status: "Refined" },
      });
      s.office.immediate(() =>
        updateEntry(
          s.office,
          late.opId,
          { state: "pushed", branch: BRANCH, commit: LATE },
          s.t.clock.now(),
        ),
      );
      s.git.notInHead.add(LATE);
      s.host.checks = GREEN;
      expect(await s.slot.tick(s.officeId)).toBe("merged");
      expect(allEntries(s.office).map((entry) => [entry.subject, entry.state])).toEqual([
        ["TASK-1", "merged"],
        ["TASK-2", "pushed"],
      ]);
      expect(pendingLaneOp(s.office, s.keys.one)).toBeNull();
      expect(pendingLaneOp(s.office, s.keys.two)).not.toBeNull();
      // The left-out operation still names the deleted branch, so the slot flushes right away and
      // the lane applies it again on a new branch, although no operation is pending.
      expect(s.flushes).toEqual([{ rebuild: undefined, heldThen: null }]);
    });
  });

  it("does not flush after a merge that left nothing behind", async () => {
    await withTempDir(async (dir) => {
      const s = await slotSetup(dir);
      await openBacklogPr(s);
      s.host.checks = GREEN;
      expect(await s.slot.tick(s.officeId)).toBe("merged");
      expect(s.flushes).toEqual([]);
    });
  });

  it("leaves the slot when the checks do not report within the wait, and comes back once they pass", async () => {
    await withTempDir(async (dir) => {
      const s = await slotSetup(dir);
      await openBacklogPr(s);
      expect(await s.slot.tick(s.officeId)).toBe("waiting");
      s.t.clock.advance(CHECKS_WAIT_MS - 1);
      expect(await s.slot.tick(s.officeId)).toBe("waiting");
      s.t.clock.advance(1);
      expect(await s.slot.tick(s.officeId)).toBe("left");
      expect(s.slot.holding(s.officeId)).toBeNull();
      const stuck = notices(s.office).filter((n) => n.code === SLOT_NOTICES.checksStuck);
      expect(stuck).toHaveLength(1);
      expect(stuck[0]?.text).toContain("ci-ok");
      // Out until the checks pass.
      expect(await s.slot.tick(s.officeId)).toBe("idle");
      s.host.checks = GREEN;
      expect(await s.slot.tick(s.officeId)).toBe("merged");
    });
  });

  it("notices once that the checks cannot be read, and still bounds the wait", async () => {
    await withTempDir(async (dir) => {
      const s = await slotSetup(dir);
      await openBacklogPr(s);
      s.host.checksError = new CodeHostError("unauthenticated", "gh is not logged in.");
      expect(await s.slot.tick(s.officeId)).toBe("waiting");
      expect(await s.slot.tick(s.officeId)).toBe("waiting");
      const unreadable = notices(s.office).filter((n) => n.code === SLOT_NOTICES.checksUnreadable);
      expect(unreadable).toHaveLength(1);
      expect(unreadable[0]?.text).toContain("gh is not logged in.");
      s.t.clock.advance(CHECKS_WAIT_MS);
      expect(await s.slot.tick(s.officeId)).toBe("left");
      expect(notices(s.office).map((n) => n.code)).toContain(SLOT_NOTICES.checksStuck);
    });
  });

  it("leaves the slot when the PR is closed while it waits", async () => {
    await withTempDir(async (dir) => {
      const s = await slotSetup(dir);
      await openBacklogPr(s);
      expect(await s.slot.tick(s.officeId)).toBe("waiting");
      const pr = s.host.prs.get(1);
      if (pr !== undefined) s.host.prs.set(1, { ...pr, state: "closed" });
      expect(await s.slot.tick(s.officeId)).toBe("left");
      expect(notices(s.office).map((n) => n.code)).toContain(SLOT_NOTICES.closed);
      expect(s.slot.holding(s.officeId)).toBeNull();
      expect(await s.slot.tick(s.officeId)).toBe("idle");
      expect(s.host.merges).toEqual([]);
    });
  });

  it("shows the entered notice once per PR and head", async () => {
    await withTempDir(async (dir) => {
      const s = await slotSetup(dir);
      await openBacklogPr(s);
      s.git.fetchOk = false;
      expect(await s.slot.tick(s.officeId)).toBe("left");
      expect(await s.slot.tick(s.officeId)).toBe("left");
      expect(notices(s.office).filter((n) => n.code === SLOT_NOTICES.entered)).toHaveLength(1);
      // A new head is a new entry.
      s.git.heads.set(BRANCH, "6".repeat(40));
      expect(await s.slot.tick(s.officeId)).toBe("left");
      expect(notices(s.office).filter((n) => n.code === SLOT_NOTICES.entered)).toHaveLength(2);
    });
  });
});
