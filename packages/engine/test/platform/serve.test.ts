// `serveUnixSocket`'s stop removes the socket file.

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { serveUnixSocket } from "../../src/platform/serve";

describe("serveUnixSocket stop", () => {
  it("removes the path", () =>
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
