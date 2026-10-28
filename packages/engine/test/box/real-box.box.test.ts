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
// The boxes of the first and the network test are build boxes (DIPO-281): raw boxes with no box
// network tools, whose commands run with all their capabilities and with no box firewall, so they
// test the backend and the host-only network as such. Every other box dipo makes has the firewall;
// box-network.ci.test.ts tests it, and the image build in a build box.
//
// The image build (DIPO-266, in a build box since DIPO-281) registers only when the maintainer
// also sets DIPO_TEST_BOX_BUILD=1; it needs the internet (the web route builds its Safe-Chain box from the pinned release, DIPO-343). The
// package cache test (below) builds the office image of a small description that way first (or
// reuses it).
//
// A second test (DIPO-268) repeats the DIPO-264 network lines through dipo's web proxy and the
// Safe-Chain box behind it (DIPO-343), so it also needs the internet: no way out without the proxy (by name, and by IP address to a public address
// and the default gateway, all found at test time); through it the Mac's loopback, the box
// network, the Mac's own address, the default gateway and IP literals are refused, plain HTTP
// proxying is refused, a registry (also with a trailing dot) goes through Safe-Chain, the internet
// works, and an npm install is checked by Safe-Chain. A direct connection to a service bound to the
// Mac's own local-network address is only reported: it is reachable, under the risk the
// maintainer accepted in the 0021 amendment of 2026-10-21, until DIPO-283. The box network's
// address exists on the Mac only while a box runs on it, so its listener opens after the box starts.
//
// A third test (DIPO-267), registered with the build proxy too and needing the internet, fills the office package cache for a small Bun project in a fill box of the office
// image, through the web route and Safe-Chain; no package manager runs on the Mac (the project's
// lockfile is made in a helper box the same way). It checks that the fill box is gone afterwards,
// that an unchanged lockfile reuses the cache, that every write to the cache from inside a box
// fails and the host files stay unchanged, that the box installs the project offline from the
// read-only cache into its own files, that the worker's own Bun cache is not the package cache,
// and that a symlink in the cache root never becomes a mount.

import {
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
import { join, relative } from "node:path";

import { describe, expect, it } from "bun:test";

import { cleanEnv, withTempDir } from "@dipsaus-orchestrator/testkit";

import { statsArgs } from "../../src/box/apple-args";
import {
  boxCacheInstall,
  createBoxWithPackageCache,
  ensurePackageCache,
} from "../../src/box/cache";
import { ensureBoxImage } from "../../src/box/build-box";
import { describeBox } from "../../src/box/image";
import { AppleContainerBoxes } from "../../src/box/apple-container";
import { BoxError, type BoxExecOptions, boxName, isBoxTimedOut } from "../../src/box/port";
import {
  BoxWebRoute,
  type RunningBoxWebRoute,
  systemInterfaceAddresses,
  type WebProxyEvent,
} from "../../src/box/web-proxy";
import { startBoxWebRoute } from "../../src/box/safe-chain-box";
import { systemClock } from "../../src/platform/clock";
import { systemSpawn } from "../../src/platform/process";

const IMAGE = "docker.io/library/alpine:3.20";
/** A first run pulls the image; later calls keep the 60 s default. */
const PULL_TIMEOUT_MS = 300_000;

/** The image build in a build box, through the web route and Safe-Chain (DIPO-281). */
const BUILDS = process.env["DIPO_TEST_BOX_BUILD"] === "1";
/** An image build takes minutes. */
const BUILD_TIMEOUT_MS = 40 * 60_000;

const registers =
  process.env["DIPO_TEST_BOX"] === "1" &&
  process.env["DIPO_TEST_CI"] !== "1" &&
  process.env["CI"] === undefined;

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

        const runId = `build-t${crypto.randomUUID().slice(0, 8)}`;
        const name = boxName(runId);
        /** The box's processes whose command line holds `marker`. */
        const running = async (marker: string) =>
          (await boxes.exec(name, ["ps", "-o", "pid,args"], { fullPrivilege: true })).stdout
            .split("\n")
            .filter((line) => line.includes(marker));
        await withTempDir(async (dir) => {
          const code = join(dir, "code");
          mkdirSync(code);
          writeFileSync(join(code, "hello.txt"), "hello from the host\n");
          try {
            // A build box gets no mount; the read-only cache is tested with the fill below.
            await boxes.create({ runId, image: IMAGE, network }, { timeoutMs: PULL_TIMEOUT_MS });
            const before = performance.now();
            await boxes.start(name);
            fact(`box start took ${Math.round(performance.now() - before)} ms`);

            expect(await boxes.list()).toContainEqual({ name, runId, state: "running" });

            await boxes.copyIn(name, code, "/work");
            const cat = await boxes.exec(name, ["cat", "/work/hello.txt"], { fullPrivilege: true });
            expect(cat).toMatchObject({ code: 0, stdout: "hello from the host\n" });

            const printed = await boxes.exec(name, ["env"], {
              env: { DIPO_BOX: "1" },
              fullPrivilege: true,
            });
            expect(printed.stdout).toContain("DIPO_BOX=1");
            expect(printed.stdout).not.toContain(`HOME=${process.env["HOME"] ?? "-"}\n`);

            await boxes.exec(name, ["sh", "-c", "echo made in the box > /work/out.txt"], {
              fullPrivilege: true,
            });
            const out = join(dir, "out.txt");
            await boxes.copyOut(name, "/work/out.txt", out);
            expect(readFileSync(out, "utf8")).toBe("made in the box\n");

            // A symlink in the box that points outside the copied folder.
            await boxes.exec(
              name,
              [
                "sh",
                "-c",
                "mkdir -p /work/links && echo inside > /work/links/plain.txt && ln -s /etc/hostname /work/links/hostname-link",
              ],
              { fullPrivilege: true },
            );
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

            const live = boxes.execLive(name, ["cat"], { fullPrivilege: true });
            live.stdin.write("echoed\n");
            live.stdin.end();
            expect(await new Response(live.stdout).text()).toBe("echoed\n");
            expect((await live.exited).code).toBe(0);

            // A long-running exec whose client is killed.
            const sleeper = boxes.execLive(name, ["sleep", "6061"], { fullPrivilege: true });
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
              .exec(name, ["sleep", "6062"], { timeoutMs: 2000, fullPrivilege: true })
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
            const kept = await boxes.exec(name, ["cat", "/work/out.txt"], { fullPrivilege: true });
            expect(kept).toMatchObject({ code: 0, stdout: "made in the box\n" });
          } finally {
            await boxes.delete(name).catch(() => {});
          }
          expect((await boxes.list()).map((box) => box.name)).not.toContain(name);
        });
      },
      PULL_TIMEOUT_MS + 120_000,
    );

    if (BUILDS) {
      it(
        "fills the office package cache in a fill box through the web route, and mounts it read-only",
        async () => {
          const env = cleanEnv();
          const cliEnv = {
            PATH: env["PATH"] ?? "/usr/bin:/bin:/usr/local/bin",
            HOME: env["HOME"] ?? "/",
          };
          await withTempDir(async (dir) => {
            const root = join(dir, "package-cache");
            const toolsRoot = join(dir, "box-net-tools");
            const boxes = new AppleContainerBoxes({
              spawn: systemSpawn,
              clock: systemClock,
              env: cliEnv,
              packageCacheRoot: root,
              netToolsRoot: toolsRoot,
            });
            expect(await boxes.check()).toMatchObject({ ok: true });
            const network = await boxes.network();
            const route = new BoxWebRoute<RunningBoxWebRoute>(async () => {
              const started = await startBoxWebRoute(
                network,
                {
                  boxes,
                  clock: systemClock,
                  scratchRoot: join(dir, "scratch"),
                  toolsRoot,
                  caFile: join(dir, "safe-chain", "ca.pem"),
                },
                { clock: systemClock },
              );
              if (!started.ok) throw new Error(started.reason);
              return started.route;
            });
            // The office image with Bun, built in a build box (reused when it exists with its tools).
            const { image } = describeBox(
              { packages: ["jq"] },
              { bun: { version: "1.4.2", evidence: ".bun-version" } },
            );
            const built = await ensureBoxImage(
              {
                boxes,
                route,
                scratchRoot: join(dir, "scratch"),
                toolsRoot,
                clock: systemClock,
              },
              image,
            );
            const runId = `test-${crypto.randomUUID().slice(0, 8)}`;
            const name = boxName(runId);
            try {
              // A small Bun project. Its lockfile is made in a helper box through the same route:
              // no package manager runs on the Mac.
              const project = join(dir, "project");
              mkdirSync(project);
              const manifest =
                '{ "name": "cache-probe", "dependencies": { "is-number": "7.0.0" } }\n';
              writeFileSync(join(project, "package.json"), manifest);
              const helperRun = `test-${crypto.randomUUID().slice(0, 8)}`;
              const helper = boxName(helperRun);
              try {
                await boxes.create({
                  runId: helperRun,
                  image: built.tag,
                  network,
                  netTools: built.netTools,
                });
                await boxes.start(helper);
                const helperRoute = await route.acquire(helper);
                await boxes.copyIn(helper, helperRoute.caFile, "/ca.pem");
                await boxes.exec(helper, ["mkdir", "-p", "/work"]);
                await boxes.copyIn(helper, join(project, "package.json"), "/work/package.json");
                const locked = await boxes.exec(
                  helper,
                  ["bun", "install", "--lockfile-only", "--cafile=/ca.pem"],
                  {
                    cwd: "/work",
                    env: {
                      https_proxy: helperRoute.url,
                      HTTPS_PROXY: helperRoute.url,
                      NODE_EXTRA_CA_CERTS: "/ca.pem",
                    },
                    timeoutMs: PULL_TIMEOUT_MS,
                  },
                );
                expect(locked.code).toBe(0);
                await boxes.copyOut(helper, "/work/bun.lock", join(project, "bun.lock"));
              } finally {
                await route.release(helper);
                await boxes.delete(helper).catch(() => {});
              }
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
                image: { tag: built.tag, toolchain: image.toolchain, netTools: built.netTools },
                route,
              };

              const before = performance.now();
              const made = await createBoxWithPackageCache({
                boxes,
                spec: { runId, image: built.tag, network, netTools: built.netTools },
                readSource: async () => source,
                cache: cacheRequest,
              });
              fact(
                `package cache filled in a fill box in ${Math.round(performance.now() - before)} ms`,
              );
              expect(made.cache.filled).toBe(true);
              // The fill box is gone, and the route stopped with it.
              const left = (await boxes.list()).filter((box) => box.name.startsWith("dipo-fill-"));
              expect(left).toEqual([]);
              expect(route.running).toBe(false);
              const again = await ensurePackageCache({ ...cacheRequest, source, boxes });
              expect(again.filled).toBe(false);
              const hostFiles = listFiles(made.cache.path);
              expect(hostFiles.some((file) => file.startsWith("bun/is-number@7.0.0"))).toBe(true);
              fact(`the filled cache holds ${hostFiles.length} files`);

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

              // The box installs the project offline from the read-only cache into its own files.
              await boxes.exec(name, ["mkdir", "-p", "/work"]);
              await boxes.copyIn(name, join(project, "package.json"), "/work/package.json");
              await boxes.copyIn(name, join(project, "bun.lock"), "/work/bun.lock");
              const install = boxCacheInstall("bun");
              const installed = await boxes.exec(name, install.command, {
                cwd: "/work",
                env: install.env,
                timeoutMs: PULL_TIMEOUT_MS,
              });
              fact(`offline install from the cache: ${JSON.stringify(installed)}`);
              expect(installed.code).toBe(0);
              const present = await boxes.exec(name, [
                "test",
                "-f",
                "/work/node_modules/is-number/package.json",
              ]);
              expect(present.code).toBe(0);
              // The worker's own installs use Bun's default cache, in the box.
              const own = await boxes.exec(name, ["bun", "pm", "cache"], { cwd: "/work" });
              fact(`the worker's own Bun cache in the box: ${own.stdout.trim()}`);
              expect(own.stdout).not.toContain("/dipo/package-cache");
              expect(listFiles(made.cache.path)).toEqual(hostFiles);

              // A symlink in the cache root that points out of it never becomes a mount.
              symlinkSync(dir, join(root, "escape"));
              const escaped = await boxes
                .create({
                  runId: `${runId}-x`,
                  image: built.tag,
                  network,
                  netTools: built.netTools,
                  packageCache: join(root, "escape"),
                })
                .then(() => "created")
                .catch((error: unknown) =>
                  error instanceof BoxError ? error.code : String(error),
                );
              expect(escaped).toBe("box.cacheOutsideRoot");
            } finally {
              await boxes.delete(name).catch(() => {});
              await route.close();
            }
          });
        },
        BUILD_TIMEOUT_MS,
      );
    }

    it(
      "reaches the internet only through dipo's web proxy, and the registries only through Safe-Chain",
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
        expect(await boxes.check()).toMatchObject({ ok: true });
        const network = await boxes.network();
        const runId = `build-t${crypto.randomUUID().slice(0, 8)}`;
        const name = boxName(runId);
        const events: WebProxyEvent[] = [];
        /** A command in the raw build box, with all its capabilities and no box firewall. */
        const run = (
          command: readonly [string, ...string[]],
          options: Omit<BoxExecOptions, "fullPrivilege"> = {},
        ) => boxes.exec(name, command, { ...options, fullPrivilege: true });

        await withTempDir(async (dir) => {
          // The Safe-Chain box mounts its image's box network tools from this folder (DIPO-343).
          const routeBoxes = new AppleContainerBoxes({
            spawn: systemSpawn,
            clock: systemClock,
            env: cliEnv,
            netToolsRoot: join(dir, "box-net-tools"),
          });
          const route = new BoxWebRoute<RunningBoxWebRoute>(async () => {
            const started = await startBoxWebRoute(
              network,
              {
                boxes: routeBoxes,
                clock: systemClock,
                scratchRoot: join(dir, "scratch"),
                toolsRoot: join(dir, "box-net-tools"),
                caFile: join(dir, "safe-chain", "ca.pem"),
              },
              { clock: systemClock, onEvent: (event) => events.push(event) },
            );
            if (!started.ok) throw new Error(started.reason);
            return started.route;
          });
          const loopback = await listenOn("127.0.0.1");
          // The box network's address exists on the Mac only while a box runs on it, so this
          // listener opens after the box starts.
          let onBoxNetwork: { server: Server; port: number } | null = null;
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
            onBoxNetwork = await listenOn(network.hostAddress);

            // Without the proxy there is no way out.
            const direct = await run([
              "sh",
              "-c",
              "wget -q -T5 -O /dev/null https://example.com && echo 'internet: yes' || echo 'internet: no'; " +
                "wget -q -T5 -O /dev/null https://registry.npmjs.org/ && echo 'registry: yes' || echo 'registry: no'",
            ]);
            expect(direct.stdout).toContain("internet: no");
            expect(direct.stdout).toContain("registry: no");

            // Nor by IP address: a public address and the default gateway. The Mac's own address,
            // where a listener waits, is reported but not required closed: the accepted risk of the
            // 0021 amendment of 2026-10-21, until DIPO-283.
            const literals = [
              `${publicAddress}:443`,
              ...(onMac === null ? [] : [`${macAddress}:${onMac.port}`]),
              ...(gateway === null ? [] : [`${gateway}:80`, `${gateway}:443`]),
            ];
            const kinds = [
              "a public address on 443",
              ...(onMac === null ? [] : ["the Mac's own address"]),
              ...(gateway === null
                ? []
                : ["the default gateway on 80", "the default gateway on 443"]),
            ];
            const outcomes: string[] = [];
            for (const [index, target] of literals.entries()) {
              const [host, port] = target.split(":");
              const tried = await run([
                "sh",
                "-c",
                `nc -z -w3 ${host} ${port} && echo open || echo closed`,
              ]);
              outcomes.push(tried.stdout.trim());
              fact(`direct to ${kinds[index]}: ${tried.stdout.trim()}`);
            }
            const required = outcomes.filter(
              (_, index) => kinds[index] !== "the Mac's own address",
            );
            expect(required.every((outcome) => outcome === "closed")).toBe(true);
            fact(
              `${required.length} required direct IP-address attempts without the proxy were closed`,
            );

            const route1 = await route.acquire(name);
            expect(route1.host).toBe(network.hostAddress);
            await boxes.copyIn(name, route1.caFile, "/ca.pem");
            const proxyEnv = {
              https_proxy: route1.url,
              HTTPS_PROXY: route1.url,
              NODE_EXTRA_CA_CERTS: "/ca.pem",
            };
            const setup = await run(
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
              const result = await run([
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

            const allowed = await run(["sh", "-c", "npm --prefix /tmp/a install is-number@7.0.0"], {
              env: proxyEnv,
              timeoutMs: PULL_TIMEOUT_MS,
            });
            expect(allowed.code).toBe(0);
            const blocked = await run(
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
            onBoxNetwork?.server.close();
            onMac?.server.close();
          }
          expect(route.running).toBe(false);
        });
      },
      2 * PULL_TIMEOUT_MS + 120_000,
    );
  });
}
