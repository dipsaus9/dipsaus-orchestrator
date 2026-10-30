// CI only (0017 section 1, DIPO-225): real git repositories and processes, too slow for the local
// run.
// A gate read that brings a stale mirror up to date goes through the stories index (DIPO-201): the
// index records the pass, logs its warnings and tells the clients; its next poll at the same base
// commit runs no pass; and the claim re-check does the same in its own git session.

import { describe, expect, it } from "bun:test";

import { RunId, type StoryKey } from "@dipsaus-orchestrator/contract";

import { GateStore } from "../../src/gate-decisions";
import { insertRun } from "../../src/records/run-records";
import { insertClaim } from "../../src/worktree/records";
import { systemSpawn } from "../../src/platform/process";
import { backlog, CLI, key, read, withGatedOffice, type Gated } from "./gated-office";
import { backlogStoryStore } from "../../src/backlog/store";

/** Moves `_base` on with a commit the mirror has not read. */
async function moveBase({ repo, engineGit, officeId }: Gated): Promise<void> {
  await backlog(repo, ["task", "edit", "TASK-1", "-t", "A new title"]);
  await repo.commitAll("rename a story");
  await repo.git("push", "--quiet", "origin", "main");
  await engineGit.forOffice(officeId)?.fetch();
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("the gate read and the stories index", () => {
    it("tells the clients once, records the pass and leaves the next poll nothing to read", () =>
      withGatedOffice(async (o) => {
        const { s, index, officeId, changed } = o;
        await moveBase(o);
        const baseline = changed.length;
        const before = index.lastPass(officeId);
        const reply = await read(s, { office: officeId, story: "TASK-2" });
        expect(reply.ok).toBe(true);

        const pass = index.lastPass(officeId);
        expect(pass).not.toBe(before);
        expect(pass?.cursor).toBeDefined();
        expect(changed.length).toBe(baseline + 1);
        expect(changed.at(-1)).toBe(officeId);

        // A poll at the same base commit finds the index current: no pass, no notice.
        await index.refresh(officeId);
        expect(index.lastPass(officeId)).toBe(pass);
        expect(changed.length).toBe(baseline + 1);
      }));

    it("logs a branch-unread warning of the gate's pass as the index's own pass does", () =>
      withGatedOffice(async (o) => {
        const { s, officeId, office, warnings } = o;
        const storyKey: StoryKey = key(office, "TASK-1");
        const run = RunId.parse(s.ids.next("run"));
        const branch = "TASK-1/no-such-branch";
        const sha = "d".repeat(40);
        office.immediate(() => {
          insertRun(office, {
            runId: run,
            kind: "story",
            key: storyKey,
            story: "TASK-1",
            tier: "M",
            role: "developer",
            model: "haiku",
            startSha: sha,
            branch,
            budgetUnit: "tokens",
            budgetLimit: 1,
            loopCap: 3,
            reviewRoundCap: null,
            configHash: "h",
            overrideKeys: null,
            runProfileId: null,
            startedAt: s.clock.now(),
          });
          insertClaim(office, {
            runId: run,
            key: storyKey,
            story: "TASK-1",
            branch,
            base: "main",
            baseSha: sha,
            startSha: sha,
            claimSha: sha,
            reused: false,
            claimedAt: s.clock.now(),
          });
        });
        await moveBase(o);
        const reply = await read(s, { office: officeId, story: "TASK-2" });
        expect(reply.ok).toBe(true);
        expect(warnings.map((w) => w.message)).toContain(
          "a claimed story was read on the base, not its branch",
        );
        expect(warnings.at(-1)?.fields).toMatchObject({
          office: officeId,
          story: "TASK-1",
          branch,
        });
      }));

    it("the claim re-check with a stale mirror runs one index pass in its session and views no task", () =>
      withGatedOffice(async (o) => {
        const { s, index, engineGit, officeId, office, repo, changed } = o;
        await moveBase(o);
        const views: string[][] = [];
        const gates = new GateStore({
          git: engineGit,
          index,
          offices: { get: (id) => s.manager.get(id), config: (id) => s.manager.config(id) },
          clock: s.clock,
          ids: s.ids,
          stories: backlogStoryStore({
            ...CLI(repo),
            spawn: (options) => {
              if (options.cmd.includes("view")) views.push([...options.cmd]);
              return systemSpawn(options);
            },
          }),
        });
        const git = engineGit.forOffice(officeId);
        if (git === undefined) throw new Error("the office has no git");
        const base = await git.ensureBaseWorktree();
        const baseline = changed.length;
        const before = index.lastPass(officeId);
        // The claim's queue item hands its session to the re-check.
        const decision = await git.run((session) =>
          gates.recordGateDecision(
            officeId,
            key(office, "TASK-2"),
            "pickup",
            { path: base.path, base: "main" },
            session,
          ),
        );
        expect(decision.result.passed).toBe(false);
        expect(index.lastPass(officeId)).not.toBe(before);
        expect(changed.length).toBe(baseline + 1);
        // Only the story itself is viewed, not every task of the backlog.
        expect(views.length).toBe(1);
      }));
  });
}
