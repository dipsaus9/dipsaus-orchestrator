// The image build's proxy (DIPO-271, criterion 7): it runs only for the length of a build, on the
// Mac's address on the builder's network (found as the box network's is), and it is dipo's web
// route, so the box web proxy's address rules apply to the build. An image that exists starts no
// proxy at all.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { AppleContainerBoxes } from "../../src/box/apple-container";
import { ensureImageWithBuildProxy } from "../../src/box/build-proxy";
import { boxImageTag, type BoxImageDescription, NODE_TARBALL_SHA256 } from "../../src/box/image";
import { BoxError, type BoxBuildNetwork } from "../../src/box/port";
import { checkAddress, type BoxWebRouteStart } from "../../src/box/web-proxy";
import { BUILD_HOST_ADDRESS, FakeBoxes } from "./fake-boxes";
import { fakeContainer, networkJson } from "./fake-container";

const CA =
  "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIBATAKBggqhkjOPQQDAjA=\n-----END CERTIFICATE-----\n";

const IMAGE: BoxImageDescription = {
  debian: "trixie",
  toolchain: { node: "24.22.1", bun: "1.4.2" },
  nodeSha256: NODE_TARBALL_SHA256["24.22.1"]!,
  packages: [],
  claudeCode: "2.1.303",
};

/** A build route on `network` that logs its start and stop. */
function buildRoute(dir: string, log: string[], fails?: string) {
  return async (network: BoxBuildNetwork): Promise<BoxWebRouteStart> => {
    log.push(`route on ${network.name} ${network.hostAddress}`);
    if (fails !== undefined) return { ok: false, reason: fails };
    const caFile = join(dir, "ca.pem");
    writeFileSync(caFile, CA);
    const url = `http://${network.hostAddress}:3128`;
    return {
      ok: true,
      route: {
        host: network.hostAddress,
        port: 3128,
        url,
        caFile,
        stop: async () => {
          log.push("route stopped");
        },
      },
    };
  };
}

describe("the image build's proxy", () => {
  it("starts no proxy when the office image already exists", () =>
    withTempDir(async (dir) => {
      const log: string[] = [];
      const boxes = new FakeBoxes({ log, images: [boxImageTag(IMAGE)] });
      const result = await ensureImageWithBuildProxy(
        { boxes, startRoute: buildRoute(dir, log), scratchRoot: dir },
        IMAGE,
      );
      expect(result).toEqual({ tag: boxImageTag(IMAGE), built: false });
      expect(log.some((line) => line.startsWith("route") || line === "build network")).toBe(false);
    }));

  it("runs on the builder network's host address for the length of one build only", () =>
    withTempDir(async (dir) => {
      const log: string[] = [];
      const boxes = new FakeBoxes({ log });
      const result = await ensureImageWithBuildProxy(
        { boxes, startRoute: buildRoute(dir, log), scratchRoot: dir },
        IMAGE,
      );
      expect(result).toEqual({ tag: boxImageTag(IMAGE), built: true });
      const tag = boxImageTag(IMAGE).slice(0, 16);
      expect(log).toEqual([
        `has image ${tag}`,
        "builder status stopped",
        "build network",
        `route on default ${BUILD_HOST_ADDRESS}`,
        `has image ${tag}`,
        `build ${tag} through http://${BUILD_HOST_ADDRESS}:3128`,
        "route stopped",
        "stop builder",
      ]);
    }));

  it("stops the proxy when the build fails, and builds nothing when the proxy does not start", () =>
    withTempDir(async (dir) => {
      const log: string[] = [];
      const boxes = new FakeBoxes({ log });
      boxes.buildImage = async () => {
        log.push("build failed");
        throw new BoxError("box.failed", "apt failed");
      };
      const failed = await ensureImageWithBuildProxy(
        { boxes, startRoute: buildRoute(dir, log), scratchRoot: dir },
        IMAGE,
      ).catch((error: unknown) => error);
      expect((failed as BoxError).code).toBe("box.failed");
      expect(log.slice(-3)).toEqual(["build failed", "route stopped", "stop builder"]);

      const noRoute: string[] = [];
      const refused = await ensureImageWithBuildProxy(
        {
          boxes: new FakeBoxes({ log: noRoute }),
          startRoute: buildRoute(dir, noRoute, "Safe-Chain is not installed"),
          scratchRoot: dir,
        },
        IMAGE,
      ).catch((error: unknown) => error);
      expect((refused as BoxError).code).toBe("box.buildProxyFailed");
      expect((refused as BoxError).message).toContain("Safe-Chain is not installed");
      expect(noRoute.some((line) => line.startsWith("build dipo-box"))).toBe(false);
      expect(noRoute.at(-1)).toBe("stop builder");
    }));

  it("applies the box web proxy's address rules with the builder's network as the refused one", () => {
    // The route the build gets is the box web route, with the builder network's host address as
    // its own network. Documentation addresses stand in for public ones.
    const context = {
      interfaces: [{ address: BUILD_HOST_ADDRESS, cidr: `${BUILD_HOST_ADDRESS}/24` }],
      boxHostAddress: BUILD_HOST_ADDRESS,
      publicStandIns: ["198.51.100.0/24"],
    };
    expect(checkAddress("198.51.100.7", context)).toEqual({ ok: true, connectTo: "198.51.100.7" });
    expect(checkAddress("192.0.2.30", context).ok).toBe(false);
    expect(checkAddress(BUILD_HOST_ADDRESS, context).ok).toBe(false);
  });
});

const ENV = { PATH: "/usr/bin:/bin", HOME: "/Users/someone" };
const is = (args: readonly string[], ...want: string[]) => args.join(" ") === want.join(" ");

describe("the builder network of the Apple backend", () => {
  it("starts the builder, then finds the Mac's address on the default network", async () => {
    const fake = fakeContainer((args) => {
      if (is(args, "builder", "start")) return {};
      if (is(args, "network", "list", "--format", "json")) {
        return {
          stdout: JSON.stringify([
            networkJson("dipo-boxes", "hostOnly", "192.0.2.1"),
            networkJson("default", "nat", BUILD_HOST_ADDRESS),
          ]),
        };
      }
      return undefined;
    });
    const port = new AppleContainerBoxes({
      spawn: fake.spawn,
      clock: new ManualClock(),
      env: ENV,
      cli: "/usr/local/bin/container",
    });
    expect(await port.buildNetwork()).toEqual({ name: "default", hostAddress: BUILD_HOST_ADDRESS });
    expect(fake.args()).toEqual([
      ["builder", "start"],
      ["network", "list", "--format", "json"],
    ]);
  });

  it("refuses when the default network shows no address, naming a failed builder start", async () => {
    const fake = fakeContainer((args) => {
      if (is(args, "builder", "start")) return { code: 1, stderr: "builder image missing" };
      if (is(args, "network", "list", "--format", "json")) return { stdout: "[]" };
      return undefined;
    });
    const port = new AppleContainerBoxes({ spawn: fake.spawn, clock: new ManualClock(), env: ENV });
    const error = (await port.buildNetwork().catch((e: unknown) => e)) as BoxError;
    expect(error.code).toBe("box.unreadable");
    expect(error.message).toContain("builder image missing");
  });
});
