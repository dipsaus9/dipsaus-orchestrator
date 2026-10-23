// The box firewall (DIPO-281, from DIPO-283 and DIPO-286; 0021 section 3 and its amendment of
// 2026-10-21): what a box may reach on its host-only network besides dipo's proxies is nothing.
//
// On the host-only network the Mac is the box's neighbour, so without a rule a box reaches every
// service of the Mac that listens on all interfaces, or on the Mac's own local-network address.
// A rule on the Mac needs root there, which dipo does not have, so the rule sits in the box's own
// kernel, set and kept by dipo:
//
// - The rule (`firewallRules`): output only to the loopback interface and to the Mac's address on
//   the box network on the ports of dipo's proxies; every other packet, of either IP family, is
//   dropped. dipo sets it, and checks it took (`checkFirewallListing`), before a box's first
//   install or build step and again at each session, with the ports of that moment.
// - The tools that set and keep it (`BOX_NET_TOOLS_PATH`): `nft`, `setpriv` and `tail` with their
//   libraries and loader, run through the loader by path. A box image build extracts them from
//   Debian's packages before any package's install script runs, and dipo copies them out to a
//   folder of its own (`netToolsDir`); every other box mounts that folder read-only at the same
//   path, so a worker cannot write them.
// - Every command dipo starts in a box runs contained (`containedCommand`, DIPO-334): through
//   `setpriv` as the box user, a fixed non-root uid and gid (`BOX_USER_UID`) with no other
//   group, no capability in any set (the bounding set an allow list of none, `USER_CAPABILITIES`)
//   and no new privileges, inherited by everything it starts and never regained. The worker's
//   session and its commands, the office install, the package cache fill and every npm install of
//   an image build run so. dipo's own fixed steps that must be root (`rootStepCommand`) keep only
//   the allow list `ROOT_STEP_CAPABILITIES`, never `net_admin` or `net_raw`. Only the rule itself,
//   and a build box's first step before any install script ran, run with all of the box's
//   capabilities. The box's keepalive process is the mounted `tail`.
// - The tools folder sits directly under `/`: a folder of `/` cannot be renamed by the box user,
//   and a mount point cannot be renamed at all, so no planted loader takes its place; `/etc`,
//   `/usr`, `/lib` and `/opt` belong to root, so neither `/etc/ld.so.preload` nor an NSS module
//   can be planted for a command that runs as root.
//
// Pure, but for `resolveNetToolsMount`, which reads the folder it checks.

import { isIP } from "node:net";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";

import { BoxError } from "./port";

/** Where the box's network tools are: in a build box as extracted, in every other box mounted. */
export const BOX_NET_TOOLS_PATH = "/dipo-net";
/** The loader the tools run through, by path, so no program of the box's own takes part. */
export const NET_TOOLS_LOADER = `${BOX_NET_TOOLS_PATH}/ld.so`;
/** The folder of the tools' libraries. */
export const NET_TOOLS_LIB = `${BOX_NET_TOOLS_PATH}/lib`;
/** The tools, each in `bin/` of the tools folder. */
export const NET_TOOLS = ["nft", "setpriv", "tail"] as const;
export type NetTool = (typeof NET_TOOLS)[number];
/** The files the tools folder must hold, relative to it. */
export const NET_TOOLS_FILES: readonly string[] = [
  "ld.so",
  ...NET_TOOLS.map((tool) => `bin/${tool}`),
];
/** The folder of dipo's state folder that holds each image's copy of the tools, by image hash. */
export const BOX_NET_TOOLS_DIR = "box-net-tools";

/** The box user's uid and gid (DIPO-334): no user of Debian's base image has them. */
export const BOX_USER_UID = 1000;
export const BOX_USER_GID = 1000;

/** The capabilities a contained command of the box user keeps (setpriv's names): none. */
export const USER_CAPABILITIES: readonly string[] = [];

/**
 * The capabilities one of dipo's root steps keeps (`rootStepCommand`), an allow list: owners and
 * modes of files (`chown`, `dac_override`, `dac_read_search`, `fowner`, `fsetid`), the user
 * switches of apt and of Debian's package scripts (`setuid`, `setgid`, `kill`, `sys_chroot`,
 * `audit_write`). Never the network (`net_admin`, `net_raw`), mounts or tracing.
 */
export const ROOT_STEP_CAPABILITIES: readonly string[] = [
  "audit_write",
  "chown",
  "dac_override",
  "dac_read_search",
  "fowner",
  "fsetid",
  "kill",
  "setgid",
  "setuid",
  "sys_chroot",
];

/** setpriv's bounding set option that keeps exactly `allowed`. */
export function boundingSet(allowed: readonly string[]): string {
  return `--bounding-set=${["-all", ...allowed.map((cap) => `+${cap}`)].join(",")}`;
}

/** `tool` run through the tools' own loader and libraries, with `args`. */
export function netToolCommand(tool: NetTool, args: readonly string[]): [string, ...string[]] {
  return [
    NET_TOOLS_LOADER,
    "--library-path",
    NET_TOOLS_LIB,
    `${BOX_NET_TOOLS_PATH}/bin/${tool}`,
    ...args,
  ];
}

/**
 * The setpriv options of a contained command, before its `--`: the box user by number (no name
 * lookup), no other group, no capability.
 */
const CONTAINED_OPTIONS: readonly string[] = [
  `--reuid=${BOX_USER_UID}`,
  `--regid=${BOX_USER_GID}`,
  "--clear-groups",
  "--inh-caps=-all",
  "--ambient-caps=-all",
  boundingSet(USER_CAPABILITIES),
  "--no-new-privs",
];

/** The setpriv options of a root step: root, with `ROOT_STEP_CAPABILITIES` only. */
const ROOT_STEP_OPTIONS: readonly string[] = [
  "--inh-caps=-all",
  "--ambient-caps=-all",
  boundingSet(ROOT_STEP_CAPABILITIES),
  "--no-new-privs",
];

/** `command` run contained (file comment): through setpriv as the box user, with no capability. */
export function containedCommand(command: readonly [string, ...string[]]): [string, ...string[]] {
  return netToolCommand("setpriv", [...CONTAINED_OPTIONS, "--", ...command]);
}

/** `command` as one of dipo's root steps: root, with `ROOT_STEP_CAPABILITIES` only. */
export function rootStepCommand(command: readonly [string, ...string[]]): [string, ...string[]] {
  return netToolCommand("setpriv", [...ROOT_STEP_OPTIONS, "--", ...command]);
}

/** `command` without the prefix that `wrap` adds, or null when it has none. */
function unwrap(
  command: readonly string[],
  wrap: (inner: readonly [string, ...string[]]) => string[],
): readonly string[] | null {
  const prefix = wrap(["-"]).slice(0, -1);
  if (command.length <= prefix.length) return null;
  return prefix.every((part, at) => command[at] === part) ? command.slice(prefix.length) : null;
}

/** The command a contained or root-step `command` runs, or null when it is neither. */
export function uncontained(command: readonly string[]): readonly string[] | null {
  return unwrap(command, containedCommand) ?? unwrap(command, rootStepCommand);
}

/** True when `command` runs as one of dipo's root steps (`rootStepCommand`). */
export function isRootStepWrapped(command: readonly string[]): boolean {
  return unwrap(command, rootStepCommand) !== null;
}

/** The box's keepalive process: the mounted `tail`, so nothing of the box's own runs as it. */
export const CONTAINED_KEEPALIVE = netToolCommand("tail", ["-f", "/dev/null"]);

/** What the rule lets a box reach: the Mac's address on the box network, on dipo's ports. */
export interface BoxFirewall {
  /** The Mac's address on the box network (`BoxNetwork.hostAddress`). */
  readonly hostAddress: string;
  /** The ports of dipo's proxies there that the box may reach now. */
  readonly ports: readonly number[];
}

/** The table and chain the rule lives in. */
const TABLE = "dipo";
const CHAIN = "output";

function refuse(message: string, details: Readonly<Record<string, unknown>>): never {
  throw new BoxError("box.refused", message, false, details);
}

/** The rule's inputs, checked: an IP literal and one to eight ports. */
function checkedFirewall(firewall: BoxFirewall): { family: 4 | 6; ports: number[] } {
  const family = isIP(firewall.hostAddress);
  if (family !== 4 && family !== 6) {
    refuse("the box firewall needs the box network's host address as an IP address.", {
      hostAddress: firewall.hostAddress,
    });
  }
  const ports = [...new Set(firewall.ports)].toSorted((a, b) => a - b);
  if (
    ports.length === 0 ||
    ports.length > 8 ||
    ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)
  ) {
    refuse("the box firewall needs one to eight ports from 1 to 65535.", { ports: firewall.ports });
  }
  return { family, ports };
}

/**
 * The nft commands of the rule, as one argument: the whole ruleset flushed, then one table whose
 * output chain drops everything but the loopback interface and the Mac's address on the box
 * network on `ports`.
 */
export function firewallRules(firewall: BoxFirewall): string {
  const { family, ports } = checkedFirewall(firewall);
  const match = family === 4 ? "ip daddr" : "ip6 daddr";
  return [
    "flush ruleset",
    `add table inet ${TABLE}`,
    `add chain inet ${TABLE} ${CHAIN} { type filter hook output priority 0 ; policy drop ; }`,
    `add rule inet ${TABLE} ${CHAIN} oifname "lo" accept`,
    `add rule inet ${TABLE} ${CHAIN} ${match} ${firewall.hostAddress} tcp dport { ${ports.join(", ")} } accept`,
  ].join(" ; ");
}

/** The command that sets the rule; it runs with the box's capabilities. */
export function firewallCommand(firewall: BoxFirewall): [string, ...string[]] {
  return netToolCommand("nft", [firewallRules(firewall)]);
}

/** The command that lists the rule's chain, to check it took. */
export function firewallListCommand(): [string, ...string[]] {
  return netToolCommand("nft", ["list", "chain", "inet", TABLE, CHAIN]);
}

/** The address and ports a rule of `firewallRules` names, read back from its text. */
const RULE_TARGET = / (?:ip|ip6) daddr (\S+) tcp dport \{ ([0-9, ]+) \} accept$/;

/**
 * True when `command` is the list command above, or the command of a rule exactly as
 * `firewallRules` writes it for some address and ports: nothing else runs with the box's
 * capabilities outside a build box.
 */
export function isFirewallCommand(command: readonly string[]): boolean {
  const prefix = netToolCommand("nft", []);
  if (command.length <= prefix.length || !prefix.every((part, at) => command[at] === part)) {
    return false;
  }
  const args = command.slice(prefix.length);
  if (args.join("\u0000") === firewallListCommand().slice(prefix.length).join("\u0000")) {
    return true;
  }
  const rules = args.length === 1 ? (args[0] ?? "") : null;
  const target = rules === null ? null : RULE_TARGET.exec(rules);
  if (rules === null || target === null) return false;
  const ports = (target[2] ?? "").split(", ").map(Number);
  try {
    return firewallRules({ hostAddress: target[1] ?? "", ports }) === rules;
  } catch {
    return false;
  }
}

/**
 * True when nft's listing of the chain shows the rule of `firewall`: the drop policy, the
 * loopback accept, and the Mac's address with each port.
 */
export function checkFirewallListing(listing: string, firewall: BoxFirewall): boolean {
  const { family, ports } = checkedFirewall(firewall);
  const text = listing.replace(/\s+/g, " ");
  const match = family === 4 ? "ip daddr" : "ip6 daddr";
  // nft prints a set of one port as the port alone.
  const portLists = [
    `dport { ${ports.join(", ")} }`,
    ...(ports.length === 1 ? [`dport ${ports[0]}`] : []),
  ];
  return (
    text.includes(`chain ${CHAIN} {`) &&
    /type filter hook output priority (0|filter); policy drop;/.test(text) &&
    text.includes('oifname "lo" accept') &&
    portLists.some((list) => text.includes(`${match} ${firewall.hostAddress} tcp ${list} accept`))
  );
}

/** The folder of dipo's state that holds the tools of the image `tag` (`dipo-box:<hash>`). */
export function netToolsDir(root: string, tag: string): string {
  const hash = /:([0-9a-f]{64})$/.exec(tag)?.[1];
  if (hash === undefined) refuse(`${JSON.stringify(tag)} is not a dipo box image tag.`, { tag });
  return join(root, hash);
}

/**
 * The real path of the tools folder `path`, checked before it is mounted into a box: under dipo's
 * tools root `root` (a symlink cannot point the mount elsewhere), a folder, and holding each of
 * `NET_TOOLS_FILES` as a regular file. Refuses with `box.netToolsMissing` otherwise.
 */
export async function resolveNetToolsMount(path: string, root: string): Promise<string> {
  const missing = (message: string): never => {
    throw new BoxError("box.netToolsMissing", message, false, { path, root });
  };
  if (!path.startsWith("/") || !root.startsWith("/")) {
    missing("the box network tools and their root must be absolute paths.");
  }
  const realRoot = await realpath(root).catch(() =>
    missing("the box network tools root is missing."),
  );
  const real = await realpath(path).catch(() => missing("the box network tools are missing."));
  if (!real.startsWith(`${realRoot}/`)) {
    missing(`the box network tools resolve to ${real}, which is not under dipo's tools root.`);
  }
  const info = await lstat(real).catch(() => null);
  if (info === null || !info.isDirectory()) missing("the box network tools are not a folder.");
  for (const file of NET_TOOLS_FILES) {
    const entry = await lstat(join(real, file)).catch(() => null);
    if (entry === null || !entry.isFile()) {
      missing(`the box network tools have no regular file ${file}.`);
    }
  }
  return real;
}
