// PID identity (DIPO-23): start time from `ps -o lstart=` and `/proc/<pid>/stat` fixtures, the
// 2 s tolerance, PID reuse, zombies, and the live probe on this machine.

import { describe, expect, it } from "bun:test";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import {
  ChildProcesses,
  isDaemonCommand,
  isWorkerHostCommand,
  signalProcess,
  isSameProcess,
  parseBootTime,
  parseLstart,
  parseProcStat,
  parsePsLine,
  pidExists,
  procStartTimeMs,
  systemProcessProbe,
  type ProcessInfo,
} from "../../src/platform/process";

// `LC_ALL=C TZ=UTC ps -o stat= -o lstart= -o command= -p <pid>` on macOS.
const PS_DAEMON = "Ss   Mon Oct 12 09:52:03 2026     /usr/local/bin/dipo daemon --foreground";
const PS_PADDED_DAY = "S    Fri Oct  2 23:05:09 2026     /usr/local/bin/dipo daemon --foreground";
const PS_ZOMBIE = "Z+   Mon Oct 12 09:52:03 2026     (dipo)";
const OCT_12_095203 = Date.UTC(2026, 9, 12, 9, 52, 3);

// `/proc/<pid>/stat`: the command name may hold spaces and parentheses.
const PROC_STAT = (state: string, startTicks: number) =>
  `4242 (dipo (x) y) ${state} 1 4242 4242 0 -1 4194560 1000 0 0 0 12 3 0 0 20 0 3 0 ${startTicks} 123456789 4000 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 2 0 0 0 0 0`;
const PROC_STAT_FILE = "cpu  1 2 3 4\nintr 5\nctxt 6\nbtime 1791535923\nprocesses 7\n";

const info = (startTimeMs: number, zombie = false): ProcessInfo => ({
  pid: 4242,
  startTimeMs,
  zombie,
  command: "dipo daemon --foreground",
});

describe("ps -o lstart", () => {
  it("parses the C-locale UTC format, including a space-padded day", () => {
    expect(parseLstart("Mon Oct 12 09:52:03 2026")).toBe(OCT_12_095203);
    expect(parseLstart("Fri Oct  2 23:05:09 2026")).toBe(Date.UTC(2026, 9, 2, 23, 5, 9));
    expect(parseLstart("lun 12 oct 09:52:03 2026")).toBeNull();
  });

  it("parses a line with state, start time and command", () => {
    expect(parsePsLine(4242, PS_DAEMON)).toEqual({
      pid: 4242,
      startTimeMs: OCT_12_095203,
      zombie: false,
      command: "/usr/local/bin/dipo daemon --foreground",
    });
    expect(parsePsLine(4242, PS_PADDED_DAY)?.startTimeMs).toBe(Date.UTC(2026, 9, 2, 23, 5, 9));
    expect(parsePsLine(4242, PS_ZOMBIE)?.zombie).toBe(true);
    expect(parsePsLine(4242, "")).toBeNull();
  });
});

describe("/proc/<pid>/stat", () => {
  it("reads state and start ticks from field 22, counting from the last parenthesis", () => {
    expect(parseProcStat(PROC_STAT("S", 987_654))).toEqual({ state: "S", startTicks: 987_654 });
    expect(parseProcStat(PROC_STAT("Z", 5))?.state).toBe("Z");
    expect(parseProcStat("garbage")).toBeNull();
  });

  it("turns boot time and ticks into ms since the epoch", () => {
    expect(parseBootTime(PROC_STAT_FILE)).toBe(1_791_535_923);
    expect(procStartTimeMs(1_791_535_923, 12_345)).toBe(1_791_535_923_000 + 123_450);
  });
});

describe("isSameProcess", () => {
  const record = { pid: 4242, startTimeMs: OCT_12_095203 };

  it("matches a start time within 2 s either way", () => {
    expect(isSameProcess(record, info(OCT_12_095203))).toBe(true);
    expect(isSameProcess(record, info(OCT_12_095203 + 2000))).toBe(true);
    expect(isSameProcess(record, info(OCT_12_095203 - 2000))).toBe(true);
  });

  it("treats a later start time as PID reuse", () => {
    expect(isSameProcess(record, info(OCT_12_095203 + 2001))).toBe(false);
    expect(isSameProcess(record, info(OCT_12_095203 + 3_600_000))).toBe(false);
  });

  it("counts a zombie and a missing process as dead", () => {
    expect(isSameProcess(record, info(OCT_12_095203, true))).toBe(false);
    expect(isSameProcess(record, null)).toBe(false);
  });

  it("compares the PID too", () => {
    expect(isSameProcess({ ...record, pid: 1 }, info(OCT_12_095203))).toBe(false);
  });
});

describe("isDaemonCommand", () => {
  it("recognises the binary and the source form", () => {
    expect(isDaemonCommand("/usr/local/bin/dipo daemon --foreground")).toBe(true);
    expect(
      isDaemonCommand("bun packages/cli/src/main.ts daemon --foreground --log-level debug"),
    ).toBe(true);
    expect(isDaemonCommand("dipo daemon worker-host run_01")).toBe(false);
    expect(isDaemonCommand("vim daemon.ts")).toBe(false);
  });
});

describe("system probe", () => {
  const platform = process.platform === "linux" ? "linux" : "darwin";

  it("reads this process with a start time in the past", async () => {
    const own = await systemProcessProbe(platform)(process.pid);
    expect(own).not.toBeNull();
    expect(own?.zombie).toBe(false);
    expect(own?.command).toContain("bun");
    // Whole-second precision, so allow the tolerance against the clock reading.
    expect(own?.startTimeMs ?? Infinity).toBeLessThanOrEqual(
      performance.timeOrigin + performance.now() + 2000,
    );
  });

  it("returns null for a process that has exited", async () => {
    const child = Bun.spawn({ cmd: ["true"], stdout: "ignore", stderr: "ignore" });
    await child.exited;
    expect(pidExists(child.pid)).toBe(false);
    expect(await systemProcessProbe(platform)(child.pid)).toBeNull();
  });

  it("gives the same start time on a second reading", async () => {
    const probe = systemProcessProbe(platform);
    const first = await probe(process.pid);
    const second = await probe(process.pid);
    expect(first).not.toBeNull();
    expect(isSameProcess({ pid: process.pid, startTimeMs: first?.startTimeMs ?? 0 }, second)).toBe(
      true,
    );
  });
});

describe("ChildProcesses (DIPO-68)", () => {
  it("waits for every tracked child, including one tracked while waiting", async () => {
    const children = new ChildProcesses();
    await children.waitAll();
    const first = children.spawn(["sleep", "0.2"]);
    const waiting = children.waitAll();
    const second = children.spawn(["sleep", "0.3"]);
    expect(children.pids().toSorted()).toEqual([first.pid, second.pid].toSorted());
    await waiting;
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(children.size).toBe(0);
  });

  it("kills the whole process group of a child still running", async () => {
    await withTempDir(async (dir) => {
      const children = new ChildProcesses();
      const grandchildFile = join(dir, "grandchild.pid");
      const child = children.spawn([
        "/bin/sh",
        "-c",
        `sleep 30 & echo $! > "${grandchildFile}"; wait`,
      ]);
      for (let i = 0; i < 100 && !existsSync(grandchildFile); i++) await Bun.sleep(20);
      const grandchild = Number(readFileSync(grandchildFile, "utf8").trim());
      expect(pidExists(grandchild)).toBe(true);

      expect(children.killGroups("SIGKILL")).toEqual([child.pid]);
      await children.waitAll();
      expect(child.signalCode).toBe("SIGKILL");
      for (let i = 0; i < 100 && pidExists(grandchild); i++) await Bun.sleep(20);
      expect(pidExists(grandchild)).toBe(false);
    });
  });
});

describe("isWorkerHostCommand (DIPO-93)", () => {
  const RUN = "run_01JZ0000000000000000000001";

  it("matches `dipo daemon worker-host <run>` for exactly that run, from the binary or source", () => {
    expect(isWorkerHostCommand(`/usr/local/bin/dipo daemon worker-host ${RUN}`, RUN)).toBe(true);
    expect(isWorkerHostCommand(`/opt/bun /src/cli/main.ts daemon worker-host ${RUN}`, RUN)).toBe(
      true,
    );
    // A binary path with spaces still ends in the same three arguments.
    expect(isWorkerHostCommand(`/Users/m/My Tools/dipo daemon worker-host ${RUN}`, RUN)).toBe(true);
  });

  it("refuses another run, another form, extra arguments or another program", () => {
    expect(isWorkerHostCommand("dipo daemon worker-host run_01JZ0000000000000000000002", RUN)).toBe(
      false,
    );
    expect(isWorkerHostCommand(`dipo daemon worker-host ${RUN} --x`, RUN)).toBe(false);
    expect(isWorkerHostCommand(`dipo hook worker-host ${RUN}`, RUN)).toBe(false);
    expect(isWorkerHostCommand(`daemon worker-host ${RUN}`, RUN)).toBe(false);
    expect(isWorkerHostCommand(`vim ${RUN}`, RUN)).toBe(false);
    expect(isWorkerHostCommand("", RUN)).toBe(false);
  });
});

describe("signalProcess (DIPO-93)", () => {
  it("never signals PID 1, a non-PID or this process itself", () => {
    expect(signalProcess(1, "SIGTERM")).toBe(false);
    expect(signalProcess(0, "SIGTERM")).toBe(false);
    expect(signalProcess(-5, "SIGTERM")).toBe(false);
    expect(signalProcess(1.5, "SIGTERM")).toBe(false);
    expect(signalProcess(process.pid, "SIGTERM")).toBe(false);
  });

  it("signals one child process", async () => {
    const child = Bun.spawn({ cmd: ["/bin/sleep", "30"], stdout: "ignore", stderr: "ignore" });
    expect(signalProcess(child.pid, "SIGTERM")).toBe(true);
    await child.exited;
    expect(child.signalCode).toBe("SIGTERM");
    // Gone now: nothing to signal.
    expect(signalProcess(child.pid, "SIGTERM")).toBe(false);
  });
});
