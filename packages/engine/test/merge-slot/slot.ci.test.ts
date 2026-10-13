// The merge slot end to end against real temporary repositories, the pinned Backlog CLI and an
// in-memory code host whose squash merge really merges on the bare remote (DIPO-73), in CI only
// (0017): a green PR merges and an operation submitted meanwhile opens the next PR; a moved base is
// merged into the branch, pushed without force, and a refusal while the base moves again is
// retried; a base that conflicts rebuilds the branch on a new name, opens a new PR and closes the
// old one. The fast cases of the same rules are in slot.test.ts.

import { describe, expect, it } from "bun:test";

import { type OfficeId, StoryId } from "@dipsaus-orchestrator/contract";
import { type TempRepoWithRemote, withBareRemote } from "@dipsaus-orchestrator/testkit";

import { allEntries, OfficeLane, pendingLaneOp } from "../../src/backlog/lane";
import { BacklogPrs, findPr } from "../../src/backlog/pr";
import { MergeSlot, SLOT_NOTICES } from "../../src/merge-slot";
import { CodeHostError, type RequiredCheck } from "../../src/platform/host";
import { addStory } from "../../src/stories/keys";
import {
  BACKLOG_FIXTURE,
  inRemote,
  laneSetup,
  notices,
  publish,
  pushStatusChange,
  squashMergeOnRemote,
} from "../backlog/lane/helpers";
import { FakeHost, REMOTE_URL } from "../backlog/pr/helpers";

import { GREEN, PENDING } from "./helpers";

const FIXTURE = { fixture: BACKLOG_FIXTURE };

const trimmed = async (out: Promise<string>): Promise<string> => (await out).trim();

/** A host whose squash merge squashes the branch onto the remote's `main`. */
class RemoteHost extends FakeHost {
  checks: RequiredCheck[] = GREEN;
  refusals = 0;
  onRefuse: () => Promise<void> = async () => {};
  merges = 0;

  constructor(readonly repo: TempRepoWithRemote) {
    super();
  }

  override async requiredChecks(): Promise<RequiredCheck[]> {
    return this.checks;
  }

  override async squashMerge(
    repo: string,
    number: number,
    merge?: { headSha: string; subject: string },
  ): Promise<void> {
    this.calls.push(`merge ${repo} #${number} at ${merge?.headSha}`);
    this.merges += 1;
    if (this.refusals > 0) {
      this.refusals -= 1;
      await this.onRefuse();
      throw new CodeHostError("failed", "Base branch was modified.");
    }
    const pr = this.prs.get(number);
    if (pr === undefined) throw new Error(`no PR #${number}`);
    await squashMergeOnRemote(this.repo, pr.head);
    this.prs.set(number, { ...pr, state: "merged", headSha: merge?.headSha ?? "" });
  }
}

async function setup(repo: TempRepoWithRemote) {
  await publish(repo);
  await repo.git("config", `url.${repo.remote}.insteadOf`, REMOTE_URL);
  await repo.git("remote", "set-url", "origin", REMOTE_URL);
  const base = await laneSetup(repo);
  const officeId = base.office.officeId as OfficeId;
  const host = new RemoteHost(repo);
  let lane: OfficeLane | undefined;
  const prs = new BacklogPrs({
    host,
    lane: () => lane,
    cli: base.cli,
    offices: { get: () => base.office },
    clock: base.t.clock,
  });
  const slot = new MergeSlot({
    host,
    prs,
    lane: () => lane,
    offices: { get: () => base.office },
    clock: base.t.clock,
  });
  lane = new OfficeLane({
    officeId,
    office: base.office,
    git: base.git,
    cli: base.cli,
    clock: base.t.clock,
    kinds: base.kinds,
    onFlushed: (office, report) => prs.afterFlush(office, report),
    held: (office) => slot.holding(office),
  });
  const made = lane;
  const keys = {
    one: addStory(base.office, base.t.ids, { story: StoryId.parse("TASK-1") }, 0).key,
    two: addStory(base.office, base.t.ids, { story: StoryId.parse("TASK-2") }, 0).key,
  };
  return { ...base, officeId, host, prs, slot, lane: made, keys };
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("the merge slot with a real repository", () => {
    it("merges a green PR and opens the next PR for an operation held meanwhile", async () => {
      await withBareRemote(async (repo) => {
        const s = await setup(repo);
        const first = await s.lane.submit({
          kind: "edit",
          key: s.keys.one,
          subject: "TASK-1",
          target: { status: "Refined" },
        });
        const branch = first.report.branch as string;
        expect(findPr(s.office, 1)?.check).toBe("passed");

        s.host.checks = PENDING;
        expect(await s.slot.tick(s.officeId)).toBe("waiting");
        const held = await s.lane.submit({
          kind: "edit",
          key: s.keys.two,
          subject: "TASK-2",
          target: { labels: { add: ["tier:M"] } },
        });
        expect(held.report.held).toBe(true);
        // Nothing reached the branch while it was in the slot.
        expect(await trimmed(inRemote(repo, "log", "--format=%s", "-1", branch))).toBe(
          "backlog: edit TASK-1",
        );

        s.host.checks = GREEN;
        // A second later, so the next branch gets a name of its own.
        s.t.clock.advance(1000);
        expect(await s.slot.tick(s.officeId)).toBe("merged");
        expect(await trimmed(inRemote(repo, "log", "--format=%s", "-1", "main"))).toBe(
          `backlog PR ${branch}`,
        );
        expect(findPr(s.office, 1)?.state).toBe("merged");
        expect(pendingLaneOp(s.office, s.keys.one)).toBeNull();
        // The merged branch is gone here and on the remote.
        expect(await trimmed(repo.git("branch", "--list", branch))).toBe("");
        expect(await trimmed(inRemote(repo, "branch", "--list", branch))).toBe("");
        // The held operation went onto a new branch and the next PR.
        const next = allEntries(s.office).find((entry) => entry.subject === "TASK-2");
        expect(next?.state).toBe("pushed");
        expect(next?.branch).not.toBe(branch);
        expect(s.host.prs.get(2)).toMatchObject({ state: "open", head: next?.branch });
      }, FIXTURE);
    });

    it("merges a moved base into the branch and retries a refusal while the base moves again", async () => {
      await withBareRemote(async (repo) => {
        const s = await setup(repo);
        const first = await s.lane.submit({
          kind: "edit",
          key: s.keys.one,
          subject: "TASK-1",
          target: { status: "Refined" },
        });
        const branch = first.report.branch as string;
        const before = (await inRemote(repo, "rev-parse", branch)).trim();
        await pushStatusChange(repo, { "TASK-3": "In Progress" });
        s.host.refusals = 1;
        s.host.onRefuse = () => pushStatusChange(repo, { "TASK-3": "In Review" });

        expect(await s.slot.tick(s.officeId)).toBe("merged");
        expect(s.host.merges).toBe(2);
        // The branch took merge commits (never a rebase) and was pushed without force: the old
        // tip is an ancestor of what merged.
        const merges = s.host.calls.filter((call) => call.startsWith("merge"));
        const mergedHead = merges.at(-1)?.split(" at ")[1] ?? "";
        expect(await trimmed(repo.git("merge-base", "--is-ancestor", before, mergedHead))).toBe("");
        expect(
          (await repo.git("rev-list", "--merges", "--count", `${before}..${mergedHead}`)).trim(),
        ).toBe("2");
        expect(notices(s.office).map((n) => n.code)).toContain(SLOT_NOTICES.merged);
      }, FIXTURE);
    });

    it("rebuilds a branch that conflicts with the base on a new branch and a new PR", async () => {
      await withBareRemote(async (repo) => {
        const s = await setup(repo);
        const first = await s.lane.submit({
          kind: "edit",
          key: s.keys.one,
          subject: "TASK-1",
          target: { status: "Refined" },
        });
        const branch = first.report.branch as string;
        await pushStatusChange(repo, { "TASK-1": "In Progress" });

        expect(await s.slot.tick(s.officeId)).toBe("rebuilt");
        const entry = allEntries(s.office)[0];
        expect(entry?.branch).toBe(`${branch}-2`);
        expect(entry?.state).toBe("pushed");
        expect(s.host.prs.get(1)?.state).toBe("closed");
        expect(s.host.prs.get(2)).toMatchObject({ state: "open", head: `${branch}-2` });
        expect(findPr(s.office, 1)?.state).toBe("closed");
        // The merge was aborted: the old branch is where it was.
        expect(await trimmed(repo.git("log", "--format=%s", "-1", branch))).toBe(
          "backlog: edit TASK-1",
        );
        expect(s.host.merges).toBe(0);
      }, FIXTURE);
    });
  });
}
