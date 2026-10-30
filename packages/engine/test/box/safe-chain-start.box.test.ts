// The start of dipo's web route on real boxes (DIPO-383), opt-in: it registers only with
// DIPO_TEST_BOX=1, never in CI, on macOS with Apple container 1.6.0 or newer and the internet. It
// builds a Safe-Chain image of its own, under a test tag, so it never removes or replaces the
// machine-wide one dipo uses. The maintainer runs it by hand:
//
//   DIPO_TEST_BOX=1 bun test packages/engine/test/box/safe-chain-start.box.test.ts
//
// - After its Safe-Chain image is removed and built again, the route starts ten times in a row.
// - A dead first address of the malware lists does not hold Safe-Chain's fetch up: the next one
//   is tried within seconds and the route starts.
// - A malware-list host that never answers: the start script prints no ready line, the route
//   fails closed before its check, and the reason names the host.
// - Fail-closed on the real path: a Safe-Chain box the web proxy never reaches (it never
//   forwards) fails the route, and no install reaches a registry.
// A raw box (a build box of alpine) runs on the box network throughout, since the network's address
// on the Mac exists only while a box runs. Every outcome is also printed as a `fact:` line.

import { lookup } from "node:dns/promises";
import { connect, Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { cleanEnv, makeTempDir, removeTempDir } from "@dipsaus-orchestrator/testkit";

import { AppleContainerBoxes } from "../../src/box/apple-container";
import { BUILD_BOX_RUN_PREFIX, type BoxNetwork, boxName } from "../../src/box/port";
import { SAFE_CHAIN_MALWARE_LIST_HOST, SAFE_CHAIN_REGISTRY_HOSTS } from "../../src/box/safe-chain";
import {
  type SafeChainBoxInfo,
  type SafeChainRouteDeps,
  startBoxWebRoute,
} from "../../src/box/safe-chain-box";
import type { BoxWebProxyDeps, WebProxyEvent } from "../../src/box/web-proxy";
import { systemClock } from "../../src/platform/clock";
import { systemSpawn } from "../../src/platform/process";
import { cleanUpRealBoxes } from "./real-box-cleanup";

const registers =
  process.env["DIPO_TEST_BOX"] === "1" &&
  process.env["DIPO_TEST_CI"] !== "1" &&
  process.env["CI"] === undefined &&
  process.platform === "darwin";

/** The raw box that keeps the box network's address on the Mac. */
const KEEP_IMAGE = "docker.io/library/alpine:3.20";
/** This test's own Safe-Chain image: a dipo box image tag no plan of dipo's hashes to. */
const TEST_TAG = `dipo-box:${new Bun.CryptoHasher("sha256").update("DIPO-383 test Safe-Chain image").digest("hex")}`;
/** The image build and ten starts take minutes. */
const TIMEOUT_MS = 30 * 60_000;

/** The addresses the upstream listener resolves a malware-list host to, as it resolves them. */
async function malwareListAddresses(): Promise<Set<string>> {
  return new Set(
    (await lookup(SAFE_CHAIN_MALWARE_LIST_HOST, { all: true })).map((entry) => entry.address),
  );
}

function fact(text: string): void {
  console.log(`fact: ${text}`);
}

if (registers) {
  // Every box this run makes is deleted after its tests, and one an earlier run left is reported.
  const cleanup = cleanUpRealBoxes(import.meta.path);
  const root = makeTempDir();
  const env = cleanEnv();
  const toolsRoot = join(root, "box-net-tools");
  const boxes = new AppleContainerBoxes({
    stateLabel: cleanup.stateLabel,
    spawn: systemSpawn,
    clock: systemClock,
    env: { PATH: env["PATH"] ?? "/usr/bin:/bin:/usr/local/bin", HOME: homedir() },
    netToolsRoot: toolsRoot,
  });
  const keepRun = `${BUILD_BOX_RUN_PREFIX}${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const keep = boxName(keepRun);
  /** The Safe-Chain box of the last start: this test's own, by name. */
  let lastBox = "";
  let network: BoxNetwork | null = null;

  /** One route start with this test's image; the proxy's events and the upstream listener's. */
  const start = async (
    deps: Partial<SafeChainRouteDeps> = {},
    proxy: Partial<BoxWebProxyDeps> = {},
  ) => {
    const events: (WebProxyEvent & { at: number })[] = [];
    let info: SafeChainBoxInfo | null = null;
    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
    lastBox = `dipo-safe-chain-${id}`;
    const started = await startBoxWebRoute(
      network as BoxNetwork,
      {
        boxes,
        clock: systemClock,
        scratchRoot: join(root, "scratch"),
        toolsRoot,
        caFile: join(root, "route", "ca.pem"),
        imageTag: TEST_TAG,
        boxId: () => id,
        onSafeChain: (box) => {
          info = box;
        },
        ...deps,
      },
      {
        clock: systemClock,
        onEvent: (event) => events.push({ ...event, at: performance.now() }),
        ...proxy,
      },
    );
    return { started, events, info: info as SafeChainBoxInfo | null };
  };

  beforeAll(async () => {
    expect(await boxes.check()).toMatchObject({ ok: true });
    network = await boxes.network();
    await boxes.create({ runId: keepRun, image: KEEP_IMAGE, network });
    await boxes.start(keep);
  }, TIMEOUT_MS);

  afterAll(async () => {
    await boxes.delete(keep).catch(() => {});
    await boxes.deleteImage(TEST_TAG).catch(() => {});
    removeTempDir(root);
  }, TIMEOUT_MS);

  describe("the start of the web route on real boxes (DIPO-383)", () => {
    it(
      "starts ten times in a row after its Safe-Chain image is removed and built again",
      async () => {
        if (await boxes.hasImage(TEST_TAG)) await boxes.deleteImage(TEST_TAG);
        expect(await boxes.hasImage(TEST_TAG)).toBe(false);
        const results: string[] = [];
        for (let i = 0; i < 10; i += 1) {
          const begun = performance.now();
          const { started } = await start();
          const took = Math.round(performance.now() - begun);
          results.push(started.ok ? "ok" : started.reason);
          fact(`start ${i + 1}: ${started.ok ? "ok" : started.reason} in ${took} ms`);
          if (started.ok) await started.route.stop();
          if (i === 0) expect(await boxes.hasImage(TEST_TAG)).toBe(true);
        }
        expect(results).toEqual(Array.from({ length: 10 }, () => "ok"));
      },
      TIMEOUT_MS,
    );

    it(
      "does not let a dead first address of the malware lists hold the start up",
      async () => {
        const listed = await malwareListAddresses();
        let deadAt: number | null = null;
        const { started, events } = await start(
          {},
          {
            connectBox: (options) => connect(options),
            connect: (address, port) => {
              if (deadAt === null && listed.has(address)) {
                deadAt = performance.now();
                fact(`the malware lists' first address ${address} never answers`);
                return new Socket();
              }
              return connect({ host: address, port });
            },
          },
        );
        if (started.ok) await started.route.stop();
        expect(started.ok ? "ok" : started.reason).toBe("ok");
        const reached = events.find(
          (event) => event.kind === "direct" && event.host === SAFE_CHAIN_MALWARE_LIST_HOST,
        );
        const waited = Math.round((reached?.at ?? Infinity) - (deadAt ?? 0));
        fact(`the malware lists reached ${waited} ms after the dead address was tried`);
        expect(deadAt).not.toBeNull();
        expect(waited).toBeLessThan(5_000);
      },
      TIMEOUT_MS,
    );

    it(
      "fails closed before its check when the malware-list host never answers, and names it",
      async () => {
        const listed = await malwareListAddresses();
        const { started, events } = await start(
          // The start script then gives up loading after 40 s.
          { readyTimeoutMs: 60_000 },
          {
            connectBox: (options) => connect(options),
            connect: (address, port) =>
              listed.has(address) ? new Socket() : connect({ host: address, port }),
          },
        );
        expect(started.ok).toBe(false);
        if (started.ok) return;
        fact(`the route did not start: ${started.reason}`);
        expect(started.reason).toContain("could not load its malware list");
        expect(started.reason).toContain(`no address of ${SAFE_CHAIN_MALWARE_LIST_HOST} answered`);
        // The check never ran: no tunnel went to the Safe-Chain box.
        expect(events.filter((event) => event.kind === "registry")).toEqual([]);
        expect((await boxes.list()).some((box) => box.name === lastBox)).toBe(false);
      },
      TIMEOUT_MS,
    );

    it(
      "fails closed when the web proxy never reaches Safe-Chain, and no install reaches a registry",
      async () => {
        const { started, events } = await start(
          {},
          // The Safe-Chain box takes no connection from the web proxy: it never forwards.
          { connectBox: () => new Socket() },
        );
        expect(started.ok).toBe(false);
        if (started.ok) return;
        fact(`the route did not start: ${started.reason.split("\n")[0]}`);
        expect(started.reason).toContain("did not work after 3 attempts");
        expect(events.filter((event) => event.kind === "registry")).toEqual([]);
        // Only Safe-Chain's own loads reached a registry, through the upstream listener before the
        // ready line; nothing the check sent went anywhere but to the Safe-Chain box.
        const direct = events.filter(
          (event) => event.kind === "direct" && SAFE_CHAIN_REGISTRY_HOSTS.includes(event.host),
        );
        fact(`registry connections, all Safe-Chain's own loads: ${direct.length}`);
        expect(direct.length).toBeLessThanOrEqual(2);
        expect((await boxes.list()).some((box) => box.name === lastBox)).toBe(false);
      },
      TIMEOUT_MS,
    );
  });
}
