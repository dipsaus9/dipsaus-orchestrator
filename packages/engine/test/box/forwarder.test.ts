// The test URL's forwarder on the Mac (DIPO-309): it listens on the Mac's loopback only, passes
// bytes both ways to the target from the given source address, keeps a free port it is asked
// for, and ends every connection when it closes. The target here is a server on the loopback,
// standing in for `dev` in a test box.

import { connect, createServer, type Server, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "bun:test";

import { FORWARDER_HOST, startForwarder, systemReach } from "../../src/box/forwarder";

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** An echo server on the loopback that records the address each connection came from. */
async function echo(): Promise<{ port: number; from: string[]; sockets: Socket[] }> {
  const from: string[] = [];
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    from.push(socket.remoteAddress ?? "");
    sockets.push(socket);
    socket.on("error", () => {});
    socket.pipe(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { port: address.port, from, sockets };
}

/** Sends `text` through a new connection to `port` and reads it back. */
function roundTrip(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let got = "";
    socket.on("data", (chunk) => {
      got += chunk.toString();
      if (got.length >= text.length) {
        socket.end();
        resolve(got);
      }
    });
    socket.on("error", reject);
    socket.on("connect", () => socket.write(text));
  });
}

describe("the test forwarder", () => {
  it("listens on the Mac's loopback only and passes bytes both ways from the source address", async () => {
    const target = await echo();
    const forwarder = await startForwarder({
      address: "127.0.0.1",
      port: target.port,
      source: "127.0.0.1",
    });
    try {
      expect(FORWARDER_HOST).toBe("127.0.0.1");
      expect(forwarder.port).toBeGreaterThan(0);
      expect(forwarder.port).not.toBe(target.port);
      expect(await roundTrip(forwarder.port, "hello box")).toBe("hello box");
      expect(target.from).toEqual(["127.0.0.1"]);
    } finally {
      await forwarder.close();
    }
  });

  it("takes the port it is asked for when free, else another one", async () => {
    const target = await echo();
    const first = await startForwarder({
      address: "127.0.0.1",
      port: target.port,
      source: "127.0.0.1",
    });
    const wanted = first.port;
    await first.close();
    const again = await startForwarder(
      { address: "127.0.0.1", port: target.port, source: "127.0.0.1" },
      { port: wanted },
    );
    try {
      expect(again.port).toBe(wanted);
      // The port is taken now, so a second forwarder asking for it gets another.
      const other = await startForwarder(
        { address: "127.0.0.1", port: target.port, source: "127.0.0.1" },
        { port: wanted },
      );
      expect(other.port).not.toBe(wanted);
      expect(await roundTrip(other.port, "x")).toBe("x");
      await other.close();
    } finally {
      await again.close();
    }
  });

  it("closes the client's connection when the target refuses, and ends every connection at close", async () => {
    const target = await echo();
    const refusing = await startForwarder({ address: "127.0.0.1", port: 1, source: "127.0.0.1" });
    const closed = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port: refusing.port });
      socket.on("close", () => resolve(true));
      socket.on("error", () => {});
    });
    expect(closed).toBe(true);
    await refusing.close();

    const forwarder = await startForwarder({
      address: "127.0.0.1",
      port: target.port,
      source: "127.0.0.1",
    });
    const socket = connect({ host: "127.0.0.1", port: forwarder.port });
    socket.on("error", () => {});
    await new Promise<void>((resolve) => socket.on("connect", () => resolve()));
    socket.write("ping");
    await new Promise<void>((resolve) => socket.once("data", () => resolve()));
    expect(forwarder.connections()).toBe(2);
    const ended = new Promise<void>((resolve) => socket.on("close", () => resolve()));
    await forwarder.close();
    await ended;
    expect(forwarder.connections()).toBe(0);
    // Stopped: nothing listens on its port any more.
    expect(
      await systemReach({ address: "127.0.0.1", port: forwarder.port, source: "127.0.0.1" }, 1000),
    ).toBe(false);
  });
});

describe("the reach check", () => {
  it("is true for a listening port and false for a closed one", async () => {
    const target = await echo();
    expect(
      await systemReach({ address: "127.0.0.1", port: target.port, source: "127.0.0.1" }, 1000),
    ).toBe(true);
    expect(await systemReach({ address: "127.0.0.1", port: 1, source: "127.0.0.1" }, 1000)).toBe(
      false,
    );
  });
});
