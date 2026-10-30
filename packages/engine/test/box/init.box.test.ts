// Every box starts with Apple container's init (DIPO-378), on real boxes, opt-in: it registers
// only with DIPO_TEST_BOX=1 and never in CI. It needs macOS with Apple container 1.6.0 or newer and
// its service running, and the internet: it builds an office image of its own (a small
// description with `procps`, so no other test's image is rebuilt) in a build box, and a Safe-Chain
// image under a test tag, and deletes both at the end. That takes minutes. The maintainer runs it
// by hand:
//
//   DIPO_TEST_BOX=1 bun test packages/engine/test/box/init.box.test.ts
//
// Before DIPO-378 a box's PID 1 was its keepalive `tail`, which waits for no child, so every
// orphan of a box's commands stayed a zombie until the box stopped. It checks, on the build box
// (behind its firewall, before the install steps, through the build's `beforeInstall`) and on a
// box of the image with its firewall set as a session sets it:
// - what the old start caught still holds: the keepalive (the image's `tail` in the build box,
//   the mounted one in every other box) runs, now as the init's child, and keeps the box running
//   until dipo stops it; the box's root holds Apple's default capabilities and `CAP_NET_ADMIN`,
//   the box user none; the mounts are the tools (not in a build box) and the init's own file
//   `/.cz-init`, read-only from the VM's own root device, never a folder of the Mac;
// - orphans that exit are reaped, also after a double fork, in a new session, by SIGKILL and
//   twenty at once: none is left a zombie;
// - the bypass forms, as the box user: `kill` of PID 1 and of the keepalive, through wrappers,
//   quoting and chaining, each fails, PID 1 and the keepalive keep running, and the firewall is
//   still listed as dipo set it; as the box's own root, outside dipo's path, `kill -9` either
//   fails or stops the box;
// - fail closed on the real path: behind the firewall neither box reaches the Mac (on all
//   interfaces, on its loopback, on its local-network address), the default gateway or a
//   registry directly, while dipo's web route answers.
// The Safe-Chain box of the route starts with the init too. Every outcome is also printed as a
// `fact:` line. The test deletes only the boxes and images it made.

import { lookup } from "node:dns/promises";
import { createServer, isIP, type Server } from "node:net";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { afterAll, describe, expect, it } from "bun:test";

import { cleanEnv, makeTempDir, removeTempDir } from "@dipsaus-orchestrator/testkit";

import { BOX_KEEPALIVE } from "../../src/box/apple-args";
import { AppleContainerBoxes } from "../../src/box/apple-container";
import { ensureBoxImage, type BoxImageResult } from "../../src/box/build-box";
import {
  BOX_NET_TOOLS_PATH,
  BOX_USER_UID,
  type BoxFirewall,
  CONTAINED_KEEPALIVE,
} from "../../src/box/firewall";
import { boxImageTag, describeBox } from "../../src/box/image";
import { type BoxNetwork, boxName } from "../../src/box/port";
import {
  BoxWebRoute,
  type RunningBoxWebRoute,
  systemInterfaceAddresses,
} from "../../src/box/web-proxy";
import { startBoxWebRoute } from "../../src/box/safe-chain-box";
import { systemClock } from "../../src/platform/clock";
import { systemSpawn } from "../../src/platform/process";

const registers =
  process.env["DIPO_TEST_BOX"] === "1" &&
  process.env["DIPO_TEST_CI"] !== "1" &&
  process.env["CI"] === undefined &&
  process.platform === "darwin";

/** The image build in a build box takes minutes. */
const TIMEOUT_MS = 45 * 60_000;
const CLI = "/usr/local/bin/container";
/** Apple container's init, mounted at the root of every box started with `--init`. */
const INIT = "/.cz-init";
/** This test's own Safe-Chain image: a dipo box image tag no plan of dipo's hashes to. */
const SAFE_CHAIN_TAG = `dipo-box:${new Bun.CryptoHasher("sha256").update("DIPO-378 test Safe-Chain image").digest("hex")}`;
/** This test's own office image: a small description no other test builds. */
const DESCRIPTION = describeBox({ packages: ["procps"] }, {});
/** The bounding set Apple container gives a box's root (measured on 1.6.0), and CAP_NET_ADMIN. */
const APPLE_DEFAULT_CAPS = 0xa80425fbn;
const NET_ADMIN = 1n << 12n;
/** The mount points every box has, of the VM's own filesystems: proc, sysfs, devices and the root. */
const KERNEL_MOUNTS = [
  "/",
  "/dev",
  "/dev/mqueue",
  "/dev/pts",
  "/dev/shm",
  "/proc",
  "/proc/bus",
  "/proc/fs",
  "/proc/irq",
  "/proc/keys",
  "/proc/sys",
  "/proc/timer_list",
  "/sys",
  "/sys/firmware",
  "/sys/fs/cgroup",
];

/**
 * Orphans the box user leaves, each a shell line that prints the pid of every process that ends up
 * a child of PID 1 and exits within a second or two (the bypass forms of the reaper).
 */
const ORPHANS: readonly (readonly [string, string])[] = [
  ["an orphan", "/bin/sleep 1 >/dev/null 2>&1 & echo $!"],
  ["a double fork", "( /bin/sleep 1 >/dev/null 2>&1 & echo $! ); exit 0"],
  [
    "a double fork in a new session",
    "( setsid sh -c 'echo $$; exec /bin/sleep 1 >/dev/null 2>&1' & ); /bin/sleep 0.3",
  ],
  [
    "an orphan that kills itself with SIGKILL",
    "( sh -c 'echo $$; /bin/sleep 0.5 >/dev/null 2>&1; kill -9 $$' & ); /bin/sleep 0.3",
  ],
  [
    "twenty orphans at once",
    "for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do ( /bin/sleep 0.5 >/dev/null 2>&1 & echo $! ); done",
  ],
];

function fact(text: string): void {
  console.log(`fact: ${text}`);
}

/** The bounding set of a `/proc/<pid>/status`. */
function bounding(status: string): bigint {
  return BigInt(`0x${/CapBnd:\s*([0-9a-f]+)/.exec(status)?.[1] ?? "0"}`);
}

/** One process of a box, from `/proc/<pid>/stat` and its command line. */
interface Proc {
  readonly pid: number;
  readonly state: string;
  readonly ppid: number;
  readonly argv: readonly string[];
}

/** The status of one `exec`, as the box ran it. */
interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
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

/** The pids a shell line printed, one per line. */
function pidsOf(stdout: string): number[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line))
    .map(Number);
}

/** True when `argv` runs `keepalive`: `container`'s init runs a bare program name by its path. */
function runsKeepalive(argv: readonly string[], keepalive: readonly string[]): boolean {
  const [program, ...args] = keepalive;
  return (
    argv.length === keepalive.length &&
    (argv[0] === program || (!program!.includes("/") && basename(argv[0]!) === program)) &&
    argv.slice(1).every((arg, at) => arg === args[at])
  );
}

if (registers) {
  const root = makeTempDir();
  const env = cleanEnv();
  const cliEnv = { PATH: env["PATH"] ?? "/usr/bin:/bin:/usr/local/bin", HOME: homedir() };
  const toolsRoot = join(root, "box-net-tools");
  const boxes = new AppleContainerBoxes({
    spawn: systemSpawn,
    clock: systemClock,
    cli: CLI,
    env: cliEnv,
    netToolsRoot: toolsRoot,
  });
  let network: BoxNetwork | null = null;
  const safeChainBoxes: string[] = [];
  const route = new BoxWebRoute<RunningBoxWebRoute>(async () => {
    const started = await startBoxWebRoute(
      network ?? (await boxes.network()),
      {
        boxes,
        clock: systemClock,
        scratchRoot: join(root, "scratch"),
        toolsRoot,
        caFile: join(root, "route", "ca.pem"),
        imageTag: SAFE_CHAIN_TAG,
        onSafeChain: (box) => safeChainBoxes.push(box.name),
      },
      { clock: systemClock },
    );
    if (!started.ok) throw new Error(started.reason);
    return started.route;
  });
  let services: {
    allInterfaces: { server: Server; port: number };
    loopback: { server: Server; port: number };
    lan: { address: string; server: Server; port: number } | null;
  } | null = null;
  const gatewayFound = defaultGateway(cliEnv);
  const registryAddress = lookup("registry.npmjs.org", { family: 4 }).then(
    (found) => found.address,
  );

  afterAll(async () => {
    await route.close();
    if (services !== null) {
      for (const service of [
        services.allInterfaces,
        services.loopback,
        ...(services.lan === null ? [] : [services.lan]),
      ]) {
        service.server.close();
      }
    }
    await boxes.deleteImage(boxImageTag(DESCRIPTION.image)).catch(() => {});
    await boxes.deleteImage(SAFE_CHAIN_TAG).catch(() => {});
    removeTempDir(root);
  }, TIMEOUT_MS);

  /** The Mac's services; they open once a box runs, since the box network's address exists only then. */
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
      loopback: await listenOn("127.0.0.1"),
      lan:
        lanAddress === undefined ? null : { address: lanAddress, ...(await listenOn(lanAddress)) },
    };
    fact(`the Mac's own local-network address: ${lanAddress === undefined ? "none" : "found"}`);
    return services;
  };

  /** `command` run by `container exec` itself, as the box's own root, outside dipo's path. */
  const inspect = async (box: string, command: readonly string[]): Promise<Ran> => {
    const child = systemSpawn({ cmd: [CLI, "exec", box, ...command], env: cliEnv });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code: exit.code ?? -1, stdout, stderr };
  };

  /** Every process of `box`, as its root reads `/proc`. */
  const processes = async (box: string): Promise<Proc[]> => {
    const listed = await inspect(box, [
      "/bin/sh",
      "-c",
      'for p in /proc/[0-9]*; do s=$(cat "$p/stat" 2>/dev/null) || continue; c=$(tr "\\000" "\\001" < "$p/cmdline" 2>/dev/null); printf "%s\\t%s\\n" "$s" "$c"; done',
    ]);
    expect(listed.code).toBe(0);
    return listed.stdout
      .split("\n")
      .filter((line) => line.includes("\t"))
      .map((line) => {
        const [stat, cmdline] = [
          line.slice(0, line.indexOf("\t")),
          line.slice(line.indexOf("\t") + 1),
        ];
        const close = stat.lastIndexOf(")");
        const [state, ppid] = stat
          .slice(close + 1)
          .trim()
          .split(/\s+/);
        return {
          pid: Number(stat.slice(0, stat.indexOf(" "))),
          state: state ?? "",
          ppid: Number(ppid),
          argv: cmdline.split("\u0001").filter((arg, at, all) => at < all.length - 1 || arg !== ""),
        };
      });
  };

  /** PID 1 and the keepalive of `box`: the init, and the keepalive as its child. */
  const initAndKeepalive = async (box: string, keepalive: readonly string[]) => {
    const all = await processes(box);
    const init = all.find((proc) => proc.pid === 1);
    const child = all.find(
      (proc) => proc.ppid === 1 && proc.state !== "Z" && runsKeepalive(proc.argv, keepalive),
    );
    fact(
      `${box}: PID 1 runs ${JSON.stringify(init?.argv)}, its keepalive ${JSON.stringify(child)}`,
    );
    return { init, child, zombies: all.filter((proc) => proc.state === "Z") };
  };

  /** The mount points of `box` beyond the kernel's, each with its source and whether read-only. */
  const extraMounts = async (box: string) => {
    const mounts = await inspect(box, ["/bin/cat", "/proc/mounts"]);
    expect(mounts.code).toBe(0);
    const lines = mounts.stdout
      .trim()
      .split("\n")
      .map((line) => line.split(" "));
    const points = lines.map((fields) => fields[1]!);
    fact(`${box}: mounts ${points.join(", ")}`);
    expect(points.filter((point) => KERNEL_MOUNTS.includes(point)).toSorted()).toEqual(
      KERNEL_MOUNTS,
    );
    return lines
      .filter((fields) => !KERNEL_MOUNTS.includes(fields[1]!))
      .map((fields) => ({
        point: fields[1]!,
        source: fields[0]!,
        type: fields[2]!,
        readOnly: (fields[3] ?? "").split(",").includes("ro"),
      }))
      .toSorted((a, b) => a.point.localeCompare(b.point));
  };

  /** The bounding sets of the box's root and of the box user, as the kernel reports them. */
  const capabilities = async (box: string) => {
    const own = await inspect(box, ["/bin/grep", "^Cap", "/proc/self/status"]);
    const init = await inspect(box, ["/bin/grep", "^Cap", "/proc/1/status"]);
    const user = await boxes.exec(box, ["/bin/grep", "^Cap", "/proc/self/status"]);
    const uid = await boxes.exec(box, ["id", "-u"]);
    fact(`${box}: the box's root ${own.stdout.replaceAll("\n", " ")}`);
    fact(`${box}: the box user ${user.stdout.replaceAll("\n", " ")}`);
    return {
      root: bounding(own.stdout),
      init: bounding(init.stdout),
      user: user.stdout,
      uid: uid.stdout.trim(),
    };
  };

  /** Orphans of the box user (`ORPHANS`), then whether any of them, or any process, is a zombie. */
  const orphansReaped = async (box: string) => {
    const left: Record<string, number[]> = {};
    for (const [what, line] of ORPHANS) {
      const ran = await boxes.exec(box, ["sh", "-c", line]);
      left[what] = pidsOf(ran.stdout);
      fact(`${box}: ${what}: pids ${left[what]!.join(" ")} (exit ${ran.code})`);
    }
    await Bun.sleep(3_000);
    const all = await processes(box);
    const outcome: Record<string, string> = {};
    for (const [what, pids] of Object.entries(left)) {
      const zombies = pids.filter((pid) =>
        all.some((proc) => proc.pid === pid && proc.state === "Z"),
      );
      outcome[what] =
        pids.length === 0 ? "no pid" : zombies.length === 0 ? "reaped" : `zombies ${zombies}`;
      fact(`${box}: ${what}: ${outcome[what]}`);
    }
    return { outcome, zombies: all.filter((proc) => proc.state === "Z") };
  };

  /** One TCP connection from inside `box`, contained, with bash's /dev/tcp: open or closed. */
  const direct = async (box: string, host: string, port: number): Promise<string> => {
    const tried = await boxes.exec(box, [
      "timeout",
      "6",
      "bash",
      "-c",
      `exec 3<>/dev/tcp/${host}/${port} && echo open || echo closed`,
    ]);
    return tried.stdout.trim() === "open" ? "open" : "closed";
  };

  /** What the firewall refuses, tried directly from `box`, and dipo's web route, which it allows. */
  const reach = async (box: string, hostAddress: string, routePort: number) => {
    const mac = await openServices(hostAddress);
    const gateway = await gatewayFound;
    const tries: [string, string, number][] = [
      ["the web route", hostAddress, routePort],
      ["a Mac service on all interfaces", hostAddress, mac.allInterfaces.port],
      ["a Mac service on its loopback, at the Mac's address", hostAddress, mac.loopback.port],
      ["a Mac service on its loopback, at the box's loopback", "127.0.0.1", mac.loopback.port],
      ...(mac.lan === null
        ? []
        : ([["a Mac service on its local-network address", mac.lan.address, mac.lan.port]] as [
            string,
            string,
            number,
          ][])),
      ...(gateway === null
        ? []
        : ([["the default gateway", gateway, 80]] as [string, string, number][])),
      ["the npm registry's public address", await registryAddress, 443],
    ];
    const outcomes: Record<string, string> = {};
    for (const [what, host, port] of tries) {
      outcomes[what] = await direct(box, host, port);
      fact(`${box}: direct to ${what}: ${outcomes[what]}`);
    }
    return outcomes;
  };

  /**
   * The box user's `kill` of PID 1 and of the keepalive (pid `keepalive`), in its bypass forms:
   * wrappers, quoting, indirection and chaining. Each exit code, by form.
   */
  const userKills = async (box: string, keepalive: number) => {
    const forms: [string, string][] = [
      ["kill -9 1", "kill -9 1"],
      ["kill -KILL 1, quoted", "'kill' '-KILL' '1'"],
      ["kill -9 1 through env and a second shell", "env sh -c 'kill -9 1'"],
      ["kill -9 1 through eval", "true && eval 'kill -9 1'"],
      ["kill -9 1 through timeout", "timeout 5 sh -c 'kill -9 1'"],
      ["kill -TERM 1", "kill -TERM 1"],
      ["kill -STOP 1", "kill -STOP 1"],
      ["kill -9 of the keepalive", `kill -9 ${keepalive}`],
      ["kill -9 of the keepalive through env", `env sh -c 'kill -9 ${keepalive}'`],
      ["/bin/kill -9 1", "[ -x /bin/kill ] || { echo absent; exit 0; }; /bin/kill -9 1"],
    ];
    const codes: Record<string, number> = {};
    for (const [what, line] of forms) {
      const tried = await boxes.exec(box, ["sh", "-c", line]);
      // The base image of a build box has no /bin/kill (procps); the shell's own kill stands in.
      if (tried.stdout.trim() === "absent") {
        fact(`${box}: as the box user, ${what}: no /bin/kill in this box`);
        continue;
      }
      codes[what] = tried.code ?? -1;
      fact(`${box}: as the box user, ${what}: exit ${tried.code}: ${tried.stderr.trim()}`);
    }
    // Every process the box user may signal: its own, never PID 1 or the keepalive.
    const all = await boxes.exec(box, ["sh", "-c", "kill -9 -1"]);
    fact(`${box}: as the box user, kill -9 -1: exit ${all.code}`);
    return codes;
  };

  /** True while `box` runs, as `container list` sees it. */
  const running = async (box: string) =>
    (await boxes.list()).find((entry) => entry.name === box)?.state === "running";

  /** What the build box showed behind its firewall, before the install steps. */
  let buildSeen: {
    box: string;
    initAndKeepalive: Awaited<ReturnType<typeof initAndKeepalive>>;
    mounts: Awaited<ReturnType<typeof extraMounts>>;
    capabilities: Awaited<ReturnType<typeof capabilities>>;
    orphans: Awaited<ReturnType<typeof orphansReaped>>;
    kills: Record<string, number>;
    after: Awaited<ReturnType<typeof initAndKeepalive>>;
    stillRunning: boolean;
    firewallHeld: boolean;
    reach: Record<string, string>;
  } | null = null;
  let building: Promise<BoxImageResult> | null = null;
  const built = (): Promise<BoxImageResult> => {
    building ??= (async () => {
      expect(await boxes.check()).toMatchObject({ ok: true });
      network = await boxes.network();
      const hostAddress = network.hostAddress;
      const before = performance.now();
      const result = await ensureBoxImage(
        {
          boxes,
          route,
          scratchRoot: join(root, "scratch"),
          toolsRoot,
          clock: systemClock,
          onEvent: (event) => fact(`build cleanup: ${JSON.stringify(event)}`),
          beforeInstall: async (box, routeUrl) => {
            const routePort = Number(new URL(routeUrl).port);
            const firewall: BoxFirewall = { hostAddress, ports: [routePort] };
            const seen = await initAndKeepalive(box, BOX_KEEPALIVE);
            const mounts = await extraMounts(box);
            const caps = await capabilities(box);
            const orphans = await orphansReaped(box);
            const kills = await userKills(box, seen.child?.pid ?? 0);
            const after = await initAndKeepalive(box, BOX_KEEPALIVE);
            const firewallHeld = await boxes
              .checkFirewall(box, firewall)
              .then(() => true)
              .catch(() => false);
            buildSeen = {
              box,
              initAndKeepalive: seen,
              mounts,
              capabilities: caps,
              orphans,
              kills,
              after,
              stillRunning: await running(box),
              firewallHeld,
              reach: await reach(box, hostAddress, routePort),
            };
          },
        },
        DESCRIPTION.image,
      );
      fact(
        `image ${result.tag} ${result.built ? "built" : "reused"} in ${Math.round(performance.now() - before)} ms`,
      );
      return result;
    })();
    return building;
  };

  describe("every box starts with the init (DIPO-378)", () => {
    it(
      "the build box: the image's tail as the init's child, no mount of the Mac, orphans reaped, kills refused, the firewall closed",
      async () => {
        const result = await built();
        expect(result.built).toBe(true);
        const seen = buildSeen!;
        expect(seen).not.toBeNull();
        // What the old start caught: the keepalive runs, now under the init, and keeps the box up;
        // dipo stopped it to commit the image (the build completed).
        expect(seen.initAndKeepalive.init?.argv).toEqual([INIT, "--", ...BOX_KEEPALIVE]);
        expect(seen.initAndKeepalive.child).toBeDefined();
        expect(seen.stillRunning).toBe(true);
        expect(await running(seen.box)).toBe(false);
        // No mount but the init's own file, read-only, from the VM's root device.
        expect(seen.mounts).toEqual([
          { point: INIT, source: "/dev/root", type: "ext4", readOnly: true },
        ]);
        expect(seen.capabilities.root).toBe(APPLE_DEFAULT_CAPS | NET_ADMIN);
        expect(seen.capabilities.init).toBe(APPLE_DEFAULT_CAPS | NET_ADMIN);
        expect(seen.capabilities.uid).toBe(String(BOX_USER_UID));
        expect(seen.capabilities.user).toMatch(/CapBnd:\s*0+\n/);
        expect(seen.capabilities.user).toMatch(/CapEff:\s*0+\n/);
        // Orphans reaped.
        expect(Object.values(seen.orphans.outcome)).toEqual(ORPHANS.map(() => "reaped"));
        expect(seen.orphans.zombies).toEqual([]);
        // The box user's kills fail, and nothing they aimed at moved.
        for (const [what, code] of Object.entries(seen.kills)) {
          expect({ what, failed: code !== 0 }).toEqual({ what, failed: true });
        }
        expect(seen.after.init?.argv).toEqual(seen.initAndKeepalive.init?.argv);
        expect(seen.after.child?.pid).toBe(seen.initAndKeepalive.child?.pid);
        expect(seen.firewallHeld).toBe(true);
        // Fail closed: only dipo's web route answers.
        expect(seen.reach["the web route"]).toBe("open");
        for (const [what, outcome] of Object.entries(seen.reach)) {
          if (what !== "the web route")
            expect({ what, outcome }).toEqual({ what, outcome: "closed" });
        }
      },
      TIMEOUT_MS,
    );

    it(
      "a box of the image: the mounted tail as the init's child, the tools mount only, orphans reaped, kills refused, the firewall closed",
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
          const web = await route.acquire(name);
          // As a session sets it.
          const firewall: BoxFirewall = { hostAddress, ports: [web.port] };
          await boxes.firewall(name, firewall);

          // The Safe-Chain box of the route started with the init too. The build's route ended
          // with the build, so this route's box is the last one.
          const safeChain = safeChainBoxes.at(-1)!;
          const pid1 = await inspect(safeChain, ["/bin/cat", "/proc/1/cmdline"]);
          fact(
            `${safeChain}: PID 1 runs ${JSON.stringify(pid1.stdout.split("\u0000"))}: ${pid1.stderr.trim()}`,
          );
          expect(pid1.stdout.split("\u0000").slice(0, -1)).toEqual([
            INIT,
            "--",
            ...CONTAINED_KEEPALIVE,
          ]);

          // What the old start caught.
          const seen = await initAndKeepalive(name, CONTAINED_KEEPALIVE);
          expect(seen.init?.argv).toEqual([INIT, "--", ...CONTAINED_KEEPALIVE]);
          expect(seen.child).toBeDefined();
          const mounts = await extraMounts(name);
          expect(mounts.map(({ point, readOnly }) => ({ point, readOnly }))).toEqual([
            { point: INIT, readOnly: true },
            { point: BOX_NET_TOOLS_PATH, readOnly: true },
          ]);
          expect(mounts[0]).toMatchObject({ source: "/dev/root", type: "ext4" });
          const caps = await capabilities(name);
          expect(caps.root).toBe(APPLE_DEFAULT_CAPS | NET_ADMIN);
          expect(caps.init).toBe(APPLE_DEFAULT_CAPS | NET_ADMIN);
          expect(caps.uid).toBe(String(BOX_USER_UID));
          expect(caps.user).toMatch(/CapBnd:\s*0+\n/);
          expect(caps.user).toMatch(/CapEff:\s*0+\n/);
          expect(caps.user).toMatch(/CapPrm:\s*0+\n/);
          await Bun.sleep(3_000);
          expect(await running(name)).toBe(true);

          // Orphans reaped.
          const orphans = await orphansReaped(name);
          expect(Object.values(orphans.outcome)).toEqual(ORPHANS.map(() => "reaped"));
          expect(orphans.zombies).toEqual([]);

          // The box user's kills fail; PID 1, the keepalive and the firewall stay.
          const kills = await userKills(name, seen.child!.pid);
          for (const [what, code] of Object.entries(kills)) {
            expect({ what, failed: code !== 0 }).toEqual({ what, failed: true });
          }
          const after = await initAndKeepalive(name, CONTAINED_KEEPALIVE);
          expect(after.init?.argv).toEqual(seen.init?.argv);
          expect(after.child?.pid).toBe(seen.child!.pid);
          expect(await running(name)).toBe(true);
          await boxes.checkFirewall(name, firewall);

          // Fail closed: only dipo's web route answers.
          const outcomes = await reach(name, hostAddress, web.port);
          expect(outcomes["the web route"]).toBe("open");
          for (const [what, outcome] of Object.entries(outcomes)) {
            if (what !== "the web route")
              expect({ what, outcome }).toEqual({ what, outcome: "closed" });
          }

          // dipo stops the box: the init passes the stop on, and the box stops.
          const stopping = performance.now();
          await boxes.stop(name);
          fact(`${name}: stopped by dipo in ${Math.round(performance.now() - stopping)} ms`);
          expect(await running(name)).toBe(false);

          // As the box's own root, outside dipo's path: kill -9 of PID 1, then of the keepalive,
          // either fails or stops the box.
          await boxes.start(name);
          const restarted = await initAndKeepalive(name, CONTAINED_KEEPALIVE);
          expect(restarted.child).toBeDefined();
          for (const [what, pid] of [
            ["PID 1", 1],
            ["the keepalive", restarted.child!.pid],
          ] as const) {
            const tried = await inspect(name, ["/bin/sh", "-c", `kill -9 ${pid}`]);
            await Bun.sleep(2_000);
            const up = await running(name);
            const now = up ? await initAndKeepalive(name, CONTAINED_KEEPALIVE) : null;
            fact(
              `${name}: as the box's root, kill -9 of ${what}: exit ${tried.code}; the box ${up ? "runs" : "stopped"}`,
            );
            if (up) {
              expect(now!.init?.argv).toEqual([INIT, "--", ...CONTAINED_KEEPALIVE]);
              expect(now!.child).toBeDefined();
            }
          }
        } finally {
          await route.release(name).catch(() => {});
          await boxes.delete(name).catch(() => {});
        }
        expect((await boxes.list()).map((box) => box.name)).not.toContain(name);
      },
      TIMEOUT_MS,
    );
  });
}
