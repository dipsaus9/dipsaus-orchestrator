// PID identity (DIPO-23): start time from `kinfo_proc` and `kern.procargs2` buffers (DIPO-114) and
// `/proc/<pid>/stat` fixtures, the 2 s tolerance, PID reuse, zombies, and the live probe on this
// machine: a live PID, a dead PID and a zombie, and on macOS the same reading as `/bin/ps`.

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
  darwinProcessInfo,
  KINFO_PROC_SIZE,
  kinfoOutcome,
  parseKinfoProc,
  parseProcArgs,
  parseProcStat,
  pidExists,
  procStartTimeMs,
  systemProcessProbe,
  systemSpawn,
  type ProcessInfo,
} from "../../src/platform/process";

import { watchRejections } from "./rejections";

// `struct kinfo_proc` from `kern.proc.pid.<pid>` on macOS: `p_starttime` at 0, `p_stat` at 36,
// `p_comm` at 243. Running is `SRUN` (2), a zombie `SZOMB` (5).
function kinfoBuffer(startSeconds: number, stat: number, comm: string): Uint8Array {
  const buffer = new Uint8Array(KINFO_PROC_SIZE);
  const view = new DataView(buffer.buffer);
  view.setBigInt64(0, BigInt(startSeconds), true);
  view.setInt32(8, 746_958, true);
  buffer[36] = stat;
  buffer.set(new TextEncoder().encode(comm).subarray(0, 16), 243);
  return buffer;
}

// `kern.procargs2.<pid>`: argc, the executable path, NUL padding, the arguments, the environment.
function procArgsBuffer(execPath: string, args: readonly string[], env: readonly string[] = []) {
  const strings = [...args, ...env].map((s) => `${s}\0`).join("");
  const bytes = new TextEncoder().encode(`${execPath}\0\0\0${strings}`);
  const buffer = new Uint8Array(4 + bytes.byteLength);
  new DataView(buffer.buffer).setInt32(0, args.length, true);
  buffer.set(bytes, 4);
  return buffer;
}

const OCT_12_095203 = Date.UTC(2026, 9, 12, 9, 52, 3);

/** The command line of `spawnReady`, as the probes show it: arguments joined by spaces. */
const READY_CMD = ["/bin/sh", "-c", "echo ready; read line"];
const READY_COMMAND = READY_CMD.join(" ");

/**
 * Spawns `READY_CMD` and returns once the child has written its `ready` line from its own program.
 * Linux shows an empty command line until the exec, so a probe read straight after `Bun.spawn`
 * can see nothing (DIPO-171). The line is only written after the exec, so the command is final.
 */
async function spawnReady(): Promise<Bun.Subprocess<"pipe", "pipe", "ignore">> {
  const child = Bun.spawn({ cmd: READY_CMD, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("ready\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`the ready child exited before its ready line: ${text}`);
    text += decoder.decode(value);
  }
  reader.releaseLock();
  return child;
}

/**
 * Runs `fn` with the PID of a zombie: the shell's background child exits at once and is never
 * reaped, because `exec` replaces the shell with a `sleep` that does not wait for children.
 */
async function withZombie(fn: (pid: number) => Promise<void>): Promise<void> {
  const parent = Bun.spawn({
    cmd: ["/bin/sh", "-c", "/bin/sleep 0 & echo $!; exec /bin/sleep 30"],
    stdout: "pipe",
    stderr: "ignore",
  });
  try {
    const { value } = await parent.stdout.getReader().read();
    const pid = Number(new TextDecoder().decode(value).trim());
    const probe = systemProcessProbe(process.platform === "linux" ? "linux" : "darwin");
    for (let i = 0; i < 100 && (await probe(pid))?.zombie !== true; i++) await Bun.sleep(20);
    await fn(pid);
  } finally {
    parent.kill("SIGKILL");
    await parent.exited;
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** One process as `LC_ALL=C TZ=UTC /bin/ps -o stat= -o lstart= -o command=` shows it. */
async function readPs(pid: number): Promise<ProcessInfo | null> {
  const child = Bun.spawn({
    cmd: ["/bin/ps", "-o", "stat=", "-o", "lstart=", "-o", "command=", "-p", String(pid)],
    env: { LC_ALL: "C", TZ: "UTC", PATH: "/usr/bin:/bin" },
    stdout: "pipe",
    stderr: "ignore",
  });
  const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) return null;
  const [stat = "", , month = "", day, time = "", year, ...command] = text.trim().split(/\s+/);
  const [hours, minutes, seconds] = time.split(":").map(Number);
  const startTimeMs = Date.UTC(
    Number(year),
    MONTHS.indexOf(month),
    Number(day),
    hours,
    minutes,
    seconds,
  );
  return { pid, startTimeMs, zombie: stat.startsWith("Z"), command: command.join(" ") };
}

/** False on Linux, and inside the macOS sandbox, which refuses to exec the setuid `/bin/ps`. */
async function psRuns(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try {
    return (await readPs(process.pid)) !== null;
  } catch {
    return false;
  }
}

const PS_RUNS = await psRuns();

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

describe("kern.proc.pid and kern.procargs2 (DIPO-114)", () => {
  it("reads whole-second start time, zombie state and comm from kinfo_proc", () => {
    expect(parseKinfoProc(kinfoBuffer(OCT_12_095203 / 1000, 2, "dipo"))).toEqual({
      startSeconds: OCT_12_095203 / 1000,
      zombie: false,
      comm: "dipo",
    });
    expect(parseKinfoProc(kinfoBuffer(OCT_12_095203 / 1000, 5, "dipo"))?.zombie).toBe(true);
    expect(parseKinfoProc(kinfoBuffer(1, 2, "a-very-long-command-name"))?.comm).toBe(
      "a-very-long-comm",
    );
  });

  it("finds no process in an empty or short kinfo_proc", () => {
    expect(parseKinfoProc(new Uint8Array(0))).toBeNull();
    expect(parseKinfoProc(kinfoBuffer(1, 2, "dipo").subarray(0, 100))).toBeNull();
    expect(parseKinfoProc(new Uint8Array(KINFO_PROC_SIZE))).toBeNull();
  });

  it("reads a process as gone only when the sysctl succeeds with no bytes", () => {
    expect(kinfoOutcome(7, 0, new Uint8Array(0))).toBeNull();
    expect(kinfoOutcome(7, 0, kinfoBuffer(1_791_535_923, 2, "dipo"))).toEqual({
      startSeconds: 1_791_535_923,
      zombie: false,
      comm: "dipo",
    });
  });

  it("throws, never reads as dead, when the sysctl fails or returns a malformed kinfo_proc", () => {
    // EPERM from a Seatbelt denial, EINVAL or ENOMEM all come back as -1.
    expect(() => kinfoOutcome(7, -1, new Uint8Array(KINFO_PROC_SIZE))).toThrow(
      "cannot read process 7: sysctl kern.proc.pid returned -1",
    );
    expect(() => kinfoOutcome(7, 0, new Uint8Array(100))).toThrow("malformed kinfo_proc");
    expect(() => kinfoOutcome(7, 0, new Uint8Array(KINFO_PROC_SIZE))).toThrow(
      "malformed kinfo_proc",
    );
  });

  it("joins the arguments with spaces, leaving out the executable path and the environment", () => {
    expect(
      parseProcArgs(
        procArgsBuffer(
          "/usr/local/bin/dipo",
          ["/usr/local/bin/dipo", "daemon", "--foreground"],
          ["HOME=/Users/me"],
        ),
      ),
    ).toBe("/usr/local/bin/dipo daemon --foreground");
    expect(
      parseProcArgs(procArgsBuffer("/b", ["/Users/m/My Tools/dipo", "daemon", "worker-host", "r"])),
    ).toBe("/Users/m/My Tools/dipo daemon worker-host r");
  });

  it("refuses malformed procargs", () => {
    expect(parseProcArgs(new Uint8Array(0))).toBeNull();
    expect(parseProcArgs(procArgsBuffer("/b", []))).toBeNull();
    const truncated = procArgsBuffer("/b", ["one", "two"]);
    new DataView(truncated.buffer).setInt32(0, 5, true);
    expect(parseProcArgs(truncated)).toBeNull();
  });

  it("names the command as ps does: <defunct> for a zombie, (comm) without arguments", () => {
    const start = OCT_12_095203 / 1000;
    expect(
      darwinProcessInfo(7, { startSeconds: start, zombie: false, comm: "dipo" }, "a b"),
    ).toEqual({ pid: 7, startTimeMs: OCT_12_095203, zombie: false, command: "a b" });
    expect(
      darwinProcessInfo(7, { startSeconds: start, zombie: false, comm: "dipo" }, null).command,
    ).toBe("(dipo)");
    expect(
      darwinProcessInfo(7, { startSeconds: start, zombie: true, comm: "dipo" }, "a b").command,
    ).toBe("<defunct>");
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

  it("reads a child's full command line", async () => {
    const child = await spawnReady();
    try {
      const read = await systemProcessProbe(platform)(child.pid);
      expect(read).toMatchObject({ pid: child.pid, zombie: false, command: READY_COMMAND });
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  });

  it("reports a zombie as one, and as not the same process", async () => {
    await withZombie(async (pid) => {
      const read = await systemProcessProbe(platform)(pid);
      expect(read).not.toBeNull();
      expect(read?.zombie).toBe(true);
      if (platform === "darwin") expect(read?.command).toBe("<defunct>");
      expect(isSameProcess({ pid, startTimeMs: read?.startTimeMs ?? 0 }, read)).toBe(false);
    });
  });

  // Outside the sandbox only: Seatbelt refuses to exec the setuid `/bin/ps` (DIPO-114).
  it.skipIf(!PS_RUNS)("reads the same as /bin/ps on macOS: live, child and zombie", async () => {
    const probe = systemProcessProbe("darwin");
    const child = await spawnReady();
    try {
      await withZombie(async (zombie) => {
        for (const pid of [process.pid, child.pid, zombie]) {
          expect(await probe(pid)).toEqual(await readPs(pid));
        }
      });
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
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

// Measured on Bun 1.4.2 (macOS arm64): after the child exited, `flush()` and `end()` return plain
// values here; a promise they may return elsewhere is covered by `ignoreRejection` in
// background.test.ts. This keeps the wrapper from turning either into an unhandled rejection.
describe("systemSpawn stdin (DIPO-117)", () => {
  it("writes to and closes the pipe of a child that already exited without an unhandled rejection", async () => {
    const watch = watchRejections();
    const child = systemSpawn({ cmd: ["/bin/sh", "-c", "exit 0"], stdin: "pipe" });
    expect(await child.exited).toEqual({ code: 0, signal: null });
    try {
      child.stdin?.write("too late\n");
    } catch {
      // A sync throw reaches the caller, as before; only rejections are dropped.
    }
    try {
      child.stdin?.end();
    } catch {
      // Likewise.
    }
    expect(await watch.stop()).toEqual([]);
  });
});
