// The extraction of a fill box's cache archive on the Mac (DIPO-267): archives built here byte by
// byte, so the hostile ones a real tar would not write can be tested. Only files and folders are
// taken, nothing lands outside the destination, and the archive itself must be one regular file.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import type { Signal } from "@dipsaus-orchestrator/contract";
import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import {
  CACHE_ARCHIVE_LIMITS,
  extractCacheArchive,
  streamCacheArchive,
} from "../../src/box/cache-extract";
import { BoxError, type BoxPort } from "../../src/box/port";

const encoder = new TextEncoder();

interface Entry {
  readonly name: string;
  /** `0` file, `5` folder, `2` symlink, `1` hard link, `L` long name, `x`/`g` pax, ... */
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

function tarBytes(entries: readonly Entry[]): Uint8Array {
  const parts = [...entries.map(block), new Uint8Array(1024)];
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

/** A fresh folder holding the archive of `entries`, as the copy-out leaves it. */
function archive(dir: string, entries: readonly Entry[]): string {
  const folder = join(dir, "archive");
  mkdirSync(folder);
  writeFileSync(join(folder, "cache.tar"), tarBytes(entries));
  return folder;
}

/** One pax record, `<length> <key>=<value>\n`, its length counting itself. */
function record(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 2;
  if (`${length}${body}`.length !== length) length += 1;
  return `${length}${body}`;
}

/** The destination folder, inside a parent that holds a marker the archive must not reach. */
function destination(dir: string): string {
  const parent = join(dir, "parent");
  mkdirSync(join(parent, "dest"), { recursive: true });
  writeFileSync(join(parent, "marker"), "keep\n");
  return join(parent, "dest");
}

/** Everything in the parent but `dest`, so a write outside it shows. */
function outside(dir: string): string[] {
  return readdirSync(join(dir, "parent"), { recursive: true })
    .map(String)
    .filter((path) => path !== "dest" && !path.startsWith("dest/"))
    .toSorted();
}

async function refused(promise: Promise<unknown>, why?: string): Promise<BoxError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BoxError);
    expect((error as BoxError).code).toBe("box.cacheFillFailed");
    if (why !== undefined) expect((error as BoxError).message).toContain(why);
    return error as BoxError;
  }
  throw new Error("expected the archive to be refused");
}

describe("extracting a cache archive", () => {
  it("writes folders and files, keeping only the execute bits", () =>
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
          { name: "PaxHeader", type: "x", data: record("path", "npm/_cacache/index-v5/aa/bb") },
          { name: "short", type: "0", data: "index\n" },
        ]),
        dest,
      );
      const index = join(dest, "bun/x@1.0.0@@@1/index.js");
      expect(readFileSync(index, "utf8")).toBe("exports.x = 1;\n");
      expect(statSync(index).mode & 0o7777).toBe(0o755);
      expect(readFileSync(join(dest, long), "utf8")).toBe("{}\n");
      expect(readFileSync(join(dest, "bun/y@2.0.0@@@1/pkg.json"), "utf8")).toBe("{}\n");
      expect(readFileSync(join(dest, "npm/_cacache/index-v5/aa/bb"), "utf8")).toBe("index\n");
      expect(outside(dir)).toEqual(["marker"]);
    }));

  it("takes what the system's tar writes", () =>
    withTempDir(async (dir) => {
      const source = join(dir, "source");
      mkdirSync(join(source, "bun", "x@1.0.0@@@1"), { recursive: true });
      writeFileSync(join(source, "bun", "x@1.0.0@@@1", "package.json"), "{}\n");
      const folder = join(dir, "archive");
      mkdirSync(folder);
      const packed = spawnSync("tar", ["-C", source, "-cf", join(folder, "cache.tar"), "bun"], {
        env: { PATH: "/usr/bin:/bin", COPYFILE_DISABLE: "1" },
      });
      expect(packed.status).toBe(0);
      const dest = destination(dir);
      await extractCacheArchive(folder, dest);
      expect(readFileSync(join(dest, "bun/x@1.0.0@@@1/package.json"), "utf8")).toBe("{}\n");
    }));
});

describe("links", () => {
  it("refuses `L -> ../../outside` before `l/planted` can use it", () =>
    withTempDir(async (dir) => {
      const dest = destination(dir);
      await refused(
        extractCacheArchive(
          archive(dir, [
            { name: "L", type: "2", link: "../../outside" },
            { name: "l/planted", type: "2", link: "/etc/hosts" },
          ]),
          dest,
        ),
        "takes no links",
      );
      await refused(
        extractCacheArchive(
          (() => {
            const folder = join(dir, "second");
            mkdirSync(folder);
            writeFileSync(
              join(folder, "cache.tar"),
              tarBytes([
                { name: "L", type: "2", link: "../.." },
                { name: "l/x", type: "0", data: "escaped\n" },
              ]),
            );
            return folder;
          })(),
          dest,
        ),
        "takes no links",
      );
      expect(outside(dir)).toEqual(["marker"]);
      expect(existsSync(join(dir, "outside"))).toBe(false);
      expect(readdirSync(dest)).toEqual([]);
    }));

  for (const [what, entry] of [
    ["a symlink", { name: "link", type: "2", link: "index.js" }],
    ["a hard link", { name: "hard", type: "1", link: "index.js" }],
    ["a GNU long link name", { name: "././@LongLink", type: "K", data: "target\0" }],
  ] as const) {
    it(`refuses ${what}, even one that stays in the tree`, () =>
      withTempDir(async (dir) => {
        const dest = destination(dir);
        await refused(
          extractCacheArchive(
            archive(dir, [{ name: "index.js", type: "0", data: "x" }, entry]),
            dest,
          ),
          "takes no links",
        );
        expect(outside(dir)).toEqual(["marker"]);
      }));
  }
});

describe("collisions", () => {
  for (const [what, entries] of [
    [
      "a file written twice",
      [
        { name: "a", type: "0", data: "1" },
        { name: "a", type: "0", data: "2" },
      ],
    ],
    [
      "two names that differ only in case",
      [
        { name: "Pkg/index.js", type: "0", data: "1" },
        { name: "pkg/index.js", type: "0", data: "2" },
      ],
    ],
    [
      "the NFC and NFD forms of one name",
      [
        { name: "café/a", type: "0", data: "1" },
        { name: "café/a", type: "0", data: "2" },
      ],
    ],
    [
      "a folder and a file of one name",
      [
        { name: "a/", type: "5" },
        { name: "a", type: "0", data: "x" },
      ],
    ],
    [
      "a file and then a path below it",
      [
        { name: "a", type: "0", data: "x" },
        { name: "A/b", type: "0", data: "y" },
      ],
    ],
  ] as const) {
    it(`refuses ${what}`, () =>
      withTempDir(async (dir) => {
        const dest = destination(dir);
        await refused(extractCacheArchive(archive(dir, entries), dest));
        expect(outside(dir)).toEqual(["marker"]);
      }));
  }
});

describe("the archive file", () => {
  it("refuses a symlink in place of the archive", () =>
    withTempDir(async (dir) => {
      const folder = join(dir, "archive");
      mkdirSync(folder);
      writeFileSync(join(dir, "mac-file"), tarBytes([{ name: "a", type: "0", data: "x" }]));
      symlinkSync(join(dir, "mac-file"), join(folder, "cache.tar"));
      await refused(extractCacheArchive(folder, destination(dir)), "regular file");
    }));

  it("refuses a folder, a hard-linked file, and a folder holding more than the archive", () =>
    withTempDir(async (dir) => {
      const dest = destination(dir);
      const asFolder = join(dir, "one");
      mkdirSync(join(asFolder, "cache.tar"), { recursive: true });
      await refused(extractCacheArchive(asFolder, dest), "regular file");

      const linked = join(dir, "two");
      mkdirSync(linked);
      writeFileSync(join(dir, "mac-file"), tarBytes([{ name: "a", type: "0", data: "x" }]));
      linkSync(join(dir, "mac-file"), join(linked, "cache.tar"));
      await refused(extractCacheArchive(linked, dest), "regular file");

      const crowded = archive(dir, [{ name: "a", type: "0", data: "x" }]);
      writeFileSync(join(crowded, "extra"), "");
      await refused(extractCacheArchive(crowded, dest), "not one");

      const empty = join(dir, "three");
      mkdirSync(empty);
      await refused(extractCacheArchive(empty, dest), "not one");
    }));
});

describe("caps", () => {
  it("refuses an archive, an entry count and unpacked bytes above their caps", () =>
    withTempDir(async (dir) => {
      const dest = destination(dir);
      const folder = archive(dir, [
        { name: "a", type: "0", data: "x".repeat(600) },
        { name: "b", type: "0", data: "y".repeat(600) },
      ]);
      await refused(
        extractCacheArchive(folder, dest, { ...CACHE_ARCHIVE_LIMITS, maxArchiveBytes: 1000 }),
        "more than 1000",
      );
      await refused(
        extractCacheArchive(folder, dest, { ...CACHE_ARCHIVE_LIMITS, maxEntries: 1 }),
        "more than 1 entries",
      );
      await refused(
        extractCacheArchive(folder, join(dir, "parent"), {
          ...CACHE_ARCHIVE_LIMITS,
          maxTotalBytes: 1000,
        }),
        "more than 1000 bytes",
      );
      expect(CACHE_ARCHIVE_LIMITS).toEqual({
        maxArchiveBytes: 8 * 1024 ** 3,
        maxEntries: 2_000_000,
        maxTotalBytes: 8 * 1024 ** 3,
      });
    }));
});

describe("what the extractor does not fully handle", () => {
  for (const [what, entries, why] of [
    [
      "a global pax header",
      [
        { name: "g", type: "g", data: record("path", "x") },
        { name: "a", type: "0", data: "x" },
      ],
      'type "g"',
    ],
    [
      "a pax size that differs from its header",
      [
        { name: "x", type: "x", data: record("size", "99") },
        { name: "a", type: "0", data: "x" },
      ],
      "pax size",
    ],
    [
      "a pax record it does not know",
      [
        { name: "x", type: "x", data: record("GNU.sparse.map", "0,1") },
        { name: "a", type: "0", data: "x" },
      ],
      "GNU.sparse.map",
    ],
    ["a sparse entry", [{ name: "s", type: "S", data: "x" }], 'type "S"'],
    ["a FIFO", [{ name: "fifo", type: "6" }], 'type "6"'],
    ["a path with ..", [{ name: "../escaped", type: "0", data: "x" }], "leaves its folder"],
    ["an absolute path", [{ name: "/tmp/escaped", type: "0", data: "x" }], "leaves its folder"],
  ] as const) {
    it(`refuses ${what}`, () =>
      withTempDir(async (dir) => {
        const dest = destination(dir);
        await refused(extractCacheArchive(archive(dir, entries), dest), why);
        expect(outside(dir)).toEqual(["marker"]);
      }));
  }

  it("refuses a bad checksum and a truncated archive", () =>
    withTempDir(async (dir) => {
      const dest = destination(dir);
      const folder = archive(dir, [{ name: "a", type: "0", data: "x".repeat(600) }]);
      const bytes = readFileSync(join(folder, "cache.tar"));
      bytes[0] = "b".charCodeAt(0);
      writeFileSync(join(folder, "cache.tar"), bytes);
      await refused(extractCacheArchive(folder, dest), "checksum");
      writeFileSync(
        join(folder, "cache.tar"),
        tarBytes([{ name: "a", type: "0", data: "x".repeat(600) }]).subarray(0, 700),
      );
      await refused(extractCacheArchive(folder, dest), "truncated");
    }));
});

/** Does nothing: what `close` is before the stream starts. */
function nothing(): void {}

/** A box whose `cat` streams `chunks`, then exits with `code`; `hang` keeps it open until killed. */
function streamingBox(chunks: readonly string[], code: number | null = 0, hang = false) {
  const calls: string[] = [];
  let finish!: (exit: { code: number | null; signal: Signal | null }) => void;
  const exited = new Promise<{ code: number | null; signal: Signal | null }>((resolve) => {
    finish = resolve;
  });
  let close: () => void = nothing;
  const boxes: Pick<BoxPort, "execLive" | "stop"> = {
    execLive: (box, command) => {
      calls.push(`execLive ${box} ${command.join(" ")}`);
      return {
        stdin: { write: () => {}, end: () => {} },
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            close = () => {
              try {
                controller.close();
              } catch {
                // Already closed.
              }
            };
            if (!hang) close();
          },
        }),
        stderr: new ReadableStream({ start: (controller) => controller.close() }),
        exited,
        kill: (signal: Signal = "SIGTERM") => {
          calls.push(`kill ${signal}`);
          close();
          finish({ code: null, signal });
        },
      };
    },
    stop: async (box) => {
      calls.push(`stop ${box}`);
    },
  };
  if (!hang) finish({ code, signal: null });
  return { boxes, calls };
}

function stream(
  dir: string,
  boxes: Pick<BoxPort, "execLive" | "stop">,
  clock = new ManualClock(),
  maxBytes = 1000,
) {
  const folder = join(dir, "archive");
  mkdirSync(folder, { recursive: true });
  return {
    folder,
    clock,
    done: streamCacheArchive({
      boxes,
      box: "dipo-fill-1",
      from: "/tmp/dipo-fill/cache.tar",
      folder,
      name: "cache.tar",
      maxBytes,
      timeoutMs: 60_000,
      clock,
    }),
  };
}

describe("streaming the archive out of the fill box", () => {
  it("writes the stream into the only entry of the fresh folder", () =>
    withTempDir(async (dir) => {
      const { boxes, calls } = streamingBox(["part one, ", "part two"]);
      const { folder, done } = stream(dir, boxes);
      expect(await done).toBe(join(folder, "cache.tar"));
      expect(readdirSync(folder)).toEqual(["cache.tar"]);
      expect(readFileSync(join(folder, "cache.tar"), "utf8")).toBe("part one, part two");
      expect(calls).toEqual(["execLive dipo-fill-1 cat /tmp/dipo-fill/cache.tar"]);
    }));

  it("cuts a stream over the cap, ends the process in the box and leaves nothing", () =>
    withTempDir(async (dir) => {
      const { boxes, calls } = streamingBox(["x".repeat(600), "y".repeat(600)], 0, true);
      const { folder, done } = stream(dir, boxes);
      await refused(done, "was cut");
      expect(readdirSync(folder)).toEqual([]);
      expect(calls).toEqual([
        "execLive dipo-fill-1 cat /tmp/dipo-fill/cache.tar",
        "kill SIGKILL",
        "stop dipo-fill-1",
      ]);
    }));

  it("refuses a stream that fails midway and leaves nothing", () =>
    withTempDir(async (dir) => {
      const { boxes, calls } = streamingBox(["half of it"], 1);
      const { folder, done } = stream(dir, boxes);
      await refused(done, "exit 1");
      expect(readdirSync(folder)).toEqual([]);
      expect(calls.at(-1)).toBe("stop dipo-fill-1");
    }));

  it("refuses a stream at its deadline, ends the process in the box and leaves nothing", () =>
    withTempDir(async (dir) => {
      const { boxes, calls } = streamingBox(["some"], 0, true);
      const { folder, clock, done } = stream(dir, boxes);
      const refusal = refused(done, "deadline");
      while (clock.pendingTimers === 0) await Bun.sleep(1);
      clock.advance(60_000);
      await refusal;
      expect(readdirSync(folder)).toEqual([]);
      expect(calls.slice(-2)).toEqual(["kill SIGKILL", "stop dipo-fill-1"]);
    }));

  it("refuses a folder that is not empty before anything runs", () =>
    withTempDir(async (dir) => {
      const { boxes, calls } = streamingBox(["x"]);
      mkdirSync(join(dir, "archive"));
      writeFileSync(join(dir, "archive", "planted"), "");
      await refused(stream(dir, boxes).done, "not empty");
      expect(calls).toEqual([]);
    }));
});
