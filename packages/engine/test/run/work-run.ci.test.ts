// CI only (0017): `work.run` end to end on real git with a bare `origin` and the pinned
// Backlog CLI (DIPO-48 test plan). A Ready fixture story goes to In Progress with one claim commit
// pushed, a stored pickup decision and the events `work.assigned` and `work.phase setup`; a story
// with an open unknown edited in by hand fails the re-check and goes back to Refined through the
// planning lane with the R15 message. Two stories with scripted workers run at once on an office
// wired as the daemon wires it (`loop-office.ts`, 0002): both developers work side by side, and both
// stories reach In Review with their own pull request and their own reviewer. Each case needs
// several CLI calls, an office load, a fetch, a claim and a push, well over the local per-test
// budget; the same rules run locally against fakes in work-run.test.ts.

import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type CommandReply,
  type OfficeId,
  RequestId,
  type RunId,
} from "@dipsaus-orchestrator/contract";
import { type TempRepoWithRemote, withBareRemote } from "@dipsaus-orchestrator/testkit";

import { BacklogLane } from "../../src/backlog/lane";
import { cursorAt } from "../../src/changelog/log";
import { replay } from "../../src/changelog/replay";
import { executeCommand } from "../../src/commands/execute";
import type { OfficeHandle } from "../../src/db/office";
import { GateStore } from "../../src/gate-decisions";
import { EngineGit } from "../../src/git";
import { officeStatusesReady } from "../../src/backlog/init";
import { storyRunBase, WorkRun } from "../../src/run";
import { findRun, findStoryPr } from "../../src/records";
import { StoryIndex } from "../../src/stories/feature";
import { hasLiveClaim, StoryClaims } from "../../src/worktree";
import { countRows } from "../commands/helpers";
import { backlog, CLI, publish, writeDeveloperRole } from "../gate/gated-office";
import { BACKLOG_FIXTURE, type OfficeSetup, officeSetup, resultOf, send } from "../office/helpers";
import { backlogStoryStore } from "../../src/backlog/store";
import {
  addTask4,
  devScript,
  type Session,
  TASK_1,
  TASK_4,
  TSV,
  TSV_DONE,
  withLoopOffice,
  writeFile,
} from "../engine/loop-office";

interface Running {
  readonly repo: TempRepoWithRemote;
  readonly workRun: WorkRun;
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
        "--add-label",
        "role:developer",
      ]);
      // The role TASK-1's label names (R17, DIPO-477).
      writeDeveloperRole(repo.dir);
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
        roster: (office: OfficeId) => setup?.manager.roster(office) ?? [],
      };
      const engineGit = new EngineGit({ spawn: CLI(repo).spawn, env: repo.env });
      const index = new StoryIndex({
        git: engineGit,
        stories: backlogStoryStore(CLI(repo)),
        offices,
      });
      const gates = new GateStore({
        git: engineGit,
        stories: backlogStoryStore(CLI(repo)),
        offices,
        index,
        get clock() {
          return loaded().clock;
        },
        get ids() {
          return loaded().ids;
        },
      });
      const claims = new StoryClaims({
        stories: backlogStoryStore(CLI(repo)),
        git: (office) => engineGit.forOffice(office),
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
        base: storyRunBase({
          git: (office) => engineGit.forOffice(office),
          stories: backlogStoryStore(CLI(repo)),
        }),
        stories: index,
        // The fixture has no verify script; the run profile is DIPO-72's, checked locally.
        profiles: { ensureFreshProfile: async () => undefined, verifyResolved: () => null },
        statuses: async (office) => {
          const git = engineGit.forOffice(office);
          if (git === undefined) throw new Error("no git");
          return officeStatusesReady(git);
        },
        startsPaused: () => null,
        claims,
        gates,
        lane: (office) => lane.planning(office),
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
        await fn({ repo, workRun, s, officeId, office: access.office });
      } finally {
        index.stop();
        s.state.close();
      }
    },
    { fixture: BACKLOG_FIXTURE },
  );
}

let count = 0;
/** Sends `work.run` and waits for the starts it decided after its answer (DIPO-456). */
async function workRunCommand(r: Running, stories?: string[]): Promise<CommandReply> {
  count += 1;
  // The base as the background pass keeps it, read again now that the office loaded.
  await r.workRun.refreshBase(r.officeId);
  const reply = await executeCommand(r.s.deps, {
    requestId: RequestId.parse(`01J9ZK5Q8W3V4X6Y7Z${(90_000 + count).toString().padStart(8, "0")}`),
    name: "work.run",
    args: { from: r.repo.dir, ...(stories === undefined ? {} : { stories }) },
    origin: "cli",
    confirmed: false,
    office: r.officeId,
  });
  await r.workRun.settled();
  return reply;
}

function types(r: Running): { type: string; delta: unknown }[] {
  const result = replay(r.office, cursorAt(r.officeId, 0));
  if (!result.ok) throw new Error(result.error.message);
  return result.entries.map(({ type, delta }) => ({ type, delta }));
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("work.run on real git and the Backlog CLI", () => {
    // Each case makes several CLI calls, a fetch, a claim and a push; under a parallel CI load
    // that takes longer than the default 5 s.
    it(
      "claims a Ready story with one claim commit, a stored pickup decision and the run events",
      () =>
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
            const entries = types(r);
            expect(entries.slice(-4).map((entry) => entry.type)).toEqual([
              "work.assigned",
              // The setup phase marker (DIPO-83).
              "work.output",
              "work.phase",
              "story.state",
            ]);
            // The claim commit is read on the branch at once (DIPO-56): the story is In Progress.
            expect(entries.at(-1)?.delta).toMatchObject({ from: "Ready", to: "In Progress" });
          },
        ),
      30_000,
    );

    // DIPO-104: the executor resolves `stories` before the handler fetches, so a story merged to
    // the remote base since the last poll was `story.unknown` until `office rescan`.
    it(
      "runs a story named by id that was merged to the remote base after the office loaded",
      () =>
        withRunOffice(
          async () => undefined,
          async (r) => {
            const tasks = join(r.repo.dir, "backlog", "tasks");
            const text = readFileSync(join(tasks, "task-1 - Add-the-CSV-export-command.md"), "utf8")
              .replace("id: TASK-1", "id: TASK-4")
              .replace("title: Add the CSV export command", "title: Add the JSON import command")
              .replace("TASK-1/add-the-csv-export-command", "TASK-4/add-the-json-import-command");
            writeFileSync(join(tasks, "task-4 - Add-the-JSON-import-command.md"), text);
            await publish(r.repo, "merge TASK-4");
            expect(
              r.office.get<{ n: number }>(
                "select count(*) as n from stories where office_id = $office_id and story_id = 'TASK-4'",
              )?.n,
            ).toBe(0);

            const result = resultOf<{
              started: { story: string }[];
              skipped: { story: string; reason: string }[];
            }>(await workRunCommand(r, ["TASK-4"]));
            expect(result.started.map((s) => s.story)).toEqual(["TASK-4"]);
            expect(result.skipped).toEqual([]);
          },
        ),
      30_000,
    );

    it(
      "returns a story with an open unknown edited in by hand to Refined with the R15 message",
      () =>
        withRunOffice(
          async (repo) => {
            const file = join(
              repo.dir,
              "backlog",
              "tasks",
              "task-1 - Add-the-CSV-export-command.md",
            );
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
        ),
      30_000,
    );

    it(
      "runs two stories with scripted workers at once, each reaching In Review with its own pull request",
      () =>
        withLoopOffice({ prepare: addTask4 }, async (w) => {
          const storyOf = (session: Session) => findRun(w.office, session.runId as RunId)?.story;
          // Every session holds until the scenario lets it go.
          w.director = () => "hold";
          const result = resultOf<{ started: { story: string; run: string }[] }>(
            await w.command("work.run", { from: w.repo.dir, stories: [TASK_1, TASK_4] }),
          );
          expect(result.started.map((started) => started.story)).toEqual([TASK_1, TASK_4]);
          const heldOf = (story: string, kind: Session["kind"]) =>
            [...w.held.values()].find(
              (h) => h.session.kind === kind && storyOf(h.session) === story,
            );
          await w.until(
            "both developers run",
            () =>
              heldOf(TASK_1, "implement") !== undefined &&
              heldOf(TASK_4, "implement") !== undefined,
          );
          const live = () =>
            w.office.all<{ story_id: string; role: string }>(
              `select r.story_id, a.role from agents a join runs r
                on r.office_id = a.office_id and r.run_id = a.run_id
                where a.office_id = $office_id and a.ended_at is null order by r.story_id`,
            );
          expect(live()).toEqual([
            { story_id: TASK_1, role: "developer" },
            { story_id: TASK_4, role: "developer" },
          ]);

          // Both developers finish; each story gets its own PR and its own reviewer at once.
          const first = heldOf(TASK_1, "implement")?.session;
          const second = heldOf(TASK_4, "implement")?.session;
          if (first === undefined || second === undefined) throw new Error("no developers held");
          writeFile(first, "packages/export/csv.ts", "export const csv = 1;\n");
          writeFile(second, TSV, "export const tsv = 1;\n");
          w.release(first.agentId, devScript(first.n).slice(1));
          w.release(second.agentId, devScript(second.n, TSV_DONE).slice(1));
          const runs = result.started.map((started) => started.run as RunId);
          await w.until("both pull requests", () =>
            runs.every((run) => findStoryPr(w.office, run) !== null),
          );
          await w.until(
            "both reviews run",
            () => heldOf(TASK_1, "review") !== undefined && heldOf(TASK_4, "review") !== undefined,
          );
          const prs = runs.map((run) => findStoryPr(w.office, run)?.number);
          expect(new Set(prs).size).toBe(2);
          expect(live()).toEqual([
            { story_id: TASK_1, role: "reviewer" },
            { story_id: TASK_4, role: "reviewer" },
          ]);
        }),
      300_000,
    );
  });
}
