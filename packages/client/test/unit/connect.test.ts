// `connectToDaemon` against a fake daemon on a Unix socket in a temp DIPO_HOME (0005): a daemon of
// another version, or one that refuses the hello's shape (`args.invalid`, `not.permitted`), is
// `OtherVersionError`; a daemon's own failure (`internal`) keeps its code.

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { ClientError } from "../../src/index";
import { connectToDaemon, OtherVersionError } from "../../src/node/index";

const CLIENT = { name: "connect-test", version: "1.2.3" };

type Answer = { readonly error: string } | { readonly engine: string };

/** A fake daemon that answers `engine.hello` with `answer`; returns the env that finds it. */
function fakeDaemon(dir: string, answer: Answer) {
  const state = join(dir, "state");
  const run = join(dir, "run");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(run, { recursive: true, mode: 0o700 });
  const socket = join(run, "d.sock");
  const server = Bun.serve({
    unix: socket,
    fetch: (request, served) =>
      served.upgrade(request) ? undefined : new Response("no", { status: 400 }),
    websocket: {
      message(ws, message) {
        const frame = JSON.parse(String(message)) as { requestId: string };
        const reply =
          "error" in answer
            ? {
                ok: false,
                requestId: frame.requestId,
                error: { code: answer.error, message: answer.error, retryable: false },
              }
            : {
                ok: true,
                requestId: frame.requestId,
                result: {
                  engine: answer.engine,
                  daemon: "running",
                  offices: [],
                  cursor: { stream: "software", seq: 0 },
                },
              };
        ws.send(JSON.stringify({ kind: "reply", reply }));
      },
    },
  });
  writeFileSync(
    join(state, "runtime.json"),
    JSON.stringify({ runtimeDir: run, socket, pid: 1, startTimeMs: 1, version: "x" }),
  );
  return { env: { DIPO_TEST: "1", DIPO_HOME: state }, stop: () => server.stop(true) };
}

async function failure(answer: Answer): Promise<unknown> {
  return withTempDir(async (dir) => {
    const daemon = fakeDaemon(dir, answer);
    try {
      const { client } = await connectToDaemon({
        client: CLIENT,
        origin: "other",
        env: daemon.env,
        timeoutMs: 2_000,
      });
      client.close();
      return null;
    } catch (error) {
      return error;
    } finally {
      daemon.stop();
    }
  });
}

describe("connectToDaemon and the daemon's version (0005)", () => {
  it("connects to a daemon of the same version", async () => {
    expect(await failure({ engine: CLIENT.version })).toBeNull();
  });

  it("refuses a daemon of another version with the restart hint", async () => {
    const error = await failure({ engine: "9.9.9" });
    expect(error).toBeInstanceOf(OtherVersionError);
    expect((error as Error).message).toBe(
      "daemon runs v9.9.9, this binary is v1.2.3, run `dipo daemon restart`",
    );
  });

  for (const code of ["args.invalid", "not.permitted"]) {
    it(`takes a hello refused with ${code} for a daemon of another version`, async () => {
      const error = await failure({ error: code });
      expect(error).toBeInstanceOf(OtherVersionError);
      expect((error as OtherVersionError).daemonVersion).toBeNull();
    });
  }

  it("keeps a daemon's own failure as its code, not another version", async () => {
    const error = await failure({ error: "internal" });
    expect(error).toBeInstanceOf(ClientError);
    expect(error).not.toBeInstanceOf(OtherVersionError);
    expect((error as ClientError).code).toBe("internal");
  });
});
