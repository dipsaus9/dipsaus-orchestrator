// The web route of the boxes (0021 section 3 and its amendment of 2026-10-21, DIPO-268): a
// CONNECT proxy, ported from the reviewed probe proxy (`tools/box-probe/web-proxy.ts`). A box sits
// on a host-only network with no route out; this proxy, listening only on the network's host
// address on the Mac, is its one way to the internet.
//
// - A tunnel to a package registry Safe-Chain checks (host name normalised: lower case, one
//   trailing dot dropped) goes to dipo's Safe-Chain proxy, and only on the TLS port.
// - Every other tunnel goes only to a public internet address. IP literals (also numeric forms such
//   as a bare decimal number) are refused, and so is a name that resolves to an address the rule
//   in `checkAddress` refuses: the Mac's own addresses and on-link prefixes, the box network,
//   private, shared, loopback, link-local, multicast and reserved ranges, NAT64 (64:ff9b::/96),
//   6to4 (2002::/16), Teredo, and IPv4-mapped forms of any refused IPv4 address. A name with any
//   refused address is refused as a whole.
// - The name is resolved once and the tunnel goes to an address that resolution returned and the
//   rule passed, as an IP literal, so nothing resolves it again (no DNS-rebinding gap).
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
// Known gaps:
// - A registry alias or another name on a registry's CDN reaches the registry directly (DIPO-281).
// - Listed local ports of the Mac are not allowed yet (DIPO-282).
// - The rule knows private hosts only by their address ranges, so two are not recognised (both
//   from the 0021 amendment of 2026-10-21): a private host on a public range reached through a
//   VPN's route, and the Mac's own public IPv4 address reached back through the router.

import { lookup } from "node:dns/promises";
import { connect, createServer, isIP, type Server, type Socket } from "node:net";
import { networkInterfaces } from "node:os";

import type { Clock, TimerHandle } from "@dipsaus-orchestrator/contract";

import {
  startSafeChainProxy,
  type SafeChainProxyDeps,
  type SafeChainProxyRequest,
} from "../platform/safe-chain-proxy";
import { SAFE_CHAIN_REGISTRY_HOSTS, SAFE_CHAIN_TLS_PORT } from "../sandbox/safe-chain-proxy";
import type { BoxNetwork } from "./port";

/** The longest request head read before a tunnel opens. */
export const WEB_PROXY_HEAD_LIMIT = 8 * 1024;
/** How long a client may take to send its request head. */
export const WEB_PROXY_HEAD_TIMEOUT_MS = 30_000;
/** How long one upstream connection may take to open. */
export const WEB_PROXY_CONNECT_TIMEOUT_MS = 30_000;
/** The connection caps and the idle timeout of a tunnel, unless the caller names others. */
export const WEB_PROXY_LIMITS = {
  /** Client connections open at once, over all boxes. */
  maxConnections: 512,
  /** Client connections open at once from one box (one source address on the box network). */
  maxConnectionsPerSource: 128,
  /** A tunnel with no traffic either way for this long is closed. */
  idleTimeoutMs: 10 * 60_000,
} as const;
/** Where dipo's Safe-Chain proxy listens (`startSafeChainProxy`). */
const SAFE_CHAIN_HOST = "127.0.0.1";

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
  | { readonly kind: "refused"; readonly target: string; readonly reason: string };

export interface BoxWebProxyOptions {
  /** The box network; the proxy listens only on its host address. */
  readonly network: Pick<BoxNetwork, "hostAddress">;
  /** dipo's Safe-Chain proxy on 127.0.0.1 (`RunningSafeChainProxy.port`). */
  readonly safeChainPort: number;
  /** The port to listen on; 0 (the default) takes a free one. */
  readonly port?: number;
  /** Caps and idle timeout; each one left out takes its `WEB_PROXY_LIMITS` value. */
  readonly limits?: Partial<{ -readonly [K in keyof typeof WEB_PROXY_LIMITS]: number }>;
}

export interface BoxWebProxyDeps {
  readonly clock: Clock;
  /** Resolves a host name to its addresses, once per tunnel. */
  readonly resolve?: (host: string) => Promise<readonly string[]>;
  /** Opens an upstream connection to an IP literal. */
  readonly connect?: (address: string, port: number) => Socket;
  /** The Mac's interface addresses, read for each check. */
  readonly interfaces?: () => readonly HostInterfaceAddress[];
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

/**
 * Joins a client and its upstream both ways; either side closing closes both, and so does no
 * traffic either way for `idleMs`.
 */
function pipeSockets(
  client: Socket,
  upstream: Socket,
  first: Buffer,
  clock: Clock,
  idleMs: number,
): void {
  if (first.length > 0) upstream.write(first);
  client.pipe(upstream);
  upstream.pipe(client);
  let last = clock.now();
  const touch = () => {
    last = clock.now();
  };
  let timer: TimerHandle | null = null;
  const arm = (delay: number) => {
    timer = clock.setTimeout(() => {
      const idle = clock.now() - last;
      if (idle >= idleMs) close();
      else arm(idleMs - idle);
    }, delay);
  };
  const close = () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    client.destroy();
    upstream.destroy();
  };
  client.on("data", touch);
  upstream.on("data", touch);
  arm(idleMs);
  client.on("error", close);
  upstream.on("error", close);
  client.on("close", close);
  upstream.on("close", close);
  client.resume();
}

function hostForUrl(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}

/**
 * Starts the web proxy on the box network's host address. Refuses a host address that is not an
 * IP literal, or the unspecified address, which would listen on every interface.
 */
export async function startBoxWebProxy(
  options: BoxWebProxyOptions,
  deps: BoxWebProxyDeps,
): Promise<RunningBoxWebProxy> {
  const listenHost = options.network.hostAddress;
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

  /** Opens an upstream to the first of `addresses` that answers, within the deadline each. */
  const connectFirst = (
    addresses: readonly string[],
    port: number,
    done: (upstream: Socket | null, address: string | null) => void,
  ) => {
    const [address, ...rest] = addresses;
    if (address === undefined || stopped) {
      done(null, null);
      return;
    }
    const upstream = track(open(address, port));
    let timer: TimerHandle | null = deps.clock.setTimeout(
      () => upstream.destroy(),
      WEB_PROXY_CONNECT_TIMEOUT_MS,
    );
    const settle = (ok: boolean) => {
      if (timer === null) return;
      deps.clock.clearTimeout(timer);
      timer = null;
      upstream.off("connect", onConnect);
      if (ok) {
        done(upstream, address);
      } else {
        upstream.destroy();
        connectFirst(rest, port, done);
      }
    };
    const onConnect = () => settle(true);
    upstream.once("connect", onConnect);
    upstream.once("error", () => settle(false));
    upstream.once("close", () => settle(false));
  };

  const tunnel = (client: Socket, head: Buffer, end: number) => {
    const request = parseTunnelRequest(head.subarray(0, end).toString("latin1"));
    if (!request.ok) {
      // The box's text, printable and short, for the log only.
      const line = head.subarray(0, Math.min(200, head.indexOf("\r\n"))).toString("latin1");
      refuse(client, line.replace(/[^\x20-\x7e]/g, "?"), request.status, request.reason);
      return;
    }
    const { host, port } = request;
    const target = `${host}:${port}`;
    const rest = head.subarray(end + 4);
    if (isRegistryHost(host)) {
      if (port !== SAFE_CHAIN_TLS_PORT) {
        refuse(
          client,
          target,
          403,
          `a registry is reached only on port ${SAFE_CHAIN_TLS_PORT}, through Safe-Chain`,
        );
        return;
      }
      // Safe-Chain reads the CONNECT itself: it gets a fresh head with the normal host name and
      // none of the box's headers.
      emit({ kind: "registry", host, port });
      const forwarded = Buffer.concat([
        Buffer.from(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`, "latin1"),
        rest,
      ]);
      connectFirst([SAFE_CHAIN_HOST], options.safeChainPort, (upstream) => {
        if (client.destroyed) {
          upstream?.destroy();
          return;
        }
        if (upstream === null) {
          client.end(answer(502));
          return;
        }
        pipeSockets(client, upstream, forwarded, deps.clock, limits.idleTimeoutMs);
      });
      return;
    }
    resolve(host).then(
      (addresses) => {
        if (stopped || client.destroyed) return;
        const context = {
          interfaces: interfaces(),
          boxHostAddress: listenHost,
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
        connectFirst(checked, port, (upstream, address) => {
          if (client.destroyed) {
            upstream?.destroy();
            return;
          }
          if (upstream === null || address === null) {
            client.end(answer(502));
            return;
          }
          emit({ kind: "direct", host, port, address });
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          pipeSockets(client, upstream, rest, deps.clock, limits.idleTimeoutMs);
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

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, listenHost, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  const bound = typeof address === "object" && address !== null ? address : null;
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

/** The web proxy together with the Safe-Chain proxy behind it. */
export interface RunningBoxWebRoute extends RunningBoxWebProxy {
  /** The Safe-Chain CA bundle, for the box's package managers to trust. */
  readonly caFile: string;
}

export type BoxWebRouteStart =
  | { readonly ok: true; readonly route: RunningBoxWebRoute }
  | { readonly ok: false; readonly reason: string };

/**
 * Starts dipo's Safe-Chain proxy and the web proxy in front of it; `stop` stops both. Fail-closed:
 * when either cannot start, what started is stopped and the reason returned.
 */
export async function startBoxWebRoute(
  network: Pick<BoxNetwork, "hostAddress">,
  safeChain: { readonly request: SafeChainProxyRequest; readonly deps: SafeChainProxyDeps },
  deps: BoxWebProxyDeps,
): Promise<BoxWebRouteStart> {
  const started = await startSafeChainProxy(safeChain.request, safeChain.deps);
  if (!started.ok) return { ok: false, reason: started.reason };
  let proxy: RunningBoxWebProxy;
  try {
    proxy = await startBoxWebProxy({ network, safeChainPort: started.proxy.port }, deps);
  } catch (error) {
    await started.proxy.stop();
    return {
      ok: false,
      reason: `the web proxy did not start: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    ok: true,
    route: {
      ...proxy,
      caFile: started.proxy.caFile,
      async stop() {
        try {
          await proxy.stop();
        } finally {
          await started.proxy.stop();
        }
      },
    },
  };
}
