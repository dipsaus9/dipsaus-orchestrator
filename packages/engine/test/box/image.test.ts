// The office's box image (DIPO-266, 0021 sections 4 and 5, decisions 9 and 12): the description
// from the box block and the repository, the build file dipo writes, the tag that hashes it, the
// build through the box backend (reused when the tag exists), the image builder stopped again after
// a build that started it (DIPO-298), and the block read from the base branch only.

import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { ManualClock, withTempDir, withTempRepo } from "@dipsaus-orchestrator/testkit";

import { AppleContainerBoxes, builderIsRunning } from "../../src/box/apple-container";
import { ensureImageWithBuildProxy } from "../../src/box/build-proxy";
import {
  BOX_DEFAULTS,
  boxBuildFile,
  boxImageTag,
  type BoxImageDescription,
  checkImageDescription,
  describeBox,
  ensureBoxImage,
  NODE_TARBALL_SHA256,
  readBaseBox,
  readBaseBoxSection,
  withImageBuilder,
} from "../../src/box/image";
import {
  BOX_BUILD_CA_FILE,
  BOX_BUILD_FILE,
  BOX_BUILD_TIMEOUT_MS,
  BOX_CALL_TIMEOUT_MS,
  type BoxBuildNetwork,
  type BoxImageBuild,
  type BoxPort,
  BoxError,
  isBoxTimedOut,
} from "../../src/box/port";
import { OfficeGit, spawnGitExec } from "../../src/git";
import { systemSpawn } from "../../src/platform/process";
import type { BoxWebRouteStart } from "../../src/box/web-proxy";
import { boxJson, type CliReply, fakeContainer, networkJson } from "./fake-container";

const CA =
  "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIBATAKBggqhkjOPQQDAjA=\n-----END CERTIFICATE-----\n";
const PROXY_URL = "http://192.0.2.1:3128";

const IMAGE: BoxImageDescription = {
  debian: "trixie",
  toolchain: { node: "24.22.1", bun: "1.4.2" },
  nodeSha256: NODE_TARBALL_SHA256["24.22.1"]!,
  packages: ["jq", "ripgrep"],
  claudeCode: "2.1.303",
};
const ARM64_SUM = "a".repeat(64);

function refused(build: () => unknown): BoxError {
  try {
    build();
  } catch (error) {
    expect(error).toBeInstanceOf(BoxError);
    expect((error as BoxError).code).toBe("box.refused");
    return error as BoxError;
  }
  throw new Error("expected a refusal");
}

describe("the box description", () => {
  it("takes each key of the box block first, then the repository's pin, then dipo's default", () => {
    const detected = {
      node: { version: "22.12.0", evidence: ".nvmrc" },
      bun: { version: "1.3.0", evidence: ".bun-version" },
      pnpm: { version: null, evidence: "pnpm is the package manager; no exact version" },
    };
    expect(describeBox(undefined, detected)).toEqual({
      image: {
        debian: BOX_DEFAULTS.debian,
        toolchain: { node: "22.12.0", bun: "1.3.0", pnpm: BOX_DEFAULTS.toolchain.pnpm },
        // dipo pins no sum for 22.12.0: the build file refuses it unless the block gives one.
        nodeSha256: {},
        packages: [],
        claudeCode: BOX_DEFAULTS.claudeCode,
      },
      files: [],
    });
    expect(
      describeBox(
        {
          debian: "bookworm",
          toolchain: { bun: "1.4.2", yarn: "1.22.22", nodeSha256: { arm64: ARM64_SUM } },
          packages: ["ripgrep", "jq"],
          claudeCode: "2.1.300",
          files: [{ path: ".env.example", noRealSecrets: true }],
        },
        detected,
      ),
    ).toEqual({
      image: {
        debian: "bookworm",
        toolchain: {
          node: "22.12.0",
          bun: "1.4.2",
          pnpm: BOX_DEFAULTS.toolchain.pnpm,
          yarn: "1.22.22",
        },
        nodeSha256: { arm64: ARM64_SUM },
        packages: ["jq", "ripgrep"],
        claudeCode: "2.1.300",
      },
      files: [{ path: ".env.example", noRealSecrets: true }],
    });
  });

  it("always has Node, and only the tools the repository or the block asks for", () => {
    expect(describeBox({}, {}).image.toolchain).toEqual({ node: BOX_DEFAULTS.toolchain.node });
    expect(describeBox({ toolchain: { node: "20.0.0" } }, {}).image.toolchain).toEqual({
      node: "20.0.0",
    });
  });

  it("pins the default Node version's tarball sums, and takes the block's for another version", () => {
    expect(NODE_TARBALL_SHA256[BOX_DEFAULTS.toolchain.node]).toEqual({
      arm64: expect.stringMatching(/^[0-9a-f]{64}$/),
      x64: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(describeBox({}, {}).image.nodeSha256).toEqual(
      NODE_TARBALL_SHA256[BOX_DEFAULTS.toolchain.node]!,
    );
    const other = describeBox(
      { toolchain: { node: "20.0.0", nodeSha256: { arm64: ARM64_SUM } } },
      {},
    );
    expect(other.image.nodeSha256).toEqual({ arm64: ARM64_SUM });
    expect(boxBuildFile(other.image)).toContain(`arm64) arch=arm64; sum=${ARM64_SUM} ;;`);
    expect(boxBuildFile(other.image)).toContain(
      'amd64) echo "no pinned Node.js sha256 for x64" >&2; exit 1 ;;',
    );
  });

  it("refuses a Node version without a pinned or given tarball sha256", () => {
    const unknown = describeBox({ toolchain: { node: "20.0.0" } }, {}).image;
    expect(unknown.nodeSha256).toEqual({});
    const error = refused(() => boxBuildFile(unknown));
    expect(error.message).toContain("box.toolchain.nodeSha256");
    refused(() => checkImageDescription({ ...IMAGE, nodeSha256: { arm64: "abc" } }));
    refused(() =>
      checkImageDescription({
        ...IMAGE,
        nodeSha256: { riscv64: ARM64_SUM } as BoxImageDescription["nodeSha256"],
      }),
    );
  });

  it("refuses values that could break out of the build file", () => {
    refused(() => checkImageDescription({ ...IMAGE, debian: "trixie-slim\nRUN id" }));
    refused(() => checkImageDescription({ ...IMAGE, claudeCode: "latest" }));
    refused(() => checkImageDescription({ ...IMAGE, packages: ["jq; id"] }));
    refused(() => checkImageDescription({ ...IMAGE, packages: ["git"] }));
    refused(() => checkImageDescription({ ...IMAGE, toolchain: { node: "24" } }));
    refused(() =>
      checkImageDescription({ ...IMAGE, toolchain: { node: "24.0.0", yarn: "4.1.0" } }),
    );
    refused(() =>
      checkImageDescription({
        ...IMAGE,
        toolchain: { node: "24.0.0", deno: "2.0.0" } as BoxImageDescription["toolchain"],
      }),
    );
    expect(checkImageDescription(IMAGE)).toBe(IMAGE);
  });
});

describe("the build file", () => {
  const file = boxBuildFile(IMAGE);
  const lines = file.split("\n");

  it("starts from the Debian slim image of the release, and takes only the proxy as an argument", () => {
    expect(lines.filter((line) => line.startsWith("FROM "))).toEqual([
      "FROM docker.io/library/debian:trixie-slim",
    ]);
    expect(lines.filter((line) => line.startsWith("ARG "))).toEqual([
      "ARG DIPO_PROXY",
      "ARG DEBIAN_FRONTEND=noninteractive",
    ]);
  });

  it("copies nothing in: the CA bundle is mounted for the npm step only", () => {
    expect(lines.filter((line) => /^(COPY|ADD) /.test(line))).toEqual([]);
    const mounts = lines.filter((line) => line.includes("--mount="));
    expect(mounts).toEqual([
      `RUN --mount=type=bind,source=${BOX_BUILD_CA_FILE},target=/run/dipo/${BOX_BUILD_CA_FILE} \\`,
    ]);
  });

  it("installs the packages with apt through the proxy, checking TLS after the CA step", () => {
    const apt = lines.filter((line) => line.includes("apt-get "));
    expect(apt).toHaveLength(4);
    for (const line of apt) expect(line).toContain('-o Acquire::https::Proxy="$DIPO_PROXY"');
    expect(apt.filter((line) => line.includes("Verify-Peer=false"))).toHaveLength(2);
    expect(apt[1]).toContain("install -y --no-install-recommends ca-certificates");
    expect(apt[3]).toContain("install -y --no-install-recommends curl jq ripgrep");
    expect(apt[3]).not.toContain("Verify-Peer=false");
  });

  it("fails the build in its last step when any package brought git in", () => {
    const steps = file.trimEnd().split("\n\n");
    expect(steps.at(-1)?.split("\n").at(-1)).toBe(
      'RUN if command -v git >/dev/null 2>&1 || dpkg -s git >/dev/null 2>&1; then echo "git is in the box image; a package pulled it in (0021 decision 4)" >&2; exit 1; fi',
    );
    // git is never asked for: only the check names it.
    expect(lines.filter((line) => /\bgit\b/.test(line))).toHaveLength(2);
  });

  it("installs Node from nodejs.org at its version, checked against the sha256 dipo pins", () => {
    const sums = NODE_TARBALL_SHA256["24.22.1"]!;
    expect(file).toContain('"https://nodejs.org/dist/v24.22.1/$name"');
    expect(file).toContain('name="node-v24.22.1-linux-$arch.tar.gz"');
    expect(file).toContain(`arm64) arch=arm64; sum=${sums.arm64} ;;`);
    expect(file).toContain(`amd64) arch=x64; sum=${sums.x64} ;;`);
    expect(file).toContain('echo "$sum  $name" | sha256sum -c -');
    expect(file).not.toContain("SHASUMS256");
  });

  it("installs Claude Code and the package managers from npm through Safe-Chain at the pinned versions", () => {
    const npm = lines.filter((line) => line.includes("npm install"));
    expect(npm).toHaveLength(1);
    expect(npm[0]).toContain(`NODE_EXTRA_CA_CERTS=/run/dipo/${BOX_BUILD_CA_FILE}`);
    expect(npm[0]).toContain('--https-proxy="$DIPO_PROXY"');
    expect(npm[0]).toContain('HTTPS_PROXY="$DIPO_PROXY"');
    expect(npm[0]).toMatch(/ bun@1\.4\.2 @anthropic-ai\/claude-code@2\.1\.303; \\$/);
    expect(file).toContain("    claude --version");
    expect(file).toContain("    bun --version");
    expect(
      boxBuildFile({ ...IMAGE, toolchain: { node: "24.22.1", pnpm: "12.14.0", yarn: "1.22.22" } }),
    ).toContain(" pnpm@12.14.0 yarn@1.22.22 @anthropic-ai/claude-code@2.1.303");
  });

  it("turns off Claude Code's auto-update and nonessential traffic in the image", () => {
    const env = file.slice(file.indexOf("ENV "), file.indexOf("\n\n", file.indexOf("ENV ")));
    expect(env).toContain("DISABLE_AUTOUPDATER=1");
    expect(env).toContain("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1");
    // Set before the install, so no step of the build updates or reports either.
    expect(file.indexOf("ENV ")).toBeLessThan(file.indexOf("npm install"));
  });

  it("is the same text for the same description", () => {
    expect(boxBuildFile({ ...IMAGE })).toBe(file);
  });
});

describe("the image tag", () => {
  it("is dipo-box: and the sha256 of the build file", () => {
    const tag = boxImageTag(IMAGE);
    expect(tag).toMatch(/^dipo-box:[0-9a-f]{64}$/);
    expect(tag).toBe(
      `dipo-box:${new Bun.CryptoHasher("sha256").update(boxBuildFile(IMAGE)).digest("hex")}`,
    );
  });

  it("stays for an unchanged description and changes with every part of it", () => {
    const tag = boxImageTag(IMAGE);
    expect(boxImageTag({ ...IMAGE, toolchain: { ...IMAGE.toolchain } })).toBe(tag);
    const changed: BoxImageDescription[] = [
      { ...IMAGE, debian: "bookworm" },
      { ...IMAGE, toolchain: { ...IMAGE.toolchain, node: "24.22.0" } },
      { ...IMAGE, toolchain: { ...IMAGE.toolchain, bun: "1.4.3" } },
      { ...IMAGE, toolchain: { node: "24.22.1" } },
      { ...IMAGE, toolchain: { ...IMAGE.toolchain, pnpm: "12.14.0" } },
      { ...IMAGE, packages: ["jq"] },
      { ...IMAGE, claudeCode: "2.1.304" },
      { ...IMAGE, nodeSha256: { ...IMAGE.nodeSha256, arm64: ARM64_SUM } },
    ];
    const tags = changed.map(boxImageTag);
    expect(new Set([tag, ...tags]).size).toBe(changed.length + 1);
  });

  it("does not change with the files a box may get, which are not part of the image", () => {
    const without = describeBox({}, {});
    const withFiles = describeBox({ files: [{ path: ".env.example", noRealSecrets: true }] }, {});
    expect(boxImageTag(withFiles.image)).toBe(boxImageTag(without.image));
  });
});

/** A box backend that records builds and knows the images in `have`. */
function recordingBoxes(have: Set<string>, onBuild?: (build: BoxImageBuild) => Promise<void>) {
  const builds: { build: BoxImageBuild; files: Record<string, string> }[] = [];
  const boxes: Pick<BoxPort, "hasImage" | "buildImage"> = {
    hasImage: async (tag) => have.has(tag),
    buildImage: async (build) => {
      const files: Record<string, string> = {};
      for (const name of readdirSync(build.contextDir)) {
        files[name] = readFileSync(join(build.contextDir, name), "utf8");
      }
      builds.push({ build, files });
      await onBuild?.(build);
      have.add(build.tag);
    },
  };
  return { boxes, builds };
}

describe("building the image", () => {
  it("builds once from dipo's own folder holding only the build file and the CA bundle", () =>
    withTempDir(async (dir) => {
      const caFile = join(dir, "ca.pem");
      writeFileSync(caFile, CA);
      const scratchRoot = join(dir, "scratch");
      mkdirSync(scratchRoot);
      const { boxes, builds } = recordingBoxes(new Set());
      const request = { boxes, image: IMAGE, proxy: { url: PROXY_URL, caFile }, scratchRoot };

      expect(await ensureBoxImage(request)).toEqual({ tag: boxImageTag(IMAGE), built: true });
      expect(builds).toHaveLength(1);
      const [first] = builds;
      expect(first?.build.tag).toBe(boxImageTag(IMAGE));
      expect(first?.build.proxyUrl).toBe(PROXY_URL);
      expect(first?.build.contextDir.startsWith(`${realpathSync(scratchRoot)}/box-build-`)).toBe(
        true,
      );
      expect(first?.files).toEqual({
        [BOX_BUILD_FILE]: boxBuildFile(IMAGE),
        [BOX_BUILD_CA_FILE]: CA,
      });
      // The build folder is gone after the build.
      expect(existsSync(first!.build.contextDir)).toBe(false);

      // An unchanged description reuses the image; a changed one builds a new one.
      expect(await ensureBoxImage(request)).toEqual({ tag: boxImageTag(IMAGE), built: false });
      expect(builds).toHaveLength(1);
      const next = { ...IMAGE, claudeCode: "2.1.304" };
      expect(await ensureBoxImage({ ...request, image: next })).toEqual({
        tag: boxImageTag(next),
        built: true,
      });
      expect(builds).toHaveLength(2);
    }));

  it("builds one image for two requests of the same description at once", () =>
    withTempDir(async (dir) => {
      const caFile = join(dir, "ca.pem");
      writeFileSync(caFile, CA);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { boxes, builds } = recordingBoxes(new Set(), () => gate);
      const request = { boxes, image: IMAGE, proxy: { url: PROXY_URL, caFile }, scratchRoot: dir };
      const first = ensureBoxImage(request);
      const second = ensureBoxImage(request);
      release();
      expect(await Promise.all([first, second])).toEqual([
        { tag: boxImageTag(IMAGE), built: true },
        { tag: boxImageTag(IMAGE), built: true },
      ]);
      expect(builds).toHaveLength(1);
    }));

  it("refuses a CA bundle that is not PEM certificates and removes its folder after a failed build", () =>
    withTempDir(async (dir) => {
      const caFile = join(dir, "ca.pem");
      writeFileSync(caFile, "not a certificate\n");
      const scratchRoot = join(dir, "scratch");
      mkdirSync(scratchRoot);
      const { boxes, builds } = recordingBoxes(new Set());
      const request = { boxes, image: IMAGE, proxy: { url: PROXY_URL, caFile }, scratchRoot };
      expect(
        (await ensureBoxImage(request).catch((error: unknown) => error)) as BoxError,
      ).toMatchObject({
        code: "box.refused",
      });
      expect(builds).toEqual([]);

      writeFileSync(caFile, CA);
      const failing = recordingBoxes(new Set(), async () => {
        throw new BoxError("box.failed", "the build failed");
      });
      const error = await ensureBoxImage({ ...request, boxes: failing.boxes }).catch(
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({ code: "box.failed" });
      expect(readdirSync(scratchRoot)).toEqual([]);
    }));

  it("runs container build through the Apple backend with the 30-minute build deadline", () =>
    withTempDir(async (dir) => {
      const caFile = join(dir, "ca.pem");
      writeFileSync(caFile, CA);
      const fake = fakeContainer((args) =>
        args[0] === "image" ? { code: 1, stderr: "image not found" } : { hang: true },
      );
      const clock = new ManualClock();
      const boxes = new AppleContainerBoxes({
        spawn: fake.spawn,
        clock,
        env: { PATH: "/usr/bin" },
      });
      const building = ensureBoxImage({
        boxes,
        image: IMAGE,
        proxy: { url: PROXY_URL, caFile },
        scratchRoot: dir,
      }).catch((error: unknown) => error);
      for (let i = 0; i < 50 && fake.calls.length < 2; i += 1) await Bun.sleep(5);
      const [inspect, build] = fake.args();
      expect(inspect).toEqual(["image", "inspect", boxImageTag(IMAGE)]);
      expect(build?.[0]).toBe("build");
      expect(build?.slice(1, 3)).toEqual(["--file", `${build?.at(-1)}/${BOX_BUILD_FILE}`]);
      expect(build).toContain(`DIPO_PROXY=${PROXY_URL}`);

      clock.advance(BOX_CALL_TIMEOUT_MS);
      await Bun.sleep(5);
      expect(fake.children[1]?.signals).toEqual([]);
      clock.advance(BOX_BUILD_TIMEOUT_MS - BOX_CALL_TIMEOUT_MS);
      const error = await building;
      expect(isBoxTimedOut(error)).toBe(true);
      expect(fake.children[1]?.signals).toEqual(["SIGKILL"]);
    }));

  it("keeps the end of a failed build's output in its error", async () => {
    const output = Array.from({ length: 100 }, (_, at) => `step ${at}`).join("\n");
    const fake = fakeContainer(() => ({ code: 1, stderr: output }));
    const boxes = new AppleContainerBoxes({
      spawn: fake.spawn,
      clock: new ManualClock(),
      env: { PATH: "/usr/bin" },
    });
    const error = await boxes
      .buildImage({ tag: boxImageTag(IMAGE), contextDir: "/tmp/d266/ctx", proxyUrl: PROXY_URL })
      .catch((caught: unknown) => caught as BoxError);
    expect(error).toMatchObject({ code: "box.failed" });
    expect((error as BoxError).message).toContain("step 99");
    expect((error as BoxError).message).not.toContain("step 59\n");
  });

  it("reuses an image the backend has: container image inspect exits 0", async () => {
    const fake = fakeContainer(() => ({ code: 0, stdout: "[]" }));
    const boxes = new AppleContainerBoxes({
      spawn: fake.spawn,
      clock: new ManualClock(),
      env: { PATH: "/usr/bin" },
    });
    expect(await boxes.hasImage(boxImageTag(IMAGE))).toBe(true);
    expect(fake.args()).toEqual([["image", "inspect", boxImageTag(IMAGE)]]);
  });
});

/** `container builder status --format json` of a builder in `state`, as `container list` shows it. */
function builderJson(state: string): string {
  return JSON.stringify([boxJson("buildkit", state)]);
}

/**
 * The Apple backend over a fake `container` for one whole image build: the image is missing, the
 * builder's status is `status`, and the build exits with `buildCode`. The builder stop is answered,
 * so a test sees whether dipo ran it.
 */
function builderWorld(status: CliReply, buildCode = 0) {
  const clock = new ManualClock();
  const fake = fakeContainer((args) => {
    const call = args.join(" ");
    if (args[0] === "image") return { code: 1, stderr: "image not found" };
    if (call === "builder status --format json") return status;
    if (call === "builder start" || call === "builder stop") return {};
    if (call === "network list --format json") {
      return { stdout: JSON.stringify([networkJson("default", "nat", "192.0.2.20")]) };
    }
    if (args[0] === "build")
      return buildCode === 0 ? {} : { code: buildCode, stderr: "apt failed" };
    return undefined;
  });
  const boxes = new AppleContainerBoxes({
    spawn: fake.spawn,
    clock,
    env: { PATH: "/usr/bin" },
  });
  return { fake, boxes, clock };
}

/** A build route on the builder's network that writes its CA bundle into `dir`. */
function buildRoute(dir: string) {
  return async (network: BoxBuildNetwork): Promise<BoxWebRouteStart> => {
    const caFile = join(dir, "route-ca.pem");
    writeFileSync(caFile, CA);
    const url = `http://${network.hostAddress}:3128`;
    return {
      ok: true,
      route: { host: network.hostAddress, port: 3128, url, caFile, stop: async () => {} },
    };
  };
}

/** The builder calls of `fake`, in order. */
function builderCalls(fake: ReturnType<typeof fakeContainer>): string[] {
  return fake
    .args()
    .filter((args) => args[0] === "builder" || args[0] === "build")
    .map((args) => (args[0] === "build" ? "build" : args.join(" ")));
}

/** A promise a test opens by hand. */
function handGate(): { opened: Promise<void>; release: () => void } {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release };
}

describe("the image builder after a build (DIPO-298)", () => {
  it("stops the builder after a build it started that passed", () =>
    withTempDir(async (dir) => {
      const { fake, boxes } = builderWorld({ stdout: builderJson("stopped") });
      const result = await ensureImageWithBuildProxy(
        { boxes, startRoute: buildRoute(dir), scratchRoot: dir },
        IMAGE,
      );
      expect(result).toEqual({ tag: boxImageTag(IMAGE), built: true });
      expect(builderCalls(fake)).toEqual([
        "builder status --format json",
        "builder start",
        "build",
        "builder stop",
      ]);
    }));

  it("stops the builder after a build it started that failed, also when no builder existed", () =>
    withTempDir(async (dir) => {
      // A builder that does not exist yet: the status call fails and prints no JSON.
      const { fake, boxes } = builderWorld({ code: 1, stderr: "builder not found" }, 1);
      const error = await ensureImageWithBuildProxy(
        { boxes, startRoute: buildRoute(dir), scratchRoot: dir },
        IMAGE,
      ).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "box.failed" });
      expect((error as BoxError).message).toContain("apt failed");
      expect(builderCalls(fake)).toEqual([
        "builder status --format json",
        "builder start",
        "build",
        "builder stop",
      ]);
    }));

  it("leaves a builder that was already running before the build running", () =>
    withTempDir(async (dir) => {
      for (const buildCode of [0, 1]) {
        const { fake, boxes } = builderWorld({ stdout: builderJson("running") }, buildCode);
        await ensureImageWithBuildProxy(
          { boxes, startRoute: buildRoute(dir), scratchRoot: dir },
          IMAGE,
        ).catch(() => undefined);
        expect(builderCalls(fake)).toEqual([
          "builder status --format json",
          "builder start",
          "build",
        ]);
      }
    }));

  it("builds and stops the builder when the status call times out", () =>
    withTempDir(async (dir) => {
      const { fake, boxes, clock } = builderWorld({ hang: true });
      const building = ensureImageWithBuildProxy(
        { boxes, startRoute: buildRoute(dir), scratchRoot: dir },
        IMAGE,
      );
      for (let i = 0; i < 50 && fake.calls.length < 2; i += 1) await Bun.sleep(5);
      expect(fake.args()[1]).toEqual(["builder", "status", "--format", "json"]);
      clock.advance(BOX_CALL_TIMEOUT_MS);
      expect(await building).toEqual({ tag: boxImageTag(IMAGE), built: true });
      expect(fake.children[1]?.signals).toEqual(["SIGKILL"]);
      expect(builderCalls(fake)).toEqual([
        "builder status --format json",
        "builder start",
        "build",
        "builder stop",
      ]);
    }));

  it("touches no builder when the image already exists", () =>
    withTempDir(async (dir) => {
      const fake = fakeContainer((args) => (args[0] === "image" ? { stdout: "[]" } : undefined));
      const boxes = new AppleContainerBoxes({
        spawn: fake.spawn,
        clock: new ManualClock(),
        env: { PATH: "/usr/bin" },
      });
      expect(
        await ensureImageWithBuildProxy(
          { boxes, startRoute: buildRoute(dir), scratchRoot: dir },
          IMAGE,
        ),
      ).toEqual({ tag: boxImageTag(IMAGE), built: false });
      expect(fake.args()).toEqual([["image", "inspect", boxImageTag(IMAGE)]]);
    }));

  it("stops the builder once, after the last of two builds at the same time", async () => {
    const log: string[] = [];
    const builder = {
      builderRunning: async () => {
        log.push("status");
        return false;
      },
      stopBuilder: async () => {
        log.push("stop");
      },
    };
    const firstGate = handGate();
    const secondGate = handGate();
    const first = withImageBuilder(builder, undefined, async () => {
      await firstGate.opened;
      log.push("first built");
    });
    const second = withImageBuilder(builder, undefined, async () => {
      await secondGate.opened;
      throw new BoxError("box.failed", "the second build failed");
    });
    firstGate.release();
    await first;
    expect(log).toEqual(["status", "first built"]);
    secondGate.release();
    expect(await second.catch((error: unknown) => error)).toMatchObject({ code: "box.failed" });
    expect(log).toEqual(["status", "first built", "stop"]);

    // The next build reads the builder's state again, and a failed stop leaves its result alone.
    const failingStop = {
      ...builder,
      stopBuilder: async () => {
        log.push("stop failed");
        throw new BoxError("box.failed", "container builder stop failed");
      },
    };
    expect(await withImageBuilder(failingStop, undefined, async () => "built")).toBe("built");
    expect(log.slice(3)).toEqual(["status", "stop failed"]);
  });

  it("reads a running builder from the status JSON, and anything else as not running", () => {
    expect(builderIsRunning([boxJson("buildkit", "running")])).toBe(true);
    expect(builderIsRunning(boxJson("buildkit", "running"))).toBe(true);
    expect(builderIsRunning({ id: "buildkit", status: "running" })).toBe(true);
    for (const value of [
      [boxJson("buildkit", "stopped")],
      [],
      {},
      null,
      "builder is not running",
      { status: { state: "stopping" } },
    ]) {
      expect(builderIsRunning(value)).toBe(false);
    }
  });

  it("reads a failed or unreadable status call as a builder that is not running", async () => {
    for (const [reply, running] of [
      [{ stdout: builderJson("running") }, true],
      [{ stdout: builderJson("stopped") }, false],
      [{ stdout: "builder is not running\n" }, false],
      [{ code: 1, stderr: "not found" }, false],
    ] as const) {
      const { fake, boxes } = builderWorld(reply);
      expect(await boxes.builderRunning()).toBe(running);
      expect(fake.args()).toEqual([["builder", "status", "--format", "json"]]);
    }
  });

  it("fails a builder stop that container refuses, with its message", async () => {
    const fake = fakeContainer(() => ({ code: 1, stderr: "builder is busy" }));
    const boxes = new AppleContainerBoxes({
      spawn: fake.spawn,
      clock: new ManualClock(),
      env: { PATH: "/usr/bin" },
    });
    const error = await boxes.stopBuilder().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "box.failed" });
    expect((error as BoxError).message).toContain("builder is busy");
    expect(fake.args()).toEqual([["builder", "stop"]]);
  });
});

const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z00000266" as OfficeId;

describe("the box block on the base branch", () => {
  const BASE_FILE = `version: 9
box:
  debian: bookworm
  packages: [jq]
  files:
    - { path: .env.example, noRealSecrets: true }
`;

  it("is read from <remote>/<base>, never from the checkout or a story's commit", () =>
    withTempRepo(async (repo) => {
      mkdirSync(join(repo.dir, ".dipo"));
      writeFileSync(join(repo.dir, ".dipo/office.yaml"), BASE_FILE);
      const base = await repo.commitAll("base");
      await repo.git("update-ref", "refs/remotes/origin/main", base);
      // A story's change, committed and in the work tree: not the base.
      await repo.git("checkout", "--quiet", "-b", "DIPO-1/story");
      writeFileSync(
        join(repo.dir, ".dipo/office.yaml"),
        "version: 9\nbox: { packages: [nmap], files: [{ path: .env, noRealSecrets: true }] }\n",
      );
      await repo.commitAll("story");
      writeFileSync(join(repo.dir, ".dipo/office.local.yaml"), "version: 9\n");

      const read = await readBaseBoxSection(officeGit(repo.dir, repo.env));
      expect(read).toEqual({
        ok: true,
        commit: base,
        section: {
          debian: "bookworm",
          packages: ["jq"],
          files: [{ path: ".env.example", noRealSecrets: true }],
        },
      });
    }));

  it("is absent when the base has no office file or no box block", () =>
    withTempRepo(async (repo) => {
      writeFileSync(join(repo.dir, "README.md"), "hello\n");
      const first = await repo.commitAll("first");
      await repo.git("update-ref", "refs/remotes/origin/main", first);
      const git = officeGit(repo.dir, repo.env);
      expect(await readBaseBoxSection(git)).toEqual({
        ok: true,
        section: undefined,
        commit: first,
      });

      mkdirSync(join(repo.dir, ".dipo"));
      writeFileSync(join(repo.dir, ".dipo/office.yaml"), "version: 9\nstoryPr: { open: false }\n");
      const second = await repo.commitAll("second");
      await repo.git("update-ref", "refs/remotes/origin/main", second);
      expect(await readBaseBoxSection(git)).toEqual({
        ok: true,
        section: undefined,
        commit: second,
      });
    }));

  it("refuses a base file whose box files entry lacks the noRealSecrets mark", () =>
    withTempRepo(async (repo) => {
      mkdirSync(join(repo.dir, ".dipo"));
      writeFileSync(
        join(repo.dir, ".dipo/office.yaml"),
        "version: 9\nbox:\n  files:\n    - { path: .env.local }\n",
      );
      const base = await repo.commitAll("base");
      await repo.git("update-ref", "refs/remotes/origin/main", base);
      const read = await readBaseBoxSection(officeGit(repo.dir, repo.env));
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.errors.map((error) => error.path)).toEqual(["box.files.0.noRealSecrets"]);
    }));

  it("describes the whole box from one base commit: the block and the toolchain files", () =>
    withTempRepo(async (repo) => {
      mkdirSync(join(repo.dir, ".dipo"));
      writeFileSync(join(repo.dir, ".dipo/office.yaml"), "version: 9\nbox: { packages: [jq] }\n");
      writeFileSync(join(repo.dir, "package.json"), JSON.stringify({ name: "repo" }));
      writeFileSync(join(repo.dir, ".bun-version"), "1.4.2\n");
      writeFileSync(join(repo.dir, "bun.lock"), "{}\n");
      const base = await repo.commitAll("base");
      await repo.git("update-ref", "refs/remotes/origin/main", base);
      // A story changes Bun and switches to pnpm: neither reaches the box.
      await repo.git("checkout", "--quiet", "-b", "DIPO-1/story");
      writeFileSync(join(repo.dir, ".bun-version"), "1.5.0\n");
      writeFileSync(join(repo.dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      await repo.commitAll("story");
      writeFileSync(join(repo.dir, ".bun-version"), "1.6.0\n");

      const read = await readBaseBox(officeGit(repo.dir, repo.env));
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.commit).toBe(base);
      expect(read.detected.bun).toEqual({ version: "1.4.2", evidence: ".bun-version" });
      expect(read.detected.pnpm).toBeUndefined();
      expect(read.description.image).toEqual({
        debian: BOX_DEFAULTS.debian,
        toolchain: { node: BOX_DEFAULTS.toolchain.node, bun: "1.4.2" },
        nodeSha256: NODE_TARBALL_SHA256[BOX_DEFAULTS.toolchain.node]!,
        packages: ["jq"],
        claudeCode: BOX_DEFAULTS.claudeCode,
      });
    }));
});

function officeGit(dir: string, env: Record<string, string>): OfficeGit {
  const real = realpathSync(dir);
  return new OfficeGit({
    officeId: OFFICE,
    mainWorktree: real,
    commonDir: join(real, ".git"),
    settings: { remote: "origin", base: "main" },
    runner: { exec: spawnGitExec(systemSpawn), env, sleep: async () => {} },
    clock: new ManualClock(),
  });
}
