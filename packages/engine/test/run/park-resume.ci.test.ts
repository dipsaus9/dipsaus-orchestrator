// CI only (0017 section 1): a `needs-permission` park answered with `work.answer` on real git with
// the pinned Backlog CLI and DIPO-44's worker host in this process (DIPO-75). `work.run` claims
// TASK-1 and its first host replays the live `needs-permission` recording (see
// `../hooks/needs-permission.ts`): the story parks with the park's permission question. The maintainer's allow goes through the permission wait to the real
// `Resumption.resumePark`: the park is lifted on the story branch, the same run is active again
// and its next session starts in a second host (replaying `success-single`) with the allow
// message. Its done report goes through its last part (the worktree stands in for its box) to In Review, so
// the run ends once: one `run_outcomes` row whose minutes leave out the two parked hours, and one
// run in `usage_daily` with each agent fed once. Each case needs a claim, an office load and
// several CLI calls, well over the local per-test budget.

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type CommandReply,
  type IdSource,
  RequestId,
  type RunId,
} from "@dipsaus-orchestrator/contract";

import { executeCommand } from "../../src/commands/execute";
import { buildRegistry } from "../../src/commands/registry";
import { OFFICE_DEFAULTS } from "../../src/config";
import { PermissionAsks } from "../../src/hooks/permissions";
import { findQuestion, openQuestions } from "../../src/hooks/questions";
import { createSystemIds } from "../../src/platform/ids";
import { findRun, openPark, runTotals } from "../../src/run";
import { encode } from "../../src/workers/claude-cli/encode";
import { needsPermissionRecording, reportedPermission } from "../hooks/needs-permission";
import { detect } from "../../src/scan/detect";
import { backlog, publish } from "../gate/gated-office";
import { resultOf, send } from "../office/helpers";
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
              presence: { tuiConnected: () => false },
              parks: {
                resume: (office, id, request) =>
                  r.resumption?.resumePark(office, id, request) ??
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
              changed: true,
              result: { question: question?.questionId, delivered: "on-resume", run },
            });
            // The reply came once the run reopened; the session starts after it.
            await r.resumption?.idle();
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
            // The second session's done report then went through its last part to In Review.
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

  describe("a tier edit while a story is parked (DIPO-143, 0020 section 5)", () => {
    it(
      "resumes the parked run with its start caps, and a story started afterwards gets the edited tier",
      () =>
        withRunOffice(
          {
            host: "replay",
            recordings: [RECORDING, "success-single"],
            checks: { ok: true },
            control: {},
            outcomes: true,
            resumeParks: true,
            finisher: { profile: PROFILE, beforeWorker: writeCsv },
            // A second Ready story, after TASK-1 in the queue, for the run started after the edit.
            prepare: async (repo) => {
              await backlog(repo, [
                "task",
                "create",
                "Add the TSV export command",
                "-d",
                TSV_DESCRIPTION,
                "--ac",
                "The export command writes one TSV row per story",
                "-s",
                "Ready",
                "-l",
                "tier:S",
                "--type",
                "feature",
                "-m",
                "m-0",
                "--ref",
                "packages/tsv/",
                "--ordinal",
                "9000",
              ]);
              await publish(repo, "add TASK-4");
            },
          },
          async (r: Running) => {
            const ids = createSystemIds(r.s.clock);
            const start = OFFICE_DEFAULTS.tiers.S;
            const run = await startStory(r, ids, "TASK-1");
            await r.control?.idle();
            expect(openPark(r.office, findRun(r.office, run)?.key ?? "")?.reason).toBe(
              "needs-permission",
            );
            const startCaps = {
              tier: "S",
              budgetLimit: start.budgetTokens,
              maxTurns: start.maxTurns,
              maxMinutes: start.maxMinutes,
              loopCap: start.loops,
            };
            expect(findRun(r.office, run)).toMatchObject(startCaps);

            // The maintainer edits the tier while the story is parked, and reloads the config.
            mkdirSync(join(r.repo.dir, ".dipo"), { recursive: true });
            writeFileSync(join(r.repo.dir, ".dipo", "office.yaml"), EDITED_YAML);
            resultOf(await send(r.s, "office.reloadConfig", { office: r.officeId }));
            expect(r.s.manager.config(r.officeId)?.tiers.S).toMatchObject(EDITED);

            // The turns the first session used, which the resumed session's turn cap leaves out.
            const used = runTotals(r.office, run, 0, 0).turns;
            const [question] = openQuestions(r.office);
            await answerAllow(r, ids, question?.questionId ?? "");
            await r.resumption?.idle();
            await r.control?.idle();

            // The same run resumed in a second host, its CLI turn cap counted from the start snapshot.
            expect(r.hosts.map((host) => host.runId)).toEqual([run, run]);
            const argv: readonly string[] = r.hosts[1]?.plan.argv ?? [];
            const maxTurns = argv[argv.indexOf("--max-turns") + 1];
            expect(maxTurns).toBe(String(Math.max(1, start.maxTurns - used)));
            expect(maxTurns).not.toBe(String(Math.max(1, EDITED.maxTurns - used)));
            // The parked run's stored caps are still its start snapshot.
            expect(findRun(r.office, run)).toMatchObject(startCaps);

            // A story started after the edit stores the edited tier as its snapshot.
            const second = await startStory(r, ids, "TASK-4");
            await r.control?.idle();
            expect(findRun(r.office, second)).toMatchObject({
              story: "TASK-4",
              tier: "S",
              budgetLimit: EDITED.budgetTokens,
              maxTurns: EDITED.maxTurns,
              maxMinutes: EDITED.maxMinutes,
              loopCap: EDITED.loops,
            });
          },
        ),
      120_000,
    );
  });
}

/** The tier S edit of the DIPO-143 case: every cap differs from the built-in defaults. */
const EDITED = { budgetTokens: 900_000, maxTurns: 500, maxMinutes: 90, loops: 9 };
const EDITED_YAML = [
  "version: 1",
  "tiers:",
  "  S:",
  `    budgetTokens: ${EDITED.budgetTokens}`,
  `    maxTurns: ${EDITED.maxTurns}`,
  `    maxMinutes: ${EDITED.maxMinutes}`,
  `    loops: ${EDITED.loops}`,
  "",
].join("\n");

const TSV_DESCRIPTION = [
  "Outcome: maintainers can export the story list as TSV for a spreadsheet.",
  "",
  "```dipo",
  'branch: "TASK-4/add-the-tsv-export-command"',
  "unknowns: []",
  "test_plan:",
  "  entries:",
  '    - kind: "automated"',
  '      check: "(unit) one TSV row per story, header first"',
  "```",
].join("\n");

function writeCsv(worktree: string): void {
  mkdirSync(join(worktree, "packages", "export"), { recursive: true });
  writeFileSync(join(worktree, "packages", "export", "csv.ts"), "export const csv = 1;\n");
}

/** `work.run` on one story; the run it started. */
async function startStory(r: Running, ids: IdSource, story: string): Promise<RunId> {
  const started = resultOf<{ started: { story: string; run: string }[] }>(
    await executeCommand(
      { ...r.s.deps, ids },
      {
        requestId: requestId(),
        name: "work.run",
        args: { from: r.repo.dir, stories: [story] },
        origin: "cli",
        confirmed: true,
        office: r.officeId,
      },
    ),
  );
  const run = started.started.find((s) => s.story === story)?.run;
  if (run === undefined) throw new Error(`work.run did not start ${story}`);
  return run as RunId;
}

/** The maintainer allows the parked permission question once (`work.answer`). */
async function answerAllow(r: Running, ids: IdSource, question: string): Promise<void> {
  const asks = new PermissionAsks({
    clock: r.s.clock,
    ids,
    offices: {
      get: (office) => r.s.manager.get(office),
      config: (office) => r.s.manager.config(office),
    },
    steering: { send: async () => ({ ok: true }) },
    encode,
    presence: { tuiConnected: () => false },
    parks: {
      resume: (office, id, request) =>
        r.resumption?.resumePark(office, id, request) ??
        Promise.resolve({ kind: "failed", reason: "no outcomes" }),
    },
  });
  resultOf(
    await executeCommand(
      { ...r.s.deps, ids, registry: buildRegistry([asks.feature]) },
      {
        requestId: requestId(),
        name: "work.answer",
        args: { question, text: "", decision: "allow" },
        origin: "cli",
        confirmed: false,
        office: r.officeId,
      },
    ),
  );
}
