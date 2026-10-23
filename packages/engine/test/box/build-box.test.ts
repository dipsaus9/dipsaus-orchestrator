// The office image built in a build box (DIPO-281, from DIPO-286), on the in-memory backend: the
// base pulled, a build box on the host-only box network with nothing mounted, the boxes' own web
// route acquired once it runs, dipo's build folder copied in, the bootstrap with the box's
// capabilities, the box firewall to the route's port only, the box network tools streamed out and
// extracted with links refused, the install steps contained, then a stop and the commit; the
// route released and the build box deleted whatever happened. An image that exists with its tools
// is reused; two requests share one build; every failure fails the build closed.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { ensureBoxImage, type BoxImageDeps } from "../../src/box/build-box";
import { NET_TOOLS_FILES, netToolsDir } from "../../src/box/firewall";
import {
  BUILD_BOOTSTRAP_SCRIPT,
  BUILD_DIR_IN_BOX,
  BUILD_PROXY_ENV,
  BUILD_STEPS_SCRIPT,
  boxBuildScripts,
  boxImageTag,
  type BoxImageDescription,
  NODE_TARBALL_SHA256,
} from "../../src/box/image";
import {
  BOX_BUILD_CA_FILE,
  BOX_BUILD_TIMEOUT_MS,
  BoxError,
  type BoxExecOptions,
} from "../../src/box/port";

import { BOX_HOST_ADDRESS, FakeBoxes, type FakeBoxesOptions, writeNetTools } from "./fake-boxes";
import { tarBytes } from "./tar-bytes";

const CA =
  "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIBATAKBggqhkjOPQQDAjA=\n-----END CERTIFICATE-----\n";
const IMAGE: BoxImageDescription = {
  debian: "trixie",
  toolchain: { node: "24.22.1", bun: "1.4.2" },
  nodeSha256: NODE_TARBALL_SHA256["24.22.1"]!,
  packages: ["jq"],
  claudeCode: "2.1.303",
};
const TAG = boxImageTag(IMAGE);
const BUILD = "dipo-build-0123456789abcdef";
const ROUTE_URL = `http://${BOX_HOST_ADDRESS}:3128`;

interface Build {
  readonly boxes: FakeBoxes;
  readonly deps: BoxImageDeps;
  readonly log: string[];
  readonly toolsRoot: string;
  /** What the route's acquire and release saw, and what each exec got. */
  readonly execs: { readonly command: readonly string[]; readonly options?: BoxExecOptions }[];
  readonly events: unknown[];
}

function build(dir: string, options: FakeBoxesOptions = {}, ca = CA): Build {
  const log: string[] = [];
  const execs: Build["execs"] = [];
  const boxes = new FakeBoxes({
    ...options,
    log,
    exec: (box, command, execOptions) => {
      execs.push({ command, ...(execOptions === undefined ? {} : { options: execOptions }) });
      return options.exec?.(box, command, execOptions);
    },
  });
  mkdirSync(dir, { recursive: true });
  const caFile = join(dir, "route-ca.pem");
  writeFileSync(caFile, ca);
  const toolsRoot = join(dir, "state", "box-net-tools");
  const events: unknown[] = [];
  const deps: BoxImageDeps = {
    boxes,
    route: {
      acquire: async (box) => {
        log.push(`acquire ${box}`);
        return { url: ROUTE_URL, caFile };
      },
      release: async (box) => {
        log.push(`release ${box}`);
      },
    },
    scratchRoot: join(dir, "scratch"),
    toolsRoot,
    clock: new ManualClock(),
    buildId: () => "0123456789abcdef",
    onEvent: (event) => events.push(event),
  };
  return { boxes, deps, log, toolsRoot, execs, events };
}

describe("building the office image in a build box (DIPO-281)", () => {
  it("builds on the box network through the boxes' web route, behind the firewall, and commits", () =>
    withTempDir(async (dir) => {
      const b = build(dir);
      const result = await ensureBoxImage(b.deps, IMAGE);
      const tools = netToolsDir(realpathSync(b.toolsRoot), TAG);
      expect(result).toEqual({ tag: TAG, built: true, netTools: tools });
      expect(b.log).toEqual([
        `has image ${TAG.slice(0, 16)}`,
        "pull docker.io/library/debian:trixie-slim",
        "network",
        `create ${BUILD}`,
        `start ${BUILD}`,
        `acquire ${BUILD}`,
        `copy in ${BUILD} ${BUILD_DIR_IN_BOX}`,
        `exec ${BUILD} /bin/sh`,
        `firewall ${BUILD} ${BOX_HOST_ADDRESS} 3128`,
        `exec live ${BUILD} tar -cf -`,
        `exec ${BUILD} /bin/sh`,
        `stop ${BUILD}`,
        `commit ${BUILD} ${TAG.slice(0, 16)}`,
        `release ${BUILD}`,
        `delete ${BUILD}`,
      ]);
      expect(b.boxes.commits).toEqual([TAG]);
      // The bootstrap alone runs with the box's capabilities; the install steps run contained.
      expect(b.execs.map((exec) => [exec.command.join(" "), exec.options?.fullPrivilege])).toEqual([
        [`/bin/sh ${BUILD_DIR_IN_BOX}/${BUILD_BOOTSTRAP_SCRIPT}`, true],
        [`/bin/sh ${BUILD_DIR_IN_BOX}/${BUILD_STEPS_SCRIPT}`, undefined],
      ]);
      for (const exec of b.execs) {
        expect(exec.options?.env).toEqual({ [BUILD_PROXY_ENV]: ROUTE_URL });
        expect(exec.options?.timeoutMs).toBe(BOX_BUILD_TIMEOUT_MS);
      }
      // The tools are on the Mac, each a regular file, for every box of the image to mount.
      for (const file of NET_TOOLS_FILES) {
        expect(readFileSync(join(tools, file), "utf8")).toBe(`fake ${file}\n`);
      }
      // Nothing of the build stays behind on the Mac but the tools.
      expect(readdirSync(join(dir, "scratch"))).toEqual([]);
      expect(readdirSync(b.toolsRoot)).toEqual([TAG.split(":")[1] ?? ""]);
    }));

  it("copies in only the two scripts and the route's CA bundle", () =>
    withTempDir(async (dir) => {
      const b = build(dir, { files: join(dir, "box-files") });
      await ensureBoxImage(b.deps, IMAGE);
      const folder = b.boxes.filesOf(BUILD, BUILD_DIR_IN_BOX);
      expect(readdirSync(folder).toSorted()).toEqual(
        [BOX_BUILD_CA_FILE, BUILD_BOOTSTRAP_SCRIPT, BUILD_STEPS_SCRIPT].toSorted(),
      );
      const scripts = boxBuildScripts(IMAGE);
      expect(readFileSync(join(folder, BUILD_BOOTSTRAP_SCRIPT), "utf8")).toBe(scripts.bootstrap);
      expect(readFileSync(join(folder, BUILD_STEPS_SCRIPT), "utf8")).toBe(scripts.build);
      expect(readFileSync(join(folder, BOX_BUILD_CA_FILE), "utf8")).toBe(CA);
    }));

  it("reuses an image that exists with its tools, and builds one that lost its tools again", () =>
    withTempDir(async (dir) => {
      const b = build(dir, { images: [TAG] });
      writeNetTools(b.toolsRoot, TAG);
      expect(await ensureBoxImage(b.deps, IMAGE)).toEqual({
        tag: TAG,
        built: false,
        netTools: netToolsDir(realpathSync(b.toolsRoot), TAG),
      });
      expect(b.log).toEqual([`has image ${TAG.slice(0, 16)}`]);

      const lost = build(join(dir, "lost"), { images: [TAG] });
      const rebuilt = await ensureBoxImage(lost.deps, IMAGE);
      expect(rebuilt.built).toBe(true);
      // The old image of the tag goes before the commit makes it again.
      expect(lost.log.indexOf(`delete image ${TAG.slice(0, 16)}`)).toBeLessThan(
        lost.log.indexOf(`commit ${BUILD} ${TAG.slice(0, 16)}`),
      );
    }));

  it("builds one image for two requests of the same description at once", () =>
    withTempDir(async (dir) => {
      const b = build(dir);
      const [first, second] = await Promise.all([
        ensureBoxImage(b.deps, IMAGE),
        ensureBoxImage(b.deps, IMAGE),
      ]);
      expect(first).toEqual(second);
      expect(b.boxes.commits).toEqual([TAG]);
    }));

  it("fails closed when a step fails: the output's end in the error, the box deleted, nothing committed", () =>
    withTempDir(async (dir) => {
      for (const script of [BUILD_BOOTSTRAP_SCRIPT, BUILD_STEPS_SCRIPT]) {
        const b = build(join(dir, script), {
          exec: (_box, command) =>
            command[1]?.endsWith(script) === true
              ? { code: 1, stdout: "Reading package lists...\n", stderr: "E: no such package\n" }
              : undefined,
        });
        const error = (await ensureBoxImage(b.deps, IMAGE).catch((e: unknown) => e)) as BoxError;
        expect(error).toBeInstanceOf(BoxError);
        expect(error.code).toBe("box.buildFailed");
        expect(error.message).toContain(`${script} failed (exit 1)`);
        expect(error.message).toContain("E: no such package");
        expect(b.boxes.commits).toEqual([]);
        expect(b.boxes.boxes.size).toBe(0);
        expect(b.log.slice(-2)).toEqual([`release ${BUILD}`, `delete ${BUILD}`]);
      }
    }));

  it("never runs an install step when the firewall cannot be set", () =>
    withTempDir(async (dir) => {
      const b = build(dir, { firewallFails: new BoxError("box.firewallFailed", "no netfilter") });
      const error = (await ensureBoxImage(b.deps, IMAGE).catch((e: unknown) => e)) as BoxError;
      expect(error.code).toBe("box.firewallFailed");
      expect(b.execs.map((exec) => exec.command[1])).toEqual([
        `${BUILD_DIR_IN_BOX}/${BUILD_BOOTSTRAP_SCRIPT}`,
      ]);
      expect(b.boxes.commits).toEqual([]);
      expect(b.boxes.boxes.size).toBe(0);
    }));

  it("refuses tools that hold a link, and a CA bundle that is not PEM certificates", () =>
    withTempDir(async (dir) => {
      const linked = build(join(dir, "linked"), {
        tools: () => ({
          bytes: tarBytes([
            { name: "bin/", type: "5", mode: 0o755 },
            { name: "ld.so", type: "0", data: "x", mode: 0o755 },
            { name: "bin/nft", type: "2", link: "/usr/sbin/nft" },
          ]),
        }),
      });
      const error = (await ensureBoxImage(linked.deps, IMAGE).catch((e: unknown) => e)) as BoxError;
      expect(error.code).toBe("box.buildFailed");
      expect(linked.boxes.commits).toEqual([]);
      expect(existsSync(netToolsDir(linked.toolsRoot, TAG))).toBe(false);
      // A tools archive without one of the tools is refused too.
      const short = build(join(dir, "short"), {
        tools: () => ({ bytes: tarBytes([{ name: "ld.so", type: "0", data: "x" }]) }),
      });
      const missing = (await ensureBoxImage(short.deps, IMAGE).catch(
        (e: unknown) => e,
      )) as BoxError;
      expect(missing.code).toBe("box.netToolsMissing");
      expect(short.boxes.commits).toEqual([]);

      const badCa = build(join(dir, "ca"), {}, "not a certificate\n");
      const caError = (await ensureBoxImage(badCa.deps, IMAGE).catch(
        (e: unknown) => e,
      )) as BoxError;
      expect(caError.code).toBe("box.buildFailed");
      expect(caError.message).toContain("CA bundle");
      expect(badCa.log).not.toContain(`copy in ${BUILD} ${BUILD_DIR_IN_BOX}`);
      expect(badCa.boxes.boxes.size).toBe(0);
    }));

  it("reports a cleanup that failed, and still fails with the build's own error", () =>
    withTempDir(async (dir) => {
      const b = build(dir, {
        exec: (_box, command) =>
          command[1]?.endsWith(BUILD_STEPS_SCRIPT) === true
            ? { code: 2, stdout: "", stderr: "x" }
            : undefined,
      });
      b.boxes.delete = async () => {
        throw new Error("container delete failed");
      };
      const error = (await ensureBoxImage(b.deps, IMAGE).catch((e: unknown) => e)) as BoxError;
      expect(error.code).toBe("box.buildFailed");
      expect(b.events).toEqual([
        {
          kind: "buildCleanupFailed",
          box: BUILD,
          step: "boxDelete",
          reason: "container delete failed",
        },
      ]);
    }));
});
