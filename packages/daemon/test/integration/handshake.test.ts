// The PID lock's step 1 (0005, DIPO-24 AC #10): the handshake is `engine.hello` and then
// `daemon.status` over `ws+unix://`, and it counts only when the status names the record's PID.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  helloHandshake,
  systemClock,
  writeRuntimeRecord,
  type PidRecord,
} from "@dipsaus-orchestrator/engine/platform";
import { makeTempDir, removeTempDir } from "@dipsaus-orchestrator/testkit";

import { startHarness, TEST_VERSION, type Harness } from "../support/harness";

let dir: string;
let harness: Harness;

const record = (pid: number): PidRecord => ({
  pid,
  startTimeMs: 1,
  version: TEST_VERSION,
  runtimeDir: null,
});

beforeEach(async () => {
  dir = makeTempDir();
  harness = await startHarness(dir);
  mkdirSync(join(dir, "state"), { recursive: true });
  writeRuntimeRecord(join(dir, "state"), {
    runtimeDir: dir,
    socket: harness.socketPath,
    pid: process.pid,
    startTimeMs: 1,
    version: TEST_VERSION,
  });
});

afterEach(async () => {
  await harness.close();
  removeTempDir(dir);
});

function handshake() {
  return helloHandshake({
    stateDir: join(dir, "state"),
    clock: systemClock,
    client: { name: "test", version: "0" },
    timeoutMs: 2000,
  });
}

describe("helloHandshake", () => {
  it("reports a daemon that answers engine.hello and daemon.status with the record's PID", async () => {
    expect(await handshake()(record(process.pid))).toBe(true);
  });

  it("does not count a runtime record or status of another PID", async () => {
    expect(await handshake()(record(process.pid + 1))).toBe(false);
  });

  it("does not count a runtime record written by another process with the same PID", async () => {
    // A reused PID: the record's start time differs from the one the socket's daemon wrote.
    expect(await handshake()({ ...record(process.pid), startTimeMs: 2 })).toBe(false);
  });

  it("does not count a socket nobody serves", async () => {
    await harness.socket.stop();
    expect(await handshake()(record(process.pid))).toBe(false);
  });
});
