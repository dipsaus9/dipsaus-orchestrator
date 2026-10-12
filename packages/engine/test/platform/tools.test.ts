// Tool paths and the executable stamp (DIPO-70): resolution over a fake `PATH` of temp
// directories, a missing `rg` reported as missing, and a replaced file giving another stamp.

import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import {
  resolveTools,
  sameStamp,
  systemExecutableStamp,
  systemIsExecutable,
} from "../../src/platform/tools";

function tool(dir: string, name: string, mode = 0o755): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, mode);
  return path;
}

describe("resolveTools", () => {
  it("finds each tool in the first PATH directory that has it and reports rg as missing", () =>
    withTempDir((dir) => {
      const a = join(dir, "a");
      const b = join(dir, "b");
      tool(a, "git");
      tool(b, "git");
      tool(b, "claude");
      tool(a, "backlog");
      tool(b, "gh");
      const resolved = resolveTools(`${a}:${b}`);
      expect(resolved.paths).toEqual({
        claude: join(b, "claude"),
        backlog: join(a, "backlog"),
        gh: join(b, "gh"),
        git: join(a, "git"),
      });
      expect(resolved.missing).toEqual(["rg"]);
    }));

  it("skips files without the execute bit, directories, and empty or relative entries", () =>
    withTempDir((dir) => {
      const a = join(dir, "a");
      const b = join(dir, "b");
      tool(a, "rg", 0o644);
      mkdirSync(join(a, "gh"), { recursive: true });
      tool(b, "rg");
      const resolved = resolveTools(`:relative:${a}:${b}`);
      expect(resolved.paths).toEqual({ rg: join(b, "rg") });
      expect(resolved.missing).toEqual(["claude", "backlog", "gh", "git"]);
    }));

  it("reports every tool as missing without a PATH", () => {
    expect(resolveTools(undefined, () => true)).toEqual({
      paths: {},
      missing: ["claude", "backlog", "gh", "rg", "git"],
    });
  });

  it("asks the injected check in PATH order", () => {
    const asked: string[] = [];
    const resolved = resolveTools("/x:/y", (path) => {
      asked.push(path);
      return path === "/y/git";
    });
    expect(resolved.paths).toEqual({ git: "/y/git" });
    expect(asked.slice(-2)).toEqual(["/x/git", "/y/git"]);
  });

  it("checks real files", () =>
    withTempDir((dir) => {
      expect(systemIsExecutable(tool(dir, "x"))).toBe(true);
      expect(systemIsExecutable(join(dir, "absent"))).toBe(false);
    }));
});

describe("executable stamp", () => {
  it("changes when the file is replaced and is null while it is gone", () =>
    withTempDir((dir) => {
      const path = tool(dir, "dipo");
      const before = systemExecutableStamp(path);
      expect(before).not.toBeNull();
      expect(sameStamp(before!, systemExecutableStamp(path)!)).toBe(true);
      // An upgrade writes a new file and renames it over the old one: a new inode.
      const next = tool(dir, "dipo.new");
      writeFileSync(next, "#!/bin/sh\nexit 1\n");
      renameSync(next, path);
      const after = systemExecutableStamp(path);
      expect(after).not.toBeNull();
      expect(sameStamp(before!, after!)).toBe(false);
      expect(systemExecutableStamp(join(dir, "gone"))).toBeNull();
    }));
});
