// Adopting an open backlog PR after a lost database (DIPO-80), against real temporary repositories,
// the pinned Backlog CLI and an in-memory code host, in CI only (0017). One database opens the PR;
// a second, fresh database on the same repository stands for the database after the loss. The
// fresh one adopts the PR into `backlog_prs` and the lane, appends to it and merges it through the
// merge slot; a new Ready whose gate decision was lost keeps it unmerged until the gate passes
// again; two unknown PRs, or one whose branch holds a commit the lane did not make, are noticed and
// left alone. No test reaches GitHub.

import { writeFileSync } from "node:fs";

import { describe, expect, it, setDefaultTimeout } from "bun:test";

import { type OfficeId, StoryId } from "@dipsaus-orchestrator/contract";
import { git, type TempRepoWithRemote, withBareRemote } from "@dipsaus-orchestrator/testkit";

import { viewStory } from "../../../src/backlog/fields/write";
import { allEntries, LANE_NOTICES, OfficeLane, pendingLaneOp } from "../../../src/backlog/lane";
import { insertEntry, updateEntry } from "../../../src/backlog/lane/journal";
import { BacklogPrs, findPr, PR_NOTICES } from "../../../src/backlog/pr";
import { gateStoryFromView } from "../../../src/gate/input";
import { gateContentHash, storeGateDecision } from "../../../src/gate/store";
import { MergeSlot } from "../../../src/merge-slot";
import type { RequiredCheck } from "../../../src/platform/host";
import { addStory } from "../../../src/stories/keys";
import { GREEN } from "../../merge-slot/helpers";
import {
  BACKLOG_FIXTURE,
  inRemote,
  laneSetup,
  notices,
  otherClone,
  publish,
  pushStatusChange,
  squashMergeOnRemote,
  taskFile,
} from "../lane/helpers";

import { FakeHost, REMOTE_URL } from "./helpers";

// Each test drives the pinned Backlog CLI and real git several times; the GitHub macOS runner needs
// more than the default 5 s (DIPO-316).
setDefaultTimeout(30_000);

const FIXTURE = { fixture: BACKLOG_FIXTURE };

/** A host whose squash merge squashes the branch onto the remote's `main`. */
class RemoteHost extends FakeHost {
  checks: RequiredCheck[] = GREEN;
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
    const pr = this.prs.get(number);
    if (pr === undefined) throw new Error(`no PR #${number}`);
    await squashMergeOnRemote(this.repo, pr.head);
    this.prs.set(number, { ...pr, state: "merged", headSha: merge?.headSha ?? "" });
  }
}

/** One database on the repository: its lane, backlog PRs and merge slot, sharing `host`. */
async function database(repo: TempRepoWithRemote, host: RemoteHost, stateDir: string) {
  const base = await laneSetup(repo, undefined, stateDir);
  const officeId = base.office.officeId as OfficeId;
  let lane: OfficeLane | undefined;
  const prs = new BacklogPrs({
    host,
    list: host,
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
  return { ...base, officeId, prs, slot, lane: made, keys };
}

async function start(repo: TempRepoWithRemote) {
  await publish(repo);
  await repo.git("config", `url.${repo.remote}.insteadOf`, REMOTE_URL);
  await repo.git("remote", "set-url", "origin", REMOTE_URL);
  const host = new RemoteHost(repo);
  const lost = await database(repo, host, "state-lost");
  return { host, lost };
}

/** The host calls that would change a PR: dipo never closes, edits or merges one it left alone. */
function changing(host: FakeHost): string[] {
  return host.calls.filter((call) => /^(close|update|merge|create) /.test(call));
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("adopting an open backlog PR after a lost database", () => {
    it("adopts the one open PR into backlog_prs and the lane, appends to it and merges it", async () => {
      await withBareRemote(async (repo) => {
        const { host, lost } = await start(repo);
        const first = await lost.lane.submit({
          kind: "edit",
          key: lost.keys.one,
          subject: "TASK-1",
          target: { status: "Refined" },
        });
        const branch = first.report.branch as string;
        expect(host.prs.get(1)).toMatchObject({ state: "open", head: branch });

        // The database is lost: a fresh one knows neither the PR nor the journal.
        const fresh = await database(repo, host, "state-fresh");
        expect(findPr(fresh.office, 1)).toBeNull();
        expect(await fresh.prs.adopt(fresh.officeId)).toEqual({ adopted: 1, refused: [] });
        expect(host.calls).toContain(`list o/r dipo/backlog-`);
        expect(findPr(fresh.office, 1)).toMatchObject({ state: "open", branch, check: "passed" });
        expect(allEntries(fresh.office)).toEqual([
          expect.objectContaining({
            opId: 1,
            kind: "edit",
            subject: "TASK-1",
            key: fresh.keys.one,
            branch,
            state: "pushed",
            prRef: host.prs.get(1)?.url,
          }),
        ]);
        expect(pendingLaneOp(fresh.office, fresh.keys.one)?.ops).toEqual([1]);
        const adopted = notices(fresh.office).filter((n) => n.code === PR_NOTICES.adopted);
        expect(adopted.map((n) => n.level)).toEqual(["info"]);
        expect(adopted[0]?.text).toContain("#1");
        // A second look finds it known and adopts nothing.
        expect(await fresh.prs.adopt(fresh.officeId)).toEqual({ adopted: null, refused: [] });

        // The lane treats it as its open branch: a new operation goes onto it with a later op id,
        // and no second PR opens.
        fresh.t.clock.advance(1000);
        const next = await fresh.lane.submit({
          kind: "edit",
          key: fresh.keys.two,
          subject: "TASK-2",
          target: { labels: { add: ["tier:M"] } },
        });
        expect(next.entry.opId).toBe(2);
        expect(next.report.branch).toBe(branch);
        expect([...host.prs.keys()]).toEqual([1]);
        expect(
          (await inRemote(repo, "log", "--format=%s", branch, "^main")).trim().split("\n"),
        ).toEqual(["backlog: edit TASK-2", "backlog: edit TASK-1"]);

        // The merge slot merges it once its checks pass, and the lane closes the operations.
        expect(await fresh.slot.tick(fresh.officeId)).toBe("merged");
        expect(host.prs.get(1)?.state).toBe("merged");
        expect(findPr(fresh.office, 1)?.state).toBe("merged");
        expect(allEntries(fresh.office).map((entry) => entry.state)).toEqual(["merged", "merged"]);
        expect(pendingLaneOp(fresh.office, fresh.keys.one)).toBeNull();
        expect(host.calls.filter((call) => call.startsWith("close"))).toEqual([]);
      }, FIXTURE);
    });

    it("keeps an adopted PR with a new Ready whose gate decision was lost unmerged until the gate passes again", async () => {
      await withBareRemote(async (repo) => {
        const { host, lost } = await start(repo);
        await lost.lane.submit({
          kind: "edit",
          key: lost.keys.two,
          subject: "TASK-2",
          target: { status: "Ready" },
        });

        const fresh = await database(repo, host, "state-fresh");
        expect((await fresh.prs.adopt(fresh.officeId)).adopted).toBe(1);
        expect(findPr(fresh.office, 1)).toMatchObject({ state: "open", check: "failed" });
        const failed = notices(fresh.office).filter((n) => n.code === PR_NOTICES.checkFailed);
        expect(failed.map((n) => n.key)).toEqual([fresh.keys.two]);
        expect(failed[0]?.text).toContain("[ready-decision] on TASK-2");
        expect(await fresh.slot.tick(fresh.officeId)).toBe("idle");
        expect(host.merges).toBe(0);

        // The Ready gate passes again for TASK-2's content; the next sync checks the PR again and
        // the merge slot merges it.
        fresh.t.clock.advance(1000);
        const view = await viewStory({ cli: fresh.cli, cwd: repo.dir, id: "TASK-2", kind: "task" });
        fresh.office.immediate(() =>
          storeGateDecision(fresh.office, fresh.t.ids, {
            key: fresh.keys.two,
            result: { mode: "ready", passed: true, failures: [] },
            contentHash: gateContentHash(gateStoryFromView(view, [])),
            at: fresh.t.clock.now(),
          }),
        );
        await fresh.prs.sync(fresh.officeId);
        expect(findPr(fresh.office, 1)).toMatchObject({ check: "passed", failures: [] });
        expect(await fresh.slot.tick(fresh.officeId)).toBe("merged");
        expect(host.prs.get(1)?.state).toBe("merged");
      }, FIXTURE);
    });

    it("rebuilds the new operations of an adopted branch that conflicts, and drops the adopted one naming its closed PR", async () => {
      await withBareRemote(async (repo) => {
        const { host, lost } = await start(repo);
        await lost.lane.submit({
          kind: "edit",
          key: lost.keys.one,
          subject: "TASK-1",
          target: { status: "Refined" },
        });
        const fresh = await database(repo, host, "state-fresh");
        expect((await fresh.prs.adopt(fresh.officeId)).adopted).toBe(1);
        fresh.t.clock.advance(1000);
        await fresh.lane.submit({
          kind: "edit",
          key: fresh.keys.two,
          subject: "TASK-2",
          target: { labels: { add: ["tier:M"] } },
        });

        // TASK-1 changed on main: the branch is rebuilt (0010 section 2) with TASK-2 only, and the
        // adopted PR is closed as for any rebuild.
        await pushStatusChange(repo, { "TASK-1": "In Progress" });
        expect(await fresh.slot.tick(fresh.officeId)).toBe("rebuilt");
        expect(host.prs.get(1)?.state).toBe("closed");
        expect(host.prs.get(2)?.state).toBe("open");
        const entries = allEntries(fresh.office);
        expect(entries.map((entry) => [entry.subject, entry.state])).toEqual([
          ["TASK-1", "dropped"],
          ["TASK-2", "pushed"],
        ]);
        const dropped = notices(fresh.office).filter((n) => n.code === LANE_NOTICES.dropped);
        expect(dropped).toHaveLength(1);
        expect(dropped[0]?.text).toContain("its change is in the backlog PR #1, which dipo closes");
        expect(dropped[0]?.text).toContain("it was not applied again there");
        expect(dropped[0]?.text).not.toContain("still on");
      }, FIXTURE);
    });

    it("lets go of an adopted PR that conflicts with the base without closing it", async () => {
      await withBareRemote(async (repo) => {
        const { host, lost } = await start(repo);
        const first = await lost.lane.submit({
          kind: "edit",
          key: lost.keys.one,
          subject: "TASK-1",
          target: { status: "Refined" },
        });
        const branch = first.report.branch as string;
        const fresh = await database(repo, host, "state-fresh");
        expect((await fresh.prs.adopt(fresh.officeId)).adopted).toBe(1);

        // TASK-1 changed on main meanwhile: the branch conflicts, and its operation's target state
        // was lost, so the lane cannot rebuild it on a new branch.
        await pushStatusChange(repo, { "TASK-1": "In Progress" });
        expect(await fresh.slot.tick(fresh.officeId)).toBe("rebuilt");
        const codes = notices(fresh.office).map((n) => n.code);
        expect(codes).toContain(LANE_NOTICES.adoptedAbandoned);
        expect(codes).toContain(LANE_NOTICES.dropped);
        expect(codes).toContain(PR_NOTICES.letGo);
        expect(allEntries(fresh.office).map((entry) => entry.state)).toEqual(["dropped"]);
        expect(pendingLaneOp(fresh.office, fresh.keys.one)).toBeNull();
        // The record lets go; the PR and its branch stay as they are for the maintainer.
        expect(findPr(fresh.office, 1)?.state).toBe("closed");
        expect(host.prs.get(1)?.state).toBe("open");
        expect(host.calls.filter((call) => /^(close|merge|create) /.test(call))).toEqual([
          `create o/r ${branch} -> main: ${host.prs.get(1)?.title}`,
        ]);
        expect((await inRemote(repo, "log", "--format=%s", "-1", branch)).trim()).toBe(
          "backlog: edit TASK-1",
        );
        // A rescan does not take it back.
        expect(await fresh.prs.adopt(fresh.officeId)).toEqual({ adopted: null, refused: [] });
      }, FIXTURE);
    });

    it("adopts nothing when a lane branch of the office's own appears while it fetches", async () => {
      await withBareRemote(async (repo) => {
        const { host, lost } = await start(repo);
        await lost.lane.submit({
          kind: "edit",
          key: lost.keys.one,
          subject: "TASK-1",
          target: { status: "Refined" },
        });
        const fresh = await database(repo, host, "state-fresh");
        // A flush of the fresh lane lands between adopt's first look and its git queue item: it
        // cut a branch of the office's own, which the journal names.
        const own = "dipo/backlog-20990101T000000";
        let armed = true;
        fresh.hooks.onGit = (args) => {
          if (!armed || !args.includes("fetch")) return;
          armed = false;
          fresh.office.immediate(() => {
            const entry = insertEntry(
              fresh.office,
              { kind: "edit", key: fresh.keys.two, subject: "TASK-2", target: {} },
              fresh.t.clock.now(),
            );
            updateEntry(
              fresh.office,
              entry.opId,
              { state: "committed", branch: own, commit: "c".repeat(40) },
              fresh.t.clock.now(),
            );
          });
        };
        const report = await fresh.prs.adopt(fresh.officeId);
        expect(armed).toBe(false);
        expect(report).toMatchObject({ adopted: null, refused: [{ number: 1 }] });
        expect(report.refused[0]?.reason).toContain(`backlog branch ${own}`);
        expect(findPr(fresh.office, 1)).toBeNull();
        expect(allEntries(fresh.office).map((entry) => entry.branch)).toEqual([own]);
      }, FIXTURE);
    });

    it("adopts none of two unknown PRs, nor one whose branch the lane did not make, and closes nothing", async () => {
      await withBareRemote(async (repo) => {
        const { host, lost } = await start(repo);
        await lost.lane.submit({
          kind: "edit",
          key: lost.keys.one,
          subject: "TASK-1",
          target: { status: "Refined" },
        });
        // A second backlog branch with a commit made by hand, and its PR.
        const other = await otherClone(repo);
        const hand = "dipo/backlog-20990101T000000";
        await git(other, repo.home, "checkout", "--quiet", "-b", hand, "origin/main");
        writeFileSync(taskFile(other, "TASK-3"), "edited by hand\n");
        await git(other, repo.home, "commit", "--quiet", "-am", "edit TASK-3 by hand");
        await git(other, repo.home, "push", "--quiet", "origin", hand);
        await host.createPr("o/r", { base: "main", head: hand, title: "by hand", body: "" });
        const before = changing(host);

        const fresh = await database(repo, host, "state-fresh");
        const two = await fresh.prs.adopt(fresh.officeId);
        expect(two.adopted).toBeNull();
        expect(two.refused.map((r) => r.number)).toEqual([1, 2]);
        const refused = notices(fresh.office).filter((n) => n.code === PR_NOTICES.notAdopted);
        expect(refused.map((n) => n.level)).toEqual(["warn", "warn"]);
        expect(refused[0]?.text).toContain("2 open backlog PRs (#1, #2)");
        expect(findPr(fresh.office, 1)).toBeNull();
        expect(allEntries(fresh.office)).toEqual([]);
        // A rescan with nothing changed does not notice it again.
        await fresh.prs.adopt(fresh.officeId);
        expect(notices(fresh.office).filter((n) => n.code === PR_NOTICES.notAdopted)).toHaveLength(
          2,
        );

        // The maintainer closes #1; #2 alone is unknown now, but its branch holds a commit the
        // lane did not make, so the lane cannot take it over.
        const one = host.prs.get(1);
        if (one !== undefined) host.prs.set(1, { ...one, state: "closed" });
        const hand2 = await fresh.prs.adopt(fresh.officeId);
        expect(hand2).toMatchObject({ adopted: null, refused: [{ number: 2 }] });
        expect(hand2.refused[0]?.reason).toContain("is not a dipo backlog commit");
        expect(findPr(fresh.office, 2)).toBeNull();
        expect(allEntries(fresh.office)).toEqual([]);
        expect(await fresh.slot.tick(fresh.officeId)).toBe("idle");
        expect(host.prs.get(2)?.state).toBe("open");
        expect(changing(host)).toEqual(before);
      }, FIXTURE);
    });
  });
}
