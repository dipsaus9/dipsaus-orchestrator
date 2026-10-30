// verifyHostForSignal against real processes (DIPO-386, 0005): the check reads the live process
// table, so a process that is not this run's worker host is refused however its PID, start time or
// command line came to look like the row's. Each refused case below would be signalled without
// its check; the first case shows a real host-form process passes, so the refusals are not vacuous.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { currentPlatform } from "../../src/platform/paths";
import { systemProcessProbe } from "../../src/platform/process";
import { type WorkerHostRow, verifyHostForSignal } from "../../src/runs/worker-hosts";
import { lateHostScript } from "./fixtures/late-host-script";

const RUN = "run_01JZ0000000000000000000001";
const AGENT = "agt_01JZ0000000000000000000001";
const probe = systemProcessProbe(currentPlatform());
const HOUR = 3_600_000;

let dir = "";
/** The stand-in host at `<dir>/cli/src/main.ts`, so Bun running it is the host's source form. */
let standIn = "";
const children: Bun.Subprocess[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "verify-real-"));
  standIn = lateHostScript(dir);
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

/** A recorded, open row for `pid`, started at `startTimeMs`, written at `startedAt`. */
function rowFor(pid: number, startTimeMs: number, startedAt = startTimeMs): WorkerHostRow {
  return {
    pid,
    startTimeMs,
    runId: RUN,
    agentId: AGENT,
    socketPath: join(dir, "host.sock"),
    protocolVersion: 2,
    runDir: dir,
    eventFile: join(dir, "events.ndjson"),
    processedOffset: 0,
    exitCode: null,
    exitSignal: null,
    exitSignalInferred: false,
    finalOffset: null,
    endedAt: null,
    startedAt,
    pending: false,
    signalStop: true,
  };
}

/** Starts a real process; resolves once it runs with the command line it was given. */
async function start(
  argv: string[],
  env: Record<string, string> = {},
): Promise<{ pid: number; startTimeMs: number; command: string }> {
  const child = Bun.spawn(argv, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "ignore"],
  });
  children.push(child);
  for (let i = 0; i < 200; i += 1) {
    const info = await probe(child.pid);
    if (info !== null && info.command.endsWith(RUN)) return info;
    await Bun.sleep(10);
  }
  throw new Error(`the child ${argv.join(" ")} did not come up`);
}

/** Bun under another program name, as a wrapper or another tool would show in the process table. */
function bunNamed(name: string): string {
  const path = join(dir, name);
  symlinkSync(process.execPath, path);
  return path;
}

describe("verifyHostForSignal on real processes (DIPO-386)", () => {
  it("passes for a real process in the host's source form, with the row's start time", async () => {
    const live = await start([process.execPath, standIn, "daemon", "worker-host", RUN]);
    expect(await verifyHostForSignal(rowFor(live.pid, live.startTimeMs), probe)).toEqual({
      ok: true,
    });
  });

  it("refuses a reused PID: the live process started an hour after the recorded host", async () => {
    const live = await start([process.execPath, standIn, "daemon", "worker-host", RUN]);
    const check = await verifyHostForSignal(rowFor(live.pid, live.startTimeMs - HOUR), probe);
    expect(check).toMatchObject({ ok: false, reason: expect.stringContaining("start time") });
  });

  it("refuses a process that started before its row was written", async () => {
    const live = await start([process.execPath, standIn, "daemon", "worker-host", RUN]);
    const row = rowFor(live.pid, live.startTimeMs, live.startTimeMs + HOUR);
    const check = await verifyHostForSignal(row, probe);
    expect(check).toMatchObject({ ok: false, reason: expect.stringContaining("before its row") });
  });

  it("refuses a command that only mentions the run id, with the host's words or without", async () => {
    // Another tool whose arguments end in the host's three words.
    const grep = await start([bunNamed("grep"), standIn, "daemon", "worker-host", RUN]);
    expect(await verifyHostForSignal(rowFor(grep.pid, grep.startTimeMs), probe)).toMatchObject({
      ok: false,
    });
    // Bun running another script, with exactly the host's words after it.
    const other = join(dir, "other.ts");
    await Bun.write(other, await Bun.file(standIn).text());
    const script = await start([process.execPath, other, "daemon", "worker-host", RUN]);
    expect(await verifyHostForSignal(rowFor(script.pid, script.startTimeMs), probe)).toMatchObject({
      ok: false,
    });
    const logs = await start([process.execPath, standIn, "logs", RUN]);
    expect(await verifyHostForSignal(rowFor(logs.pid, logs.startTimeMs), probe)).toMatchObject({
      ok: false,
    });
  });

  it("refuses a shell running the host's words under sh -c", async () => {
    // A compound command, so the shell stays the process instead of exec'ing it.
    const shell = await start([
      "/bin/sh",
      "-c",
      "while :; do sleep 1; done",
      process.execPath,
      "daemon",
      "worker-host",
      RUN,
    ]);
    expect(shell.command.startsWith("/bin/sh -c")).toBe(true);
    expect(await verifyHostForSignal(rowFor(shell.pid, shell.startTimeMs), probe)).toMatchObject({
      ok: false,
    });
  });

  it("refuses an env wrapper in front of the host's binary", async () => {
    // A real env execs its command, so its PID would then be the command itself; a process still
    // shown as env in front of the host's words is a wrapper.
    const env = await start([
      bunNamed("env"),
      standIn,
      "/usr/local/bin/dipo",
      "daemon",
      "worker-host",
      RUN,
    ]);
    expect(env.command).toContain("/env ");
    expect(await verifyHostForSignal(rowFor(env.pid, env.startTimeMs), probe)).toMatchObject({
      ok: false,
    });
  });

  it("refuses a zombie of a process in the host's form", async () => {
    // The host-form child exits at once; its parent, sleep after the exec, never reaps it.
    const parent = Bun.spawn(
      [
        "/bin/sh",
        "-c",
        `"$1" "$2" daemon worker-host "$3" & echo $!; exec sleep 600`,
        "sh",
        process.execPath,
        standIn,
        RUN,
      ],
      { env: { ...process.env, LATE_HOST_EXIT: "1" }, stdio: ["ignore", "pipe", "ignore"] },
    );
    children.push(parent);
    const reader = parent.stdout.getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    const pid = Number(new TextDecoder().decode(value).trim());
    let info = await probe(pid);
    for (let i = 0; i < 300 && info !== null && !info.zombie; i += 1) {
      await Bun.sleep(10);
      info = await probe(pid);
    }
    expect(info).toMatchObject({ zombie: true });
    const zombie = info as NonNullable<typeof info>;
    expect(await verifyHostForSignal(rowFor(pid, zombie.startTimeMs), probe)).toMatchObject({
      ok: false,
    });
  });
});
