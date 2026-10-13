// The daemon's side of autostart (DIPO-63): worker hosts start in their own `systemd-run --user
// --scope` unit under systemd (AC #5), the launchd bootout after a refused `config.yaml` names
// `gui/<uid>` or, without it, `user/<uid>` (AC #6, #7), and `wait-pid` returns once the PID is gone.
// Every process is a fake; nothing touches launchctl or systemd.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import type { ChildProcess, Spawn, SpawnOptions } from "@dipsaus-orchestrator/contract";
import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { waitForPidExit } from "../../src/platform/keepawake";
import { detachedEnv, type DetachedSpawnOptions } from "../../src/platform/process";
import {
  bootoutOwnLaunchdJob,
  launchdJobPid,
  systemdScopeCommand,
  underLaunchdJob,
  underSystemdUnit,
} from "../../src/platform/supervisor";
import { launchWorkerHost } from "../../src/runs/worker-hosts";

const RUN = "run_01JZ0000000000000000000001";

/** A stream that holds `text` and is closed. */
const textStream = (text = "") =>
  new ReadableStream<Uint8Array>({
    start: (c) => {
      if (text !== "") c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });

type FakeAnswer = number | "hang" | { readonly code: number; readonly stdout: string };

function fakeSpawn(answer: (cmd: readonly string[]) => FakeAnswer) {
  const calls: (readonly string[])[] = [];
  const spawn: Spawn = (options: SpawnOptions): ChildProcess => {
    calls.push(options.cmd);
    const given = answer(options.cmd);
    const code = typeof given === "object" ? given.code : given;
    return {
      pid: 1,
      stdin: null,
      stdout: textStream(typeof given === "object" ? given.stdout : ""),
      stderr: textStream(),
      exited: code === "hang" ? new Promise(() => {}) : Promise.resolve({ code, signal: null }),
      kill: () => {},
    };
  };
  return { spawn, calls };
}

/** `launchctl print` of a running job, as launchd shows it (abridged). */
const printed = (pid: number) => ({
  code: 0,
  stdout: `gui/501/dipo.daemon = {\n\tactive count = 1\n\tstate = running\n\tpid = ${pid}\n}\n`,
});

describe("systemd scope for worker hosts", () => {
  it("detects the dipo.service cgroup", () => {
    expect(
      underSystemdUnit(
        () => "0::/user.slice/user-1000.slice/user@1000.service/app.slice/dipo.service\n",
      ),
    ).toBe(true);
    expect(underSystemdUnit(() => "0::/user.slice/user-1000.slice/session-3.scope\n")).toBe(false);
    expect(underSystemdUnit(() => null)).toBe(false);
  });

  it("starts the host inside systemd-run --user --scope when asked", () =>
    withTempDir(async (dir) => {
      const calls: DetachedSpawnOptions[] = [];
      await launchWorkerHost({
        runId: RUN,
        agentId: "agt_01JZ0000000000000000000001",
        officeDir: join(dir, "office"),
        runtimeDir: join(dir, "rt"),
        plan: { argv: ["claude"], env: {}, cwd: dir, files: [], stdin: [] },
        dipoCommand: ["/opt/dipo"],
        env: {},
        probe: async (pid) => ({ pid, startTimeMs: 0, zombie: false, command: "dipo" }),
        spawnDetached: (options) => {
          calls.push(options);
          return { pid: 77 };
        },
        systemdScope: true,
      });
      expect(calls[0]?.cmd).toEqual([
        "systemd-run",
        "--user",
        "--scope",
        "--quiet",
        `--unit=dipo-run-${RUN}`,
        "/opt/dipo",
        "daemon",
        "worker-host",
        RUN,
      ]);
      expect(systemdScopeCommand(RUN, ["x"]).slice(0, 5)).toEqual(calls[0]?.cmd.slice(0, 5) ?? []);
    }));
});

describe("launchd bootout after a refused config.yaml", () => {
  it("knows the job by XPC_SERVICE_NAME", () => {
    expect(underLaunchdJob({ XPC_SERVICE_NAME: "dipo.daemon" })).toBe(true);
    expect(underLaunchdJob({ XPC_SERVICE_NAME: "0" })).toBe(false);
    expect(underLaunchdJob({})).toBe(false);
  });

  it("reads the job's PID from launchctl print", () => {
    expect(launchdJobPid(printed(812).stdout)).toBe(812);
    expect(launchdJobPid("state = not running\n")).toBeNull();
  });

  it("boots out of gui/<uid> when launchd is the parent and the job reports this PID", async () => {
    const { spawn, calls } = fakeSpawn((cmd) => (cmd[1] === "print" ? printed(812) : 0));
    const target = await bootoutOwnLaunchdJob({
      spawn,
      uid: 501,
      pid: 812,
      ppid: 1,
      clock: new ManualClock(),
    });
    expect(target).toBe("gui/501/dipo.daemon");
    expect(calls).toEqual([
      ["launchctl", "print", "gui/501/dipo.daemon"],
      ["launchctl", "bootout", "gui/501/dipo.daemon"],
    ]);
  });

  it("uses user/<uid> over SSH, and does not wait past its cap for a bootout that hangs", async () => {
    const clock = new ManualClock();
    const { spawn, calls } = fakeSpawn((cmd) => {
      if (cmd[1] !== "print") return "hang";
      return cmd[2]?.startsWith("gui/") === true ? 113 : printed(812);
    });
    const done = bootoutOwnLaunchdJob({ spawn, uid: 501, pid: 812, ppid: 1, clock, waitMs: 3000 });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    clock.advance(3000);
    expect(await done).toBe("user/501/dipo.daemon");
    expect(calls.at(-1)).toEqual(["launchctl", "bootout", "user/501/dipo.daemon"]);
  });

  it("never boots out when launchd is not the parent (an inherited XPC_SERVICE_NAME)", async () => {
    const { spawn, calls } = fakeSpawn((cmd) => (cmd[1] === "print" ? printed(812) : 0));
    const target = await bootoutOwnLaunchdJob({
      spawn,
      uid: 501,
      pid: 812,
      ppid: 4242,
      clock: new ManualClock(),
    });
    expect(target).toBeNull();
    expect(calls).toEqual([]);
  });

  it("never boots out a job whose PID is another process (the maintainer's real daemon)", async () => {
    // Re-parented to launchd, but the installed job runs PID 700, not this process.
    const { spawn, calls } = fakeSpawn((cmd) => (cmd[1] === "print" ? printed(700) : 0));
    const target = await bootoutOwnLaunchdJob({
      spawn,
      uid: 501,
      pid: 812,
      ppid: 1,
      clock: new ManualClock(),
    });
    expect(target).toBeNull();
    expect(calls.map((c) => c[1])).toEqual(["print", "print"]);
  });

  it("strips XPC_SERVICE_NAME from every detached child's environment", () => {
    expect(detachedEnv({ XPC_SERVICE_NAME: "dipo.daemon", PATH: "/usr/bin" })).toEqual({
      PATH: "/usr/bin",
    });
  });
});

describe("waitForPidExit", () => {
  it("resolves once the PID is gone, looking every second", async () => {
    const clock = new ManualClock();
    let alive = true;
    let done = false;
    void waitForPidExit(42, clock, () => alive).then(() => {
      done = true;
    });
    clock.advance(5000);
    await Promise.resolve();
    expect(done).toBe(false);
    alive = false;
    clock.advance(1000);
    await Promise.resolve();
    expect(done).toBe(true);
  });
});
