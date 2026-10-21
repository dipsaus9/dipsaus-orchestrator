// A box worker's stream through the worker host, ingestion and run control (DIPO-271):
// - criterion 3: budgets, the turn and minute caps and the live view work on a box worker's
//   recorded stream as on a Mac worker's: the host writes the same lines, ingestion stores the
//   same output and usage, and run control parks at the same caps;
// - criterion 6: a stop (the cap's, the budget's or the stop command's stop sequence, or SIGTERM
//   to the host) ends claude inside the box, not only the `container exec` client on the Mac,
//   whose kill leaves its process running in the box.
//
// The box stream is a committed Claude recording with the `system/init` a box worker shows: the
// code at /work, the placeholder key's source and all permissions. Every other line is as
// recorded, since Claude Code's stream-json does not depend on where it runs. The backend is the
// in-memory one; no `container` program and no claude runs.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { RunId, StoryId, type WorkRef } from "@dipsaus-orchestrator/contract";
import type { ChildProcess, Signal, Spawn } from "@dipsaus-orchestrator/contract";
import {
  FakeProcess,
  fakeSpawn,
  ManualClock,
  type Recording,
  recordedProcesses,
  stdoutText,
  withTempDir,
} from "@dipsaus-orchestrator/testkit";

import type { BoxSession } from "../../src/box/workers";
import { BOX_PLACEHOLDER_API_KEY } from "../../src/box/model-proxy";
import { connectHost, type HostClient } from "../../src/host/client";
import { WorkerHost } from "../../src/host/main";
import { EVENTS_FILE, hostSocketPath, LAUNCH_FILE, type HostLaunch } from "../../src/host/protocol";
import { type IngestAdapter, Ingestor } from "../../src/ingest/ingestor";
import { systemClock } from "../../src/platform/clock";
import { type BranchPark, CAP_TICK_MS, findRun, insertRun, RunControl } from "../../src/run";
import { addStory } from "../../src/stories/keys";
import { CLAUDE_LINE_SCRUB, claudeCliAdapter } from "../../src/workers/claude-cli/adapter";
import { planInBox } from "../../src/workers/claude-cli/box-plan";
import { encode, STOP_SIGTERM_AFTER_MS } from "../../src/workers/claude-cli/encode";
import { initialState } from "../../src/workers/claude-cli/interpret";
import type { Caps, HostLine, HostOp, ParseState } from "../../src/workers/types";
import { insertClaim } from "../../src/worktree/records";
import { FakeBoxes } from "../box/fake-boxes";
import {
  appendLines,
  hostLines,
  type IngestFixture,
  ingestFixture,
  loggedEvents,
  storedOutput,
  target,
} from "../ingest/helpers";
import { context, spec, withoutSkills } from "./launch-fixtures";
import { loadRecording } from "./replay";

const RUN = "run_01JZ0000000000000000000271";
const BOX = `dipo-${RUN}`;

/** A committed recording as a box worker's stream (file comment). */
function boxRecording(name: string): Recording {
  const recording = withoutSkills(loadRecording(name));
  const lines = recording.lines.map((line) => {
    const data = line.data as Record<string, unknown>;
    if (line.ch !== "stdout" || data["type"] !== "system" || data["subtype"] !== "init") {
      return line;
    }
    return {
      ...line,
      data: {
        ...data,
        cwd: "/work",
        apiKeySource: "ANTHROPIC_API_KEY",
        permissionMode: "bypassPermissions",
      },
    };
  });
  return { ...recording, name: `${name} in a box`, lines };
}

/** The box adapter's interpret: the init checks of a box run (placeholder key accepted). */
const boxAdapter: IngestAdapter = claudeCliAdapter(
  context(),
  {
    spawn: () => {
      throw new Error("unused");
    },
    clock: new ManualClock(),
  },
  { boxWorker: true },
) as unknown as IngestAdapter;

function boxSession(boxes: FakeBoxes): BoxSession {
  return {
    box: BOX,
    workdir: "/work",
    env: {
      ANTHROPIC_API_KEY: BOX_PLACEHOLDER_API_KEY,
      ANTHROPIC_BASE_URL: "http://192.0.2.10:4000",
      NO_PROXY: "192.0.2.10",
      HTTPS_PROXY: "http://192.0.2.10:3128",
      HTTP_PROXY: "http://192.0.2.10:3128",
      NODE_EXTRA_CA_CERTS: "/dipo/safe-chain-ca.pem",
    },
    systemFile: "/dipo/system.md",
    exec: (command, env) => boxes.execLiveCommand(BOX, command, { cwd: "/work", env }),
    stop: boxes.stopCommand(BOX),
  };
}

interface BoxHost {
  readonly host: WorkerHost;
  readonly runDir: string;
  readonly socket: string;
  readonly boxes: FakeBoxes;
  /** The `container exec` clients started, in order. */
  readonly clients: FakeProcess[];
  /** The argv of every program the host started. */
  readonly spawned: (readonly string[])[];
  readonly clock: ManualClock;
}

/**
 * A worker host in this process running the box plan of `recording`'s stream. `container exec`
 * starts a client replaying the stream and marks claude running in the box; killing the client
 * leaves it running there, as with the real `container`. `container stop` stops the fake box.
 */
function boxHost(
  dir: string,
  recording: Recording,
  options: { gate?: Promise<void> } = {},
): BoxHost {
  const runDir = join(dir, "repo", ".git", "dipo", "runs", RUN);
  mkdirSync(runDir, { recursive: true });
  const socket = hostSocketPath(join(dir, "rt"), RUN);
  const boxes = new FakeBoxes();
  void boxes.create({
    runId: RUN,
    image: "dipo-box:x",
    network: { name: "dipo-boxes", mode: "hostOnly", hostAddress: "192.0.2.10" },
  });
  void boxes.start(BOX);
  const plan = {
    ...planInBox(
      spec({ run: RUN, systemFile: join(runDir, "system.md") }),
      boxSession(boxes),
      runDir,
    ),
    lineScrub: CLAUDE_LINE_SCRUB,
  };
  const launch: HostLaunch = {
    version: 1,
    run: RUN,
    agent: "agt_01JZ0000000000000000000271",
    socket,
    plan,
  };
  writeFileSync(join(runDir, LAUNCH_FILE), JSON.stringify(launch), { mode: 0o600 });
  const clock = new ManualClock();
  const replay = fakeSpawn(recording, clock);
  const clients: FakeProcess[] = [];
  const spawned: (readonly string[])[] = [];
  const spawn: Spawn = (spawnOptions) => {
    spawned.push(spawnOptions.cmd);
    const [, verb, name] = spawnOptions.cmd;
    if (verb === "stop") {
      void boxes.stop(name ?? "");
      return new FakeProcess({ lines: [], clock });
    }
    const child = replay.spawn(spawnOptions) as FakeProcess;
    clients.push(child);
    const box = boxes.boxes.get(BOX);
    if (box !== undefined) box.workerRunning = true;
    const gate = options.gate;
    if (gate === undefined) return child;
    const reader = child.stdout.getReader();
    return {
      get pid() {
        return child.pid;
      },
      stdin: child.stdin,
      stdout: new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            await gate;
            const { done, value } = await reader.read();
            if (done) controller.close();
            else controller.enqueue(value);
          },
        },
        { highWaterMark: 0 },
      ),
      stderr: child.stderr,
      exited: child.exited,
      kill: (signal?: Signal) => child.kill(signal),
    } satisfies ChildProcess;
  };
  const host = WorkerHost.start({
    runId: RUN,
    runDir,
    clock,
    spawn,
    killGroup: () => {},
    pid: 9271,
  });
  return { host, runDir, socket, boxes, clients, spawned, clock };
}

function eventLines(runDir: string): HostLine[] {
  return readFileSync(join(runDir, EVENTS_FILE), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as HostLine);
}

async function connect(socket: string): Promise<HostClient> {
  const connected = await connectHost(socket, { runId: RUN, clock: systemClock, timeoutMs: 2000 });
  if (!connected.ok) throw new Error(`cannot connect: ${connected.reason}`);
  return connected.client;
}

/** Sends host ops over the socket as run control's steering does. */
async function send(client: HostClient, ops: readonly HostOp[]): Promise<void> {
  for (const op of ops) {
    if ("write" in op) await client.request({ op: "write", data: op.write });
    else if ("closeStdin" in op) await client.request({ op: "closeStdin" });
    else if ("signal" in op) {
      await client.request({
        op: "signal",
        signal: op.signal,
        ...(op.afterMs === undefined ? {} : { afterMs: op.afterMs }),
      });
    }
  }
}

describe("a box worker's stream through the worker host (criteria 1 and 3)", () => {
  it("is written to events.ndjson as a Mac worker's is, and ingested into the live view", () =>
    withTempDir(async (dir) => {
      const recording = boxRecording("success-tools-subagent");
      const box = boxHost(dir, recording);
      const exit = await box.host.done;
      expect(exit).toMatchObject({ code: 0, signal: null });
      // The host started the box client with the plan's argv and the client environment only.
      expect(box.spawned[0]?.slice(0, 3)).toEqual([
        "/usr/local/bin/container",
        "exec",
        "--interactive",
      ]);
      expect(box.clients[0]?.stdinWrites[0]).toContain('"type":"user"');
      // The same stdout lines as the stream.
      const recorded = (recordedProcesses(recording.lines)[0] ?? [])
        .filter((line) => line.ch === "stdout")
        .map((line) => stdoutText(line.data));
      const lines = eventLines(box.runDir);
      expect(lines.filter((line) => line.ch === "stdout").length).toBe(recorded.length);
      // After the exit the host stopped the box once: nothing the worker started lingers there.
      expect(box.spawned.filter((cmd) => cmd[1] === "stop")).toEqual([
        ["/usr/local/bin/container", "stop", BOX],
      ]);
      expect(box.boxes.boxes.get(BOX)?.state).toBe("stopped");

      // The live view: ingestion stores the output and the usage, with no rejected start.
      const f = await ingestFixture(join(dir, "ingest"));
      try {
        appendLines(f.eventFile, lines);
        const ingestor = new Ingestor({ office: f.office, clock: f.t.clock, pricing: null });
        ingestor.track(
          target(f, boxAdapter, initialState({ plannedModel: "haiku" }) as unknown as ParseState),
        );
        ingestor.close();
        const types = loggedEvents(f.office).map((event) => event.type);
        expect(types).toContain("work.output");
        expect(types).toContain("usage.updated");
        expect(storedOutput(f.office, f.run).length).toBeGreaterThan(0);
        expect(types).not.toContain("story.parked");
      } finally {
        f.t.state.close();
      }
    }));
});

describe("the caps on a box worker's stream (criterion 3)", () => {
  const ROOMY: Caps = { budgetTokens: 1_000_000, maxTurns: 100, maxMinutes: 30 };
  let dir: string;
  let f: IngestFixture;
  let control: RunControl;
  let sent: HostOp[][];
  let work: WorkRef;
  let ingestor: Ingestor | null;

  beforeEach(async () => {
    dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "box-caps-"));
    f = await ingestFixture(dir);
    sent = [];
    ingestor = null;
    control = new RunControl({
      clock: f.t.clock,
      offices: { get: () => f.office },
      writer: {
        write: async (): Promise<BranchPark> => {
          return {
            commit: "c".repeat(40),
            lastGoodCommit: "a".repeat(40),
            from: "In Progress",
            pushed: true,
            pushError: null,
          };
        },
      },
      steering: {
        send: async (_office, _run, ops) => {
          sent.push([...ops]);
          return { ok: true };
        },
      },
      encode,
    });
    const { office, run } = f;
    const { key } = office.immediate(() =>
      addStory(office, f.t.ids, { story: StoryId.parse("DIPO-1") }, f.t.clock.now()),
    );
    work = { ...f.work, key };
    office.immediate(() => {
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
        worktree: join(dir, "trees", "DIPO-1"),
        slot: 1,
        budgetUnit: "tokens",
        budgetLimit: ROOMY.budgetTokens,
        loopCap: 3,
        reviewRoundCap: null,
        configHash: "h",
        overrideKeys: null,
        runProfileId: null,
        startedAt: f.t.clock.now(),
      });
      insertClaim(office, {
        runId: run,
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
    ingestor?.close();
    control.close();
    f.t.state.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** The parks run control recorded. */
  function parks(): { reason: string; detail: string }[] {
    return f.office.all(`select reason, detail from parks where office_id = $office_id`);
  }

  function track(caps: Caps): void {
    f.office.run(
      "update runs set budget_limit = $budget where office_id = $office_id and run_id = $run",
      { budget: caps.budgetTokens, run: f.run },
    );
    control.track(f.office.officeId, { runId: f.run, work, caps, startedAt: f.t.clock.now() });
  }

  async function ingest(recording: Recording): Promise<void> {
    appendLines(f.eventFile, hostLines(recording));
    ingestor = new Ingestor({
      office: f.office,
      clock: f.t.clock,
      pricing: null,
      hooks: control.hooks,
    });
    ingestor.track(
      target(f, boxAdapter, initialState({ plannedModel: "haiku" }) as unknown as ParseState),
    );
    await control.idle();
  }

  it("parks budget-exceeded at the token budget and sends the stop sequence", async () => {
    const recording = boxRecording("budget-engine-cap");
    const budget = recording.meta.testConfig?.["budgetTokens"] as number;
    track({ ...ROOMY, budgetTokens: budget });
    await ingest(recording);
    expect(parks().map((park) => park.reason)).toEqual(["budget-exceeded"]);
    expect(parks()[0]?.detail).toContain("token budget reached");
    expect(sent).toEqual([encode({ kind: "stop" })]);
    expect(findRun(f.office, RunId.parse(f.run))?.endKind).toBe("capped");
  });

  it("parks at the CLI's turn cap", async () => {
    track(ROOMY);
    await ingest(boxRecording("max-turns"));
    expect(parks().map((park) => [park.reason, park.detail])).toEqual([
      ["budget-exceeded", "turn cap (--max-turns) after 2 turns"],
    ]);
  });

  it("parks at the engine's summed turn cap", async () => {
    track({ ...ROOMY, maxTurns: 2 });
    await ingest(boxRecording("success-single"));
    expect(parks()[0]?.detail).toMatch(/^turn cap reached: \d+ of 2 turns$/);
  });

  it("parks at the minute cap on the next tick", async () => {
    track({ ...ROOMY, maxMinutes: 30 });
    // The box worker is still in its first turn: the stream up to its first result.
    const recording = boxRecording("success-tools-subagent");
    const first = recording.lines.findIndex(
      (line) => line.ch === "stdout" && (line.data as { type?: string }).type === "result",
    );
    await ingest({ ...recording, lines: recording.lines.slice(0, first) });
    f.t.clock.advance(31 * CAP_TICK_MS);
    await control.idle();
    expect(parks().map((park) => park.detail)).toContain(
      "time cap reached: 30 of 30 minutes since the worker started",
    );
    expect(sent.at(-1)).toEqual(encode({ kind: "stop" }));
  });
});

/** Lets the host's pending promise callbacks run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe("stopping a box worker (criterion 6)", () => {
  it("ends claude in the box at the stop sequence's SIGTERM, not only the exec client", () =>
    withTempDir(async (dir) => {
      let open!: () => void;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const box = boxHost(dir, boxRecording("success-single"), { gate });
      const state = box.boxes.boxes.get(BOX)!;
      expect(state.workerRunning).toBe(true);
      const client = await connect(box.socket);

      // The stop sequence run control sends for a cap, a budget or the stop command.
      await send(client, encode({ kind: "stop" }));
      expect(box.spawned.some((cmd) => cmd[1] === "stop")).toBe(false);
      box.clock.advance(STOP_SIGTERM_AFTER_MS);
      await settle();
      // The SIGTERM went to the exec client, and the host stopped the box with it.
      expect(box.clients[0]?.signals).toEqual(["SIGTERM"]);
      expect(box.spawned.filter((cmd) => cmd[1] === "stop")).toEqual([
        ["/usr/local/bin/container", "stop", BOX],
      ]);
      expect(state.workerRunning).toBe(false);
      open();
      await box.host.done;
      // Once only: the exit that followed did not stop the box again.
      expect(box.spawned.filter((cmd) => cmd[1] === "stop")).toHaveLength(1);
      expect(state.state).toBe("stopped");
      expect(readFileSync(join(box.runDir, "host.log"), "utf8")).toContain(
        "running the stop command",
      );
    }));

  it("ends claude in the box when only the exec client died", () =>
    withTempDir(async (dir) => {
      let open!: () => void;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const box = boxHost(dir, boxRecording("success-single"), { gate });
      const state = box.boxes.boxes.get(BOX)!;
      // A killed exec client leaves its process running in the box ...
      box.clients[0]?.kill("SIGKILL");
      expect(state.workerRunning).toBe(true);
      open();
      // ... until the host, seeing its worker gone, stops the box.
      box.clock.advance(10_000);
      await box.host.done;
      expect(state.workerRunning).toBe(false);
      expect(box.spawned.filter((cmd) => cmd[1] === "stop")).toHaveLength(1);
    }));

  it("ends claude in the box when the host itself gets SIGTERM (a follow-only host's stop)", () =>
    withTempDir(async (dir) => {
      let open!: () => void;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const box = boxHost(dir, boxRecording("success-single"), { gate });
      const state = box.boxes.boxes.get(BOX)!;
      expect(box.host.terminate()).toBe(true);
      await settle();
      // The stop command runs at the SIGTERM, before the worker has even exited.
      expect(box.spawned.filter((cmd) => cmd[1] === "stop")).toHaveLength(1);
      expect(state.workerRunning).toBe(false);
      open();
      await box.host.done;
      expect(box.spawned.filter((cmd) => cmd[1] === "stop")).toHaveLength(1);
    }));
});
