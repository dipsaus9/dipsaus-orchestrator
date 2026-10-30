// A stand-in worker host for the real-process tests (DIPO-386). It waits until the gate file named
// by STAND_IN_GATE exists, then binds the socket named by STAND_IN_SOCKET and answers the hello
// with its own PID, as a host does. Its command line is `bun <this file> daemon worker-host <run>`,
// so the engine's identity check takes it for a worker host.

import { existsSync } from "node:fs";
import { createServer } from "node:net";

const socketPath = process.env["STAND_IN_SOCKET"] ?? "";
const gate = process.env["STAND_IN_GATE"] ?? "";
const runId = process.argv.at(-1) ?? "";

while (!existsSync(gate)) await Bun.sleep(10);

createServer((socket) => {
  socket.once("data", () => {
    socket.write(
      `${JSON.stringify({ kind: "hello", version: 2, run: runId, pid: process.pid })}\n`,
    );
  });
}).listen(socketPath);

// Stays up until the test kills it.
await new Promise(() => {});
