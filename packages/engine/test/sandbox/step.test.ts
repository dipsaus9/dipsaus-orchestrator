// `runSandboxedStep` with a fake sandbox host and the manual clock (DIPO-37): fail-closed
// `startFailed`, the temp root, the allowlisted environment, the script timeout and the output.

import { describe, expect, it } from "bun:test";

import type { ChildExit, ChildProcess, Signal } from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import type { SandboxTools, SrtSettings } from "../../src/sandbox/policy";
import { evaluateProbe, type ProbeResult } from "../../src/sandbox/probe";
import {
  capture,
  KILL_GRACE_MS,
  runSandboxedStep,
  SANDBOX_REFUSED_EXIT_CODE,
  SANDBOX_REFUSED_MARKER,
  type SandboxHost,
  type StepRequest,
} from "../../src/sandbox/step";

const TEMP_ROOT = "/tmp/dipo-s-test01";

type FakeChild = ChildProcess & {
  finish(exit: ChildExit, stdout?: string, stderr?: string): void;
  readonly signals: Signal[];
};

function fakeChild(): FakeChild {
  const exit = Promise.withResolvers<ChildExit>();
  let out: ReadableStreamDefaultController<Uint8Array> | undefined;
  let err: ReadableStreamDefaultController<Uint8Array> | undefined;
  const signals: Signal[] = [];
  return {
    pid: 4242,
    stdin: null,
    stdout: new ReadableStream({ start: (c) => void (out = c) }),
    stderr: new ReadableStream({ start: (c) => void (err = c) }),
    exited: exit.promise,
    kill: (signal: Signal = "SIGTERM") => void signals.push(signal),
    signals,
    finish(result, stdout = "", stderr = "") {
      if (stdout !== "") out?.enqueue(new TextEncoder().encode(stdout));
      if (stderr !== "") err?.enqueue(new TextEncoder().encode(stderr));
      out?.close();
      err?.close();
      exit.resolve(result);
    },
  };
}

type Recorder = {
  host: SandboxHost;
  child: FakeChild;
  started: Parameters<SandboxHost["start"]>[0][];
  policies: SrtSettings[];
  removed: string[];
  probedTools: SandboxTools[];
  trustInputs: Parameters<SandboxHost["trustCheck"]>[0][];
  refusal: string | null;
  distrust: string[];
};

const TOOLS: SandboxTools = { rg: "/usr/bin/rg", bwrap: "/usr/bin/bwrap", socat: "/usr/bin/socat" };

function fakeHost(probe: ProbeResult = { ok: true }): Recorder {
  const child = fakeChild();
  const rec: Recorder = {
    child,
    started: [],
    policies: [],
    removed: [],
    probedTools: [],
    trustInputs: [],
    refusal: null,
    distrust: [],
    host: {
      resolveTools: async () => TOOLS,
      trustCheck: async (input) => {
        rec.trustInputs.push(input);
        return rec.distrust;
      },
      probe: async (tools) => {
        rec.probedTools.push(tools);
        return probe;
      },
      readRefusal: async () => rec.refusal,
      createTempRoot: async () => TEMP_ROOT,
      removeTempRoot: async (root) => void rec.removed.push(root),
      writePolicy: async (root, settings) => {
        rec.policies.push(settings);
        return `${root}.policy.json`;
      },
      start: (options) => {
        rec.started.push(options);
        return child;
      },
    },
  };
  return rec;
}

const REQUEST: StepRequest = {
  kind: "verify",
  script: "verify",
  command: ["bun", "run", "verify"],
  worktree: "/src/p.worktrees/P-1",
  mainCheckout: "/src/p",
  home: "/home/m",
  uid: 501,
  dipoDirs: ["/home/m/.local/state/dipo"],
  sandbox: { toolchainPaths: ["~/.bun/install/cache"], registryHosts: ["registry.npmjs.org"] },
  scriptMinutes: { install: 15, verify: 20 },
  env: {
    PATH: "/usr/bin:/bin",
    HOME: "/home/m",
    GH_TOKEN: "secret",
    NPM_TOKEN: "secret",
    ANTHROPIC_API_KEY: "secret",
    BUN_OPTIONS: "--preload ./x.ts",
    TMPDIR: "/var/folders/xyz",
  },
};

/** Lets pending promise callbacks run. */
const settle = () => new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
async function settleMany(): Promise<void> {
  for (let i = 0; i < 20; i++) await settle();
}

describe("runSandboxedStep", () => {
  it("returns startFailed with the reasons when the probe fails, and runs nothing", async () => {
    const missingRg = evaluateProbe({
      platform: "darwin",
      rg: null,
      bwrap: null,
      socat: null,
      restrictUserns: null,
      os: null,
    });
    const rec = fakeHost(missingRg);
    const result = await runSandboxedStep(
      { clock: new ManualClock(), platform: "darwin", host: rec.host },
      REQUEST,
    );
    expect(result).toEqual({
      outcome: "startFailed",
      reason: "sandbox unavailable: ripgrep (rg) is not installed or not on PATH",
    });
    expect(rec.started).toEqual([]);
    expect(rec.removed).toEqual([TEMP_ROOT]);
  });

  it("returns startFailed for bubblewrap 0.4.1 on Linux", async () => {
    const old = evaluateProbe({
      platform: "linux",
      rg: "/usr/bin/rg",
      bwrap: { path: "/usr/bin/bwrap", version: "bubblewrap 0.4.1" },
      socat: "/usr/bin/socat",
      restrictUserns: "0",
      os: { id: "ubuntu", versionId: "22.04" },
    });
    const rec = fakeHost(old);
    const result = await runSandboxedStep(
      { clock: new ManualClock(), platform: "linux", host: rec.host },
      REQUEST,
    );
    expect(result).toEqual({
      outcome: "startFailed",
      reason: "sandbox unavailable: bubblewrap 0.4.1 is older than 0.5.0",
    });
    expect(rec.started).toEqual([]);
  });

  it("returns startFailed when the probe itself throws", async () => {
    const rec = fakeHost();
    rec.host.probe = async () => {
      throw new Error("spawn failed");
    };
    const result = await runSandboxedStep(
      { clock: new ManualClock(), platform: "darwin", host: rec.host },
      REQUEST,
    );
    expect(result).toEqual({
      outcome: "startFailed",
      reason: "sandbox probe failed: spawn failed",
    });
  });

  it("returns startFailed when sandbox-exec cannot be spawned", async () => {
    const rec = fakeHost();
    rec.host.start = () => {
      throw new Error("ENOENT");
    };
    const result = await runSandboxedStep(
      { clock: new ManualClock(), platform: "darwin", host: rec.host },
      REQUEST,
    );
    expect(result).toEqual({
      outcome: "startFailed",
      reason: "could not start dipo daemon sandbox-exec: ENOENT",
    });
    expect(rec.removed).toEqual([TEMP_ROOT]);
  });

  it("returns startFailed when sandbox-exec wrote a refusal file", async () => {
    const rec = fakeHost();
    rec.refusal = "seccomp not available - unix socket access not restricted";
    const running = runSandboxedStep(
      { clock: new ManualClock(), platform: "linux", host: rec.host },
      REQUEST,
    );
    await settleMany();
    rec.child.finish(
      { code: SANDBOX_REFUSED_EXIT_CODE, signal: null },
      "",
      `${SANDBOX_REFUSED_MARKER}seccomp not available - unix socket access not restricted\n`,
    );
    expect(await running).toEqual({
      outcome: "startFailed",
      reason: "sandbox refused to start: seccomp not available - unix socket access not restricted",
    });
  });

  it("treats a faked refusal line with exit 125 as an ordinary failure", async () => {
    const rec = fakeHost();
    const running = runSandboxedStep(
      { clock: new ManualClock(), platform: "linux", host: rec.host },
      REQUEST,
    );
    await settleMany();
    rec.child.finish(
      { code: SANDBOX_REFUSED_EXIT_CODE, signal: null },
      "",
      `${SANDBOX_REFUSED_MARKER}faked by worker code\n`,
    );
    expect(await running).toMatchObject({ outcome: "exited", code: SANDBOX_REFUSED_EXIT_CODE });
  });

  it("refuses untrusted paths before the probe runs anything", async () => {
    const rec = fakeHost();
    rec.distrust = [
      "bwrap /src/p.worktrees/P-1/bin/bwrap is writable by the step (allowWrite /src/p.worktrees/P-1)",
    ];
    const result = await runSandboxedStep(
      { clock: new ManualClock(), platform: "linux", host: rec.host },
      REQUEST,
    );
    expect(result).toEqual({
      outcome: "startFailed",
      reason:
        "sandbox refused untrusted paths: bwrap /src/p.worktrees/P-1/bin/bwrap is writable by the step (allowWrite /src/p.worktrees/P-1)",
    });
    expect(rec.probedTools).toEqual([]);
    expect(rec.started).toEqual([]);
  });

  it("checks the policy with the pinned tools and the step environment", async () => {
    const rec = fakeHost();
    const running = runSandboxedStep(
      { clock: new ManualClock(), platform: "linux", host: rec.host },
      REQUEST,
    );
    await settleMany();
    rec.child.finish({ code: 0, signal: null });
    await running;
    const input = rec.trustInputs[0];
    expect(input?.settings.bwrapPath).toBe("/usr/bin/bwrap");
    expect(input?.env["PATH"]).toBe("/usr/bin:/bin");
    expect(input?.home).toBe("/home/m");
    expect(rec.probedTools).toEqual([TOOLS]);
    expect(rec.policies[0]?.ripgrep).toEqual({ command: "/usr/bin/rg" });
    expect(rec.policies[0]?.filesystem.denyRead).toContain("/home/m/.local/state/dipo");
    expect(rec.policies[0]?.filesystem.denyRead).toContain("/run/user/501");
  });

  it("returns startFailed when the script has no timeout", async () => {
    const rec = fakeHost();
    const result = await runSandboxedStep(
      { clock: new ManualClock(), platform: "darwin", host: rec.host },
      { ...REQUEST, script: "lint" },
    );
    expect(result).toEqual({
      outcome: "startFailed",
      reason: "no timeouts.scriptMinutes entry for script lint",
    });
  });

  it("runs the command in the worktree with an allowlisted environment and its own temp root", async () => {
    const rec = fakeHost();
    const running = runSandboxedStep(
      { clock: new ManualClock(), platform: "darwin", host: rec.host },
      {
        ...REQUEST,
        extraEnv: {
          PORT: "4100",
          BUN_OPTIONS: "--preload x",
          NODE_OPTIONS: "-r x",
          BUN_CONFIG_REGISTRY: "x",
        },
      },
    );
    await settleMany();
    rec.child.finish({ code: 0, signal: null }, "ok\n", "warn\n");
    const result = await running;
    expect(result).toEqual({
      outcome: "exited",
      code: 0,
      signal: null,
      timedOut: false,
      stdout: { text: "ok\n", truncated: false },
      stderr: { text: "warn\n", truncated: false },
      warnings: [],
    });
    expect(rec.started).toHaveLength(1);
    const started = rec.started[0];
    expect(started?.command).toEqual(["bun", "run", "verify"]);
    expect(started?.cwd).toBe("/src/p.worktrees/P-1");
    expect(started?.policyPath).toBe(`${TEMP_ROOT}.policy.json`);
    expect(started?.env).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/home/m",
      PORT: "4100",
      TMPDIR: TEMP_ROOT,
      DIPO_TMP: TEMP_ROOT,
    });
    expect(rec.probedTools).toEqual([TOOLS]);
    expect(rec.removed).toEqual([TEMP_ROOT]);
  });

  it("writes the verify policy for verify and the install policy for install", async () => {
    for (const kind of ["verify", "install"] as const) {
      const rec = fakeHost();
      const running = runSandboxedStep(
        { clock: new ManualClock(), platform: "darwin", host: rec.host },
        { ...REQUEST, kind, script: kind },
      );
      await settleMany();
      rec.child.finish({ code: 0, signal: null });
      await running;
      const policy = rec.policies[0];
      expect(policy?.filesystem.allowWrite).toContain(TEMP_ROOT);
      expect(policy?.network.allowUnixSockets).toEqual([TEMP_ROOT]);
      if (kind === "install") {
        expect(policy?.network.allowedDomains).toEqual(["registry.npmjs.org"]);
        expect(policy?.filesystem.allowWrite).toContain("/home/m/.bun/install/cache");
      } else {
        expect(policy?.network.allowedDomains).toEqual([]);
        expect(policy?.filesystem.allowWrite).not.toContain("/home/m/.bun/install/cache");
      }
    }
  });

  it("stops a step that overruns timeouts.scriptMinutes: SIGTERM, then SIGKILL", async () => {
    const clock = new ManualClock();
    const rec = fakeHost();
    const running = runSandboxedStep({ clock, platform: "darwin", host: rec.host }, REQUEST);
    await settleMany();
    clock.advance(20 * 60_000 - 1);
    expect(rec.child.signals).toEqual([]);
    clock.advance(1);
    expect(rec.child.signals).toEqual(["SIGTERM"]);
    clock.advance(KILL_GRACE_MS);
    expect(rec.child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    rec.child.finish({ code: null, signal: "SIGKILL" }, "partial");
    const result = await running;
    expect(result).toMatchObject({
      outcome: "exited",
      code: null,
      signal: "SIGKILL",
      timedOut: true,
      stdout: { text: "partial", truncated: false },
    });
    expect(clock.pendingTimers).toBe(0);
  });

  it("clears its timer when the step ends in time", async () => {
    const clock = new ManualClock();
    const rec = fakeHost();
    const running = runSandboxedStep({ clock, platform: "darwin", host: rec.host }, REQUEST);
    await settleMany();
    rec.child.finish({ code: 3, signal: null });
    expect(await running).toMatchObject({ outcome: "exited", code: 3, timedOut: false });
    expect(clock.pendingTimers).toBe(0);
  });

  it("reports Linux glob warnings from the policy", async () => {
    const rec = fakeHost();
    const running = runSandboxedStep(
      { clock: new ManualClock(), platform: "linux", host: rec.host },
      {
        ...REQUEST,
        kind: "install",
        script: "install",
        sandbox: { toolchainPaths: ["~/.cache/*"], registryHosts: [] },
      },
    );
    await settleMany();
    rec.child.finish({ code: 0, signal: null });
    expect(await running).toMatchObject({
      warnings: ["allowWrite: skipped /home/m/.cache/* (a glob; Linux takes literal paths only)"],
    });
  });
});

describe("capture", () => {
  it("keeps the tail when the output passes the limit", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of ["abcd", "efgh", "ij"])
          controller.enqueue(new TextEncoder().encode(part));
        controller.close();
      },
    });
    expect(await capture(stream, 5)).toEqual({ text: "fghij", truncated: true });
  });
});
