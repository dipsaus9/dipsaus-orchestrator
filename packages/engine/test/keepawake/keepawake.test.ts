// Keep-awake while work is active (DIPO-63, 0006 decision 12) on the manual clock with fake
// keep-awake processes, so no real assertion is ever taken: one assertion is requested when work
// starts and released 2 minutes after the last work ends (AC #1); the assertion is
// `caffeinate -i -w` (0004: macOS only), and `daemon.status` says why it is not held (AC #2).

import { describe, expect, it } from "bun:test";

import { ManualClock } from "@dipsaus-orchestrator/testkit";

import {
  KeepAwake,
  KeepAwakeHolder,
  KEEP_AWAKE_RELEASE_MS,
  NO_WORK,
  type WorkActivity,
} from "../../src/keepawake/index";
import { createLogger } from "../../src/log/logger";
import {
  keepAwakeCommand,
  KeepAwakeMissingError,
  type KeepAwakeExit,
  type KeepAwakeProcess,
  type SpawnKeepAwake,
} from "../../src/platform/keepawake";

const DAEMON_PID = 4242;
const LID = "closing the lid on battery still sleeps the Mac";

interface FakeProcess extends KeepAwakeProcess {
  readonly cmd: readonly string[];
  killed: boolean;
  exit(exit: Partial<KeepAwakeExit>): void;
}

/** Fake keep-awake processes; `refuse` decides which commands exit at once and with what. */
function fakeSpawn(refuse: (cmd: readonly string[]) => string | "missing" | null = () => null) {
  const started: FakeProcess[] = [];
  let nextPid = 900;
  const spawn: SpawnKeepAwake = (cmd) => {
    const refusal = refuse(cmd);
    if (refusal === "missing") throw new KeepAwakeMissingError(cmd[0]);
    const { promise: exited, resolve } = Promise.withResolvers<KeepAwakeExit>();
    const process: FakeProcess = {
      pid: nextPid++,
      cmd,
      killed: false,
      exited,
      kill() {
        process.killed = true;
        resolve({ code: null, signal: "SIGTERM", stderr: "" });
      },
      exit(exit) {
        resolve({ code: 1, signal: null, stderr: "", ...exit });
      },
    };
    if (refusal !== null) process.exit({ code: 1, stderr: `${refusal}\n` });
    started.push(process);
    return process;
  };
  return { spawn, started };
}

function setup(refuse?: (cmd: readonly string[]) => string | "missing" | null) {
  const clock = new ManualClock();
  const fake = fakeSpawn(refuse);
  const logger = createLogger({ clock, sinks: [], component: "test" });
  const holder = new KeepAwakeHolder({
    daemonPid: DAEMON_PID,
    env: { PATH: "/usr/bin" },
    spawn: fake.spawn,
    clock,
    logger,
    settleMs: 1000,
  });
  let activity: WorkActivity = NO_WORK;
  const keepAwake = new KeepAwake({
    holder,
    read: async () => activity,
    clock,
    logger,
  });
  /** Sets the activity and runs one poll, moving the clock only while a settle time is due. */
  const poll = async (next: WorkActivity) => {
    activity = next;
    let finished = false;
    const done = keepAwake.poll().then(() => {
      finished = true;
    });
    for (;;) {
      for (let j = 0; j < 10; j++) await Promise.resolve();
      if (finished) break;
      clock.advance(1000);
    }
    await done;
  };
  return { clock, keepAwake, poll, started: fake.started };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("keepAwakeCommand", () => {
  it("is caffeinate -i -w on the daemon's pid, and never systemd-inhibit (0004)", () => {
    expect(keepAwakeCommand(DAEMON_PID)).toEqual(["caffeinate", "-i", "-w", "4242"]);
  });
});

describe("KeepAwake", () => {
  it("requests the assertion when a run starts and releases it 2 minutes after it ends", async () => {
    const { clock, keepAwake, poll, started } = setup();
    await poll(NO_WORK);
    expect(started).toEqual([]);
    expect(keepAwake.status()).toEqual({ held: false });

    await poll({ runs: 1, verifies: 0, waiting: 0 });
    expect(started.map((p) => p.cmd)).toEqual([["caffeinate", "-i", "-w", "4242"]]);
    expect(keepAwake.status()).toEqual({
      held: true,
      reason: "1 run active; closing the lid on battery still sleeps the Mac",
    });

    await poll(NO_WORK);
    const ended = clock.now();
    clock.advanceTo(ended + KEEP_AWAKE_RELEASE_MS - 1);
    expect(started[0]?.killed).toBe(false);
    expect(keepAwake.status().held).toBe(true);
    clock.advanceTo(ended + KEEP_AWAKE_RELEASE_MS);
    expect(started[0]?.killed).toBe(true);
    await flush();
    expect(keepAwake.status()).toEqual({ held: false });
    expect(started).toHaveLength(1);
  });

  it("keeps one assertion for work that resumes within the 2 minutes", async () => {
    const { clock, keepAwake, poll, started } = setup();
    await poll({ runs: 0, verifies: 1, waiting: 0 });
    expect(keepAwake.status()).toEqual({ held: true, reason: `1 verify running; ${LID}` });
    await poll(NO_WORK);
    clock.advance(60_000);
    await poll({ runs: 2, verifies: 0, waiting: 1 });
    expect(keepAwake.status()).toEqual({
      held: true,
      reason: `2 runs active, 1 claimed story waiting to start; ${LID}`,
    });
    clock.advance(KEEP_AWAKE_RELEASE_MS * 2);
    expect(started).toHaveLength(1);
    expect(started[0]?.killed).toBe(false);
    await keepAwake.stop();
    expect(started[0]?.killed).toBe(true);
  });

  it("counts a confirmed batch waiting to start as work", async () => {
    const { keepAwake, poll, started } = setup();
    await poll({ runs: 0, verifies: 0, waiting: 1 });
    expect(started).toHaveLength(1);
    expect(keepAwake.status().held).toBe(true);
  });

  it("reports why when caffeinate exits at once, and when it is missing", async () => {
    const refused = setup(() => "caffeinate: refused");
    await refused.poll({ runs: 1, verifies: 0, waiting: 0 });
    expect(refused.keepAwake.status()).toEqual({ held: false, reason: "caffeinate: refused" });
    // It does not try again on every poll while the work goes on.
    await refused.poll({ runs: 1, verifies: 0, waiting: 0 });
    expect(refused.started).toHaveLength(1);

    const missing = setup(() => "missing");
    await missing.poll({ runs: 1, verifies: 0, waiting: 0 });
    expect(missing.keepAwake.status()).toEqual({ held: false, reason: "caffeinate not found" });
  });

  it("starts a new process when the old one ended on its own", async () => {
    const { keepAwake, poll, started } = setup();
    await poll({ runs: 1, verifies: 0, waiting: 0 });
    started[0]?.exit({ code: null, signal: "SIGKILL" });
    await flush();
    expect(keepAwake.status()).toEqual({
      held: false,
      reason: "the keep-awake process ended by SIGKILL",
    });
    await poll({ runs: 1, verifies: 0, waiting: 0 });
    expect(started).toHaveLength(2);
    expect(keepAwake.status().held).toBe(true);
  });

  it("polls on its own clock and stops with the daemon", async () => {
    const { clock, keepAwake, started } = setup();
    keepAwake.start();
    await flush();
    clock.advance(15_000);
    await flush();
    await keepAwake.stop();
    expect(clock.pendingTimers).toBe(0);
    expect(started).toEqual([]);
  });
});
