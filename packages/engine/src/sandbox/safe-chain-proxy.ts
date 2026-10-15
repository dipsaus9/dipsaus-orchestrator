// dipo's Safe-Chain checking proxy for worker installs (DIPO-84, maintainer decision 2026-10-15,
// option B). Pure: names, hosts, the proxy's own sandbox policy, the holder script and the gate's
// request rule. The processes live in `platform/safe-chain-proxy.ts` (daemon side) and
// `platform/safe-chain-gate.ts` (inside the proxy's sandbox).
//
// Why it looks like this (measured in DIPO-84 with srt 0.0.79 and Safe-Chain 1.5.12):
// - Safe-Chain has no proxy mode. `safe-chain <manager> <args>` starts its checking proxy on
//   127.0.0.1 and runs the manager with `HTTPS_PROXY` pointing at it. dipo runs it with a holder
//   script in place of the manager: the holder reports `HTTPS_PROXY` and the CA bundle path, then
//   waits on stdin, so the proxy stays up until dipo closes that stdin.
// - Safe-Chain checks one ecosystem per process (`bun`: the npm registries; `pip3`: PyPI) and
//   tunnels every other host unchecked, so dipo runs two, and the gate sends each host to its own.
// - Safe-Chain forwards a plain-HTTP request to any host, 127.0.0.1 included, and tunnels a
//   CONNECT to any host. The gate in front of it lets through only `CONNECT <registry>:443` and
//   refuses everything else, so worker traffic can reach nothing but the checked registries.
// - The packaged binary takes its install directory from its own path, so a copy at
//   `<dir>/sc/bin/safe-chain` keeps its CA, certificates and caches in `<dir>/sc`: a fresh CA per
//   proxy, and `~/.safe-chain` is never written (it is not even read inside the sandbox).
// - The worker sandbox reaches the gate only as Claude Code's `httpProxyPort`; it keeps
//   `allowLocalBinding` false, so it can connect to no other local port.

import { DENIED_SOCKET_PATHS, isAtOrUnder, type SrtSettings } from "./policy";

/** npm-family registries Safe-Chain 1.5 checks (bun, npm, pnpm: npmjs; yarn 1: yarnpkg). */
export const SAFE_CHAIN_NPM_HOSTS = ["registry.npmjs.org", "registry.yarnpkg.com"] as const;
/** PyPI hosts Safe-Chain 1.5 checks (pip: the index and the files). */
export const SAFE_CHAIN_PYPI_HOSTS = ["pypi.org", "files.pythonhosted.org"] as const;
/** The registries a worker may reach, only through the gate and Safe-Chain. */
export const SAFE_CHAIN_REGISTRY_HOSTS: readonly string[] = [
  ...SAFE_CHAIN_NPM_HOSTS,
  ...SAFE_CHAIN_PYPI_HOSTS,
];
/** Aikido's malware lists; Safe-Chain itself fetches them, workers never reach them. */
export const SAFE_CHAIN_MALWARE_LIST_HOST = "malware-list.aikido.dev";
/** Every host the proxy's sandbox may reach. */
export const SAFE_CHAIN_PROXY_HOSTS: readonly string[] = [
  ...SAFE_CHAIN_REGISTRY_HOSTS,
  SAFE_CHAIN_MALWARE_LIST_HOST,
];
/** The only port the gate forwards. */
export const SAFE_CHAIN_TLS_PORT = 443;

export type SafeChainEcosystem = "npm" | "pypi";
export const SAFE_CHAIN_ECOSYSTEMS: readonly SafeChainEcosystem[] = ["npm", "pypi"];

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

/** Where the worker's CA bundle goes, in the run's Safe-Chain shell directory. */
export const SAFE_CHAIN_CA_FILE = "ca.pem";

/** Variable the holder reads: the file it writes its report to. */
export const HOLDER_REPORT_ENV = "DIPO_SAFE_CHAIN_REPORT";

/**
 * The private (0700) parent of every proxy directory, `<root>/<random>`. Short, because macOS
 * limits Unix socket paths to about 104 bytes; one parent, so the worker sandbox denies reading
 * every proxy at once, and leftovers of a killed daemon are swept from one place.
 */
export const SAFE_CHAIN_PROXY_ROOT = "/tmp/dipo-p";

/** A proxy directory's name under the root: what `mkdtemp` makes, nothing else is swept. */
export const PROXY_DIR_NAME = /^[A-Za-z0-9]{6}$/;

/** The ecosystem whose Safe-Chain checks `host`, or null when no proxy may reach it. */
export function ecosystemOf(host: string): SafeChainEcosystem | null {
  const name = host.toLowerCase();
  if ((SAFE_CHAIN_NPM_HOSTS as readonly string[]).includes(name)) return "npm";
  if ((SAFE_CHAIN_PYPI_HOSTS as readonly string[]).includes(name)) return "pypi";
  return null;
}

/** The files of one proxy directory; every path is absolute. */
export interface SafeChainProxyLayout {
  readonly dir: string;
  /** The copied install: `bin/safe-chain`; Safe-Chain keeps its CA and caches here. */
  readonly install: string;
  readonly binary: string;
  /** The holder scripts, one per manager name; on the proxy's PATH, never writable. */
  readonly holders: string;
  /** The proxy's TMPDIR: Safe-Chain writes its CA bundle and pip config here. */
  readonly tmp: string;
  /** The proxy processes' HOME: empty, so nothing of the maintainer's home is used. */
  readonly home: string;
  /** Holder reports, one file per ecosystem. */
  readonly reports: string;
  /** The directory of the gate's Unix socket (the only file the gate makes). */
  readonly sockets: string;
  /** The gate's Unix socket; dipo's local port forwards to it. */
  readonly socket: string;
  /** The proxy's sandbox settings, a sibling so the sandbox cannot rewrite it. */
  readonly policy: string;
  /** The daemon that owns the proxy (its process id), for the sweep of leftovers. */
  readonly owner: string;
}

export function safeChainProxyLayout(dir: string): SafeChainProxyLayout {
  return {
    dir,
    install: `${dir}/sc`,
    binary: `${dir}/sc/bin/safe-chain`,
    holders: `${dir}/holder`,
    tmp: `${dir}/tmp`,
    home: `${dir}/home`,
    reports: `${dir}/out`,
    sockets: `${dir}/sock`,
    socket: `${dir}/sock/gate.sock`,
    policy: `${dir}.policy.json`,
    owner: `${dir}/owner`,
  };
}

/** The report file of one ecosystem's holder. */
export function holderReportPath(layout: SafeChainProxyLayout, ecosystem: SafeChainEcosystem) {
  return `${layout.reports}/${ecosystem}`;
}

/**
 * The holder: stands in for the package manager Safe-Chain runs. It writes Safe-Chain's proxy URL
 * and CA bundle path to its report file (atomically), then waits until its stdin closes.
 */
export function holderScript(): string {
  return [
    "#!/bin/sh",
    "# dipo (DIPO-84): stands in for the package manager, so Safe-Chain keeps its checking proxy up.",
    `report="$${HOLDER_REPORT_ENV}"`,
    `printf '%s\\n%s\\n' "$HTTPS_PROXY" "$NODE_EXTRA_CA_CERTS" > "$report.tmp" && mv "$report.tmp" "$report" || exit 1`,
    "exec cat > /dev/null",
    "",
  ].join("\n");
}

/** What a holder reported: Safe-Chain's local port and its CA bundle. */
export interface HolderReport {
  readonly port: number;
  readonly bundle: string;
}

/** Pure: a holder report, or null when it is not one (wrong host, port or path). */
export function parseHolderReport(text: string, layout: SafeChainProxyLayout): HolderReport | null {
  const [proxy = "", bundle = ""] = text.split("\n");
  const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(proxy.trim());
  const port = Number(match?.[1]);
  if (match === null || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  const path = bundle.trim();
  if (!path.startsWith("/") || path.includes("/../") || !isAtOrUnder(path, layout.tmp)) {
    return null;
  }
  return { port, bundle: path };
}

/** The largest request head the gate reads before it refuses. */
export const GATE_HEAD_LIMIT_BYTES = 8 * 1024;
/** How long the gate waits for a whole request head. */
export const GATE_HEAD_TIMEOUT_MS = 10_000;

export type GateDecision =
  | {
      readonly ok: true;
      readonly ecosystem: SafeChainEcosystem;
      readonly host: string;
      readonly port: number;
    }
  | { readonly ok: false; readonly status: 400 | 403; readonly reason: string };

/**
 * Pure: the gate's rule for one request head (up to and without the blank line). Only
 * `CONNECT <checked registry>:443` passes; plain HTTP, other methods, ports and hosts are refused.
 */
export function gateDecision(head: string): GateDecision {
  const [line = ""] = head.split("\r\n");
  const match = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(line);
  if (match === null) return { ok: false, status: 400, reason: "not an HTTP/1 request line" };
  const [, method = "", target = ""] = match;
  if (method !== "CONNECT") {
    return { ok: false, status: 403, reason: `${method} is refused; only CONNECT is allowed` };
  }
  const authority = /^([A-Za-z0-9.-]+):(\d{1,5})$/.exec(target);
  if (authority === null) return { ok: false, status: 400, reason: `bad CONNECT target ${target}` };
  const host = (authority[1] ?? "").toLowerCase();
  const port = Number(authority[2]);
  const ecosystem = ecosystemOf(host);
  if (ecosystem === null) {
    return { ok: false, status: 403, reason: `${host} is not a registry Safe-Chain checks` };
  }
  if (port !== SAFE_CHAIN_TLS_PORT) {
    return { ok: false, status: 403, reason: `port ${port} is refused; only 443 is allowed` };
  }
  return { ok: true, ecosystem, host, port };
}

export interface SafeChainProxyPolicyInput {
  readonly platform: "darwin" | "linux";
  readonly home: string;
  readonly uid: number;
  readonly layout: SafeChainProxyLayout;
  /** The files the sandboxed `dipo` needs: its binary, or Bun and the source tree. */
  readonly dipoReads: readonly string[];
  /** dipo's own state and runtime directories. */
  readonly dipoDirs: readonly string[];
}

/**
 * The proxy's own sandbox: no worker code runs in it, but it handles worker traffic, so a bug in
 * Safe-Chain or the gate stays contained. Network only to the registries and Aikido's malware
 * list; local binding, because Safe-Chain listens on 127.0.0.1 (srt cannot grant a listen
 * without it); no reads of the home directory beyond the `dipo` that runs the gate; writes only
 * to the proxy directory's install, temp, home, report and socket directories.
 */
export function safeChainProxyPolicy(input: SafeChainProxyPolicyInput): SrtSettings {
  const { layout } = input;
  const sockets =
    input.platform === "darwin"
      ? { allowUnixSockets: [layout.sockets] }
      : { allowAllUnixSockets: true as const };
  return {
    network: {
      allowedDomains: [...SAFE_CHAIN_PROXY_HOSTS],
      deniedDomains: [],
      strictAllowlist: true,
      allowLocalBinding: true,
      ...sockets,
    },
    filesystem: {
      denyRead: [
        ...new Set([
          input.home,
          ...input.dipoDirs,
          `/run/user/${input.uid}`,
          ...DENIED_SOCKET_PATHS,
        ]),
      ],
      allowRead: [...new Set([layout.dir, ...input.dipoReads])],
      // Never the holder directory: it is on the proxy's PATH.
      allowWrite: [layout.install, layout.tmp, layout.home, layout.reports, layout.sockets],
      denyWrite: [`${layout.install}/bin`],
    },
  };
}

/** The install caches of a worker, under its temp directory (env name, directory name). */
export const WORKER_CACHE_DIRS: readonly (readonly [string, string])[] = [
  ["BUN_INSTALL_CACHE_DIR", "bun"],
  ["npm_config_cache", "npm"],
  ["YARN_CACHE_FOLDER", "yarn"],
  ["PIP_CACHE_DIR", "pip"],
  ["XDG_CACHE_HOME", "xdg-cache"],
  ["XDG_DATA_HOME", "xdg-data"],
];

/** The worker's cache variables: every install cache in `<tmpDir>/caches`. */
export function workerCacheEnv(tmpDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, dir] of WORKER_CACHE_DIRS) env[name] = `${tmpDir}/caches/${dir}`;
  return env;
}

/** Variables that point a worker's package managers at the proxy's CA bundle. */
export const WORKER_CA_VARIABLES = [
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
  "PIP_CERT",
] as const;

export function workerCaEnv(caFile: string): Record<string, string> {
  return Object.fromEntries(WORKER_CA_VARIABLES.map((name) => [name, caFile]));
}

/** Largest CA bundle dipo copies for the worker. */
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
