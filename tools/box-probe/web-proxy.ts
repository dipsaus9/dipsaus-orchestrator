// The web route of one probe box (DIPO-264, decision 0021 section 3): an HTTP CONNECT proxy that
// listens only on the box network's host address. A tunnel to a package registry goes to dipo's
// Safe-Chain proxy; any other tunnel goes straight out through the Mac's own connection, but only
// to a public internet address: the Mac itself, local and private networks and IP literals are
// refused (DIPO-264 review), so the proxy is no way into the Mac or the network around it. Probe code:
// one proxy for one box, stopped with Ctrl-C or when stdin closes.
//
// Usage: bun tools/box-probe/web-proxy.ts <listen-host> <listen-port> <ca-file>
// The Safe-Chain CA bundle is written to <ca-file>, for the box's package managers to trust.

import { lookup } from "node:dns/promises";
import { connect, createServer, isIP, type Socket } from "node:net";
import { homedir, userInfo } from "node:os";

import { systemClock } from "../../packages/engine/src/platform/clock";
import { currentPlatform } from "../../packages/engine/src/platform/paths";
import { startSafeChainProxy } from "../../packages/engine/src/platform/safe-chain-proxy";
import { SAFE_CHAIN_REGISTRY_HOSTS } from "../../packages/engine/src/sandbox/safe-chain-proxy";

/** The longest request head read before a tunnel opens. */
const HEAD_LIMIT = 8 * 1024;
const CONNECT_LINE = /^CONNECT ([A-Za-z0-9.-]+):(\d{1,5}) HTTP\/1\.[01]\r\n/;

const [listenHost, listenPort, caFile] = process.argv.slice(2);
if (listenHost === undefined || listenPort === undefined || caFile === undefined) {
  console.error("usage: bun tools/box-probe/web-proxy.ts <listen-host> <listen-port> <ca-file>");
  process.exit(2);
}

const home = homedir();
const started = await startSafeChainProxy(
  { installRoot: `${home}/.safe-chain`, caFile, home, uid: userInfo().uid, env: process.env },
  { platform: currentPlatform(), clock: systemClock },
);
if (!started.ok) {
  console.error(`Safe-Chain proxy did not start: ${started.reason}`);
  process.exit(1);
}
const safeChain = started.proxy;
const registries = new Set(SAFE_CHAIN_REGISTRY_HOSTS);

/** IPv4 ranges that are not the public internet: this host, private, shared, link-local and the like. */
const NON_PUBLIC_V4: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8
  [0x0a000000, 8], // 10.0.0.0/8
  [0x64400000, 10], // 100.64.0.0/10 (shared address space, often VPNs)
  [0x7f000000, 8], // 127.0.0.0/8
  [0xa9fe0000, 16], // 169.254.0.0/16
  [0xac100000, 12], // 172.16.0.0/12
  [0xc0000000, 24], // 192.0.0.0/24
  [0xc0a80000, 16], // 192.168.0.0/16
  [0xc6120000, 15], // 198.18.0.0/15
  [0xe0000000, 3], // 224.0.0.0/3 (multicast and reserved)
];

function v4Number(address: string): number {
  return address.split(".").reduce((value, part) => value * 256 + Number(part), 0);
}

/** True only for an address on the public internet. */
function isPublic(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped !== null) return isPublic(mapped[1] ?? "");
  if (isIP(address) === 4) {
    const value = v4Number(address);
    return NON_PUBLIC_V4.every(
      ([base, bits]) =>
        Math.floor(value / 2 ** (32 - bits)) !== Math.floor(base / 2 ** (32 - bits)),
    );
  }
  const lower = address.toLowerCase();
  if (lower === "::" || lower === "::1") return false;
  // fc00::/7 (unique local), fe80::/10 (link-local), ff00::/8 (multicast).
  return !/^(f[cd]|fe[89ab]|ff)/.test(lower);
}

function refuse(client: Socket, why: string): void {
  console.log(`refused: ${why}`);
  client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
}

function pipe(client: Socket, upstream: Socket, first: Buffer): void {
  if (first.length > 0) upstream.write(first);
  client.pipe(upstream);
  upstream.pipe(client);
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", close);
  upstream.on("error", close);
  client.on("close", close);
  upstream.on("close", close);
}

const server = createServer((client) => {
  let head = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end === -1) {
      if (head.length > HEAD_LIMIT) client.destroy();
      return;
    }
    client.off("data", onData);
    client.pause();
    const match = CONNECT_LINE.exec(head.subarray(0, end + 2).toString("latin1"));
    if (match === null) {
      client.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
      return;
    }
    // A trailing dot names the same host, so it is dropped before the registry match.
    const host = (match[1] ?? "").toLowerCase().replace(/\.+$/, "");
    const port = Number(match[2]);
    if (host === "" || isIP(host) !== 0) {
      refuse(client, `${host}:${port} is not a host name`);
      return;
    }
    if (registries.has(host)) {
      // Safe-Chain reads the CONNECT itself: it gets the request with the host name normalised.
      console.log(`CONNECT ${host}:${port} -> safe-chain`);
      const rest = head.subarray(head.indexOf("\r\n") + 2);
      const forwarded = Buffer.concat([Buffer.from(`CONNECT ${host}:${port} HTTP/1.1\r\n`), rest]);
      const upstream = connect(safeChain.port, "127.0.0.1", () => {
        pipe(client, upstream, forwarded);
        client.resume();
      });
      upstream.on("error", () => client.destroy());
      return;
    }
    // The name is resolved once, and the tunnel goes to that address, so the check and the
    // connection see the same address.
    lookup(host, { all: true }).then(
      (addresses) => {
        const blocked = addresses.find((entry) => !isPublic(entry.address));
        const target = addresses[0];
        if (target === undefined || blocked !== undefined) {
          refuse(client, `${host}:${port} resolves to ${blocked?.address ?? "nothing"}`);
          return;
        }
        console.log(`CONNECT ${host}:${port} -> direct (${target.address})`);
        const upstream = connect(port, target.address, () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          pipe(client, upstream, head.subarray(end + 4));
          client.resume();
        });
        upstream.on("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
      },
      () => refuse(client, `${host}:${port} does not resolve`),
    );
  };
  client.on("data", onData);
  client.on("error", () => client.destroy());
});

const sockets = new Set<Socket>();
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});

async function stop(): Promise<void> {
  server.close();
  for (const socket of sockets) socket.destroy();
  try {
    await safeChain.stop();
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
// Reading stdin is what lets its end be seen.
process.stdin.on("end", () => void stop());
process.stdin.resume();

server.listen(Number(listenPort), listenHost, () => {
  console.log(
    `ready: listening on ${listenHost}:${listenPort}, Safe-Chain on 127.0.0.1:${safeChain.port}`,
  );
});
