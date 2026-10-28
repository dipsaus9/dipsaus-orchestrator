// Safe-Chain in a box of its own (DIPO-343; 0004, 0008): what checks every package a box installs
// from a registry. Pure: the registries and the hosts Safe-Chain itself reaches, the one
// machine-wide Safe-Chain image and its scripts, and the check of a CA bundle. The box itself is
// started and checked in `safe-chain-box.ts`; dipo's web proxy sends each registry tunnel to it
// (`web-proxy.ts`).
//
// Why it looks like this (measured in DIPO-84 with Safe-Chain 1.5.12, and in DIPO-343):
// - Safe-Chain has no proxy mode. `safe-chain <manager> <args>` starts its checking proxy on the
//   box's loopback and runs the manager with `HTTPS_PROXY` pointing at it. dipo runs it with a
//   holder script in place of the manager: the holder reports `HTTPS_PROXY` and the CA bundle path,
//   then waits, so the proxy stays up for the life of the box.
// - Safe-Chain checks one ecosystem per process (`bun`: the npm registries; `pip3`: PyPI), so the
//   box runs two, and the web proxy sends each registry to its own (`SAFE_CHAIN_BOX_PORTS`). Each
//   is reached through a `socat` forwarder on the box network, since Safe-Chain listens only on the
//   box's loopback.
// - Safe-Chain sends its own traffic (the registries it checks, its malware lists) through the
//   proxy its own `HTTPS_PROXY` names: dipo's upstream listener, which reaches those hosts only.
// - The packaged binary takes its install directory from its own path, so a copy at
//   `<dir>/bin/safe-chain` keeps its CA, certificates and caches in `<dir>`: a fresh CA in each
//   box, which lives as long as dipo's web route.
// - The image is one for the whole machine, built from Debian's slim image, the box network tools
//   and the official release binary pinned by sha256, with no npm install: building it needs no
//   Safe-Chain, while building an office image does.

import { createHash } from "node:crypto";

import {
  apt,
  BOX_DEFAULTS,
  BUILD_BOOTSTRAP_SCRIPT,
  BUILD_DIR_IN_BOX,
  BUILD_STEPS_SCRIPT,
  BUILD_SYSTEM_SCRIPT,
  bootstrapLines,
  boxUserLines,
  script,
} from "./image";
import { BOX_IMAGE_REPOSITORY } from "./port";
import { BOX_USER_HOME } from "./user";

/** npm-family registries Safe-Chain 1.5 checks (bun, npm, pnpm: npmjs; yarn 1: yarnpkg). */
export const SAFE_CHAIN_NPM_HOSTS = ["registry.npmjs.org", "registry.yarnpkg.com"] as const;
/** PyPI hosts Safe-Chain 1.5 checks (pip: the index and the files). */
export const SAFE_CHAIN_PYPI_HOSTS = ["pypi.org", "files.pythonhosted.org"] as const;
/** The registries a box reaches, only through Safe-Chain. */
export const SAFE_CHAIN_REGISTRY_HOSTS: readonly string[] = [
  ...SAFE_CHAIN_NPM_HOSTS,
  ...SAFE_CHAIN_PYPI_HOSTS,
];
/** Aikido's malware lists; Safe-Chain itself fetches them, boxes never reach them. */
export const SAFE_CHAIN_MALWARE_LIST_HOST = "malware-list.aikido.dev";
/** Every host the Safe-Chain box reaches, through dipo's upstream listener only. */
export const SAFE_CHAIN_UPSTREAM_HOSTS: readonly string[] = [
  ...SAFE_CHAIN_REGISTRY_HOSTS,
  SAFE_CHAIN_MALWARE_LIST_HOST,
];
/** The only port a registry, and a host Safe-Chain reaches, is tunnelled to. */
export const SAFE_CHAIN_TLS_PORT = 443;

export type SafeChainEcosystem = "npm" | "pypi";
export const SAFE_CHAIN_ECOSYSTEMS: readonly SafeChainEcosystem[] = ["npm", "pypi"];

/** The ecosystem whose Safe-Chain checks `host` (normal form), or null for any other host. */
export function ecosystemOf(host: string): SafeChainEcosystem | null {
  const name = host.toLowerCase();
  if ((SAFE_CHAIN_NPM_HOSTS as readonly string[]).includes(name)) return "npm";
  if ((SAFE_CHAIN_PYPI_HOSTS as readonly string[]).includes(name)) return "pypi";
  return null;
}

/** The ports of the Safe-Chain box on the box network, one per ecosystem (the forwarders). */
export const SAFE_CHAIN_BOX_PORTS: Readonly<Record<SafeChainEcosystem, number>> = {
  npm: 8101,
  pypi: 8102,
};

/** The run id prefix of the Safe-Chain box: its name is `dipo-safe-chain-<id>`. */
export const SAFE_CHAIN_BOX_RUN_PREFIX = "safe-chain-";

/**
 * The Safe-Chain release in the image: the official `safe-chain-linux-arm64` binary of the GitHub
 * release, checked against its sha256 (the release's own digest), as Node.js is
 * (`NODE_TARBALL_SHA256`). 1.5.12 is the version DIPO-84 measured.
 */
export const SAFE_CHAIN_RELEASE = {
  version: "1.5.12",
  arm64Sha256: "27a9fb9290dfd27ca8724888d9b3c7ad28d0bbd3fc087db51eb6d363ac7bbc73",
} as const;

/** Where the image holds Safe-Chain: the binary, the holders and the start script, root's. */
export const SAFE_CHAIN_IMAGE_DIR = "/opt/safe-chain";
/** The start script, run in the box as the box user. */
export const SAFE_CHAIN_START_SCRIPT = `${SAFE_CHAIN_IMAGE_DIR}/start.sh`;
/** The box user's folder each start makes afresh: Safe-Chain's install, CA and temp files. */
export const SAFE_CHAIN_RUN_DIR = `${BOX_USER_HOME}/sc`;
/** Where Safe-Chain writes its CA bundle: the run folder's temp folder. */
export const SAFE_CHAIN_TMP_DIR = `${SAFE_CHAIN_RUN_DIR}/tmp`;
/** Variable the holder reads: the file it writes its report to. */
export const HOLDER_REPORT_ENV = "DIPO_SAFE_CHAIN_REPORT";

/**
 * The command Safe-Chain is started with for each ecosystem: a manager whose command needs the
 * proxy, so Safe-Chain starts it and runs the holder in the manager's place.
 */
export const SAFE_CHAIN_HOLDER_COMMANDS: Readonly<
  Record<SafeChainEcosystem, readonly [string, ...string[]]>
> = {
  npm: ["bun", "install"],
  pypi: ["pip3", "install", "dipo-safe-chain-holder"],
};

/** Largest CA bundle dipo copies out of the Safe-Chain box. */
export const CA_BUNDLE_LIMIT_BYTES = 4 * 1024 * 1024;

const CERTIFICATE_BLOCK =
  /-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+-----END CERTIFICATE-----/g;

/**
 * Pure: true when a CA bundle holds PEM certificates and nothing else but `#` comment lines (what
 * Safe-Chain writes: its CA, the certifi roots with their comments, the runtime's roots).
 */
export function isCertificateBundle(text: string): boolean {
  if (text.length === 0 || text.length > CA_BUNDLE_LIMIT_BYTES) return false;
  const normal = text.replaceAll("\r\n", "\n");
  if (normal.match(CERTIFICATE_BLOCK) === null) return false;
  return normal
    .replace(CERTIFICATE_BLOCK, "")
    .split("\n")
    .every((line) => line.trim() === "" || line.startsWith("#"));
}

/** The holder: stands in for the package manager, reports Safe-Chain's proxy and CA, and waits. */
export function holderScript(): string {
  return [
    "#!/bin/sh",
    "# dipo (DIPO-84, DIPO-343): stands in for the package manager, so Safe-Chain keeps its proxy up.",
    `report="$${HOLDER_REPORT_ENV}"`,
    `printf '%s\\n%s\\n' "$HTTPS_PROXY" "$NODE_EXTRA_CA_CERTS" > "$report.tmp" && mv "$report.tmp" "$report" || exit 1`,
    "exec tail -f /dev/null",
    "",
  ].join("\n");
}

/** How long the start script waits for one Safe-Chain process to report its proxy, in seconds. */
export const SAFE_CHAIN_START_SECONDS = 150;

/** One Safe-Chain process of the start script, with the holder in the manager's place. */
function startLines(ecosystem: SafeChainEcosystem): string[] {
  const command = SAFE_CHAIN_HOLDER_COMMANDS[ecosystem].join(" ");
  const forward = SAFE_CHAIN_BOX_PORTS[ecosystem];
  return [
    `${HOLDER_REPORT_ENV}="$dir/out/${ecosystem}" PATH="${SAFE_CHAIN_IMAGE_DIR}/holder:/usr/bin:/bin" "$dir/bin/safe-chain" ${command} < /dev/null > "$dir/${ecosystem}.log" 2>&1 &`,
    "tries=0",
    `until [ -s "$dir/out/${ecosystem}" ]; do`,
    "  tries=$((tries + 1))",
    `  if [ "$tries" -gt ${SAFE_CHAIN_START_SECONDS * 10} ]; then fail "the ${ecosystem} Safe-Chain process did not start its proxy"; fi`,
    "  sleep 0.1",
    "done",
    `port=$(sed -n 1p "$dir/out/${ecosystem}" | sed -n 's|^http://127\\.0\\.0\\.1:\\([0-9][0-9]*\\)$|\\1|p')`,
    `[ -n "$port" ] || fail "the ${ecosystem} Safe-Chain process reported no proxy on the loopback"`,
    `socat TCP-LISTEN:${forward},fork,reuseaddr TCP:127.0.0.1:"$port" &`,
  ];
}

/**
 * The start script (`SAFE_CHAIN_START_SCRIPT`), run in the box as the box user with `HTTPS_PROXY`
 * naming dipo's upstream listener: a fresh copy of Safe-Chain, its two processes with the holder,
 * a forwarder per ecosystem on `SAFE_CHAIN_BOX_PORTS`, then one ready line on stdout
 * (`{"ready":true,"bundle":...}`), or `{"ready":false,"reason":...}` and exit 1.
 */
export function safeChainStartScript(): string {
  return [
    "#!/bin/sh",
    "# dipo's Safe-Chain box (DIPO-343): Safe-Chain for npm and PyPI behind dipo's web proxy.",
    "set -eu",
    'fail() { printf \'{"ready":false,"reason":"%s"}\\n\' "$1"; exit 1; }',
    '[ -n "${HTTPS_PROXY:-}" ] || fail "no upstream proxy"',
    `dir="${SAFE_CHAIN_RUN_DIR}"`,
    'rm -rf "$dir"',
    'mkdir -p "$dir/bin" "$dir/out" "$dir/tmp"',
    `cp ${SAFE_CHAIN_IMAGE_DIR}/bin/safe-chain "$dir/bin/safe-chain"`,
    'export TMPDIR="$dir/tmp"',
    // One after the other: the first makes the CA in the install folder, the second loads it.
    ...SAFE_CHAIN_ECOSYSTEMS.flatMap(startLines),
    'bundle=$(sed -n 2p "$dir/out/npm")',
    'case "$bundle" in "$dir/tmp/"*) ;; *) fail "Safe-Chain named no CA bundle in its temp folder" ;; esac',
    'printf \'{"ready":true,"bundle":"%s"}\\n\' "$bundle"',
    "wait",
    "",
  ].join("\n");
}

/** The files of the Safe-Chain image's build folder, besides the three scripts. */
export const SAFE_CHAIN_BUILD_FILES = {
  start: "start.sh",
  holder: "holder.sh",
} as const;

/** What the Safe-Chain image is built from: the base image and every file of the build folder. */
export interface SafeChainBuildPlan {
  readonly base: string;
  /** The build folder's files by name; the three scripts among them. */
  readonly files: Readonly<Record<string, string>>;
}

/**
 * The Safe-Chain image's build (DIPO-343), pure: the bootstrap of every box image (the box network
 * tools), then as a root step behind the box firewall Debian's CA certificates, curl and socat,
 * the pinned release binary checked against its sha256, the holders, the start script and the box
 * user; then as the box user the version check. No npm install, so no Safe-Chain is needed.
 */
export function safeChainBuildPlan(): SafeChainBuildPlan {
  const { version, arm64Sha256 } = SAFE_CHAIN_RELEASE;
  const url = `https://github.com/AikidoSec/safe-chain/releases/download/${version}/safe-chain-linux-arm64`;
  const bootstrap = script(
    [
      "The first step of dipo's Safe-Chain image build (DIPO-343). It runs before the box firewall,",
      "so it runs only programs of Debian's base image and no package's install script.",
    ],
    bootstrapLines(),
  );
  const system = script(
    [
      "The system steps of dipo's Safe-Chain image build (DIPO-343), as root with dipo's root allow",
      "list behind the box firewall: Debian's signed archive and the pinned Safe-Chain binary only.",
    ],
    [
      "export DEBIAN_FRONTEND=noninteractive",
      `${apt(false)} update`,
      `${apt(false)} install -y --no-install-recommends ca-certificates`,
      `${apt(true)} update`,
      `${apt(true)} install -y --no-install-recommends curl socat`,
      "rm -rf /var/lib/apt/lists/*",
      `case "$(dpkg --print-architecture)" in arm64) sum=${arm64Sha256} ;; *) echo "no pinned Safe-Chain binary for this architecture" >&2; exit 1 ;; esac`,
      "cd /tmp",
      `curl --proxy "$proxy" -fsSL -o safe-chain "${url}"`,
      'echo "$sum  safe-chain" | sha256sum -c -',
      `install -d -o 0 -g 0 -m 0755 ${SAFE_CHAIN_IMAGE_DIR} ${SAFE_CHAIN_IMAGE_DIR}/bin ${SAFE_CHAIN_IMAGE_DIR}/holder`,
      `install -o 0 -g 0 -m 0755 safe-chain ${SAFE_CHAIN_IMAGE_DIR}/bin/safe-chain`,
      "rm -f safe-chain",
      ...SAFE_CHAIN_ECOSYSTEMS.map(
        (ecosystem) =>
          `install -o 0 -g 0 -m 0755 ${BUILD_DIR_IN_BOX}/${SAFE_CHAIN_BUILD_FILES.holder} ${SAFE_CHAIN_IMAGE_DIR}/holder/${SAFE_CHAIN_HOLDER_COMMANDS[ecosystem][0]}`,
      ),
      `install -o 0 -g 0 -m 0755 ${BUILD_DIR_IN_BOX}/${SAFE_CHAIN_BUILD_FILES.start} ${SAFE_CHAIN_START_SCRIPT}`,
      ...boxUserLines(),
    ],
  );
  const build = script(
    ["The last step of dipo's Safe-Chain image build (DIPO-343), as the box user: the version."],
    [
      // From a copy: Safe-Chain makes its CA folder next to its own binary, which is root's.
      'check="$(mktemp -d)"',
      'mkdir "$check/bin"',
      `cp ${SAFE_CHAIN_IMAGE_DIR}/bin/safe-chain "$check/bin/safe-chain"`,
      `"$check/bin/safe-chain" --version | grep -F "${version}"`,
      'rm -rf "$check"',
      "if command -v git >/dev/null 2>&1; then echo 'git is in the Safe-Chain image' >&2; exit 1; fi",
    ],
  );
  return {
    base: `docker.io/library/debian:${BOX_DEFAULTS.debian}-slim`,
    files: {
      [BUILD_BOOTSTRAP_SCRIPT]: bootstrap,
      [BUILD_SYSTEM_SCRIPT]: system,
      [BUILD_STEPS_SCRIPT]: build,
      [SAFE_CHAIN_BUILD_FILES.start]: safeChainStartScript(),
      [SAFE_CHAIN_BUILD_FILES.holder]: holderScript(),
    },
  };
}

/** `dipo-box:<sha256 of the Safe-Chain build plan>`: the one Safe-Chain image of this dipo. */
export function safeChainImageTag(plan: SafeChainBuildPlan = safeChainBuildPlan()): string {
  const hash = createHash("sha256").update("dipo Safe-Chain image (DIPO-343)\n").update(plan.base);
  for (const name of Object.keys(plan.files).toSorted()) {
    hash.update(`\n${name}\n${plan.files[name] ?? ""}`);
  }
  return `${BOX_IMAGE_REPOSITORY}:${hash.digest("hex")}`;
}
