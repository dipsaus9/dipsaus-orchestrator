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
import { homedir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "bun:test";

import { cleanEnv, makeTempDir, removeTempDir } from "@dipsaus-orchestrator/testkit";

import { AppleContainerBoxes } from "../../src/box/apple-container";
import { ensureBoxImage } from "../../src/box/build-box";
import { BOX_IMAGE_ENV, describeBox } from "../../src/box/image";
import { type BoxNetwork, boxName, isBoxTimedOut } from "../../src/box/port";
import { SAFE_CHAIN_BOX_PORTS, SAFE_CHAIN_REGISTRY_HOSTS } from "../../src/box/safe-chain";
import { type SafeChainBoxInfo, startBoxWebRoute } from "../../src/box/safe-chain-box";
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
        // this test's own (with `file`), so a rebuild never replaces one that dipo or another
        // test made.
        const office = await ensureBoxImage(
          {
            boxes,
            route,
            scratchRoot: join(root, "scratch"),
            toolsRoot,
            clock: systemClock,
          },
          describeBox({ packages: ["file"] }, {}).image,
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
          const skips: [string, string][] = [
            ["straight out", curl("https://registry.npmjs.org/", null)],
            [
              "through the upstream listener",
              curl("https://registry.npmjs.org/", info.upstreamUrl),
            ],
            ["to the registry's IP address", curl(`https://${registryIp}/`, proxy, "-k")],
            ["direct to its IP address", `timeout 6 bash -c 'exec 3<>/dev/tcp/${registryIp}/443'`],
          ];
          for (const [what, line] of skips) {
            const tried = await sh(name, line);
            fact(`a registry tunnel ${what}: exit ${tried.code} ${tried.out.trim()}`);
            expect(tried.code).not.toBe(0);
          }
          for (const port of [SAFE_CHAIN_BOX_PORTS.npm, SAFE_CHAIN_BOX_PORTS.pypi, 22, 80]) {
            const tried = await sh(
              name,
              `timeout 6 bash -c 'exec 3<>/dev/tcp/${info.address}/${port}'`,
            );
            fact(`the box to port ${port} of the Safe-Chain box: exit ${tried.code}`);
            expect(tried.code).not.toBe(0);
          }

          // Criterion 3: the bypass forms.
          const bypasses: [string, string, Record<string, string>][] = [
            ["a registry alias", curl("https://registry.npmjs.com/", proxy), {}],
            ["a CDN name", curl("https://registry.npmjs.org.cdn.cloudflare.net/", proxy), {}],
            ["an IP literal", curl(`https://${registryIp}/is-number`, proxy, "-k"), {}],
            [
              "a TLS handshake naming another host",
              curl(
                "https://registry.npmjs.org/is-number",
                proxy,
                "--connect-to registry.npmjs.org:443:example.com:443",
              ),
              {},
            ],
            [
              "the proxy changed to the Safe-Chain box",
              `${npm("is-odd@3.0.1", "c")} --fetch-retries 0`,
              { ...through, HTTPS_PROXY: `http://${info.address}:${SAFE_CHAIN_BOX_PORTS.npm}` },
            ],
            [
              "the proxy changed to the upstream listener",
              `${npm("is-odd@3.0.1", "d")} --fetch-retries 0`,
              { ...through, HTTPS_PROXY: info.upstreamUrl },
            ],
            [
              "the proxy setting removed",
              `unset HTTPS_PROXY HTTP_PROXY https_proxy http_proxy; ${npm("is-odd@3.0.1", "e")} --fetch-retries 0`,
              { NODE_EXTRA_CA_CERTS: BOX_CA },
            ],
          ];
          for (const [what, line, extra] of bypasses) {
            const tried = await sh(name, `${line} --fetch-timeout 15000 2>&1 || exit 1`, extra);
            fact(`${what}: exit ${tried.code}`);
            expect(tried.code).not.toBe(0);
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
            reason: "the Safe-Chain box did not answer",
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
