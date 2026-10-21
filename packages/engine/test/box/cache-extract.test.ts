// The extraction of a fill box's cache archive on the Mac (DIPO-267): archives built here byte by
// byte, so the hostile ones a real tar would not write can be tested, such as `d -> ../..` followed
// by `d/x`. Nothing may land outside the destination.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { extractCacheArchive } from "../../src/box/cache-extract";
import { BoxError } from "../../src/box/port";

const encoder = new TextEncoder();

interface Entry {
  readonly name: string;
  /** `0` file, `5` folder, `2` symlink, `1` hard link, `L` long name, `x` pax header, ... */
  readonly type: string;
  readonly data?: string;
  readonly link?: string;
  readonly mode?: number;
  /** Writes `ustar\0` `00` with this prefix instead of GNU's magic. */
  readonly prefix?: string;
}

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

/** One header block and its data blocks. */
function block(entry: Entry): Uint8Array {
  const data = encoder.encode(entry.data ?? "");
  const header = new Uint8Array(512);
  const put = (text: string, at: number) => header.set(encoder.encode(text), at);
  put(entry.name, 0);
  put(octal(entry.mode ?? 0o644, 8), 100);
  put(octal(0, 8), 108);
  put(octal(0, 8), 116);
  put(octal(data.length, 12), 124);
  put(octal(0, 12), 136);
  header[156] = entry.type.charCodeAt(0);
  put(entry.link ?? "", 157);
  if (entry.prefix === undefined) put("ustar  \0", 257);
  else {
    put("ustar\0", 257);
    put("00", 263);
    put(entry.prefix, 345);
  }
  put("        ", 148);
  const sum = header.reduce((total, byte) => total + byte, 0);
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const padded = new Uint8Array(512 + Math.ceil(data.length / 512) * 512);
  padded.set(header);
  padded.set(data, 512);
  return padded;
}

function archive(dir: string, entries: readonly Entry[]): string {
  const parts = [...entries.map(block), new Uint8Array(1024)];
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  const path = join(dir, "cache.tar");
  writeFileSync(path, bytes);
  return path;
}

/** The destination folder, inside a parent that holds a marker the archive must not reach. */
function destination(dir: string): string {
  const parent = join(dir, "parent");
  mkdirSync(join(parent, "dest"), { recursive: true });
  writeFileSync(join(parent, "marker"), "keep\n");
  return join(parent, "dest");
}

/** Everything below `dir` except `dest`, so a write outside it shows. */
function outside(dir: string): string[] {
  return readdirSync(join(dir, "parent"), { recursive: true })
    .map(String)
    .filter((path) => path !== "dest" && !path.startsWith("dest/"))
    .toSorted();
}

async function refused(promise: Promise<unknown>): Promise<BoxError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BoxError);
    expect((error as BoxError).code).toBe("box.cacheFillFailed");
    return error as BoxError;
  }
  throw new Error("expected the archive to be refused");
}

/** One pax record, `<length> <key>=<value>\n`, its length counting itself. */
function record(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 2;
  if (`${length}${body}`.length !== length) length += 1;
  return `${length}${body}`;
}

describe("extracting a cache archive", () => {
  it("writes folders, files and in-tree symlinks, keeping only the execute bits", () =>
    withTempDir(async (dir) => {
      const dest = destination(dir);
      const long = `bun/${"a".repeat(120)}@1.0.0@@@1/package.json`;
      await extractCacheArchive(
        archive(dir, [
          { name: "bun/", type: "5" },
          { name: "bun/x@1.0.0@@@1/index.js", type: "0", data: "exports.x = 1;\n", mode: 0o4755 },
          { name: "././@LongLink", type: "L", data: `${long}\0` },
          { name: "truncated", type: "0", data: "{}\n" },
          { name: "pkg.json", type: "0", data: "{}\n", prefix: "bun/y@2.0.0@@@1" },
          { name: "bun/x@1.0.0@@@1/link", type: "2", link: "index.js" },
        ]),
        dest,
      );
      expect(readFileSync(join(dest, "bun/x@1.0.0@@@1/index.js"), "utf8")).toBe("exports.x = 1;\n");
      expect(statSync(join(dest, "bun/x@1.0.0@@@1/index.js")).mode & 0o7777).toBe(0o755);
      expect(readFileSync(join(dest, long), "utf8")).toBe("{}\n");
      expect(readFileSync(join(dest, "bun/y@2.0.0@@@1/pkg.json"), "utf8")).toBe("{}\n");
      expect(readlinkSync(join(dest, "bun/x@1.0.0@@@1/link"))).toBe("index.js");
      expect(outside(dir)).toEqual(["marker"]);
    }));

  it("reads a pax path header", () =>
    withTempDir(async (dir) => {
      const dest = destination(dir);
      await extractCacheArchive(
        archive(dir, [
          { name: "PaxHeader", type: "x", data: record("path", "npm/_cacache/index-v5/aa/bb") },
          { name: "short", type: "0", data: "index\n" },
        ]),
        dest,
      );
      expect(readFileSync(join(dest, "npm/_cacache/index-v5/aa/bb"), "utf8")).toBe("index\n");
    }));

  it("takes what the system's tar writes", () =>
    withTempDir(async (dir) => {
      const source = join(dir, "source");
      mkdirSync(join(source, "bun", "x@1.0.0@@@1"), { recursive: true });
      writeFileSync(join(source, "bun", "x@1.0.0@@@1", "package.json"), "{}\n");
      symlinkSync("package.json", join(source, "bun", "x@1.0.0@@@1", "link"));
      const tar = join(dir, "cache.tar");
      const packed = spawnSync("tar", ["-C", source, "-cf", tar, "bun"], {
        env: { PATH: "/usr/bin:/bin", COPYFILE_DISABLE: "1" },
      });
      expect(packed.status).toBe(0);
      const dest = destination(dir);
      await extractCacheArchive(tar, dest);
      expect(readFileSync(join(dest, "bun/x@1.0.0@@@1/package.json"), "utf8")).toBe("{}\n");
      expect(lstatSync(join(dest, "bun/x@1.0.0@@@1/link")).isSymbolicLink()).toBe(true);
    }));

  it("never writes through a symlink the archive made: d -> ../.. then d/x", () =>
    withTempDir(async (dir) => {
      const dest = destination(dir);
      await refused(
        extractCacheArchive(
          archive(dir, [
            { name: "d", type: "2", link: "../.." },
            { name: "d/x", type: "0", data: "escaped\n" },
          ]),
          dest,
        ),
      );
      expect(outside(dir)).toEqual(["marker"]);
      expect(existsSync(join(dir, "x"))).toBe(false);
      expect(lstatSync(join(dest, "d")).isDirectory()).toBe(true);
    }));

  it("refuses a symlink inside another symlink's path", () =>
    withTempDir(async (dir) => {
      const dest = destination(dir);
      await refused(
        extractCacheArchive(
          archive(dir, [
            { name: "d", type: "2", link: "../.." },
            { name: "d/e", type: "2", link: "marker" },
          ]),
          dest,
        ),
      );
      expect(outside(dir)).toEqual(["marker"]);
      expect(readdirSync(dest)).toEqual([]);
    }));

  for (const [what, entries] of [
    ["an absolute symlink", [{ name: "link", type: "2", link: "/etc/hosts" }]],
    ["a path with ..", [{ name: "../escaped", type: "0", data: "x" }]],
    ["an absolute path", [{ name: "/tmp/escaped", type: "0", data: "x" }]],
    ["a hard link", [{ name: "hard", type: "1", link: "x" }]],
    ["a FIFO", [{ name: "fifo", type: "6" }]],
    [
      "a file written twice",
      [
        { name: "a", type: "0", data: "1" },
        { name: "a", type: "0", data: "2" },
      ],
    ],
  ] as const) {
    it(`refuses ${what}`, () =>
      withTempDir(async (dir) => {
        const dest = destination(dir);
        await expect(extractCacheArchive(archive(dir, entries), dest)).rejects.toThrow();
        expect(outside(dir)).toEqual(["marker"]);
      }));
  }

  it("refuses a bad checksum and a truncated archive", () =>
    withTempDir(async (dir) => {
      const dest = destination(dir);
      const path = archive(dir, [{ name: "a", type: "0", data: "x".repeat(600) }]);
      const bytes = readFileSync(path);
      bytes[0] = "b".charCodeAt(0);
      writeFileSync(path, bytes);
      await refused(extractCacheArchive(path, dest));
      const good = archive(dir, [{ name: "a", type: "0", data: "x".repeat(600) }]);
      writeFileSync(good, readFileSync(good).subarray(0, 700));
      await refused(extractCacheArchive(good, dest));
    }));
});
