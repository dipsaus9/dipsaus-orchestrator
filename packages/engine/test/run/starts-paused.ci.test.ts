// CI only (0017 section 1): a plan limit on real git with the pinned Backlog CLI and DIPO-44's
// worker host in this process (DIPO-359 test plan, 0020). `work.run` claims TASK-1 and its first
// host replays `plan-limit-rejected`: the office's starts pause until two minutes after the reset,
// the story parks `worker-failed` with the detail "plan limit until <reset>" on its branch, and a
// new run is refused. When the pause lifts, dipo resumes that park through the one resume path: the
// park is lifted on the branch and a second host of the same run starts (replaying
// `success-single`) with the park's detail as its first message. The lift timer itself runs on the
// manual clock in starts-paused.test.ts; here the lift is called as the timer calls it, since the
// recording's reset lies months after the test clock. Each case needs a claim, an office load and
// several CLI calls, well over the local per-test budget.

import { describe, expect, it } from "bun:test";

import { type CommandReply, RequestId, type RunId } from "@dipsaus-orchestrator/contract";

import { executeCommand } from "../../src/commands/execute";
import { createSystemIds } from "../../src/platform/ids";
import { PLAN_LIMIT_RESUME_AFTER_MS, type StartsPaused } from "../../src/run";
import { findRun } from "../../src/records";
import { resultOf } from "../office/helpers";
import { type Running, withRunOffice } from "./run-office";

let count = 0;
function requestId(): RequestId {
  count += 1;
  return RequestId.parse(`01J9ZK5Q8W3V4X6Y7Z${(90_000 + count).toString().padStart(8, "0")}`);
}

function command(r: Running, name: string, args: Record<string, unknown>): Promise<CommandReply> {
  return executeCommand(
    { ...r.s.deps, ids: createSystemIds(r.s.clock) },
    { requestId: requestId(), name, args, origin: "cli", confirmed: true, office: r.officeId },
  );
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("a plan limit on the run path (0020)", () => {
    it(
      "pauses the office's starts, parks worker-failed, and resumes that park when the pause lifts",
      () =>
        withRunOffice(
          {
            host: "replay",
            recordings: ["plan-limit-rejected", "success-single"],
            checks: { ok: true },
            control: {},
            outcomes: true,
            startsPaused: true,
            resumeParks: true,
          },
          async (r) => {
            const started = resultOf<{ started: { story: string; run: string }[] }>(
              await command(r, "work.run", { from: r.repo.dir }),
            );
            const run = started.started[0]?.run as RunId;
            await r.control?.idle();
            const paused = r.startsPaused as StartsPaused;
            const reset = new Date(1_791_827_400 * 1000).toISOString();

            // Paused, with its reason and time; the story parked worker-failed to resume on lift.
            expect(paused.state(r.officeId)).toMatchObject({
              reason: "plan-limit",
              detail: `plan limit until ${reset}`,
              until: Date.parse(reset) + PLAN_LIMIT_RESUME_AFTER_MS,
            });
            const parks = () =>
              r.office.all<{ reason: string; detail: string; resume_on_lift: number }>(
                `select reason, detail, resume_on_lift from parks where office_id = $office_id
                  and resolved_at is null`,
              );
            expect(parks()).toEqual([
              { reason: "worker-failed", detail: `plan limit until ${reset}`, resume_on_lift: 1 },
            ]);
            expect(findRun(r.office, run)?.ending).toBe("parked");

            // No new session starts while it holds: work.run is refused, named or not.
            const refused = await command(r, "work.run", { from: r.repo.dir });
            expect(refused.ok).toBe(false);
            if (!refused.ok) expect(refused.error.details).toMatchObject({ check: "plan-limit" });

            // The lift: the park resumes through the one resume path, a second host of the run.
            paused.lift(r.officeId, "the plan limit's reset time passed");
            await paused.idle();
            await r.resumption?.idle();
            await r.control?.idle();
            expect(paused.state(r.officeId)).toBeNull();
            expect(parks()).toEqual([]);
            expect(r.hosts.map((host) => host.runId)).toEqual([run, run]);
            expect(r.hosts[1]?.plan.stdin.join("")).toContain(`plan limit until ${reset}`);
          },
        ),
      60_000,
    );
  });
}
