// The test box on real boxes (DIPO-309, criteria 3 and 9 to 11; 0002, 0008), opt-in: it registers
// only with DIPO_TEST_BOX=1 and never in CI. It needs macOS with Apple container 1.6.0 or newer and
// its service running, and the internet (the web route builds its Safe-Chain box from the pinned
// release, DIPO-343): the office image (now with socat) is built in a build box on its first run,
// which takes minutes. No model session runs. The maintainer runs it by hand:
//
//   DIPO_TEST_BOX=1 bun test packages/engine/test/box/test-box.box.test.ts
//
// It makes two test boxes of a small repository through `TestBoxes.start`, with the real backend,
// web route, forwarder and reach check. `dev` is socat serving a fixed page: in box A only on the
// box's loopback (so dipo starts the relay), in box B on all of the box's addresses. A developer
// box D comes from `BoxWorkers.create` like every story's box. Every outcome is printed as a
// `fact:` line.
//
// - The way in (criterion 3): the URL is http://localhost:<port> on the Mac and serves the page,
//   also while a VPN routes the box network's range (the route the Mac takes to the box is printed);
//   no container port is published.
// - What the old rule caught still fails (criterion 9): from test box A, a new connection to the
//   Mac (a listener on all interfaces), and the internet directly; from developer box D with its
//   firewall set as an install sets it, a new connection to the Mac, and an answer to the Mac.
// - The bypass forms (criterion 10): from test box A, a reply-shaped connection (its source port
//   is the `dev` port) to the Mac with no connection the Mac opened, a connection to the
//   forwarder's port on the Mac, and a second port the product opens there; from box D (before its
//   own firewall, so only A's rule can stop it) a connection to A's `dev` port.
// - Fail closed against the real path (criterion 11): A's firewall set without the reply rule
//   makes the URL fail and opens nothing else; with the forwarder stopped the URL fails too.
// The test deletes the boxes it made; it stops or deletes nothing else, and keeps the image.

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, isIP, type Server } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { cleanEnv, ManualClock, withBareRemote, withTempDir } from "@dipsaus-orchestrator/testkit";

import { AppleContainerBoxes } from "../../src/box/apple-container";
import { startForwarder, systemReach } from "../../src/box/forwarder";
import { readBaseBox } from "../../src/box/image";
import { startModelProxy } from "../../src/box/model-proxy";
import { boxName } from "../../src/box/port";
import { type TestBoxRequest, TestBoxes } from "../../src/box/test-box";
import { startBoxWebRoute } from "../../src/box/safe-chain-box";
import { systemInterfaceAddresses } from "../../src/box/web-proxy";
import { BOX_INDEX_DIR, BoxWorkers } from "../../src/box/workers";
import { OfficeGit, spawnGitExec } from "../../src/git";
import { systemListenHttp } from "../../src/platform/box-host";
import { systemClock } from "../../src/platform/clock";
import { systemSpawn } from "../../src/platform/process";
import { AdapterHolds } from "../../src/workers/hold";

const registers =
  process.env["DIPO_TEST_BOX"] === "1" &&
  process.env["DIPO_TEST_CI"] !== "1" &&
  process.env["CI"] === undefined;

/** The image build on a cold builder and the boxes. */
const TIMEOUT_MS = 45 * 60_000;
const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z0000TST1" as OfficeId;
const DEV_PORT = 5173;
const SECOND_PORT = 6000;
const PAGE = "hello from the test box";
/**
 * `dev`: writes a fixed page, prints its URL, then serves the page on the address `BIND` names.
 * The page is a file, so no colon or comma of it reaches socat's address syntax.
 */
const DEV = `#!/bin/sh
curl -sS -m 20 -o /dev/null -w '%{http_code}' -x "$HTTPS_PROXY" https://example.com/ > /tmp/proxy.txt 2>/dev/null || true
printf 'HTTP/1.0 200 OK\\r\\nContent-Type: text/plain\\r\\n\\r\\n${PAGE}\\n' > /tmp/page.http
echo "  Local:   http://localhost:${DEV_PORT}/"
exec socat TCP-LISTEN:${DEV_PORT},bind="$BIND",fork,reuseaddr SYSTEM:"cat /tmp/page.http"
`;

/** True once `check` is, trying for about ten seconds: a listener just started may not be up yet. */
async function soon(check: () => Promise<boolean>): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt++) {
    if (await check()) return true;
    await Bun.sleep(1_000);
  }
  return false;
}

function fact(text: string): void {
  console.log(`fact: ${text}`);
}

/** A listener on all of the Mac's interfaces that counts the connections it gets. */
async function macListener(): Promise<{ server: Server; port: number; got: () => number }> {
  let got = 0;
  const server = createServer((socket) => {
    got += 1;
    socket.on("error", () => {});
    socket.end();
  });
  await new Promise<void>((resolve) => server.listen({ host: "0.0.0.0", port: 0 }, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { server, port: address.port, got: () => got };
}

/** The page at `url`, or the error's text; a short deadline, since a dropped packet hangs. */
async function page(url: string): Promise<string> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return `${response.status} ${(await response.text()).trim()}`;
  } catch (error) {
    return `failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** The interface the Mac's route to `address` names, from `route -n get`. */
async function routeOf(address: string): Promise<string> {
  const child = systemSpawn({
    cmd: ["/sbin/route", "-n", "get", address],
    env: { PATH: "/usr/bin:/bin" },
  });
  const text = await new Response(child.stdout).text();
  await child.exited;
  return /interface: (\S+)/.exec(text)?.[1] ?? "unknown";
}

if (registers) {
  describe("the test box on real boxes (DIPO-309)", () => {
    it(
      "is reached through the forwarder on the Mac's loopback only, answers only the Mac on its dev port, and fails closed",
      async () => {
        const env = cleanEnv();
        const home = homedir();
        const cliEnv = { PATH: env["PATH"] ?? "/usr/bin:/bin:/usr/local/bin", HOME: home };
        await withTempDir(async (tmp) => {
          await withBareRemote(async (repo) => {
            writeFileSync(join(repo.dir, "README.md"), "# a test box test\n");
            writeFileSync(join(repo.dir, "dev.sh"), DEV, { mode: 0o755 });
            const head = await repo.commitAll("start");
            await repo.git("push", "--quiet", "origin", "main");
            await repo.git("fetch", "--quiet", "origin");
            const real = realpathSync(repo.dir);
            const git = new OfficeGit({
              officeId: OFFICE,
              mainWorktree: real,
              commonDir: join(real, ".git"),
              settings: { remote: "origin", base: "main" },
              runner: { exec: spawnGitExec(systemSpawn), env: repo.env, sleep: async () => {} },
              clock: new ManualClock(),
            });
            const boxes = new AppleContainerBoxes({
              spawn: systemSpawn,
              clock: systemClock,
              cli: "/usr/local/bin/container",
              env: cliEnv,
              netToolsRoot: join(tmp, "state", "box-net-tools"),
            });
            expect(await boxes.check()).toMatchObject({ ok: true });
            const workers = new BoxWorkers({
              boxes,
              startWebRoute: (network, ids) =>
                startBoxWebRoute(
                  network,
                  {
                    boxes,
                    clock: systemClock,
                    scratchRoot: tmp,
                    toolsRoot: join(tmp, "state", "box-net-tools"),
                    caFile: join(tmp, "route", "ca.pem"),
                    boxId: ids.boxId,
                    buildId: ids.buildId,
                  },
                  { clock: systemClock },
                ),
              // No session runs, so the model proxy never starts.
              startModelProxy: (network) =>
                startModelProxy({
                  network,
                  keychain: { spawn: systemSpawn, clock: systemClock, env: cliEnv },
                  listen: systemListenHttp,
                }),
              readBaseBox,
              code: { spawn: systemSpawn, clock: systemClock },
              holds: new AdapterHolds({ clock: systemClock, notify: () => {} }),
              adapter: "claude-cli",
              tmpRoot: tmp,
              indexDir: join(tmp, "state", BOX_INDEX_DIR),
              scratchRoot: tmp,
              netToolsRoot: join(tmp, "state", "box-net-tools"),
              warn: (message, fields) => fact(`${message} ${JSON.stringify(fields)}`),
            });
            const infos: string[] = [];
            const tests = new TestBoxes({
              workers,
              boxes,
              forward: startForwarder,
              reach: systemReach,
              clock: systemClock,
              warn: (message, fields) => fact(`${message} ${JSON.stringify(fields)}`),
              info: (message) => infos.push(message),
            });
            const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
            const testA = `tst_A${suffix}`;
            const testB = `tst_B${suffix}`;
            const devRun = `test-${suffix.toLowerCase()}`;
            const boxA = boxName(testA);
            const reviewRun = `review-${suffix.toLowerCase()}`;
            const boxD = boxName(devRun);
            /** Stops every socat listener in `box` (dev and its relay), as the box user. */
            const stopDev = async (box: string) => {
              await boxes.exec(box, [
                "/bin/sh",
                "-c",
                "for p in /proc/[0-9]*; do if tr '\\0' ' ' < $p/cmdline 2>/dev/null | grep -q '^socat TCP-LISTEN'; then kill ${p#/proc/}; fi; done; true",
              ]);
            };
            const mac = await macListener();
            const request = (testId: string, bind: string): TestBoxRequest => {
              const runDir = join(tmp, "tests", testId);
              mkdirSync(runDir, { recursive: true });
              return {
                office: OFFICE,
                testId,
                runDir,
                git,
                head,
                install: null,
                // A setup step, so dev's proxy password must outlive it (one admission per box).
                setup: {
                  commands: [["sh", "-c", "echo setup"]],
                  cwd: ".",
                  env: {},
                  timeoutMs: 60_000,
                },
                dev: {
                  command: ["sh", "dev.sh"],
                  cwd: "/work",
                  env: { BIND: bind },
                  startTimeoutMs: 120_000,
                },
              };
            };
            /** True when `box` opens a TCP connection to `host:port`, as the box user. */
            const connects = async (box: string, host: string, port: number, extra = "") => {
              const ran = await boxes.exec(box, [
                "/bin/sh",
                "-c",
                `socat -u /dev/null TCP:${host}:${port},connect-timeout=3${extra}`,
              ]);
              return ran.code === 0;
            };
            try {
              const network = await boxes.network();
              const host = network.hostAddress;
              const lan = systemInterfaceAddresses()
                .map((entry) => entry.address)
                .find(
                  (candidate) =>
                    isIP(candidate) === 4 &&
                    (candidate.startsWith("192.168.") || candidate.startsWith("10.")) &&
                    !candidate.startsWith("192.168.12") &&
                    !candidate.startsWith("192.168.64.") &&
                    candidate !== host,
                );

              // Box A: dev only on the box's loopback, so dipo starts the relay. Its setup runs
              // first, and dev still gets a working proxy password (one admission per test box).
              const a = await tests.start(request(testA, "127.0.0.1"));
              fact(`test box A: ${JSON.stringify(a)}`);
              expect(infos.some((info) => info.includes("starting the relay"))).toBe(true);
              expect(a.url).toMatch(/^http:\/\/localhost:\d+\/$/);
              const proxied = await boxes.exec(boxA, ["/bin/cat", "/tmp/proxy.txt"]);
              expect(proxied.stdout.trim()).toBe("200");
              fact("dev reached the internet through the web route with its proxy password");
              const address = a.forward?.target.address ?? "";
              fact(`the Mac routes ${address} through ${await routeOf(address)}`);
              const url = a.url ?? "";
              expect(await page(url)).toBe(`200 ${PAGE}`);
              const spec = systemSpawn({
                cmd: ["/usr/local/bin/container", "inspect", boxA],
                env: cliEnv,
              });
              const described = JSON.parse(await new Response(spec.stdout).text()) as {
                configuration?: { publishedPorts?: unknown[] };
              }[];
              await spec.exited;
              expect(described[0]?.configuration?.publishedPorts ?? []).toEqual([]);
              fact("no container port is published");

              // Box D, a developer box, and box R, a reviewer's: made as every box is, no firewall
              // yet. D is the control below: what A cannot reach, a box without a firewall can.
              for (const runId of [devRun, reviewRun]) {
                mkdirSync(join(tmp, "runs", runId), { recursive: true });
                await workers.create({
                  office: OFFICE,
                  runId,
                  runDir: join(tmp, "runs", runId),
                  git,
                  startCommit: head,
                });
              }

              // Criterion 9, the test box: no new connection out, to the Mac, the local network
              // or the internet; box D reaches the Mac and its LAN address, so the rule stops A.
              expect(await connects(boxD, host, mac.port)).toBe(true);
              expect(await connects(boxA, host, mac.port)).toBe(false);
              expect(await connects(boxA, "1.1.1.1", 443)).toBe(false);
              if (lan !== undefined) {
                expect(await connects(boxD, lan, mac.port)).toBe(true);
                expect(await connects(boxA, lan, mac.port)).toBe(false);
                fact(`the Mac's local network address ${lan} is not reached from the test box`);
              }
              fact("test box A opens no connection to the Mac, the local network or the internet");

              // Criterion 10: the forwarder's port on the Mac. A listener on that port at the
              // Mac's bridge address shows the firewall is what stops it: box D reaches it.
              const forwarderPort = a.forward?.port ?? 0;
              const bridge = createServer((socket) => {
                socket.on("error", () => {});
                socket.end();
              });
              await new Promise<void>((resolve) =>
                bridge.listen({ host, port: forwarderPort }, resolve),
              );
              try {
                expect(await connects(boxD, host, forwarderPort)).toBe(true);
                expect(await connects(boxA, host, forwarderPort)).toBe(false);
              } finally {
                await new Promise<void>((resolve) => bridge.close(() => resolve()));
              }
              // And a second port the product opens.
              const second = boxes.execLive(boxA, [
                "socat",
                `TCP-LISTEN:${SECOND_PORT},bind=0.0.0.0,fork,reuseaddr`,
                "SYSTEM:echo second",
              ]);
              second.exited.catch(() => undefined);
              expect(await soon(() => connects(boxA, "127.0.0.1", SECOND_PORT))).toBe(true);
              expect(await systemReach({ address, port: SECOND_PORT, source: host }, 3_000)).toBe(
                false,
              );
              fact("the forwarder's port and a second port of the product are not reached");

              // Criterion 10: another box reaching A's dev port. D has no firewall yet, so only
              // A's own rule stands between them.
              expect(await connects(boxD, address, DEV_PORT)).toBe(false);
              fact("another box does not reach the test box's dev port");

              // Criterion 9, a developer box and a reviewer box with their firewall as an install
              // sets it: no new connection to the Mac, no answer to the Mac, and no way in.
              for (const runId of [devRun, reviewRun]) {
                const box = boxName(runId);
                await workers.route(runId);
                const refused = await workers.inbound(runId, [7000]).then(
                  () => "set",
                  (error: unknown) => (error as { code?: string }).code ?? "error",
                );
                expect(refused).toBe("box.refused");
                const before = mac.got();
                expect(await connects(box, host, mac.port)).toBe(false);
                expect(mac.got()).toBe(before);
                const listener = boxes.execLive(box, [
                  "socat",
                  "TCP-LISTEN:7000,bind=0.0.0.0,fork,reuseaddr",
                  "SYSTEM:echo d",
                ]);
                listener.exited.catch(() => undefined);
                expect(await soon(() => connects(box, "127.0.0.1", 7000))).toBe(true);
                const boxAddress = (await boxes.address(box)) ?? "";
                expect(
                  await systemReach({ address: boxAddress, port: 7000, source: host }, 3_000),
                ).toBe(false);
              }
              fact("a developer box and a reviewer box neither reach nor answer the Mac");

              // Criterion 11, fail closed: without the reply rule the URL fails, nothing opens.
              await workers.route(testA);
              expect(await page(url)).toStartWith("failed");
              expect(await systemReach({ address, port: DEV_PORT, source: host }, 3_000)).toBe(
                false,
              );
              expect(await connects(boxA, host, mac.port)).toBe(false);
              await workers.inbound(testA, [DEV_PORT]);
              expect(await page(url)).toBe(`200 ${PAGE}`);
              fact("without the reply rule the URL fails; with it back, it works");

              // Criterion 10: a reply-shaped packet with no connection the Mac opened. dev and its
              // relay stop, so the box's own connection may take the dev port as its source port.
              await stopDev(boxA);
              const loop = boxes.execLive(boxA, [
                "socat",
                "TCP-LISTEN:6001,bind=127.0.0.1",
                "SYSTEM:true",
              ]);
              loop.exited.catch(() => undefined);
              expect(
                await soon(() =>
                  connects(boxA, "127.0.0.1", 6001, `,sourceport=${DEV_PORT},reuseaddr`),
                ),
              ).toBe(true);
              const replies = mac.got();
              expect(
                await connects(boxA, host, mac.port, `,sourceport=${DEV_PORT},reuseaddr`),
              ).toBe(false);
              expect(mac.got()).toBe(replies);
              fact("a reply-shaped connection from the dev port does not reach the Mac");

              // Box B: dev on all of the box's addresses: no relay; then the forwarder stopped.
              infos.length = 0;
              const b = await tests.start(request(testB, "0.0.0.0"));
              expect(infos.some((info) => info.includes("starting the relay"))).toBe(false);
              expect(await page(b.url ?? "")).toBe(`200 ${PAGE}`);
              await tests.stopForwarders();
              expect(await page(b.url ?? "")).toStartWith("failed");
              fact("with the forwarder stopped the URL fails");

              // A daemon restart: B's box still runs its product, so it is taken up again on the
              // same port; once dev ended, it is not.
              const targetB = b.forward?.target ?? null;
              const again = await tests.reattach({
                testId: testB,
                target: targetB,
                port: b.forward?.port ?? null,
              });
              expect(again).toEqual({ port: b.forward?.port ?? 0 });
              expect(await page(b.url ?? "")).toBe(`200 ${PAGE}`);
              await tests.stopForwarders();
              await stopDev(boxName(testB));
              expect(
                await tests.reattach({
                  testId: testB,
                  target: targetB,
                  port: b.forward?.port ?? null,
                }),
              ).toBeNull();
              fact("after a restart a test is taken up again only while its dev answers");
            } finally {
              await tests.close(testA).catch(() => {});
              await tests.close(testB).catch(() => {});
              await boxes.delete(boxD).catch(() => {});
              await boxes.delete(boxName(reviewRun)).catch(() => {});
              await workers.close();
              await new Promise<void>((resolve) => mac.server.close(() => resolve()));
            }
          });
        });
      },
      TIMEOUT_MS,
    );
  });
}
