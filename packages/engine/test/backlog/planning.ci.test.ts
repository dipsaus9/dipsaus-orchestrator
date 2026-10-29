// CI only (0017): `story.park` of a story with no run, its `work.resume` and `story.drop` on real
// temporary repositories, a bare remote and the pinned Backlog CLI (DIPO-160, DIPO-344; 0020). The
// lane writes F16 and the archive on its engine branch; a drop with `deleteBranch` deletes the
// branch locally and on the remote; a drop without it keeps the branch and records it as released.
// A claim has no worktree (DIPO-349). Fast versions of the command rules are in planning.test.ts.

import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { type OfficeId, RequestId, StoryId, type StoryKey } from "@dipsaus-orchestrator/contract";
import { git, withBareRemote } from "@dipsaus-orchestrator/testkit";

import {
  allEntries,
  DROP_KIND,
  dropKind,
  EDIT_KIND,
  editKind,
  HOLD_KIND,
  OfficeLane,
  planningLane,
  RESUME_KIND,
} from "../../src/backlog/lane";
import { executeCommand } from "../../src/commands/execute";
import { stateOfficeDirectory } from "../../src/commands/offices";
import { buildRegistry } from "../../src/commands/registry";
import { MemoryRequestTable } from "../../src/commands/requests";
import { executeRead } from "../../src/reads/execute";
import { currentPlatform } from "../../src/platform/paths";
import { systemProcessProbe } from "../../src/platform/process";
import { insertStoryPr, latestStoryPr } from "../../src/story-pr/records";
import { openPark } from "../../src/run";
import { WorkResumeCommand } from "../../src/run/work-resume";
import { writeMirror } from "../../src/stories/apply";
import { addStory } from "../../src/stories/keys";
import { StoryPlanning } from "../../src/stories/planning";
import {
  claimStory,
  hasLiveClaim,
  liveClaimOf,
  releaseClaim,
  releasedBranchFor,
} from "../../src/worktree";
import {
  BACKLOG_FIXTURE,
  BRANCH_1,
  byHandOn,
  claimSetup,
  type ClaimSetup,
  inRemote,
  publish,
  TASK_1,
} from "../worktree/helpers";

const FIXTURE = { fixture: BACKLOG_FIXTURE };
const TASK_2_FILE = "backlog/tasks/task-2 - Rename-the-export-setting.md";
const TASK_1_FILE = "backlog/tasks/task-1 - Add-the-CSV-export-command.md";

interface Closed {
  repo: string;
  number: number;
  comment: string;
}

function world(s: ClaimSetup) {
  const lane = new OfficeLane({
    officeId: s.office.officeId,
    office: s.office,
    git: s.git,
    cli: s.cli,
    clock: s.t.clock,
    kinds: new Map([
      [EDIT_KIND, editKind(EDIT_KIND)],
      [HOLD_KIND, editKind(HOLD_KIND)],
      [RESUME_KIND, editKind(RESUME_KIND)],
      [DROP_KIND, dropKind],
    ]),
    liveClaim: hasLiveClaim,
  });
  const closed: Closed[] = [];
  const planning = new StoryPlanning({
    lane: () => planningLane(lane),
    git: () => s.git,
    host: {
      closePr: async (repo, number, comment) => {
        closed.push({ repo, number, comment });
      },
    },
    implemented: () => true,
    probe: systemProcessProbe(currentPlatform()),
  });
  const registry = buildRegistry([planning.feature, new WorkResumeCommand(() => planning).feature]);
  let n = 0;
  const send = (name: string, args: Record<string, unknown>) => {
    n += 1;
    return executeCommand(
      {
        registry,
        offices: stateOfficeDirectory(s.t.state),
        clock: s.t.clock,
        ids: s.t.ids,
        softwareRequests: new MemoryRequestTable(s.t.clock),
      },
      {
        requestId: RequestId.parse(`01J9ZK5Q8W3V4X6Y7Z${String(n).padStart(8, "0")}`),
        name,
        args,
        origin: "cli",
        confirmed: true,
        office: s.office.officeId as OfficeId,
      },
    );
  };
  const read = (args: Record<string, unknown>) =>
    executeRead(
      { registry, offices: stateOfficeDirectory(s.t.state), clock: s.t.clock },
      {
        requestId: RequestId.parse("01J9ZK5Q8W3V4X6Y7Z00000001"),
        name: "story.losses",
        args: { office: s.office.officeId, ...args },
      },
    );
  return { lane, closed, send, read };
}

/** A story in the index and the mirror at `status`, with its park record when parked. */
function indexed(s: ClaimSetup, id: string, status: string, park?: object): StoryKey {
  return s.office.immediate(() => {
    const { key } = addStory(s.office, s.t.ids, { story: StoryId.parse(id) }, s.t.clock.now());
    writeMirror(
      s.office,
      key,
      {
        kind: "task",
        story: StoryId.parse(id),
        title: id,
        status,
        labels: [],
        contentHash: `hash-${id}`,
        ...(park === undefined ? {} : { park: park as never }),
      },
      s.t.clock.now(),
      "base",
    );
    return key;
  });
}

async function branchExists(cwd: string, home: string, ref: string): Promise<boolean> {
  return git(cwd, home, "rev-parse", "--verify", "--quiet", ref).then(
    () => true,
    () => false,
  );
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("park and resume through the real planning lane", () => {
    it("writes F16 and status Parked on the engine branch, then lifts it", async () => {
      await withBareRemote(async (repo) => {
        await publish(repo);
        const s = await claimSetup(repo);
        const { send } = world(s);
        const key = indexed(s, "TASK-2", "Refined");

        const held = await send("story.park", { story: "TASK-2", note: "after M2" });
        expect(held).toMatchObject({ ok: true, changed: true });
        const [entry] = allEntries(s.office);
        expect(entry).toMatchObject({ kind: "hold", state: "pushed" });
        const branch = entry?.branch as string;
        const onBranch = await inRemote(repo, "show", `${branch}:${TASK_2_FILE}`);
        expect(onBranch).toContain("status: Parked");
        expect(onBranch).toContain('reason: "by-maintainer"');
        expect(onBranch).toContain('from: "Refined"');
        expect(onBranch).toContain('note: "after M2"');

        const resumed = await send("work.resume", { story: "TASK-2" });
        expect(resumed).toMatchObject({
          ok: true,
          result: { story: "TASK-2", key, to: "Refined" },
        });
        expect(allEntries(s.office).map((e) => [e.kind, e.state])).toEqual([
          ["hold", "pushed"],
          ["resume", "pushed"],
        ]);
        const lifted = await inRemote(repo, "show", `${branch}:${TASK_2_FILE}`);
        expect(lifted).toContain("status: Refined");
        expect(lifted).not.toContain("by-maintainer");
        expect(openPark(s.office, key)).toBeNull();
      }, FIXTURE);
    });
  });

  describe("drop through the real planning lane", () => {
    it("deletes the branch locally and on the remote with deleteBranch", async () => {
      await withBareRemote(async (repo) => {
        await publish(repo);
        const s = await claimSetup(repo);
        const { send, closed } = world(s);
        const key = indexed(s, TASK_1, "Parked", {
          reason: "by-maintainer",
          from: "In Progress",
          note: "n",
        });
        const outcome = await claimStory(s.deps(), s.request(key));
        if (!outcome.ok) throw new Error(`no claim: ${outcome.notice}`);
        const { claim } = outcome;
        s.office.immediate(() => {
          s.office.run(
            `insert into parks (office_id, park_id, key, story_id, run_id, reason, detail, at)
           values ($office_id, 1, $key, $story, $run, 'by-maintainer', 'stopped', $at)`,
            { key, story: TASK_1, run: claim.runId, at: s.t.clock.now() },
          );
          insertStoryPr(s.office, {
            runId: claim.runId,
            key,
            number: 12,
            url: "https://github.com/acme/app/pull/12",
            branch: BRANCH_1,
            base: "main",
            headSha: "c".repeat(40),
            state: "open",
            title: "feat(TASK-1): export",
            bodyHash: "h",
            openedAt: s.t.clock.now(),
            closedAt: null,
          });
        });
        // The branch is on the remote after the claim.
        expect(await branchExists(repo.remote, repo.home, BRANCH_1)).toBe(true);
        expect(liveClaimOf(s.office, key)).not.toBeNull();
        expect(closed).toEqual([]);

        const dropped = await send("story.drop", { story: TASK_1, deleteBranch: true });
        expect(dropped).toMatchObject({ ok: true, changed: true, result: { story: TASK_1, key } });
        expect(await branchExists(repo.dir, repo.home, `refs/heads/${BRANCH_1}`)).toBe(false);
        expect(await branchExists(repo.remote, repo.home, `refs/heads/${BRANCH_1}`)).toBe(false);
        expect(liveClaimOf(s.office, key)).toBeNull();
        expect(releasedBranchFor(s.office, key, BRANCH_1)).toBeNull();
        expect(openPark(s.office, key)).toBeNull();
        expect(closed).toHaveLength(1);
        expect(closed[0]).toMatchObject({ repo: "acme/app", number: 12 });
        expect(latestStoryPr(s.office, key)?.state).toBe("closed");

        // The lane archived the task file on its engine branch, which is pushed.
        const [entry] = allEntries(s.office);
        expect(entry).toMatchObject({ kind: "drop", state: "pushed" });
        const files = await inRemote(repo, "ls-tree", "-r", "--name-only", entry?.branch as string);
        expect(files).toContain("backlog/archive/tasks/task-1 - Add-the-CSV-export-command.md");
        expect(files).not.toContain(TASK_1_FILE);
      }, FIXTURE);
    });

    it("keeps the branch and records it as released without deleteBranch", async () => {
      await withBareRemote(async (repo) => {
        await publish(repo);
        const s = await claimSetup(repo);
        const { send } = world(s);
        const key = indexed(s, TASK_1, "Parked", {
          reason: "by-maintainer",
          from: "In Progress",
          note: "n",
        });
        const outcome = await claimStory(s.deps(), s.request(key));
        if (!outcome.ok) throw new Error(`no claim: ${outcome.notice}`);

        const dropped = await send("story.drop", { story: TASK_1, deleteBranch: false });
        expect(dropped).toMatchObject({ ok: true, changed: true });
        expect(await branchExists(repo.dir, repo.home, `refs/heads/${BRANCH_1}`)).toBe(true);
        expect(await branchExists(repo.remote, repo.home, `refs/heads/${BRANCH_1}`)).toBe(true);
        expect(liveClaimOf(s.office, key)).toBeNull();
        expect(releasedBranchFor(s.office, key, BRANCH_1)).toMatchObject({ reason: "drop" });
      }, FIXTURE);
    });

    it("lists the commit a deleteBranch drop loses (DIPO-228)", async () => {
      await withBareRemote(async (repo) => {
        await publish(repo);
        const s = await claimSetup(repo);
        const { read } = world(s);
        const key = indexed(s, TASK_1, "Parked", {
          reason: "by-maintainer",
          from: "In Progress",
          note: "n",
        });
        const outcome = await claimStory(s.deps(), s.request(key));
        if (!outcome.ok) throw new Error(`no claim: ${outcome.notice}`);
        await byHandOn(repo, BRANCH_1, async (dir) => {
          writeFileSync(join(dir, "work.txt"), "work\n");
          await git(dir, repo.home, "add", "work.txt");
          await git(dir, repo.home, "commit", "--quiet", "-m", "feat(TASK-1): add work");
        });

        const reply = await read({ story: TASK_1 });
        expect(reply).toMatchObject({ ok: true, result: { story: TASK_1, key } });
        const commits = reply.ok
          ? (reply.result as { commits: { subject: string }[] }).commits
          : [];
        const subjects = commits.map((commit) => commit.subject);
        expect(subjects).toContain("feat(TASK-1): add work");
      }, FIXTURE);
    });

    it("deletes the kept branch of an unclaimed story locally and on the remote, and reclaims its release", async () => {
      await withBareRemote(async (repo) => {
        await publish(repo);
        const s = await claimSetup(repo);
        const { send, read } = world(s);
        const key = indexed(s, TASK_1, "Parked", {
          reason: "by-maintainer",
          from: "In Progress",
          note: "n",
        });
        const outcome = await claimStory(s.deps(), s.request(key));
        if (!outcome.ok) throw new Error(`no claim: ${outcome.notice}`);
        const { claim } = outcome;
        // A release that keeps the branch.
        s.office.immediate(() =>
          releaseClaim(s.office, claim.runId, {
            at: s.t.clock.now(),
            reason: "by-maintainer",
            keepBranch: true,
          }),
        );

        expect(await read({ story: TASK_1 })).toMatchObject({
          ok: true,
          result: { commits: expect.any(Array) },
        });
        expect(await branchExists(repo.dir, repo.home, `refs/heads/${BRANCH_1}`)).toBe(true);

        const dropped = await send("story.drop", { story: TASK_1, deleteBranch: true });
        expect(dropped).toMatchObject({ ok: true, changed: true });
        expect(await branchExists(repo.dir, repo.home, `refs/heads/${BRANCH_1}`)).toBe(false);
        expect(await branchExists(repo.remote, repo.home, `refs/heads/${BRANCH_1}`)).toBe(false);
        expect(releasedBranchFor(s.office, key, BRANCH_1)).toBeNull();
        const row = s.office.get<{ reclaimed_at: number | null }>(
          "select reclaimed_at from released_branches where office_id = $office_id and key = $key",
          { key },
        );
        expect(row?.reclaimed_at).not.toBeNull();
      }, FIXTURE);
    });
  });
}
