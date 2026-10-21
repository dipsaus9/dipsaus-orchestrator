// The copy-out of a filled package cache (DIPO-267). The fill box writes its cache as one tar
// archive; `container copy` copies only that file to the Mac, and dipo extracts it here, so no
// link the box made can steer where a file lands:
//
// - every entry's path stays in the destination: relative, no `..`, `.` or empty part;
// - only folders, regular files and symlinks are taken; hard links, devices and FIFOs are refused;
// - folders and files are written first, files with `wx` (never through or over anything);
//   symlinks are made only after the last file, so no write ever goes through one, and a symlink
//   may not sit inside another symlink's path or on a path that already exists;
// - a symlink's target must be relative; `checkCopiedTree` then resolves each one with realpath;
// - file modes keep only the execute bits (0644 or 0755); owners and times are not kept.
//
// It reads ustar and GNU tar (`L` and `K` long names) and pax extended headers (`x`, `g`).
// Any other entry, a bad checksum or a truncated archive refuses with `box.cacheFillFailed`.

import { lstat, mkdir, open, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { BoxError } from "./port";

const BLOCK = 512;
/** How much of a file is copied at once. */
const CHUNK = 1024 * 1024;
/** The longest long name or pax header read. */
const MAX_HEADER_DATA = 1024 * 1024;

function refuse(message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new BoxError("box.cacheFillFailed", `the package cache archive ${message}`, false, details);
}

/** A NUL-ended text field of a header. */
function text(header: Uint8Array, start: number, length: number): string {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);
  return new TextDecoder().decode(end < 0 ? field : field.subarray(0, end));
}

/** A numeric field: octal text, or GNU's base-256 for large values. */
function number(header: Uint8Array, start: number, length: number): number {
  const field = header.subarray(start, start + length);
  if ((field[0]! & 0x80) !== 0) {
    let value = field[0]! & 0x7f;
    for (const byte of field.subarray(1)) value = value * 256 + byte;
    if (!Number.isSafeInteger(value)) refuse("holds a size dipo cannot read.");
    return value;
  }
  const digits = text(header, start, length).trim();
  if (digits === "") return 0;
  if (!/^[0-7]+$/.test(digits)) refuse("holds a number that is not octal.", { digits });
  return Number.parseInt(digits, 8);
}

function checksumOk(header: Uint8Array): boolean {
  let sum = 0;
  for (let at = 0; at < BLOCK; at += 1) sum += at >= 148 && at < 156 ? 0x20 : header[at]!;
  return sum === number(header, 148, 8);
}

/** The records of a pax extended header (`<length> <key>=<value>\n`). */
function paxRecords(data: Uint8Array): Map<string, string> {
  const records = new Map<string, string>();
  const decoded = new TextDecoder().decode(data);
  let at = 0;
  while (at < decoded.length) {
    const space = decoded.indexOf(" ", at);
    const length = Number.parseInt(decoded.slice(at, space), 10);
    if (space < 0 || !Number.isSafeInteger(length) || length <= 0)
      refuse("holds a bad pax header.");
    const record = decoded.slice(space + 1, at + length - 1);
    const equals = record.indexOf("=");
    if (equals < 0) refuse("holds a bad pax record.");
    records.set(record.slice(0, equals), record.slice(equals + 1));
    at += length;
  }
  return records;
}

/** An entry path made relative and checked: no `..`, `.` or empty part; null for the root. */
function entryPath(raw: string): string | null {
  let path = raw;
  while (path.startsWith("./")) path = path.slice(2);
  while (path.endsWith("/")) path = path.slice(0, -1);
  if (path === "" || path === ".") return null;
  if (
    path.startsWith("/") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    refuse(`holds the path ${JSON.stringify(raw)}, which leaves its folder.`, { path: raw });
  }
  return path;
}

/**
 * Extracts the tar archive `archive` into the existing, empty folder `dest`, by the rules in the
 * module comment. Refuses with `box.cacheFillFailed`.
 */
export async function extractCacheArchive(archive: string, dest: string): Promise<void> {
  const input = await open(archive, "r");
  const links: { path: string; target: string }[] = [];
  try {
    const { size: total } = await input.stat();
    const header = new Uint8Array(BLOCK);
    let position = 0;
    let longName: string | null = null;
    let longLink: string | null = null;
    let pax = new Map<string, string>();

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
      const type = String.fromCharCode(header[156]!);
      const size = number(header, 124, 12);
      position += BLOCK;
      const padded = Math.ceil(size / BLOCK) * BLOCK;
      if (position + padded > total) refuse("is truncated.");

      if (type === "L" || type === "K") {
        const value = text(await readData(size), 0, size);
        if (type === "L") longName = value;
        else longLink = value;
        position += padded;
        continue;
      }
      if (type === "x" || type === "g") {
        const records = paxRecords(await readData(size));
        if (type === "x") pax = records;
        position += padded;
        continue;
      }

      const ustar = text(header, 257, 6) === "ustar" && text(header, 263, 2) === "00";
      const prefix = ustar ? text(header, 345, 155) : "";
      const named = text(header, 0, 100);
      const raw = pax.get("path") ?? longName ?? (prefix === "" ? named : `${prefix}/${named}`);
      const linkTarget = pax.get("linkpath") ?? longLink ?? text(header, 157, 100);
      longName = null;
      longLink = null;
      pax = new Map();
      const path = entryPath(raw);

      if (type === "5") {
        if (path !== null) await mkdir(join(dest, path), { recursive: true, mode: 0o755 });
      } else if (type === "0" || type === "\0" || type === "7") {
        if (path === null) refuse("holds a file without a name.");
        await mkdir(dirname(join(dest, path)), { recursive: true, mode: 0o755 });
        const mode = (number(header, 100, 8) & 0o111) === 0 ? 0o644 : 0o755;
        const output = await open(join(dest, path), "wx", mode);
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
      } else if (type === "2") {
        if (path === null) refuse("holds a symlink without a name.");
        if (linkTarget === "" || isAbsolute(linkTarget)) {
          refuse(`holds ${path}, a symlink to the absolute path ${linkTarget}.`, {
            path,
            target: linkTarget,
          });
        }
        links.push({ path, target: linkTarget });
      } else {
        refuse(`holds ${raw}, an entry of type ${JSON.stringify(type)} dipo does not take.`, {
          path: raw,
          type,
        });
      }
      position += padded;
    }
  } finally {
    await input.close();
  }

  // Symlinks last: nothing is written after them, so no write goes through one.
  const linkPaths = new Set(links.map((link) => link.path));
  for (const link of links) {
    const parts = link.path.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      if (linkPaths.has(parts.slice(0, depth).join("/"))) {
        refuse(`holds ${link.path}, a symlink inside another symlink's path.`, { path: link.path });
      }
    }
  }
  for (const link of links) {
    const at = join(dest, link.path);
    if ((await lstat(at).catch(() => null)) !== null) {
      refuse(`holds ${link.path} twice, once as a symlink.`, { path: link.path });
    }
    await mkdir(dirname(at), { recursive: true, mode: 0o755 });
    await symlink(link.target, at);
  }
}
