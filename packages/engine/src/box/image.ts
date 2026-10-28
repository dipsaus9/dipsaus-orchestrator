// The office's box image (0021 sections 4 and 5, decisions 9 and 12, DIPO-266). The office config's
// `box` block (version 9) describes it: a Debian slim release, the toolchain and its exact
// versions, extra Debian packages and a pinned Claude Code version, plus the files outside git a
// box may get. What the block leaves out is detected from the repository scan, so a new office
// needs no hand-written block.
//
// - dipo reads the block from the base branch only (`readBaseBoxSection`), so a story cannot
//   change its own box; `readBaseBox` also reads the files the toolchain detection needs from that
//   same commit.
// - The Node.js tarball is checked against a sha256 dipo pins per version (`NODE_TARBALL_SHA256`).
// - Every image has git from Debian's archive, for the box's own local repository (0008): the
//   build checks that it runs.
// - dipo writes the build's two scripts itself (`boxBuildScripts`); a build file in the repository
//   is never read. The image is built in a build box on the host-only box network and made by
//   committing that box (`build-box.ts`, DIPO-281); `container build` is not used.
// - The image tag is a sha256 of the scripts, which are made from the image description alone:
//   an unchanged description reuses its image, a changed one builds a new one.
// - The build reaches the network only through dipo's web route, as a worker box does: its address
//   is in the scripts' environment, Safe-Chain's CA bundle is a file in dipo's build folder, removed
//   before the commit. npm installs (Claude Code, Bun, pnpm, Yarn) go to the registry through
//   Safe-Chain. The install steps run contained and behind the box firewall (`firewall.ts`): the
//   Debian packages from Debian's signed archive and the pinned Node.js tarball as one of dipo's
//   root steps, everything from npm as the box user (`user.ts`, DIPO-334), whose home holds the
//   npm prefix.
// - Claude Code's auto-update and nonessential traffic are off in every command of the image's
//   boxes (`BOX_IMAGE_ENV`, 0021 section 4).
// - The block's `localPorts` (version 12, DIPO-282) is no part of the image: it says which local
//   ports of the Mac the office's boxes reach through the web route.

import { createHash } from "node:crypto";

import { configError } from "@dipsaus-orchestrator/contract";

import { OFFICE_FILE, resolveOfficeConfig } from "../config/load";
import type { ConfigError } from "../config/load";
import type { OfficeBoxSection } from "../config/schema";
import type { GitSession, OfficeGit } from "../git/office";
import { type BoxTool, type DetectedBoxToolchain, detectBoxToolchain } from "../scan/detect/box";
import { detect } from "../scan/detect/detect";
import { BUN_VERSION_FILE, LOCKFILES, ROOT_MANIFEST, RUNTIME_FILES } from "../scan/detect/manifest";
import type { Probe } from "../scan/detect/types";
import { BOX_NET_TOOLS_PATH, BOX_USER_GID, BOX_USER_UID } from "./firewall";
import { BOX_BUILD_CA_FILE, BOX_IMAGE_REPOSITORY, BoxError } from "./port";
import { BOX_NPM_PREFIX, BOX_ROOT_DIRS, BOX_USER_DIRS, BOX_USER_HOME, BOX_USER_NAME } from "./user";

/** dipo's defaults for what neither the box block nor the repository pins. */
export const BOX_DEFAULTS = {
  /** Debian 13. */
  debian: "trixie",
  /** The Claude Code release the escape probe ran from npm (tools/box-probe/RESULTS.md). */
  claudeCode: "2.1.303",
  toolchain: {
    node: "24.22.1",
    bun: "1.4.2",
    pnpm: "12.14.0",
    yarn: "1.22.22",
  },
} as const;

/** The architectures nodejs.org builds Node.js tarballs for that a box can run. */
export type NodeArch = "arm64" | "x64";
/** The sha256 of `node-v<version>-linux-<arch>.tar.gz`, per architecture. */
export type NodeSha256 = Readonly<Partial<Record<NodeArch, string>>>;

/**
 * The pinned sha256 of the Node.js tarballs dipo knows, by version: what nodejs.org's
 * SHASUMS256.txt of that release lists. The build checks the download against it, and it is part
 * of the build file, so of the tag. A Node version not listed here needs `box.toolchain.nodeSha256`
 * in the office config, or the build is refused.
 */
export const NODE_TARBALL_SHA256: Readonly<Record<string, NodeSha256>> = {
  "24.22.1": {
    arm64: "33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3",
    x64: "eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c",
  },
};

/** The toolchain of a box image: Node always (npm installs Claude Code), the rest as needed. */
export type BoxToolchain = { readonly node: string } & Partial<
  Readonly<Record<Exclude<BoxTool, "node">, string>>
>;

/** What the image is built from; its build file, and so its tag, depend on nothing else. */
export interface BoxImageDescription {
  readonly debian: string;
  readonly toolchain: BoxToolchain;
  /** The Node.js tarball's sha256 per architecture; the build refuses an architecture without one. */
  readonly nodeSha256: NodeSha256;
  /** Extra Debian packages, sorted. */
  readonly packages: readonly string[];
  readonly claudeCode: string;
}

/** A file outside git a box may get (0021 decision 9). */
export interface BoxFileEntry {
  readonly path: string;
  readonly noRealSecrets: true;
}

/**
 * The whole box of an office: its image, the files outside git a box may get, and the local ports
 * of the Mac its boxes reach through the web route (DIPO-282), sorted.
 */
export interface BoxDescription {
  readonly image: BoxImageDescription;
  readonly files: readonly BoxFileEntry[];
  readonly localPorts: readonly number[];
}

const EXACT = /^\d+\.\d+\.\d+$/;
const DEBIAN = /^[a-z0-9][a-z0-9.]*$/;
const PACKAGE = /^[a-z0-9][a-z0-9+.-]+(?:=[A-Za-z0-9.+~:-]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** The tools after Node, in the order the build file installs them. */
const NPM_TOOLS = ["bun", "pnpm", "yarn"] as const;
/** Debian's architecture name for each Node.js tarball architecture. */
const NODE_ARCHES: readonly NodeArch[] = ["arm64", "x64"];
const DEBIAN_ARCH: Readonly<Record<NodeArch, string>> = { arm64: "arm64", x64: "amd64" };

/**
 * The box of an office: each key of the committed block wins, then the version the repository
 * pins, then dipo's default. A toolchain tool is in the image when the block names it or the
 * repository needs it; Node always is. The Node tarball's sha256 comes from the block, else from
 * `NODE_TARBALL_SHA256`.
 *
 * Both inputs must come from the same base commit: `section` from `readBaseBoxSection`, and
 * `detected` from a probe of that commit (the `_base` checkout at the commit it returned), never
 * from a story's checkout or branch. `readBaseBox` reads both from one commit.
 */
export function describeBox(
  section: OfficeBoxSection | undefined,
  detected: DetectedBoxToolchain,
): BoxDescription {
  const committed = section?.toolchain ?? {};
  const toolchain: Record<string, string> = {
    node: committed.node ?? detected.node?.version ?? BOX_DEFAULTS.toolchain.node,
  };
  for (const tool of NPM_TOOLS) {
    const version = committed[tool] ?? detected[tool]?.version;
    if (version !== undefined && version !== null) toolchain[tool] = version;
    else if (detected[tool] !== undefined) toolchain[tool] = BOX_DEFAULTS.toolchain[tool];
  }
  const pinned = committed.nodeSha256;
  return {
    image: {
      debian: section?.debian ?? BOX_DEFAULTS.debian,
      toolchain: toolchain as BoxToolchain,
      nodeSha256:
        pinned !== undefined && Object.keys(pinned).length > 0
          ? (Object.fromEntries(
              Object.entries(pinned).filter(([, sum]) => sum !== undefined),
            ) as NodeSha256)
          : { ...NODE_TARBALL_SHA256[toolchain["node"]!] },
      packages: [...new Set(section?.packages ?? [])].toSorted(),
      claudeCode: section?.claudeCode ?? BOX_DEFAULTS.claudeCode,
    },
    files: section?.files ?? [],
    localPorts: sortedPorts(section),
  };
}

/** The listed local ports (DIPO-282), each once, in order; none when the block lists none. */
function sortedPorts(section: OfficeBoxSection | undefined): number[] {
  return [...new Set(section?.localPorts)].toSorted((a, b) => a - b);
}

function refuse(message: string, details: Readonly<Record<string, unknown>>): never {
  throw new BoxError("box.refused", message, false, details);
}

/**
 * Refuses a description whose values could break out of the build file. The schema already holds
 * them to these forms; this check keeps the build file safe from any other caller.
 */
export function checkImageDescription(image: BoxImageDescription): BoxImageDescription {
  if (!DEBIAN.test(image.debian)) refuse("the Debian release is not a release name.", { ...image });
  if (!EXACT.test(image.claudeCode)) {
    refuse("the Claude Code version is not an exact version.", { claudeCode: image.claudeCode });
  }
  for (const [tool, version] of Object.entries(image.toolchain)) {
    if (!(["node", ...NPM_TOOLS] as readonly string[]).includes(tool)) {
      refuse(`${JSON.stringify(tool)} is not a box tool.`, { tool });
    }
    if (typeof version !== "string" || !EXACT.test(version)) {
      refuse(`the ${tool} version is not an exact version.`, { tool, version });
    }
  }
  if (image.toolchain.yarn !== undefined && !image.toolchain.yarn.startsWith("1.")) {
    refuse("only Yarn 1 installs from npm.", { yarn: image.toolchain.yarn });
  }
  const sums = Object.entries(image.nodeSha256);
  if (sums.length === 0) {
    refuse(
      `Node.js ${image.toolchain.node} has no pinned tarball sha256; set box.toolchain.nodeSha256 in the office config.`,
      { node: image.toolchain.node },
    );
  }
  for (const [arch, sum] of sums) {
    if (!(NODE_ARCHES as readonly string[]).includes(arch) || !SHA256.test(sum ?? "")) {
      refuse(`the Node.js sha256 for ${JSON.stringify(arch)} is not a sha256.`, { arch, sum });
    }
  }
  for (const name of image.packages) {
    if (!PACKAGE.test(name)) {
      refuse(`${JSON.stringify(name)} is not a Debian package a box may get.`, { name });
    }
  }
  return image;
}

/**
 * The Debian packages every image gets besides the office's: curl for the build's downloads, and
 * git for the box's own local repository (0008).
 */
export const BASE_PACKAGES: readonly string[] = ["curl", "git"];

/** The environment variable that carries the web route's address into a build's scripts. */
export const BUILD_PROXY_ENV = "DIPO_PROXY";
/** Where a build box gets dipo's build folder: its two scripts and the Safe-Chain CA bundle. */
export const BUILD_DIR_IN_BOX = "/dipo-build";
/** The bootstrap script's name in the build folder. */
export const BUILD_BOOTSTRAP_SCRIPT = "bootstrap.sh";
/** The system script's name in the build folder (DIPO-334). */
export const BUILD_SYSTEM_SCRIPT = "system.sh";
/** The build script's name in the build folder. */
export const BUILD_STEPS_SCRIPT = "build.sh";

/**
 * The last step of a build (DIPO-334), one of dipo's root steps: dipo's build folder and the box
 * network tools' copy removed, so neither is in the image.
 */
export function buildCleanupCommand(): [string, ...string[]] {
  return ["/bin/rm", "-rf", "--", BUILD_DIR_IN_BOX, BOX_NET_TOOLS_PATH];
}

/**
 * The environment every command in a box of the office image gets (0021 section 4): Claude Code's
 * auto-update and nonessential traffic off, and npm's update notice off. An image made by commit
 * keeps its base image's settings, so dipo passes these with each command instead.
 */
export const BOX_IMAGE_ENV: Readonly<Record<string, string>> = {
  DISABLE_AUTOUPDATER: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  NPM_CONFIG_UPDATE_NOTIFIER: "false",
};

/** The CA bundle inside the build box, for the npm step. */
const CA_IN_BUILD = `${BUILD_DIR_IN_BOX}/${BOX_BUILD_CA_FILE}`;
/** apt through the web route; `checked` false only for the steps that run before the CAs exist. */
const apt = (checked: boolean) =>
  `apt-get -o Acquire::https::Proxy="$proxy"${checked ? "" : " -o Acquire::https::Verify-Peer=false -o Acquire::https::Verify-Host=false"}`;

/** A script: a comment, `set -eu`, the route's address, and its lines. */
function script(comment: readonly string[], lines: readonly string[]): string {
  return [
    "#!/bin/sh",
    ...comment.map((line) => `# ${line}`),
    "set -eu",
    `proxy="\${${BUILD_PROXY_ENV}:?the build has no web route}"`,
    ...lines,
    "",
  ].join("\n");
}

/** What an office image is built from: the base image and dipo's three scripts. */
export interface BoxBuildScripts {
  /** Debian's slim image of the release, pulled on the Mac. */
  readonly base: string;
  /**
   * The first step, with the build box's capabilities and before any package's install script
   * runs: Debian's archive lists over https through the web route, and the box network tools
   * (`firewall.ts`) extracted from Debian's packages without running their scripts, with their
   * libraries and loader, to `BOX_NET_TOOLS_PATH`. Only programs of the base image run.
   */
  readonly bootstrap: string;
  /**
   * The system steps (DIPO-334), one of dipo's root steps behind the box firewall: the CA
   * certificates, curl, git and the office's Debian packages from Debian's signed archive, Node.js
   * checked against its pinned sha256, and the box user with its folders (`user.ts`).
   */
  readonly system: string;
  /**
   * The install steps, as the box user behind the box firewall: Claude Code and the package
   * managers from npm through Safe-Chain into the box user's npm prefix, and the version checks,
   * git's among them. `buildCleanupCommand` runs after it.
   */
  readonly build: string;
}

/**
 * The bootstrap's lines (`BoxBuildScripts.bootstrap`): the box network tools extracted from
 * Debian's packages without their scripts, with their libraries and loader.
 */
function bootstrapLines(): string[] {
  const tools = BOX_NET_TOOLS_PATH;
  return [
    'for list in /etc/apt/sources.list /etc/apt/sources.list.d/*; do if [ -f "$list" ]; then sed -i "s|http://|https://|g" "$list"; fi; done',
    `${apt(false)} update`,
    "want=nftables",
    'if [ ! -x /usr/bin/setpriv ]; then want="$want setpriv"; fi',
    `${apt(false)} install -y --no-install-recommends --download-only $want`,
    `stage=/opt/dipo-stage; tools=${tools}`,
    'rm -rf "$stage" "$tools"',
    'mkdir -p "$stage" "$tools/bin" "$tools/lib"',
    'for deb in /var/cache/apt/archives/*.deb; do dpkg-deb -x "$deb" "$stage"; done',
    'setpriv=/usr/bin/setpriv; if [ ! -x "$setpriv" ]; then setpriv="$stage/usr/bin/setpriv"; fi',
    'cp -L "$stage/usr/sbin/nft" "$tools/bin/nft"',
    'cp -L "$setpriv" "$tools/bin/setpriv"',
    'cp -L /usr/bin/tail "$tools/bin/tail"',
    'multiarch="$(uname -m)-linux-gnu"',
    'libs="$stage/usr/lib/$multiarch:$stage/lib/$multiarch"',
    'for bin in "$tools"/bin/*; do',
    '  needs="$(LD_LIBRARY_PATH="$libs" ldd "$bin")"',
    '  if printf "%s\\n" "$needs" | grep -q "not found"; then echo "$bin needs a library the box lacks" >&2; exit 1; fi',
    '  for lib in $(printf "%s\\n" "$needs" | sed -n "s/.*=> \\(\\/[^ ]*\\) .*/\\1/p"); do cp -L "$lib" "$tools/lib/"; done',
    '  loader="$(printf "%s\\n" "$needs" | sed -n "s/^[[:space:]]*\\(\\/[^ ]*\\) (0x.*/\\1/p" | head -n 1)"',
    '  if [ -n "$loader" ]; then cp -L "$loader" "$tools/ld.so"; fi',
    "done",
    '[ -f "$tools/ld.so" ]',
    'for tool in nft setpriv tail; do "$tools/ld.so" --library-path "$tools/lib" "$tools/bin/$tool" --version >/dev/null; done',
    'chmod -R a+rX,go-w "$tools"',
    "# The box user reads the build folder (the CA bundle) but cannot write it (DIPO-334).",
    `chmod -R a+rX,go-w ${BUILD_DIR_IN_BOX}`,
    'rm -rf "$stage" /var/cache/apt/archives/*.deb /var/lib/apt/lists/*',
  ];
}

/**
 * The scripts of `image`, written by dipo (never read from a repository). Pure: the same
 * description always gives the same text, so the image tag (`boxImageTag`) is a hash of it.
 */
export function boxBuildScripts(image: BoxImageDescription): BoxBuildScripts {
  const { debian, toolchain, nodeSha256, packages, claudeCode } = checkImageDescription(image);
  const node = toolchain.node;
  // One case per architecture: its pinned sum, or a refusal when the description has none.
  const nodeCases = NODE_ARCHES.map((arch) => {
    const sum = nodeSha256[arch];
    return sum === undefined
      ? `${DEBIAN_ARCH[arch]}) echo "no pinned Node.js sha256 for ${arch}" >&2; exit 1 ;;`
      : `${DEBIAN_ARCH[arch]}) arch=${arch}; sum=${sum} ;;`;
  }).join(" ");
  const npmPackages = [
    ...NPM_TOOLS.flatMap((tool) =>
      toolchain[tool] === undefined ? [] : [`${tool}@${toolchain[tool]}`],
    ),
    `@anthropic-ai/claude-code@${claudeCode}`,
  ];
  const checks = [
    ...NPM_TOOLS.filter((tool) => toolchain[tool] !== undefined).map((tool) => `${tool} --version`),
    "claude --version",
  ];
  const bootstrap = script(
    [
      "The first step of a dipo office image build (DIPO-281). It runs before the box firewall, so",
      "it runs only programs of Debian's base image and no package's install script.",
    ],
    bootstrapLines(),
  );
  const system = script(
    [
      "The system steps of a dipo office image build (DIPO-281, DIPO-334). They run as root with",
      "dipo's root allow list, behind the box firewall: Debian's signed archive and Node.js only.",
    ],
    [
      "export DEBIAN_FRONTEND=noninteractive",
      "# Debian's archive is signed, so the step that installs the CA certificates may skip the TLS",
      "# check that needs them; every later step checks.",
      `${apt(false)} update`,
      `${apt(false)} install -y --no-install-recommends ca-certificates`,
      `${apt(true)} update`,
      `${apt(true)} install -y --no-install-recommends ${[...new Set([...BASE_PACKAGES, ...packages])].join(" ")}`,
      "rm -rf /var/lib/apt/lists/*",
      "# Node.js (with npm) from nodejs.org, checked against the sha256 dipo pins for the release.",
      `case "$(dpkg --print-architecture)" in ${nodeCases} *) echo "no pinned Node.js tarball for this architecture" >&2; exit 1 ;; esac`,
      `name="node-v${node}-linux-$arch.tar.gz"`,
      "cd /tmp",
      `curl --proxy "$proxy" -fsSLO "https://nodejs.org/dist/v${node}/$name"`,
      'echo "$sum  $name" | sha256sum -c -',
      'tar -xzf "$name" -C /usr/local --strip-components=1 --no-same-owner --exclude="*/CHANGELOG.md" --exclude="*/LICENSE" --exclude="*/README.md"',
      'rm -f "$name"',
      "node --version",
      ...boxUserLines(),
    ],
  );
  const build = script(
    [
      "The install steps of a dipo office image build (DIPO-281, DIPO-334). They run as the box user",
      "behind the box firewall: the web route is the only way out, registries go through Safe-Chain.",
    ],
    [
      "# Claude Code and the package managers from npm, through Safe-Chain at the pinned versions,",
      "# into the box user's prefix; Claude Code's auto-update and nonessential traffic are off",
      "# (0021 section 4).",
      ...Object.entries(BOX_IMAGE_ENV).map(([key, value]) => `export ${key}=${value}`),
      `export PATH="${BOX_NPM_PREFIX}/bin:$PATH"`,
      `HTTPS_PROXY="$proxy" HTTP_PROXY="$proxy" NODE_EXTRA_CA_CERTS=${CA_IN_BUILD} npm install --global --prefix=${BOX_NPM_PREFIX} --no-fund --no-audit --https-proxy="$proxy" --proxy="$proxy" ${npmPackages.join(" ")}`,
      "npm cache clean --force",
      ...checks,
      "# git for the box's own local repository (0008).",
      "git --version",
      'rm -rf "$HOME/.npm"',
    ],
  );
  return { base: `docker.io/library/debian:${debian}-slim`, bootstrap, system, build };
}

/**
 * The system script's lines that make the box user (DIPO-334): its uid and gid refused when the
 * base image already has them, its entries, root's folders, then the user's.
 */
function boxUserLines(): string[] {
  const user = `${BOX_USER_NAME}:x:${BOX_USER_UID}:${BOX_USER_GID}:${BOX_USER_NAME}:${BOX_USER_HOME}:/bin/sh`;
  return [
    "# The box user (DIPO-334): every untrusted command of the image's boxes runs as it.",
    `if cut -d: -f3 /etc/passwd | grep -qx ${BOX_USER_UID} || cut -d: -f3 /etc/group | grep -qx ${BOX_USER_GID}; then echo "the base image already has uid ${BOX_USER_UID} or gid ${BOX_USER_GID}" >&2; exit 1; fi`,
    `echo "${user}" >> /etc/passwd`,
    `echo "${BOX_USER_NAME}:x:${BOX_USER_GID}:" >> /etc/group`,
    `for dir in ${BOX_ROOT_DIRS.join(" ")}; do install -d -o 0 -g 0 -m 0755 "$dir"; done`,
    `for dir in ${BOX_USER_DIRS.join(" ")}; do install -d -o ${BOX_USER_UID} -g ${BOX_USER_GID} -m 0755 "$dir"; done`,
  ];
}

/** `dipo-box:<sha256 of the build scripts>`: the image of one description. */
export function boxImageTag(image: BoxImageDescription): string {
  const { base, bootstrap, system, build } = boxBuildScripts(image);
  const hash = createHash("sha256")
    .update(
      `dipo box image, built in a box (DIPO-281, DIPO-334)\n${base}\n${bootstrap}\n${system}\n${build}`,
    )
    .digest("hex");
  return `${BOX_IMAGE_REPOSITORY}:${hash}`;
}

/** The box block on the base branch, or why it cannot be read. */
export type BaseBoxSection =
  | {
      readonly ok: true;
      /** The block as committed; undefined when the base has no office file or no block. */
      readonly section: OfficeBoxSection | undefined;
      /** The base commit it was read from. */
      readonly commit: string;
    }
  | { readonly ok: false; readonly errors: readonly ConfigError[] };

/**
 * Reads the `box` block of `.dipo/office.yaml` as committed on `<remote>/<base>`, never from a
 * checkout, a story branch or `office.local.yaml`: a story cannot change its own box (0021
 * decision 12). The whole file is validated, so an entry of `box.files` without its
 * `noRealSecrets` mark is refused here. Runs one queue item of the office git.
 */
export function readBaseBoxSection(git: OfficeGit): Promise<BaseBoxSection> {
  return git.run(async (session) => {
    const { base, commit } = await baseCommit(git, session);
    const files = await filesAt(session, commit, [OFFICE_FILE]);
    return sectionFrom(files.get(OFFICE_FILE), base, commit);
  });
}

/** The whole box on the base branch, or why it cannot be read. */
export type BaseBox =
  | {
      readonly ok: true;
      readonly description: BoxDescription;
      /** What the repository at that commit asks for, with where each version came from. */
      readonly detected: DetectedBoxToolchain;
      /** The base commit both were read from. */
      readonly commit: string;
    }
  | { readonly ok: false; readonly errors: readonly ConfigError[] };

/**
 * The box of the office as `describeBox` makes it, with both of its inputs read from one base
 * commit in one queue item: the `box` block (as `readBaseBoxSection`) and the files the toolchain
 * detection reads (`package.json`, `.bun-version`, `.node-version`, `.nvmrc` and which lockfiles
 * exist). Nothing comes from a checkout, so a story cannot change its box.
 */
export function readBaseBox(git: OfficeGit): Promise<BaseBox> {
  return git.run(async (session) => {
    const { base, commit } = await baseCommit(git, session);
    const lockfiles = LOCKFILES.map(([name]) => name);
    const files = await filesAt(session, commit, [
      OFFICE_FILE,
      ROOT_MANIFEST,
      BUN_VERSION_FILE,
      ...RUNTIME_FILES,
      ...lockfiles,
    ]);
    const read = sectionFrom(files.get(OFFICE_FILE), base, commit);
    if (!read.ok) return read;
    const texts: Record<string, string> = {};
    for (const path of [ROOT_MANIFEST, BUN_VERSION_FILE, ...RUNTIME_FILES]) {
      const file = files.get(path);
      if (file?.text !== undefined) texts[path] = file.text;
    }
    const probe: Probe = {
      texts,
      lockfiles: lockfiles.filter((name) => files.get(name)?.text !== undefined),
      workspaceDirs: [],
      configImports: {},
      envFiles: [],
    };
    const detected = detectBoxToolchain(probe, detect(probe).toolchain);
    return { ok: true, description: describeBox(read.section, detected), detected, commit };
  });
}

/** The base branch and the commit `<remote>/<base>` points at (also the package cache, DIPO-267). */
export async function baseCommit(
  git: OfficeGit,
  session: GitSession,
): Promise<{ base: string; commit: string }> {
  const base = await git.resolveBaseIn(session);
  const ref = `refs/remotes/${git.settings.remote}/${base}`;
  const commit = (
    await session.ok(session.repository, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
  ).trim();
  return { base, commit };
}

/** A file at a commit: its text when it is a regular file, else only that it is not. */
export interface FileAt {
  readonly text?: string;
}

/** The files of `paths` that exist at `commit`, read from git's objects, never a checkout. */
export async function filesAt(
  session: GitSession,
  commit: string,
  paths: readonly string[],
): Promise<Map<string, FileAt>> {
  const listed = await session.ok(session.repository, [
    "ls-tree",
    "-z",
    "--full-tree",
    commit,
    "--",
    ...paths,
  ]);
  const files = new Map<string, FileAt>();
  for (const entry of listed.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const path = entry.slice(tab + 1);
    if (!paths.includes(path)) continue;
    const [mode, type, object] = entry.slice(0, tab).split(" ");
    if (type !== "blob" || (mode !== "100644" && mode !== "100755") || object === undefined) {
      files.set(path, {});
      continue;
    }
    files.set(path, { text: await session.ok(session.repository, ["cat-file", "blob", object]) });
  }
  return files;
}

/** The `box` block of the office file read at the base commit. */
function sectionFrom(file: FileAt | undefined, base: string, commit: string): BaseBoxSection {
  if (file === undefined) return { ok: true, section: undefined, commit };
  if (file.text === undefined) {
    return {
      ok: false,
      errors: [
        configError(
          OFFICE_FILE,
          "(top level)",
          "regular file",
          `the file on ${base} is not a regular file`,
        ),
      ],
    };
  }
  const result = resolveOfficeConfig({ office: file.text });
  if (!result.ok) return { ok: false, errors: result.errors };
  const section = result.config.box;
  return { ok: true, section: Object.keys(section).length === 0 ? undefined : section, commit };
}
