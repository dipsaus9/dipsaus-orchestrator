// One real box on Apple container (DIPO-265), opt-in: it registers only with DIPO_TEST_BOX=1 and
// never in CI, because it needs macOS with Apple container 1.6.0 or newer and its service running,
// pulls an image on its first run, and creates a real box and the host-only box network. The
// maintainer runs it by hand:
//
//   DIPO_TEST_BOX=1 bun test packages/engine/test/box/real-box.box.test.ts
//
// It checks the start check, the start time, copy in and out, exec, a long-running exec, memory,
// the list, files kept after stop and start, and delete. The box network stays for later runs.
// It also prints, with `fact:` lines, three behaviours of `container` the backend relies on:
// - what `container copy` out does with a symlink in the box that points outside the copied folder;
// - whether a killed `container exec` client leaves its process running in the box;
// - whether `container stats` on a stopped box exits non-zero.
//
// The image build (DIPO-266) registers only when the maintainer also names a running build proxy:
// DIPO_TEST_BOX_PROXY (`http://<host>:<port>`, reachable from the builder on the default network)
// and DIPO_TEST_BOX_CA (the Safe-Chain CA bundle that proxy wrote). dipo's web proxy
// (`box/web-proxy.ts`, DIPO-268) is that proxy, started on an address the builder reaches: the
// builder runs on the default network, not the box network. It builds the office image of a small
// description (minutes on a cold builder), builds it again to see the image reused, and checks the
// box it runs: Claude Code at its pinned version, with auto-update and nonessential traffic off,
// and neither the build proxy, the build CA nor git in the image.
//
// A second test (DIPO-268) repeats the DIPO-264 network lines through dipo's web proxy and the
// Safe-Chain proxy behind it, so it also needs the official Safe-Chain install (`~/.safe-chain`)
// and the internet: no way out without the proxy (by name, and by IP address to a public address,
// the Mac's own address and the default gateway, all found at test time); through it the Mac's
// loopback, the box network, the Mac's own address, the default gateway and IP literals are refused, plain HTTP proxying is refused, a registry
// (also with a trailing dot) goes through Safe-Chain, the internet works, and an npm install is
// checked by Safe-Chain.
//
// A third test (DIPO-267) fills the office package cache for a small Bun project on the Mac, through
// dipo's Safe-Chain proxy (so it also needs `~/.safe-chain` and the internet), mounts it in a box,
// and checks that every write to it from inside the box fails and the host files stay unchanged,
// and that a symlink in the cache root never becomes a mount. With the build proxy named as well,
// the office image then installs the project offline from the read-only cache into the box's own
// filesystem, and the worker's own Bun cache is not the package cache.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { lookup } from "node:dns/promises";
import { createServer, isIP, type Server } from "node:net";
import { homedir } from "node:os";
import { join, relative } from "node:path";

import { describe, expect, it } from "bun:test";

import { cleanEnv, withTempDir } from "@dipsaus-orchestrator/testkit";

import { statsArgs } from "../../src/box/apple-args";
import {
  boxCacheInstall,
  createBoxWithPackageCache,
  ensurePackageCache,
  fillEnvironment,
} from "../../src/box/cache";
import { boxImageTag, describeBox, ensureBoxImage } from "../../src/box/image";
import { AppleContainerBoxes } from "../../src/box/apple-container";
import { BoxError, boxName, isBoxTimedOut } from "../../src/box/port";
import {
  BoxWebRoute,
  type RunningBoxWebRoute,
  startBoxWebRoute,
  systemInterfaceAddresses,
  type WebProxyEvent,
} from "../../src/box/web-proxy";
import { systemClock } from "../../src/platform/clock";
import { currentPlatform } from "../../src/platform/paths";
import { systemSpawn } from "../../src/platform/process";
import { startSafeChainProxy } from "../../src/platform/safe-chain-proxy";

const IMAGE = "docker.io/library/alpine:3.20";
/** A first run pulls the image; later calls keep the 60 s default. */
const PULL_TIMEOUT_MS = 300_000;

/** The build proxy the image build needs; the build test registers only with both. */
const BUILD_PROXY = process.env["DIPO_TEST_BOX_PROXY"];
const BUILD_CA = process.env["DIPO_TEST_BOX_CA"];
/** An image build takes minutes. */
const BUILD_TIMEOUT_MS = 40 * 60_000;

const registers =
  process.env["DIPO_TEST_BOX"] === "1" &&
  process.env["DIPO_TEST_CI"] !== "1" &&
  process.env["CI"] === undefined;

/** The official Safe-Chain install the web route's Safe-Chain proxy copies its binary from. */
const SAFE_CHAIN_INSTALL = join(homedir(), ".safe-chain");

/** Listens on `host` with a free port, for the box to try to reach. */
function listenOn(host: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.end("HTTP/1.1 200 OK\r\n\r\n"));
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address !== null ? address.port : 0 });
    });
  });
}

/** The Mac's default IPv4 gateway, as `route` reports it now; null when it names none. */
async function defaultGateway(env: Record<string, string>): Promise<string | null> {
  const child = systemSpawn({ cmd: ["/sbin/route", "-n", "get", "default"], env });
  const [out] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  const gateway = /gateway:\s*(\S+)/.exec(out)?.[1] ?? null;
  return gateway !== null && isIP(gateway) === 4 ? gateway : null;
}

/** Every file below `dir`, relative to it, sorted. */
function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .toSorted();
}

/** A line the maintainer's run shows: one observed behaviour of `container`. */
function fact(text: string): void {
  console.log(`fact: ${text}`);
}

/** What the host path `path` is, without following a symlink. */
function describePath(path: string): string {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return "missing";
  }
  if (stat.isSymbolicLink()) return `a symlink to ${readlinkSync(path)}`;
  if (stat.isFile()) return `a regular file of ${stat.size} bytes`;
  return stat.isDirectory() ? "a folder" : "another kind of file";
}

if (registers) {
  describe("a real box on Apple container", () => {
    it(
      "starts, copies in and out, runs commands, keeps its files over stop and start, and is deleted",
      async () => {
        const env = cleanEnv();
        const cliEnv = {
          PATH: env["PATH"] ?? "/usr/bin:/bin:/usr/local/bin",
          HOME: env["HOME"] ?? "/",
        };
        const boxes = new AppleContainerBoxes({
          spawn: systemSpawn,
          clock: systemClock,
          env: cliEnv,
        });
        const check = await boxes.check();
        expect(check).toMatchObject({ ok: true });

        const network = await boxes.network();
        expect(network.mode).toBe("hostOnly");

        const runId = `test-${crypto.randomUUID().slice(0, 8)}`;
        const name = boxName(runId);
        /** The box's processes whose command line holds `marker`. */
        const running = async (marker: string) =>
          (await boxes.exec(name, ["ps", "-o", "pid,args"])).stdout
            .split("\n")
            .filter((line) => line.includes(marker));
        await withTempDir(async (dir) => {
          const code = join(dir, "code");
          mkdirSync(code);
          writeFileSync(join(code, "hello.txt"), "hello from the host\n");
          try {
            // A package cache must lie under the backend's cache root (DIPO-267): here the temp dir.
            await new AppleContainerBoxes({
              spawn: systemSpawn,
              clock: systemClock,
              env: cliEnv,
              packageCacheRoot: dir,
            }).create(
              { runId, image: IMAGE, network, packageCache: code },
              { timeoutMs: PULL_TIMEOUT_MS },
            );
            const before = performance.now();
            await boxes.start(name);
            fact(`box start took ${Math.round(performance.now() - before)} ms`);

            expect(await boxes.list()).toContainEqual({ name, runId, state: "running" });

            await boxes.copyIn(name, code, "/work");
            const cat = await boxes.exec(name, ["cat", "/work/hello.txt"]);
            expect(cat).toMatchObject({ code: 0, stdout: "hello from the host\n" });

            // The package cache is read-only inside the box.
            const write = await boxes.exec(name, ["sh", "-c", "touch /dipo/package-cache/x"]);
            expect(write.code).not.toBe(0);

            const printed = await boxes.exec(name, ["env"], { env: { DIPO_BOX: "1" } });
            expect(printed.stdout).toContain("DIPO_BOX=1");
            expect(printed.stdout).not.toContain(`HOME=${process.env["HOME"] ?? "-"}\n`);

            await boxes.exec(name, ["sh", "-c", "echo made in the box > /work/out.txt"]);
            const out = join(dir, "out.txt");
            await boxes.copyOut(name, "/work/out.txt", out);
            expect(readFileSync(out, "utf8")).toBe("made in the box\n");

            // A symlink in the box that points outside the copied folder.
            await boxes.exec(name, [
              "sh",
              "-c",
              "mkdir -p /work/links && echo inside > /work/links/plain.txt && ln -s /etc/hostname /work/links/hostname-link",
            ]);
            const links = join(dir, "links");
            const copied = await boxes
              .copyOut(name, "/work/links", links)
              .then(() => "succeeded")
              .catch(
                (error: unknown) =>
                  `failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            fact(`copy out of a folder holding a symlink to /etc/hostname ${copied}`);
            fact(`the copied plain file is ${describePath(join(links, "plain.txt"))}`);
            fact(`the copied symlink is ${describePath(join(links, "hostname-link"))}`);

            const live = boxes.execLive(name, ["cat"]);
            live.stdin.write("echoed\n");
            live.stdin.end();
            expect(await new Response(live.stdout).text()).toBe("echoed\n");
            expect((await live.exited).code).toBe(0);

            // A long-running exec whose client is killed.
            const sleeper = boxes.execLive(name, ["sleep", "6061"]);
            await Bun.sleep(1000);
            sleeper.kill("SIGKILL");
            fact(`the killed exec client ended with ${JSON.stringify(await sleeper.exited)}`);
            await Bun.sleep(1000);
            const leftLive = await running("sleep 6061");
            fact(
              `after its client was killed, the exec's process ${leftLive.length > 0 ? `still runs in the box: ${leftLive.join("; ").trim()}` : "is gone from the box"}`,
            );

            // An exec killed at its deadline.
            const timedOut = await boxes
              .exec(name, ["sleep", "6062"], { timeoutMs: 2000 })
              .then(() => false)
              .catch((error: unknown) => isBoxTimedOut(error));
            expect(timedOut).toBe(true);
            await Bun.sleep(1000);
            const leftShort = await running("sleep 6062");
            fact(
              `after box.timedOut, the exec's process ${leftShort.length > 0 ? `still runs in the box: ${leftShort.join("; ").trim()}` : "is gone from the box"}`,
            );

            const memory = await boxes.memory(name);
            expect(memory?.usedBytes).toBeGreaterThan(0);
            fact(`box memory: ${memory?.usedBytes} of ${memory?.limitBytes} bytes`);

            await boxes.stop(name);
            expect(await boxes.list()).toContainEqual({ name, runId, state: "stopped" });
            const stats = systemSpawn({ cmd: ["container", ...statsArgs(name)], env: cliEnv });
            const [statsOut, statsErr, statsExit] = await Promise.all([
              new Response(stats.stdout).text(),
              new Response(stats.stderr).text(),
              stats.exited,
            ]);
            fact(
              `container stats on a stopped box exits ${statsExit.code}, stdout ${JSON.stringify(statsOut.trim())}, stderr ${JSON.stringify(statsErr.trim())}`,
            );
            expect(await boxes.memory(name)).toBeNull();
            await boxes.start(name);
            const kept = await boxes.exec(name, ["cat", "/work/out.txt"]);
            expect(kept).toMatchObject({ code: 0, stdout: "made in the box\n" });
          } finally {
            await boxes.delete(name).catch(() => {});
          }
          expect((await boxes.list()).map((box) => box.name)).not.toContain(name);
        });
      },
      PULL_TIMEOUT_MS + 120_000,
    );

    it(
      "fills the office package cache through Safe-Chain outside the box, and mounts it read-only",
      async () => {
        expect(existsSync(join(SAFE_CHAIN_INSTALL, "bin", "safe-chain"))).toBe(true);
        const env = cleanEnv();
        const cliEnv = {
          PATH: env["PATH"] ?? "/usr/bin:/bin:/usr/local/bin",
          HOME: env["HOME"] ?? "/",
        };
        await withTempDir(async (dir) => {
          const started = await startSafeChainProxy(
            {
              installRoot: SAFE_CHAIN_INSTALL,
              caFile: join(dir, "safe-chain", "ca.pem"),
              home: homedir(),
              uid: process.getuid?.() ?? 0,
              env: process.env,
            },
            { platform: currentPlatform(), clock: systemClock, root: join(dir, "p") },
          );
          if (!started.ok) throw new Error(started.reason);
          const proxy = {
            url: `http://127.0.0.1:${started.proxy.port}`,
            caFile: started.proxy.caFile,
          };
          const root = join(dir, "package-cache");
          const boxes = new AppleContainerBoxes({
            spawn: systemSpawn,
            clock: systemClock,
            env: cliEnv,
            packageCacheRoot: root,
          });
          const runId = `test-${crypto.randomUUID().slice(0, 8)}`;
          const name = boxName(runId);
          try {
            // A small Bun project; its lockfile is made here, through the same proxy.
            const project = join(dir, "project");
            mkdirSync(project);
            const manifest =
              '{ "name": "cache-probe", "dependencies": { "is-number": "7.0.0" } }\n';
            writeFileSync(join(project, "package.json"), manifest);
            const lock = systemSpawn({
              cmd: [process.execPath, "install", "--lockfile-only", `--cafile=${proxy.caFile}`],
              cwd: project,
              env: fillEnvironment({
                path: cliEnv.PATH,
                home: join(dir, "home"),
                tmp: dir,
                caFile: proxy.caFile,
                proxyUrl: proxy.url,
              }),
            });
            expect((await lock.exited).code).toBe(0);
            const source = {
              commit: "test",
              lockfile: {
                name: "bun.lock",
                manager: "bun" as const,
                text: readFileSync(join(project, "bun.lock"), "utf8"),
              },
              files: [{ path: "package.json", text: manifest }],
            };
            const cacheRequest = {
              root,
              proxy,
              tools: { bun: process.execPath },
              path: cliEnv.PATH,
              spawn: systemSpawn,
              clock: systemClock,
            };
            const before = performance.now();
            const made = await createBoxWithPackageCache({
              boxes,
              spec: { runId, image: IMAGE, network: await boxes.network() },
              readSource: async () => source,
              cache: cacheRequest,
              options: { timeoutMs: PULL_TIMEOUT_MS },
            });
            fact(`package cache filled in ${Math.round(performance.now() - before)} ms`);
            expect(made.cache.filled).toBe(true);
            const again = await ensurePackageCache({ ...cacheRequest, source });
            expect(again.filled).toBe(false);
            const hostFiles = listFiles(made.cache.path);
            expect(hostFiles.some((file) => file.startsWith("bun/is-number@7.0.0"))).toBe(true);

            await boxes.start(name);
            const listed = await boxes.exec(name, ["ls", "/dipo/package-cache/bun"]);
            expect(listed.stdout).toContain("is-number@7.0.0");
            // Every write to the cache fails inside the box.
            for (const write of [
              "touch /dipo/package-cache/bun/x",
              "rm -rf /dipo/package-cache/bun/is-number@7.0.0@@@1",
              "echo changed > /dipo/package-cache/dipo-cache.json",
              "mkdir /dipo/package-cache/new",
            ]) {
              const tried = await boxes.exec(name, ["sh", "-c", write]);
              expect(tried.code).not.toBe(0);
            }
            expect(listFiles(made.cache.path)).toEqual(hostFiles);

            // A symlink in the cache root that points out of it never becomes a mount.
            symlinkSync(dir, join(root, "escape"));
            const escaped = await boxes
              .create({
                runId: `${runId}-x`,
                image: IMAGE,
                network: await boxes.network(),
                packageCache: join(root, "escape"),
              })
              .then(() => "created")
              .catch((error: unknown) => (error instanceof BoxError ? error.code : String(error)));
            expect(escaped).toBe("box.cacheOutsideRoot");

            if (BUILD_PROXY !== undefined && BUILD_CA !== undefined) {
              // The office image installs the project offline from the read-only cache into the
              // box's own filesystem; the worker's own cache stays in the box.
              const { image } = describeBox(
                { packages: ["jq"] },
                { bun: { version: "1.4.2", evidence: ".bun-version" } },
              );
              const built = await ensureBoxImage({
                boxes,
                image,
                proxy: { url: BUILD_PROXY, caFile: BUILD_CA },
                scratchRoot: dir,
              });
              const officeRun = `test-${crypto.randomUUID().slice(0, 8)}`;
              const office = boxName(officeRun);
              try {
                await createBoxWithPackageCache({
                  boxes,
                  spec: { runId: officeRun, image: built.tag, network: await boxes.network() },
                  readSource: async () => source,
                  cache: cacheRequest,
                });
                await boxes.start(office);
                await boxes.exec(office, ["mkdir", "-p", "/work"]);
                await boxes.copyIn(office, join(project, "package.json"), "/work/package.json");
                await boxes.copyIn(office, join(project, "bun.lock"), "/work/bun.lock");
                const install = boxCacheInstall("bun");
                const installed = await boxes.exec(office, install.command, {
                  cwd: "/work",
                  env: install.env,
                  timeoutMs: PULL_TIMEOUT_MS,
                });
                fact(`offline install from the cache: ${JSON.stringify(installed)}`);
                expect(installed.code).toBe(0);
                const present = await boxes.exec(office, [
                  "test",
                  "-f",
                  "/work/node_modules/is-number/package.json",
                ]);
                expect(present.code).toBe(0);
                const own = await boxes.exec(office, ["bun", "pm", "cache"], { cwd: "/work" });
                fact(`the worker's own Bun cache in the box: ${own.stdout.trim()}`);
                expect(own.stdout).not.toContain("/dipo/package-cache");
                expect(listFiles(made.cache.path)).toEqual(hostFiles);
              } finally {
                await boxes.delete(office).catch(() => {});
              }
            }
          } finally {
            await boxes.delete(name).catch(() => {});
            await started.proxy.stop();
          }
        });
      },
      BUILD_TIMEOUT_MS,
    );

    if (BUILD_PROXY !== undefined && BUILD_CA !== undefined) {
      it(
        "builds the office image once through the build proxy, and runs Claude Code from it",
        async () => {
          const env = cleanEnv();
          const boxes = new AppleContainerBoxes({
            spawn: systemSpawn,
            clock: systemClock,
            env: { PATH: env["PATH"] ?? "/usr/bin:/bin:/usr/local/bin", HOME: env["HOME"] ?? "/" },
          });
          // Bun from .bun-version, as the scan detects it; the rest from dipo's defaults.
          const { image } = describeBox(
            { packages: ["jq"] },
            { bun: { version: "1.4.2", evidence: ".bun-version" } },
          );
          await withTempDir(async (dir) => {
            const request = {
              boxes,
              image,
              proxy: { url: BUILD_PROXY, caFile: BUILD_CA },
              scratchRoot: dir,
            };
            const before = performance.now();
            const first = await ensureBoxImage(request);
            const took = Math.round(performance.now() - before);
            fact(`image ${first.tag} ${first.built ? "built" : "reused"} in ${took} ms`);
            expect(first.tag).toBe(boxImageTag(image));
            expect(await ensureBoxImage(request)).toEqual({ tag: first.tag, built: false });

            const network = await boxes.network();
            const runId = `test-${crypto.randomUUID().slice(0, 8)}`;
            const name = boxName(runId);
            try {
              await boxes.create({ runId, image: first.tag, network });
              await boxes.start(name);
              const claude = await boxes.exec(name, ["claude", "--version"]);
              expect(claude.code).toBe(0);
              expect(claude.stdout).toContain(image.claudeCode);
              const bun = await boxes.exec(name, ["bun", "--version"]);
              expect(bun.stdout.trim()).toBe("1.4.2");
              const printed = (await boxes.exec(name, ["env"])).stdout;
              expect(printed).toContain("DISABLE_AUTOUPDATER=1");
              expect(printed).toContain("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1");
              expect(printed).not.toContain("DIPO_PROXY");
              expect(printed).not.toContain(BUILD_PROXY);
              // The build CA was mounted for the npm step only; it is not in the image.
              const ca = await boxes.exec(name, ["test", "-e", "/run/dipo/safe-chain-ca.pem"]);
              expect(ca.code).not.toBe(0);
              const git = await boxes.exec(name, ["sh", "-c", "command -v git || echo none"]);
              expect(git.stdout.trim()).toBe("none");
            } finally {
              await boxes.delete(name).catch(() => {});
            }
          });
        },
        BUILD_TIMEOUT_MS,
      );
    }

    it(
      "reaches the internet only through dipo's web proxy, and the registries only through Safe-Chain",
      async () => {
        expect(existsSync(join(SAFE_CHAIN_INSTALL, "bin", "safe-chain"))).toBe(true);
        const env = cleanEnv();
        const cliEnv = {
          PATH: env["PATH"] ?? "/usr/bin:/bin:/usr/local/bin",
          HOME: env["HOME"] ?? "/",
        };
        const boxes = new AppleContainerBoxes({
          spawn: systemSpawn,
          clock: systemClock,
          env: cliEnv,
        });
        expect(await boxes.check()).toMatchObject({ ok: true });
        const network = await boxes.network();
        const runId = `test-${crypto.randomUUID().slice(0, 8)}`;
        const name = boxName(runId);
        const events: WebProxyEvent[] = [];

        await withTempDir(async (dir) => {
          const route = new BoxWebRoute<RunningBoxWebRoute>(async () => {
            const started = await startBoxWebRoute(
              network,
              {
                request: {
                  installRoot: SAFE_CHAIN_INSTALL,
                  caFile: join(dir, "safe-chain", "ca.pem"),
                  home: homedir(),
                  uid: process.getuid?.() ?? 0,
                  env: process.env,
                },
                deps: { platform: currentPlatform(), clock: systemClock, root: join(dir, "p") },
              },
              { clock: systemClock, onEvent: (event) => events.push(event) },
            );
            if (!started.ok) throw new Error(started.reason);
            return started.route;
          });
          const loopback = await listenOn("127.0.0.1");
          const onBoxNetwork = await listenOn(network.hostAddress);
          // The Mac's own address on another network than the box network, when it has one.
          const macAddress = systemInterfaceAddresses().find(
            (entry) =>
              isIP(entry.address) === 4 &&
              !entry.address.startsWith("127.") &&
              entry.address !== network.hostAddress,
          )?.address;
          const onMac = macAddress === undefined ? null : await listenOn(macAddress);
          const gateway = await defaultGateway(cliEnv);
          const publicAddress = (await lookup("example.com", { family: 4 })).address;
          fact(
            `direct targets: a public address of example.com, ${macAddress === undefined ? "no" : "the"} Mac's own address, ${gateway === null ? "no" : "the"} default gateway`,
          );
          try {
            await boxes.create({ runId, image: IMAGE, network }, { timeoutMs: PULL_TIMEOUT_MS });
            await boxes.start(name);

            // Without the proxy there is no way out.
            const direct = await boxes.exec(name, [
              "sh",
              "-c",
              "wget -q -T5 -O /dev/null https://example.com && echo 'internet: yes' || echo 'internet: no'; " +
                "wget -q -T5 -O /dev/null https://registry.npmjs.org/ && echo 'registry: yes' || echo 'registry: no'",
            ]);
            expect(direct.stdout).toContain("internet: no");
            expect(direct.stdout).toContain("registry: no");

            // Nor by IP address: a public address, the Mac's own address (a listener waits there)
            // and the default gateway.
            const literals = [
              `${publicAddress}:443`,
              ...(onMac === null ? [] : [`${macAddress}:${onMac.port}`]),
              ...(gateway === null ? [] : [`${gateway}:80`, `${gateway}:443`]),
            ];
            for (const target of literals) {
              const [host, port] = target.split(":");
              const tried = await boxes.exec(name, [
                "sh",
                "-c",
                `nc -z -w3 ${host} ${port} && echo open || echo closed`,
              ]);
              expect(tried.stdout.trim()).toBe("closed");
            }
            fact(`${literals.length} direct IP-address attempts without the proxy were closed`);

            const route1 = await route.acquire(name);
            expect(route1.host).toBe(network.hostAddress);
            await boxes.copyIn(name, route1.caFile, "/ca.pem");
            const proxyEnv = {
              https_proxy: route1.url,
              HTTPS_PROXY: route1.url,
              NODE_EXTRA_CA_CERTS: "/ca.pem",
            };
            const setup = await boxes.exec(
              name,
              [
                "sh",
                "-c",
                "sed -i 's#^http://#https://#' /etc/apk/repositories && apk add --no-cache curl nodejs npm",
              ],
              { env: proxyEnv, timeoutMs: PULL_TIMEOUT_MS },
            );
            expect(setup.code).toBe(0);

            /** The proxy's CONNECT answer and the final HTTP status of one request from the box. */
            const through = async (url: string): Promise<string> => {
              const result = await boxes.exec(name, [
                "sh",
                "-c",
                `curl -x ${route1.url} --cacert /ca.pem -sS -m 10 -o /dev/null -w '%{http_connect} %{http_code}' '${url}' || true`,
              ]);
              const answer = result.stdout.trim();
              fact(`through the web proxy: ${url} -> ${answer}`);
              return answer;
            };
            expect(await through(`https://127.0.0.1:${loopback.port}/`)).toStartWith("403");
            expect(await through(`https://localhost:${loopback.port}/`)).toStartWith("403");
            expect(await through(`https://localtest.me:${loopback.port}/`)).toStartWith("403");
            expect(
              await through(`https://${network.hostAddress}:${onBoxNetwork.port}/`),
            ).toStartWith("403");
            if (onMac !== null) {
              expect(await through(`https://${macAddress}:${onMac.port}/`)).toStartWith("403");
            }
            if (gateway !== null) {
              expect(await through(`https://${gateway}/`)).toStartWith("403");
            }
            // A registry by IP literal (any literal is refused, so a documentation address will do).
            expect(await through("https://203.0.113.10/")).toStartWith("403");
            // Plain HTTP proxying is refused: no CONNECT, the proxy's own 405.
            expect(await through("http://example.com/")).toBe("000 405");
            expect(await through("https://registry.npmjs.org./")).toStartWith("200");
            expect(await through("https://example.com/")).toBe("200 200");

            const allowed = await boxes.exec(
              name,
              ["sh", "-c", "npm --prefix /tmp/a install is-number@7.0.0"],
              { env: proxyEnv, timeoutMs: PULL_TIMEOUT_MS },
            );
            expect(allowed.code).toBe(0);
            const blocked = await boxes.exec(
              name,
              ["sh", "-c", "npm --prefix /tmp/b install safe-chain-test 2>&1"],
              { env: proxyEnv, timeoutMs: PULL_TIMEOUT_MS },
            );
            expect(blocked.code).not.toBe(0);
            expect(blocked.stdout).toContain("blocked by safe-chain");

            expect(events).toContainEqual({
              kind: "registry",
              host: "registry.npmjs.org",
              port: 443,
            });
            for (const event of events) fact(`web proxy event: ${JSON.stringify(event)}`);
          } finally {
            await boxes.delete(name).catch(() => {});
            await route.release(name);
            loopback.server.close();
            onBoxNetwork.server.close();
            onMac?.server.close();
          }
          expect(route.running).toBe(false);
        });
      },
      2 * PULL_TIMEOUT_MS + 120_000,
    );
  });
}
