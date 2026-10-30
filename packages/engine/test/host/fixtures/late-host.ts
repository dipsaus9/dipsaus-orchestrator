// A stand-in worker host for the real-process tests of DIPO-386. Its command line is
// `bun <this file> ... daemon worker-host <run>`, so a test can make it look like the host's source
// form or put words in front of it. It binds the socket named by LATE_HOST_SOCKET only once the
// file named by LATE_HOST_GATE exists (a host that binds late), then answers each connection's
// hello with its own PID, as a host does; without LATE_HOST_SOCKET it never binds. It runs until
// it is killed, or exits at once with LATE_HOST_EXIT=1.

import { existsSync } from "node:fs";
import { createServer } from "node:net";

if (process.env["LATE_HOST_EXIT"] === "1") process.exit(0);

const socketPath = process.env["LATE_HOST_SOCKET"] ?? "";
const gate = process.env["LATE_HOST_GATE"] ?? "";
const runId = process.argv.at(-1) ?? "";

if (socketPath !== "") {
  while (!existsSync(gate)) await Bun.sleep(10);
  createServer((socket) => {
    socket.once("data", () => {
      socket.write(
        `${JSON.stringify({ kind: "hello", version: 2, run: runId, pid: process.pid })}\n`,
      );
    });
  }).listen(socketPath);
}

await new Promise(() => {});
