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
// - The build fails when git ends up in the image (0021 decision 4).
// - dipo writes the build file itself (`boxBuildFile`), in a folder it made, and builds it with the
//   box backend. A build file in the repository is never read.
// - The image tag is a sha256 of that build file, which is made from the image description alone:
//   an unchanged description reuses its image, a changed one builds a new one.
// - The build reaches the network only through dipo's proxy (`BoxBuildProxy`): its address is a
//   build argument, and Safe-Chain's CA bundle is a file in the build folder, mounted only during
//   the npm step and never part of the image. npm installs (Claude Code, Bun, pnpm, Yarn) go to
//   the registry through Safe-Chain.
// - Claude Code's auto-update and nonessential traffic are off in the image (0021 section 4).

import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { configError } from "@dipsaus-orchestrator/contract";

import { OFFICE_FILE, resolveOfficeConfig } from "../config/load";
import type { ConfigError } from "../config/load";
import type { OfficeBoxSection } from "../config/schema";
import type { GitSession, OfficeGit } from "../git/office";
import { isCertificateBundle } from "../sandbox/safe-chain-proxy";
import { type BoxTool, type DetectedBoxToolchain, detectBoxToolchain } from "../scan/detect/box";
import { detect } from "../scan/detect/detect";
import { BUN_VERSION_FILE, LOCKFILES, ROOT_MANIFEST, RUNTIME_FILES } from "../scan/detect/manifest";
import type { Probe } from "../scan/detect/types";
import { BUILD_PROXY_ARG } from "./apple-args";
import {
  BOX_BUILD_CA_FILE,
  BOX_BUILD_FILE,
  BOX_IMAGE_REPOSITORY,
  BoxError,
  type BoxCallOptions,
  type BoxPort,
} from "./port";

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

/** The whole box of an office: its image and the files outside git a box may get. */
export interface BoxDescription {
  readonly image: BoxImageDescription;
  readonly files: readonly BoxFileEntry[];
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
  };
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
    if (!PACKAGE.test(name) || name.split("=")[0] === "git") {
      refuse(`${JSON.stringify(name)} is not a Debian package a box may get.`, { name });
    }
  }
  return image;
}

/** One RUN step: its commands joined so the shell stops at the first failure. */
function run(commands: readonly string[], mount?: string): string {
  const head = mount === undefined ? "RUN set -eu; \\" : `RUN ${mount} \\\n    set -eu; \\`;
  return [
    head,
    ...commands.map((command, at) => `    ${command}${at < commands.length - 1 ? "; \\" : ""}`),
  ].join("\n");
}

/** The CA bundle inside the build, only while the npm step runs. */
const CA_IN_BUILD = `/run/dipo/${BOX_BUILD_CA_FILE}`;
/** apt through the proxy; `checked` false only for the step that installs the CAs. */
const apt = (checked: boolean) =>
  `apt-get -o Acquire::https::Proxy="$${BUILD_PROXY_ARG}"${checked ? "" : " -o Acquire::https::Verify-Peer=false -o Acquire::https::Verify-Host=false"}`;

/**
 * The build file of `image`, written by dipo (never read from a repository). Pure: the same
 * description always gives the same text, so the image tag (`boxImageTag`) is a hash of it.
 */
export function boxBuildFile(image: BoxImageDescription): string {
  const { debian, toolchain, nodeSha256, packages, claudeCode } = checkImageDescription(image);
  const node = toolchain.node;
  // One case per architecture: its pinned sum, or a refusal when the description has none.
  const nodeCases = NODE_ARCHES.map((arch) => {
    const sum = nodeSha256[arch];
    return sum === undefined
      ? `${DEBIAN_ARCH[arch]}) echo "no pinned Node.js sha256 for ${arch}" >&2; exit 1 ;;`
      : `${DEBIAN_ARCH[arch]}) arch=${arch}; sum=${sum} ;;`;
  }).join(" ");
  const proxy = `"$${BUILD_PROXY_ARG}"`;
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
  return [
    "# The box image of a dipo office (0021 sections 4 and 5, DIPO-266). dipo wrote this file from",
    "# the office's box description; it never builds from a file in the repository.",
    `FROM docker.io/library/debian:${debian}-slim`,
    "",
    "# dipo's proxy, the build's only way out: registries through Safe-Chain, other hosts on the",
    "# public internet only. Safe-Chain's CA bundle is mounted for the npm step only.",
    `ARG ${BUILD_PROXY_ARG}`,
    "ARG DEBIAN_FRONTEND=noninteractive",
    "",
    "# Debian's archive over https through the proxy. The archive is signed, so the step that",
    "# installs the CA certificates may skip the TLS check that needs them; every later step checks.",
    run([
      `[ -n ${proxy} ]`,
      'for list in /etc/apt/sources.list /etc/apt/sources.list.d/*; do if [ -f "$list" ]; then sed -i "s|http://|https://|g" "$list"; fi; done',
      `${apt(false)} update`,
      `${apt(false)} install -y --no-install-recommends ca-certificates`,
      `${apt(true)} update`,
      `${apt(true)} install -y --no-install-recommends ${["curl", ...packages].join(" ")}`,
      "rm -rf /var/lib/apt/lists/*",
    ]),
    "",
    "# Node.js (with npm) from nodejs.org, checked against the sha256 dipo pins for the release.",
    run([
      `case "$(dpkg --print-architecture)" in ${nodeCases} *) echo "no pinned Node.js tarball for this architecture" >&2; exit 1 ;; esac`,
      `name="node-v${node}-linux-$arch.tar.gz"`,
      "cd /tmp",
      `curl --proxy ${proxy} -fsSLO "https://nodejs.org/dist/v${node}/$name"`,
      'echo "$sum  $name" | sha256sum -c -',
      'tar -xzf "$name" -C /usr/local --strip-components=1 --no-same-owner --exclude="*/CHANGELOG.md" --exclude="*/LICENSE" --exclude="*/README.md"',
      'rm -f "$name"',
      "node --version",
    ]),
    "",
    "# Claude Code is pinned; its auto-update and nonessential traffic are off (0021 section 4).",
    "ENV DISABLE_AUTOUPDATER=1 \\",
    "    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \\",
    "    NPM_CONFIG_UPDATE_NOTIFIER=false",
    "",
    "# Claude Code and the package managers from npm, through Safe-Chain at the pinned versions.",
    run(
      [
        `HTTPS_PROXY=${proxy} HTTP_PROXY=${proxy} NODE_EXTRA_CA_CERTS=${CA_IN_BUILD} npm install --global --no-fund --no-audit --https-proxy=${proxy} --proxy=${proxy} ${npmPackages.join(" ")}`,
        "npm cache clean --force",
        ...checks,
      ],
      `--mount=type=bind,source=${BOX_BUILD_CA_FILE},target=${CA_IN_BUILD}`,
    ),
    "",
    "# No git in a box (0021 decision 4): the build fails when any package brought it in.",
    'RUN if command -v git >/dev/null 2>&1 || dpkg -s git >/dev/null 2>&1; then echo "git is in the box image; a package pulled it in (0021 decision 4)" >&2; exit 1; fi',
    "",
  ].join("\n");
}

/** `dipo-box:<sha256 of the build file>`: the image of one description. */
export function boxImageTag(image: BoxImageDescription): string {
  const hash = createHash("sha256").update(boxBuildFile(image)).digest("hex");
  return `${BOX_IMAGE_REPOSITORY}:${hash}`;
}

/** dipo's proxy the build reaches the network through. */
export interface BoxBuildProxy {
  /** `http://<host>:<port>`, reachable from the builder. */
  readonly url: string;
  /** Safe-Chain's CA bundle (PEM certificates only), as the proxy wrote it. */
  readonly caFile: string;
}

export interface BoxImageRequest {
  readonly boxes: Pick<BoxPort, "hasImage" | "buildImage">;
  readonly image: BoxImageDescription;
  readonly proxy: BoxBuildProxy;
  /** A private folder of dipo's, outside any repository, where the build folder is made. */
  readonly scratchRoot: string;
  readonly options?: BoxCallOptions;
}

export interface BoxImageResult {
  readonly tag: string;
  /** False when an image of this description already existed and was reused. */
  readonly built: boolean;
}

/** Builds in flight, by tag: a second request for the same image waits for the first. */
const building = new Map<string, Promise<BoxImageResult>>();

async function build(request: BoxImageRequest, tag: string): Promise<BoxImageResult> {
  if (await request.boxes.hasImage(tag, request.options)) return { tag, built: false };
  const ca = await readFile(request.proxy.caFile, "utf8");
  if (!isCertificateBundle(ca)) {
    refuse("the build's CA bundle is not PEM certificates.", { caFile: request.proxy.caFile });
  }
  const contextDir = await realpath(await mkdtemp(join(request.scratchRoot, "box-build-")));
  try {
    // The folder holds only what dipo writes here: the build file and the CA bundle.
    await writeFile(join(contextDir, BOX_BUILD_FILE), boxBuildFile(request.image), {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(join(contextDir, BOX_BUILD_CA_FILE), ca, { flag: "wx", mode: 0o600 });
    await request.boxes.buildImage(
      { tag, contextDir, proxyUrl: request.proxy.url },
      request.options,
    );
    return { tag, built: true };
  } finally {
    await rm(contextDir, { recursive: true, force: true });
  }
}

/**
 * The image of `request.image`: reused when its tag exists, built once otherwise. The build has
 * the backend's build deadline (`BOX_BUILD_TIMEOUT_MS`) unless the options name another.
 */
export function ensureBoxImage(request: BoxImageRequest): Promise<BoxImageResult> {
  const tag = boxImageTag(request.image);
  const pending = building.get(tag);
  if (pending !== undefined) return pending;
  const started = build(request, tag).finally(() => building.delete(tag));
  building.set(tag, started);
  return started;
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
