// The web route of the boxes (0021 section 3 and its amendment of 2026-10-21, DIPO-268): a
// CONNECT proxy, ported from the reviewed probe proxy (`tools/box-probe/web-proxy.ts`). A box sits
// on a host-only network with no route out; this proxy, listening only on the network's host
// address on the Mac, is its one way to the internet.
//
// - A tunnel to a package registry Safe-Chain checks (host name normalised: lower case, one
//   trailing dot dropped) goes to the Safe-Chain box (DIPO-343, `safe-chain-box.ts`), on the port
//   of the registry's ecosystem, and only on the TLS port. While no Safe-Chain box runs, it is
//   refused: no registry is reached but through Safe-Chain. Each one is kept with its client box,
//   the box its proxy password names, and when it opened and closed (`RegistryTunnels`, DIPO-396),
//   so a refusal in Safe-Chain's log is tied to the box that asked. A tunnel with no password dipo
//   admitted still goes to Safe-Chain; its refusals are tied to no box.
// - A tunnel to another name of a registry (DIPO-281, `registryRefusal`) is refused: a known alias,
//   a CDN name or a public mirror of a registry Safe-Chain checks, or any name under a zone that
//   only serves a registry. Safe-Chain checks only its own names, so none of them goes to it.
// - Every other tunnel goes only to a public internet address. IP literals (also numeric forms such
//   as a bare decimal number) are refused, and so is a name that resolves to an address the rule
//   in `checkAddress` refuses: the Mac's own addresses and on-link prefixes, the box network,
//   private, shared, loopback, link-local, multicast and reserved ranges, NAT64 (64:ff9b::/96),
//   6to4 (2002::/16), Teredo, IPv4-compatible and IPv4-translated forms, and IPv4-mapped forms of
//   any refused IPv4 address. A name with any refused address is refused as a whole.
// - The name is resolved once and the tunnel goes to an address that resolution returned and the
//   rule passed, as an IP literal, so nothing resolves it again (no DNS-rebinding gap).
// - What a box sends into a direct tunnel is read before it goes on (DIPO-281, `TunnelInspector`),
//   so a tunnel to a harmless name on a registry's CDN cannot ask for the registry inside it: a TLS
//   handshake must name exactly the host of the CONNECT (no Encrypted Client Hello, no handshake
//   without a name), and a stream that is not TLS may not name a registry anywhere, nor switch to
//   HTTP/2 in clear text, whose compressed headers could hide a name.
// - The Mac's own local ports (DIPO-282): a box reaches only the ports its office lists
//   (`box.localPorts`, from the base branch), only through this proxy, as `BOX_LOCAL_HOST:<port>`,
//   which the proxy connects to on the Mac's loopback. A box is known by the proxy password in its
//   proxy URL (`BoxAdmissions`); a tunnel without a known password reaches no local port.
// - Plain HTTP proxying (a request for an absolute URL) is refused with 405: the proxy is a tunnel
//   for CONNECT only and never an open forward proxy. Plain HTTP still works inside a CONNECT
//   tunnel, under the same rules.
// - The documentation ranges (RFC 5737, RFC 3849, 3fff::/20) are refused too. Tests that need a
//   public stand-in name documentation prefixes in `publicStandIns`, which lifts only that refusal;
//   dipo itself never passes it.
// - Client connections are capped, overall and per box source address, and a tunnel with no
//   traffic either way for the idle timeout is closed (`WEB_PROXY_LIMITS`).
//
// `BoxWebRoute` starts the proxy with the first box that uses it and stops it with the last.
//
// Safe-Chain's own traffic gets a listener of its own (DIPO-343, `startSafeChainUpstreamProxy`),
// on the box network's host address too: it takes connections only from the Safe-Chain box's
// address, tunnels only to the hosts Safe-Chain reaches (`SAFE_CHAIN_UPSTREAM_HOSTS`) on the TLS
// port, under the address rule, and reads each tunnel's TLS handshake as a box's direct tunnel is
// read. No other box reaches it: their firewall passes only the box listener's port.
//
// A reviewer runs in a box of its own (0002) and goes out through this proxy like any box, with no
// local port of the Mac admitted.
//
// Known gaps:
// - Domain fronting on a shared CDN: a request inside a TLS session to a harmless name on the
//   same CDN can still name a registry where the proxy cannot read it.
// - The registry names are a list: a registry Safe-Chain does not know, a mirror not on the list,
//   a relay of the worker's own on the internet, or a request coalesced into a TLS session with
//   another name the registry's certificate covers still reaches registry content directly.
// - The rule knows private hosts only by their address ranges, so two are not recognised (both
//   from the 0021 amendment of 2026-10-21): a private host on a public range reached through a
//   VPN's route, and the Mac's own public IPv4 address reached back through the router.

import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { connect, createServer, isIP, type Server, type Socket } from "node:net";
import { networkInterfaces } from "node:os";

import type { Clock, TimerHandle } from "@dipsaus-orchestrator/contract";

import { type BoxConnector, connectToBox } from "./box-connect";
import type { BoxNetwork } from "./port";
import {
  ecosystemOf,
  type RegistryClients,
  SAFE_CHAIN_REGISTRY_HOSTS,
  SAFE_CHAIN_TLS_PORT,
  SAFE_CHAIN_UPSTREAM_HOSTS,
  type SafeChainEcosystem,
} from "./safe-chain";

/** The longest request head read before a tunnel opens. */
export const WEB_PROXY_HEAD_LIMIT = 8 * 1024;
/** How long a client may take to send its request head. */
export const WEB_PROXY_HEAD_TIMEOUT_MS = 30_000;
/** How long one upstream connection of the box listener may take to open. */
export const WEB_PROXY_CONNECT_TIMEOUT_MS = 30_000;
/**
 * How long one connection of the upstream listener may take to open (DIPO-383): short, so a dead
 * address of a host Safe-Chain reaches never holds Safe-Chain's fetch up.
 */
export const SAFE_CHAIN_UPSTREAM_CONNECT_TIMEOUT_MS = 5_000;
/** How long after one try at an address the next one starts while it still waits (DIPO-383). */
export const WEB_PROXY_CONNECT_STAGGER_MS = 250;
/** The connection caps and the idle timeout of a tunnel, unless the caller names others. */
export const WEB_PROXY_LIMITS = {
  /** Client connections open at once, over all boxes. */
  maxConnections: 512,
  /** Client connections open at once from one box (one source address on the box network). */
  maxConnectionsPerSource: 128,
  /** A tunnel with no traffic either way for this long is closed. */
  idleTimeoutMs: 10 * 60_000,
} as const;
/** The loopback address: where the Mac's listed local ports are reached (DIPO-282). */
const LOOPBACK = "127.0.0.1";

// ---------------------------------------------------------------------------------------------
// The address rule.

/** One address of one of the Mac's network interfaces, as `os.networkInterfaces()` lists it. */
export interface HostInterfaceAddress {
  readonly address: string;
  /** The on-link prefix, `address/length`; null when the system does not say. */
  readonly cidr: string | null;
}

/** What the address rule checks against besides the fixed ranges. */
export interface AddressContext {
  /** Every address of every interface of the Mac, read fresh for each check. */
  readonly interfaces: readonly HostInterfaceAddress[];
  /** The box network's host address (`BoxNetwork.hostAddress`). */
  readonly boxHostAddress: string;
  /**
   * Tests only: documentation prefixes (`address/length`) that pass as public stand-ins. It lifts
   * only the documentation-range refusal; every other rule still applies. dipo never passes it.
   */
  readonly publicStandIns?: readonly string[];
}

/** The rule's verdict: where to connect (an IP literal), or why not. */
export type AddressVerdict =
  | { readonly ok: true; readonly connectTo: string }
  | { readonly ok: false; readonly reason: string };

type Parsed =
  | { readonly family: 4; readonly value: number }
  | { readonly family: 6; readonly groups: readonly number[] };

/** A dotted-quad IPv4 address as an unsigned number, or null. */
function parseIPv4(text: string): number | null {
  if (isIP(text) !== 4) return null;
  return text.split(".").reduce((value, part) => value * 256 + Number(part), 0);
}

/** The 16-bit groups of one side of an IPv6 `::`. */
function hexGroups(part: string): number[] {
  return part === "" ? [] : part.split(":").map((group) => parseInt(group, 16));
}

/** An IPv6 address (zone dropped) as eight 16-bit groups, or null. */
function parseIPv6(text: string): number[] | null {
  const bare = text.split("%")[0] ?? "";
  if (isIP(bare) !== 6) return null;
  let head = bare;
  const tail: number[] = [];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
  if (dotted !== null) {
    const v4 = parseIPv4(dotted[1] ?? "");
    if (v4 === null) return null;
    tail.push(Math.floor(v4 / 0x10000), v4 % 0x10000);
    head = bare.slice(0, bare.length - (dotted[1] ?? "").length);
    if (!head.endsWith("::")) head = head.slice(0, -1);
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const left = hexGroups(halves[0] ?? "");
  const right = halves.length === 2 ? hexGroups(halves[1] ?? "") : null;
  const needed = 8 - tail.length;
  if (right === null) return left.length === needed ? [...left, ...tail] : null;
  const zeros = needed - left.length - right.length;
  if (zeros < 1) return null;
  return [...left, ...Array.from({ length: zeros }, () => 0), ...right, ...tail];
}

/** An IP literal of either family, IPv4-mapped IPv6 folded to its IPv4 address. */
function parseAddress(text: string): Parsed | null {
  const v4 = parseIPv4(text);
  if (v4 !== null) return { family: 4, value: v4 };
  const groups = parseIPv6(text);
  if (groups === null) return null;
  const mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (mapped) return { family: 4, value: (groups[6] ?? 0) * 0x10000 + (groups[7] ?? 0) };
  return { family: 6, groups };
}

function v4Text(value: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join(".");
}

/** True when `address` lies in `base/bits` (same family). */
function inPrefix(address: Parsed, base: Parsed, bits: number): boolean {
  if (address.family === 4 && base.family === 4) {
    if (bits <= 0) return true;
    const size = 2 ** (32 - Math.min(bits, 32));
    return Math.floor(address.value / size) === Math.floor(base.value / size);
  }
  if (address.family === 6 && base.family === 6) {
    let left = Math.max(0, Math.min(bits, 128));
    for (let i = 0; i < 8 && left > 0; i += 1) {
      const take = Math.min(16, left);
      const size = 2 ** (16 - take);
      if (
        Math.floor((address.groups[i] ?? 0) / size) !== Math.floor((base.groups[i] ?? 0) / size)
      ) {
        return false;
      }
      left -= take;
    }
    return true;
  }
  return false;
}

/** A prefix `address/length`, or null when it does not parse. */
function parsePrefix(cidr: string): { base: Parsed; bits: number } | null {
  const [address, length] = cidr.split("/");
  const base = parseAddress(address ?? "");
  if (base === null || length === undefined || !/^\d{1,3}$/.test(length)) return null;
  // An IPv4-mapped base keeps its IPv6 length: fold it to the IPv4 length.
  const bits = Number(length);
  const mappedBase = base.family === 4 && isIP(address ?? "") === 6;
  return { base, bits: mappedBase ? Math.max(0, bits - 96) : bits };
}

type Range = { readonly base: Parsed; readonly bits: number; readonly why: string };

/** The reason of the documentation ranges, the only refusal `publicStandIns` can lift. */
const DOCUMENTATION = "a documentation range";

function ranges(list: ReadonlyArray<readonly [string, string]>): Range[] {
  return list.map(([cidr, why]) => {
    const prefix = parsePrefix(cidr);
    if (prefix === null) throw new Error(`bad range ${cidr}`);
    return { ...prefix, why };
  });
}

/** IPv4 ranges that are not the public internet (RFC 6890 and its updates). */
const REFUSED_V4 = ranges([
  ["0.0.0.0/8", "this network"],
  ["10.0.0.0/8", "a private range"],
  ["100.64.0.0/10", "the shared address space"],
  ["127.0.0.0/8", "loopback"],
  ["169.254.0.0/16", "link-local"],
  ["172.16.0.0/12", "a private range"],
  ["192.0.0.0/24", "the IETF protocol assignments"],
  ["192.0.2.0/24", DOCUMENTATION],
  ["192.88.99.0/24", "the 6to4 relay anycast range"],
  ["192.168.0.0/16", "a private range"],
  ["198.18.0.0/15", "the benchmarking range"],
  ["198.51.100.0/24", DOCUMENTATION],
  ["203.0.113.0/24", DOCUMENTATION],
  ["224.0.0.0/4", "multicast"],
  ["240.0.0.0/4", "a reserved range"],
]);

/** IPv6 ranges that are not the public internet, or that embed an IPv4 address. */
const REFUSED_V6 = ranges([
  ["::/128", "the unspecified address"],
  ["::1/128", "loopback"],
  ["::/96", "an IPv4-compatible address"],
  ["::ffff:0:0:0/96", "an IPv4-translated address"],
  ["64:ff9b::/96", "NAT64 (64:ff9b::/96)"],
  ["64:ff9b:1::/48", "local-use NAT64"],
  ["100::/64", "the discard range"],
  ["2001::/23", "the IETF protocol assignments (Teredo among them)"],
  ["2001:db8::/32", DOCUMENTATION],
  ["2002::/16", "6to4 (2002::/16)"],
  ["3fff::/20", DOCUMENTATION],
  ["fc00::/7", "a unique local range"],
  ["fe80::/10", "link-local"],
  ["fec0::/10", "site-local"],
  ["ff00::/8", "multicast"],
]);

/** Global unicast: the only IPv6 space with public internet addresses. */
const GLOBAL_UNICAST = ranges([["2000::/3", "global unicast"]])[0] as Range;

/** The prefix the box network is assumed to have when no interface of the Mac names it. */
const BOX_PREFIX_FALLBACK = { 4: 24, 6: 64 } as const;

function same(a: Parsed, b: Parsed): boolean {
  return inPrefix(a, b, a.family === 4 ? 32 : 128);
}

/**
 * The address rule: whether a tunnel may go to `address`, which resolution returned. Only a public
 * internet address passes, and never one of the Mac's or the box network's. An IPv4-mapped IPv6
 * address is judged, and connected to, as its IPv4 address.
 */
export function checkAddress(address: string, context: AddressContext): AddressVerdict {
  const parsed = parseAddress(address);
  if (parsed === null) return { ok: false, reason: `${address} is not an IP address` };
  const refuse = (why: string): AddressVerdict => ({ ok: false, reason: `${address} is ${why}` });

  const box = parseAddress(context.boxHostAddress);
  if (box !== null) {
    const holder = context.interfaces.find((entry) => {
      const own = parseAddress(entry.address);
      return own !== null && same(own, box);
    });
    const prefix = holder?.cidr === null || holder === undefined ? null : parsePrefix(holder.cidr);
    const bits = prefix?.bits ?? BOX_PREFIX_FALLBACK[box.family];
    if (inPrefix(parsed, box, bits)) return refuse("on the box network");
  }
  for (const entry of context.interfaces) {
    const own = parseAddress(entry.address);
    if (own !== null && same(parsed, own)) return refuse("one of the Mac's own addresses");
  }
  for (const entry of context.interfaces) {
    const prefix = entry.cidr === null ? null : parsePrefix(entry.cidr);
    if (prefix !== null && inPrefix(parsed, prefix.base, prefix.bits)) {
      return refuse(`in an on-link prefix of the Mac (${entry.cidr})`);
    }
  }
  const standIns = (context.publicStandIns ?? []).flatMap((cidr) => parsePrefix(cidr) ?? []);
  const refusedBy = (range: Range) =>
    inPrefix(parsed, range.base, range.bits) &&
    !(range.why === DOCUMENTATION && standIns.some((p) => inPrefix(parsed, p.base, p.bits)));
  const mapped = parsed.family === 4 && isIP(address) === 6 ? "IPv4-mapped, " : "";
  if (parsed.family === 4) {
    const hit = REFUSED_V4.find(refusedBy);
    if (hit !== undefined) return refuse(`${mapped}${hit.why}`);
    return { ok: true, connectTo: v4Text(parsed.value) };
  }
  const hit = REFUSED_V6.find(refusedBy);
  if (hit !== undefined) return refuse(hit.why);
  if (!inPrefix(parsed, GLOBAL_UNICAST.base, GLOBAL_UNICAST.bits)) {
    return refuse("not a global unicast address");
  }
  return { ok: true, connectTo: address.split("%")[0] ?? address };
}

/** Every address of every interface of this Mac, from `os.networkInterfaces()`. */
export function systemInterfaceAddresses(): HostInterfaceAddress[] {
  return Object.values(networkInterfaces()).flatMap((list) =>
    (list ?? []).map((entry) => ({ address: entry.address, cidr: entry.cidr ?? null })),
  );
}

// ---------------------------------------------------------------------------------------------
// The request head.

/** What a client asked for: a tunnel to a host name, or why it is refused. */
export type TunnelRequest =
  | { readonly ok: true; readonly host: string; readonly port: number }
  | { readonly ok: false; readonly status: 400 | 403 | 405; readonly reason: string };

const REQUEST_LINE = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/;
const LABEL = /^[a-z0-9_-]{1,63}$/;
/** A last label that makes the name a number (the WHATWG URL "ends in a number" rule). */
const NUMERIC_LABEL = /^(0x[0-9a-f]*|[0-9]+)$/;

/**
 * A host name in its normal form: lower case, one trailing dot dropped. Null for an IP literal,
 * including numeric forms a resolver reads as IPv4 (`2130706433`, `0x7f.1`), and for anything that
 * is not a DNS name.
 */
export function normaliseHost(raw: string): string | null {
  const host = raw.toLowerCase().replace(/\.$/, "");
  if (host === "" || host.length > 253 || isIpLiteral(host)) return null;
  return host.split(".").every((label) => LABEL.test(label)) ? host : null;
}

/** True for an IP literal, or a name a resolver reads as an IPv4 number. */
function isIpLiteral(raw: string): boolean {
  const host = raw.toLowerCase().replace(/\.$/, "");
  return isIP(host) !== 0 || NUMERIC_LABEL.test(host.split(".").at(-1) ?? "");
}

/** Reads the request line of a head: only `CONNECT <host name>:<port>` asks for a tunnel. */
export function parseTunnelRequest(head: string): TunnelRequest {
  const line = head.split("\r\n")[0] ?? "";
  const match = REQUEST_LINE.exec(line);
  if (match === null) return { ok: false, status: 400, reason: "not an HTTP request" };
  if (match[1] !== "CONNECT") {
    return { ok: false, status: 405, reason: `${match[1]} is refused; only CONNECT tunnels` };
  }
  const authority = match[2] ?? "";
  if (authority.startsWith("[")) {
    return { ok: false, status: 403, reason: `${authority} is an IP address, not a host name` };
  }
  const at = authority.lastIndexOf(":");
  const rawHost = at === -1 ? authority : authority.slice(0, at);
  const rawPort = at === -1 ? "" : authority.slice(at + 1);
  const port = /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : 0;
  if (port < 1 || port > 65_535) {
    return { ok: false, status: 400, reason: `${authority} names no valid port` };
  }
  const host = normaliseHost(rawHost);
  if (host === null) {
    return {
      ok: false,
      status: 403,
      reason: isIpLiteral(rawHost)
        ? `${rawHost} is an IP address, not a host name`
        : `${rawHost} is not a host name`,
    };
  }
  return { ok: true, host, port };
}

/** The registries that go to Safe-Chain, in normal form. */
const REGISTRIES: ReadonlySet<string> = new Set(
  SAFE_CHAIN_REGISTRY_HOSTS.map((host) => host.toLowerCase()),
);

/** True when `host` (normal form) is a registry Safe-Chain checks. */
export function isRegistryHost(host: string): boolean {
  return REGISTRIES.has(host);
}

/**
 * Other names of the registries Safe-Chain checks (DIPO-281), each with what it is: aliases, the
 * names of their CDNs and public mirrors. A tunnel to one is refused, never sent direct; Safe-Chain
 * checks only its own names, so none goes to it either.
 */
export const REGISTRY_OTHER_NAMES: ReadonlyArray<readonly [string, string]> = [
  ["registry.npmjs.com", "an alias of registry.npmjs.org"],
  ["replicate.npmjs.com", "npm's replica of registry.npmjs.org"],
  ["skimdb.npmjs.com", "npm's replica of registry.npmjs.org"],
  ["registry.npmjs.org.cdn.cloudflare.net", "the CDN name of registry.npmjs.org"],
  ["registry.yarnpkg.com.cdn.cloudflare.net", "the CDN name of registry.yarnpkg.com"],
  ["registry.npmmirror.com", "a public mirror of registry.npmjs.org"],
  ["registry.npm.taobao.org", "a public mirror of registry.npmjs.org"],
  ["r.cnpmjs.org", "a public mirror of registry.npmjs.org"],
  ["pypi.python.org", "an alias of pypi.org"],
  ["test.pypi.org", "PyPI's test registry"],
  ["upload.pypi.org", "PyPI's upload host"],
  ["dualstack.python.map.fastly.net", "the CDN name of pypi.org"],
  ["python.map.fastly.net", "the CDN name of pypi.org"],
  ["dualstack.r.ssl.global.fastly.net", "the CDN name of files.pythonhosted.org"],
  ["pypi.tuna.tsinghua.edu.cn", "a public mirror of pypi.org"],
  ["cloudflare-ech.com", "the CDN's name for hidden server names"],
];

/**
 * Zones that serve a registry Safe-Chain checks (DIPO-281): every name in them but that registry
 * is refused, since another name there may reach the same servers.
 */
export const REGISTRY_ZONES: ReadonlyArray<readonly [string, string]> = [
  ["npmjs.org", "registry.npmjs.org"],
  ["pythonhosted.org", "files.pythonhosted.org"],
  ["pypi.io", "pypi.org"],
];

const OTHER_NAMES: ReadonlyMap<string, string> = new Map(REGISTRY_OTHER_NAMES);

/**
 * Why `host` (normal form) is refused as another name of a registry (`REGISTRY_OTHER_NAMES`, or a
 * name in one of `REGISTRY_ZONES`), or null. A registry Safe-Chain checks is never refused here.
 */
export function registryRefusal(host: string): string | null {
  if (isRegistryHost(host)) return null;
  const what = OTHER_NAMES.get(host);
  if (what !== undefined) {
    return `${host} is ${what}; a registry is reached only by its own name, through Safe-Chain`;
  }
  for (const [zone, registry] of REGISTRY_ZONES) {
    if (host === zone || host.endsWith(`.${zone}`)) {
      return `${host} is in ${zone}, which serves ${registry}; a registry is reached only by its own name, through Safe-Chain`;
    }
  }
  return null;
}

/** Every registry name a stream that is not TLS may not hold, lower case. */
const NAMES_IN_CLEAR: readonly string[] = [
  ...REGISTRIES,
  ...REGISTRY_OTHER_NAMES.map(([name]) => name),
  ...REGISTRY_ZONES.map(([zone]) => zone),
];

// ---------------------------------------------------------------------------------------------
// What a box sends into a direct tunnel (DIPO-281).

/** The longest TLS ClientHello read before a tunnel opens. */
export const CLIENT_HELLO_LIMIT = 64 * 1024;
const TLS_HANDSHAKE = 0x16;
const CLIENT_HELLO = 1;
const EXTENSION_SERVER_NAME = 0x0000;
/** Encrypted Client Hello, and the draft's earlier encrypted server name. */
const HIDDEN_NAME_EXTENSIONS: ReadonlySet<number> = new Set([0xfe0d, 0xffce]);
/** The largest TLS record body a client may send (2^14, plus the room TLS 1.2 allows). */
const TLS_RECORD_MAX = 16_384 + 2_048;
/** The HTTP/2 connection preface a client sends first in clear text (RFC 9113 section 3.4). */
const H2_PREFACE = Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n", "latin1");
/** How much of a stream that is not TLS is kept, to find a name split across two reads. */
const CLEAR_OVERLAP = 256;

/** What a ClientHello holds that the proxy checks, or why it cannot be read. */
export type ClientHelloRead =
  | { readonly kind: "more" }
  | { readonly kind: "bad"; readonly reason: string }
  | {
      readonly kind: "hello";
      /** Every `host_name` of the server_name extension, as sent. */
      readonly serverNames: readonly string[];
      /** True when the hello carries Encrypted Client Hello (or its draft form). */
      readonly hiddenName: boolean;
    };

const badHello = (reason: string): ClientHelloRead => ({ kind: "bad", reason });

/** Reads one ClientHello body (the handshake message without its 4-byte header). */
function readHelloBody(body: Buffer): ClientHelloRead {
  const short = badHello("the TLS ClientHello is cut short");
  let at = 34; // legacy_version (2) and random (32)
  if (body.length < at + 1) return short;
  at += 1 + (body[at] ?? 0); // session id
  if (body.length < at + 2) return short;
  at += 2 + body.readUInt16BE(at); // cipher suites
  if (body.length < at + 1) return short;
  at += 1 + (body[at] ?? 0); // compression methods
  if (at === body.length) return { kind: "hello", serverNames: [], hiddenName: false };
  if (body.length < at + 2) return short;
  const end = at + 2 + body.readUInt16BE(at);
  at += 2;
  if (end !== body.length) return badHello("the TLS ClientHello's extensions do not fill it");
  const seen = new Set<number>();
  const serverNames: string[] = [];
  let hiddenName = false;
  while (at < end) {
    if (end < at + 4) return badHello("a TLS extension is cut short");
    const type = body.readUInt16BE(at);
    const length = body.readUInt16BE(at + 2);
    const data = body.subarray(at + 4, at + 4 + length);
    at += 4 + length;
    if (at > end) return badHello("a TLS extension is cut short");
    if (seen.has(type)) return badHello(`the TLS ClientHello repeats extension ${type}`);
    seen.add(type);
    if (HIDDEN_NAME_EXTENSIONS.has(type)) hiddenName = true;
    if (type !== EXTENSION_SERVER_NAME) continue;
    const names = readServerNames(data);
    if (typeof names === "string") return badHello(names);
    serverNames.push(...names);
  }
  return { kind: "hello", serverNames, hiddenName };
}

/** The host names of a server_name extension's data, or why it cannot be read. */
function readServerNames(data: Buffer): string[] | string {
  if (data.length < 2 || data.readUInt16BE(0) !== data.length - 2) {
    return "the TLS server name list does not fill its extension";
  }
  const names: string[] = [];
  let entry = 2;
  while (entry < data.length) {
    if (data.length < entry + 3) return "a TLS server name is cut short";
    const kind = data[entry] ?? 0;
    const size = data.readUInt16BE(entry + 1);
    if (data.length < entry + 3 + size) return "a TLS server name is cut short";
    if (kind !== 0) return `the TLS server name list holds a name of type ${kind}`;
    names.push(data.subarray(entry + 3, entry + 3 + size).toString("latin1"));
    entry += 3 + size;
  }
  return names;
}

/**
 * Reads the TLS ClientHello at the start of `bytes`, also when the client split it over several
 * handshake records: `more` until it is whole, `bad` for anything else, so a hello dipo cannot
 * read never passes.
 */
export function readClientHello(bytes: Buffer): ClientHelloRead {
  const parts: Buffer[] = [];
  let at = 0;
  for (;;) {
    if (bytes.length < at + 5) {
      return bytes.length > CLIENT_HELLO_LIMIT + 5
        ? { kind: "bad", reason: "the TLS ClientHello is too long" }
        : { kind: "more" };
    }
    if (bytes[at] !== TLS_HANDSHAKE) {
      return { kind: "bad", reason: "a TLS record before the whole ClientHello is no handshake" };
    }
    if (bytes[at + 1] !== 3) return { kind: "bad", reason: "a TLS record names no TLS version" };
    const length = bytes.readUInt16BE(at + 3);
    if (length === 0 || length > TLS_RECORD_MAX) {
      return { kind: "bad", reason: `a TLS record of ${length} bytes` };
    }
    if (bytes.length < at + 5 + length) return { kind: "more" };
    parts.push(bytes.subarray(at + 5, at + 5 + length));
    at += 5 + length;
    const handshake = Buffer.concat(parts);
    if (handshake.length > CLIENT_HELLO_LIMIT + 4) {
      return { kind: "bad", reason: "the TLS ClientHello is too long" };
    }
    if (handshake.length < 4) continue;
    if (handshake[0] !== CLIENT_HELLO) {
      return { kind: "bad", reason: "the first TLS handshake message is no ClientHello" };
    }
    const whole = 4 + handshake.readUIntBE(1, 3);
    if (whole > CLIENT_HELLO_LIMIT + 4) {
      return { kind: "bad", reason: "the TLS ClientHello is too long" };
    }
    if (handshake.length < whole) continue;
    if (handshake.length > whole) {
      return { kind: "bad", reason: "the TLS records hold more than the ClientHello" };
    }
    return readHelloBody(handshake.subarray(4, whole));
  }
}

/** What the inspector says of the bytes so far. */
export type InspectVerdict =
  | { readonly kind: "wait" }
  | { readonly kind: "pass"; readonly bytes: Buffer }
  | { readonly kind: "refuse"; readonly reason: string };

/**
 * Reads what a box sends into a direct tunnel to `host` (normal form), chunk by chunk, before it
 * goes upstream (file comment). A TLS stream passes once its ClientHello names exactly `host` and
 * hides no name; what follows the hello passes unread. A stream that is not TLS is read to its
 * end: it may never name a registry, nor start or ask for HTTP/2 in clear text. A stream whose
 * first byte has the high bit set (an SSL 2 hello, or a binary protocol dipo cannot read) is
 * refused.
 */
export class TunnelInspector {
  readonly #host: string;
  #mode: "start" | "tls" | "clearStart" | "open" | "clear" | "refused" = "start";
  #held: Buffer = Buffer.alloc(0);
  #tail: string | null = null;

  constructor(host: string) {
    this.#host = host;
  }

  /** True while the start of the stream is held back. */
  get waiting(): boolean {
    return this.#mode === "start" || this.#mode === "tls" || this.#mode === "clearStart";
  }

  push(chunk: Buffer): InspectVerdict {
    switch (this.#mode) {
      case "refused":
        return { kind: "refuse", reason: "the tunnel was refused already" };
      case "open":
        return { kind: "pass", bytes: chunk };
      case "clear":
        return this.#clear(chunk);
      case "clearStart":
        this.#held = Buffer.concat([this.#held, chunk]);
        return this.#clearStart();
      case "start":
      case "tls": {
        this.#held = Buffer.concat([this.#held, chunk]);
        const first = this.#held[0];
        if (first === undefined) return { kind: "wait" };
        if (first === TLS_HANDSHAKE) {
          this.#mode = "tls";
          return this.#hello();
        }
        if (first >= 0x80) return this.#refuse("the tunnel starts with bytes dipo cannot read");
        this.#mode = "clearStart";
        return this.#clearStart();
      }
    }
  }

  /**
   * The start of a stream that is not TLS, held while it may still become the HTTP/2 preface:
   * refused once it is the preface, read as clear text once it cannot be, whatever the writes it
   * came in.
   */
  #clearStart(): InspectVerdict {
    const held = this.#held;
    const seen = Math.min(held.length, H2_PREFACE.length);
    if (held.subarray(0, seen).equals(H2_PREFACE.subarray(0, seen))) {
      if (held.length < H2_PREFACE.length) return { kind: "wait" };
      return this.#refuse("the tunnel starts HTTP/2 in clear text");
    }
    this.#mode = "clear";
    this.#held = Buffer.alloc(0);
    return this.#clear(held);
  }

  #refuse(reason: string): InspectVerdict {
    this.#mode = "refused";
    this.#held = Buffer.alloc(0);
    return { kind: "refuse", reason };
  }

  #hello(): InspectVerdict {
    const read = readClientHello(this.#held);
    if (read.kind === "more") return { kind: "wait" };
    if (read.kind === "bad") return this.#refuse(read.reason);
    if (read.hiddenName) {
      return this.#refuse("the TLS handshake hides its server name (Encrypted Client Hello)");
    }
    if (read.serverNames.length !== 1) {
      return this.#refuse(
        read.serverNames.length === 0
          ? "the TLS handshake names no server"
          : "the TLS handshake names more than one server",
      );
    }
    const asked = read.serverNames[0] ?? "";
    if (normaliseHost(asked) !== this.#host) {
      const shown = asked.replace(/[^\x20-\x7e]/g, "?").slice(0, 253);
      return this.#refuse(`the TLS handshake asks for ${shown}, not ${this.#host}`);
    }
    this.#mode = "open";
    const held = this.#held;
    this.#held = Buffer.alloc(0);
    return { kind: "pass", bytes: held };
  }

  #clear(chunk: Buffer): InspectVerdict {
    const text = (this.#tail ?? "") + chunk.toString("latin1").toLowerCase();
    if (/(?:^|\n)upgrade:[^\n]*h2c/.test(text)) {
      return this.#refuse("the tunnel asks for HTTP/2 in clear text");
    }
    const named = NAMES_IN_CLEAR.find((name) => text.includes(name));
    if (named !== undefined) return this.#refuse(`the tunnel names ${named} in clear text`);
    this.#tail = text.slice(-CLEAR_OVERLAP);
    return { kind: "pass", bytes: chunk };
  }
}

// ---------------------------------------------------------------------------------------------
// The Mac's listed local ports (DIPO-282).

/** The name a box reaches the Mac's listed local ports by, only through this proxy. */
export const BOX_LOCAL_HOST = "host.dipo.internal";
/** The proxy user name in a box's proxy URL; the password names the box. */
export const BOX_PROXY_USER = "dipo";

/**
 * The boxes the web route knows by their proxy password (DIPO-282), each with the local ports of
 * the Mac its office lists. A password is random and new for each admission.
 */
export class BoxAdmissions {
  readonly #byBox = new Map<string, string>();
  readonly #ports = new Map<string, readonly number[]>();
  /** The box of each password (DIPO-396). */
  readonly #boxes = new Map<string, string>();
  readonly #token: () => string;

  constructor(token: () => string = () => randomBytes(24).toString("hex")) {
    this.#token = token;
  }

  /** Admits `box` with `ports` and returns its new password; an earlier one stops working. */
  admit(box: string, ports: readonly number[]): string {
    this.forget(box);
    const token = this.#token();
    this.#byBox.set(box, token);
    this.#boxes.set(token, box);
    this.#ports.set(
      token,
      [...new Set(ports)].toSorted((a, b) => a - b),
    );
    return token;
  }

  /** Forgets `box`: its password stops working. */
  forget(box: string): void {
    const token = this.#byBox.get(box);
    if (token !== undefined) {
      this.#ports.delete(token);
      this.#boxes.delete(token);
    }
    this.#byBox.delete(box);
  }

  /** The box whose password is `token` (DIPO-396); null for none or an unknown or stale one. */
  boxOf(token: string | null): string | null {
    return token === null ? null : (this.#boxes.get(token) ?? null);
  }

  /** The listed ports of the box whose password is `token`; null for none or an unknown one. */
  portsOf(token: string | null): readonly number[] | null {
    return token === null ? null : (this.#ports.get(token) ?? null);
  }
}

/** How many closed registry tunnels `RegistryTunnels` keeps; older ones are forgotten. */
export const REGISTRY_TUNNELS_KEPT = 50_000;

/** One registry tunnel the web proxy sent to Safe-Chain (DIPO-396). */
interface RegistryTunnel {
  /** The box whose proxy password it carried; null when it carried none dipo admitted. */
  readonly client: string | null;
  readonly ecosystem: SafeChainEcosystem;
  /** The Mac's time the CONNECT reached the proxy, in ms. */
  readonly opened: number;
  /** The Mac's time it closed, in ms; null while it is open. */
  closed: number | null;
}

/**
 * The registry tunnels the web proxy sent to Safe-Chain (DIPO-396), each with its client box and
 * the Mac's time it opened and closed, so a refusal in Safe-Chain's log, which names no client, is
 * tied to the box that asked (`refusalsOfBox`). It keeps every open tunnel and the last
 * `REGISTRY_TUNNELS_KEPT` closed ones; a span that reaches back past those is `forgotten`.
 */
export class RegistryTunnels {
  readonly #clock: Pick<Clock, "now">;
  readonly #kept: number;
  readonly #open = new Set<RegistryTunnel>();
  #closed: RegistryTunnel[] = [];
  /** The latest close time of a tunnel forgotten; a span from before it is not known whole. */
  #forgottenUntil = Number.NEGATIVE_INFINITY;

  constructor(clock: Pick<Clock, "now">, kept: number = REGISTRY_TUNNELS_KEPT) {
    this.#clock = clock;
    this.#kept = kept;
  }

  /**
   * Keeps a tunnel of `client` (null: no box dipo admitted) to the Safe-Chain process of
   * `ecosystem`, opened at `opened` (the Mac's ms); the returned call closes it, once.
   */
  opened(client: string | null, ecosystem: SafeChainEcosystem, opened: number): () => void {
    const tunnel: RegistryTunnel = { client, ecosystem, opened, closed: null };
    this.#open.add(tunnel);
    return () => {
      if (!this.#open.delete(tunnel)) return;
      tunnel.closed = this.#clock.now();
      this.#closed.push(tunnel);
      if (this.#closed.length > this.#kept) {
        // A tenth more at once, so a close does not move the whole list each time.
        const drop = this.#closed.length - Math.floor(this.#kept * 0.9);
        for (const gone of this.#closed.slice(0, drop)) {
          this.#forgottenUntil = Math.max(this.#forgottenUntil, gone.closed ?? 0);
        }
        this.#closed = this.#closed.slice(drop);
      }
    };
  }

  /** Who had a tunnel of `ecosystem` open at any time from `from` to `to` (the Mac's ms). */
  during(ecosystem: SafeChainEcosystem, from: number, to: number): RegistryClients {
    if (from <= this.#forgottenUntil) return { kind: "forgotten" };
    const boxes: (string | null)[] = [];
    for (const tunnel of [...this.#open, ...this.#closed]) {
      if (tunnel.ecosystem !== ecosystem || tunnel.opened > to) continue;
      if (tunnel.closed !== null && tunnel.closed < from) continue;
      boxes.push(tunnel.client);
    }
    return { kind: "seen", boxes };
  }
}

/** The password of the `Proxy-Authorization: Basic` header of `head`, or null. */
export function proxyPassword(head: string): string | null {
  for (const line of head.split("\r\n").slice(1)) {
    const match = /^proxy-authorization:[ \t]*basic[ \t]+([A-Za-z0-9+/=]+)[ \t]*$/i.exec(line);
    if (match === null) continue;
    const decoded = Buffer.from(match[1] ?? "", "base64").toString("latin1");
    const colon = decoded.indexOf(":");
    return colon === -1 ? null : decoded.slice(colon + 1);
  }
  return null;
}

/** The proxy URL `url` (`http://host:port`) with the box's proxy user and `token`. */
export function admittedUrl(url: string, token: string): string {
  return url.replace(/^http:\/\//, `http://${BOX_PROXY_USER}:${token}@`);
}

// ---------------------------------------------------------------------------------------------
// The proxy.

/** One thing the proxy did, for the daemon's log and the tests. */
export type WebProxyEvent =
  | { readonly kind: "registry"; readonly host: string; readonly port: number }
  | {
      readonly kind: "direct";
      readonly host: string;
      readonly port: number;
      readonly address: string;
    }
  /** A tunnel to a listed local port of the Mac (DIPO-282). */
  | { readonly kind: "local"; readonly port: number }
  | { readonly kind: "refused"; readonly target: string; readonly reason: string };

/** Where the Safe-Chain box takes registry tunnels (DIPO-343): its address, a port per ecosystem. */
export interface SafeChainTarget {
  readonly address: string;
  readonly ports: Readonly<Record<SafeChainEcosystem, number>>;
}

export interface BoxWebProxyOptions {
  /** The box network; the proxy listens only on its host address. */
  readonly network: Pick<BoxNetwork, "hostAddress">;
  /**
   * The Safe-Chain box, read for each registry tunnel; null while none runs, and then every
   * registry tunnel is refused (DIPO-343).
   */
  readonly safeChain: () => SafeChainTarget | null;
  /** The port to listen on; 0 (the default) takes a free one. */
  readonly port?: number;
  /** Caps and idle timeout; each one left out takes its `WEB_PROXY_LIMITS` value. */
  readonly limits?: Partial<{ -readonly [K in keyof typeof WEB_PROXY_LIMITS]: number }>;
  /**
   * The boxes known by their proxy password, with their listed local ports (DIPO-282). Without
   * it no tunnel reaches a local port.
   */
  readonly admissions?: BoxAdmissions;
  /**
   * Where each registry tunnel sent to Safe-Chain is kept with its client box (DIPO-396), by the
   * proxy password it carried (`admissions`).
   */
  readonly tunnels?: RegistryTunnels;
}

export interface BoxWebProxyDeps {
  readonly clock: Clock;
  /** Resolves a host name to its addresses, once per tunnel. */
  readonly resolve?: (host: string) => Promise<readonly string[]>;
  /** Opens an upstream connection to an IP literal. */
  readonly connect?: (address: string, port: number) => Socket;
  /**
   * Opens a connection into the box network, to the Safe-Chain box (DIPO-343), from the box
   * network's host address (`connectToBox`); by default `connect` above, or the system's.
   */
  readonly connectBox?: BoxConnector;
  /** The Mac's interface addresses, read for each check. */
  readonly interfaces?: () => readonly HostInterfaceAddress[];
  /**
   * Tests only: binds the proxy's server instead of the TCP listen at `host` and `port`, such as on
   * a Unix socket where a sandbox refuses TCP listens (DIPO-287); the port is then 0. dipo never
   * passes it.
   */
  readonly listen?: (server: Server, host: string, port: number) => Promise<void>;
  readonly onEvent?: (event: WebProxyEvent) => void;
  /** Tests only: see `AddressContext.publicStandIns`. */
  readonly publicStandIns?: readonly string[];
}

export interface RunningBoxWebProxy {
  /** The address it listens on: the box network's host address. */
  readonly host: string;
  readonly port: number;
  /** The proxy URL a box's `https_proxy` names. */
  readonly url: string;
  /** Closes the port and destroys every open connection. */
  stop(): Promise<void>;
}

async function systemResolve(host: string): Promise<readonly string[]> {
  return (await lookup(host, { all: true })).map((entry) => entry.address);
}

function systemConnect(address: string, port: number): Socket {
  return connect({ host: address, port });
}

function systemListen(server: Server, host: string, port: number): Promise<void> {
  return new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
}

function answer(status: 400 | 403 | 405 | 502 | 503, extra = ""): string {
  const text = {
    400: "Bad Request",
    403: "Forbidden",
    405: "Method Not Allowed",
    502: "Bad Gateway",
    503: "Service Unavailable",
  };
  return `HTTP/1.1 ${status} ${text[status]}\r\n${extra}Content-Length: 0\r\nConnection: close\r\n\r\n`;
}

/** What a direct tunnel reads of the box's bytes before they go on (DIPO-281). */
interface TunnelReading {
  readonly inspector: TunnelInspector;
  /** Called once when the inspector refuses; the tunnel is closed right after. */
  readonly onRefused: (reason: string) => void;
}

/**
 * Joins a client and its upstream both ways; either side closing closes both, and so does no
 * traffic either way for `timing.idleMs`. With `reading`, every byte from the client goes through its
 * inspector first: held back while it waits (at most the head timeout), passed on as it passes,
 * and the tunnel closed when it refuses. The upstream's bytes always flow, so a server that
 * speaks first still can.
 */
function pipeSockets(
  client: Socket,
  upstream: Socket,
  first: Buffer,
  timing: { readonly clock: Clock; readonly idleMs: number },
  reading?: TunnelReading,
): void {
  const { clock, idleMs } = timing;
  upstream.pipe(client);
  let last = clock.now();
  const touch = () => {
    last = clock.now();
  };
  let timer: TimerHandle | null = null;
  let readTimer: TimerHandle | null = null;
  const arm = (delay: number) => {
    timer = clock.setTimeout(() => {
      const idle = clock.now() - last;
      if (idle >= idleMs) close();
      else arm(idleMs - idle);
    }, delay);
  };
  const close = () => {
    if (timer !== null) clock.clearTimeout(timer);
    if (readTimer !== null) clock.clearTimeout(readTimer);
    timer = null;
    readTimer = null;
    client.destroy();
    upstream.destroy();
  };
  if (reading === undefined) {
    if (first.length > 0) upstream.write(first);
    client.pipe(upstream);
  } else {
    let refused = false;
    const feed = (chunk: Buffer) => {
      if (refused) return;
      const verdict = reading.inspector.push(chunk);
      if (verdict.kind === "refuse") {
        refused = true;
        reading.onRefused(verdict.reason);
        close();
        return;
      }
      if (!reading.inspector.waiting && readTimer !== null) {
        clock.clearTimeout(readTimer);
        readTimer = null;
      }
      if (verdict.kind === "pass" && verdict.bytes.length > 0 && !upstream.write(verdict.bytes)) {
        client.pause();
        upstream.once("drain", () => client.resume());
      }
    };
    // A start that is never whole holds the tunnel only as long as a request head may take.
    readTimer = clock.setTimeout(() => {
      readTimer = null;
      if (reading.inspector.waiting && !refused) {
        refused = true;
        reading.onRefused("the tunnel's first bytes did not arrive in time");
        close();
      }
    }, WEB_PROXY_HEAD_TIMEOUT_MS);
    client.on("data", feed);
    if (first.length > 0) feed(first);
  }
  client.on("data", touch);
  upstream.on("data", touch);
  arm(idleMs);
  client.on("error", close);
  upstream.on("error", close);
  client.on("close", close);
  upstream.on("close", close);
  client.resume();
}

/**
 * Why the upstream listener (DIPO-343) refuses a tunnel: a client that is not the Safe-Chain box,
 * a host Safe-Chain does not reach, or a port but the TLS port. Null when it may go on.
 */
function upstreamRefusal(
  client: Socket,
  host: string,
  port: number,
  source: () => string | null,
): string | null {
  const from = (client.remoteAddress ?? "").replace(/^::ffff:/, "");
  const allowed = source();
  if (allowed === null || from !== allowed) {
    return `${from || "a client"} is not the Safe-Chain box; this listener serves only Safe-Chain`;
  }
  if (!SAFE_CHAIN_UPSTREAM_HOSTS.includes(host)) {
    return `${host} is not a host Safe-Chain reaches`;
  }
  if (port !== SAFE_CHAIN_TLS_PORT) {
    return `Safe-Chain reaches ${host} only on port ${SAFE_CHAIN_TLS_PORT}`;
  }
  return null;
}

function hostForUrl(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}

/**
 * Starts the web proxy on the box network's host address. Refuses a host address that is not an
 * IP literal, or the unspecified address, which would listen on every interface.
 */
export function startBoxWebProxy(
  options: BoxWebProxyOptions,
  deps: BoxWebProxyDeps,
): Promise<RunningBoxWebProxy> {
  return startWebProxy(
    {
      listenHost: options.network.hostAddress,
      boxHostAddress: () => options.network.hostAddress,
      kind: { box: options.safeChain },
      port: options.port ?? 0,
      connectTimeoutMs: WEB_PROXY_CONNECT_TIMEOUT_MS,
      limits: options.limits ?? {},
      admissions: options.admissions ?? null,
      tunnels: options.tunnels ?? null,
    },
    deps,
  );
}

export interface SafeChainUpstreamOptions {
  /** The box network; the listener is on its host address, as the box web proxy is. */
  readonly network: Pick<BoxNetwork, "hostAddress">;
  /** The Safe-Chain box's address, read for each connection; null: no connection is taken. */
  readonly source: () => string | null;
  /** Caps and idle timeout; each one left out takes its `WEB_PROXY_LIMITS` value. */
  readonly limits?: BoxWebProxyOptions["limits"];
}

/**
 * Starts the listener of Safe-Chain's own traffic (DIPO-343, file comment): on the box network's
 * host address, taking connections only from `options.source`, tunnelling only to
 * `SAFE_CHAIN_UPSTREAM_HOSTS` on the TLS port under the address rule.
 */
export function startSafeChainUpstreamProxy(
  options: SafeChainUpstreamOptions,
  deps: BoxWebProxyDeps,
): Promise<RunningBoxWebProxy> {
  return startWebProxy(
    {
      listenHost: options.network.hostAddress,
      boxHostAddress: () => options.network.hostAddress,
      kind: { upstream: options.source },
      port: 0,
      connectTimeoutMs: SAFE_CHAIN_UPSTREAM_CONNECT_TIMEOUT_MS,
      // Every connection comes from the one Safe-Chain box, so its cap is the overall one.
      limits: {
        maxConnectionsPerSource: options.limits?.maxConnections ?? WEB_PROXY_LIMITS.maxConnections,
        ...options.limits,
      },
      admissions: null,
      tunnels: null,
    },
    deps,
  );
}

/** Where one listener of the web proxy listens and what its address rule knows. */
interface WebProxyListener {
  readonly listenHost: string;
  /** The box network's host address for the address rule, read for each check; null: none. */
  readonly boxHostAddress: () => string | null;
  /**
   * Whose listener it is. A box's sends registry tunnels to the Safe-Chain box, refuses other
   * names of a registry and reads what a box sends into each direct tunnel (DIPO-281).
   * Safe-Chain's own (`upstream`, DIPO-343) takes only the Safe-Chain box and reaches only the
   * hosts it checks.
   */
  readonly kind:
    | { readonly box: () => SafeChainTarget | null }
    | { readonly upstream: () => string | null };
  readonly port: number;
  /** How long one upstream connection may take to open. */
  readonly connectTimeoutMs: number;
  readonly limits: NonNullable<BoxWebProxyOptions["limits"]>;
  /** The boxes and their listed local ports (DIPO-282); null: no local port is reachable. */
  readonly admissions: BoxAdmissions | null;
  /** Where registry tunnels are kept with their client box (DIPO-396); null: nowhere. */
  readonly tunnels: RegistryTunnels | null;
}

async function startWebProxy(
  options: WebProxyListener,
  deps: BoxWebProxyDeps,
): Promise<RunningBoxWebProxy> {
  const { listenHost, kind, admissions, tunnels } = options;
  const safeChain = "box" in kind ? kind.box : null;
  const upstreamSource = "upstream" in kind ? kind.upstream : null;
  const parsed = parseAddress(listenHost);
  if (
    parsed === null ||
    (parsed.family === 4 ? parsed.value === 0 : parsed.groups.every((g) => g === 0))
  ) {
    throw new Error(`the web proxy cannot listen on ${JSON.stringify(listenHost)}`);
  }
  const resolve = deps.resolve ?? systemResolve;
  const open = deps.connect ?? systemConnect;
  const interfaces = deps.interfaces ?? systemInterfaceAddresses;
  const emit = deps.onEvent ?? (() => {});
  const limits = { ...WEB_PROXY_LIMITS, ...options.limits };
  const sockets = new Set<Socket>();
  /** Open client connections per source address. */
  const clients = new Map<string, number>();
  let clientCount = 0;
  let stopped = false;

  const track = (socket: Socket): Socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    if (stopped) socket.destroy();
    return socket;
  };

  const refuse = (client: Socket, target: string, status: 400 | 403 | 405, reason: string) => {
    emit({ kind: "refused", target, reason });
    client.end(answer(status, status === 405 ? "Allow: CONNECT\r\n" : ""));
  };

  /** Opens a connection into the box network from its host address (`connectToBox`). */
  const openBox = (address: string, port: number): Socket =>
    connectToBox(
      { address, port, hostAddress: options.boxHostAddress() },
      deps.connectBox ??
        (deps.connect === undefined
          ? undefined
          : (target) =>
              (deps.connect as NonNullable<typeof deps.connect>)(target.host, target.port)),
    );

  /**
   * Opens an upstream to the first of `addresses` that answers (DIPO-383): one try at a time,
   * the next started after `WEB_PROXY_CONNECT_STAGGER_MS` or as soon as one fails, each within
   * the listener's deadline, so one dead address cannot hold a tunnel up. The first that opens wins
   * and every other try is closed. With none, `done` gets why each failed.
   */
  const connectFirst = (
    addresses: readonly string[],
    port: number,
    done: (upstream: Socket | null, address: string | null, failure: string) => void,
    opener: (address: string, port: number) => Socket = open,
  ) => {
    const deadlineMs = options.connectTimeoutMs;
    const failures: string[] = [];
    const tries = new Set<() => void>();
    let next = 0;
    let settled = false;
    let stagger: TimerHandle | null = null;
    const finish = (upstream: Socket | null, address: string | null) => {
      if (settled) return;
      settled = true;
      if (stagger !== null) deps.clock.clearTimeout(stagger);
      stagger = null;
      for (const close of tries) close();
      done(upstream, address, failures.join("; "));
    };
    const startNext = () => {
      if (settled) return;
      if (stagger !== null) deps.clock.clearTimeout(stagger);
      stagger = null;
      const address = addresses[next];
      if (address === undefined || stopped) {
        if (tries.size === 0) finish(null, null);
        return;
      }
      next += 1;
      let opened: Socket;
      try {
        opened = opener(address, port);
      } catch (error) {
        // Fail-closed: a connection that cannot leave the right way is not opened at all.
        failures.push(`${address}: ${error instanceof Error ? error.message : String(error)}`);
        finish(null, null);
        return;
      }
      const upstream = track(opened);
      let waiting = true;
      const end = () => {
        waiting = false;
        tries.delete(close);
        deps.clock.clearTimeout(timer);
      };
      const close = () => {
        end();
        upstream.destroy();
      };
      const fail = (why: string) => {
        if (!waiting) return;
        close();
        failures.push(`${address}: ${why}`);
        startNext();
      };
      const timer = deps.clock.setTimeout(() => fail(`no answer in ${deadlineMs} ms`), deadlineMs);
      tries.add(close);
      upstream.once("connect", () => {
        if (!waiting) return;
        end();
        finish(upstream, address);
      });
      upstream.once("error", (error: Error) => fail(error.message));
      upstream.once("close", () => fail("closed"));
      if (next < addresses.length) {
        stagger = deps.clock.setTimeout(startNext, WEB_PROXY_CONNECT_STAGGER_MS);
      }
    };
    startNext();
  };

  /** A tunnel to a listed local port of the Mac, on its loopback (DIPO-282). */
  const local = (client: Socket, headText: string, port: number, rest: Buffer) => {
    const target = `${BOX_LOCAL_HOST}:${port}`;
    if (admissions === null) {
      refuse(client, target, 403, "the Mac's local ports are reached only from a box");
      return;
    }
    const ports = admissions.portsOf(proxyPassword(headText));
    if (ports === null) {
      refuse(
        client,
        target,
        403,
        "the tunnel names no box dipo admitted, so it reaches no local port",
      );
      return;
    }
    if (!ports.includes(port)) {
      refuse(
        client,
        target,
        403,
        `port ${port} of the Mac is not listed in the office config (box.localPorts)`,
      );
      return;
    }
    connectFirst([LOOPBACK], port, (upstream) => {
      if (client.destroyed) {
        upstream?.destroy();
        return;
      }
      if (upstream === null) {
        client.end(answer(502));
        return;
      }
      emit({ kind: "local", port });
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      pipeSockets(client, upstream, rest, { clock: deps.clock, idleMs: limits.idleTimeoutMs });
    });
  };

  /**
   * A tunnel to a registry Safe-Chain checks: through the Safe-Chain box, on the port of the
   * registry's ecosystem, on the TLS port only; refused while no Safe-Chain box runs. Each one sent
   * to Safe-Chain is kept in `tunnels` with the box its proxy password names (DIPO-396), or none.
   */
  const registry = (
    client: Socket,
    asked: { readonly host: string; readonly port: number; readonly headText: string },
    rest: Buffer,
    safeChainOf: () => SafeChainTarget | null,
  ) => {
    const opened = deps.clock.now();
    const { host, port, headText } = asked;
    const target = `${host}:${port}`;
    if (port !== SAFE_CHAIN_TLS_PORT) {
      refuse(
        client,
        target,
        403,
        `a registry is reached only on port ${SAFE_CHAIN_TLS_PORT}, through Safe-Chain`,
      );
      return;
    }
    const box = safeChainOf();
    const ecosystem = ecosystemOf(host);
    if (box === null || ecosystem === null) {
      emit({
        kind: "refused",
        target,
        reason: "Safe-Chain is not running, so no registry is reached",
      });
      client.end(answer(503));
      return;
    }
    // Safe-Chain reads the CONNECT itself: it gets a fresh head with the normal host name and
    // none of the box's headers.
    const forwarded = Buffer.concat([
      Buffer.from(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`, "latin1"),
      rest,
    ]);
    connectFirst(
      [box.address],
      box.ports[ecosystem],
      (upstream) => {
        if (client.destroyed) {
          upstream?.destroy();
          return;
        }
        if (upstream === null) {
          emit({ kind: "refused", target, reason: "the Safe-Chain box did not answer" });
          client.end(answer(502));
          return;
        }
        // Only once the Safe-Chain box took it: a registry tunnel never goes anywhere else.
        emit({ kind: "registry", host, port });
        if (tunnels !== null) {
          const clientBox = admissions?.boxOf(proxyPassword(headText)) ?? null;
          client.once("close", tunnels.opened(clientBox, ecosystem, opened));
        }
        pipeSockets(client, upstream, forwarded, {
          clock: deps.clock,
          idleMs: limits.idleTimeoutMs,
        });
      },
      openBox,
    );
  };

  const tunnel = (client: Socket, head: Buffer, end: number) => {
    const headText = head.subarray(0, end).toString("latin1");
    const request = parseTunnelRequest(headText);
    if (!request.ok) {
      // The box's text, printable and short, for the log only.
      const line = head.subarray(0, Math.min(200, head.indexOf("\r\n"))).toString("latin1");
      refuse(client, line.replace(/[^\x20-\x7e]/g, "?"), request.status, request.reason);
      return;
    }
    const { host, port } = request;
    const target = `${host}:${port}`;
    const rest = head.subarray(end + 4);
    if (upstreamSource !== null) {
      const why = upstreamRefusal(client, host, port, upstreamSource);
      if (why !== null) {
        refuse(client, target, 403, why);
        return;
      }
    } else if (host === BOX_LOCAL_HOST) {
      local(client, headText, port, rest);
      return;
    }
    const boxListener = safeChain !== null;
    if (safeChain !== null && isRegistryHost(host)) {
      registry(client, { host, port, headText }, rest, safeChain);
      return;
    }
    const otherName = boxListener ? registryRefusal(host) : null;
    if (otherName !== null) {
      refuse(client, target, 403, otherName);
      return;
    }
    resolve(host).then(
      (addresses) => {
        if (stopped || client.destroyed) return;
        const context = {
          interfaces: interfaces(),
          boxHostAddress: options.boxHostAddress() ?? "",
          ...(deps.publicStandIns === undefined ? {} : { publicStandIns: deps.publicStandIns }),
        };
        const verdicts = addresses.map((address) => checkAddress(address, context));
        const refused = verdicts.find((verdict) => !verdict.ok);
        if (addresses.length === 0 || (refused !== undefined && !refused.ok)) {
          const why = refused !== undefined && !refused.ok ? refused.reason : "no address";
          refuse(client, target, 403, `${host} resolves to ${why}`);
          return;
        }
        const checked = verdicts.flatMap((verdict) => (verdict.ok ? [verdict.connectTo] : []));
        connectFirst(checked, port, (upstream, address, failure) => {
          if (client.destroyed) {
            upstream?.destroy();
            return;
          }
          if (upstream === null || address === null) {
            // Said, so a failed start of the web route shows where Safe-Chain's fetch ended (DIPO-383).
            emit({
              kind: "refused",
              target,
              reason: `no address of ${host} answered (${failure})`,
            });
            client.end(answer(502));
            return;
          }
          emit({ kind: "direct", host, port, address });
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          pipeSockets(
            client,
            upstream,
            rest,
            { clock: deps.clock, idleMs: limits.idleTimeoutMs },
            boxListener || upstreamSource !== null
              ? {
                  inspector: new TunnelInspector(host),
                  onRefused: (reason) => emit({ kind: "refused", target, reason }),
                }
              : undefined,
          );
        });
      },
      () => {
        if (!stopped) refuse(client, target, 403, `${host} does not resolve`);
      },
    );
  };

  const server: Server = createServer((client) => {
    track(client);
    const source = client.remoteAddress ?? "unknown";
    const fromSource = clients.get(source) ?? 0;
    if (clientCount >= limits.maxConnections || fromSource >= limits.maxConnectionsPerSource) {
      const which =
        clientCount >= limits.maxConnections
          ? `${limits.maxConnections} connections in all`
          : `${limits.maxConnectionsPerSource} connections from ${source}`;
      emit({ kind: "refused", target: source, reason: `over the cap of ${which}` });
      client.on("error", () => client.destroy());
      client.end(answer(503));
      return;
    }
    clientCount += 1;
    clients.set(source, fromSource + 1);
    client.once("close", () => {
      clientCount -= 1;
      const left = (clients.get(source) ?? 1) - 1;
      if (left > 0) clients.set(source, left);
      else clients.delete(source);
    });
    let head = Buffer.alloc(0);
    const timer = deps.clock.setTimeout(() => client.destroy(), WEB_PROXY_HEAD_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1 ? head.length > WEB_PROXY_HEAD_LIMIT : end > WEB_PROXY_HEAD_LIMIT) {
        client.destroy();
        return;
      }
      if (end === -1) return;
      deps.clock.clearTimeout(timer);
      client.off("data", onData);
      client.pause();
      tunnel(client, head, end);
    };
    client.on("data", onData);
    client.on("error", () => client.destroy());
    client.on("close", () => deps.clock.clearTimeout(timer));
  });

  await (deps.listen ?? systemListen)(server, listenHost, options.port);
  const address = server.address();
  const bound = typeof address === "object" && address !== null ? address : null;
  if (deps.listen === undefined && (bound === null || bound.port === 0)) {
    // dipo's own listen must bind a TCP port, or a proxy URL would name none.
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    throw new Error(`the web proxy did not bind a TCP port on ${listenHost}`);
  }
  const host = bound?.address ?? listenHost;
  const port = bound?.port ?? 0;
  let closed: Promise<void> | null = null;
  return {
    host,
    port,
    url: `http://${hostForUrl(host)}:${port}`,
    stop() {
      if (closed !== null) return closed;
      stopped = true;
      closed = new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      return closed;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Starting and stopping with the boxes.

/**
 * The web route the boxes share: started when the first box acquires it, stopped when the last
 * box releases it. Calls are handled one at a time, so a release never races a start.
 */
export class BoxWebRoute<T extends { stop(): Promise<void> }> {
  readonly #start: () => Promise<T>;
  readonly #users = new Set<string>();
  #running: T | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(start: () => Promise<T>) {
    this.#start = start;
  }

  /** The boxes using the route now. */
  get users(): readonly string[] {
    return [...this.#users];
  }

  get running(): boolean {
    return this.#running !== null;
  }

  #serial<R>(work: () => Promise<R>): Promise<R> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** Marks `box` as a user, starting the route for the first one. */
  acquire(box: string): Promise<T> {
    return this.#serial(async () => {
      if (this.#running === null) this.#running = await this.#start();
      this.#users.add(box);
      return this.#running;
    });
  }

  /** Drops `box` as a user, stopping the route after the last one. */
  release(box: string): Promise<void> {
    return this.#serial(async () => {
      if (!this.#users.delete(box) || this.#users.size > 0 || this.#running === null) return;
      const running = this.#running;
      this.#running = null;
      await running.stop();
    });
  }

  /** Stops the route whatever uses it (daemon shutdown). */
  close(): Promise<void> {
    return this.#serial(async () => {
      this.#users.clear();
      const running = this.#running;
      this.#running = null;
      await running?.stop();
    });
  }
}

/** The web proxy together with the Safe-Chain box behind it (DIPO-343). */
export interface RunningBoxWebRoute extends RunningBoxWebProxy {
  /** The Safe-Chain CA bundle on the Mac, for the box's package managers to trust. */
  readonly caFile: string;
  /**
   * Admits `box` with its office's listed local ports (DIPO-282) and returns the proxy URL the box
   * gets: `url` with the box's own proxy password. An earlier URL of the box stops naming it.
   */
  admit(box: string, ports: readonly number[]): string;
  /** The registry tunnels it sent to Safe-Chain, each with its client box (DIPO-396). */
  readonly tunnels: RegistryTunnels;
}

export type BoxWebRouteStart =
  | { readonly ok: true; readonly route: RunningBoxWebRoute }
  | { readonly ok: false; readonly reason: string };
