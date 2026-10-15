// CI only (0017 section 1): a `needs-permission` park answered with `work.answer` on real git with
// the pinned Backlog CLI and DIPO-44's worker host in this process (DIPO-75). `work.run` claims
// TASK-1 and its first host replays the live `needs-permission` recording (see
// `../hooks/needs-permission.ts`): the story parks with the park's permission question. The maintainer's allow goes through the permission wait to the real
// `RunOutcomes.resumePark`: the park is lifted on the story branch, the same run is active again
// and its next session starts in a second host (replaying `success-single`) with the allow
// message. Its done report goes through verify and commit (a fake verify step) to In Review, so
// the run ends once: one `run_outcomes` row whose minutes leave out the two parked hours, and one
// run in `usage_daily` with each agent fed once. Each case needs a claim, an office load and
// several CLI calls, well over the local per-test budget.

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type CommandReply, RequestId, type RunId } from "@dipsaus-orchestrator/contract";

import { executeCommand } from "../../src/commands/execute";
import { buildRegistry } from "../../src/commands/registry";
import { PermissionAsks } from "../../src/hooks/permissions";
import { findQuestion, openQuestions } from "../../src/hooks/questions";
import { createSystemIds } from "../../src/platform/ids";
import { findRun, openPark } from "../../src/run";
import { encode } from "../../src/workers/claude-cli/encode";
import { needsPermissionRecording, reportedPermission } from "../hooks/needs-permission";
import { detect } from "../../src/scan/detect";
import { resultOf } from "../office/helpers";
import { BRANCH, type Running, withRunOffice } from "./run-office";

const PARKED_MS = 2 * 60 * 60_000;

const PROFILE = detect({
  texts: { "package.json": JSON.stringify({ name: "fixture", scripts: { verify: "bun test" } }) },
  lockfiles: ["bun.lock"],
  workspaceDirs: [],
  configImports: {},
  envFiles: [],
});

const RECORDING = needsPermissionRecording();
const PERMISSION = reportedPermission(RECORDING);

let count = 0;
function requestId(): RequestId {
  count += 1;
  return RequestId.parse(`01J9ZK5Q8W3V4X6Y7Z${(85_000 + count).toString().padStart(8, "0")}`);
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("a needs-permission park answered with allow once (live recording)", () => {
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
            finisher: {
              profile: PROFILE,
              beforeWorker: (worktree) => {
                mkdirSync(join(worktree, "packages", "export"), { recursive: true });
                writeFileSync(
                  join(worktree, "packages", "export", "csv.ts"),
                  "export const csv = 1;\n",
                );
              },
            },
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
            // The story stood parked two hours before the answer.
            r.s.clock.advance(PARKED_MS);
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

            // The park was lifted on the branch, pushed, and resolved; the same run went on.
            const remoteTip = (await r.repo.git("ls-remote", "--heads", "origin", BRANCH)).split(
              "\t",
            )[0];
            const remoteLog = (
              await r.repo.git("log", "--format=%s", "-n", "4", remoteTip ?? BRANCH)
            )
              .trim()
              .split("\n");
            // The second session's done report then went through verify and commit at In Review.
            expect(remoteLog[0]).toBe("TASK-1: status In Review");
            expect(remoteLog.slice(2)).toEqual([
              "TASK-1: status In Progress",
              "TASK-1: status Parked",
            ]);
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

            // One run end: one run_outcomes row with the park and the minutes it worked (the two
            // parked hours do not count), and the run counted once in usage_daily with each
            // agent's usage fed once.
            const ended = findRun(r.office, run);
            expect(ended?.endedAt).not.toBeNull();
            expect(ended?.parkedMs).toBe(PARKED_MS);
            const outcomes = r.office.all<{
              outcome: string;
              park_reasons: string;
              minutes: number;
            }>(
              "select outcome, park_reasons, minutes from run_outcomes where office_id = $office_id and run_id = $run",
              { run },
            );
            expect(outcomes).toEqual([
              { outcome: "parked", park_reasons: '["needs-permission"]', minutes: 0 },
            ]);
            const totals = r.office.get<{ input: number; output: number; turns: number }>(
              `select sum(input) as input, sum(output) as output, sum(turns) as turns
                from usage_totals where office_id = $office_id and run_id = $run`,
              { run },
            );
            const daily = r.office.all<{
              runs: number;
              input: number;
              output: number;
              turns: number;
            }>("select runs, input, output, turns from usage_daily where office_id = $office_id");
            expect(daily).toEqual([
              { runs: 1, ...(totals ?? { input: -1, output: -1, turns: -1 }) },
            ]);
          },
        ),
      90_000,
    );
  });
}
