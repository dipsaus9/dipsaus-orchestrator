// `hostSocketSteering` against a real host process that binds its socket late (DIPO-411): a send
// to a recorded host whose socket is not bound yet is asked again until it answers, up to the
// host's launch deadline (`connectWhenBound`), so a stop sent while the host starts reaches it. Past
// the launch deadline one attempt is made, as before. The stand-in (`late-host.ts`) binds only once
// the test creates its gate file, and appends every op it gets to a file.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { RunId } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../../src/db/office";
import { systemClock } from "../../src/platform/clock";
import { recordWorkerHost } from "../../src/records/worker-hosts";
import { HOST_LAUNCH_DEADLINE_MS, hostSocketSteering } from "../../src/run/hosts";
import { addOffice, openTestState, type TestState } from "../commands/helpers";

const LATE_HOST = resolve(import.meta.dir, "../host/fixtures/late-host.ts");

let dir = "";
let t: TestState;
let office: OfficeHandle;
const children: Bun.Subprocess[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "steer-"));
  t = await openTestState(dir);
  office = addOffice(t);
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  t.state.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Starts the stand-in host of `run`, which binds `<dir>/<name>.sock` once its gate exists. */
function lateHost(run: RunId, name: string) {
  const socketPath = join(dir, `${name}.sock`);
  const gate = join(dir, `${name}.gate`);
  const ops = join(dir, `${name}.ops`);
  const child = Bun.spawn([process.execPath, LATE_HOST, "daemon", "worker-host", run], {
    env: { ...process.env, LATE_HOST_SOCKET: socketPath, LATE_HOST_GATE: gate, LATE_HOST_OPS: ops },
    stdio: ["ignore", "ignore", "ignore"],
  });
  children.push(child);
  return { pid: child.pid, socketPath, gate, ops };
}

/** The recorded host row, written `ago` ms before now. */
function record(run: RunId, host: { pid: number; socketPath: string }, ago = 0): void {
  recordWorkerHost(
    office,
    {
      pid: host.pid,
      startTimeMs: 1,
      runId: run,
      agentId: `agt_${run.slice(4)}`,
      socketPath: host.socketPath,
      protocolVersion: 3,
      runDir: dir,
      eventFile: join(dir, "events.ndjson"),
      launchDeadline: systemClock.now() - ago + HOST_LAUNCH_DEADLINE_MS,
    },
    { ...systemClock, now: () => systemClock.now() - ago },
  );
}

describe("hostSocketSteering while the host starts (DIPO-411)", () => {
  it("asks a host that has not bound its socket yet again, and the stop reaches it once it binds", async () => {
    const run = RunId.parse(t.ids.next("run"));
    const host = lateHost(run, "a");
    record(run, host);
    const steering = hostSocketSteering({ clock: systemClock });
    const sending = steering.send(office, run, [{ closeStdin: true }, { signal: "SIGTERM" }]);
    // The send is under way while the socket is not bound.
    await Bun.sleep(300);
    expect(existsSync(host.socketPath)).toBe(false);
    writeFileSync(host.gate, "");
    expect(await sending).toEqual({ ok: true });
    expect(readFileSync(host.ops, "utf8").trim().split("\n")).toEqual(["closeStdin", "signal"]);
  });

  it("stops asking a starting host once the daemon is closing", async () => {
    const run = RunId.parse(t.ids.next("run"));
    const host = lateHost(run, "c");
    record(run, host);
    let closing = false;
    const steering = hostSocketSteering({ clock: systemClock, stopped: () => closing });
    const sending = steering.send(office, run, [{ closeStdin: true }]);
    await Bun.sleep(100);
    closing = true;
    const begun = performance.now();
    expect(await sending).toMatchObject({
      ok: false,
      reason: expect.stringContaining("unreachable"),
    });
    expect(performance.now() - begun).toBeLessThan(1_000);
  });

  it("makes one attempt at a host past its launch deadline, as before", async () => {
    const run = RunId.parse(t.ids.next("run"));
    const host = lateHost(run, "b");
    record(run, host, HOST_LAUNCH_DEADLINE_MS + 1_000);
    const steering = hostSocketSteering({ clock: systemClock });
    const begun = performance.now();
    const sent = await steering.send(office, run, [{ closeStdin: true }]);
    expect(sent).toMatchObject({ ok: false, reason: expect.stringContaining("unreachable") });
    expect(performance.now() - begun).toBeLessThan(1_000);
    expect(existsSync(host.ops)).toBe(false);
  });
});
