// dipo's root steps on real boxes (DIPO-336, from the DIPO-334 review), opt-in: it registers only
// with DIPO_TEST_BOX=1 and never in CI. It needs macOS with Apple container 1.6.0 or newer and its
// service running, and the internet (the web route builds its Safe-Chain box from the pinned
// release, DIPO-343); it builds the office image of a small description in a build box, which
// takes minutes. The maintainer runs it by hand:
//
//   DIPO_TEST_BOX=1 bun test packages/engine/test/box/root-step.box.test.ts
//
// The fixed root steps outside a build box (`isRootStep`) keep only chown, dac_override and
// fowner (`ROOT_STEP_CAPABILITIES`); a build box's root steps keep the build box's own list
// (`BUILD_ROOT_CAPABILITIES`). On the real boxes it checks:
// - each list as the kernel sees it: a root step's capability sets, read from /proc, in a box of
//   the image (the fixed list) and in the build box behind its firewall (the build list);
// - what the steps still do with the smaller list, each through dipo's own path (`exec` with
//   `rootStep`): a stage folder made root's and closed, handed over to the box user with links
//   kept as links, removed when the box user has left it unreadable, and `dipo-part` made
//   runnable (`installDipoPart`), and a whole `copyInAsUser`;
// - the bypass forms: a command outside the fixed list asked for as root is refused before it
//   reaches the box, in its wrapped forms too; a step's own arguments that ask setpriv for a
//   capability get none in the kernel; and every root step `container` ran in a box that is no
//   build box carried the fixed list, never the build box's;
// - fail closed against the real path: as a fixed root step, dropping to another user (it needs
//   setuid) fails in the box, while the build box's list, in the same box, lets it through.
//
// To read a root step's capabilities and to look at files the box user cannot read, the test
// runs `container exec` itself (`inspect`): outside dipo's path, as the box's own root, or with
// the exact wrapper dipo's path adds (`rootStepCommand`). The test deletes only the boxes it made,
// and keeps the image.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "bun:test";

import type { Spawn } from "@dipsaus-orchestrator/contract";

import { cleanEnv, makeTempDir, removeTempDir } from "@dipsaus-orchestrator/testkit";

import { AppleContainerBoxes } from "../../src/box/apple-container";
import { ensureBoxImage, type BoxImageResult } from "../../src/box/build-box";
import { installDipoPart } from "../../src/box/door";
import {
  BOX_USER_UID,
  BUILD_ROOT_CAPABILITIES,
  boundingSet,
  buildRootStepCommand,
  netToolCommand,
  ROOT_STEP_CAPABILITIES,
  rootStepCommand,
} from "../../src/box/firewall";
import { describeBox } from "../../src/box/image";
import { BoxError, type BoxNetwork, boxName } from "../../src/box/port";
import { BoxWebRoute, type RunningBoxWebRoute } from "../../src/box/web-proxy";
import { startBoxWebRoute } from "../../src/box/safe-chain-box";
import {
  BOX_STAGE_ROOT,
  copyInAsUser,
  DIPO_PART_PATH,
  newStagePath,
  partModeCommand,
  stageHandOverCommand,
  stageMakeCommand,
  stageRemoveCommand,
} from "../../src/box/user";
import { systemClock } from "../../src/platform/clock";
import { systemSpawn } from "../../src/platform/process";

const registers =
  process.env["DIPO_TEST_BOX"] === "1" &&
  process.env["DIPO_TEST_CI"] !== "1" &&
  process.env["CI"] === undefined;

/** The image build in a build box takes minutes. */
const TIMEOUT_MS = 45 * 60_000;
const CLI = "/usr/local/bin/container";

/** Linux capability numbers, by setpriv's names. */
const CAP_BITS: Readonly<Record<string, bigint>> = {
  chown: 0n,
  dac_override: 1n,
  dac_read_search: 2n,
  fowner: 3n,
  fsetid: 4n,
  kill: 5n,
  setgid: 6n,
  setuid: 7n,
  setpcap: 8n,
  net_admin: 12n,
  net_raw: 13n,
  sys_chroot: 18n,
  sys_admin: 21n,
  mknod: 27n,
  audit_write: 29n,
  setfcap: 31n,
};

/** The mask of the capabilities `names`. */
function maskOf(names: readonly string[]): bigint {
  return names.reduce((mask, name) => {
    const bit = CAP_BITS[name];
    if (bit === undefined) throw new Error(`no bit for ${name}`);
    return mask | (1n << bit);
  }, 0n);
}

/** The capability sets of `/proc/self/status`'s `Cap*` lines, by their names. */
function capSets(status: string): Record<string, bigint> {
  const sets: Record<string, bigint> = {};
  for (const [, name, hex] of status.matchAll(/^Cap(\w+):\s*([0-9a-f]+)$/gm)) {
    sets[name!] = BigInt(`0x${hex}`);
  }
  return sets;
}

function fact(text: string): void {
  console.log(`fact: ${text}`);
}

/** The status of one `exec`, as the box ran it. */
interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

if (registers) {
  const root = makeTempDir();
  const env = cleanEnv();
  const cliEnv = { PATH: env["PATH"] ?? "/usr/bin:/bin:/usr/local/bin", HOME: homedir() };
  /** Every `container` argv dipo's path ran, to check which list each root step carried. */
  const spawned: (readonly string[])[] = [];
  const recording: Spawn = (options) => {
    spawned.push(options.cmd);
    return systemSpawn(options);
  };
  const boxes = new AppleContainerBoxes({
    spawn: recording,
    clock: systemClock,
    cli: CLI,
    env: cliEnv,
    netToolsRoot: join(root, "box-net-tools"),
  });
  let network: BoxNetwork | null = null;
  const route = new BoxWebRoute<RunningBoxWebRoute>(async () => {
    const started = await startBoxWebRoute(
      network ?? (await boxes.network()),
      {
        boxes,
        clock: systemClock,
        scratchRoot: join(root, "scratch"),
        toolsRoot: join(root, "box-net-tools"),
        caFile: join(root, "route", "ca.pem"),
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

  /** `command` run by `container exec` itself, outside dipo's path (file comment). */
  const inspect = async (box: string, command: readonly string[]): Promise<Ran> => {
    const child = systemSpawn({ cmd: [CLI, "exec", box, ...command], env: cliEnv });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code: exit.code ?? -1, stdout, stderr };
  };

  /** One of dipo's root steps through dipo's own path; it must succeed. */
  const rootStep = async (box: string, command: readonly [string, ...string[]]) => {
    const ran = await boxes.exec(box, command, { rootStep: true });
    if (ran.code !== 0) fact(`root step ${command.join(" ")} failed: ${ran.stderr.trim()}`);
    expect(ran.code).toBe(0);
  };

  /** The build box's sets: its own root's, and a root step's through dipo's path. */
  const buildBox: { initial: bigint; step: Record<string, bigint> } = {
    initial: 0n,
    step: {},
  };
  let building: Promise<BoxImageResult> | null = null;
  const built = (): Promise<BoxImageResult> => {
    building ??= (async () => {
      expect(await boxes.check()).toMatchObject({ ok: true });
      network = await boxes.network();
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
          // Behind the firewall, where the system step runs as a root step of the build box.
          beforeInstall: async (box) => {
            const own = await inspect(box, ["/bin/grep", "^Cap", "/proc/self/status"]);
            buildBox.initial = capSets(own.stdout)["Bnd"] ?? 0n;
            const step = await boxes.exec(box, ["/bin/grep", "^Cap", "/proc/self/status"], {
              rootStep: true,
            });
            expect(step.code).toBe(0);
            buildBox.step = capSets(step.stdout);
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

  /** Makes and starts a box of the image; `use` runs with its name, and the box is deleted. */
  const withBox = async (use: (name: string) => Promise<void>): Promise<void> => {
    const result = await built();
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
      await use(name);
    } finally {
      await boxes.delete(name).catch(() => {});
    }
    expect((await boxes.list()).map((box) => box.name)).not.toContain(name);
  };

  /** The `container exec` argvs of root steps that dipo's path ran in `box`, and their lists. */
  const rootStepLists = (box: string): string[] =>
    spawned
      .filter((cmd) => cmd[1] === "exec" && cmd.includes(box))
      .map((cmd) => cmd.slice(cmd.indexOf(box) + 1))
      .filter((command) => command[0] === netToolCommand("setpriv", [])[0])
      .filter((command) => !command.some((part) => part.startsWith("--reuid=")))
      .map((command) => command.find((part) => part.startsWith("--bounding-set=")) ?? "");

  describe("dipo's root steps on real boxes (DIPO-336)", () => {
    it(
      "runs the fixed root steps with chown, dac_override and fowner only, and each still does its job",
      async () => {
        await withBox(async (name) => {
          // The list as the kernel sees it: the box's own root has more; a fixed step keeps the three.
          const own = capSets(
            (await inspect(name, ["/bin/grep", "^Cap", "/proc/self/status"])).stdout,
          );
          const fixed = maskOf(ROOT_STEP_CAPABILITIES);
          expect(fixed).toBe(0xbn);
          expect(own["Bnd"]! & fixed).toBe(fixed);
          expect(own["Bnd"]! & ~fixed).not.toBe(0n);
          const step = capSets(
            (await inspect(name, rootStepCommand(["/bin/grep", "^Cap", "/proc/self/status"])))
              .stdout,
          );
          fact(
            `a fixed root step's capability sets: ${JSON.stringify(step, (_, v) => (typeof v === "bigint" ? v.toString(16) : v))}`,
          );
          expect(step["Bnd"]).toBe(fixed);
          expect(step["Prm"]).toBe(fixed);
          expect(step["Eff"]).toBe(fixed);
          expect(step["Inh"]).toBe(0n);
          expect(step["Amb"]).toBe(0n);
          for (const cap of [
            "dac_read_search",
            "fsetid",
            "setuid",
            "setgid",
            "kill",
            "sys_chroot",
            "audit_write",
            "net_admin",
            "net_raw",
          ]) {
            expect((step["Bnd"]! >> CAP_BITS[cap]!) & 1n).toBe(0n);
          }
          const uid = await inspect(name, rootStepCommand(["/usr/bin/id", "-u"]));
          expect(uid.stdout.trim()).toBe("0");

          // mkdir: the stage folder, root's and closed to the box user.
          const stage = newStagePath();
          await rootStep(name, stageMakeCommand(stage));
          expect(
            (await inspect(name, ["/usr/bin/stat", "-c", "%u:%g %a", stage])).stdout.trim(),
          ).toBe("0:0 700");
          const closed = await boxes.exec(name, ["/bin/ls", stage]);
          expect(closed.code).not.toBe(0);

          // chown -R -h: the copy and everything in it given to the box user; a link stays a link,
          // and what it points to keeps its owner.
          const source = join(root, `source-${crypto.randomUUID().slice(0, 8)}`);
          mkdirSync(join(source, "deep"), { recursive: true });
          writeFileSync(join(source, "a.txt"), "from the host\n");
          writeFileSync(join(source, "deep", "b.txt"), "deeper\n", { mode: 0o600 });
          await boxes.copyIn(name, `${source}/.`, stage);
          // A link to a file of root's, made in the stage, for `-h` to keep.
          const link = await inspect(name, [
            "/bin/ln",
            "-s",
            "/etc/hostname",
            `${stage}/hostname-link`,
          ]);
          expect(link.code).toBe(0);
          await rootStep(name, stageHandOverCommand(stage));
          const owners = await inspect(name, ["/usr/bin/find", stage, "-printf", "%U:%G %y %P\\n"]);
          const lines = owners.stdout.trim().split("\n");
          fact(`the stage after the hand-over: ${lines.join("; ")}`);
          expect(lines.length).toBe(5);
          for (const line of lines) expect(line).toStartWith(`${BOX_USER_UID}:${BOX_USER_UID} `);
          expect(lines).toContain(`${BOX_USER_UID}:${BOX_USER_UID} l hostname-link`);
          expect(
            (await inspect(name, ["/usr/bin/stat", "-c", "%u:%g", "/etc/hostname"])).stdout.trim(),
          ).toBe("0:0");
          const read = await boxes.exec(name, ["/bin/cat", `${stage}/a.txt`]);
          expect(read).toMatchObject({ code: 0, stdout: "from the host\n" });

          // rm -rf: the stage removed, also when the box user left it unreadable to others.
          const locked = await boxes.exec(name, [
            "/bin/sh",
            "-c",
            `mkdir ${stage}/deep/locked && touch ${stage}/deep/locked/x && chmod 000 ${stage}/deep/locked ${stage}/deep && chmod 000 ${stage}`,
          ]);
          expect(locked.code).toBe(0);
          await rootStep(name, stageRemoveCommand(stage));
          expect((await inspect(name, ["/usr/bin/test", "-e", stage])).code).not.toBe(0);

          // chmod of dipo-part: root's, runnable by the box user, not writable by it.
          await installDipoPart({ boxes, tmpRoot: root }, name);
          expect(
            (
              await inspect(name, ["/usr/bin/stat", "-c", "%u:%g %a", DIPO_PART_PATH])
            ).stdout.trim(),
          ).toBe("0:0 755");
          await rootStep(name, partModeCommand());
          const write = await boxes.exec(name, ["/bin/sh", "-c", `echo x >> ${DIPO_PART_PATH}`]);
          expect(write.code).not.toBe(0);

          // The whole copy for the box user, which runs the stage steps in turn.
          await copyInAsUser(boxes, name, source, "/work/copied");
          const copied = await boxes.exec(name, ["/bin/cat", "/work/copied/deep/b.txt"]);
          expect(copied).toMatchObject({ code: 0, stdout: "deeper\n" });
          expect(
            (
              await inspect(name, ["/usr/bin/stat", "-c", "%u:%g", "/work/copied/a.txt"])
            ).stdout.trim(),
          ).toBe(`${BOX_USER_UID}:${BOX_USER_UID}`);
          expect((await inspect(name, ["/bin/ls", "-A", BOX_STAGE_ROOT])).stdout.trim()).toBe("");

          // Every root step dipo's path ran in this box carried the fixed list, never the build box's.
          const lists = rootStepLists(name);
          fact(`root steps run in the box of the image: ${lists.length}`);
          expect(lists.length).toBeGreaterThanOrEqual(8);
          expect(new Set(lists)).toEqual(new Set([boundingSet(ROOT_STEP_CAPABILITIES)]));
        });

        // The build box keeps its own list: a root step there, behind its firewall, as the kernel
        // saw it, is the build list as far as the box's own root has it, never the network.
        const result = await built();
        if (!result.built) {
          fact("the image existed with its tools already: the build box check did not run");
        } else {
          const build = maskOf(BUILD_ROOT_CAPABILITIES);
          fact(
            `build box: its own bounding set ${buildBox.initial.toString(16)}, a root step's ${buildBox.step["Bnd"]?.toString(16)}`,
          );
          expect(buildBox.step["Bnd"]).toBe(buildBox.initial & build);
          expect(buildBox.step["Eff"]).toBe(buildBox.initial & build);
          expect((buildBox.step["Eff"]! >> CAP_BITS["setuid"]!) & 1n).toBe(1n);
          expect((buildBox.step["Eff"]! >> CAP_BITS["net_admin"]!) & 1n).toBe(0n);
          expect((buildBox.step["Eff"]! >> CAP_BITS["net_raw"]!) & 1n).toBe(0n);
          const lists = spawned
            .filter(
              (cmd) => cmd[1] === "exec" && cmd.some((part) => part.startsWith("dipo-build-")),
            )
            .flatMap((cmd) => cmd.filter((part) => part.startsWith("--bounding-set=")))
            .filter((list) => list !== boundingSet([]));
          expect(new Set(lists)).toEqual(new Set([boundingSet(BUILD_ROOT_CAPABILITIES)]));
        }
      },
      TIMEOUT_MS,
    );

    it(
      "refuses every other command as root, gives a step's arguments no capability, and fails a fixed step that needs setuid",
      async () => {
        await withBox(async (name) => {
          // A command outside the fixed list, asked for as root, is refused before it reaches the box.
          const before = spawned.length;
          const asked: (readonly [string, ...string[]])[] = [
            ["/usr/bin/id", "-u"],
            ["/bin/sh", "-c", `${partModeCommand().join(" ")}`],
            ["/usr/bin/env", ...partModeCommand()],
            ["/bin/chmod", "4755", DIPO_PART_PATH],
            ["/bin/chmod", "0755", DIPO_PART_PATH, "--bounding-set=+setuid"],
            rootStepCommand(partModeCommand()),
            buildRootStepCommand(partModeCommand()),
            netToolCommand("setpriv", ["--bounding-set=+setuid", "--", ...partModeCommand()]),
          ];
          for (const command of asked) {
            const outcome = await boxes
              .exec(name, command, { rootStep: true })
              .then(() => "ran")
              .catch((error: unknown) =>
                error instanceof BoxError ? error.code : `other: ${String(error)}`,
              );
            expect(outcome).toBe("box.refused");
          }
          expect(spawned.length).toBe(before);

          // Fail closed: as a fixed root step, dropping to another user needs setuid, and fails.
          const drop = netToolCommand("setpriv", ["--reuid=1000", "--", "/usr/bin/id", "-u"]);
          const fixedDrop = await inspect(name, rootStepCommand(drop));
          fact(
            `a fixed root step that needs setuid: exit ${fixedDrop.code}: ${fixedDrop.stderr.trim()}`,
          );
          expect(fixedDrop.code).not.toBe(0);
          expect(fixedDrop.stdout.trim()).not.toBe("1000");
          // The same command with the build box's list, in the same box, goes through: what fails
          // is the list, nothing else.
          const buildDrop = await inspect(name, buildRootStepCommand(drop));
          expect(buildDrop).toMatchObject({ code: 0 });
          expect(buildDrop.stdout.trim()).toBe("1000");

          // A step's arguments cannot add a capability: setpriv asked for setuid from inside a
          // fixed step gets none, so the drop still fails.
          const regain = await inspect(
            name,
            rootStepCommand(
              netToolCommand("setpriv", [
                "--bounding-set=+setuid",
                "--inh-caps=+setuid",
                "--ambient-caps=+setuid",
                "--reuid=1000",
                "--",
                "/usr/bin/id",
                "-u",
              ]),
            ),
          );
          fact(
            `a fixed root step asking setpriv for setuid: exit ${regain.code}: ${regain.stderr.trim()}`,
          );
          expect(regain.code).not.toBe(0);
          // Asked to add to its bounding set, setpriv either fails or runs with the fixed list only.
          const widened = await inspect(
            name,
            rootStepCommand(
              netToolCommand("setpriv", [
                "--bounding-set=+setuid,+net_admin",
                "--",
                "/bin/grep",
                "^Cap",
                "/proc/self/status",
              ]),
            ),
          );
          fact(
            `a fixed root step asking setpriv for a wider bounding set: exit ${widened.code}: ${widened.stderr.trim()}`,
          );
          if (widened.code === 0) {
            const status = capSets(widened.stdout);
            expect(status["Bnd"]! & ~maskOf(ROOT_STEP_CAPABILITIES)).toBe(0n);
            expect(status["Eff"]! & ~maskOf(ROOT_STEP_CAPABILITIES)).toBe(0n);
          } else {
            expect(widened.stdout).not.toContain("Cap");
          }

          // The box user never gains a capability, from a fixed step or around it.
          const user = capSets(
            (await boxes.exec(name, ["/bin/grep", "^Cap", "/proc/self/status"])).stdout,
          );
          expect(user["Bnd"]).toBe(0n);
          expect(user["Eff"]).toBe(0n);
          expect(user["Prm"]).toBe(0n);
          // Nor root back through setpriv.
          const userRoot = await boxes.exec(
            name,
            netToolCommand("setpriv", ["--reuid=0", "--", "/usr/bin/id", "-u"]),
          );
          expect(userRoot.code).not.toBe(0);
          // No root step ran with the build box's list here.
          expect(
            rootStepLists(name).filter((list) => list !== boundingSet(ROOT_STEP_CAPABILITIES)),
          ).toEqual([]);
        });
      },
      TIMEOUT_MS,
    );
  });
}
