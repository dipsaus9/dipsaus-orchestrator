// CI only (0017 section 1): real processes (DIPO-411). A real `dipo daemon worker-host` is started
// detached through the engine with a stub worker, and `story.park` is sent at once, before the host
// has bound its socket, as in the hand test where the stop went out 0.24 s after the host started.
// The stop's send waits for the starting host (`hostSocketSteering`, `connectWhenBound`), the host
// stops its worker, ingestion reads the exit, and only then does the story park: the reply comes
// after the worker exited, never while it runs. Sent during setup, before the host is spawned, the
// park waits for the start to end and then stops the new worker the same way.

import { describe, expect, it } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  type CommandReply,
  type OfficeId,
  RequestId,
  RunId,
  StoryId,
  type WorkRef,
  storyPark,
} from "@dipsaus-orchestrator/contract";
import { cleanEnv, withTempDir } from "@dipsaus-orchestrator/testkit";

import { executeCommand } from "../../src/commands/execute";
import { stateOfficeDirectory } from "../../src/commands/offices";
import { buildRegistry, type FeatureModule } from "../../src/commands/registry";
import { MemoryRequestTable } from "../../src/commands/requests";
import type { ParseState } from "../../src/workers/types";
import { systemClock } from "../../src/platform/clock";
import { currentPlatform } from "../../src/platform/paths";
import { systemProcessProbe } from "../../src/platform/process";
import { findRun, insertRun, runIntents } from "../../src/records";
import { addStory } from "../../src/records/story-keys";
import {
  hostAlive,
  type LaunchedHost,
  startWorkerHost,
  workerHostsOf,
} from "../../src/records/worker-hosts";
import { type BranchPark, RunControl } from "../../src/run";
import { HOST_LAUNCH_DEADLINE_MS, hostSocketSteering, OfficeIngest } from "../../src/run/hosts";
import { insertClaim } from "../../src/worktree/records";
import { addOffice, openTestState } from "../commands/helpers";
import { backlogLayout } from "../story-store/backlog";
import { mirrorStory } from "./park-fixture";

const FIXTURES = resolve(import.meta.dir, "../host/fixtures");
const CLI_MAIN = resolve(import.meta.dir, "../../../cli/src/main.ts");

function killGroup(pid: number | undefined): void {
  if (pid === undefined || pid <= 1) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("story.park while the worker host is still starting (DIPO-411)", () => {
    for (const when of ["while the host binds its socket", "during setup, before the spawn"]) {
      it(
        `waits for the starting host (${when}), stops its worker, and parks only after the worker exited`,
        () =>
          withTempDir(async (dir) => {
            const t = await openTestState(dir);
            const office = addOffice(t);
            const probe = systemProcessProbe(currentPlatform());
            const clock = systemClock;
            const env = cleanEnv();
            delete env["BUN_OPTIONS"];
            delete env["BUN_FEATURE_FLAG_NO_ORPHANS"];
            const run = RunId.parse(t.ids.next("run"));
            const agent = t.ids.next("agt");
            const { key } = office.immediate(() =>
              addStory(office, t.ids, { story: StoryId.parse("DIPO-1") }, clock.now()),
            );
            office.immediate(() => {
              mirrorStory(office, { key, story: "DIPO-1" });
              insertRun(office, {
                runId: run,
                kind: "story",
                key,
                story: "DIPO-1",
                tier: "M",
                role: "developer",
                model: "haiku",
                startSha: "b".repeat(40),
                branch: "DIPO-1/add-a-greeting",
                budgetUnit: "tokens",
                budgetLimit: 1_000_000,
                loopCap: 3,
                reviewRoundCap: null,
                configHash: "h",
                overrideKeys: null,
                runProfileId: null,
                startedAt: clock.now(),
              });
              insertClaim(office, {
                runId: run,
                key,
                story: "DIPO-1",
                branch: "DIPO-1/add-a-greeting",
                base: "main",
                baseSha: "b".repeat(40),
                startSha: "b".repeat(40),
                claimSha: "d".repeat(40),
                reused: false,
                claimedAt: clock.now(),
              });
            });
            const work = {
              story: "DIPO-1",
              key,
              run,
              agent,
              role: "developer",
              tier: "M",
              model: "haiku",
            } as WorkRef;
            const control = new RunControl({
              stories: backlogLayout,
              clock,
              offices: { get: () => office },
              writer: {
                write: async (): Promise<BranchPark> => ({
                  commit: "c".repeat(40),
                  lastGoodCommit: "a".repeat(40),
                  from: "In Progress",
                  pushed: true,
                  pushError: null,
                }),
              },
              steering: hostSocketSteering({ clock }),
              // The stub worker ignores a stop message; it dies of the SIGTERM at once.
              encode: () => [{ closeStdin: true }, { signal: "SIGTERM" }],
            });
            const ingest = new OfficeIngest({ clock, hooks: control.hooks });

            const workDir = join(dir, "w");
            mkdirSync(workDir, { recursive: true });
            const stub = join(workDir, "s.sh");
            copyFileSync(join(FIXTURES, "stub-worker.sh"), stub);
            chmodSync(stub, 0o755);
            let host: LaunchedHost | undefined;
            try {
              // During setup the run's start is under way, as `work.run` marks it from the run row.
              const setup = when.startsWith("during setup");
              const started = setup ? control.starting(run) : null;
              let replied = false;
              const parking = setup
                ? park(t, office.officeId as OfficeId, control).then((reply) => {
                    replied = true;
                    return reply;
                  })
                : null;
              if (setup) {
                await Bun.sleep(50);
                // The park waits: nothing parked, and the host is not spawned yet.
                expect(replied).toBe(false);
                expect(findRun(office, run)?.endedAt).toBeNull();
                expect(workerHostsOf(office, run)).toEqual([]);
              }
              const startedAt = clock.now();
              host = await startWorkerHost(office, clock, {
                runId: run,
                agentId: agent,
                officeDir: join(dir, "repo", ".git", "dipo"),
                runtimeDir: join(dir, "rt"),
                plan: {
                  argv: ["/bin/sh", stub],
                  env: { PATH: "/usr/bin:/bin" },
                  cwd: dir,
                  files: [],
                  stdin: ['"first"\n'],
                },
                dipoCommand: [process.execPath, CLI_MAIN],
                startedAt,
                launchDeadline: startedAt + HOST_LAUNCH_DEADLINE_MS,
                env: { ...env, DIPO_HOME: join(dir, "state"), DIPO_TMP: dir },
                probe,
              });
              control.track(office.officeId as OfficeId, {
                runId: run,
                work,
                caps: { budgetTokens: 1_000_000, maxTurns: 100, maxMinutes: 30 },
                startedAt,
              });
              ingest.start(office, host, {
                run,
                agent,
                role: "developer",
                tier: "M",
                model: "haiku",
                budgetLimit: 1_000_000,
                work,
                adapter: { interpret: (_line, state) => ({ events: [], state }) },
                initialState: {} as ParseState,
              });
              started?.();

              // The park goes out within the host's first second, before its socket is bound.
              expect(clock.now() - startedAt).toBeLessThan(1_000);
              expect(existsSync(host.socketPath)).toBe(false);
              const reply = await (parking ?? park(t, office.officeId as OfficeId, control));
              if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`);
              expect(reply.result).toMatchObject({ story: "DIPO-1", run });

              // By the reply the worker has exited and its exit was ingested; then the run parked.
              const events = readFileSync(host.eventFile, "utf8");
              expect(events).toContain('"ch":"exit"');
              const agentEnded = office.get<{ ended_at: number | null }>(
                "select ended_at from agents where office_id = $office_id and agent_id = $agent",
                { agent },
              )?.ended_at;
              const ended = findRun(office, run);
              expect(ended?.ending).toBe("parked");
              expect(agentEnded).not.toBeNull();
              expect(agentEnded ?? Infinity).toBeLessThanOrEqual(ended?.endedAt ?? 0);
              // The stop was sent, not failed as an unreachable socket.
              expect(
                runIntents(office, run).map((intent) => [
                  intent.kind,
                  intent.error,
                  intent.sentAt !== null,
                ]),
              ).toEqual([["stop", null, true]]);
              // The host exits after its worker.
              const deadline = performance.now() + 10_000;
              while (performance.now() < deadline && (await hostAlive(host, probe))) {
                await Bun.sleep(50);
              }
              expect(await hostAlive(host, probe)).toBe(false);
            } finally {
              ingest.close();
              control.close();
              killGroup(host?.pid);
              t.state.close();
            }
          }),
        60_000,
      );
    }
  });
}

/** `story.park` of DIPO-1, as the planning feature hands it to run control. */
function park(
  t: Awaited<ReturnType<typeof openTestState>>,
  office: OfficeId,
  control: RunControl,
): Promise<CommandReply> {
  const feature: FeatureModule = {
    name: "park",
    register: (registry) =>
      registry.addAsyncOfficeCommand({
        definition: storyPark,
        handle: async (ctx, args) => {
          const parked = await control.parkByMaintainer(ctx, args);
          const identity = ctx.stories.get(args.story)!;
          return {
            ...parked,
            result: { story: identity.story, key: identity.key, ...parked.result },
          };
        },
      }),
  };
  return executeCommand(
    {
      registry: buildRegistry([control.feature, feature]),
      offices: stateOfficeDirectory(t.state),
      clock: t.clock,
      ids: t.ids,
      softwareRequests: new MemoryRequestTable(t.clock),
    },
    {
      requestId: RequestId.parse("01J9ZK5Q8W3V4X6Y7Z00000411"),
      name: "story.park",
      args: { story: "DIPO-1", note: "Not now." },
      origin: "cli",
      confirmed: true,
      office,
    },
  );
}
