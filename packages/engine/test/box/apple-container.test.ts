// The Apple container backend (DIPO-265) against a fake `container` CLI: the start check, the
// host-only network, the lifecycle calls, exec (short and long-running), memory, the list of
// dipo's own boxes, and the deadline that kills a call with `box.timedOut`.

import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { BOX_NETWORK_NAME } from "../../src/box/apple-args";
import {
  AppleContainerBoxes,
  type AppleContainerDeps,
  systemHostResources,
} from "../../src/box/apple-container";
import {
  BOX_CALL_TIMEOUT_MS,
  BOX_PACKAGE_CACHE_PATH,
  BoxError,
  type BoxNetwork,
  isBoxTimedOut,
} from "../../src/box/port";
import {
  boxJson,
  type CliScript,
  type FakeContainer,
  fakeContainer,
  missingContainer,
  networkJson,
  STATUS_RUNNING,
  VERSION_1_6_0,
} from "./fake-container";

const ENV = { PATH: "/usr/bin:/bin", HOME: "/Users/someone" };
const HOST = { memoryBytes: 32 * 1024 ** 3, cpus: 12 };
const RUN = "run_01J9ZK5Q8W3V4X6Y7Z00000001";
const BOX = `dipo-${RUN}`;
const NETWORK: BoxNetwork = {
  name: BOX_NETWORK_NAME,
  mode: "hostOnly",
  hostAddress: "192.0.2.1",
};

/** Every fake made in a test, so each argv the backend ran is checked after it. */
let fakes: FakeContainer[] = [];

afterEach(() => {
  const forbidden = [
    "-v",
    "--volume",
    "--ssh",
    "-p",
    "--publish",
    "--publish-socket",
    "--virtualization",
  ];
  for (const fake of fakes) {
    for (const args of fake.args()) {
      // A box command follows the box name of `exec`; it is the box's own, not container's.
      const own = args[0] === "exec" ? args.slice(0, args.indexOf(BOX) + 1) : args;
      expect(own.filter((arg) => forbidden.includes(arg))).toEqual([]);
    }
    for (const call of fake.calls) expect(call.env).toEqual(ENV);
  }
  fakes = [];
});

function boxes(script: CliScript, deps: Partial<AppleContainerDeps> = {}) {
  const fake = fakeContainer(script);
  fakes.push(fake);
  const clock = new ManualClock();
  const port = new AppleContainerBoxes({
    spawn: fake.spawn,
    clock,
    env: ENV,
    host: HOST,
    home: "/Users/someone",
    cli: "/usr/local/bin/container",
    ...deps,
  });
  return { fake, clock, port };
}

const is = (args: readonly string[], ...want: string[]) => args.join(" ") === want.join(" ");

/** Lets pending promise callbacks run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

async function rejection(promise: Promise<unknown>): Promise<BoxError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BoxError);
    return error as BoxError;
  }
  throw new Error("expected the call to fail");
}

describe("the start check", () => {
  it("passes on container 1.6.0 with its service running", async () => {
    const { port, fake } = boxes((args) => {
      if (is(args, "--version")) return { stdout: VERSION_1_6_0 };
      if (is(args, "system", "status", "--format", "json")) return { stdout: STATUS_RUNNING };
      return undefined;
    });
    expect(await port.check()).toEqual({ ok: true, version: "1.6.0" });
    expect(fake.calls[0]?.cmd[0]).toBe("/usr/local/bin/container");
  });

  it("accepts a newer container", async () => {
    const { port } = boxes((args) =>
      is(args, "--version")
        ? { stdout: "container CLI version 1.10.2 (build: release, commit: 0000000)\n" }
        : { stdout: STATUS_RUNNING },
    );
    expect(await port.check()).toEqual({ ok: true, version: "1.10.2" });
  });

  it("refuses when the CLI is missing", async () => {
    const port = new AppleContainerBoxes({
      spawn: missingContainer,
      clock: new ManualClock(),
      env: ENV,
      host: HOST,
    });
    const check = await port.check();
    expect(check.ok).toBe(false);
    expect(check).toMatchObject({ version: null });
    if (!check.ok) expect(check.reason).toContain("is it installed?");
  });

  it("refuses a CLI that prints no version or fails", async () => {
    for (const reply of [{ stdout: "container\n" }, { code: 1, stderr: "boom" }]) {
      const { port } = boxes(() => reply);
      const check = await port.check();
      expect(check).toMatchObject({ ok: false, version: null });
    }
  });

  it("refuses a CLI older than 1.6.0", async () => {
    for (const old of ["0.9.0", "1.5.9"]) {
      const { port, fake } = boxes(() => ({
        stdout: `container CLI version ${old} (build: release, commit: 0000000)\n`,
      }));
      const check = await port.check();
      expect(check).toMatchObject({ ok: false, version: old });
      if (!check.ok) expect(check.reason).toContain(`${old} is older than 1.6.0`);
      expect(fake.calls).toHaveLength(1);
    }
  });

  it("refuses when the system service is not running", async () => {
    const replies = [
      { code: 1, stdout: JSON.stringify({ status: "not running" }) },
      { code: 1, stdout: JSON.stringify({ status: "unregistered" }) },
      { code: 0, stdout: JSON.stringify({ status: "stopping" }) },
    ];
    for (const status of replies) {
      const { port } = boxes((args) =>
        is(args, "--version") ? { stdout: VERSION_1_6_0 } : status,
      );
      const check = await port.check();
      expect(check).toMatchObject({ ok: false, version: "1.6.0" });
      if (!check.ok) expect(check.reason).toContain("container system start");
    }
  });
});

describe("the box network", () => {
  it("creates the host-only network when it is missing and reads its host address", async () => {
    let created = false;
    const { port, fake } = boxes((args) => {
      if (is(args, "network", "list", "--format", "json")) {
        return {
          stdout: JSON.stringify(
            created
              ? [networkJson("default", "nat"), networkJson(BOX_NETWORK_NAME, "hostOnly")]
              : [networkJson("default", "nat")],
          ),
        };
      }
      if (args[0] === "network" && args[1] === "create") {
        created = true;
        return { stdout: `${BOX_NETWORK_NAME}\n` };
      }
      return undefined;
    });
    expect(await port.network()).toEqual(NETWORK);
    expect(fake.args()[1]).toEqual([
      "network",
      "create",
      "--internal",
      "--label",
      "dipo=network",
      BOX_NETWORK_NAME,
    ]);
  });

  it("reuses a host-only network that exists", async () => {
    const { port, fake } = boxes(() => ({
      stdout: JSON.stringify([networkJson(BOX_NETWORK_NAME, "hostOnly", "192.0.2.65")]),
    }));
    expect(await port.network()).toEqual({ ...NETWORK, hostAddress: "192.0.2.65" });
    expect(fake.calls).toHaveLength(1);
  });

  it("refuses a network of that name in any other mode", async () => {
    const { port } = boxes(() => ({
      stdout: JSON.stringify([networkJson(BOX_NETWORK_NAME, "nat")]),
    }));
    const error = await rejection(port.network());
    expect(error.code).toBe("box.refused");
    expect(error.details).toEqual({ network: BOX_NETWORK_NAME, mode: "nat" });
  });
});

describe("box lifecycle", () => {
  it("creates a box named dipo-<run id> with the dipo label, the cache read-only and the Mac's resources", () =>
    withTempDir(async (dir) => {
      const root = join(dir, "package-cache");
      mkdirSync(join(root, "generation"), { recursive: true });
      const cache = realpathSync(join(root, "generation"));
      const { port, fake } = boxes(() => ({ stdout: `${BOX}\n` }), { packageCacheRoot: root });
      const name = await port.create({
        runId: RUN,
        image: "docker.io/library/alpine:3.20",
        network: NETWORK,
        packageCache: join(root, "generation"),
      });
      expect(name).toBe(BOX);
      expect(fake.args()).toEqual([
        [
          "create",
          "--name",
          BOX,
          "--label",
          `dipo=${RUN}`,
          "--network",
          BOX_NETWORK_NAME,
          "--memory",
          "32768M",
          "--cpus",
          "12",
          "--mount",
          `type=bind,source=${cache},target=${BOX_PACKAGE_CACHE_PATH},readonly`,
          "--entrypoint",
          "tail",
          "docker.io/library/alpine:3.20",
          "-f",
          "/dev/null",
        ],
      ]);
    }));

  it("refuses a package cache without a cache root, or one a symlink points out of the root", () =>
    withTempDir(async (dir) => {
      const root = join(dir, "package-cache");
      const outside = join(dir, "outside");
      mkdirSync(root);
      mkdirSync(outside);
      symlinkSync(outside, join(root, "link"));
      const { port, fake } = boxes(() => ({}), { packageCacheRoot: root });
      for (const packageCache of [join(root, "link"), outside, root, join(root, "missing")]) {
        const error = await rejection(
          port.create({ runId: RUN, image: "alpine:3.20", network: NETWORK, packageCache }),
        );
        expect(error.code).toBe("box.cacheOutsideRoot");
      }
      const { port: rootless } = boxes(() => ({}));
      const error = await rejection(
        rootless.create({
          runId: RUN,
          image: "alpine:3.20",
          network: NETWORK,
          packageCache: outside,
        }),
      );
      expect(error.code).toBe("box.cacheOutsideRoot");
      expect(fake.calls).toHaveLength(0);
    }));

  it("defaults to the Mac's total memory and CPU count", () => {
    expect(systemHostResources()).toEqual({
      memoryBytes: totalmem(),
      cpus: availableParallelism(),
    });
  });

  it("starts, stops, copies in and out, and deletes through one call each", async () => {
    const { port, fake } = boxes(() => ({}));
    await port.start(BOX);
    await port.copyIn(BOX, "/tmp/d265/code", "/work");
    await port.copyOut(BOX, "/work/out", "/tmp/d265/out");
    await port.exportFiles(BOX, "/tmp/d265/box.tar");
    await port.stop(BOX);
    await port.delete(BOX);
    expect(fake.args()).toEqual([
      ["start", BOX],
      ["copy", "/tmp/d265/code", `${BOX}:/work`],
      ["copy", `${BOX}:/work/out`, "/tmp/d265/out"],
      ["export", "--output", "/tmp/d265/box.tar", BOX],
      ["stop", BOX],
      ["delete", "--force", BOX],
    ]);
  });

  it("fails a call that exits non-zero with box.failed and container's message", async () => {
    const { port } = boxes(() => ({ code: 1, stderr: "Error: notFound: container not found\n" }));
    const error = await rejection(port.start(BOX));
    expect(error.code).toBe("box.failed");
    expect(error.message).toContain("container not found");
  });

  it("refuses a name that is not one of dipo's boxes before running anything", async () => {
    const { port, fake } = boxes(() => ({}));
    expect((await rejection(port.delete("probe-box"))).code).toBe("box.refused");
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses to create a box on any network but dipo's, whatever mode the caller claims", async () => {
    const { port, fake } = boxes(() => ({}));
    for (const network of [
      { ...NETWORK, name: "default" },
      { ...NETWORK, name: "probe-internal" },
    ]) {
      const error = await rejection(port.create({ runId: RUN, image: "alpine:3.20", network }));
      expect(error.code).toBe("box.refused");
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses the home folder as the package cache", async () => {
    const { port, fake } = boxes(() => ({}));
    for (const packageCache of ["/Users/someone", "/Users", "/"]) {
      const error = await rejection(
        port.create({ runId: RUN, image: "alpine:3.20", network: NETWORK, packageCache }),
      );
      expect(error.code).toBe("box.refused");
    }
    expect(fake.calls).toHaveLength(0);
  });
});

describe("exec", () => {
  it("runs a command to its end and returns a non-zero exit as a result", async () => {
    const { port, fake } = boxes(() => ({ code: 3, stdout: "out\n", stderr: "err\n" }));
    const result = await port.exec(BOX, ["sh", "-c", "exit 3"], { cwd: "/work", env: { A: "1" } });
    expect(result).toEqual({ code: 3, stdout: "out\n", stderr: "err\n" });
    expect(fake.args()[0]).toEqual([
      "exec",
      "--workdir",
      "/work",
      "--env",
      "A=1",
      BOX,
      "sh",
      "-c",
      "exit 3",
    ]);
  });

  it("starts a long-running command with stdin and stdout and no deadline", async () => {
    const { port, fake, clock } = boxes(() => ({ hang: true, stdout: '{"ready":true}\n' }));
    const live = port.execLive(BOX, ["claude", "-p"], { cwd: "/work" });
    expect(fake.calls[0]?.stdin).toBe("pipe");
    expect(fake.args()[0]).toEqual([
      "exec",
      "--interactive",
      "--workdir",
      "/work",
      BOX,
      "claude",
      "-p",
    ]);
    live.stdin.write("hello\n");
    expect(fake.children[0]?.stdinWrites).toEqual(["hello\n"]);
    clock.advance(BOX_CALL_TIMEOUT_MS * 10);
    expect(clock.pendingTimers).toBe(0);
    expect(fake.children[0]?.signals).toEqual([]);
    const reader = live.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('{"ready":true}\n');
    reader.releaseLock();
    live.kill("SIGTERM");
    expect(await live.exited).toEqual({ code: null, signal: "SIGTERM" });
  });
});

describe("memory and the list", () => {
  it("reads a running box's memory, and null for a stopped one", async () => {
    let running = true;
    const { port, fake } = boxes(() => ({
      stdout: JSON.stringify(
        running
          ? [
              {
                id: BOX,
                memoryUsageBytes: 7_549_747,
                memoryLimitBytes: 34_359_738_368,
                numProcesses: 2,
              },
            ]
          : [],
      ),
    }));
    expect(await port.memory(BOX)).toEqual({ usedBytes: 7_549_747, limitBytes: 34_359_738_368 });
    running = false;
    expect(await port.memory(BOX)).toBeNull();
    expect(fake.args()[0]).toEqual(["stats", "--no-stream", "--format", "json", BOX]);
  });

  it("throws box.unreadable when the box is listed without a memory figure", async () => {
    for (const entry of [{ id: BOX }, { id: BOX, memoryUsageBytes: "7 MiB" }]) {
      const { port } = boxes(() => ({ stdout: JSON.stringify([entry]) }));
      expect((await rejection(port.memory(BOX))).code).toBe("box.unreadable");
    }
  });

  it("maps a failed stats to null only when it says the box is not running", async () => {
    const stopped = boxes(() => ({ code: 1, stderr: `Error: container ${BOX} is not running\n` }));
    expect(await stopped.port.memory(BOX)).toBeNull();
    for (const stderr of [
      "Error: apiserver is not running\n",
      `Error: notFound: "no such container: ${BOX}"\n`,
      "Error: internalError: stats failed\n",
      "",
    ]) {
      const { port } = boxes(() => ({ code: 1, stderr }));
      expect((await rejection(port.memory(BOX))).code).toBe("box.failed");
    }
  });

  it("lists only dipo's boxes: named dipo-<run id> and labelled with that run id", async () => {
    const { port, fake } = boxes(() => ({
      stdout: JSON.stringify([
        boxJson(BOX, "running", { dipo: RUN }),
        boxJson("dipo-run_2", "stopped", { dipo: "run_2" }),
        boxJson("dipo-run_3", "stopping", { dipo: "run_3" }),
        boxJson("probe-box", "running", { dipo: "probe-box" }),
        boxJson("dipo-unlabelled", "running"),
        boxJson("dipo-run_4", "running", { dipo: "run_5" }),
        boxJson("web", "running", { app: "web" }),
      ]),
    }));
    expect(await port.list()).toEqual([
      { name: BOX, runId: RUN, state: "running" },
      { name: "dipo-run_2", runId: "run_2", state: "stopped" },
      { name: "dipo-run_3", runId: "run_3", state: "unknown" },
    ]);
    expect(fake.args()[0]).toEqual(["list", "--all", "--format", "json"]);
  });

  it("fails with box.unreadable on output that is not the JSON it expects", async () => {
    for (const stdout of ["not json", "{}"]) {
      const { port } = boxes(() => ({ stdout }));
      expect((await rejection(port.list())).code).toBe("box.unreadable");
    }
  });
});

describe("deadlines", () => {
  it("kills a call at the 60 s default and fails it with box.timedOut", async () => {
    const { port, fake, clock } = boxes(() => ({ hang: true }));
    const stopping = rejection(port.stop(BOX));
    await settle();
    clock.advance(BOX_CALL_TIMEOUT_MS - 1);
    await settle();
    expect(fake.children[0]?.signals).toEqual([]);
    clock.advance(1);
    const error = await stopping;
    expect(isBoxTimedOut(error)).toBe(true);
    expect(error.details).toEqual({ args: ["stop", BOX], timeoutMs: BOX_CALL_TIMEOUT_MS });
    expect(fake.children[0]?.signals).toEqual(["SIGKILL"]);
    expect(clock.pendingTimers).toBe(0);
  });

  it("puts a deadline on every call, the start check included", async () => {
    const calls: [string, (port: AppleContainerBoxes) => Promise<unknown>][] = [
      ["check", (port) => port.check()],
      ["network", (port) => port.network()],
      ["create", (port) => port.create({ runId: RUN, image: "alpine:3.20", network: NETWORK })],
      ["start", (port) => port.start(BOX)],
      ["stop", (port) => port.stop(BOX)],
      ["delete", (port) => port.delete(BOX)],
      ["copyIn", (port) => port.copyIn(BOX, "/tmp/a", "/work")],
      ["copyOut", (port) => port.copyOut(BOX, "/work", "/tmp/a")],
      ["exportFiles", (port) => port.exportFiles(BOX, "/tmp/a.tar")],
      ["exec", (port) => port.exec(BOX, ["true"])],
      ["memory", (port) => port.memory(BOX)],
      ["list", (port) => port.list()],
    ];
    for (const [call, run] of calls) {
      const { port, clock } = boxes(() => ({ hang: true }));
      const failing = rejection(run(port));
      await settle();
      clock.advance(BOX_CALL_TIMEOUT_MS);
      expect({ call, code: (await failing).code }).toEqual({ call, code: "box.timedOut" });
    }
  });

  it("takes a deadline per call and per backend", async () => {
    const { port, clock, fake } = boxes(() => ({ hang: true }), { timeoutMs: 5_000 });
    const create = rejection(
      port.create({ runId: RUN, image: "alpine:3.20", network: NETWORK }, { timeoutMs: 300_000 }),
    );
    const start = rejection(port.start(BOX));
    await settle();
    clock.advance(5_000);
    expect((await start).code).toBe("box.timedOut");
    expect(fake.children[0]?.signals).toEqual([]);
    clock.advance(295_000);
    expect((await create).code).toBe("box.timedOut");
  });
});
