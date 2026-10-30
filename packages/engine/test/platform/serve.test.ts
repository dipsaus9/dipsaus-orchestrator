// `serveUnixSocket`'s stop (DIPO-355): Bun unlinks a unix socket's path when its server stops. A
// daemon that lost its lock stops with `removeFile: false` and must leave the path to the daemon
// that bound it since, so that one still answers.

import { describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { serveUnixSocket } from "../../src/platform/serve";

describe("serveUnixSocket stop", () => {
  it("with removeFile false leaves the path to the server that bound it since", () =>
    withTempDir(async (dir) => {
      const path = join(dir, "s.sock");
      const loser = serveUnixSocket(path, () => ({
        message: () => {},
        drain: () => {},
        closed: () => {},
      }));
      // Another daemon removes the path and binds its own socket there.
      unlinkSync(path);
      const winner = Bun.serve({ unix: path, fetch: () => new Response("winner") });
      try {
        await loser.stop({ removeFile: false });
        expect(existsSync(path)).toBe(true);
        expect(await (await fetch("http://localhost/", { unix: path })).text()).toBe("winner");
        expect(existsSync(`${path}.${process.pid}.keep`)).toBe(false);
      } finally {
        await winner.stop(true);
      }
    }));

  it("removes the path by default", () =>
    withTempDir(async (dir) => {
      const path = join(dir, "s.sock");
      const served = serveUnixSocket(path, () => ({
        message: () => {},
        drain: () => {},
        closed: () => {},
      }));
      expect(existsSync(path)).toBe(true);
      await served.stop();
      expect(existsSync(path)).toBe(false);
    }));
});
