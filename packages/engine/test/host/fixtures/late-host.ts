// A stand-in worker host for the real-process tests of DIPO-386. A test runs it as
// `bun <copy>/cli/src/main.ts daemon worker-host <run>` (`lateHostScript`), the source form of the
// host, or puts other words in front of it. It binds the socket named by LATE_HOST_SOCKET only
// once the file named by LATE_HOST_GATE exists (a host that binds late); without LATE_HOST_SOCKET
// it never binds. It answers a hello with its own PID in protocol 3, answers every op, and appends
// each op name to the file named by LATE_HOST_OPS. It runs until it is killed, or exits at once
// with LATE_HOST_EXIT=1.

import { appendFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";

if (process.env["LATE_HOST_EXIT"] === "1") process.exit(0);

const socketPath = process.env["LATE_HOST_SOCKET"] ?? "";
const gate = process.env["LATE_HOST_GATE"] ?? "";
const opsFile = process.env["LATE_HOST_OPS"] ?? "";
const runId = process.argv.at(-1) ?? "";

if (socketPath !== "") {
  while (!existsSync(gate)) await Bun.sleep(10);
  createServer((socket) => {
    let buffered = "";
    socket.on("data", (data) => {
      buffered += data.toString("utf8");
      for (let at = buffered.indexOf("\n"); at >= 0; at = buffered.indexOf("\n")) {
        const frame = JSON.parse(buffered.slice(0, at)) as {
          kind: string;
          id?: number;
          op?: string;
        };
        buffered = buffered.slice(at + 1);
        const reply =
          frame.kind === "hello"
            ? { kind: "hello", version: 3, run: runId, pid: process.pid }
            : { kind: "reply", id: frame.id, ok: true, result: { offset: 0 } };
        if (frame.kind === "op" && opsFile !== "") appendFileSync(opsFile, `${frame.op}\n`);
        socket.write(`${JSON.stringify(reply)}\n`);
      }
    });
  }).listen(socketPath);
}

await new Promise(() => {});
