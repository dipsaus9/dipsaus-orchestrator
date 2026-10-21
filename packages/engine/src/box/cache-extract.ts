// The copy-out of a filled package cache (DIPO-267). The fill box writes its cache as one tar
// archive; `container copy` copies only that file into a fresh folder of dipo's, and dipo extracts
// it here. The rules are kept few, so they are easy to check:
//
// - The folder must hold exactly one entry, a regular file with one link (lstat), opened with
//   O_NOFOLLOW and checked again on the open file, within `CACHE_ARCHIVE_LIMITS`.
// - Only folders and regular files are taken. Every symlink and hard link is refused: Bun's
//   install cache, npm's `_cacache` and pnpm's store hold none that a box needs. If a manager's
//   cache ever does, the fill fails loudly with `box.cacheFillFailed` and the live run shows it.
// - Every path is relative, with no `..`, `.` or empty part. Two entries whose paths match once
//   Unicode-decomposed and lower-cased (as on a case- and normalisation-insensitive APFS volume)
//   are refused, also a folder and a file, and a path below an earlier file.
// - Files are created with O_CREAT|O_EXCL|O_NOFOLLOW (an existing path is refused), and before each
//   write the real path of its folder must be exactly the destination's real path joined with the
//   entry's folder.
// - The entry count and the extracted bytes are capped. File modes keep only the execute bits.
// - It reads ustar and GNU tar (`L` long names) and pax `x` headers, whose `path` it applies and
//   whose `size` must match the header. Global pax headers, GNU long link names, sparse entries and
//   any pax record it does not know are refused: what it does not fully handle fails closed.

import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { join, posix } from "node:path";

import { BoxError } from "./port";

/** The caps of one cache archive. */
export interface CacheArchiveLimits {
  /** The largest archive, in the fill box and on the Mac. */
  readonly maxArchiveBytes: number;
  /** The most entries (headers) an archive may hold. */
  readonly maxEntries: number;
  /** The most bytes of files an archive may unpack to. */
  readonly maxTotalBytes: number;
}

const GIB = 1024 ** 3;
/** dipo's caps: 8 GiB of archive, two million entries, 8 GiB unpacked. */
export const CACHE_ARCHIVE_LIMITS: CacheArchiveLimits = {
  maxArchiveBytes: 8 * GIB,
  maxEntries: 2_000_000,
  maxTotalBytes: 8 * GIB,
};

const BLOCK = 512;
/** How much of a file is copied at once. */
const CHUNK = 1024 * 1024;
/** The longest long name or pax header read. */
const MAX_HEADER_DATA = 64 * 1024;
/** pax records that only describe the entry and are not applied. */
const IGNORED_PAX = new Set(["mtime", "atime", "ctime", "uid", "gid", "uname", "gname"]);
const IGNORED_PAX_PREFIXES = ["LIBARCHIVE.xattr.", "SCHILY.xattr."];

function refuse(message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new BoxError("box.cacheFillFailed", `the package cache archive ${message}`, false, details);
}

/** A NUL-ended text field of a header. */
function text(header: Uint8Array, start: number, length: number): string {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);
  return new TextDecoder().decode(end < 0 ? field : field.subarray(0, end));
}

/** A numeric field: octal text, or GNU's base-256 within a safe integer. */
function number(header: Uint8Array, start: number, length: number): number {
  const field = header.subarray(start, start + length);
  if ((field[0]! & 0x80) !== 0) {
    if ((field[0]! & 0x40) !== 0) refuse("holds a negative number.");
    let value = field[0]! & 0x3f;
    for (const byte of field.subarray(1)) {
      value = value * 256 + byte;
      if (!Number.isSafeInteger(value)) refuse("holds a number dipo cannot read.");
    }
    return value;
  }
  const digits = text(header, start, length).trim();
  if (digits === "") return 0;
  if (!/^[0-7]+$/.test(digits)) refuse("holds a number that is not octal.", { digits });
  const value = Number.parseInt(digits, 8);
  if (!Number.isSafeInteger(value)) refuse("holds a number dipo cannot read.");
  return value;
}

function checksumOk(header: Uint8Array): boolean {
  let sum = 0;
  for (let at = 0; at < BLOCK; at += 1) sum += at >= 148 && at < 156 ? 0x20 : header[at]!;
  return sum === number(header, 148, 8);
}

/** The records of a pax extended header (`<length> <key>=<value>\n`). */
function paxRecords(bytes: Uint8Array): Map<string, string> {
  const records = new Map<string, string>();
  const decoder = new TextDecoder();
  let at = 0;
  while (at < bytes.length) {
    const space = bytes.indexOf(0x20, at);
    const digits = space < 0 ? "" : decoder.decode(bytes.subarray(at, space));
    const length = /^\d+$/.test(digits) ? Number(digits) : Number.NaN;
    if (!Number.isSafeInteger(length) || length <= space - at + 1 || at + length > bytes.length) {
      refuse("holds a bad pax header.");
    }
    if (bytes[at + length - 1] !== 0x0a) refuse("holds a bad pax record.");
    const record = decoder.decode(bytes.subarray(space + 1, at + length - 1));
    const equals = record.indexOf("=");
    if (equals <= 0) refuse("holds a bad pax record.");
    const key = record.slice(0, equals);
    if (records.has(key)) refuse(`repeats the pax record ${key}.`, { key });
    records.set(key, record.slice(equals + 1));
    at += length;
  }
  return records;
}

/** An entry path made relative and checked: no `..`, `.` or empty part; null for the root. */
function entryPath(raw: string): string | null {
  let path = raw;
  while (path.startsWith("./")) path = path.slice(2);
  if (path.endsWith("/")) path = path.slice(0, -1);
  if (path === "" || path === ".") return null;
  if (
    path.startsWith("/") ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    refuse(`holds the path ${JSON.stringify(raw)}, which leaves its folder.`, { path: raw });
  }
  return path;
}

/** The key two paths share on a case- and normalisation-insensitive volume. */
function collisionKey(path: string): string {
  return path.normalize("NFD").toLowerCase();
}

/** The one regular file `folder` holds, with one link; refuses anything else. */
async function archiveIn(folder: string, limits: CacheArchiveLimits): Promise<string> {
  const names = await readdir(folder);
  if (names.length !== 1) refuse(`folder holds ${names.length} entries, not one.`, { folder });
  const path = join(folder, names[0]!);
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1) {
    refuse("is not a regular file with one link.", { path });
  }
  if (info.size > limits.maxArchiveBytes) {
    refuse(`is ${info.size} bytes, more than ${limits.maxArchiveBytes}.`, { size: info.size });
  }
  return path;
}

/** Collision keys of the entries seen and of the folders their paths need. */
class Claims {
  readonly #kinds = new Map<string, "file" | "folder">();
  readonly #entries = new Set<string>();

  /** Records `entry`; refuses a second entry of its key, a file/folder clash, a path below a file. */
  claim(entry: string, kind: "file" | "folder"): void {
    const parts = entry.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      const key = collisionKey(parts.slice(0, depth).join("/"));
      if (this.#kinds.get(key) === "file") refuse(`holds ${entry} below a file.`, { path: entry });
      this.#kinds.set(key, "folder");
    }
    const key = collisionKey(entry);
    if (this.#entries.has(key) || (this.#kinds.has(key) && this.#kinds.get(key) !== kind)) {
      refuse(`holds ${entry} twice, or as a file and a folder.`, { path: entry });
    }
    this.#entries.add(key);
    this.#kinds.set(key, kind);
  }
}

/** Makes `folder` (relative to `realDest`) and checks its real path is exactly where it belongs. */
async function makeFolder(realDest: string, folder: string): Promise<string> {
  const expected = folder === "." ? realDest : join(realDest, folder);
  await mkdir(expected, { recursive: true, mode: 0o755 });
  if ((await realpath(expected)) !== expected) {
    refuse(`holds ${folder}, a folder that is not where it belongs.`, { path: folder });
  }
  return expected;
}

/**
 * Extracts the one archive in the fresh folder `folder` into the existing, empty folder `dest`,
 * by the rules in the module comment. Refuses with `box.cacheFillFailed`.
 */
export async function extractCacheArchive(
  folder: string,
  dest: string,
  limits: CacheArchiveLimits = CACHE_ARCHIVE_LIMITS,
): Promise<void> {
  try {
    await extract(folder, dest, limits);
  } catch (error) {
    if (error instanceof BoxError) throw error;
    refuse(`could not be extracted: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function extract(folder: string, dest: string, limits: CacheArchiveLimits): Promise<void> {
  const path = await archiveIn(folder, limits);
  const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await input.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > limits.maxArchiveBytes) {
      refuse("changed after it was checked.", { path });
    }
    const total = opened.size;
    const realDest = await realpath(dest);
    const claims = new Claims();
    const header = new Uint8Array(BLOCK);
    let position = 0;
    let entries = 0;
    let bytes = 0;
    let longName: string | null = null;
    let pax: Map<string, string> | null = null;

    const readData = async (size: number): Promise<Uint8Array> => {
      if (size > MAX_HEADER_DATA) refuse("holds a header that is too long.");
      const data = new Uint8Array(size);
      const { bytesRead } = await input.read(data, 0, size, position);
      if (bytesRead !== size) refuse("is truncated.");
      return data;
    };

    for (;;) {
      const { bytesRead } = await input.read(header, 0, BLOCK, position);
      if (bytesRead === 0) break;
      if (bytesRead !== BLOCK) refuse("is truncated.");
      if (header.every((byte) => byte === 0)) break;
      if (!checksumOk(header)) refuse("holds a header with a bad checksum.", { position });
      entries += 1;
      if (entries > limits.maxEntries) refuse(`holds more than ${limits.maxEntries} entries.`);
      const type = String.fromCharCode(header[156]!);
      const size = number(header, 124, 12);
      position += BLOCK;
      const padded = Math.ceil(size / BLOCK) * BLOCK;
      if (position + padded > total) refuse("is truncated.");

      if (type === "L") {
        if (longName !== null) refuse("holds two long names for one entry.");
        longName = text(await readData(size), 0, size);
        position += padded;
        continue;
      }
      if (type === "x") {
        if (pax !== null) refuse("holds two pax headers for one entry.");
        pax = paxRecords(await readData(size));
        for (const key of pax.keys()) {
          const known =
            key === "path" ||
            key === "size" ||
            IGNORED_PAX.has(key) ||
            IGNORED_PAX_PREFIXES.some((prefix) => key.startsWith(prefix));
          if (!known) refuse(`holds the pax record ${key}, which dipo does not take.`, { key });
        }
        position += padded;
        continue;
      }
      if (type !== "0" && type !== "\0" && type !== "5") {
        const what =
          type === "1" || type === "2" || type === "K"
            ? "a link; the package cache takes no links"
            : `an entry of type ${JSON.stringify(type)} dipo does not take`;
        refuse(`holds ${what}.`, { type, name: text(header, 0, 100) });
      }

      const ustar = text(header, 257, 6) === "ustar" && text(header, 263, 2) === "00";
      const prefix = ustar ? text(header, 345, 155) : "";
      const named = text(header, 0, 100);
      const paxSize = pax?.get("size");
      if (paxSize !== undefined && paxSize !== String(size)) {
        refuse("holds a pax size that differs from its header.", { paxSize, size });
      }
      const raw = pax?.get("path") ?? longName ?? (prefix === "" ? named : `${prefix}/${named}`);
      longName = null;
      pax = null;
      const entry = entryPath(raw);

      if (type === "5") {
        if (size !== 0) refuse("holds a folder with data.");
        if (entry !== null) {
          claims.claim(entry, "folder");
          await makeFolder(realDest, entry);
        }
        continue;
      }
      if (entry === null) refuse("holds a file without a name.");
      claims.claim(entry, "file");
      bytes += size;
      if (bytes > limits.maxTotalBytes) {
        refuse(`unpacks to more than ${limits.maxTotalBytes} bytes.`);
      }
      const at = join(await makeFolder(realDest, posix.dirname(entry)), posix.basename(entry));
      const mode = (number(header, 100, 8) & 0o111) === 0 ? 0o644 : 0o755;
      const output = await open(
        at,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        mode,
      ).catch((error: unknown) => {
        if ((error as { code?: string }).code === "EEXIST") refuse(`holds ${entry} twice.`);
        throw error;
      });
      try {
        const buffer = new Uint8Array(Math.min(CHUNK, Math.max(size, 1)));
        let copied = 0;
        while (copied < size) {
          const want = Math.min(buffer.length, size - copied);
          const read = await input.read(buffer, 0, want, position + copied);
          if (read.bytesRead !== want) refuse("is truncated.");
          await output.write(buffer, 0, want);
          copied += want;
        }
      } finally {
        await output.close();
      }
      position += padded;
    }
    if (longName !== null || pax !== null) refuse("ends inside an entry.");
  } finally {
    await input.close();
  }
}
