// The office's box image (DIPO-266, 0021 sections 4 and 5, decisions 9 and 12): the description
// from the box block and the repository, the build file dipo writes, the tag that hashes it, the
// build through the box backend (reused when the tag exists), and the block read from the base
// branch only.

import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { ManualClock, withTempDir, withTempRepo } from "@dipsaus-orchestrator/testkit";

import { AppleContainerBoxes } from "../../src/box/apple-container";
import {
  BOX_DEFAULTS,
  boxBuildFile,
  boxImageTag,
  type BoxImageDescription,
  checkImageDescription,
  describeBox,
  ensureBoxImage,
  readBaseBoxSection,
} from "../../src/box/image";
import {
  BOX_BUILD_CA_FILE,
  BOX_BUILD_FILE,
  BOX_BUILD_TIMEOUT_MS,
  BOX_CALL_TIMEOUT_MS,
  type BoxImageBuild,
  type BoxPort,
  BoxError,
  isBoxTimedOut,
} from "../../src/box/port";
import { OfficeGit, spawnGitExec } from "../../src/git";
import { systemSpawn } from "../../src/platform/process";
import { fakeContainer } from "./fake-container";

const CA =
  "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIBATAKBggqhkjOPQQDAjA=\n-----END CERTIFICATE-----\n";
const PROXY_URL = "http://192.0.2.1:3128";

const IMAGE: BoxImageDescription = {
  debian: "trixie",
  toolchain: { node: "24.22.1", bun: "1.4.2" },
  packages: ["jq", "ripgrep"],
  claudeCode: "2.1.303",
};

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
        packages: [],
        claudeCode: BOX_DEFAULTS.claudeCode,
      },
      files: [],
    });
    expect(
      describeBox(
        {
          debian: "bookworm",
          toolchain: { bun: "1.4.2", yarn: "1.22.22" },
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
    expect(file).not.toMatch(/\bgit\b/);
  });

  it("installs Node from nodejs.org at its version, checked against the published sums", () => {
    expect(file).toContain('"https://nodejs.org/dist/v24.22.1/$name"');
    expect(file).toContain('name="node-v24.22.1-linux-$arch.tar.gz"');
    expect(file).toContain('grep "  $name\\$" SHASUMS256.txt | sha256sum -c -');
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
