// The office's box image (DIPO-266, 0021 sections 4 and 5, decisions 9 and 12): the description
// from the box block and the repository, the two build scripts dipo writes (DIPO-281), the tag
// that hashes them, and the block read from the base branch only. The build in a build box is in
// build-box.test.ts.

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { ManualClock, withTempRepo } from "@dipsaus-orchestrator/testkit";

import { BOX_NET_TOOLS_PATH, BOX_USER_GID, BOX_USER_UID } from "../../src/box/firewall";
import {
  BOX_DEFAULTS,
  BOX_IMAGE_ENV,
  aptPackages,
  boxBuildScripts,
  boxImageTag,
  type BoxImageDescription,
  BUILD_DIR_IN_BOX,
  BUILD_PROXY_ENV,
  buildCleanupCommand,
  checkImageDescription,
  describeBox,
  NODE_TARBALL_SHA256,
  readBaseBox,
  readBaseBoxSection,
} from "../../src/box/image";
import { BOX_BUILD_CA_FILE, BoxError } from "../../src/box/port";
import { BOX_NPM_PREFIX, BOX_ROOT_DIRS, BOX_USER_DIRS, BOX_USER_HOME } from "../../src/box/user";
import { OfficeGit, spawnGitExec } from "../../src/git";
import { systemSpawn } from "../../src/platform/process";

const IMAGE: BoxImageDescription = {
  debian: "trixie",
  toolchain: { node: "24.22.1", bun: "1.4.2" },
  nodeSha256: NODE_TARBALL_SHA256["24.22.1"]!,
  packages: ["jq", "ripgrep"],
  claudeCode: "2.1.303",
};
const ARM64_SUM = "a".repeat(64);
const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z00000266" as OfficeId;

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
      localPorts: [],
    });
    expect(
      describeBox(
        {
          debian: "bookworm",
          toolchain: { bun: "1.4.2", yarn: "1.22.22", nodeSha256: { arm64: ARM64_SUM } },
          packages: ["ripgrep", "jq"],
          claudeCode: "2.1.300",
          files: [{ path: ".env.example", noRealSecrets: true }],
          localPorts: [8080, 5432, 8080],
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
      localPorts: [5432, 8080],
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
    expect(boxBuildScripts(other.image).system).toContain(`arm64) arch=arm64; sum=${ARM64_SUM} ;;`);
    expect(boxBuildScripts(other.image).system).toContain(
      'amd64) echo "no pinned Node.js sha256 for x64" >&2; exit 1 ;;',
    );
  });

  it("refuses a Node version without a pinned or given tarball sha256", () => {
    const unknown = describeBox({ toolchain: { node: "20.0.0" } }, {}).image;
    expect(unknown.nodeSha256).toEqual({});
    const error = refused(() => boxBuildScripts(unknown));
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

describe("the build scripts (DIPO-281)", () => {
  const scripts = boxBuildScripts(IMAGE);
  const bootstrap = scripts.bootstrap.split("\n");
  const system = scripts.system.split("\n");
  const build = scripts.build.split("\n");

  it("start from the Debian slim image of the release, and take the route's address from the environment", () => {
    expect(scripts.base).toBe("docker.io/library/debian:trixie-slim");
    for (const lines of [bootstrap, system, build]) {
      expect(lines[0]).toBe("#!/bin/sh");
      expect(lines).toContain("set -eu");
      expect(lines).toContain(`proxy="\${${BUILD_PROXY_ENV}:?the build has no web route}"`);
    }
  });

  it("bootstrap only downloads and unpacks the firewall's tools: no package's install script runs", () => {
    const apt = bootstrap.filter((line) => line.includes("apt-get "));
    expect(apt).toHaveLength(2);
    for (const line of apt) expect(line).toContain('-o Acquire::https::Proxy="$proxy"');
    expect(apt[0]).toMatch(/ update$/);
    expect(apt[1]).toContain("install -y --no-install-recommends --download-only $want");
    expect(bootstrap).toContain("want=nftables");
    // Packages are unpacked with dpkg-deb, never installed with their scripts.
    expect(scripts.bootstrap).toContain('dpkg-deb -x "$deb" "$stage"');
    expect(scripts.bootstrap).not.toMatch(/\bdpkg -i\b|\bnpm\b|\bcurl\b/);
    // The tools land in the tools folder, with their libraries and loader, and must run from there.
    expect(bootstrap).toContain(`stage=/opt/dipo-stage; tools=${BOX_NET_TOOLS_PATH}`);
    expect(scripts.bootstrap).toContain('cp -L "$stage/usr/sbin/nft" "$tools/bin/nft"');
    expect(scripts.bootstrap).toContain('cp -L "$setpriv" "$tools/bin/setpriv"');
    expect(scripts.bootstrap).toContain('cp -L /usr/bin/tail "$tools/bin/tail"');
    expect(scripts.bootstrap).toContain('cp -L "$loader" "$tools/ld.so"');
    expect(scripts.bootstrap).toContain(
      'for tool in nft setpriv tail; do "$tools/ld.so" --library-path "$tools/lib" "$tools/bin/$tool" --version >/dev/null; done',
    );
    expect(scripts.bootstrap).toContain('grep -q "not found"');
  });

  it("bootstrap leaves the build folder readable for the box user, not writable (DIPO-334)", () => {
    expect(bootstrap).toContain(`chmod -R a+rX,go-w ${BUILD_DIR_IN_BOX}`);
    expect(BUILD_DIR_IN_BOX.split("/")).toHaveLength(2);
  });

  it("system installs the packages with apt through the route, checking TLS after the CA step", () => {
    expect(build.filter((line) => line.includes("apt-get "))).toEqual([]);
    const apt = system.filter((line) => line.includes("apt-get "));
    expect(apt).toHaveLength(4);
    for (const line of apt) expect(line).toContain('-o Acquire::https::Proxy="$proxy"');
    expect(apt.filter((line) => line.includes("Verify-Peer=false"))).toHaveLength(2);
    expect(apt[1]).toContain("install -y --no-install-recommends ca-certificates");
    expect(apt[3]).toContain("install -y --no-install-recommends curl git socat jq ripgrep");
    expect(apt[3]).not.toContain("Verify-Peer=false");
  });

  // DIPO-346: the box's own local repository (0008) needs git in every image, once.
  it("installs git from Debian's archive in every image and checks that it runs", () => {
    expect(build).toContain("git --version");
    const office = boxBuildScripts({ ...IMAGE, packages: ["git", "jq"] }).system.split("\n");
    const install = office.filter((line) =>
      line.includes("install -y --no-install-recommends curl"),
    );
    expect(install).toHaveLength(1);
    expect(install[0]).toEndWith("install -y --no-install-recommends curl socat git jq");
    expect(build.join("\n")).not.toContain("git is in the box image");
    // A versioned git of the office's replaces dipo's unversioned one; apt never gets both.
    expect(aptPackages(["git=1:2.47.2-0.1", "jq"])).toEqual([
      "curl",
      "socat",
      "git=1:2.47.2-0.1",
      "jq",
    ]);
    expect(aptPackages(["curl=8.14.1-2"])).toEqual(["git", "socat", "curl=8.14.1-2"]);
    expect(aptPackages([])).toEqual(["curl", "git", "socat"]);
  });

  it("system installs Node from nodejs.org at its version, checked against the sha256 dipo pins", () => {
    const sums = NODE_TARBALL_SHA256["24.22.1"]!;
    expect(scripts.system).toContain(
      'curl --proxy "$proxy" -fsSLO "https://nodejs.org/dist/v24.22.1/$name"',
    );
    expect(scripts.system).toContain('name="node-v24.22.1-linux-$arch.tar.gz"');
    expect(scripts.system).toContain(`arm64) arch=arm64; sum=${sums.arm64} ;;`);
    expect(scripts.system).toContain(`amd64) arch=x64; sum=${sums.x64} ;;`);
    expect(scripts.system).toContain('echo "$sum  $name" | sha256sum -c -');
  });

  it("system makes the box user, refusing a base image that has its ids, then its folders (DIPO-334)", () => {
    const at = (needle: string) => system.findIndex((line) => line.includes(needle));
    expect(system).toContain(
      `echo "dipo:x:${BOX_USER_UID}:${BOX_USER_GID}:dipo:${BOX_USER_HOME}:/bin/sh" >> /etc/passwd`,
    );
    expect(system).toContain(`echo "dipo:x:${BOX_USER_GID}:" >> /etc/group`);
    expect(at("cut -d: -f3 /etc/passwd")).toBeLessThan(at(">> /etc/passwd"));
    expect(system.at(-3)).toContain(`-o 0 -g 0 -m 0755`);
    expect(system.at(-3)).toContain(BOX_ROOT_DIRS.join(" "));
    expect(system.at(-2)).toContain(`-o ${BOX_USER_UID} -g ${BOX_USER_GID} -m 0755`);
    expect(system.at(-2)).toContain(BOX_USER_DIRS.join(" "));
    // Root's folders sit directly under `/`, where the box user cannot rename them.
    for (const dir of BOX_ROOT_DIRS) expect(dir.split("/")).toHaveLength(2);
  });

  it("build installs Claude Code and the package managers from npm through Safe-Chain, with Claude Code's updates off", () => {
    const npm = build.filter((line) => line.includes("npm install"));
    expect(npm).toHaveLength(1);
    expect(npm[0]).toContain(`NODE_EXTRA_CA_CERTS=${BUILD_DIR_IN_BOX}/${BOX_BUILD_CA_FILE}`);
    expect(npm[0]).toContain('--https-proxy="$proxy"');
    // Into the box user's own prefix, which its PATH names (DIPO-334).
    expect(npm[0]).toContain(` --global --prefix=${BOX_NPM_PREFIX} `);
    expect(build.indexOf(`export PATH="${BOX_NPM_PREFIX}/bin:$PATH"`)).toBeLessThan(
      build.indexOf(npm[0]!),
    );
    expect(npm[0]).toMatch(/ bun@1\.4\.2 @anthropic-ai\/claude-code@2\.1\.303$/);
    expect(build).toContain("claude --version");
    expect(build).toContain("bun --version");
    for (const [key, value] of Object.entries(BOX_IMAGE_ENV)) {
      expect(build.indexOf(`export ${key}=${value}`)).toBeLessThan(build.indexOf(npm[0]!));
    }
    expect(BOX_IMAGE_ENV).toEqual({
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      NPM_CONFIG_UPDATE_NOTIFIER: "false",
    });
    expect(
      boxBuildScripts({
        ...IMAGE,
        toolchain: { node: "24.22.1", pnpm: "12.14.0", yarn: "1.22.22" },
      }).build,
    ).toContain(" pnpm@12.14.0 yarn@1.22.22 @anthropic-ai/claude-code@2.1.303");
  });

  it("build removes the box user's npm cache; the cleanup removes dipo's build folder and the tools' copy", () => {
    expect(build.filter((line) => line !== "").at(-1)).toBe('rm -rf "$HOME/.npm"');
    expect(buildCleanupCommand()).toEqual([
      "/bin/rm",
      "-rf",
      "--",
      BUILD_DIR_IN_BOX,
      BOX_NET_TOOLS_PATH,
    ]);
  });

  it("are the same text for the same description", () => {
    expect(boxBuildScripts({ ...IMAGE })).toEqual(scripts);
  });
});

describe("the image tag", () => {
  it("is dipo-box: and the sha256 of the build scripts", () => {
    const tag = boxImageTag(IMAGE);
    const { base, bootstrap, system, build } = boxBuildScripts(IMAGE);
    expect(tag).toBe(
      `dipo-box:${new Bun.CryptoHasher("sha256")
        .update(
          `dipo box image, built in a box (DIPO-281, DIPO-334)\n${base}\n${bootstrap}\n${system}\n${build}`,
        )
        .digest("hex")}`,
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

  it("does not change with the files a box may get or the listed local ports, which are not part of the image", () => {
    const without = describeBox({}, {});
    const withFiles = describeBox(
      { files: [{ path: ".env.example", noRealSecrets: true }], localPorts: [5432] },
      {},
    );
    expect(boxImageTag(withFiles.image)).toBe(boxImageTag(without.image));
    expect(withFiles.localPorts).toEqual([5432]);
  });
});

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

  it("reads the listed local ports of a version 12 block from the base (DIPO-282)", () =>
    withTempRepo(async (repo) => {
      mkdirSync(join(repo.dir, ".dipo"));
      writeFileSync(
        join(repo.dir, ".dipo/office.yaml"),
        "version: 12\nbox: { localPorts: [8080, 5432] }\n",
      );
      const base = await repo.commitAll("base");
      await repo.git("update-ref", "refs/remotes/origin/main", base);
      // A story that lists another port changes nothing.
      await repo.git("checkout", "--quiet", "-b", "DIPO-1/story");
      writeFileSync(
        join(repo.dir, ".dipo/office.yaml"),
        "version: 12\nbox: { localPorts: [22] }\n",
      );
      await repo.commitAll("story");
      const read = await readBaseBox(officeGit(repo.dir, repo.env));
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.description.localPorts).toEqual([5432, 8080]);
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
