// What Safe-Chain refuses, read from its log in a real Safe-Chain box (DIPO-376), opt-in: it
// registers only with DIPO_TEST_BOX=1, on macOS and never in CI, because it needs Apple container
// 1.6.0 or newer with its service running and the internet, and builds the Safe-Chain image and
// this test's office image the first time (minutes). The maintainer runs it by hand:
//
//   DIPO_TEST_BOX=1 bun test packages/engine/test/box/safe-chain-refusals.box.test.ts
//
// One web route, as dipo starts it, and two boxes of the office image behind it, each as a session
// of its own run sets it, the two sessions open at once:
// - Each session's mark is taken, then box A installs Safe-Chain's npm test package with npm and
//   asks for a PyPI file on Aikido's malware list; then box B installs the same npm test package
//   with bun and asks for another PyPI file on the list. Each is refused, and the install fails.
//   Safe-Chain's log then holds each refusal with its reason, and each session keeps only its own
//   box's (DIPO-396): A's row holds the npm test package and its PyPI file, B's the npm test
//   package and its own, and the route's own check before the marks is in neither. So a
//   Safe-Chain release that words its log otherwise fails here, instead of dropping refusals
//   without a word.
// - The bypass forms: a tunnel with a wrong, a stale (B admitted again) or no proxy password still
//   goes to Safe-Chain, which still refuses, and its refusal is unknown on both open runs, never
//   one run's. A registry alias never reaches Safe-Chain: the proxy refuses it.
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
import type { SafeChainMark } from "../../src/box/safe-chain";
import {
  type SafeChainFound,
  type SafeChainUnknown,
  uniqueFound,
} from "../../src/prompts/safe-chain";
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

/** Three packages on Aikido's PyPI malware list now, with plain names: the list changes over time. */
async function pypiMalware(): Promise<{ readonly name: string; readonly version: string }[]> {
  const response = await fetch(PYPI_MALWARE_LIST);
  const list = (await response.json()) as {
    package_name: string;
    version: string;
    reason: string;
  }[];
  const names = new Set<string>();
  const entries = list.filter((item) => {
    const plain =
      item.reason === "MALWARE" &&
      /^[a-z]+$/.test(item.package_name) &&
      /^[0-9.]+$/.test(item.version) &&
      !names.has(item.package_name);
    if (plain) names.add(item.package_name);
    return plain;
  });
  if (entries.length < 3) throw new Error("Aikido's PyPI malware list holds too few plain entries");
  return entries.slice(0, 3).map((entry) => ({ name: entry.package_name, version: entry.version }));
}

/** Longer than a refusal's span on the Mac's clock, so two steps' tunnels never share one. */
const APART_MS = 3_000;

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

  describe("Safe-Chain's refusals in its log, each on its own box's run, in real boxes (DIPO-376, DIPO-396)", () => {
    it(
      "keeps each refusal of two overlapping sessions on its own box's run only, with Safe-Chain's reason",
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
        const [forA, forB, unnamed] = (await pypiMalware()) as [Malware, Malware, Malware];
        fact(
          `PyPI packages on Aikido's malware list: ${[forA, forB, unnamed].map(label).join(", ")}`,
        );
        const names = [boxName(`test-${crypto.randomUUID().slice(0, 8)}`), ""];
        names[1] = boxName(`test-${crypto.randomUUID().slice(0, 8)}`);
        const [nameA, nameB] = names as [string, string];
        let info: SafeChainBoxInfo | null = null;
        try {
          const web = await (async () => {
            let got: RunningBoxWebRoute | null = null;
            for (const name of [nameA, nameB]) {
              const runId = name.replace(/^dipo-/, "");
              await boxes.create({ runId, image: office.tag, network, netTools: office.netTools });
              await boxes.start(name);
              got = await route.acquire(name);
              await boxes.firewall(name, { hostAddress: network.hostAddress, ports: [got.port] });
              const stage = join(root, `dipo-files-${runId}`);
              mkdirSync(stage, { recursive: true });
              writeFileSync(join(stage, "safe-chain-ca.pem"), readFileSync(got.caFile));
              await boxes.copyIn(name, `${stage}/.`, "/dipo");
            }
            return got as RunningBoxWebRoute;
          })();
          info = safeChain as SafeChainBoxInfo | null;
          if (info === null) throw new Error("the route reported no Safe-Chain box");
          const scBox = info.name;
          fact(`Safe-Chain box ${scBox}, boxes ${nameA} and ${nameB}`);
          const through = (proxy: string) => ({
            HTTPS_PROXY: proxy,
            HTTP_PROXY: proxy,
            NODE_EXTRA_CA_CERTS: BOX_CA,
          });
          const proxyA = web.admit(nameA, []);
          const proxyB = web.admit(nameB, []);
          /** A PyPI file on the malware list through `proxy` from `box`: curl's status. */
          const pypiFile = async (box: string, proxy: string, malware: Malware) => {
            const file = `https://files.pythonhosted.org/packages/xx/yy/${malware.name}-${malware.version}.tar.gz`;
            const got = await sh(
              box,
              `curl -sS -m 60 -o /dev/null -w '%{http_code}' --cacert ${BOX_CA} -x "$HTTPS_PROXY" ${file}`,
              through(proxy),
            );
            fact(
              `${box}: a PyPI file of ${label(malware)}: exit ${got.code}, status ${got.out.trim()}`,
            );
            return got.out.trim();
          };

          // Both sessions start: their marks are after the route's own check of safe-chain-test.
          const markA = await markSafeChain(boxes, scBox, systemClock);
          const markB = await markSafeChain(boxes, scBox, systemClock);
          fact(`marks at the sessions' start: ${JSON.stringify([markA, markB])}`);
          for (const mark of [markA, markB]) {
            expect(mark.box).toBe(scBox);
            expect(mark.lines.npm).toBeGreaterThan(0);
            expect(mark.lines.pypi).not.toBeNull();
            expect(mark.clock).not.toBeNull();
          }

          // Box A: npm and a PyPI file. A bare 403 to the installer: it names no reason.
          const npm = await sh(
            nameA,
            "npm install --prefix /tmp/n --cache /tmp/n-cache --no-audit --no-fund safe-chain-test 2>&1",
            through(proxyA),
          );
          fact(`${nameA}: npm install safe-chain-test: exit ${npm.code}: ${tail(npm.out)}`);
          expect(npm.code).toBe(1);
          expect(npm.out).toContain("403");
          expect(await pypiFile(nameA, proxyA, forA)).toBe("403");
          await Bun.sleep(APART_MS);

          // Box B: the same npm package with bun, and another PyPI file.
          const bun = await sh(
            nameB,
            "mkdir -p /tmp/b && cd /tmp/b && bun add safe-chain-test 2>&1",
            through(proxyB),
          );
          fact(`${nameB}: bun add safe-chain-test: exit ${bun.code}: ${tail(bun.out)}`);
          expect(bun.code).toBe(1);
          expect(bun.out).toContain("403");
          expect(await pypiFile(nameB, proxyB, forB)).toBe("403");
          await Bun.sleep(APART_MS);

          // The bypass forms from box B: a wrong, a stale and no password. Safe-Chain still
          // refuses each; the tunnel names no box.
          const wrong = proxyB.replace(/:[^:@/]+@/, ":not-the-password@");
          const bare = proxyB.replace(/\/\/[^@]+@/, "//");
          const proxyB2 = web.admit(nameB, []);
          expect(proxyB2).not.toBe(proxyB);
          for (const proxy of [wrong, bare, proxyB]) {
            expect(await pypiFile(nameB, proxy, unnamed)).toBe("403");
          }
          await Bun.sleep(APART_MS);
          // A registry alias skips Safe-Chain only to be refused by the proxy: no tunnel at all.
          const alias = await sh(
            nameA,
            `curl -sS -m 60 -o /dev/null -w '%{http_connect}' --cacert ${BOX_CA} -x "$HTTPS_PROXY" https://registry.npmjs.com/safe-chain-test/-/safe-chain-test-0.0.1-security.tgz`,
            through(proxyA),
          );
          fact(
            `${nameA}: a registry alias: exit ${alias.code}, CONNECT status ${alias.out.trim()}`,
          );
          expect(alias.code).not.toBe(0);
          expect(alias.out).toContain("403");

          // What Safe-Chain wrote, as it wrote it.
          for (const ecosystem of SAFE_CHAIN_ECOSYSTEMS) {
            const log = await boxes.exec(scBox, ["cat", "--", safeChainLogFile(ecosystem)]);
            for (const line of log.stdout.trim().split("\n")) fact(`${ecosystem} log: ${line}`);
          }

          // Both sessions end: each keeps its own box's refusals, with Safe-Chain's reason, and
          // the tunnels that named no box as unknown on both.
          const read = async (mark: SafeChainMark, client: string): Promise<SafeChainFound> =>
            uniqueFound(
              await readSafeChain(boxes, scBox, mark, {
                clock: systemClock,
                client,
                tunnels: web.tunnels,
              }),
            );
          const foundA = await read(markA, nameA);
          const foundB = await read(markB, nameB);
          fact(`run A's refusals: ${JSON.stringify(foundA)}`);
          fact(`run B's refusals: ${JSON.stringify(foundB)}`);
          const malwareOf = (ecosystem: "npm" | "pypi", pkg: string) => ({
            ecosystem,
            package: pkg,
            reason: MALWARE,
          });
          const untied: SafeChainUnknown[] = [
            {
              ecosystem: "pypi",
              why: "Safe-Chain refused a package while a registry tunnel that named no box dipo admitted was open, so dipo cannot tell which box asked for it",
            },
          ];
          expect(foundA).toEqual({
            refusals: [
              malwareOf("npm", "safe-chain-test@0.0.1-security"),
              malwareOf("pypi", label(forA)),
            ],
            unknown: untied,
          });
          expect(foundB).toEqual({
            refusals: [
              malwareOf("npm", "safe-chain-test@0.0.1-security"),
              malwareOf("pypi", label(forB)),
            ],
            unknown: untied,
          });
          expect(JSON.stringify(foundA)).not.toContain(forB.name);
          expect(JSON.stringify(foundB)).not.toContain(forA.name);
          expect(JSON.stringify([foundA, foundB])).not.toContain(unnamed.name);
          // Read from the sessions' end on, the logs hold nothing more of them.
          const after = await markSafeChain(boxes, scBox, systemClock);
          expect(await read(after, nameA)).toEqual({ refusals: [], unknown: [] });

          // Fail-closed: the route stops, its Safe-Chain box goes, and the session's log with it.
          await route.release(nameA);
          await route.release(nameB);
          expect(route.running).toBe(false);
          const gone = await readSafeChain(boxes, scBox, markA, {
            clock: systemClock,
            client: nameA,
            tunnels: web.tunnels,
          });
          fact(`run A's refusals once the Safe-Chain box is gone: ${JSON.stringify(gone)}`);
          expect(gone.refusals).toEqual([]);
          expect(gone.unknown.map((log) => log.ecosystem)).toEqual(["npm", "pypi"]);
        } finally {
          for (const name of [nameA, nameB]) {
            await route.release(name).catch(() => {});
            await boxes.delete(name).catch(() => {});
          }
        }
        // These boxes and this test's Safe-Chain box went with the route.
        const left = (await boxes.list()).map((box) => box.name);
        expect(left).not.toContain(nameA);
        expect(left).not.toContain(nameB);
        if (info !== null) expect(left).not.toContain((info as SafeChainBoxInfo).name);
      },
      TIMEOUT_MS,
    );
  });
}

type Malware = { readonly name: string; readonly version: string };

/** `name@version`, as Safe-Chain names a package. */
function label(malware: Malware): string {
  return `${malware.name}@${malware.version}`;
}

/** The last three lines of an installer's output, on one line. */
function tail(out: string): string {
  return out.trim().split("\n").slice(-3).join(" | ");
}
