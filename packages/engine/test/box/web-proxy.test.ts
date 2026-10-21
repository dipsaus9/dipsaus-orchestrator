// The web route of the boxes (DIPO-268): the address rule over every refused range (IPv6 forms
// included), host-name normalisation, the registry routing to Safe-Chain, the refusals, that a
// tunnel goes to the address resolution returned and the rule checked (no second lookup), that
// plain HTTP proxying is refused, the connection caps and the idle timeout, that stop destroys open
// tunnels, and that the route starts with the first box and stops with the last.
//
// The Mac's interfaces and the public stand-ins are documentation addresses: the Mac has
// 192.0.2.10/25 and 2001:db8:1::10/64, the box network is 198.51.100.1/24, and the rest of the
// documentation ranges play the public internet. The rule refuses documentation ranges; the tests
// lift that one refusal with `publicStandIns`. The proxy itself listens on loopback TCP, or on a
// Unix socket where the sandbox refuses loopback listens (DIPO-287), and its upstream connections
// are redirected to local test servers while the address asked for is kept.

import { connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "bun:test";

import { guardRuns, makeTempDir, ManualClock, removeTempDir } from "@dipsaus-orchestrator/testkit";

import {
  BoxWebRoute,
  type AddressContext,
  checkAddress,
  type HostInterfaceAddress,
  isRegistryHost,
  normaliseHost,
  parseTunnelRequest,
  type BoxWebProxyDeps,
  type BoxWebProxyOptions,
  type RunningBoxWebProxy,
  startBoxWebProxy,
  WEB_PROXY_HEAD_LIMIT,
  WEB_PROXY_HEAD_TIMEOUT_MS,
  WEB_PROXY_LIMITS,
  type WebProxyEvent,
} from "../../src/box/web-proxy";
import { SAFE_CHAIN_REGISTRY_HOSTS } from "../../src/sandbox/safe-chain-proxy";

const LOOPBACK = "127.0.0.1";
const BOX_HOST = "198.51.100.1";
const INTERFACES: readonly HostInterfaceAddress[] = [
  { address: "192.0.2.10", cidr: "192.0.2.10/25" },
  { address: "2001:db8:1::10", cidr: "2001:db8:1::10/64" },
  { address: BOX_HOST, cidr: `${BOX_HOST}/24` },
  { address: "fe80::1", cidr: "fe80::1/64" },
];
/** Every documentation prefix, as public stand-ins. */
const STAND_INS = [
  "192.0.2.0/24",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "2001:db8::/32",
  "3fff::/20",
];
const CONTEXT = { interfaces: INTERFACES, boxHostAddress: BOX_HOST, publicStandIns: STAND_INS };

function refusedBy(address: string, context: AddressContext = CONTEXT): string {
  const verdict = checkAddress(address, context);
  if (verdict.ok) throw new Error(`${address} passed, to ${verdict.connectTo}`);
  return verdict.reason;
}

describe("the address rule", () => {
  it("refuses every non-public IPv4 range, at both ends", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["0.0.0.0", "this network"],
      ["0.255.255.255", "this network"],
      ["10.0.0.0", "a private range"],
      ["10.255.255.255", "a private range"],
      ["100.64.0.0", "the shared address space"],
      ["100.127.255.255", "the shared address space"],
      ["127.0.0.1", "loopback"],
      ["127.255.255.255", "loopback"],
      ["169.254.0.0", "link-local"],
      ["169.254.255.255", "link-local"],
      ["172.16.0.0", "a private range"],
      ["172.31.255.255", "a private range"],
      ["192.0.0.0", "the IETF protocol assignments"],
      ["192.0.0.255", "the IETF protocol assignments"],
      ["192.88.99.0", "the 6to4 relay anycast range"],
      ["192.168.0.0", "a private range"],
      ["192.168.255.255", "a private range"],
      ["198.18.0.0", "the benchmarking range"],
      ["198.19.255.255", "the benchmarking range"],
      ["224.0.0.0", "multicast"],
      ["239.255.255.255", "multicast"],
      ["240.0.0.0", "a reserved range"],
      ["255.255.255.255", "a reserved range"],
    ];
    for (const [address, why] of cases) {
      expect(refusedBy(address)).toBe(`${address} is ${why}`);
    }
  });

  it("refuses the IPv4-mapped IPv6 form of every refused IPv4 address, in both notations", () => {
    expect(refusedBy("::ffff:127.0.0.1")).toBe("::ffff:127.0.0.1 is IPv4-mapped, loopback");
    expect(refusedBy("::ffff:7f00:1")).toBe("::ffff:7f00:1 is IPv4-mapped, loopback");
    expect(refusedBy("::FFFF:10.1.2.3")).toBe("::FFFF:10.1.2.3 is IPv4-mapped, a private range");
    expect(refusedBy("0:0:0:0:0:ffff:a9fe:a9fe")).toContain("IPv4-mapped, link-local");
    expect(refusedBy("::ffff:100.64.0.1")).toContain("IPv4-mapped, the shared address space");
    expect(refusedBy("::ffff:224.0.0.1")).toContain("IPv4-mapped, multicast");
    // The Mac's own addresses and the box network in mapped form.
    expect(refusedBy("::ffff:192.0.2.10")).toContain("one of the Mac's own addresses");
    expect(refusedBy("::ffff:198.51.100.9")).toContain("on the box network");
  });

  it("passes the IPv4-mapped form of a public address and connects to its IPv4 address", () => {
    expect(checkAddress("::ffff:203.0.113.7", CONTEXT)).toEqual({
      ok: true,
      connectTo: "203.0.113.7",
    });
    expect(checkAddress("::ffff:cb00:7107", CONTEXT)).toEqual({
      ok: true,
      connectTo: "203.0.113.7",
    });
  });

  it("refuses every IPv6 range that is not the public internet or embeds an IPv4 address", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["::", "the unspecified address"],
      ["::1", "loopback"],
      ["::203.0.113.7", "an IPv4-compatible address"],
      ["::ffff:0:cb00:7107", "an IPv4-translated address"],
      ["64:ff9b::203.0.113.7", "NAT64 (64:ff9b::/96)"],
      ["64:ff9b::7f00:1", "NAT64 (64:ff9b::/96)"],
      ["64:ff9b:1::1", "local-use NAT64"],
      ["100::1", "the discard range"],
      ["2001::1", "the IETF protocol assignments (Teredo among them)"],
      ["2001:0:4136:e378:8000:63bf:3fff:fdd2", "the IETF protocol assignments (Teredo among them)"],
      ["2001:1ff:ffff::1", "the IETF protocol assignments (Teredo among them)"],
      ["2002::1", "6to4 (2002::/16)"],
      ["2002:c000:0201::1", "6to4 (2002::/16)"],
      ["2002:7f00:1::1", "6to4 (2002::/16)"],
      ["fc00::1", "a unique local range"],
      ["fdff:ffff::1", "a unique local range"],
      ["fe80:0:0:1::1234", "link-local"],
      ["fe80:0:0:1::5%en0", "link-local"],
      ["febf::1", "link-local"],
      ["fec0::1", "site-local"],
      ["ff02::1", "multicast"],
      ["FF0E::1", "multicast"],
      ["4000::1", "not a global unicast address"],
      ["1fff::1", "not a global unicast address"],
    ];
    for (const [address, why] of cases) {
      expect(refusedBy(address)).toBe(`${address} is ${why}`);
    }
  });

  it("refuses the Mac's own addresses and its on-link prefixes", () => {
    expect(refusedBy("192.0.2.10")).toBe("192.0.2.10 is one of the Mac's own addresses");
    expect(refusedBy("192.0.2.100")).toBe(
      "192.0.2.100 is in an on-link prefix of the Mac (192.0.2.10/25)",
    );
    expect(refusedBy("2001:db8:1::10")).toBe("2001:db8:1::10 is one of the Mac's own addresses");
    expect(refusedBy("2001:db8:1:0:ffff::1")).toBe(
      "2001:db8:1:0:ffff::1 is in an on-link prefix of the Mac (2001:db8:1::10/64)",
    );
    // Just outside the prefixes.
    expect(checkAddress("192.0.2.200", CONTEXT)).toEqual({ ok: true, connectTo: "192.0.2.200" });
    expect(checkAddress("2001:db8:1:1::1", CONTEXT)).toEqual({
      ok: true,
      connectTo: "2001:db8:1:1::1",
    });
  });

  it("draws an on-link prefix exactly at its length", () => {
    const narrow = {
      interfaces: [{ address: "192.0.2.1", cidr: "192.0.2.1/25" }],
      boxHostAddress: BOX_HOST,
      publicStandIns: STAND_INS,
    };
    expect(refusedBy("192.0.2.127", narrow)).toContain("on-link prefix");
    expect(checkAddress("192.0.2.128", narrow)).toEqual({ ok: true, connectTo: "192.0.2.128" });
    const v6 = {
      interfaces: [{ address: "2001:db8::1", cidr: "2001:db8::1/63" }],
      boxHostAddress: BOX_HOST,
      publicStandIns: STAND_INS,
    };
    expect(refusedBy("2001:db8:0:1::1", v6)).toContain("on-link prefix");
    expect(checkAddress("2001:db8:0:2::1", v6)).toEqual({ ok: true, connectTo: "2001:db8:0:2::1" });
  });

  it("refuses the box network, by its interface's prefix or, without one, a /24", () => {
    expect(refusedBy(BOX_HOST)).toBe(`${BOX_HOST} is on the box network`);
    expect(refusedBy("198.51.100.250")).toBe("198.51.100.250 is on the box network");
    const unlisted = { interfaces: [], boxHostAddress: BOX_HOST, publicStandIns: STAND_INS };
    expect(refusedBy("198.51.100.250", unlisted)).toBe("198.51.100.250 is on the box network");
    expect(checkAddress("203.0.113.1", unlisted)).toEqual({ ok: true, connectTo: "203.0.113.1" });
  });

  it("refuses the documentation ranges unless a test names them as public stand-ins", () => {
    const plain = { interfaces: [], boxHostAddress: "2001:db8:ffff::1" };
    for (const address of [
      "192.0.2.77",
      "198.51.100.7",
      "203.0.113.7",
      "::ffff:203.0.113.7",
      "2001:db8::7",
      "3fff::7",
      "3fff:fff::7",
    ]) {
      expect(refusedBy(address, plain)).toEndWith("a documentation range");
    }
    // A stand-in lifts only the documentation refusal, never another range.
    const lifted = { ...plain, publicStandIns: ["10.0.0.0/8", "fc00::/7", "203.0.113.0/25"] };
    expect(refusedBy("10.1.2.3", lifted)).toBe("10.1.2.3 is a private range");
    expect(refusedBy("fd00::1", lifted)).toBe("fd00::1 is a unique local range");
    expect(checkAddress("203.0.113.7", lifted)).toEqual({ ok: true, connectTo: "203.0.113.7" });
    expect(refusedBy("203.0.113.200", lifted)).toBe("203.0.113.200 is a documentation range");
  });

  it("passes public addresses of both families", () => {
    expect(checkAddress("203.0.113.7", CONTEXT)).toEqual({ ok: true, connectTo: "203.0.113.7" });
    expect(checkAddress("2001:db8:2::7", CONTEXT)).toEqual({
      ok: true,
      connectTo: "2001:db8:2::7",
    });
  });

  it("refuses what is not an IP address", () => {
    expect(refusedBy("example.com")).toBe("example.com is not an IP address");
    expect(refusedBy("")).toBe(" is not an IP address");
  });
});

describe("host names and the request line", () => {
  it("normalises a host name: lower case, one trailing dot dropped", () => {
    expect(normaliseHost("Registry.NPMJS.org.")).toBe("registry.npmjs.org");
    expect(normaliseHost("example.com")).toBe("example.com");
    expect(normaliseHost("a_b-c.example")).toBe("a_b-c.example");
    expect(normaliseHost("registry.npmjs.org..")).toBeNull();
    expect(normaliseHost("")).toBeNull();
    expect(normaliseHost(".")).toBeNull();
    expect(normaliseHost("exa mple.com")).toBeNull();
    expect(normaliseHost(`${"a".repeat(64)}.example`)).toBeNull();
  });

  it("treats IP literals, numeric forms included, as no host name", () => {
    for (const literal of [
      "192.0.2.1",
      "192.0.2.1.",
      "2001:db8::1",
      "3221225985",
      "0xc0.2.1",
      "192.0.513",
      "0x7f",
    ]) {
      expect(normaliseHost(literal)).toBeNull();
    }
  });

  it("asks for a tunnel only with CONNECT to a host name and a valid port", () => {
    expect(parseTunnelRequest("CONNECT example.com:443 HTTP/1.1\r\nHost: x")).toEqual({
      ok: true,
      host: "example.com",
      port: 443,
    });
    expect(parseTunnelRequest("CONNECT Example.COM.:8443 HTTP/1.0")).toEqual({
      ok: true,
      host: "example.com",
      port: 8443,
    });
    expect(parseTunnelRequest("CONNECT [2001:db8::1]:443 HTTP/1.1")).toMatchObject({
      ok: false,
      status: 403,
      reason: "[2001:db8::1]:443 is an IP address, not a host name",
    });
    expect(parseTunnelRequest("CONNECT 192.0.2.1:443 HTTP/1.1")).toMatchObject({
      ok: false,
      status: 403,
      reason: "192.0.2.1 is an IP address, not a host name",
    });
    expect(parseTunnelRequest("CONNECT 3221225985:443 HTTP/1.1")).toMatchObject({
      ok: false,
      status: 403,
      reason: "3221225985 is an IP address, not a host name",
    });
    expect(parseTunnelRequest("CONNECT ::1:443 HTTP/1.1")).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(parseTunnelRequest("CONNECT bad_host!:443 HTTP/1.1")).toMatchObject({
      ok: false,
      status: 403,
      reason: "bad_host! is not a host name",
    });
    for (const authority of [
      "example.com:0",
      "example.com:65536",
      "example.com",
      "example.com:x",
    ]) {
      expect(parseTunnelRequest(`CONNECT ${authority} HTTP/1.1`)).toMatchObject({
        ok: false,
        status: 400,
      });
    }
    expect(parseTunnelRequest("GET http://example.com/ HTTP/1.1")).toMatchObject({
      ok: false,
      status: 405,
    });
    expect(parseTunnelRequest("hello")).toMatchObject({ ok: false, status: 400 });
  });

  it("knows every registry Safe-Chain checks", () => {
    for (const host of SAFE_CHAIN_REGISTRY_HOSTS) expect(isRegistryHost(host)).toBe(true);
    expect(isRegistryHost("example.com")).toBe(false);
    expect(isRegistryHost("registry.npmjs.org.example.com")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The proxy over real sockets, on two transports (DIPO-287): TCP on loopback, the way the proxy
// listens in dipo, and Unix sockets under the test temp root, through the proxy's `listen` seam.
// dipo's verify step on macOS runs under Seatbelt with a closed network, which refuses loopback TCP
// listens but allows Unix sockets under the step's temp root; there only the Unix transport runs.
// Everywhere else (CI's Linux run, a plain `bun test` on the Mac) both run.

/** Where a test server listens: a loopback TCP port, or a Unix socket path. */
type Endpoint = number | string;

function dial(endpoint: Endpoint, onConnect?: () => void): Socket {
  return typeof endpoint === "number"
    ? connect(endpoint, LOOPBACK, onConnect)
    : connect(endpoint, onConnect);
}

interface Transport {
  readonly name: string;
  readonly runs: boolean;
  /** Binds a test server and resolves with where it listens. */
  listen(server: Server): Promise<Endpoint>;
  /** An endpoint nothing listens on. */
  closed(): Promise<Endpoint>;
  /** Starts the proxy on this transport and resolves with it and where clients reach it. */
  startProxy(
    options: BoxWebProxyOptions,
    deps: BoxWebProxyDeps,
  ): Promise<{ proxy: RunningBoxWebProxy; endpoint: Endpoint }>;
}

function tcpListen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK, () => {
      server.off("error", reject);
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
}

function unixListen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

/**
 * True only on macOS when a TCP listen on loopback is refused: dipo's verify step there runs under
 * Seatbelt with a closed network (DIPO-114, DIPO-287). A Linux step gets a loopback of its own, so
 * on Linux a refused loopback listen still fails the TCP tests.
 */
async function sandboxRefusesLoopback(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const probe = createServer();
  try {
    await tcpListen(probe);
  } catch {
    return true;
  }
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return false;
}

const TCP_RUNS = guardRuns(
  "SANDBOX_REFUSES_LOOPBACK",
  "the sandbox refuses loopback TCP listens, so the web proxy runs over Unix sockets only",
  !(await sandboxRefusesLoopback()),
);

const servers: Server[] = [];
const proxies: RunningBoxWebProxy[] = [];
/** The directory of the Unix sockets, made on first use. */
let socketDir: string | null = null;
let socketCount = 0;

/** A fresh, short Unix socket path under the test temp root. */
function socketPath(): string {
  socketDir ??= makeTempDir();
  socketCount += 1;
  return join(socketDir, `s${socketCount}.sock`);
}

const TCP: Transport = {
  name: "TCP on loopback",
  runs: TCP_RUNS,
  listen: tcpListen,
  /** A local port with nothing listening on it. */
  async closed() {
    const server = createServer();
    const port = await tcpListen(server);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  },
  async startProxy(options, deps) {
    // No `listen` seam: the proxy's own TCP listen is what this transport tests.
    const proxy = await startBoxWebProxy(options, deps);
    return { proxy, endpoint: proxy.port };
  },
};

const UNIX: Transport = {
  name: "Unix sockets",
  runs: true,
  async listen(server) {
    const path = socketPath();
    await unixListen(server, path);
    return path;
  },
  async closed() {
    return socketPath();
  },
  async startProxy(options, deps) {
    const path = socketPath();
    const proxy = await startBoxWebProxy(options, {
      ...deps,
      listen: (server) => unixListen(server, path),
    });
    return { proxy, endpoint: path };
  },
};

afterEach(async () => {
  for (const proxy of proxies.splice(0)) await proxy.stop();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

afterAll(() => {
  if (socketDir !== null) removeTempDir(socketDir);
});

/** An upstream that answers each chunk with `upstream:<chunk>` and keeps the tunnel open. */
async function echoServer(
  transport: Transport,
): Promise<{ endpoint: Endpoint; sockets: Socket[] }> {
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on("data", (chunk) => socket.write(`upstream:${chunk.toString("latin1")}`));
    socket.on("error", () => {});
  });
  servers.push(server);
  return { endpoint: await transport.listen(server), sockets };
}

/** A stand-in for dipo's Safe-Chain proxy: records the head it gets, then echoes. */
async function fakeSafeChain(
  transport: Transport,
): Promise<{ endpoint: Endpoint; heads: string[] }> {
  const heads: string[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    let open = false;
    socket.on("data", (chunk) => {
      if (open) {
        socket.write(`safe-chain:${chunk.toString("latin1")}`);
        return;
      }
      buffer += chunk.toString("latin1");
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      heads.push(buffer.slice(0, end + 4));
      open = true;
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const rest = buffer.slice(end + 4);
      if (rest !== "") socket.write(`safe-chain:${rest}`);
    });
    socket.on("error", () => {});
  });
  servers.push(server);
  return { endpoint: await transport.listen(server), heads };
}

/** The Safe-Chain port the proxy is given when the fake Safe-Chain listens on a Unix socket. */
const SAFE_CHAIN_STAND_IN_PORT = 1;

interface Harness {
  readonly proxy: RunningBoxWebProxy;
  /** Where clients reach the proxy. */
  readonly endpoint: Endpoint;
  readonly clock: ManualClock;
  readonly events: WebProxyEvent[];
  /** Every upstream connection the proxy asked for, as `address:port`. */
  readonly connects: string[];
  /** Every host name the proxy resolved. */
  readonly lookups: string[];
  /** The fake Safe-Chain, and the port the proxy knows it by. */
  readonly safeChain: { port: number; heads: string[] };
  readonly upstream: { endpoint: Endpoint; sockets: Socket[] };
}

/**
 * A proxy on `transport` whose resolver answers from `dns` (each entry a list per call, the last
 * repeated), whose Mac has INTERFACES, and whose upstreams land on local test servers: Safe-Chain's
 * port on the fake Safe-Chain, addresses in `dead` on an endpoint nothing listens on, anything else
 * on the echo server. The address and port asked for are kept in `connects`.
 */
async function harness(
  transport: Transport,
  dns: Record<string, ReadonlyArray<readonly string[]>> = {},
  dead: readonly string[] = [],
  limits: BoxWebProxyOptions["limits"] = {},
): Promise<Harness> {
  const clock = new ManualClock();
  const events: WebProxyEvent[] = [];
  const connects: string[] = [];
  const lookups: string[] = [];
  const fake = await fakeSafeChain(transport);
  const safeChainPort =
    typeof fake.endpoint === "number" ? fake.endpoint : SAFE_CHAIN_STAND_IN_PORT;
  const upstream = await echoServer(transport);
  const closed = await transport.closed();
  const { proxy, endpoint } = await transport.startProxy(
    { network: { hostAddress: LOOPBACK }, safeChainPort, limits },
    {
      clock,
      publicStandIns: STAND_INS,
      onEvent: (event) => events.push(event),
      interfaces: () => INTERFACES,
      resolve: async (host) => {
        const seen = lookups.filter((name) => name === host).length;
        lookups.push(host);
        const answers = dns[host];
        if (answers === undefined) throw new Error(`${host} does not resolve`);
        return answers[Math.min(seen, answers.length - 1)] ?? [];
      },
      connect: (address, port) => {
        connects.push(`${address}:${port}`);
        if (address === LOOPBACK && port === safeChainPort) return dial(fake.endpoint);
        return dial(dead.includes(address) ? closed : upstream.endpoint);
      },
    },
  );
  proxies.push(proxy);
  return {
    proxy,
    endpoint,
    clock,
    events,
    connects,
    lookups,
    safeChain: { port: safeChainPort, heads: fake.heads },
    upstream,
  };
}

/**
 * Sends `head` to the proxy, then `payload` once a 200 comes back. Resolves with everything
 * received when `until` matches it or the connection closes, and closes the client.
 */
function exchange(
  endpoint: Endpoint,
  head: string,
  options: { payload?: string; until?: (text: string) => boolean } = {},
): Promise<{ text: string; closed: boolean; socket: Socket }> {
  return new Promise((resolve) => {
    const socket = dial(endpoint, () => socket.write(head));
    let text = "";
    let sent = false;
    let done = false;
    const finish = (closed: boolean) => {
      if (done) return;
      done = true;
      resolve({ text, closed, socket });
    };
    socket.on("data", (chunk) => {
      text += chunk.toString("latin1");
      if (
        !sent &&
        options.payload !== undefined &&
        text.includes("\r\n\r\n") &&
        text.startsWith("HTTP/1.1 200")
      ) {
        sent = true;
        socket.write(options.payload);
      }
      if (options.until?.(text) === true) finish(false);
    });
    socket.on("error", () => {});
    socket.on("close", () => finish(true));
  });
}

/** Whether a new connection to `endpoint` is taken. */
function reachable(endpoint: Endpoint): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = dial(endpoint);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

const connectHead = (target: string, extra = "") =>
  `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${extra}\r\n`;

for (const transport of [TCP, UNIX]) {
  describe.skipIf(!transport.runs)(`the web proxy over ${transport.name}`, () => {
    it("listens on the box network's host address and refuses to listen on every interface", async () => {
      const { proxy, endpoint } = await harness(transport);
      expect(proxy.host).toBe(LOOPBACK);
      expect(proxy.port).toBe(typeof endpoint === "number" ? endpoint : 0);
      expect(proxy.url).toBe(`http://${LOOPBACK}:${proxy.port}`);
      const clock = new ManualClock();
      for (const hostAddress of ["0.0.0.0", "::", "", "not-an-address"]) {
        await expect(
          startBoxWebProxy({ network: { hostAddress }, safeChainPort: 1 }, { clock }),
        ).rejects.toThrow("the web proxy cannot listen on");
      }
    });

    it("tunnels to the address it resolved and checked, and never resolves the name again", async () => {
      // A rebinding name: public on the first answer, loopback on every later one.
      const h = await harness(transport, { "rebind.example": [["203.0.113.7"], [LOOPBACK]] });
      const result = await exchange(h.endpoint, connectHead("rebind.example:443"), {
        payload: "ping",
        until: (text) => text.includes("upstream:ping"),
      });
      expect(result.text).toStartWith("HTTP/1.1 200 Connection Established\r\n\r\n");
      expect(result.text).toContain("upstream:ping");
      expect(h.lookups).toEqual(["rebind.example"]);
      expect(h.connects).toEqual(["203.0.113.7:443"]);
      expect(h.events).toEqual([
        { kind: "direct", host: "rebind.example", port: 443, address: "203.0.113.7" },
      ]);
      result.socket.destroy();
    });

    it("connects to the IPv4 address of an IPv4-mapped answer, and to an IPv6 one as given", async () => {
      const h = await harness(transport, {
        "mapped.example": [["::ffff:203.0.113.8"]],
        "six.example": [["2001:db8:2::8"]],
      });
      for (const host of ["mapped.example", "six.example"]) {
        const result = await exchange(h.endpoint, connectHead(`${host}:443`), {
          payload: "x",
          until: (text) => text.includes("upstream:x"),
        });
        result.socket.destroy();
      }
      expect(h.connects).toEqual(["203.0.113.8:443", "2001:db8:2::8:443"]);
    });

    it("tries the next checked address when one does not answer", async () => {
      const h = await harness(transport, { "two.example": [["203.0.113.9", "203.0.113.10"]] }, [
        "203.0.113.9",
      ]);
      const result = await exchange(h.endpoint, connectHead("two.example:443"), {
        payload: "ping",
        until: (text) => text.includes("upstream:ping"),
      });
      expect(result.text).toContain("upstream:ping");
      expect(h.connects).toEqual(["203.0.113.9:443", "203.0.113.10:443"]);
      result.socket.destroy();
    });

    it("answers 502 when no checked address answers", async () => {
      const h = await harness(transport, { "down.example": [["203.0.113.9"]] }, ["203.0.113.9"]);
      const result = await exchange(h.endpoint, connectHead("down.example:443"));
      expect(result.text).toStartWith("HTTP/1.1 502 Bad Gateway");
    });

    it("refuses a name with any refused address, before connecting", async () => {
      const h = await harness(transport, {
        "mixed.example": [["203.0.113.7", "10.0.0.1"]],
        "mac.example": [["192.0.2.10"]],
        "lan.example": [["192.0.2.33"]],
        "loopback.example": [["::1"]],
        "nat64.example": [["64:ff9b::a00:1"]],
        "sixtofour.example": [["2002:c000:0201::1"]],
        "mapped.example": [["::ffff:10.0.0.1"]],
        "empty.example": [[]],
      });
      const hosts = [
        "mixed.example",
        "mac.example",
        "lan.example",
        "loopback.example",
        "nat64.example",
        "sixtofour.example",
        "mapped.example",
        "empty.example",
        "nowhere.example",
      ];
      for (const host of hosts) {
        const result = await exchange(h.endpoint, connectHead(`${host}:443`));
        expect(result.text).toStartWith("HTTP/1.1 403 Forbidden\r\n");
        expect(result.closed).toBe(true);
      }
      expect(h.connects).toEqual([]);
      const reasons = h.events.map((event) =>
        event.kind === "refused" ? event.reason : event.kind,
      );
      expect(reasons).toEqual([
        "mixed.example resolves to 10.0.0.1 is a private range",
        "mac.example resolves to 192.0.2.10 is one of the Mac's own addresses",
        "lan.example resolves to 192.0.2.33 is in an on-link prefix of the Mac (192.0.2.10/25)",
        "loopback.example resolves to ::1 is loopback",
        "nat64.example resolves to 64:ff9b::a00:1 is NAT64 (64:ff9b::/96)",
        "sixtofour.example resolves to 2002:c000:0201::1 is 6to4 (2002::/16)",
        "mapped.example resolves to ::ffff:10.0.0.1 is IPv4-mapped, a private range",
        "empty.example resolves to no address",
        "nowhere.example does not resolve",
      ]);
    });

    it("refuses IP literals without resolving them", async () => {
      const h = await harness(transport);
      for (const target of [
        "192.0.2.1:443",
        "[2001:db8::1]:443",
        "3221225985:443",
        "203.0.113.7.:443",
      ]) {
        const result = await exchange(h.endpoint, connectHead(target));
        expect(result.text).toStartWith("HTTP/1.1 403 Forbidden\r\n");
      }
      expect(h.lookups).toEqual([]);
      expect(h.connects).toEqual([]);
    });

    it("sends registry tunnels to Safe-Chain with the host name normalised and none of the box's headers", async () => {
      const h = await harness(transport);
      const npm = await exchange(
        h.endpoint,
        connectHead("Registry.NPMJS.org.:443", "Proxy-Authorization: Basic c2VjcmV0\r\n"),
        { payload: "hello", until: (text) => text.includes("safe-chain:hello") },
      );
      expect(npm.text).toStartWith("HTTP/1.1 200 Connection Established\r\n\r\n");
      npm.socket.destroy();
      const pypi = await exchange(h.endpoint, connectHead("files.pythonhosted.org:443"), {
        payload: "hi",
        until: (text) => text.includes("safe-chain:hi"),
      });
      pypi.socket.destroy();
      expect(h.safeChain.heads).toEqual([
        "CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n",
        "CONNECT files.pythonhosted.org:443 HTTP/1.1\r\nHost: files.pythonhosted.org:443\r\n\r\n",
      ]);
      expect(h.lookups).toEqual([]);
      expect(h.connects).toEqual([
        `${LOOPBACK}:${h.safeChain.port}`,
        `${LOOPBACK}:${h.safeChain.port}`,
      ]);
      expect(h.events).toEqual([
        { kind: "registry", host: "registry.npmjs.org", port: 443 },
        { kind: "registry", host: "files.pythonhosted.org", port: 443 },
      ]);
    });

    it("refuses a registry on any port but the TLS port, so it never goes direct", async () => {
      const h = await harness(transport, { "registry.npmjs.org": [["203.0.113.7"]] });
      const result = await exchange(h.endpoint, connectHead("registry.npmjs.org:80"));
      expect(result.text).toStartWith("HTTP/1.1 403 Forbidden\r\n");
      expect(h.lookups).toEqual([]);
      expect(h.connects).toEqual([]);
    });

    it("refuses plain HTTP proxying with 405, so it is no open forward proxy", async () => {
      const h = await harness(transport, { "example.com": [["203.0.113.7"]] });
      const result = await exchange(
        h.endpoint,
        "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n",
      );
      expect(result.text).toStartWith("HTTP/1.1 405 Method Not Allowed\r\nAllow: CONNECT\r\n");
      expect(result.closed).toBe(true);
      expect(h.lookups).toEqual([]);
      expect(h.connects).toEqual([]);
    });

    it("closes a client whose head is too long or too slow", async () => {
      const h = await harness(transport);
      const long = await exchange(h.endpoint, `CONNECT ${"a".repeat(WEB_PROXY_HEAD_LIMIT + 10)}`);
      expect(long).toMatchObject({ text: "", closed: true });
      // A whole head at once that is still too long.
      const padded = await exchange(
        h.endpoint,
        connectHead("example.com:443", `X-Pad: ${"a".repeat(WEB_PROXY_HEAD_LIMIT)}\r\n`),
      );
      expect(padded).toMatchObject({ text: "", closed: true });
      const slow = exchange(h.endpoint, "CONNECT example.com:443 HTTP/1.1\r\n");
      await Bun.sleep(50);
      h.clock.advance(WEB_PROXY_HEAD_TIMEOUT_MS);
      expect(await slow).toMatchObject({ text: "", closed: true });
      expect(h.connects).toEqual([]);
    });

    it("caps client connections per box source address, and takes one again once a slot frees", async () => {
      const h = await harness(transport, { "open.example": [["203.0.113.7"]] }, [], {
        maxConnectionsPerSource: 1,
      });
      const tunnel = (head = connectHead("open.example:443")) =>
        exchange(h.endpoint, head, {
          payload: "ping",
          until: (text) => text.includes("upstream:ping"),
        });
      const first = await tunnel();
      expect(first.text).toContain("upstream:ping");
      const second = await tunnel();
      expect(second.text).toStartWith("HTTP/1.1 503 Service Unavailable\r\n");
      expect(second.closed).toBe(true);
      expect(h.events.at(-1)).toMatchObject({ kind: "refused" });
      expect(h.events.at(-1)).toHaveProperty("reason", expect.stringContaining("connections from"));
      first.socket.destroy();
      let third = await tunnel();
      for (let i = 0; i < 50 && third.text.startsWith("HTTP/1.1 503"); i += 1) {
        await Bun.sleep(10);
        third = await tunnel();
      }
      expect(third.text).toContain("upstream:ping");
      third.socket.destroy();
    });

    it("caps client connections over all boxes", async () => {
      const h = await harness(transport, { "open.example": [["203.0.113.7"]] }, [], {
        maxConnections: 1,
      });
      const first = await exchange(h.endpoint, connectHead("open.example:443"), {
        payload: "ping",
        until: (text) => text.includes("upstream:ping"),
      });
      const second = await exchange(h.endpoint, connectHead("open.example:443"));
      expect(second.text).toStartWith("HTTP/1.1 503 Service Unavailable\r\n");
      expect(h.events.at(-1)).toEqual({
        kind: "refused",
        target: expect.any(String),
        reason: "over the cap of 1 connections in all",
      });
      first.socket.destroy();
    });

    it("closes a tunnel with no traffic for the idle timeout, counting traffic either way", async () => {
      expect(WEB_PROXY_LIMITS).toEqual({
        maxConnections: 512,
        maxConnectionsPerSource: 128,
        idleTimeoutMs: 600_000,
      });
      const h = await harness(transport, { "idle.example": [["203.0.113.7"]] }, [], {
        idleTimeoutMs: 1_000,
      });
      const result = await exchange(h.endpoint, connectHead("idle.example:443"), {
        payload: "ping",
        until: (text) => text.includes("upstream:ping"),
      });
      const socket = result.socket;
      const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      h.clock.advance(900);
      const echoed = new Promise<void>((resolve) => {
        const onData = (chunk: Buffer) => {
          if (chunk.toString("latin1").includes("upstream:more")) {
            socket.off("data", onData);
            resolve();
          }
        };
        socket.on("data", onData);
      });
      socket.write("more");
      await echoed;
      h.clock.advance(900);
      await Bun.sleep(20);
      expect(socket.destroyed).toBe(false);
      h.clock.advance(100);
      await closed;
      expect(socket.destroyed).toBe(true);
    });

    it("destroys open tunnels on stop and closes its port", async () => {
      const h = await harness(transport, { "open.example": [["203.0.113.7"]] });
      const client = dial(h.endpoint, () => client.write(connectHead("open.example:443")));
      client.on("error", () => {});
      await new Promise<void>((resolve) => client.once("data", () => resolve()));
      const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
      await h.proxy.stop();
      await closed;
      expect(client.destroyed).toBe(true);
      expect(await reachable(h.endpoint)).toBe(false);
    });

    it("stops with the last box of its route", async () => {
      const clock = new ManualClock();
      const route = new BoxWebRoute(async () => {
        const started = await transport.startProxy(
          { network: { hostAddress: LOOPBACK }, safeChainPort: 1 },
          { clock },
        );
        return { endpoint: started.endpoint, stop: () => started.proxy.stop() };
      });
      const { endpoint } = await route.acquire("dipo-a");
      expect(await reachable(endpoint)).toBe(true);
      await route.release("dipo-a");
      expect(await reachable(endpoint)).toBe(false);
    });
  });
}

/** A route whose start and stop are logged. */
function counted() {
  const log: string[] = [];
  let starts = 0;
  const route = new BoxWebRoute(async () => {
    starts += 1;
    const id = starts;
    log.push(`start ${id}`);
    return {
      id,
      stop: async () => {
        log.push(`stop ${id}`);
      },
    };
  });
  return { route, log };
}

describe("the web route of the boxes", () => {
  it("starts with the first box that uses it and stops with the last", async () => {
    const { route, log } = counted();
    const [a, b] = await Promise.all([route.acquire("dipo-a"), route.acquire("dipo-b")]);
    expect(a).toBe(b);
    expect(log).toEqual(["start 1"]);
    await route.release("dipo-a");
    expect(route.running).toBe(true);
    expect(route.users).toEqual(["dipo-b"]);
    await route.release("dipo-unknown");
    expect(route.running).toBe(true);
    await route.release("dipo-b");
    expect(route.running).toBe(false);
    expect(log).toEqual(["start 1", "stop 1"]);
    await route.acquire("dipo-c");
    await route.close();
    expect(log).toEqual(["start 1", "stop 1", "start 2", "stop 2"]);
    expect(route.users).toEqual([]);
  });

  it("does not count a box whose start failed, and starts again on the next use", async () => {
    let fail = true;
    const route = new BoxWebRoute(async () => {
      if (fail) throw new Error("no Safe-Chain");
      return { stop: async () => {} };
    });
    await expect(route.acquire("dipo-a")).rejects.toThrow("no Safe-Chain");
    expect(route.running).toBe(false);
    expect(route.users).toEqual([]);
    fail = false;
    await route.acquire("dipo-a");
    expect(route.running).toBe(true);
  });
});
