// The box web proxy's hardening of DIPO-281 and DIPO-282, as pure rules: other names of the
// registries (aliases, CDN names, mirrors, registry zones), what a box sends into a direct tunnel
// (the TLS ClientHello's server name, a stream in clear text), every IPv6 form that embeds a
// private IPv4 address and every numeric IPv4 form of a CONNECT target, and the proxy passwords
// that name a box and its listed local ports. The proxy over sockets is in web-proxy.test.ts.
//
// Every address is a documentation or private-range address; the Mac's interfaces are
// documentation addresses as in web-proxy.test.ts.

import { describe, expect, it } from "bun:test";

import {
  admittedUrl,
  BoxAdmissions,
  checkAddress,
  CLIENT_HELLO_LIMIT,
  type HostInterfaceAddress,
  isRegistryHost,
  normaliseHost,
  parseTunnelRequest,
  proxyPassword,
  readClientHello,
  REGISTRY_OTHER_NAMES,
  REGISTRY_ZONES,
  registryRefusal,
  TunnelInspector,
} from "../../src/box/web-proxy";
import { SAFE_CHAIN_REGISTRY_HOSTS } from "../../src/box/safe-chain";

import { extension, hello, helloMessage, records, serverName, u16 } from "./tls-hello";

const INTERFACES: readonly HostInterfaceAddress[] = [
  { address: "192.0.2.10", cidr: "192.0.2.10/25" },
  { address: "198.51.100.1", cidr: "198.51.100.1/24" },
];
const CONTEXT = { interfaces: INTERFACES, boxHostAddress: "198.51.100.1" };

/** The verdict of a fresh inspector of a tunnel to cdn.example on `bytes`. */
const inspect = (bytes: Buffer) => new TunnelInspector("cdn.example").push(bytes);

/** The verdict kind of each chunk, in order, on one inspector of a tunnel to cdn.example. */
function named(chunks: readonly string[]): string[] {
  const inspector = new TunnelInspector("cdn.example");
  return chunks.map((chunk) => inspector.push(Buffer.from(chunk, "latin1")).kind);
}

const basic = (text: string) => Buffer.from(text).toString("base64");
const head = (line: string) => `CONNECT host.dipo.internal:5432 HTTP/1.1\r\n${line}\r\nHost: x`;

describe("other names of the registries (DIPO-281)", () => {
  it("refuses every known alias, CDN name and mirror, with what it is", () => {
    expect(REGISTRY_OTHER_NAMES.length).toBeGreaterThan(10);
    for (const [name, what] of REGISTRY_OTHER_NAMES) {
      expect(registryRefusal(name)).toBe(
        `${name} is ${what}; a registry is reached only by its own name, through Safe-Chain`,
      );
    }
    expect(registryRefusal("registry.npmjs.com")).toContain("an alias of registry.npmjs.org");
    expect(registryRefusal("registry.npmjs.org.cdn.cloudflare.net")).toContain("CDN name");
    expect(registryRefusal("dualstack.python.map.fastly.net")).toContain("CDN name of pypi.org");
  });

  it("refuses every other name in a zone that serves a registry", () => {
    for (const [zone, registry] of REGISTRY_ZONES) {
      for (const name of [zone, `www.${zone}`, `a.b.${zone}`]) {
        expect(registryRefusal(name)).toBe(
          `${name} is in ${zone}, which serves ${registry}; a registry is reached only by its own name, through Safe-Chain`,
        );
      }
    }
  });

  it("never refuses a registry Safe-Chain checks, nor a name that only looks like one", () => {
    for (const host of SAFE_CHAIN_REGISTRY_HOSTS) {
      expect(isRegistryHost(host)).toBe(true);
      expect(registryRefusal(host)).toBeNull();
    }
    for (const host of ["example.com", "npmjs.org.example.com", "notnpmjs.org", "www.npmjs.com"]) {
      expect(registryRefusal(host)).toBeNull();
    }
  });

  it("matches after the CONNECT target is normalised: case and one trailing dot", () => {
    for (const raw of ["REGISTRY.NPMJS.COM", "registry.npmjs.com.", "Test.PyPI.org."]) {
      const request = parseTunnelRequest(`CONNECT ${raw}:443 HTTP/1.1`);
      if (!request.ok) throw new Error(`${raw} was refused as a request`);
      expect(registryRefusal(request.host)).not.toBeNull();
    }
  });
});

describe("the TLS ClientHello a box sends into a direct tunnel (DIPO-281)", () => {
  it("reads the server name of a whole hello, and of one split over records and reads", () => {
    expect(readClientHello(hello("example.com"))).toEqual({
      kind: "hello",
      serverNames: ["example.com"],
      hiddenName: false,
    });
    // Split over many small handshake records: the evasion a check of the first record misses.
    const split = records(helloMessage([serverName("example.com")]), 7);
    expect(readClientHello(split)).toMatchObject({ kind: "hello", serverNames: ["example.com"] });
    // Cut at every byte: `more` until it is whole.
    for (let cut = 0; cut < split.length; cut += 1) {
      expect(readClientHello(split.subarray(0, cut))).toEqual({ kind: "more" });
    }
  });

  it("reads a hello without a server name, with two, and with Encrypted Client Hello", () => {
    expect(readClientHello(records(helloMessage([])))).toEqual({
      kind: "hello",
      serverNames: [],
      hiddenName: false,
    });
    expect(readClientHello(hello("a.example", "b.example"))).toMatchObject({
      serverNames: ["a.example", "b.example"],
    });
    for (const type of [0xfe0d, 0xffce]) {
      const read = readClientHello(
        records(helloMessage([serverName("cover.example"), extension(type, Buffer.alloc(8))])),
      );
      expect(read).toMatchObject({ kind: "hello", hiddenName: true });
    }
  });

  it("refuses a hello it cannot read", () => {
    const message = helloMessage([serverName("example.com")]);
    const cases: ReadonlyArray<readonly [string, Buffer]> = [
      [
        "a TLS record before the whole ClientHello is no handshake",
        Buffer.from([0x17, 3, 3, 0, 1, 0]),
      ],
      ["a TLS record names no TLS version", Buffer.from([0x16, 2, 0, 0, 1, 1])],
      ["a TLS record of 0 bytes", Buffer.from([0x16, 3, 1, 0, 0])],
      ["a TLS record of 30000 bytes", Buffer.concat([Buffer.from([0x16, 3, 1]), u16(30_000)])],
      [
        "the first TLS handshake message is no ClientHello",
        records(Buffer.concat([Buffer.from([2]), message.subarray(1)])),
      ],
      [
        "the TLS records hold more than the ClientHello",
        records(Buffer.concat([message, Buffer.from([1, 2, 3])])),
      ],
      [
        "the TLS ClientHello repeats extension 0",
        records(helloMessage([serverName("a.example"), serverName("b.example")])),
      ],
      [
        "the TLS server name list holds a name of type 1",
        records(helloMessage([extension(0, Buffer.from([0, 4, 1, 0, 1, 0x61]))])),
      ],
    ];
    for (const [reason, bytes] of cases) {
      expect(readClientHello(bytes)).toEqual({ kind: "bad", reason });
    }
    const huge = Buffer.alloc(CLIENT_HELLO_LIMIT + 10, 0);
    huge[0] = 1;
    huge.writeUIntBE(CLIENT_HELLO_LIMIT + 6, 1, 3);
    expect(readClientHello(records(huge))).toEqual({
      kind: "bad",
      reason: "the TLS ClientHello is too long",
    });
  });
});

describe("the tunnel inspector (DIPO-281)", () => {
  it("passes a TLS stream whose hello names the CONNECT host, and everything after it", () => {
    const inspector = new TunnelInspector("cdn.example");
    const bytes = hello("CDN.Example.");
    expect(inspector.push(bytes.subarray(0, 10))).toEqual({ kind: "wait" });
    expect(inspector.waiting).toBe(true);
    const verdict = inspector.push(bytes.subarray(10));
    expect(verdict).toEqual({ kind: "pass", bytes });
    expect(inspector.waiting).toBe(false);
    const later = Buffer.from("registry.npmjs.org, encrypted in real life");
    expect(inspector.push(later)).toEqual({ kind: "pass", bytes: later });
  });

  it("refuses a hello that asks for another name, such as a registry on the same CDN", () => {
    expect(new TunnelInspector("cdn.example").push(hello("registry.npmjs.org"))).toEqual({
      kind: "refuse",
      reason: "the TLS handshake asks for registry.npmjs.org, not cdn.example",
    });
    expect(new TunnelInspector("cdn.example").push(hello("files.pythonhosted.org"))).toMatchObject({
      kind: "refuse",
    });
  });

  it("refuses a hello with no name, two names, or a hidden name", () => {
    expect(inspect(records(helloMessage([])))).toEqual({
      kind: "refuse",
      reason: "the TLS handshake names no server",
    });
    expect(inspect(hello("cdn.example", "registry.npmjs.org"))).toEqual({
      kind: "refuse",
      reason: "the TLS handshake names more than one server",
    });
    expect(
      inspect(
        records(helloMessage([serverName("cdn.example"), extension(0xfe0d, Buffer.alloc(4))])),
      ),
    ).toEqual({
      kind: "refuse",
      reason: "the TLS handshake hides its server name (Encrypted Client Hello)",
    });
  });

  it("refuses a registry name anywhere in a stream that is not TLS, also split over reads", () => {
    expect(named(["GET / HTTP/1.1\r\nHost: cdn.example\r\n\r\n"])).toEqual(["pass"]);
    expect(named(["GET / HTTP/1.1\r\nHost: REGISTRY.NPMJS.ORG.\r\n\r\n"])).toEqual(["refuse"]);
    // A second request on a kept-alive connection, its name split across two reads.
    expect(
      named([
        "GET / HTTP/1.1\r\nHost: cdn.example\r\n\r\n",
        "GET /left-pad HTTP/1.1\r\nHost: registry.np",
        "mjs.org\r\n\r\n",
      ]),
    ).toEqual(["pass", "pass", "refuse"]);
    expect(named(["GET http://pypi.org/simple/ HTTP/1.1\r\n\r\n"])).toEqual(["refuse"]);
    expect(named(["CONNECT registry.npmjs.com:443 HTTP/1.1\r\n\r\n"])).toEqual(["refuse"]);
    expect(named(["GET / HTTP/1.1\r\nHost: test.pypi.org\r\n\r\n"])).toEqual(["refuse"]);
  });

  it("holds a clear-text start while it may become the HTTP/2 preface, over any split of writes", () => {
    const preface = "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";
    for (let cut = 1; cut < preface.length; cut += 1) {
      const inspector = new TunnelInspector("cdn.example");
      expect(inspector.push(Buffer.from(preface.slice(0, cut), "latin1"))).toEqual({
        kind: "wait",
      });
      expect(inspector.waiting).toBe(true);
      expect(inspector.push(Buffer.from(preface.slice(cut), "latin1"))).toEqual({
        kind: "refuse",
        reason: "the tunnel starts HTTP/2 in clear text",
      });
    }
    // Byte by byte, then with frames after it.
    const slow = new TunnelInspector("cdn.example");
    const verdicts = [...`${preface}\u0000\u0000`].map(
      (char) => slow.push(Buffer.from(char, "latin1")).kind,
    );
    expect(verdicts.slice(0, 23).every((kind) => kind === "wait")).toBe(true);
    expect(verdicts[23]).toBe("refuse");
    // A start that stops being a prefix passes at once, with what was held.
    const other = new TunnelInspector("cdn.example");
    expect(other.push(Buffer.from("PR", "latin1"))).toEqual({ kind: "wait" });
    expect(other.push(Buffer.from("OPFIND / HTTP/1.1\r\n", "latin1"))).toEqual({
      kind: "pass",
      bytes: Buffer.from("PROPFIND / HTTP/1.1\r\n", "latin1"),
    });
    expect(other.waiting).toBe(false);
  });

  it("refuses HTTP/2 in clear text and a start it cannot read", () => {
    expect(inspect(Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"))).toEqual({
      kind: "refuse",
      reason: "the tunnel starts HTTP/2 in clear text",
    });
    expect(
      inspect(Buffer.from("GET / HTTP/1.1\r\nHost: cdn.example\r\nUpgrade: h2c\r\n\r\n")),
    ).toEqual({ kind: "refuse", reason: "the tunnel asks for HTTP/2 in clear text" });
    // An SSL 2 style hello: the high bit of the first byte.
    expect(inspect(Buffer.from([0x80, 0x2e, 0x01, 0x03, 0x01]))).toEqual({
      kind: "refuse",
      reason: "the tunnel starts with bytes dipo cannot read",
    });
    const refused = new TunnelInspector("cdn.example");
    refused.push(Buffer.from([0xff]));
    expect(refused.push(Buffer.from("ok")).kind).toBe("refuse");
  });
});

describe("IPv6 forms that embed a private IPv4 address, and IPv4 in numeric forms (DIPO-281)", () => {
  it("refuses each IPv6 form that carries a private, loopback or link-local IPv4 address", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["::ffff:10.1.2.3", "IPv4-mapped, a private range"],
      ["::ffff:a01:203", "IPv4-mapped, a private range"],
      ["::ffff:127.0.0.1", "IPv4-mapped, loopback"],
      ["::ffff:169.254.169.254", "IPv4-mapped, link-local"],
      ["0:0:0:0:0:ffff:c0a8:0101", "IPv4-mapped, a private range"],
      ["::ffff:192.0.2.10", "one of the Mac's own addresses"],
      ["::ffff:198.51.100.7", "on the box network"],
      ["::ffff:0:10.1.2.3", "an IPv4-translated address"],
      ["::10.1.2.3", "an IPv4-compatible address"],
      ["::a01:203", "an IPv4-compatible address"],
      ["64:ff9b::10.1.2.3", "NAT64 (64:ff9b::/96)"],
      ["64:ff9b::c0a8:101", "NAT64 (64:ff9b::/96)"],
      ["64:ff9b:1::a01:203", "local-use NAT64"],
      ["2002:a01:203::1", "6to4 (2002::/16)"],
      ["2002:c0a8:101::1", "6to4 (2002::/16)"],
      ["2002:7f00:1::", "6to4 (2002::/16)"],
      ["2001:0:a01:203::1", "the IETF protocol assignments (Teredo among them)"],
      ["fe80::a01:203%en0", "link-local"],
      ["fe80::1%25en0", "link-local"],
      ["fe80::ffff:10.1.2.3", "link-local"],
    ];
    for (const [address, why] of cases) {
      const verdict = checkAddress(address, CONTEXT);
      expect(verdict).toEqual({ ok: false, reason: `${address} is ${why}` });
    }
  });

  it("refuses an IPv4 target in decimal, octal, hex, short or bracketed IPv6 form before resolving", () => {
    for (const target of [
      "3232235777",
      "0300.0250.1.1",
      "0xc0a80101",
      "0xc0.0xa8.1.1",
      "192.168.257",
      "10.1",
      "0x7f.1",
      "017700000001",
      "127.1.",
      "[::ffff:192.168.1.1]",
      "[::ffff:c0a8:101]",
      "[64:ff9b::a01:203]",
      "[2002:a01:203::1]",
      "[fe80::1%25en0]",
      "::ffff:10.1.2.3",
    ]) {
      const request = parseTunnelRequest(`CONNECT ${target}:443 HTTP/1.1`);
      expect(request).toMatchObject({ ok: false, status: 403 });
      expect(normaliseHost(target)).toBeNull();
    }
  });
});

describe("the boxes known by their proxy password (DIPO-282)", () => {
  it("names each admitted box's listed ports by a password of its own, until it is forgotten", () => {
    let next = 0;
    const admissions = new BoxAdmissions(() => `token-${(next += 1)}`);
    const a = admissions.admit("dipo-a", [8080, 5432, 8080]);
    const b = admissions.admit("dipo-b", []);
    expect(admissions.portsOf(a)).toEqual([5432, 8080]);
    expect(admissions.portsOf(b)).toEqual([]);
    expect(admissions.portsOf(null)).toBeNull();
    expect(admissions.portsOf("token-99")).toBeNull();
    // A new admission of the box retires its earlier password.
    const again = admissions.admit("dipo-a", [5432]);
    expect(admissions.portsOf(a)).toBeNull();
    expect(admissions.portsOf(again)).toEqual([5432]);
    admissions.forget("dipo-a");
    expect(admissions.portsOf(again)).toBeNull();
    expect(admissions.portsOf(b)).toEqual([]);
  });

  it("makes passwords that do not repeat", () => {
    const admissions = new BoxAdmissions();
    const tokens = new Set(Array.from({ length: 50 }, (_, i) => admissions.admit(`dipo-${i}`, [])));
    expect(tokens.size).toBe(50);
    for (const token of tokens) expect(token).toMatch(/^[0-9a-f]{48}$/);
  });

  it("reads the password of a Basic proxy authorization, and nothing else", () => {
    expect(proxyPassword(head(`Proxy-Authorization: Basic ${basic("dipo:abc")}`))).toBe("abc");
    expect(proxyPassword(head(`proxy-authorization:basic ${basic("dipo:a:b")}`))).toBe("a:b");
    expect(proxyPassword(head(`Proxy-Authorization: Basic ${basic("nocolon")}`))).toBeNull();
    expect(proxyPassword(head("Proxy-Authorization: Bearer abc"))).toBeNull();
    expect(proxyPassword(head(`Authorization: Basic ${basic("dipo:abc")}`))).toBeNull();
    expect(proxyPassword(`Proxy-Authorization: Basic ${basic("dipo:abc")}\r\n`)).toBeNull();
    expect(admittedUrl("http://198.51.100.1:3128", "abc")).toBe(
      "http://dipo:abc@198.51.100.1:3128",
    );
  });
});
