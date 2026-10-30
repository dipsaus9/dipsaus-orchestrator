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
import type { SafeChainRouteEvent } from "../../src/box/safe-chain-box";
import type { WebProxyEvent } from "../../src/box/web-proxy";
import {
  proxiedStatus,
  runSafeChainCheck,
  SAFE_CHAIN_CHECK_TIMEOUT_MS,
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
  /** The route's clock; a fresh manual one by default. */
  readonly clock?: ManualClock;
  /** True: the check's downloads go through the web proxy as a box makes them (`proxiedStatus`). */
  readonly realDownload?: boolean;
  /** Where the web proxy's connection to the Safe-Chain box lands; a port nothing listens on by default. */
  readonly safeChainPort?: number;
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
  const routeEvents: SafeChainRouteEvent[] = [];
  const proxyEvents: WebProxyEvent[] = [];
  const connects: string[] = [];
  const started = await startBoxWebRoute(
    NETWORK,
    {
      boxes,
      clock: setup.clock ?? new ManualClock(),
      scratchRoot: join(tmp, "scratch"),
      toolsRoot,
      caFile,
      boxId: () => "0123456789abcdef",
      buildId: () => "fedcba9876543210",
      ...(setup.realDownload === true
        ? {}
        : {
            download: async (proxy: string, ca: string, url: string) => {
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
          }),
      onRoute: (event) => routeEvents.push(event),
    },
    {
      clock: setup.clock ?? new ManualClock(),
      onEvent: (event) => proxyEvents.push(event),
      // Each upstream connection is recorded and lands on a port nothing listens on.
      connect: (address, port) => {
        connects.push(`${address}:${port}`);
        return connect(setup.safeChainPort ?? 1, "127.0.0.1");
      },
    },
  );
  return { started, boxes, caFile, downloads, tag, routeEvents, proxyEvents, connects };
}

/** The first line a CONNECT to `target` through the proxy on the loopback `port` gets back. */
function connectLine(port: number, target: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () =>
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`),
    );
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk.toString("latin1");
      if (text.includes("\r\n")) {
        socket.destroy();
        resolve(text.split("\r\n")[0] ?? "");
      }
    });
    socket.on("error", () => resolve(""));
    socket.on("close", () => resolve(text.split("\r\n")[0] ?? ""));
  });
}

describe.skipIf(!RUNS)("the web route with Safe-Chain in its box", () => {
  it("sends no tunnel to the Safe-Chain box once Safe-Chain ends, and says so (fail-closed)", () =>
    withTempDir(async (tmp) => {
      const { started, boxes, routeEvents, proxyEvents, connects } = await route(tmp);
      if (!started.ok) throw new Error(started.reason);
      // While it runs, a registry tunnel goes to the box (whose fake port answers nothing).
      expect(await connectLine(started.route.port, "registry.npmjs.org:443")).toBe(
        "HTTP/1.1 502 Bad Gateway",
      );
      expect(connects).toEqual([`192.168.65.9:${SAFE_CHAIN_BOX_PORTS.npm}`]);
      // The box goes away: its start script's exec ends with it.
      await boxes.stop(SAFE_CHAIN_BOX);
      for (let i = 0; i < 10 && routeEvents.length === 0; i += 1) await Bun.sleep(5);
      expect(routeEvents).toEqual([{ kind: "safeChainEnded", box: SAFE_CHAIN_BOX, code: 137 }]);
      expect(await connectLine(started.route.port, "registry.npmjs.org:443")).toBe(
        "HTTP/1.1 503 Service Unavailable",
      );
      expect(await connectLine(started.route.port, "pypi.org:443")).toBe(
        "HTTP/1.1 503 Service Unavailable",
      );
      // No further connection was made, to the box or anywhere else.
      expect(connects).toHaveLength(1);
      expect(proxyEvents.at(-1)).toEqual({
        kind: "refused",
        target: "pypi.org:443",
        reason: "Safe-Chain is not running, so no registry is reached",
      });
      // A stop now is no news: the route's own end is expected.
      await started.route.stop();
      expect(routeEvents).toHaveLength(1);
    }));

  it("reports a Safe-Chain box it could not delete", () =>
    withTempDir(async (tmp) => {
      const { started, boxes, routeEvents } = await route(tmp);
      if (!started.ok) throw new Error(started.reason);
      boxes.delete = async () => {
        throw new BoxError("box.failed", "container delete failed");
      };
      await started.route.stop();
      expect(routeEvents).toEqual([
        { kind: "safeChainDeleteFailed", box: SAFE_CHAIN_BOX, reason: "container delete failed" },
      ]);
    }));

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

/** A stand-in web proxy on the loopback: answers each CONNECT with `answer`, or never. */
async function standInProxy(answer: string | null) {
  const closed: boolean[] = [];
  const server = createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", () => {
      if (answer !== null) socket.write(answer);
    });
    socket.once("close", () => closed.push(true));
  });
  const port = await new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    }),
  );
  return { server, port, closed };
}

describe.skipIf(!RUNS)("one download of the check, as a box makes it", () => {
  it("rejects a tunnel the web proxy refuses: its 403 never passes for Safe-Chain's", async () => {
    const proxy = await standInProxy("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    const attempt = proxiedStatus(
      { host: "127.0.0.1", port: proxy.port },
      "127.0.0.1",
      PEM,
      SAFE_CHAIN_CHECK_BLOCKED_URL,
      new ManualClock(),
    );
    await expect(attempt).rejects.toThrow("the web proxy refused the tunnel (403)");
    // The check then fails: no 403 status counts.
    expect(
      safeChainCheckProblem({
        allowed: 200,
        attempts: 1,
        blocked: "the web proxy refused the tunnel (403)",
      }),
    ).toContain("did not refuse its test package");
    for (let i = 0; i < 20 && proxy.closed.length === 0; i += 1) await Bun.sleep(5);
    expect(proxy.closed).toEqual([true]);
    proxy.server.close();
  });

  it("closes its connection when the attempt runs out of time", async () => {
    const proxy = await standInProxy(null);
    const clock = new ManualClock();
    const attempt = proxiedStatus(
      { host: "127.0.0.1", port: proxy.port },
      "127.0.0.1",
      PEM,
      SAFE_CHAIN_CHECK_ALLOWED_URL,
      clock,
    );
    await Bun.sleep(20);
    clock.advance(SAFE_CHAIN_CHECK_TIMEOUT_MS);
    await expect(attempt).rejects.toThrow("timed out");
    for (let i = 0; i < 20 && proxy.closed.length === 0; i += 1) await Bun.sleep(5);
    expect(proxy.closed).toEqual([true]);
    proxy.server.close();
  });
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

/** Settles `work` while moving `clock` on, so the check's retries and deadlines fall due. */
async function settled<T>(work: Promise<T>, clock: ManualClock): Promise<T> {
  let done = false;
  void work.finally(() => (done = true)).catch(() => {});
  for (let i = 0; i < 2_000 && !done; i += 1) {
    await Bun.sleep(1);
    clock.advance(1_000);
  }
  return work;
}

/** A stand-in Safe-Chain box port: answers every CONNECT with `answer`. */
async function standInSafeChain(answer: string) {
  const server = createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", () => socket.end(answer));
  });
  const port = await new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    }),
  );
  return { server, port };
}

// What the check refused before DIPO-383, each pinned as a route that does not start (R30).
describe.skipIf(!RUNS)("what the Safe-Chain check refuses", () => {
  for (const [what, statuses, reason] of [
    [
      "the allowed download answers 502",
      { [SAFE_CHAIN_CHECK_ALLOWED_URL]: 502 },
      "did not work after 3 attempts (502)",
    ],
    [
      "the allowed download answers 404",
      { [SAFE_CHAIN_CHECK_ALLOWED_URL]: 404 },
      "did not work after 3 attempts (404)",
    ],
    [
      "safe-chain-test answers 404",
      { [SAFE_CHAIN_CHECK_BLOCKED_URL]: 404 },
      "did not refuse its test package safe-chain-test (404)",
    ],
  ] as const) {
    it(`does not start the route when ${what}`, () =>
      withTempDir(async (tmp) => {
        const clock = new ManualClock();
        const { started, boxes, caFile } = await settled(route(tmp, { statuses, clock }), clock);
        expect(started.ok).toBe(false);
        if (started.ok) return;
        expect(started.reason).toContain(reason);
        expect(boxes.boxes.has(SAFE_CHAIN_BOX)).toBe(false);
        expect(existsSync(caFile)).toBe(false);
      }));
  }

  it("does not take a 403 before TLS, from a proxy, for Safe-Chain's refusal", () =>
    withTempDir(async (tmp) => {
      const clock = new ManualClock();
      const standIn = await standInSafeChain("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      try {
        const { started, boxes } = await settled(
          route(tmp, { clock, realDownload: true, safeChainPort: standIn.port }),
          clock,
        );
        expect(started.ok).toBe(false);
        if (started.ok) return;
        expect(started.reason).toContain("the web proxy refused the tunnel (403)");
        expect(started.reason).toContain("did not work after 3 attempts");
        expect(boxes.boxes.has(SAFE_CHAIN_BOX)).toBe(false);
      } finally {
        standIn.server.close();
      }
    }));

  it("does not start the route when the tunnel to Safe-Chain is refused", () =>
    withTempDir(async (tmp) => {
      const clock = new ManualClock();
      const { started, boxes, proxyEvents } = await settled(
        route(tmp, { clock, realDownload: true }),
        clock,
      );
      expect(started.ok).toBe(false);
      if (started.ok) return;
      expect(started.reason).toContain(
        "did not work after 3 attempts (the web proxy refused the tunnel (502))",
      );
      expect(proxyEvents).toContainEqual({
        kind: "refused",
        target: "registry.npmjs.org:443",
        reason: "the Safe-Chain box did not answer",
      });
      expect(boxes.boxes.has(SAFE_CHAIN_BOX)).toBe(false);
    }));
});
