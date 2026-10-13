// Crash recovery of the planning lane (DIPO-34; 0007 section 6 step 2, 0010 section 2a step 3):
// an operation journaled before a crash is replayed by the office load step, after `git.version`
// attached the office's git and before any other git queue item; a commit made just before a
// crash is found again by its trailer instead of being applied twice.
// The slower cases run in CI only, in replay.ci.test.ts (DIPO-77).

import { describe, expect, it } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { withBareRemote, withTempRepo } from "@dipsaus-orchestrator/testkit";

import {
  allEntries,
  BacklogLane,
  LANE_NOTICES,
  OP_TRAILER,
  pendingLaneOp,
} from "../../../src/backlog/lane";
import type { BacklogCli } from "../../../src/backlog/runner";
import { buildRegistry, type FeatureModule } from "../../../src/commands/registry";
import { EngineGit } from "../../../src/git";
import type { OfficeLoadContext } from "../../../src/office/steps";
import { systemSpawn } from "../../../src/platform/process";
import { BACKLOG_FIXTURE, laneSetup, notices, publish, storyKey, subjects } from "./helpers";

/** One daemon start: fresh engine git and lane, the office's load steps run in order. */
async function loadOffice(
  ctx: OfficeLoadContext,
  env: Record<string, string>,
  cli: BacklogCli,
  log: string[],
): Promise<BacklogLane> {
  const engineGit = new EngineGit({ spawn: systemSpawn, env });
  const lane = new BacklogLane({
    cli,
    git: (office) => engineGit.forOffice(office),
  });
  // A later load step that queues git work, as the story index (DIPO-32) will.
  const later: FeatureModule = {
    name: "fixture/later",
    register(registry) {
      registry.registerLoadStep("fixture.later", async (step) => {
        await engineGit.forOffice(step.officeId)?.run(async () => {
          log.push("later item");
        });
      });
    },
  };
  const registry = buildRegistry([engineGit.feature, lane.feature, later]);
  for (const step of registry.loadSteps()) {
    const outcome = await step.run(ctx);
    if (outcome !== undefined && !outcome.ok) throw new Error(`${step.name}: ${outcome.reason}`);
  }
  return lane;
}

describe("replaying the journal at office load", () => {
  it("replays an operation journaled before a crash before any other git queue item", async () => {
    await withBareRemote(
      async (repo) => {
        await publish(repo);
        // No `base` configured: the lane follows `origin/HEAD`.
        await repo.git("remote", "set-head", "origin", "main");
        const s = await laneSetup(repo);
        const ctx: OfficeLoadContext = {
          officeId: s.office.officeId as OfficeId,
          office: s.office,
          path: realpathSync(repo.dir),
          commonDir: realpathSync(join(repo.dir, ".git")),
          config: undefined,
          clock: s.t.clock,
          ids: s.t.ids,
        };
        const key = storyKey(s);

        // First start: journal, then crash before the flush.
        const before = await loadOffice(ctx, repo.env, s.cli, s.log);
        const lane = before.forOffice(ctx.officeId);
        if (lane === undefined) throw new Error("lane not attached");
        await lane.journal({ kind: "edit", key, subject: "TASK-1", target: { status: "Refined" } });
        expect(allEntries(s.office)[0]?.state).toBe("pending");
        expect(s.log).toEqual(["later item"]);
        s.log.length = 0;

        // Second start: the load step replays it, and the later item runs only afterwards.
        s.hooks.onCli = () => s.log.push("cli during load");
        await loadOffice(ctx, repo.env, s.cli, s.log);
        const [entry] = allEntries(s.office);
        expect(entry?.state).toBe("pushed");
        const branch = entry?.branch as string;
        expect(await subjects(repo.remote, repo.home, branch, "main")).toEqual([
          "backlog: edit TASK-1",
        ]);
        const later = s.log.indexOf("later item");
        expect(later).toBe(s.log.length - 1);
        expect(s.log.slice(0, later).some((line) => line.startsWith("cli "))).toBe(true);
        expect(pendingLaneOp(s.office, key)).not.toBeNull();
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("puts a failed replay on the office as a notice, and the office still loads", async () => {
    await withBareRemote(
      async (repo) => {
        await publish(repo);
        await repo.git("remote", "set-head", "origin", "main");
        const s = await laneSetup(repo);
        const ctx: OfficeLoadContext = {
          officeId: s.office.officeId as OfficeId,
          office: s.office,
          path: realpathSync(repo.dir),
          commonDir: realpathSync(join(repo.dir, ".git")),
          config: undefined,
          clock: s.t.clock,
          ids: s.t.ids,
        };
        const key = storyKey(s);
        const before = await loadOffice(ctx, repo.env, s.cli, s.log);
        const lane = before.forOffice(ctx.officeId);
        if (lane === undefined) throw new Error("lane not attached");
        await lane.journal({ kind: "edit", key, subject: "TASK-1", target: { status: "Refined" } });
        // Before the restart, something that is not the engine's worktree takes `_backlog`.
        mkdirSync(lane.worktreePath(), { recursive: true });
        writeFileSync(join(lane.worktreePath(), "mine.txt"), "not dipo's\n");
        s.log.length = 0;

        // Every load step ran, the later one included.
        await loadOffice(ctx, repo.env, s.cli, s.log);
        expect(s.log).toEqual(["later item"]);
        expect(allEntries(s.office)[0]?.state).toBe("pending");
        expect(pendingLaneOp(s.office, key)).not.toBeNull();
        const failed = notices(s.office).filter((n) => n.code === LANE_NOTICES.replayFailed);
        expect(failed).toHaveLength(1);
        expect(failed[0]?.level).toBe("error");
        expect(failed[0]?.text).toContain("Replaying the open backlog operations failed");
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("finds a commit made just before a crash by its trailer and does not apply it twice, without a remote", async () => {
    await withTempRepo(
      async (repo) => {
        await publish(repo);
        const s = await laneSetup(repo);
        const key = storyKey(s);
        const { report } = await s.lane().submit({
          kind: "edit",
          key,
          subject: "TASK-1",
          target: { status: "Refined" },
        });
        const branch = report.branch as string;
        const sha = (await repo.git("rev-parse", branch)).trim();
        expect(await repo.git("log", "-1", "--format=%B", branch)).toContain(`${OP_TRAILER}: 1`);

        // The crash came after the commit and before its journal update.
        s.office.immediate(() =>
          s.office.run(
            "update backlog_journal set state = 'applied', commit_sha = null where office_id = $office_id",
          ),
        );
        const replayed = await s.lane().flush();
        expect(replayed.committed).toEqual([]);
        expect(replayed.branch).toBe(branch);
        expect((await repo.git("rev-parse", branch)).trim()).toBe(sha);
        expect(allEntries(s.office).map((e) => [e.state, e.commit])).toEqual([["committed", sha]]);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });
});
