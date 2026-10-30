// What Safe-Chain refuses, read from its log in a real Safe-Chain box (DIPO-376), opt-in: it
// registers only with DIPO_TEST_BOX=1, on macOS and never in CI, because it needs Apple container
// 1.6.0 or newer with its service running and the internet, and builds the Safe-Chain image and
// this test's office image the first time (minutes). The maintainer runs it by hand:
//
//   DIPO_TEST_BOX=1 bun test packages/engine/test/box/safe-chain-refusals.box.test.ts
//
// One web route, as dipo starts it, and a box of the office image behind it, as a session sets it:
// - The session's mark is taken, then the box installs Safe-Chain's npm test package with npm and
//   with bun, and asks for a PyPI file on Aikido's malware list. Each is refused. Safe-Chain's log
//   then holds each refusal with its reason, and only the session's: the route's own check refused
//   the npm test package before the mark. So a Safe-Chain release that words its log otherwise
//   fails here, instead of dropping refusals without a word.
// - Fail-closed on the real path: once the route stopped, its Safe-Chain box and its logs are gone,
//   and the session's refusals are unknown, never "no refusals".
// Every log line and outcome is printed as a `fact:` line.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "bun:test";

import { cleanEnv, makeTempDir, removeTempDir } from "@dipsaus-orchestrator/testkit";

import { AppleContainerBoxes } from "../../src/box/apple-container";
import { ensureBoxImage } from "../../src/box/build-box";
import { BOX_DEFAULTS, BOX_IMAGE_ENV, describeBox } from "../../src/box/image";
import { type BoxNetwork, boxName } from "../../src/box/port";
import { SAFE_CHAIN_ECOSYSTEMS, safeChainLogFile } from "../../src/box/safe-chain";
import {
  markSafeChain,
  readSafeChain,
  type SafeChainBoxInfo,
  startBoxWebRoute,
} from "../../src/box/safe-chain-box";
import { BoxWebRoute, type RunningBoxWebRoute } from "../../src/box/web-proxy";
import { systemClock } from "../../src/platform/clock";
import { systemSpawn } from "../../src/platform/process";
import { cleanUpRealBoxes } from "./real-box-cleanup";

const registers =
  process.env["DIPO_TEST_BOX"] === "1" &&
  process.env["DIPO_TEST_CI"] !== "1" &&
  process.env["CI"] === undefined &&
  process.platform === "darwin";

/** The image builds take minutes; the tries, a few more. */
const TIMEOUT_MS = 45 * 60_000;
/** The CA bundle's path in the box, root's, as a session copies it. */
const BOX_CA = "/dipo/safe-chain-ca.pem";
/** Aikido's PyPI malware list, which Safe-Chain checks PyPI files against. */
const PYPI_MALWARE_LIST = "https://malware-list.aikido.dev/malware_pypi.json";
const MALWARE = "Aikido's malware list marks it MALWARE";

function fact(text: string): void {
  console.log(`fact: ${text}`);
}

/** A package on Aikido's PyPI malware list now, with a plain name: the list changes over time. */
async function pypiMalware(): Promise<{ readonly name: string; readonly version: string }> {
  const response = await fetch(PYPI_MALWARE_LIST);
  const list = (await response.json()) as {
    package_name: string;
    version: string;
    reason: string;
  }[];
  const entry = list.find(
    (item) =>
      item.reason === "MALWARE" &&
      /^[a-z]+$/.test(item.package_name) &&
      /^[0-9.]+$/.test(item.version),
  );
  if (entry === undefined) throw new Error("Aikido's PyPI malware list holds no plain entry");
  return { name: entry.package_name, version: entry.version };
}

if (registers) {
  // Every box this run makes is deleted after its tests, and one an earlier run left is reported.
  const cleanup = cleanUpRealBoxes(import.meta.path);
  const root = makeTempDir();
  const env = cleanEnv();
  const cliEnv = { PATH: env["PATH"] ?? "/usr/bin:/bin:/usr/local/bin", HOME: homedir() };
  const toolsRoot = join(root, "box-net-tools");
  const boxes = new AppleContainerBoxes({
    stateLabel: cleanup.stateLabel,
    spawn: systemSpawn,
    clock: systemClock,
    env: cliEnv,
    netToolsRoot: toolsRoot,
  });
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
      { clock: systemClock },
    );
    if (!started.ok) throw new Error(started.reason);
    return started.route;
  });

  afterAll(async () => {
    await route.close();
    removeTempDir(root);
  });

  /** A shell line in `box` as the box user, as the worker runs it: its exit and output. */
  const sh = async (box: string, line: string, extra: Record<string, string> = {}) => {
    const done = await boxes.exec(box, ["sh", "-c", line], {
      env: { ...BOX_IMAGE_ENV, ...extra },
      timeoutMs: 180_000,
    });
    return { code: done.code, out: `${done.stdout}${done.stderr}` };
  };

  describe("Safe-Chain's refusals in its log, in a real box (DIPO-376)", () => {
    it(
      "names each refusal of a session with Safe-Chain's reason, and none from before it",
      async () => {
        expect(await boxes.check()).toMatchObject({ ok: true });
        network = await boxes.network();
        // An office image with Bun and pip, built (or reused) through the route: a test's own tag,
        // so no image dipo uses is replaced.
        const office = await ensureBoxImage(
          { boxes, route, scratchRoot: join(root, "scratch"), toolsRoot, clock: systemClock },
          describeBox(
            { packages: ["file", "python3-pip"], toolchain: { bun: BOX_DEFAULTS.toolchain.bun } },
            {},
          ).image,
        );
        fact(`office image ${office.tag} ${office.built ? "built" : "reused"}`);
        const malware = await pypiMalware();
        fact(`PyPI package on Aikido's malware list: ${malware.name}@${malware.version}`);
        const runId = `test-${crypto.randomUUID().slice(0, 8)}`;
        const name = boxName(runId);
        let info: SafeChainBoxInfo | null = null;
        try {
          await boxes.create({ runId, image: office.tag, network, netTools: office.netTools });
          await boxes.start(name);
          const web = await route.acquire(name);
          info = safeChain as SafeChainBoxInfo | null;
          if (info === null) throw new Error("the route reported no Safe-Chain box");
          fact(`Safe-Chain box ${info.name}`);
          await boxes.firewall(name, { hostAddress: network.hostAddress, ports: [web.port] });
          const stage = join(root, "dipo-files");
          mkdirSync(stage, { recursive: true });
          writeFileSync(join(stage, "safe-chain-ca.pem"), readFileSync(web.caFile));
          await boxes.copyIn(name, `${stage}/.`, "/dipo");
          const proxy = web.admit(name, []);
          const through = { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, NODE_EXTRA_CA_CERTS: BOX_CA };

          // The session starts: its mark is after the route's own check of safe-chain-test.
          const mark = await markSafeChain(boxes, info.name);
          fact(`mark at the session's start: ${JSON.stringify(mark)}`);
          expect(mark.box).toBe(info.name);
          expect(mark.lines.npm).toBeGreaterThan(0);
          expect(mark.lines.pypi).not.toBeNull();

          const npm = await sh(
            name,
            "npm install --prefix /tmp/n --cache /tmp/n-cache --no-audit --no-fund safe-chain-test 2>&1",
            through,
          );
          fact(
            `npm install safe-chain-test: exit ${npm.code}: ${npm.out.trim().split("\n").slice(-3).join(" | ")}`,
          );
          // A bare 403 to the installer: it names no reason (DIPO-376 found it with bun).
          expect(npm.code).toBe(1);
          expect(npm.out).toContain("403");
          const bun = await sh(
            name,
            "mkdir -p /tmp/b && cd /tmp/b && bun add safe-chain-test 2>&1",
            through,
          );
          fact(
            `bun add safe-chain-test: exit ${bun.code}: ${bun.out.trim().split("\n").slice(-3).join(" | ")}`,
          );
          expect(bun.code).toBe(1);
          expect(bun.out).toContain("403");
          const file = `https://files.pythonhosted.org/packages/xx/yy/${malware.name}-${malware.version}.tar.gz`;
          const pypi = await sh(
            name,
            `curl -sS -m 60 -o /dev/null -w '%{http_code}' --cacert ${BOX_CA} -x "$HTTPS_PROXY" ${file}`,
            through,
          );
          fact(`a PyPI file on the malware list: exit ${pypi.code}, status ${pypi.out.trim()}`);
          expect(pypi.out.trim()).toBe("403");

          // What Safe-Chain wrote, as it wrote it.
          for (const ecosystem of SAFE_CHAIN_ECOSYSTEMS) {
            const log = await boxes.exec(info.name, ["cat", "--", safeChainLogFile(ecosystem)]);
            for (const line of log.stdout.trim().split("\n")) fact(`${ecosystem} log: ${line}`);
          }

          // The session ends: its refusals, and only its, each with Safe-Chain's reason.
          const found = await readSafeChain(boxes, info.name, mark);
          fact(`the session's refusals: ${JSON.stringify(found)}`);
          expect(found.unknown).toEqual([]);
          const npmRefusals = found.refusals.filter((refusal) => refusal.ecosystem === "npm");
          // npm and bun each asked for the test package at least once.
          expect(npmRefusals.length).toBeGreaterThanOrEqual(2);
          for (const refusal of npmRefusals) {
            expect(refusal).toEqual({
              ecosystem: "npm",
              package: "safe-chain-test@0.0.1-security",
              reason: MALWARE,
            });
          }
          expect(found.refusals.filter((refusal) => refusal.ecosystem === "pypi")).toEqual([
            { ecosystem: "pypi", package: `${malware.name}@${malware.version}`, reason: MALWARE },
          ]);
          // Read from the session's end on, the logs hold nothing more of it.
          const after = await markSafeChain(boxes, info.name);
          expect(await readSafeChain(boxes, info.name, after)).toEqual({
            refusals: [],
            unknown: [],
          });

          // Fail-closed: the route stops, its Safe-Chain box goes, and the session's log with it.
          await route.release(name);
          expect(route.running).toBe(false);
          const gone = await readSafeChain(boxes, info.name, mark);
          fact(`the session's refusals once the Safe-Chain box is gone: ${JSON.stringify(gone)}`);
          expect(gone.refusals).toEqual([]);
          expect(gone.unknown.map((log) => log.ecosystem)).toEqual(["npm", "pypi"]);
        } finally {
          await route.release(name).catch(() => {});
          await boxes.delete(name).catch(() => {});
        }
        // This test's Safe-Chain box went with its route.
        const left = (await boxes.list()).map((box) => box.name);
        expect(left).not.toContain(name);
        if (info !== null) expect(left).not.toContain((info as SafeChainBoxInfo).name);
      },
      TIMEOUT_MS,
    );
  });
}
