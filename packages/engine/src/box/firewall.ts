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
// - The Safe-Chain box (DIPO-343) gets the same rule toward dipo's upstream listener, plus an
//   input chain: only the Mac's address reaches it, on its Safe-Chain ports (`inbound`), and it
//   answers only connections already made. So no other box reaches it directly, and its own
//   traffic leaves only through dipo's upstream listener.
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

/** The box user's name and home. */
export const BOX_USER_NAME = "dipo";
export const BOX_USER_HOME = "/home/dipo";
/** Where npm installs Claude Code and the package managers: the box user's own prefix. */
export const BOX_NPM_PREFIX = `${BOX_USER_HOME}/.local`;
/** The box user's PATH: its npm prefix first, then Debian's. */
export const BOX_USER_PATH = `${BOX_NPM_PREFIX}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
/**
 * The environment every contained command runs with (`containedCommand`); a command's own value
 * of one of these keys replaces that key only, never the rest.
 */
export const BOX_USER_ENV: Readonly<Record<string, string>> = {
  HOME: BOX_USER_HOME,
  USER: BOX_USER_NAME,
  LOGNAME: BOX_USER_NAME,
  PATH: BOX_USER_PATH,
};
/** The image's `env`, which sets `BOX_USER_ENV` inside the box before the command is looked up. */
export const BOX_ENV_PROGRAM = "/usr/bin/env";

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

/**
 * `command` behind the image's `env` with the box user's environment: each key of
 * `BOX_USER_ENV` removed (every copy the backend or the image may have set) and set again, from
 * `env` where it names the key, else the box user's. So PATH and HOME never depend on how the
 * backend orders the image's environment and the command's (DIPO-334).
 */
function userEnvCommand(
  command: readonly [string, ...string[]],
  env: Readonly<Record<string, string>>,
): [string, ...string[]] {
  const keys = Object.keys(BOX_USER_ENV);
  return [
    BOX_ENV_PROGRAM,
    ...keys.flatMap((key) => ["-u", key]),
    ...keys.map((key) => `${key}=${env[key] ?? BOX_USER_ENV[key]}`),
    ...command,
  ];
}

/**
 * `command` run contained (file comment): through setpriv as the box user, with no capability,
 * and with the box user's environment (`userEnvCommand`); `env` may replace a key of it.
 */
export function containedCommand(
  command: readonly [string, ...string[]],
  env: Readonly<Record<string, string>> = {},
): [string, ...string[]] {
  return netToolCommand("setpriv", [...CONTAINED_OPTIONS, "--", ...userEnvCommand(command, env)]);
}

/** `command` without the `userEnvCommand` prefix, or null when it has none. */
function withoutUserEnv(command: readonly string[]): readonly string[] | null {
  const keys = Object.keys(BOX_USER_ENV);
  const length = 1 + keys.length * 3;
  if (command.length <= length || command[0] !== BOX_ENV_PROGRAM) return null;
  const fits = keys.every(
    (key, at) =>
      command[1 + at * 2] === "-u" &&
      command[2 + at * 2] === key &&
      (command[1 + keys.length * 2 + at] ?? "").startsWith(`${key}=`),
  );
  return fits ? command.slice(length) : null;
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
  const user = unwrap(command, (inner) =>
    netToolCommand("setpriv", [...CONTAINED_OPTIONS, "--", ...inner]),
  );
  if (user !== null) return withoutUserEnv(user);
  return unwrap(command, rootStepCommand);
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
  /**
   * The Safe-Chain box only (DIPO-343): its ports that the Mac's address may connect to. With it,
   * the rule also drops every other packet coming in, and lets the box answer what it accepted.
   */
  readonly inbound?: readonly number[];
}

/** The table and chains the rule lives in. */
const TABLE = "dipo";
const CHAIN = "output";
const INPUT = "input";

function refuse(message: string, details: Readonly<Record<string, unknown>>): never {
  throw new BoxError("box.refused", message, false, details);
}

/** One to eight ports from 1 to 65535, sorted and without repeats, or a refusal. */
function checkedPorts(ports: readonly number[], what: string): number[] {
  const sorted = [...new Set(ports)].toSorted((a, b) => a - b);
  if (
    sorted.length === 0 ||
    sorted.length > 8 ||
    sorted.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)
  ) {
    refuse(`the box firewall needs one to eight ${what} from 1 to 65535.`, { ports });
  }
  return sorted;
}

/** The rule's inputs, checked: an IP literal and one to eight ports (each way). */
function checkedFirewall(firewall: BoxFirewall): {
  family: 4 | 6;
  ports: number[];
  inbound: number[] | null;
} {
  const family = isIP(firewall.hostAddress);
  if (family !== 4 && family !== 6) {
    refuse("the box firewall needs the box network's host address as an IP address.", {
      hostAddress: firewall.hostAddress,
    });
  }
  const ports = checkedPorts(firewall.ports, "ports");
  const inbound =
    firewall.inbound === undefined ? null : checkedPorts(firewall.inbound, "inbound ports");
  return { family, ports, inbound };
}

/** The state match of the packets of a connection the box opened or accepted. */
const ESTABLISHED = "ct state established,related accept";

/**
 * The nft commands of the rule, as one argument: the whole ruleset flushed, then one table whose
 * output chain drops everything but the loopback interface and the Mac's address on the box
 * network on `ports`. With `inbound` (the Safe-Chain box), the output chain also passes the
 * packets of connections already made, and an input chain drops everything but the loopback, those
 * packets, and the Mac's address on `inbound`.
 */
export function firewallRules(firewall: BoxFirewall): string {
  const { family, ports, inbound } = checkedFirewall(firewall);
  const ip = family === 4 ? "ip" : "ip6";
  const chain = (name: string, hook: string) =>
    `add chain inet ${TABLE} ${name} { type filter hook ${hook} priority 0 ; policy drop ; }`;
  return [
    "flush ruleset",
    `add table inet ${TABLE}`,
    chain(CHAIN, "output"),
    `add rule inet ${TABLE} ${CHAIN} oifname "lo" accept`,
    ...(inbound === null ? [] : [`add rule inet ${TABLE} ${CHAIN} ${ESTABLISHED}`]),
    `add rule inet ${TABLE} ${CHAIN} ${ip} daddr ${firewall.hostAddress} tcp dport { ${ports.join(", ")} } accept`,
    ...(inbound === null
      ? []
      : [
          chain(INPUT, "input"),
          `add rule inet ${TABLE} ${INPUT} iifname "lo" accept`,
          `add rule inet ${TABLE} ${INPUT} ${ESTABLISHED}`,
          `add rule inet ${TABLE} ${INPUT} ${ip} saddr ${firewall.hostAddress} tcp dport { ${inbound.join(", ")} } accept`,
        ]),
  ].join(" ; ");
}

/** The command that sets the rule; it runs with the box's capabilities. */
export function firewallCommand(firewall: BoxFirewall): [string, ...string[]] {
  return netToolCommand("nft", [firewallRules(firewall)]);
}

/**
 * The command that lists the rule, to check it took: the output chain, or the whole table when
 * the rule has an input chain too (`inbound`).
 */
export function firewallListCommand(firewall?: BoxFirewall): [string, ...string[]] {
  return firewall?.inbound === undefined
    ? netToolCommand("nft", ["list", "chain", "inet", TABLE, CHAIN])
    : netToolCommand("nft", ["list", "table", "inet", TABLE]);
}

/** The address and ports a rule of `firewallRules` names, read back from its text. */
const RULE_TARGET = / (?:ip|ip6) daddr (\S+) tcp dport \{ ([0-9, ]+) \} accept(?: ;|$)/;
/** The inbound ports a rule of `firewallRules` names, read back from its text. */
const RULE_INBOUND = / (?:ip|ip6) saddr \S+ tcp dport \{ ([0-9, ]+) \} accept$/;

/** The ports of a rule's `{ a, b }` set, read back from its text. */
function portNumbers(text: string): number[] {
  return text.split(", ").map(Number);
}

/**
 * True when `command` is one of the list commands above, or the command of a rule exactly as
 * `firewallRules` writes it for some address and ports: nothing else runs with the box's
 * capabilities outside a build box.
 */
export function isFirewallCommand(command: readonly string[]): boolean {
  const prefix = netToolCommand("nft", []);
  if (command.length <= prefix.length || !prefix.every((part, at) => command[at] === part)) {
    return false;
  }
  const args = command.slice(prefix.length).join("\u0000");
  const lists = [
    firewallListCommand(),
    firewallListCommand({ hostAddress: "", ports: [], inbound: [] }),
  ];
  if (lists.some((list) => list.slice(prefix.length).join("\u0000") === args)) return true;
  const rules = command.length === prefix.length + 1 ? (command.at(-1) ?? "") : null;
  const target = rules === null ? null : RULE_TARGET.exec(rules);
  if (rules === null || target === null) return false;
  const inbound = RULE_INBOUND.exec(rules);
  try {
    return (
      firewallRules({
        hostAddress: target[1] ?? "",
        ports: portNumbers(target[2] ?? ""),
        ...(inbound === null ? {} : { inbound: portNumbers(inbound[1] ?? "") }),
      }) === rules
    );
  } catch {
    return false;
  }
}

/** The text nft prints for a set of `ports` (a set of one port is printed as the port alone). */
function portLists(ports: readonly number[]): string[] {
  return [`dport { ${ports.join(", ")} }`, ...(ports.length === 1 ? [`dport ${ports[0]}`] : [])];
}

/**
 * True when nft's listing shows the rule of `firewall`: the drop policy, the loopback accept, and
 * the Mac's address with each port; with `inbound`, also the input chain with its drop policy,
 * its loopback and Mac rules, and the state rule in both chains.
 */
export function checkFirewallListing(listing: string, firewall: BoxFirewall): boolean {
  const { family, ports, inbound } = checkedFirewall(firewall);
  const text = listing.replace(/\s+/g, " ");
  const ip = family === 4 ? "ip" : "ip6";
  const output =
    text.includes(`chain ${CHAIN} {`) &&
    /type filter hook output priority (0|filter); policy drop;/.test(text) &&
    text.includes('oifname "lo" accept') &&
    portLists(ports).some((list) =>
      text.includes(`${ip} daddr ${firewall.hostAddress} tcp ${list} accept`),
    );
  if (inbound === null) return output;
  const established = text.split("ct state established,related accept").length - 1 === 2;
  return (
    output &&
    established &&
    text.includes(`chain ${INPUT} {`) &&
    /type filter hook input priority (0|filter); policy drop;/.test(text) &&
    text.includes('iifname "lo" accept') &&
    portLists(inbound).some((list) =>
      text.includes(`${ip} saddr ${firewall.hostAddress} tcp ${list} accept`),
    )
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
