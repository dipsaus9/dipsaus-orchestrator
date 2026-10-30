// CI only (0017): parks on real git with a bare `origin` and the pinned Backlog CLI
// (DIPO-50 test plan). Each case claims TASK-1 with `work.run`, then:
// - replays `budget-engine-cap` through FakeProcess with the tier budget from its meta: run control
//   stops the worker and parks `budget-exceeded` naming the token cap, with one park commit
//   `TASK-1: status Parked` holding the F16 block, pushed to `origin`;
// - with no worker events, `story.park` parks `by-maintainer` the same way, the branch kept.
// A story has no worktree (DIPO-349): the park commit is read from the branch ref.
// Each case needs several CLI calls, an office load, a fetch, a claim and a push, well over the
// local per-test budget; the same rules run locally against fakes in control.test.ts.

import { describe, expect, it } from "bun:test";
import { type CommandReply, RequestId } from "@dipsaus-orchestrator/contract";

import { executeCommand } from "../../src/commands/execute";
import { createSystemIds } from "../../src/platform/ids";
import { runIntents } from "../../src/records";
import { openPark } from "../../src/run/park";
import { resultOf } from "../office/helpers";
import { loadRecording } from "../workers/replay";
import { BRANCH, type Running, withRunOffice } from "./run-office";
import { backlogLayout } from "../story-store/backlog";

let count = 0;
function requestId(): RequestId {
  count += 1;
  return RequestId.parse(`01J9ZK5Q8W3V4X6Y7Z${(80_000 + count).toString().padStart(8, "0")}`);
}

function command(r: Running, name: string, args: Record<string, unknown>): Promise<CommandReply> {
  return executeCommand(
    { ...r.s.deps, ids: createSystemIds(r.s.clock) },
    { requestId: requestId(), name, args, origin: "cli", confirmed: true, office: r.officeId },
  );
}

async function startRun(r: Running): Promise<string> {
  const result = resultOf<{ started: { story: string; run: string }[] }>(
    await command(r, "work.run", { from: r.repo.dir }),
  );
  expect(result.started.map((s) => s.story)).toEqual(["TASK-1"]);
  return result.started[0]?.run as string;
}

/** TASK-1's task file as committed at the tip of the story branch. */
async function taskOnBranch(r: Running): Promise<string> {
  const listed = await r.repo.git("ls-tree", "--name-only", `${BRANCH}:backlog/tasks`);
  const name = listed.split("\n").find((file) => file.startsWith("task-1 "));
  if (name === undefined) throw new Error(`no task file of TASK-1 on ${BRANCH}`);
  return r.repo.git("show", `${BRANCH}:backlog/tasks/${name}`);
}

function parks(r: Running): { reason: string; detail: string }[] {
  return r.office.all("select reason, detail from parks where office_id = $office_id");
}

/** The engine's current park of TASK-1: Backlog.md's reason and origin (DIPO-360). */
function currentPark(r: Running): ReturnType<typeof openPark> {
  const key = r.office.get<{ key: string }>(
    "select key from stories where office_id = $office_id and story_id = 'TASK-1'",
  )?.key;
  return key === undefined ? null : openPark(backlogLayout, r.office, key);
}

async function tip(r: Running, ref: string): Promise<string> {
  return (await r.repo.git("rev-parse", ref)).trim();
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("parks on real git and the Backlog CLI", () => {
    it("budget-engine-cap: stops the worker and parks budget-exceeded with one pushed park commit", () => {
      const budget = loadRecording("budget-engine-cap").meta.testConfig?.["budgetTokens"] as number;
      return withRunOffice(
        {
          host: "replay",
          recording: "budget-engine-cap",
          checks: { ok: true },
          control: { caps: { budgetTokens: budget } },
        },
        async (r) => {
          const run = await startRun(r);
          await r.control?.idle();
          expect(parks(r).map((p) => p.reason)).toEqual(["budget-exceeded"]);
          // The current reason and origin are the task file's, as the engine reads them.
          expect(currentPark(r)).toMatchObject({ reason: "budget-exceeded", from: "In Progress" });
          expect(parks(r)[0]?.detail).toContain("token budget reached");
          // One park commit on top of the claim commit, on the branch and on origin.
          expect((await r.repo.git("log", "--format=%s", "-n", "2", BRANCH)).trim()).toBe(
            "TASK-1: status Parked\nTASK-1: status In Progress",
          );
          const remote = await r.repo.git("ls-remote", "--heads", "origin", BRANCH);
          expect(remote.split("\t")[0]).toBe(await tip(r, BRANCH));
          const changed = await r.repo.git("diff", "--name-only", `${BRANCH}~1`, BRANCH);
          expect(changed.trim().split("\n")).toHaveLength(1);
          expect(changed).toContain("backlog/tasks/");
          const view = await taskOnBranch(r);
          expect(view).toMatch(/^status: Parked$/m);
          expect(view).toContain('reason: "budget-exceeded"');
          expect(view).toContain('from: "In Progress"');
          expect(r.sent[0]?.length).toBe(4);
          expect(runIntents(r.office, run as never).map((i) => i.kind)).toEqual(["cap"]);
        },
      );
    }, 30_000);

    it(
      "story.park parks by-maintainer with the note, keeping the branch",
      () =>
        withRunOffice({ host: "stub", checks: { ok: true }, control: {} }, async (r) => {
          await startRun(r);
          const reply = await command(r, "story.park", { story: "TASK-1", note: "Not now." });
          if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`);
          expect(parks(r).map((p) => [p.reason, p.detail])).toEqual([
            ["by-maintainer", "Not now."],
          ]);
          expect((await r.repo.git("log", "--format=%s", "-n", "1", BRANCH)).trim()).toBe(
            "TASK-1: status Parked",
          );
          expect(await taskOnBranch(r)).toContain('reason: "by-maintainer"');
          // A second park finds the story parked already.
          const again = await command(r, "story.park", { story: "TASK-1", note: "Again." });
          expect(again).toMatchObject({ ok: true, changed: false });
        }),
      30_000,
    );
  });
}
