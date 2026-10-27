// dipo's web route with Safe-Chain in its own box (DIPO-343), on the fake backend: the image reused
// or built with no registry, the box made from it with its firewall (out only to the upstream
// listener, in only from the Mac on its two ports), the start script run as the box user with the
// upstream listener as its proxy, the CA bundle checked and written, and the check through the web
// proxy itself. Each way a start can fail stops what was started: the box is deleted and both
// listeners close (fail-closed). The real box is tested in safe-chain-box.ci.test.ts.

import { existsSync, readFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { guardRuns, ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { BUILD_DIR_IN_BOX, BUILD_STEPS_SCRIPT, BUILD_SYSTEM_SCRIPT } from "../../src/box/image";
import { BOX_NETWORK_NAME } from "../../src/box/apple-args";
import { BoxError, type BoxNetwork } from "../../src/box/port";
import {
  SAFE_CHAIN_BOX_PORTS,
  SAFE_CHAIN_START_SCRIPT,
  safeChainImageTag,
} from "../../src/box/safe-chain";
import {
  runSafeChainCheck,
  SAFE_CHAIN_CHECK_ALLOWED_URL,
  SAFE_CHAIN_CHECK_BLOCKED_URL,
  safeChainCheckProblem,
  startBoxWebRoute,
} from "../../src/box/safe-chain-box";
import {
  BOX_HOST_ADDRESS,
  FakeBoxes,
  type FakeBoxesOptions,
  type LiveReply,
  writeNetTools,
} from "./fake-boxes";

const PEM =
  "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIBATAKBggqhkjOPQQDAjA=\n-----END CERTIFICATE-----\n";
const BUNDLE = "/home/dipo/sc/tmp/safe-chain-ca-bundle-1.pem";
const NETWORK: BoxNetwork = { name: BOX_NETWORK_NAME, mode: "hostOnly", hostAddress: "127.0.0.1" };
const SAFE_CHAIN_BOX = "dipo-safe-chain-0123456789abcdef";

/** False only where a sandbox refuses loopback TCP listens; the route listens on TCP. */
async function loopbackListens(): Promise<boolean> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
  } catch {
    return false;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return true;
}

const RUNS = guardRuns(
  "SANDBOX_REFUSES_LOOPBACK",
  "the sandbox refuses loopback TCP listens, so the web route cannot start here",
  await loopbackListens(),
);

/** Whether a new connection to the loopback `port` is taken. */
function reachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

interface Setup {
  readonly ready?: LiveReply;
  readonly cat?: { readonly code: number; readonly stdout: string };
  readonly built?: boolean;
  readonly boxes?: FakeBoxesOptions;
  readonly statuses?: Readonly<Record<string, number>>;
}

async function route(tmp: string, setup: Setup = {}) {
  const tag = safeChainImageTag();
  const toolsRoot = join(tmp, "tools");
  if (setup.built !== false) writeNetTools(toolsRoot, tag);
  const downloads: { proxy: string; ca: string; url: string }[] = [];
  const boxes = new FakeBoxes({
    images: setup.built === false ? [] : [tag],
    live: (_box, command) =>
      command[0] === SAFE_CHAIN_START_SCRIPT
        ? (setup.ready ?? { stdout: `{"ready":true,"bundle":"${BUNDLE}"}\n`, hang: true })
        : { code: 1 },
    exec: (_box, command) =>
      command[0] === "cat" ? { stderr: "", ...(setup.cat ?? { code: 0, stdout: PEM }) } : undefined,
    ...setup.boxes,
  });
  const caFile = join(tmp, "route", "ca.pem");
  const started = await startBoxWebRoute(
    NETWORK,
    {
      boxes,
      clock: new ManualClock(),
      scratchRoot: join(tmp, "scratch"),
      toolsRoot,
      caFile,
      boxId: () => "0123456789abcdef",
      buildId: () => "fedcba9876543210",
      download: async (proxy, ca, url) => {
        downloads.push({ proxy, ca, url });
        return (
          setup.statuses?.[url] ??
          (url === SAFE_CHAIN_CHECK_ALLOWED_URL
            ? 200
            : url === SAFE_CHAIN_CHECK_BLOCKED_URL
              ? 403
              : 0)
        );
      },
    },
    { clock: new ManualClock() },
  );
  return { started, boxes, caFile, downloads, tag };
}

describe.skipIf(!RUNS)("the web route with Safe-Chain in its box", () => {
  it("makes the box from the Safe-Chain image behind its firewall, starts Safe-Chain and checks it", () =>
    withTempDir(async (tmp) => {
      const { started, boxes, caFile, downloads, tag } = await route(tmp);
      if (!started.ok) throw new Error(started.reason);
      const box = boxes.boxes.get(SAFE_CHAIN_BOX);
      expect(box?.spec.image).toBe(tag);
      expect(box?.spec.netTools).toBe(join(tmp, "tools", tag.split(":")[1] ?? ""));
      expect(box?.state).toBe("running");
      // Out only to the upstream listener, in only from the Mac on the two Safe-Chain ports.
      const firewall = boxes.firewalls.find((entry) => entry.box === SAFE_CHAIN_BOX)?.firewall;
      expect(firewall?.hostAddress).toBe("127.0.0.1");
      expect(firewall?.inbound).toEqual([SAFE_CHAIN_BOX_PORTS.npm, SAFE_CHAIN_BOX_PORTS.pypi]);
      const upstreamPort = firewall?.ports[0] ?? 0;
      expect(upstreamPort).not.toBe(started.route.port);
      expect(await reachable(upstreamPort)).toBe(true);
      // The start script as the box user, with only the upstream listener as its proxy.
      expect(boxes.liveExecs).toEqual([
        {
          box: SAFE_CHAIN_BOX,
          command: [SAFE_CHAIN_START_SCRIPT],
          env: { HTTPS_PROXY: `http://127.0.0.1:${upstreamPort}` },
        },
      ]);
      expect(readFileSync(caFile, "utf8")).toBe(PEM);
      // The check went through the web proxy the boxes use, trusting the box's CA only.
      expect(downloads).toEqual([
        { proxy: started.route.url, ca: PEM, url: SAFE_CHAIN_CHECK_ALLOWED_URL },
        { proxy: started.route.url, ca: PEM, url: SAFE_CHAIN_CHECK_BLOCKED_URL },
      ]);
      // The box lives as long as the route.
      await started.route.stop();
      expect(boxes.boxes.has(SAFE_CHAIN_BOX)).toBe(false);
      expect(existsSync(caFile)).toBe(false);
      expect(await reachable(started.route.port)).toBe(false);
      expect(await reachable(upstreamPort)).toBe(false);
    }));

  it("builds the Safe-Chain image when it is missing, with no CA bundle and no registry", () =>
    withTempDir(async (tmp) => {
      const { started, boxes, tag } = await route(tmp, { built: false });
      if (!started.ok) throw new Error(started.reason);
      expect(boxes.commits).toEqual([tag]);
      expect(boxes.log).toContain("create dipo-build-fedcba9876543210");
      expect(boxes.log).toContain("delete dipo-build-fedcba9876543210");
      const steps = boxes.execs
        .filter((exec) => exec.box === "dipo-build-fedcba9876543210")
        .map((exec) => exec.command.join(" "));
      expect(steps).toContain(`/bin/sh ${BUILD_DIR_IN_BOX}/${BUILD_SYSTEM_SCRIPT}`);
      expect(steps).toContain(`/bin/sh ${BUILD_DIR_IN_BOX}/${BUILD_STEPS_SCRIPT}`);
      // The build reached out only through the web proxy, before Safe-Chain ran.
      const buildFirewall = boxes.firewalls.find((entry) => entry.box.startsWith("dipo-build-"));
      expect(buildFirewall?.firewall).toEqual({
        hostAddress: BOX_HOST_ADDRESS,
        ports: [started.route.port],
      });
      await started.route.stop();
    }));

  for (const [what, setup, reason] of [
    [
      "Safe-Chain reports it could not start",
      {
        ready: {
          stdout: '{"ready":false,"reason":"the npm Safe-Chain process did not start its proxy"}\n',
          code: 1,
        },
      },
      "the npm Safe-Chain process did not start its proxy",
    ],
    [
      "the start script ends without a ready line",
      { ready: { stdout: "", code: 1 } },
      "it stopped before it was ready",
    ],
    [
      "Safe-Chain names a CA bundle outside its temp folder",
      { ready: { stdout: '{"ready":true,"bundle":"/etc/passwd"}\n', hang: true } },
      "outside its temp folder",
    ],
    [
      "the CA bundle is not PEM certificates",
      { cat: { code: 0, stdout: "export EVIL=1\n" } },
      "not PEM certificates",
    ],
    [
      "Safe-Chain lets its test package through",
      { statuses: { [SAFE_CHAIN_CHECK_BLOCKED_URL]: 200 } },
      "did not refuse its test package",
    ],
    [
      "the box's firewall cannot be set",
      { boxes: { firewallFails: new BoxError("box.firewallFailed", "no netfilter") } },
      "no netfilter",
    ],
  ] as const) {
    it(`fails closed when ${what}: the box is deleted and both listeners close`, () =>
      withTempDir(async (tmp) => {
        const { started, boxes, caFile, downloads } = await route(tmp, setup as Setup);
        expect(started.ok).toBe(false);
        if (started.ok) return;
        expect(started.reason).toContain(reason);
        expect(boxes.boxes.has(SAFE_CHAIN_BOX)).toBe(false);
        expect(existsSync(caFile)).toBe(false);
        const listened = boxes.firewalls[0]?.firewall.ports[0];
        if (listened !== undefined) expect(await reachable(listened)).toBe(false);
        if (what !== "Safe-Chain lets its test package through") expect(downloads).toEqual([]);
      }));
  }
});

describe("the Safe-Chain check", () => {
  it("passes only an allowed download and a refused test package", () => {
    expect(safeChainCheckProblem({ allowed: 200, attempts: 1, blocked: 403 })).toBeNull();
    expect(safeChainCheckProblem({ allowed: 502, attempts: 3, blocked: 403 })).toContain(
      "after 3 attempts (502)",
    );
    expect(safeChainCheckProblem({ allowed: 200, attempts: 1, blocked: 200 })).toContain(
      "did not refuse its test package safe-chain-test (200)",
    );
    expect(safeChainCheckProblem({ allowed: 200, attempts: 1, blocked: "reset" })).toContain(
      "(reset)",
    );
  });

  it("tries the allowed download again on the clock, and the blocked one once", async () => {
    const clock = new ManualClock();
    const tries: string[] = [];
    const answers = [503, 200];
    const check = runSafeChainCheck(clock, async (url) => {
      tries.push(url);
      return url === SAFE_CHAIN_CHECK_ALLOWED_URL ? (answers.shift() ?? 0) : 403;
    });
    for (let i = 0; i < 20 && tries.length < 2; i += 1) {
      await Promise.resolve();
      clock.advance(2_000);
    }
    expect(await check).toBeNull();
    expect(tries).toEqual([
      SAFE_CHAIN_CHECK_ALLOWED_URL,
      SAFE_CHAIN_CHECK_ALLOWED_URL,
      SAFE_CHAIN_CHECK_BLOCKED_URL,
    ]);
  });
});
