// CI only (0017 section 1): a daemon restart during a replayed run (DIPO-57 test plan). DIPO-44's
// worker host runs in this process with a FakeProcess replaying `success-tools-subagent` on a
// manual clock, on a real socket. A first "daemon" (run control and ingestion) follows it over the
// socket, then stops; lines are written while it is down; a second one re-attaches by the host's
// liveness and handshake and follows it to the exit. The stored output and its `work.output`
// entries continue without a gap or a repeated byte, and every message is counted once. It needs
// a real socket and many waits for the replay, more than the local per-test budget.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type ChildProcess,
  type Signal,
  type Spawn,
  StoryId,
  type WorkRef,
} from "@dipsaus-orchestrator/contract";
import { fakeSpawn, ManualClock, readRecording } from "@dipsaus-orchestrator/testkit";

import { WorkerHost } from "../../src/host/main";
import { LAUNCH_FILE } from "../../src/host/protocol";
import type { IngestAdapter } from "../../src/ingest/ingestor";
import {
  type BranchPark,
  insertRun,
  OfficeIngest,
  RunControl,
  RunOutcomes,
  RunReattacher,
} from "../../src/run";
import { addStory } from "../../src/stories/keys";
import { encode } from "../../src/workers/claude-cli/encode";
import {
  type ClaudeParseState,
  initialState,
  interpret,
} from "../../src/workers/claude-cli/interpret";
import { result as claudeResult } from "../../src/workers/claude-cli/result";
import type { ParseState } from "../../src/workers/types";
import { insertClaim } from "../../src/worktree/records";
import { type IngestFixture, ingestFixture, loggedEvents, storedOutput } from "../ingest/helpers";
import { RECORDINGS_DIR } from "../workers/replay";

const claude: IngestAdapter = {
  interpret: (line, state) =>
    interpret(line, state as unknown as ClaudeParseState) as unknown as {
      events: [];
      state: ParseState;
    },
};
const START = initialState({ plannedModel: "haiku" }) as unknown as ParseState;
const CAPS = { budgetTokens: 10_000_000, maxTurns: 100, maxMinutes: 600 };

let dir = "";
let f: IngestFixture;
let work: WorkRef;
const closers: (() => void)[] = [];

function engine() {
  const offices = { get: () => f.office };
  const steering = { send: async () => ({ ok: true as const }) };
  let outcomes: RunOutcomes | null = null;
  const control = new RunControl({
    clock: f.t.clock,
    offices,
    writer: {
      write: async (): Promise<BranchPark> => {
        throw new Error("no park in this test");
      },
    },
    steering,
    encode,
    outcomes: () => outcomes ?? undefined,
  });
  outcomes = new RunOutcomes({
    clock: f.t.clock,
    offices,
    steering,
    encode,
    worker: {
      id: "claude-cli",
      result: (state, exit) => claudeResult(state as unknown as ClaudeParseState, exit),
    },
    ender: () => control,
    caps: () => CAPS,
  });
  const ingest = new OfficeIngest({ clock: f.t.clock, pricing: () => null, hooks: control.hooks });
  closers.push(() => {
    control.close();
    ingest.close();
  });
  return { control, outcomes, ingest };
}

/** A spawn whose worker writes a stdout line only when the test releases one. */
function paced(spawn: Spawn) {
  let budget = 0;
  let wake: (() => void) | null = null;
  const wrapped: Spawn = (options) => {
    const child = spawn(options);
    const reader = child.stdout.getReader();
    const stdout = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          const empty = () => budget <= 0;
          while (empty()) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          budget -= 1;
          controller.enqueue(value);
        },
      },
      { highWaterMark: 0 },
    );
    return {
      get pid() {
        return child.pid;
      },
      stdin: child.stdin,
      stdout,
      stderr: child.stderr,
      exited: child.exited,
      kill: (signal?: Signal) => child.kill(signal),
    } satisfies ChildProcess;
  };
  return {
    spawn: wrapped,
    release: (lines: number) => {
      budget += lines;
      wake?.();
      wake = null;
    },
  };
}

/** Waits on real time until `done` holds. */
async function until(done: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2_000; i += 1) {
    if (done()) return;
    await Bun.sleep(2);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function fileSize(): number {
  try {
    return statSync(f.eventFile).size;
  } catch {
    return 0;
  }
}

function processed(): number {
  return (
    f.office.get<{ processed_offset: number }>(
      "select processed_offset from worker_hosts where office_id = $office_id",
    )?.processed_offset ?? 0
  );
}

beforeEach(async () => {
  dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "rea-"));
  f = await ingestFixture(dir);
  const { key } = f.office.immediate(() =>
    addStory(f.office, f.t.ids, { story: StoryId.parse("DIPO-1") }, f.t.clock.now()),
  );
  work = { ...f.work, key };
  f.office.immediate(() => {
    insertRun(f.office, {
      runId: f.run,
      kind: "story",
      key,
      story: "DIPO-1",
      tier: "M",
      role: "developer",
      model: "haiku",
      startSha: "b".repeat(40),
      branch: "DIPO-1/add-a-greeting",
      worktree: join(dir, "trees", "DIPO-1"),
      slot: 1,
      budgetUnit: "tokens",
      budgetLimit: CAPS.budgetTokens,
      loopCap: 3,
      reviewRoundCap: null,
      configHash: "h",
      overrideKeys: null,
      runProfileId: null,
      startedAt: f.t.clock.now(),
    });
    insertClaim(f.office, {
      runId: f.run,
      key,
      story: "DIPO-1",
      branch: "DIPO-1/add-a-greeting",
      worktree: join(dir, "trees", "DIPO-1"),
      base: "main",
      baseSha: "b".repeat(40),
      startSha: "b".repeat(40),
      claimSha: "d".repeat(40),
      reused: false,
      snapshot: { path: "/x", adminDir: "/x", commondir: "/x", gitdir: "/x", pointer: "/x" },
      firstFeedback: null,
      claimedAt: f.t.clock.now(),
    });
  });
});

afterEach(() => {
  for (const close of closers.splice(0)) close();
  f.t.state.close();
  rmSync(dir, { recursive: true, force: true });
});

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("a daemon restart during a replayed run", () => {
    it("re-attaches to the living host; output continues without gaps or duplicates", async () => {
      // The fixture's host row names `<dir>/events.ndjson` and `<dir>/host.sock`.
      const socket = join(dir, "host.sock");
      writeFileSync(
        join(dir, LAUNCH_FILE),
        JSON.stringify({
          version: 1,
          run: f.run,
          agent: f.agent,
          socket,
          plan: { argv: ["/bin/claude"], env: {}, cwd: dir, files: [], stdin: [] },
        }),
      );
      const replay = new ManualClock();
      const worker = paced(
        fakeSpawn(readRecording(join(RECORDINGS_DIR, "success-tools-subagent")), replay).spawn,
      );
      const host = WorkerHost.start({
        runId: f.run,
        runDir: dir,
        clock: replay,
        spawn: worker.spawn,
        killGroup: () => undefined,
        pid: 4242,
      });
      closers.push(() => void host.done.catch(() => undefined));
      const target = {
        run: f.run,
        agent: f.agent,
        role: "developer",
        tier: "M",
        model: "haiku",
        budgetLimit: CAPS.budgetTokens,
        work,
        adapter: claude,
        initialState: START,
      };

      // The first daemon follows the host over its socket.
      const first = engine();
      first.control.track(f.office.officeId, {
        runId: f.run,
        work,
        caps: CAPS,
        startedAt: f.t.clock.now(),
      });
      first.ingest.start(
        f.office,
        {
          pid: 4242,
          startTimeMs: 0,
          runId: f.run,
          agentId: f.agent,
          socketPath: socket,
          protocolVersion: 1,
          runDir: dir,
          eventFile: f.eventFile,
        },
        target,
      );
      await Bun.sleep(50);
      worker.release(15);
      await until(() => processed() > 0 && fileSize() === processed(), "the first daemon");
      // Some output is sent, some only stored, when the daemon stops.
      f.t.clock.advance(250);
      const sentBefore = loggedEvents(f.office).filter((event) => event.type === "work.output");
      expect(sentBefore.length).toBeGreaterThan(0);
      await until(() => fileSize() === processed(), "the first daemon's last pass");
      for (const close of closers.splice(0)) close();

      // Lines written while the daemon is down.
      const down = fileSize();
      worker.release(15);
      await until(() => fileSize() > down, "lines written while the daemon is down");
      await Bun.sleep(20);

      // The second daemon re-attaches: alive by PID, and the socket answers the handshake.
      const second = engine();
      const reattacher = new RunReattacher({
        clock: f.t.clock,
        offices: { get: () => f.office },
        probe: async (pid) => ({ pid, startTimeMs: 0, zombie: false, command: "dipo" }),
        ingest: second.ingest,
        control: second.control,
        outcomes: second.outcomes,
        adapter: () => claude,
        initialState: () => START,
        caps: () => CAPS,
      });
      expect(await reattacher.reattach(f.office.officeId)).toEqual([
        { run: f.run, agent: f.agent, outcome: "steer" },
      ]);
      worker.release(1_000);
      await until(
        () =>
          f.office.get<{ ended_at: number | null }>(
            "select ended_at from agents where office_id = $office_id and agent_id = $agent",
            { agent: f.agent },
          )?.ended_at != null,
        "the exit",
      );
      await second.control.idle();
      await host.done;

      // The output entries cover the stored output once, each starting where the last ended.
      const outputs = loggedEvents(f.office)
        .filter((event) => event.type === "work.output")
        .map((event) => event.data as { from: number; to: number; text: string });
      const stored = storedOutput(f.office, f.run);
      expect(stored.length).toBeGreaterThan(0);
      expect(outputs.length).toBeGreaterThan(1);
      let at = 0;
      for (const output of outputs) {
        expect(output.from).toBe(at);
        at = output.to;
      }
      expect(outputs.map((output) => output.text).join("")).toBe(stored);
      // Every message counted once.
      const counts = f.office.all<{ n: number }>(
        `select count(*) as n from usage_messages where office_id = $office_id
          group by message_id having n > 1`,
      );
      expect(counts).toEqual([]);
      expect(outputs.length).toBe(2);
    }, 30_000);
  });
}
