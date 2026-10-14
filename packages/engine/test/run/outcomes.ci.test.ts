// CI only (0017 section 1): a crashed worker's next session on real git with the pinned Backlog
// CLI and DIPO-44's worker host in this process (DIPO-51 test plan). `work.run` claims TASK-1 and
// its first host replays `terminated` (exit 143 with no intent). Run control and worker outcomes
// decide the crash; the real resumer finds no transcript to resume, builds the handoff on the
// worktree and starts a second `WorkerHost` of the same run, which replays `success-single` into
// the same `events.ndjson`. The second host's ingestion starts at the file size before it started,
// so nothing of the first process is ingested twice. Each case needs a claim, an office load and
// several CLI calls, well over the local per-test budget; the decisions run locally against fakes
// in outcomes.test.ts.

import { describe, expect, it } from "bun:test";

import { type CommandReply, RequestId } from "@dipsaus-orchestrator/contract";

import { executeCommand } from "../../src/commands/execute";
import { createSystemIds } from "../../src/platform/ids";
import { findRun, runIntents } from "../../src/run";
import { resultOf } from "../office/helpers";
import { type Running, withRunOffice } from "./run-office";

let count = 0;
function requestId(): RequestId {
  count += 1;
  return RequestId.parse(`01J9ZK5Q8W3V4X6Y7Z${(70_000 + count).toString().padStart(8, "0")}`);
}

function command(r: Running, name: string, args: Record<string, unknown>): Promise<CommandReply> {
  return executeCommand(
    { ...r.s.deps, ids: createSystemIds(r.s.clock) },
    { requestId: requestId(), name, args, origin: "cli", confirmed: true, office: r.officeId },
  );
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("a crashed worker's next session", () => {
    it(
      "starts a second host of the run that ingests only its own lines",
      () =>
        withRunOffice(
          {
            host: "replay",
            recordings: ["terminated", "success-single"],
            checks: { ok: true },
            control: {},
            outcomes: true,
          },
          async (r) => {
            const result = resultOf<{ started: { story: string; run: string }[] }>(
              await command(r, "work.run", { from: r.repo.dir }),
            );
            const run = result.started[0]?.run as string;
            await r.control?.idle();

            // Two hosts of the same run; the second is a new session with a handoff, not a resume
            // (no transcript), so its plan names a new --session-id.
            expect(r.hosts.map((host) => host.runId)).toEqual([run, run]);
            const [first, second] = r.hosts;
            expect(second?.agentId).not.toBe(first?.agentId);
            expect(second?.plan.argv).toContain("--session-id");
            expect(second?.plan.argv).not.toContain("--resume");
            expect(second?.plan.stdin.join("")).toContain("<handoff>");

            // The second host's ingestion started at the file size before it started.
            expect(first?.sizeBefore).toBe(0);
            expect(second?.sizeBefore).toBeGreaterThan(0);
            expect(r.starts).toEqual([
              { agent: second?.agentId as string, processedOffset: second?.sizeBefore as number },
            ]);

            // Nothing ingested twice: the second agent holds only the second recording's message.
            const messages = (agent: string) =>
              r.office
                .all<{ message_id: string }>(
                  `select message_id from usage_messages where office_id = $office_id
                  and agent_id = $agent order by message_id`,
                  { agent },
                )
                .map((row) => row.message_id);
            expect(messages(second?.agentId as string)).toEqual(["msg-1"]);
            expect(messages(first?.agentId as string).length).toBeGreaterThan(1);
            const agents = r.office.all<{ agent_id: string; end_reason: string | null }>(
              `select agent_id, end_reason from agents where office_id = $office_id and run_id = $run
              order by started_at, rowid`,
              { run },
            );
            expect(agents.map((agent) => agent.end_reason)).toEqual(["crashed", "exited"]);

            // The run goes on: no park, no intent, still active with its claim.
            expect(r.office.all("select reason from parks where office_id = $office_id")).toEqual(
              [],
            );
            expect(runIntents(r.office, run as never)).toEqual([]);
            expect(findRun(r.office, run as never)?.endedAt).toBeNull();
            const codes = r.office
              .all<{ delta: string }>(
                "select delta from change_log where office_id = $office_id and type = 'engine.notice'",
              )
              .map((row) => (JSON.parse(row.delta) as { code: string }).code);
            expect(codes).toContain("run.handoff");
          },
        ),
      60_000,
    );
  });
}
