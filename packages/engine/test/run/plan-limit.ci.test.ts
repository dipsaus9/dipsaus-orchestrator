// CI only (0017 section 1): a run held by a plan limit on real git with the pinned Backlog CLI and
// DIPO-44's worker host in this process (DIPO-61 test plan). `work.run` claims TASK-1 and its first
// host replays `plan-limit-rejected`: the run is held with its claim, a new run is refused, and a
// restart reads the wait back. The resume after the reset goes through the real resumer, which
// starts a second host of the same run (replaying `success-single`) with "continue" and clears the
// `plan-limit` signal in the transaction that records the new agent. The timers themselves run on
// the manual clock in plan-limit.test.ts; here the resume is called as the timer calls it, since
// the recording's reset lies months after the test clock. Each case needs a claim, an office load
// and several CLI calls, well over the local per-test budget.

import { describe, expect, it } from "bun:test";

import { type CommandReply, RequestId, type RunId } from "@dipsaus-orchestrator/contract";

import { executeCommand } from "../../src/commands/execute";
import { createSystemIds } from "../../src/platform/ids";
import { findRun, openWait, PlanLimits } from "../../src/run";
import { workView } from "../../src/views/work";
import { resultOf } from "../office/helpers";
import { type Running, withRunOffice } from "./run-office";

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

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("a run held by a plan limit", () => {
    it(
      "is held with its claim, survives a restart and resumes with continue after the reset",
      () =>
        withRunOffice(
          {
            host: "replay",
            recordings: ["plan-limit-rejected", "success-single"],
            checks: { ok: true },
            control: {},
            outcomes: true,
            planLimits: true,
          },
          async (r) => {
            const started = resultOf<{ started: { story: string; run: string }[] }>(
              await command(r, "work.run", { from: r.repo.dir }),
            );
            const run = started.started[0]?.run as RunId;
            await r.control?.idle();
            const plans = r.planLimits as PlanLimits;

            // Held: the wait fact, health limited, no park, the claim kept, new runs refused.
            expect(openWait(r.office, run)?.scope).toBe("session");
            expect(workView(r.office, run)?.health).toBe("limited");
            expect(findRun(r.office, run)?.endedAt).toBeNull();
            expect(plans.held("claude-cli", null)).toContain("the session limit");

            // A restart: a new schedule reads the wait back from the database.
            plans.close();
            const again = new PlanLimits({
              clock: r.s.clock,
              offices: { get: () => r.office, config: (office) => r.s.manager.config(office) },
              resume: (office, id, why) =>
                r.outcomes?.resumeWait(office, id, why) ?? Promise.resolve("notHeld"),
            });
            expect(again.held("claude-cli", null)).toBeNull();
            expect(again.recover(r.officeId, r.office)).toBe(1);
            expect(again.held("claude-cli", null)).not.toBeNull();
            again.close();

            // The reset: the session continues in a second host of the same run.
            expect(await r.outcomes?.resumeWait(r.officeId, run, "the plan limit reset")).toBe(
              "started",
            );
            await r.control?.idle();
            expect(r.hosts.map((host) => host.runId)).toEqual([run, run]);
            const second = r.hosts[1];
            expect(second?.plan.stdin.join("")).toContain("continue");

            // The signal ended with the new session, with its work.observed.
            expect(openWait(r.office, run)).toBeNull();
            const signals = r.office.all<{ cleared_at: number | null }>(
              `select cleared_at from run_signals
                where office_id = $office_id and run_id = $run and signal = 'plan-limit'`,
              { run },
            );
            expect(signals.map((row) => row.cleared_at === null)).toEqual([false]);
            const observed = r.office
              .all<{ delta: string }>(
                "select delta from change_log where office_id = $office_id and type = 'work.observed'",
              )
              .map((row) => JSON.parse(row.delta) as { signal: string; clearedAt?: string });
            expect(observed.map((o) => [o.signal, o.clearedAt !== undefined])).toEqual([
              ["plan-limit", false],
              ["plan-limit", true],
            ]);
            expect(r.office.all("select reason from parks where office_id = $office_id")).toEqual(
              [],
            );
          },
        ),
      60_000,
    );
  });
}
