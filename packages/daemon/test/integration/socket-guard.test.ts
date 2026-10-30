// The Unix socket is the only way into the daemon (0005, DIPO-355): no network listener and no
// `auth` frame. Its one guard is the runtime directory, real, owned by the user and 0700; the
// socket file's own mode is not relied on. A daemon run in-process on the real path binds
// `dipo.sock` there, a client of the same user connects and says hello, and an `auth` frame is no
// frame of the contract any more. Every daemon is stopped in a `finally`.

import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import { systemClock } from "@dipsaus-orchestrator/engine/platform";
import { isolatedDaemonEnv, withDaemonTempDir } from "@dipsaus-orchestrator/testkit";

import { runForeground } from "../../src/foreground";
import { requestId, TestClient } from "../support/client";

describe("the daemon's socket (0005)", () => {
  it("binds dipo.sock in an owner-only runtime directory, takes a client, and refuses an auth frame", () =>
    withDaemonTempDir(async (dir) => {
      const lines: string[] = [];
      let signal: ((name: string) => void) | null = null;
      const exited = runForeground([], {
        writeLine: () => {},
        writeError: (line) => lines.push(line),
        env: isolatedDaemonEnv(dir),
        execArgv: [],
        version: "test",
        clock: systemClock,
        onShutdownSignal: (handler) => {
          signal = handler;
          return () => {
            signal = null;
          };
        },
        // No listener for uncaught errors on the test runner's own process (DIPO-117).
        uncaughtErrors: new EventEmitter(),
      });
      try {
        const runtime = join(dir, "state", "runtime.json");
        for (let i = 0; i < 400; i++) {
          if (lines.some((line) => line.includes('"to":"running"')) && existsSync(runtime)) break;
          await Bun.sleep(25);
        }
        const { socket } = JSON.parse(readFileSync(runtime, "utf8")) as { socket: string };
        expect(socket).toBe(join(dir, "run", "dipo.sock"));

        // The guard: a real directory, not a link, owned by this user, 0700.
        const folder = dirname(socket);
        const stat = lstatSync(folder);
        expect(stat.isDirectory()).toBe(true);
        expect(stat.isSymbolicLink()).toBe(false);
        expect(realpathSync(folder)).toBe(realpathSync(join(dir, "run")));
        expect(stat.uid).toBe(process.getuid?.() ?? -1);
        expect(stat.mode & 0o777).toBe(0o700);
        expect(lstatSync(socket).isSocket()).toBe(true);

        // A client of the same user connects with no auth frame.
        const client = await TestClient.connect(socket);
        try {
          expect(await client.hello()).toMatchObject({ ok: true, result: { engine: "test" } });
          // The auth frame of the old browser listener is no ClientFrame any more.
          const auth = await client.request({ kind: "auth", requestId: requestId(), token: "t" });
          expect(auth).toMatchObject({ ok: false, error: { code: "args.invalid" } });
          expect((await client.read("daemon.status")).ok).toBe(true);
          expect(client.invalid).toEqual([]);
        } finally {
          await client.close();
        }
      } finally {
        (signal as ((name: string) => void) | null)?.("SIGTERM");
        expect(await exited).toBe(0);
      }
    }));
});
