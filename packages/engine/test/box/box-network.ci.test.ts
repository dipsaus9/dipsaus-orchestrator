// The box network on real boxes (DIPO-281, criteria 8 and 9; from DIPO-283 and DIPO-286). It
// registers only with both DIPO_TEST_CI=1 and DIPO_TEST_BOX=1, on macOS: it needs Apple container
// 1.6.0 or newer with its service running, the official Safe-Chain install (`~/.safe-chain`) and
// the internet, and builds the office image of a small description in a build box (minutes on its
// first run). CI without a box sets only DIPO_TEST_CI, so it skips this file. The maintainer runs
// it by hand:
//
//   DIPO_TEST_CI=1 DIPO_TEST_BOX=1 bun test packages/engine/test/box/box-network.ci.test.ts
//
// Services of the Mac stand in for what the maintainer runs: one listening on all interfaces, one
// on the box network's address that is no proxy of dipo's, one on the Mac's own local-network
// address when it has one, and two on its loopback, one of them a listed local port. Every
// outcome is also printed as a `fact:` line.
//
// - The build (criterion 9): from inside the build box, after the box firewall is set and before
//   the install steps, contained as an install script runs, no direct connection reaches a
//   service of the Mac, the local network, the default gateway or a registry's public address;
//   the firewall cannot be flushed; through the web route the internet is reached and a registry
//   alias is refused. The build then completes and the image holds neither git nor the build
//   folder with the CA bundle.
// - A box of the image (criterion 8, the DIPO-264 probe's line 2 and the real-box web proxy test's
//   direct line to the Mac's own address): with the firewall set as a session sets it, a contained
//   command reaches dipo's two proxy ports on the Mac and nothing else of the Mac directly; the
//   listed local port is reached only through the web proxy with the box's own proxy password, an
//   unlisted one and one without the password are refused; the worker cannot flush the rule,
//   regain the capability, or change the mounted tools, and after trying the rule still holds.
// - Fail-closed against the real path: the firewall of a box that has no box network tools (a
//   build box before its bootstrap) cannot be set, and says so.
// - The box user (DIPO-334): as an install script in the build box and as the worker in a box of
//   the image, every command runs as the fixed non-root uid, and each plant fails in every form
//   (`PLANTS`: redirection, `tee`, `cp`, a link, quoting with `eval`, `env` and a second
//   shell, chaining): `/etc/ld.so.preload`, `/etc/ld.so.conf.d`, the tools folder renamed or a
//   folder of `/` made beside it, a loader or library planted in the tools, `/etc/nsswitch.conf`
//   and an NSS module in the system's libraries, and root again through setpriv or su. After the
//   tries none of those files changed, and the next session's firewall still sets and holds. The
//   box user writes `/work`, its home and dipo's command folder, and runs Claude Code.

import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { createServer, isIP, type Server } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "bun:test";

import { cleanEnv, makeTempDir, removeTempDir } from "@dipsaus-orchestrator/testkit";

import { AppleContainerBoxes } from "../../src/box/apple-container";
import { ensureBoxImage, type BoxImageResult } from "../../src/box/build-box";
import { BOX_NET_TOOLS_PATH, BOX_USER_UID, netToolCommand } from "../../src/box/firewall";
import { BOX_IMAGE_ENV, describeBox } from "../../src/box/image";
import { BoxError, type BoxNetwork, boxName } from "../../src/box/port";
import {
  BOX_LOCAL_HOST,
  BoxWebRoute,
  type RunningBoxWebRoute,
  startBoxWebRoute,
  systemInterfaceAddresses,
  type WebProxyEvent,
} from "../../src/box/web-proxy";
import { systemClock } from "../../src/platform/clock";
import { currentPlatform } from "../../src/platform/paths";
import { systemSpawn } from "../../src/platform/process";

/**
 * What a box user tries in order to redirect a command dipo runs as root (DIPO-334), each as a
 * shell line, in the bypass forms: wrappers, quoting, indirection and chaining. Every one must fail.
 */
const PLANTS: readonly (readonly [string, string])[] = [
  ["ld.so.preload by redirection", "echo /tmp/x.so > /etc/ld.so.preload"],
  ["ld.so.preload by tee", "echo /tmp/x.so | tee /etc/ld.so.preload"],
  ["ld.so.preload by cp", "echo /tmp/x.so > /tmp/p && cp /tmp/p /etc/ld.so.preload"],
  ["ld.so.preload through a link", "ln -sf /etc/ld.so.preload /tmp/l && echo /tmp/x.so > /tmp/l"],
  [
    "ld.so.preload quoted, through eval",
    'true && eval \'printf "%s\\n" /tmp/x.so > "/etc/ld.so.preload"\'',
  ],
  [
    "ld.so.preload through env and a second shell",
    "env sh -c 'echo /tmp/x.so >> /etc/ld.so.preload'",
  ],
  ["ld.so.conf.d", "echo /tmp > /etc/ld.so.conf.d/x.conf"],
  ["the tools folder renamed", `mv ${BOX_NET_TOOLS_PATH} ${BOX_NET_TOOLS_PATH}.old`],
  ["a folder of / beside the tools", `mkdir ${BOX_NET_TOOLS_PATH}.new`],
  ["a loader planted in the tools", `cp /bin/true ${BOX_NET_TOOLS_PATH}/ld.so`],
  ["a library planted in the tools", `cp /bin/true ${BOX_NET_TOOLS_PATH}/lib/libx.so.1`],
  ["nsswitch.conf", "echo 'passwd: x files' > /etc/nsswitch.conf"],
  ["an NSS module in /lib", "cp /bin/true /lib/$(uname -m)-linux-gnu/libnss_x.so.2"],
  ["an NSS module in /usr/lib", "cp /bin/true /usr/lib/libnss_x.so.2"],
  ["root again through su", "su -c 'echo /tmp/x.so > /etc/ld.so.preload' root </dev/null"],
];

/** Each outcome of `plant` as it must be: the box user, nothing planted, nothing changed. */
const expectNothingPlanted = (outcomes: readonly string[]): void => {
  expect(outcomes[0]).toBe(`uid: ${BOX_USER_UID}`);
  expect(outcomes.filter((line) => line.endsWith(": planted"))).toEqual([]);
  expect(outcomes.at(-1)).toBe("files: unchanged");
};

/** The CI guard of every *.ci.test.ts file (0017 section 1). */
const inCi = process.env["DIPO_TEST_CI"] === "1";
const registers = inCi && process.env["DIPO_TEST_BOX"] === "1" && process.platform === "darwin";

/** The image build in a build box takes minutes; the probes, a few more. */
const TIMEOUT_MS = 45 * 60_000;
const SAFE_CHAIN_INSTALL = join(homedir(), ".safe-chain");
/** CAP_NET_ADMIN and CAP_NET_RAW, as bits of /proc/self/status's capability masks. */
const NET_ADMIN_BIT = 12n;
const NET_RAW_BIT = 13n;

function fact(text: string): void {
  console.log(`fact: ${text}`);
}

/** A service of the Mac on `host` with a free port, which answers any connection. */
function listenOn(host: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) =>
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\nmac-service"),
    );
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

if (registers) {
  const root = makeTempDir();
  const env = cleanEnv();
  const cliEnv = { PATH: env["PATH"] ?? "/usr/bin:/bin:/usr/local/bin", HOME: homedir() };
  const boxes = new AppleContainerBoxes({
    spawn: systemSpawn,
    clock: systemClock,
    env: cliEnv,
    netToolsRoot: join(root, "box-net-tools"),
  });
  const events: WebProxyEvent[] = [];
  let routes = 0;
  let network: BoxNetwork | null = null;
  const route = new BoxWebRoute<RunningBoxWebRoute>(async () => {
    routes += 1;
    const started = await startBoxWebRoute(
      network ?? (await boxes.network()),
      {
        request: {
          installRoot: SAFE_CHAIN_INSTALL,
          caFile: join(root, `route-${routes}`, "ca.pem"),
          home: homedir(),
          uid: process.getuid?.() ?? 0,
          env: process.env,
        },
        deps: { platform: currentPlatform(), clock: systemClock, root: join(root, "p") },
      },
      { clock: systemClock, onEvent: (event) => events.push(event) },
    );
    if (!started.ok) throw new Error(started.reason);
    return started.route;
  });
  /** The Mac's services; they open once a box runs, since the box network's address exists only then. */
  let services: {
    allInterfaces: { server: Server; port: number };
    boxNetwork: { server: Server; port: number };
    model: { server: Server; port: number };
    lan: { address: string; server: Server; port: number } | null;
    listed: { server: Server; port: number };
    unlisted: { server: Server; port: number };
  } | null = null;
  const gatewayFound = defaultGateway(cliEnv);
  const registryAddress = lookup("registry.npmjs.org", { family: 4 }).then(
    (found) => found.address,
  );

  const openServices = async (hostAddress: string) => {
    if (services !== null) return services;
    const lanAddress = systemInterfaceAddresses().find(
      (entry) =>
        isIP(entry.address) === 4 &&
        !entry.address.startsWith("127.") &&
        entry.address !== hostAddress,
    )?.address;
    services = {
      allInterfaces: await listenOn("0.0.0.0"),
      boxNetwork: await listenOn(hostAddress),
      model: await listenOn(hostAddress),
      lan:
        lanAddress === undefined ? null : { address: lanAddress, ...(await listenOn(lanAddress)) },
      listed: await listenOn("127.0.0.1"),
      unlisted: await listenOn("127.0.0.1"),
    };
    fact(`the Mac's own local-network address: ${lanAddress === undefined ? "none" : "found"}`);
    return services;
  };

  afterAll(async () => {
    await route.close();
    if (services !== null) {
      for (const service of [
        services.allInterfaces,
        services.boxNetwork,
        services.model,
        services.listed,
        services.unlisted,
        ...(services.lan === null ? [] : [services.lan]),
      ]) {
        service.server.close();
      }
    }
    removeTempDir(root);
  });

  /** One TCP connection from inside `box`, contained, with bash's /dev/tcp: open or closed. */
  const direct = async (box: string, host: string, port: number): Promise<string> => {
    const tried = await boxes.exec(box, [
      "timeout",
      "6",
      "bash",
      "-c",
      `exec 3<>/dev/tcp/${host}/${port} && echo open || echo closed`,
    ]);
    const outcome = tried.stdout.trim() === "open" ? "open" : "closed";
    return outcome;
  };

  /** The status line a CONNECT through the web proxy gets, from inside `box`, contained. */
  const connect = async (
    box: string,
    proxy: { host: string; port: number },
    target: string,
    password: string | null = null,
  ): Promise<string> => {
    const auth =
      password === null
        ? ""
        : `Proxy-Authorization: Basic ${Buffer.from(`dipo:${password}`).toString("base64")}\\r\\n`;
    const tried = await boxes.exec(box, [
      "timeout",
      "10",
      "bash",
      "-c",
      `exec 3<>/dev/tcp/${proxy.host}/${proxy.port} || exit 1; printf 'CONNECT ${target} HTTP/1.1\\r\\nHost: ${target}\\r\\n${auth}\\r\\n' >&3; head -n 1 <&3`,
    ]);
    return tried.stdout.trim();
  };

  /**
   * The plants of `PLANTS` from inside `box`, contained, and root again through setpriv: every
   * one's outcome, and whether the files they aim at are as before. Each is a `fact:` line.
   */
  const plant = async (box: string, who: string): Promise<string[]> => {
    const watched = `cat /etc/nsswitch.conf; ls -la ${BOX_NET_TOOLS_PATH} ${BOX_NET_TOOLS_PATH}/lib; ls /etc/ld.so.conf.d; ls /etc/ld.so.preload /lib/*/libnss_x.so.2 /usr/lib/libnss_x.so.2 2>&1`;
    const before = await boxes.exec(box, ["sh", "-c", watched]);
    const uid = await boxes.exec(box, ["id", "-u"]);
    const outcomes = [`uid: ${uid.stdout.trim()}`];
    const tries: [string, [string, ...string[]]][] = [
      ...PLANTS.map(([what, line]): [string, [string, ...string[]]] => [what, ["sh", "-c", line]]),
      [
        "root again through setpriv",
        netToolCommand("setpriv", ["--reuid=0", "--regid=0", "--clear-groups", "--", "id", "-u"]),
      ],
    ];
    for (const [what, command] of tries) {
      const tried = await boxes.exec(box, command);
      const outcome = tried.code === 0 ? "planted" : "refused";
      outcomes.push(`${what}: ${outcome}`);
      fact(`${who}, ${what}: exit ${tried.code}`);
    }
    const after = await boxes.exec(box, ["sh", "-c", watched]);
    outcomes.push(`files: ${after.stdout === before.stdout ? "unchanged" : "changed"}`);
    fact(`${who}, the files root's commands load from: ${outcomes.at(-1)}`);
    return outcomes;
  };

  /** Builds the image once for both tests, with the build box probes of criterion 9. */
  let building: Promise<BoxImageResult> | null = null;
  const buildProbes: string[] = [];
  const planted: string[] = [];
  const built = (): Promise<BoxImageResult> => {
    building ??= (async () => {
      expect(existsSync(join(SAFE_CHAIN_INSTALL, "bin", "safe-chain"))).toBe(true);
      expect(await boxes.check()).toMatchObject({ ok: true });
      network = await boxes.network();
      const hostAddress = network.hostAddress;
      const { image } = describeBox({}, {});
      const before = performance.now();
      const result = await ensureBoxImage(
        {
          boxes,
          route,
          scratchRoot: join(root, "scratch"),
          toolsRoot: join(root, "box-net-tools"),
          clock: systemClock,
          onEvent: (event) => fact(`build cleanup: ${JSON.stringify(event)}`),
          // What an install script could try, from inside the build box behind its firewall.
          beforeInstall: async (box, routeUrl) => {
            const mac = await openServices(hostAddress);
            const gateway = await gatewayFound;
            const registry = await registryAddress;
            const tries: [string, string, number][] = [
              ["a Mac service on all interfaces", hostAddress, mac.allInterfaces.port],
              ["a Mac service on the box network address", hostAddress, mac.boxNetwork.port],
              ...(mac.lan === null
                ? []
                : ([
                    ["a Mac service on its local-network address", mac.lan.address, mac.lan.port],
                  ] as [string, string, number][])),
              ...(gateway === null
                ? []
                : ([["the default gateway", gateway, 80]] as [string, string, number][])),
              ["the npm registry's public address", registry, 443],
            ];
            for (const [what, host, port] of tries) {
              const outcome = await direct(box, host, port);
              buildProbes.push(`${what}: ${outcome}`);
              fact(`build box, direct to ${what}: ${outcome}`);
            }
            const flush = await boxes.exec(box, netToolCommand("nft", ["flush ruleset"]));
            buildProbes.push(`flush: ${flush.code === 0 ? "flushed" : "refused"}`);
            fact(`build box, nft flush ruleset as an install script: exit ${flush.code}`);
            const after = await direct(box, hostAddress, mac.allInterfaces.port);
            buildProbes.push(`after the flush: ${after}`);
            const proxy = { host: hostAddress, port: Number(new URL(routeUrl).port) };
            const internet = await connect(box, proxy, "example.com:443");
            const alias = await connect(box, proxy, "registry.npmjs.com:443");
            buildProbes.push(`internet: ${internet}`, `registry alias: ${alias}`);
            fact(`build box, through the web route: example.com ${internet}, alias ${alias}`);
            // As an install script runs (DIPO-334): the box user, who can plant nothing.
            planted.push(...(await plant(box, "build box, as an install script")));
          },
        },
        image,
      );
      fact(
        `image ${result.tag} ${result.built ? "built" : "reused"} in ${Math.round(performance.now() - before)} ms`,
      );
      return result;
    })();
    return building;
  };

  // Behind the CI guard as well as the box one, so CI never builds an image.
  if (inCi)
    describe("the box network on real boxes (DIPO-281)", () => {
      it(
        "builds the office image in a build box where an install step reaches nothing but dipo's route (criterion 9)",
        async () => {
          const result = await built();
          if (!result.built) {
            fact(
              "the image existed already: the build box probes did not run; delete the image to run them",
            );
          } else {
            expect(buildProbes.filter((line) => line.endsWith(": open"))).toEqual([]);
            expect(buildProbes).toContain("flush: refused");
            expect(buildProbes).toContain("after the flush: closed");
            expect(buildProbes.find((line) => line.startsWith("internet:"))).toStartWith(
              "internet: HTTP/1.1 200",
            );
            expect(buildProbes.find((line) => line.startsWith("registry alias:"))).toStartWith(
              "registry alias: HTTP/1.1 403",
            );
            expectNothingPlanted(planted);
          }
          // The image runs Claude Code, and holds neither git nor dipo's build folder.
          const runId = `test-${crypto.randomUUID().slice(0, 8)}`;
          const name = boxName(runId);
          try {
            await boxes.create({
              runId,
              image: result.tag,
              network: network!,
              netTools: result.netTools,
            });
            await boxes.start(name);
            const claude = await boxes.exec(name, ["claude", "--version"], {
              env: { ...BOX_IMAGE_ENV },
            });
            expect(claude.code).toBe(0);
            const git = await boxes.exec(name, ["sh", "-c", "command -v git || echo none"]);
            expect(git.stdout.trim()).toBe("none");
            const folder = await boxes.exec(name, ["test", "-e", "/dipo-build"]);
            expect(folder.code).not.toBe(0);
            // The box user writes /work, its home and dipo's command folder (DIPO-334).
            const writes = await boxes.exec(name, [
              "sh",
              "-c",
              'touch /work/.probe "$HOME/.probe" /dipo/command/pid /dipo/door/.probe && id -u',
            ]);
            fact(`box user writes: exit ${writes.code}: ${writes.stderr.trim()}`);
            expect(writes.code).toBe(0);
            expect(writes.stdout.trim()).toBe(String(BOX_USER_UID));
          } finally {
            await boxes.delete(name).catch(() => {});
          }
        },
        TIMEOUT_MS,
      );

      it(
        "lets a box reach the Mac only on dipo's proxy ports, and a listed local port only through the web proxy (criterion 8)",
        async () => {
          const result = await built();
          const hostAddress = network!.hostAddress;
          const runId = `test-${crypto.randomUUID().slice(0, 8)}`;
          const name = boxName(runId);
          try {
            await boxes.create({
              runId,
              image: result.tag,
              network: network!,
              netTools: result.netTools,
            });
            await boxes.start(name);
            const mac = await openServices(hostAddress);
            const web = await route.acquire(name);
            // As a session sets it: the web route and the model proxy (a stand-in here) on the Mac.
            await boxes.firewall(name, {
              hostAddress,
              ports: [web.port, mac.model.port],
            });
            const password = new URL(web.admit(name, [mac.listed.port])).password;
            const outcomes: Record<string, string> = {};
            const tryDirect = async (what: string, host: string, port: number) => {
              outcomes[what] = await direct(name, host, port);
              fact(`box, direct to ${what}: ${outcomes[what]}`);
            };
            await tryDirect("the web route", hostAddress, web.port);
            await tryDirect("the model proxy", hostAddress, mac.model.port);
            await tryDirect("a Mac service on all interfaces", hostAddress, mac.allInterfaces.port);
            await tryDirect(
              "a Mac service on the box network address",
              hostAddress,
              mac.boxNetwork.port,
            );
            if (mac.lan !== null) {
              await tryDirect(
                "a Mac service on its local-network address",
                mac.lan.address,
                mac.lan.port,
              );
            }
            const gateway = await gatewayFound;
            if (gateway !== null) await tryDirect("the default gateway", gateway, 80);
            expect(outcomes["the web route"]).toBe("open");
            expect(outcomes["the model proxy"]).toBe("open");
            for (const [what, outcome] of Object.entries(outcomes)) {
              if (what !== "the web route" && what !== "the model proxy")
                expect(outcome).toBe("closed");
            }

            // The listed local port only through the web proxy, with the box's own password.
            const proxy = { host: hostAddress, port: web.port };
            const listed = await connect(
              name,
              proxy,
              `${BOX_LOCAL_HOST}:${mac.listed.port}`,
              password,
            );
            const unlisted = await connect(
              name,
              proxy,
              `${BOX_LOCAL_HOST}:${mac.unlisted.port}`,
              password,
            );
            const anonymous = await connect(name, proxy, `${BOX_LOCAL_HOST}:${mac.listed.port}`);
            const guessed = await connect(
              name,
              proxy,
              `${BOX_LOCAL_HOST}:${mac.listed.port}`,
              "guessed",
            );
            fact(
              `listed local port: ${listed}; unlisted: ${unlisted}; no password: ${anonymous}; a guessed one: ${guessed}`,
            );
            expect(listed).toStartWith("HTTP/1.1 200");
            expect(unlisted).toStartWith("HTTP/1.1 403");
            expect(anonymous).toStartWith("HTTP/1.1 403");
            expect(guessed).toStartWith("HTTP/1.1 403");
            // The loopback service itself is never reached directly.
            expect(await direct(name, "127.0.0.1", mac.listed.port)).toBe("closed");

            // The worker cannot undo the rule: no flush, no capability back, no change to the tools.
            const flush = await boxes.exec(name, netToolCommand("nft", ["flush ruleset"]));
            fact(
              `box, nft flush ruleset as the worker: exit ${flush.code}: ${flush.stderr.trim()}`,
            );
            expect(flush.code).not.toBe(0);
            // Asking setpriv for the capability back, and flushing the rule with it, fails too.
            const regain = await boxes.exec(
              name,
              netToolCommand("setpriv", [
                "--bounding-set=+net_admin",
                "--",
                ...netToolCommand("nft", ["flush ruleset"]),
              ]),
            );
            fact(
              `box, setpriv --bounding-set=+net_admin -- nft flush ruleset: exit ${regain.code}: ${regain.stderr.trim()}`,
            );
            expect(regain.code).not.toBe(0);
            const status = await boxes.exec(name, ["cat", "/proc/self/status"]);
            const bounding = BigInt(
              `0x${/CapBnd:\s*([0-9a-f]+)/.exec(status.stdout)?.[1] ?? "ffff"}`,
            );
            const effective = BigInt(
              `0x${/CapEff:\s*([0-9a-f]+)/.exec(status.stdout)?.[1] ?? "ffff"}`,
            );
            expect((bounding >> NET_ADMIN_BIT) & 1n).toBe(0n);
            expect((bounding >> NET_RAW_BIT) & 1n).toBe(0n);
            expect((effective >> NET_ADMIN_BIT) & 1n).toBe(0n);
            const write = await boxes.exec(name, [
              "sh",
              "-c",
              `echo x > ${BOX_NET_TOOLS_PATH}/bin/nft`,
            ]);
            expect(write.code).not.toBe(0);
            expect(await direct(name, hostAddress, mac.allInterfaces.port)).toBe("closed");
            // As the worker (DIPO-334): nothing planted, then the next session's firewall still
            // sets, and holds.
            expectNothingPlanted(await plant(name, "box, as the worker"));
            await boxes.firewall(name, { hostAddress, ports: [web.port, mac.model.port] });
            expect(await direct(name, hostAddress, web.port)).toBe("open");
            expect(await direct(name, hostAddress, mac.allInterfaces.port)).toBe("closed");
            for (const event of events) fact(`web proxy event: ${JSON.stringify(event)}`);
          } finally {
            await route.release(name);
            await boxes.delete(name).catch(() => {});
          }
        },
        TIMEOUT_MS,
      );

      it(
        "fails closed when a box has no box network tools to set its firewall with",
        async () => {
          await built();
          const runId = `build-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
          const name = boxName(runId);
          try {
            await boxes.pullImage("docker.io/library/debian:trixie-slim");
            await boxes.create({
              runId,
              image: "docker.io/library/debian:trixie-slim",
              network: network!,
            });
            await boxes.start(name);
            const error = await boxes
              .firewall(name, { hostAddress: network!.hostAddress, ports: [3128] })
              .then(() => null)
              .catch((caught: unknown) => caught);
            expect(error).toBeInstanceOf(BoxError);
            expect((error as BoxError).code).toBe("box.firewallFailed");
            // Nothing of the box's own can run contained without the tools either.
            const contained = await boxes.exec(name, ["true"]);
            expect(contained.code).not.toBe(0);
          } finally {
            await boxes.delete(name).catch(() => {});
          }
        },
        TIMEOUT_MS,
      );
    });
}
