// Rotation of `daemon.log` (DIPO-64, 0006 decision 13): at the size limit the file becomes
// `daemon.log.1`, older files shift up to `daemon.log.5`, and the oldest is dropped.

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import {
  DAEMON_LOG_KEEP,
  DAEMON_LOG_MAX_BYTES,
  openLogFile,
  rotateFiles,
} from "../../src/log/file";

const read = (path: string) => readFileSync(path, "utf8");

describe("daemon.log rotation", () => {
  it("defaults to 10 MB and five rotated files", () => {
    expect(DAEMON_LOG_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(DAEMON_LOG_KEEP).toBe(5);
  });

  it("moves daemon.log to daemon.log.1 before a line would pass the limit", async () => {
    await withTempDir((dir) => {
      // Each line is 10 bytes with its newline; the limit holds exactly two.
      const file = openLogFile(dir, { maxBytes: 20 });
      file.sink("line-0001");
      file.sink("line-0002");
      expect(existsSync(join(dir, "daemon.log.1"))).toBe(false);
      file.sink("line-0003");
      file.close();
      expect(read(join(dir, "daemon.log.1"))).toBe("line-0001\nline-0002\n");
      expect(read(join(dir, "daemon.log"))).toBe("line-0003\n");
      expect(statSync(join(dir, "daemon.log")).mode & 0o777).toBe(0o600);
    });
  });

  it("shifts older files up to daemon.log.5 and drops the oldest", async () => {
    await withTempDir((dir) => {
      const file = openLogFile(dir, { maxBytes: 10 });
      for (let n = 1; n <= 8; n += 1) file.sink(`line-000${n}`);
      file.close();
      expect(readdirSync(dir).toSorted()).toEqual([
        "daemon.log",
        "daemon.log.1",
        "daemon.log.2",
        "daemon.log.3",
        "daemon.log.4",
        "daemon.log.5",
      ]);
      expect(read(join(dir, "daemon.log"))).toBe("line-0008\n");
      expect(read(join(dir, "daemon.log.1"))).toBe("line-0007\n");
      expect(read(join(dir, "daemon.log.5"))).toBe("line-0003\n");
    });
  });

  it("counts what the file already held when it was opened", async () => {
    await withTempDir((dir) => {
      writeFileSync(join(dir, "daemon.log"), "earlier-1\n");
      const file = openLogFile(dir, { maxBytes: 15 });
      file.sink("line-0001");
      file.close();
      expect(read(join(dir, "daemon.log.1"))).toBe("earlier-1\n");
      expect(read(join(dir, "daemon.log"))).toBe("line-0001\n");
    });
  });

  it("writes a line longer than the limit into a file of its own", async () => {
    await withTempDir((dir) => {
      const file = openLogFile(dir, { maxBytes: 10 });
      file.sink("a-very-long-line");
      file.sink("short");
      file.close();
      expect(read(join(dir, "daemon.log.1"))).toBe("a-very-long-line\n");
      expect(read(join(dir, "daemon.log"))).toBe("short\n");
    });
  });

  it("rotateFiles fills gaps without failing on missing numbers", async () => {
    await withTempDir((dir) => {
      const path = join(dir, "daemon.log");
      writeFileSync(path, "current\n");
      writeFileSync(`${path}.2`, "two\n");
      rotateFiles(path, 5);
      expect(readdirSync(dir).toSorted()).toEqual(["daemon.log.1", "daemon.log.3"]);
      expect(read(`${path}.1`)).toBe("current\n");
      expect(read(`${path}.3`)).toBe("two\n");
    });
  });
});
