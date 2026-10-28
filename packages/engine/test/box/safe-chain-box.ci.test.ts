// Safe-Chain in a box of its own on real boxes (DIPO-343; criteria 1 to 4). It registers only with
// both DIPO_TEST_CI=1 and DIPO_TEST_BOX=1, on macOS: it needs Apple container 1.6.0 or newer with
// its service running and the internet, and builds the Safe-Chain image and the default office
// image the first time (minutes). CI without a box sets only DIPO_TEST_CI, so it skips this file.
// The maintainer runs it by hand:
//
//   DIPO_TEST_CI=1 DIPO_TEST_BOX=1 bun test packages/engine/test/box/safe-chain-box.ci.test.ts
//
// One web route, as dipo starts it: the web proxy, the upstream listener and the Safe-Chain box
// made from the machine-wide Safe-Chain image. A box of the office image, behind its firewall as a
// session sets it, runs every try as the box user, as the worker does:
// - An install through the Safe-Chain box works, and Safe-Chain's test package is refused.
// - What the old barrier caught still fails: a registry tunnel that skips Safe-Chain (straight out,
//   through the upstream listener, or to a registry's IP address), the test package, and the box
//   reaching any port of the Safe-Chain box.
// - The bypass forms fail: a registry alias and a CDN name, an IP literal, a TLS handshake naming
//   another host than the tunnel, and a proxy setting changed inside the box.
// - Fail-closed on the real path: with the Safe-Chain box stopped an install fails, and the web
//   proxy reaches no registry: no registry tunnel, and no direct one to a registry host.
// Every outcome is also printed as a `fact:` line.

import { lookup } from "node:dns/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "bun:test";

import { cleanEnv, makeTempDir, removeTempDir } from "@dipsaus-orchestrator/testkit";

import { AppleContainerBoxes } from "../../src/box/apple-container";
import { ensureBoxImage } from "../../src/box/build-box";
import { BOX_IMAGE_ENV, describeBox } from "../../src/box/image";
import { type BoxNetwork, boxName, isBoxTimedOut } from "../../src/box/port";
import { SAFE_CHAIN_BOX_PORTS, SAFE_CHAIN_REGISTRY_HOSTS } from "../../src/box/safe-chain";
import {
  type SafeChainBoxInfo,
  type SafeChainRouteEvent,
  startBoxWebRoute,
} from "../../src/box/safe-chain-box";
import { BoxWebRoute, type RunningBoxWebRoute, type WebProxyEvent } from "../../src/box/web-proxy";
import { systemClock } from "../../src/platform/clock";
import { systemSpawn } from "../../src/platform/process";

/** The CI guard of every *.ci.test.ts file (0017 section 1). */
const inCi = process.env["DIPO_TEST_CI"] === "1";
const registers = inCi && process.env["DIPO_TEST_BOX"] === "1" && process.platform === "darwin";

/** The image builds take minutes; the tries, a few more. */
const TIMEOUT_MS = 45 * 60_000;
/** The CA bundle's path in the box, root's, as a session copies it. */
const BOX_CA = "/dipo/safe-chain-ca.pem";

function fact(text: string): void {
  console.log(`fact: ${text}`);
}

/**
 * A tunnel to example.com through the proxy in `HTTPS_PROXY` (with the box's proxy password),
 * whose TLS handshake then names registry.npmjs.org: exit 0 only if the registry answered.
 */
const TLS_NAMING_A_REGISTRY = [
  'const net = require("net"), tls = require("tls");',
  "const u = new URL(process.env.HTTPS_PROXY);",
  'const auth = Buffer.from(decodeURIComponent(u.username) + ":" + decodeURIComponent(u.password)).toString("base64");',
  "const s = net.connect(Number(u.port), u.hostname, () => s.write(",
  '  "CONNECT example.com:443 HTTP/1.1\\r\\nHost: example.com:443\\r\\nProxy-Authorization: Basic " + auth + "\\r\\n\\r\\n"));',
  's.once("data", (d) => {',
  '  if (!String(d).startsWith("HTTP/1.1 200")) { console.log("tunnel: " + String(d).slice(0, 40)); process.exit(2); }',
  '  const t = tls.connect({ socket: s, servername: "registry.npmjs.org", rejectUnauthorized: false }, () =>',
  '    t.write("GET / HTTP/1.1\\r\\nHost: registry.npmjs.org\\r\\n\\r\\n"));',
  '  t.on("data", () => process.exit(0));',
  '  t.on("error", (e) => { console.log("tls: " + e.message); process.exit(1); });',
  '  t.on("close", () => { console.log("tls: closed"); process.exit(1); });',
  "});",
  's.on("error", (e) => { console.log("proxy: " + e.message); process.exit(3); });',
  "setTimeout(() => process.exit(4), 15000);",
].join("\n");

/** The status line a CONNECT to `target` through the proxy at `host:port` gets, from the Mac. */
function connectLine(host: string, port: number, target: string): Promise<string> {
  return new Promise((resolve) => {
    // From the box network's host address, as dipo connects (`connectToBox`): a VPN may route the
    // box subnet, the bridge address among it, into its tunnel.
    const socket = connect({ host, port, localAddress: host }, () =>
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`),
    );
    let text = "";
    const done = () => {
      socket.destroy();
      resolve(text.split("\r\n")[0] ?? "");
    };
    socket.on("data", (chunk) => {
      text += chunk.toString("latin1");
      if (text.includes("\r\n")) done();
    });
    socket.on("error", done);
    socket.on("close", done);
  });
}

/** An npm install as the worker runs one, with a fresh prefix and cache under /tmp. */
function npm(spec: string, prefix: string): string {
  return `npm install --prefix /tmp/${prefix} --cache /tmp/${prefix}-cache --no-audit --no-fund ${spec}`;
}

/** A curl of `target` that prints the status; `proxyUrl` null goes without any proxy. */
function curl(target: string, proxyUrl: string | null, more = ""): string {
  const via = proxyUrl === null ? "--noproxy '*'" : `-x ${proxyUrl}`;
  return `curl -sS -m 10 -o /dev/null -w '%{http_code}' ${via} --cacert ${BOX_CA} ${more} ${target}`;
}

if (registers) {
  const root = makeTempDir();
  const env = cleanEnv();
  const cliEnv = { PATH: env["PATH"] ?? "/usr/bin:/bin:/usr/local/bin", HOME: homedir() };
  const toolsRoot = join(root, "box-net-tools");
  const boxes = new AppleContainerBoxes({
    spawn: systemSpawn,
    clock: systemClock,
    env: cliEnv,
    netToolsRoot: toolsRoot,
  });
  const events: WebProxyEvent[] = [];
  let safeChain: SafeChainBoxInfo | null = null;
  const routeEvents: SafeChainRouteEvent[] = [];
  let network: BoxNetwork | null = null;
  const route = new BoxWebRoute<RunningBoxWebRoute>(async () => {
    const started = await startBoxWebRoute(
      network ?? (await boxes.network()),
      {
        boxes,
        clock: systemClock,
        scratchRoot: join(root, "scratch"),
        toolsRoot,
        caFile: join(root, "route", "ca.pem"),
        onSafeChain: (info) => {
          safeChain = info;
        },
        onRoute: (event) => routeEvents.push(event),
        onEvent: (event) => fact(`Safe-Chain image build cleanup: ${JSON.stringify(event)}`),
      },
      { clock: systemClock, onEvent: (event) => events.push(event) },
    );
    if (!started.ok) throw new Error(started.reason);
    return started.route;
  });

  afterAll(async () => {
    await route.close();
    removeTempDir(root);
  });

  /** A shell line in `box` as the box user, as the worker runs it: its exit and output. */
  /**
   * A shell line in `box` as the box user, as the worker runs it: its exit and output. A line still
   * running after two minutes reached nothing in time, so it counts as failed (exit null); the box
   * is deleted at the end of the test, which ends it.
   */
  const sh = async (box: string, line: string, extra: Record<string, string> = {}) => {
    try {
      const done = await boxes.exec(box, ["sh", "-c", line], {
        env: { ...BOX_IMAGE_ENV, ...extra },
        timeoutMs: 120_000,
      });
      return { code: done.code, out: `${done.stdout}${done.stderr}` };
    } catch (error) {
      if (isBoxTimedOut(error)) return { code: null, out: "timed out" };
      throw error;
    }
  };

  describe.if(inCi)("Safe-Chain in its own box (DIPO-343)", () => {
    it(
      "checks every install of a box, and nothing reaches a registry around it or without it",
      async () => {
        expect(await boxes.check()).toMatchObject({ ok: true });
        network = await boxes.network();
        const hostAddress = network.hostAddress;
        // The office image, built (or reused) through the route: its npm installs went
        // through the Safe-Chain box, which the route started for the build box. The image is
        // this test's own (with `file` and pip), so a rebuild never replaces one that dipo or another
        // test made.
        const office = await ensureBoxImage(
          {
            boxes,
            route,
            scratchRoot: join(root, "scratch"),
            toolsRoot,
            clock: systemClock,
          },
          describeBox({ packages: ["file", "python3-pip"] }, {}).image,
        );
        fact(`office image ${office.tag} ${office.built ? "built" : "reused"}`);
        const runId = `test-${crypto.randomUUID().slice(0, 8)}`;
        const name = boxName(runId);
        try {
          await boxes.create({ runId, image: office.tag, network, netTools: office.netTools });
          await boxes.start(name);
          const web = await route.acquire(name);
          const info = safeChain as SafeChainBoxInfo | null;
          if (info === null) throw new Error("the route reported no Safe-Chain box");
          fact(`Safe-Chain box ${info.name} at ${info.address}`);
          // As a session sets it: the box reaches the web proxy's port on the Mac, no more.
          await boxes.firewall(name, { hostAddress, ports: [web.port] });
          const stage = join(root, "dipo-files");
          mkdirSync(stage, { recursive: true });
          writeFileSync(join(stage, "safe-chain-ca.pem"), readFileSync(web.caFile));
          await boxes.copyIn(name, `${stage}/.`, "/dipo");
          const proxy = web.admit(name, []);
          const through = { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, NODE_EXTRA_CA_CERTS: BOX_CA };
          // Criterion 1: an install through the Safe-Chain box works.
          const installed = await sh(name, npm("is-number@7.0.0", "a"), through);
          fact(`install of is-number@7.0.0: exit ${installed.code}`);
          expect(installed.code).toBe(0);
          expect(events).toContainEqual({
            kind: "registry",
            host: "registry.npmjs.org",
            port: 443,
          });

          // Criterion 2: what the old barrier caught.
          const blocked = await sh(name, npm("safe-chain-test", "b"), through);
          fact(`install of safe-chain-test: exit ${blocked.code}`);
          expect(blocked.code).not.toBe(0);
          expect(blocked.out).toMatch(/403|blocked by safe-chain/i);
          const registryIp = (await lookup("registry.npmjs.org", { family: 4 })).address;
          // Each with why it fails: curl's exit code where the box's firewall or its lack of a
          // route stops it (6: no name service, 28: dropped until the timeout; 124: `timeout`
          // ended a connect the firewall dropped), and the proxy's 403 where the proxy refuses.
          const skips: [string, string, number, RegExp | null][] = [
            ["straight out", curl("https://registry.npmjs.org/", null), 6, null],
            [
              "through the upstream listener",
              curl("https://registry.npmjs.org/", info.upstreamUrl),
              28,
              null,
            ],
            [
              "to the registry's IP address",
              curl(`https://${registryIp}/`, proxy, "-k"),
              56,
              /response 403/,
            ],
            [
              "direct to its IP address",
              `timeout 6 bash -c 'exec 3<>/dev/tcp/${registryIp}/443'`,
              124,
              null,
            ],
          ];
          for (const [what, line, code, answer] of skips) {
            const tried = await sh(name, line);
            fact(`a registry tunnel ${what}: exit ${tried.code} ${tried.out.trim()}`);
            expect(tried.code).toBe(code);
            if (answer !== null) expect(tried.out).toMatch(answer);
          }
          for (const port of [SAFE_CHAIN_BOX_PORTS.npm, SAFE_CHAIN_BOX_PORTS.pypi, 22, 80]) {
            const tried = await sh(
              name,
              `timeout 6 bash -c 'exec 3<>/dev/tcp/${info.address}/${port}'`,
            );
            fact(`the box to port ${port} of the Safe-Chain box: exit ${tried.code}`);
            // Dropped by the firewall (no answer, no refusal) until `timeout` ends it.
            expect(tried.code).toBe(124);
          }
          // The upstream listener's own source check. No developer box reaches the listener at
          // all (its firewall drops the port, above), so the client here is the Mac, which is not
          // the Safe-Chain box either.
          const upstreamPort = Number(new URL(info.upstreamUrl).port);
          const sourceRefused = await connectLine(
            hostAddress,
            upstreamPort,
            "registry.npmjs.org:443",
          );
          fact(
            `the upstream listener to a client that is not the Safe-Chain box: ${sourceRefused}`,
          );
          expect(sourceRefused).toBe("HTTP/1.1 403 Forbidden");
          expect(events).toContainEqual({
            kind: "refused",
            target: "registry.npmjs.org:443",
            reason: `${hostAddress} is not the Safe-Chain box; this listener serves only Safe-Chain`,
          });

          // PyPI through the box's PyPI port (8102): a real pip download is checked by Safe-Chain.
          // Safe-Chain 1.5.12 has no PyPI test package (later releases add safe-chain-pi-test), so
          // no blocked PyPI package is tried.
          const pip = await sh(
            name,
            "pip download --no-deps --no-cache-dir --disable-pip-version-check -d /tmp/pip six==1.16.0 2>&1",
            { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, PIP_CERT: BOX_CA },
          );
          fact(
            `pip download of six==1.16.0: exit ${pip.code} ${pip.out.trim().split("\n").at(-1)}`,
          );
          expect(pip.code).toBe(0);
          expect(events).toContainEqual({ kind: "registry", host: "pypi.org", port: 443 });
          expect(events).toContainEqual({
            kind: "registry",
            host: "files.pythonhosted.org",
            port: 443,
          });

          // Criterion 3: the bypass forms.
          // Each refused tunnel's own answer, as curl reports it, or how the TLS probe ended.
          const refusals: [string, string, Record<string, string>, RegExp][] = [
            ["a registry alias", curl("https://registry.npmjs.com/", proxy), {}, /response 403/],
            [
              "a CDN name",
              curl("https://registry.npmjs.org.cdn.cloudflare.net/", proxy),
              {},
              /response 403/,
            ],
            [
              "an IP literal",
              curl(`https://${registryIp}/is-number`, proxy, "-k"),
              {},
              /response 403/,
            ],
            [
              "a TLS handshake naming another host",
              'node -e "$TLS_PROBE"',
              { HTTPS_PROXY: proxy, TLS_PROBE: TLS_NAMING_A_REGISTRY },
              /^tls: /m,
            ],
          ];
          for (const [what, line, extra, answer] of refusals) {
            const tried = await sh(name, line, extra);
            fact(`${what}: exit ${tried.code} ${tried.out.trim()}`);
            expect(tried.code).not.toBe(0);
            expect(tried.out).toMatch(answer);
          }
          // A proxy changed to an address the firewall drops hangs until `sh` gives up (exit
          // null); with no proxy at all, npm finds no name service.
          const bypasses: [string, string, Record<string, string>, number | null, RegExp | null][] =
            [
              [
                "the proxy changed to the Safe-Chain box",
                `${npm("is-odd@3.0.1", "c")} --fetch-retries 0`,
                { ...through, HTTPS_PROXY: `http://${info.address}:${SAFE_CHAIN_BOX_PORTS.npm}` },
                null,
                null,
              ],
              [
                "the proxy changed to the upstream listener",
                `${npm("is-odd@3.0.1", "d")} --fetch-retries 0`,
                { ...through, HTTPS_PROXY: info.upstreamUrl },
                null,
                null,
              ],
              [
                "the proxy setting removed",
                `unset HTTPS_PROXY HTTP_PROXY https_proxy http_proxy; ${npm("is-odd@3.0.1", "e")} --fetch-retries 0`,
                { NODE_EXTRA_CA_CERTS: BOX_CA },
                1,
                /EAI_AGAIN|ENOTFOUND/,
              ],
            ];
          for (const [what, line, extra, code, answer] of bypasses) {
            const tried = await sh(name, `${line} --fetch-timeout 15000 2>&1`, extra);
            const tail = tried.out.trim().split("\n").slice(-2).join(" | ");
            fact(`${what}: exit ${tried.code} ${tail}`);
            expect(tried.code).toBe(code);
            if (answer !== null) expect(tried.out).toMatch(answer);
          }
          expect(
            events.some(
              (event) =>
                event.kind === "refused" &&
                event.reason === "the TLS handshake asks for registry.npmjs.org, not example.com",
            ),
          ).toBe(true);

          // Criterion 4: fail-closed with the Safe-Chain box stopped.
          await boxes.stop(info.name);
          for (let i = 0; i < 50 && routeEvents.length === 0; i += 1) await Bun.sleep(100);
          expect(routeEvents.map((event) => event.kind)).toEqual(["safeChainEnded"]);
          const since = events.length;
          const failed = await sh(name, `${npm("is-odd@3.0.1", "f")} --fetch-retries 0`, through);
          fact(`install with the Safe-Chain box stopped: exit ${failed.code}`);
          expect(failed.code).not.toBe(0);
          const after = events.slice(since);
          fact(`web proxy events with the Safe-Chain box stopped: ${JSON.stringify(after)}`);
          expect(after.filter((event) => event.kind === "registry")).toEqual([]);
          expect(
            after.filter(
              (event) => event.kind === "direct" && SAFE_CHAIN_REGISTRY_HOSTS.includes(event.host),
            ),
          ).toEqual([]);
          expect(after).toContainEqual({
            kind: "refused",
            target: "registry.npmjs.org:443",
            reason: "Safe-Chain is not running, so no registry is reached",
          });
        } finally {
          await route.release(name).catch(() => {});
          await boxes.delete(name).catch(() => {});
        }
        // The Safe-Chain box goes with the route.
        expect((await boxes.list()).some((box) => box.name.startsWith("dipo-safe-chain-"))).toBe(
          route.running,
        );
      },
      TIMEOUT_MS,
    );
  });
}
