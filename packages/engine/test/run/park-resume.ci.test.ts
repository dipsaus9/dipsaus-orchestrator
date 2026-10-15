// CI only (0017 section 1): a `needs-permission` park answered with `work.answer` on real git with
// the pinned Backlog CLI and DIPO-44's worker host in this process (DIPO-75). `work.run` claims
// TASK-1 and its first host replays the `needs-permission` recording (a STAND-IN until the live
// capture, see `../hooks/needs-permission.ts`): the story parks with the park's permission
// question. The maintainer's allow goes through the permission wait to the real
// `RunOutcomes.resumePark`: the park is lifted on the story branch, the same run is active again
// and its next session starts in a second host (replaying `success-single`) with the allow
// message. Each case needs a claim, an office load and several CLI calls, well over the local
// per-test budget.

import { describe, expect, it } from "bun:test";

import { type CommandReply, RequestId, type RunId } from "@dipsaus-orchestrator/contract";

import { executeCommand } from "../../src/commands/execute";
import { buildRegistry } from "../../src/commands/registry";
import { PermissionAsks } from "../../src/hooks/permissions";
import { findQuestion, openQuestions } from "../../src/hooks/questions";
import { createSystemIds } from "../../src/platform/ids";
import { findRun, openPark } from "../../src/run";
import { encode } from "../../src/workers/claude-cli/encode";
import { needsPermissionRecording, reportedPermission, STAND_IN } from "../hooks/needs-permission";
import { resultOf } from "../office/helpers";
import { type Running, withRunOffice } from "./run-office";

const RECORDING = needsPermissionRecording();
const PERMISSION = reportedPermission(RECORDING);

let count = 0;
function requestId(): RequestId {
  count += 1;
  return RequestId.parse(`01J9ZK5Q8W3V4X6Y7Z${(85_000 + count).toString().padStart(8, "0")}`);
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe(`a needs-permission park answered with allow once${STAND_IN ? " (STAND-IN recording)" : ""}`, () => {
    it(
      "parks with the question, lifts the park on the branch and resumes the same run",
      () =>
        withRunOffice(
          {
            host: "replay",
            recordings: [RECORDING, "success-single"],
            checks: { ok: true },
            control: {},
            outcomes: true,
            resumeParks: true,
          },
          async (r: Running) => {
            const ids = createSystemIds(r.s.clock);
            const started = resultOf<{ started: { story: string; run: string }[] }>(
              await executeCommand(
                { ...r.s.deps, ids },
                {
                  requestId: requestId(),
                  name: "work.run",
                  args: { from: r.repo.dir },
                  origin: "cli",
                  confirmed: true,
                  office: r.officeId,
                },
              ),
            );
            const run = started.started[0]?.run as RunId;
            await r.control?.idle();

            // Parked needs-permission with the park's question; the run ended, the claim stays.
            const parked = openPark(r.office, findRun(r.office, run)?.key ?? "");
            expect(parked?.reason).toBe("needs-permission");
            expect(parked?.detail).toBe(`${PERMISSION.tool}: ${PERMISSION.action}`);
            expect(findRun(r.office, run)?.endedAt).not.toBeNull();
            const [question] = openQuestions(r.office);
            expect(question).toMatchObject({
              tool: PERMISSION.tool,
              input: PERMISSION.action,
              parkId: parked?.parkId,
            });
            const worktree = findRun(r.office, run)?.worktree ?? "";
            const subject = async () =>
              (await r.repo.git("-C", worktree, "log", "-1", "--format=%s")).trim();
            expect(await subject()).toBe("TASK-1: status Parked");

            const asks = new PermissionAsks({
              clock: r.s.clock,
              ids,
              offices: {
                get: (office) => r.s.manager.get(office),
                config: (office) => r.s.manager.config(office),
              },
              steering: { send: async () => ({ ok: true }) },
              encode,
              presence: { connected: () => false, lastRequestAt: () => null },
              parks: {
                resume: (office, id, request) =>
                  r.outcomes?.resumePark(office, id, request) ??
                  Promise.resolve({ kind: "failed", reason: "no outcomes" }),
              },
            });
            const reply: CommandReply = await executeCommand(
              { ...r.s.deps, ids, registry: buildRegistry([asks.feature]) },
              {
                requestId: requestId(),
                name: "work.answer",
                args: { question: question?.questionId, text: "", decision: "allow" },
                origin: "cli",
                confirmed: false,
                office: r.officeId,
              },
            );
            expect(reply).toMatchObject({
              ok: true,
              result: { question: question?.questionId, delivered: "on-resume", run },
            });
            await r.control?.idle();

            // The park was lifted on the branch and resolved; the same run went on.
            expect(await subject()).toBe("TASK-1: status In Progress");
            const resolved = r.office.get<{ resolved_how: string | null }>(
              "select resolved_how from parks where office_id = $office_id and park_id = $park",
              { park: parked?.parkId ?? -1 },
            );
            expect(resolved?.resolved_how).toBe("resume");
            expect(r.hosts.map((host) => host.runId)).toEqual([run, run]);
            expect(r.hosts[1]?.plan.stdin.join("")).toContain(PERMISSION.action);
            expect(findQuestion(r.office, question?.questionId ?? "")).toMatchObject({
              decision: "allow",
              closedHow: "answered",
              allowUsedAt: null,
            });
          },
        ),
      90_000,
    );
  });
}
