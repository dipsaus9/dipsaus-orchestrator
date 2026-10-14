// CI only (0017 section 1): `work.run` end to end on real git with a bare `origin` and the pinned
// Backlog CLI (DIPO-48 test plan). A Ready fixture story goes to In Progress with one claim commit
// pushed, a stored pickup decision and the events `work.assigned` and `work.phase setup`; a story
// with an open unknown edited in by hand fails the re-check and goes back to Refined through the
// planning lane with the R15 message. Each case needs several CLI calls, an office load, a fetch,
// a claim and a push, well over the local per-test budget; the same rules run locally against
// fakes in work-run.test.ts.

import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type CommandReply, type OfficeId, RequestId } from "@dipsaus-orchestrator/contract";
import { type TempRepoWithRemote, withBareRemote } from "@dipsaus-orchestrator/testkit";

import { BacklogLane } from "../../src/backlog/lane";
import { cursorAt, readLogState } from "../../src/changelog/log";
import { replay } from "../../src/changelog/replay";
import { executeCommand } from "../../src/commands/execute";
import type { OfficeHandle } from "../../src/db/office";
import { GateStore } from "../../src/gate";
import { EngineGit } from "../../src/git";
import { officeStatusesReady } from "../../src/office/init";
import { cliRunBase, findRun, WorkRun } from "../../src/run";
import { StoryIndex } from "../../src/stories/feature";
import { hasLiveClaim, StoryClaims } from "../../src/worktree";
import { countRows } from "../commands/helpers";
import { backlog, CLI, publish } from "../gate/gated-office";
import { BACKLOG_FIXTURE, type OfficeSetup, officeSetup, resultOf, send } from "../office/helpers";
import { ROOMY } from "../worktree/helpers";

interface Running {
  readonly repo: TempRepoWithRemote;
  readonly s: OfficeSetup;
  readonly officeId: OfficeId;
  readonly office: OfficeHandle;
}

/** The fixture on a bare `origin` with TASK-1 made to pass the Ready gate. */
async function withRunOffice(
  prepare: (repo: TempRepoWithRemote) => Promise<void>,
  fn: (r: Running) => Promise<void>,
): Promise<void> {
  await withBareRemote(
    async (repo) => {
      mkdirSync(join(repo.dir, "backlog", "archive", "tasks"), { recursive: true });
      await repo.commitAll("fixture");
      await repo.git("push", "--quiet", "-u", "origin", "main");
      await repo.git("remote", "set-head", "origin", "main");
      await backlog(repo, ["milestone", "add", "M0 Walking skeleton"]);
      await backlog(repo, [
        "task",
        "edit",
        "TASK-1",
        "--type",
        "feature",
        "-m",
        "m-0",
        "--ref",
        "packages/export/",
      ]);
      await prepare(repo);
      await publish(repo, "make TASK-1 pass the gate");

      let setup: OfficeSetup | undefined;
      const loaded = (): OfficeSetup => {
        if (setup === undefined) throw new Error("the office setup is not built yet");
        return setup;
      };
      const offices = {
        get: (office: OfficeId) => setup?.manager.get(office),
        config: (office: OfficeId) => setup?.manager.config(office),
      };
      const engineGit = new EngineGit({ spawn: CLI(repo).spawn, env: repo.env });
      const index = new StoryIndex({ git: engineGit, cli: CLI(repo), offices });
      const gates = new GateStore({
        git: engineGit,
        cli: CLI(repo),
        offices,
        get clock() {
          return loaded().clock;
        },
        get ids() {
          return loaded().ids;
        },
      });
      const claims = new StoryClaims({
        cli: CLI(repo),
        git: (office) => engineGit.forOffice(office),
        disk: ROOMY,
      });
      const lane = new BacklogLane({
        cli: CLI(repo),
        git: (office) => engineGit.forOffice(office),
        liveClaim: hasLiveClaim,
      });
      const workRun = new WorkRun({
        offices: {
          get: (office) => loaded().manager.get(office),
          config: (office) => loaded().manager.config(office),
          configHash: (office) => loaded().manager.configHash(office),
          configBlocksRuns: (office) => loaded().manager.configBlocksRuns(office),
        },
        base: cliRunBase({ git: (office) => engineGit.forOffice(office), cli: CLI(repo) }),
        stories: index,
        // The fixture has no verify script; the run profile is DIPO-72's, checked locally.
        profiles: { ensureFreshProfile: async () => undefined, verifyResolved: () => null },
        statuses: async (office) => {
          const git = engineGit.forOffice(office);
          if (git === undefined) throw new Error("no git");
          return officeStatusesReady(git);
        },
        adapterHeld: () => null,
        claims,
        gates,
        lane: (office) => lane.forOffice(office),
      });
      const s = await officeSetup(repo.root, {
        features: [
          engineGit.feature,
          claims.feature,
          lane.feature,
          index.feature,
          gates.feature,
          workRun.feature,
        ],
      });
      setup = s;
      try {
        const { office: officeId } = resultOf<{ office: OfficeId }>(
          await send(s, "office.open", { path: repo.dir }),
        );
        const access = await s.manager.load(officeId);
        if (!access.ok) throw new Error(`${access.error.code}: ${access.error.message}`);
        await fn({ repo, s, officeId, office: access.office });
      } finally {
        index.stop();
        s.state.close();
      }
    },
    { fixture: BACKLOG_FIXTURE },
  );
}

let count = 0;
function workRunCommand(r: Running): Promise<CommandReply> {
  count += 1;
  return executeCommand(r.s.deps, {
    requestId: RequestId.parse(`01J9ZK5Q8W3V4X6Y7Z${(90_000 + count).toString().padStart(8, "0")}`),
    name: "work.run",
    args: { from: r.repo.dir },
    origin: "cli",
    confirmed: false,
    office: r.officeId,
  });
}

function types(r: Running): { type: string; delta: unknown }[] {
  const { epoch } = readLogState(r.office);
  const result = replay(r.office, cursorAt(r.officeId, epoch, 0));
  if (!result.ok) throw new Error(result.error.message);
  return result.entries.map(({ type, delta }) => ({ type, delta }));
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("work.run on real git and the Backlog CLI", () => {
    it("claims a Ready story with one claim commit, a stored pickup decision and the run events", () =>
      withRunOffice(
        async () => undefined,
        async (r) => {
          const reply = await workRunCommand(r);
          const result = resultOf<{
            started: { story: string; run: string }[];
            skipped: { story: string; reason: string }[];
          }>(reply);
          expect(result.started.map((s) => s.story)).toEqual(["TASK-1"]);
          expect(result.skipped).toEqual([]);

          const branch = "TASK-1/add-the-csv-export-command";
          const log = await r.repo.git("log", "--format=%s", `origin/${branch}`, "-n", "2");
          expect(log.trim().split("\n")[0]).toBe("TASK-1: status In Progress");
          const main = await r.repo.git("rev-parse", "origin/main");
          const parent = await r.repo.git("rev-parse", `origin/${branch}~1`);
          expect(parent.trim()).toBe(main.trim());

          const decisions = r.office.all<{ decision: string }>(
            "select decision from gate_decisions where office_id = $office_id",
          );
          expect(decisions).toEqual([{ decision: "approved" }]);
          const run = findRun(r.office, result.started[0]?.run as never);
          expect(run).toMatchObject({ kind: "story", story: "TASK-1", branch, tier: "S" });
          const events = types(r).map((entry) => entry.type);
          expect(events.slice(-2)).toEqual(["work.assigned", "work.phase"]);
        },
      ));

    it("returns a story with an open unknown edited in by hand to Refined with the R15 message", () =>
      withRunOffice(
        async (repo) => {
          const file = join(repo.dir, "backlog", "tasks", "task-1 - Add-the-CSV-export-command.md");
          const text = readFileSync(file, "utf8").replace(
            "unknowns: []",
            'unknowns:\n  - q: "Which delimiter?"\n    status: "open"',
          );
          writeFileSync(file, text);
        },
        async (r) => {
          const result = resultOf<{ started: unknown[]; skipped: { reason: string }[] }>(
            await workRunCommand(r),
          );
          expect(result.started).toEqual([]);
          expect(result.skipped.map((s) => s.reason)).toEqual(["pickupCheckFailed"]);
          expect(countRows(r.office, "claims")).toBe(0);
          const state = types(r).find(
            (entry) =>
              entry.type === "story.state" &&
              (entry.delta as { to?: string }).to === "Refined" &&
              (entry.delta as { from?: string }).from === "Ready",
          );
          expect(state?.delta).toMatchObject({ story: "TASK-1", from: "Ready", to: "Refined" });
          const detail = (state?.delta as { detail?: string[] } | undefined)?.detail ?? [];
          expect(detail.some((line) => line.startsWith("ready TASK-1 failed R15:"))).toBe(true);
          // The move is journaled and committed on a backlog branch for the backlog PR.
          expect(
            r.office.get<{ n: number }>(
              "select count(*) as n from backlog_journal where office_id = $office_id and op_kind = 'edit'",
            )?.n,
          ).toBe(1);
        },
      ));
  });
}
