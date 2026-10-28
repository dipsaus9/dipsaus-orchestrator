// A connection from the Mac into the box network (DIPO-343): bound to the box network's host
// address, so a VPN that routes the box subnet into its tunnel cannot take it; refused without
// that address (fail-closed).

import { createServer, type Socket } from "node:net";

import { describe, expect, it } from "bun:test";

import { connectToBox } from "../../src/box/box-connect";
import { BoxError } from "../../src/box/port";

describe("a connection into the box network", () => {
  it("leaves from the box network's host address", () => {
    const opened: unknown[] = [];
    const socket = {} as Socket;
    const result = connectToBox(
      { address: "192.0.2.20", port: 8101, hostAddress: "192.0.2.1" },
      (options) => {
        opened.push(options);
        return socket;
      },
    );
    expect(result).toBe(socket);
    expect(opened).toEqual([{ host: "192.0.2.20", port: 8101, localAddress: "192.0.2.1" }]);
  });

  it("opens nothing without a host address of the box's family (fail-closed)", () => {
    for (const [address, hostAddress] of [
      ["192.0.2.20", null],
      ["192.0.2.20", "2001:db8::1"],
      ["192.0.2.20", "mac.example"],
      ["box.example", "192.0.2.1"],
    ] as const) {
      let opened = false;
      expect(() =>
        connectToBox({ address, port: 8101, hostAddress }, () => {
          opened = true;
          return {} as Socket;
        }),
      ).toThrow(BoxError);
      expect(opened).toBe(false);
    }
  });

  it("binds the real socket's source to the host address", async () => {
    const server = createServer((socket) => socket.end());
    const port = await new Promise<number | null>((resolve) => {
      server.once("error", () => resolve(null));
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resolve(typeof address === "object" && address !== null ? address.port : null);
      });
    });
    // A sandbox that refuses loopback listens leaves nothing to connect to here.
    if (port === null) return;
    const socket = connectToBox({ address: "127.0.0.1", port, hostAddress: "127.0.0.1" });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    expect(socket.localAddress).toBe("127.0.0.1");
    socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
