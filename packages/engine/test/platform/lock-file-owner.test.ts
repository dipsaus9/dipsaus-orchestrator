// Nothing in dipo but the lock module opens the daemon lock file (0005, DIPO-387). With POSIX
// `fcntl` locks, closing any descriptor of the file in the holding process drops its lock, so a
// second open anywhere in the daemon could free it. Only the contract names the file, and only
// `platform/lock.ts` uses that name, with one SQLite open.

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../../../..");
const PACKAGES = join(REPO, "packages");
const OWNERS = new Set([
  "packages/contract/src/runtime-layout.ts",
  "packages/engine/src/platform/lock.ts",
]);
const NAMES = /\bLOCK_FILE\b|dipo\.lock\b/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("the daemon lock file", () => {
  it("is named only by the contract and the lock module", () => {
    const users = readdirSync(PACKAGES)
      .flatMap((pkg) => {
        try {
          return sources(join(PACKAGES, pkg, "src"));
        } catch {
          return [];
        }
      })
      .filter((path) => NAMES.test(readFileSync(path, "utf8")))
      .map((path) => relative(REPO, path))
      .toSorted();
    expect(users).toEqual([...OWNERS].toSorted());
  });

  it("is opened once in the lock module, through SQLite", () => {
    const source = readFileSync(join(PACKAGES, "engine/src/platform/lock.ts"), "utf8");
    expect(source.match(/new Database\(/g)).toHaveLength(1);
    expect(source).not.toMatch(/\b(openSync|open|readFileSync|statSync)\(path\b/);
  });
});
