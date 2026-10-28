// The test box (DIPO-309): made from the pushed head like every box, install, setup and `dev` in
// it, the first URL `dev` prints within the start deadline, the firewall opened to the Mac's address
// on the `dev` port only, a relay only when `dev` listens on the box's loopback, the forwarder on
// the Mac, and no port published. On the fake backend, with the box worker steps recorded.

import { describe, expect, it } from "bun:test";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import type { ForwardTarget, RunningForwarder } from "../../src/box/forwarder";
import { boxName } from "../../src/box/port";
import {
  firstDevUrl,
  relayCommand,
  type TestBoxRequest,
  TestBoxError,
  TestBoxes,
  testUrl,
} from "../../src/box/test-box";
import type { OfficeGit } from "../../src/git/office";

import { BOX_HOST_ADDRESS, FakeBoxes, type LiveReply } from "./fake-boxes";

const TEST = "tst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D";
const BOX = boxName(TEST);
const HEAD = "4b4171c2a1e3f5d7b9c0e2f4a6b8d0c2e4f6a8b0";
const BOX_ADDRESS = "192.168.65.9";

interface World {
  readonly boxes: FakeBoxes;
  readonly tests: TestBoxes;
  readonly steps: string[];
  readonly routes: { readonly runId: string; readonly inbound?: readonly number[] }[];
  readonly forwards: { readonly target: ForwardTarget; readonly port?: number }[];
  readonly reaches: ForwardTarget[];
  readonly closed: string[];
  readonly clock: ManualClock;
}

function world(options: {
  readonly dev?: (command: readonly string[]) => LiveReply;
  /** Whether the Mac reaches `dev` at the box's address, per try. */
  readonly reachable?: (attempt: number) => boolean;
  readonly installFails?: boolean;
  readonly setupRed?: boolean;
}): World {
  const steps: string[] = [];
  const routes: World["routes"][number][] = [];
  const forwards: World["forwards"][number][] = [];
  const reaches: ForwardTarget[] = [];
  const closed: string[] = [];
  const clock = new ManualClock();
  const boxes = new FakeBoxes({
    live: (_box, command) =>
      options.dev?.(command) ?? (command[0] === "socat" ? { hang: true } : { hang: true }),
  });
  const workers = {
    create: async (input: { readonly runId: string; readonly startCommit: string }) => {
      steps.push(`create ${input.runId} at ${input.startCommit}`);
      await boxes.create({
        runId: input.runId,
        image: "dipo-box:x",
        network: await boxes.network(),
      });
      await boxes.start(boxName(input.runId));
      return { name: boxName(input.runId), cache: { kind: "off" as const } };
    },
    install: async () => {
      steps.push("install");
      return options.installFails === true
        ? { ok: false as const, reason: "`bun install` exited 1", output: "secret=1", ended: null }
        : { ok: true as const };
    },
    verify: async (input: { readonly step?: string; readonly cwd: string }) => {
      steps.push(`${input.step ?? "verify"} in ${input.cwd}`);
      return options.setupRed === true
        ? {
            kind: "red" as const,
            command: "bun run setup",
            exitCode: 1,
            signal: null,
            timedOutMinutes: null,
            output: "setup broke",
          }
        : { kind: "green" as const, command: "bun run setup" };
    },
    route: async (runId: string, route: { readonly inbound?: readonly number[] } = {}) => {
      routes.push({ runId, ...route });
      steps.push(
        route.inbound === undefined ? "route" : `route inbound ${route.inbound.join(",")}`,
      );
      return { HTTPS_PROXY: "http://box:pw@192.0.2.10:41000" };
    },
    discard: async (runId: string) => {
      closed.push(runId);
      await boxes.delete(boxName(runId));
    },
  };
  let attempt = 0;
  const tests = new TestBoxes({
    workers: workers as unknown as ConstructorParameters<typeof TestBoxes>[0]["workers"],
    boxes,
    clock,
    forward: async (target, forwardOptions = {}) => {
      forwards.push({ target, ...forwardOptions });
      const forwarder: RunningForwarder = {
        port: forwardOptions.port ?? 52731,
        connections: () => 0,
        close: async () => void steps.push("forwarder closed"),
      };
      return forwarder;
    },
    reach: async (target) => {
      reaches.push(target);
      return options.reachable?.(attempt++) ?? true;
    },
  });
  return { boxes, tests, steps, routes, forwards, reaches, closed, clock };
}

function request(overrides: Partial<TestBoxRequest> = {}): TestBoxRequest {
  return {
    office: "off_01J9ZK5Q8W3V4X6Y7Z0000TEST" as OfficeId,
    testId: TEST,
    runDir: "/tmp/never",
    git: {} as OfficeGit,
    head: HEAD,
    install: { commands: [["bun", "install", "--frozen-lockfile"]], env: {}, timeoutMs: 60_000 },
    setup: { commands: [["bun", "run", "setup"]], cwd: ".", env: {}, timeoutMs: 60_000 },
    dev: {
      command: ["bun", "run", "dev"],
      cwd: "/work",
      env: { PORT: "5173" },
      startTimeoutMs: 300_000,
    },
    ...overrides,
  };
}

const VITE =
  "\n  \u001b[32mVITE\u001b[39m ready\n  ➜  Local:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/app/\u001b[39m\n";

describe("the first URL dev prints", () => {
  it("is read past colours, with its port and path", () => {
    const found = firstDevUrl(VITE);
    expect(found?.port).toBe(5173);
    expect(found?.url.pathname).toBe("/app/");
    expect(testUrl(found!.url, 52731)).toBe("http://localhost:52731/app/");
    expect(firstDevUrl("listening on https://0.0.0.0, ready")?.port).toBe(443);
    expect(firstDevUrl("Server at http://[::1]:3000.")?.loopbackV6).toBe(true);
    expect(firstDevUrl("starting...")).toBeNull();
  });

  it("names a relay from the box's address to the loopback port", () => {
    expect(relayCommand("192.168.65.9", 5173, false)).toEqual([
      "socat",
      "TCP-LISTEN:5173,bind=192.168.65.9,fork,reuseaddr",
      "TCP4:127.0.0.1:5173",
    ]);
    expect(relayCommand("192.168.65.9", 3000, true).at(-1)).toBe("TCP6:[::1]:3000");
  });
});

describe("a test box", () => {
  it("is made from the pushed head, installs, runs setup and dev, opens only the dev port to the Mac, and forwards from the Mac's loopback", async () => {
    const w = world({ dev: () => ({ stdout: VITE, hang: true }) });
    const running = await w.tests.start(request());
    expect(w.steps).toEqual([
      `create ${TEST} at ${HEAD}`,
      "install",
      "route",
      "setup in .",
      "route inbound 5173",
    ]);
    expect(w.boxes.liveExecs.map((exec) => exec.command)).toEqual([["bun", "run", "dev"]]);
    expect(w.boxes.liveExecs[0]?.env).toMatchObject({
      PORT: "5173",
      HTTPS_PROXY: "http://box:pw@192.0.2.10:41000",
    });
    // dev answers at the box's address: no relay; the forwarder starts from the Mac's bridge address.
    expect(w.reaches).toEqual([{ address: BOX_ADDRESS, port: 5173, source: BOX_HOST_ADDRESS }]);
    expect(w.forwards).toEqual([
      { target: { address: BOX_ADDRESS, port: 5173, source: BOX_HOST_ADDRESS } },
    ]);
    expect(running).toEqual({
      box: BOX,
      url: "http://localhost:52731/app/",
      forward: { port: 52731, target: { address: BOX_ADDRESS, port: 5173 } },
    });
    // No port is published: the box spec carries none, and nothing else reaches the box.
    expect(JSON.stringify(w.boxes.boxes.get(BOX)?.spec)).not.toMatch(/publish|5173/);
    expect(w.tests.holds(TEST)).toBe(true);
  });

  it("starts the relay when dev listens only on the box's loopback", async () => {
    const w = world({
      dev: (command) => (command[0] === "socat" ? { hang: true } : { stdout: VITE, hang: true }),
      reachable: (attempt) => attempt > 0,
    });
    const running = await w.tests.start(request());
    expect(w.boxes.liveExecs.map((exec) => exec.command)).toEqual([
      ["bun", "run", "dev"],
      relayCommand(BOX_ADDRESS, 5173, false),
    ]);
    expect(running.url).toBe("http://localhost:52731/app/");
  });

  it("gets no dev for a product with nothing to start, and no forwarder", async () => {
    const w = world({});
    const running = await w.tests.start(request({ dev: null, setup: null }));
    expect(running).toEqual({ box: BOX, url: null, forward: null });
    expect(w.steps).toEqual([`create ${TEST} at ${HEAD}`, "install", "route"]);
    expect(w.boxes.liveExecs).toEqual([]);
    expect(w.forwards).toEqual([]);
  });

  it("fails at the start deadline when dev prints no URL, and deletes the box", async () => {
    const w = world({ dev: () => ({ stdout: "compiling...\n", hang: true }) });
    const started = w.tests.start(request());
    // Let the box steps run, then pass the deadline.
    for (let i = 0; i < 50 && w.boxes.liveExecs.length === 0; i++) await Promise.resolve();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    w.clock.advance(300_000);
    const error = await started.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TestBoxError);
    expect((error as TestBoxError).step).toBe("dev");
    expect((error as Error).message).toContain("printed no URL within 300 seconds");
    expect((error as Error).message).toContain("compiling...");
    expect(w.closed).toEqual([TEST]);
    expect(w.boxes.boxes.has(BOX)).toBe(false);
  });

  it("fails when dev ends before a URL, when install fails, or setup is red, each saying which step", async () => {
    const ended = world({ dev: () => ({ stdout: "boom\n", code: 1 }) });
    const dev = await ended.tests.start(request()).catch((caught: unknown) => caught);
    expect((dev as TestBoxError).step).toBe("dev");
    expect((dev as Error).message).toContain("ended (exit 1) before it printed a URL");

    const install = world({ installFails: true });
    const failed = await install.tests.start(request()).catch((caught: unknown) => caught);
    expect((failed as TestBoxError).step).toBe("install");
    // The install's output stays in the daemon's log (it may hold an env file's values).
    expect((failed as Error).message).not.toContain("secret");
    expect(install.closed).toEqual([TEST]);

    const setup = world({ setupRed: true });
    const red = await setup.tests.start(request()).catch((caught: unknown) => caught);
    expect((red as TestBoxError).step).toBe("setup");
    expect((red as Error).message).toContain("setup broke");
  });

  it("fails when the Mac reaches dev neither at the box's address nor through the relay", async () => {
    const w = world({ dev: () => ({ stdout: VITE, hang: true }), reachable: () => false });
    const started = w.tests.start(request());
    for (let round = 0; round < 20; round++) {
      for (let i = 0; i < 20; i++) await Promise.resolve();
      w.clock.advance(1_000);
    }
    const error = await started.catch((caught: unknown) => caught);
    expect((error as TestBoxError).step).toBe("reach");
    expect(w.forwards).toEqual([]);
    expect(w.closed).toEqual([TEST]);
  });

  it("is taken up again after a daemon restart on the same port, and is gone once its box is", async () => {
    const w = world({ dev: () => ({ stdout: VITE, hang: true }) });
    await w.tests.start(request());
    await w.tests.stopForwarders();
    const again = await w.tests.reattach({
      testId: TEST,
      target: { address: BOX_ADDRESS, port: 5173 },
      port: 52731,
    });
    expect(again).toEqual({ port: 52731 });
    expect(w.routes.at(-1)).toEqual({ runId: TEST, inbound: [5173] });
    expect(w.forwards.at(-1)).toEqual({
      target: { address: BOX_ADDRESS, port: 5173, source: BOX_HOST_ADDRESS },
      port: 52731,
    });
    await w.boxes.delete(BOX);
    expect(
      await w.tests.reattach({
        testId: TEST,
        target: { address: BOX_ADDRESS, port: 5173 },
        port: 1,
      }),
    ).toBeNull();
  });

  it("closes its forwarder and box, and the sweep deletes test boxes no open test names", async () => {
    const w = world({ dev: () => ({ stdout: VITE, hang: true }) });
    await w.tests.start(request());
    const other = "tst_01J9ZK5Q8W3V4X6Y7Z8A9B0C2E";
    await w.boxes.create({ runId: other, image: "i", network: await w.boxes.network() });
    await w.boxes.create({
      runId: "run_01J9ZK5Q8W3V4X6Y7Z8A9B0C3F",
      image: "i",
      network: await w.boxes.network(),
    });
    expect(await w.tests.sweep(new Set([TEST]))).toEqual([other]);
    expect([...w.boxes.boxes.keys()].toSorted()).toEqual(
      [BOX, boxName("run_01J9ZK5Q8W3V4X6Y7Z8A9B0C3F")].toSorted(),
    );
    await w.tests.close(TEST);
    expect(w.steps.at(-1)).toBe("forwarder closed");
    expect(w.boxes.boxes.has(BOX)).toBe(false);
    expect(w.tests.holds(TEST)).toBe(false);
  });
});
