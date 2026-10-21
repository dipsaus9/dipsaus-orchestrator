// Tar archives built byte by byte for the archive tests (DIPO-267, DIPO-273), so the hostile ones a
// real tar would not write can be tested too.

const encoder = new TextEncoder();

/** One entry of an archive. */
export interface TarEntry {
  readonly name: string;
  /** `0` file, `5` folder, `2` symlink, `1` hard link, `L` long name, `x`/`g` pax, ... */
  readonly type: string;
  readonly data?: string | Uint8Array;
  readonly link?: string;
  readonly mode?: number;
  /** Writes `ustar\0` `00` with this prefix instead of GNU's magic. */
  readonly prefix?: string;
}

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

/** One header block and its data blocks. */
function block(entry: TarEntry): Uint8Array {
  const data =
    typeof entry.data === "string" ? encoder.encode(entry.data) : (entry.data ?? new Uint8Array());
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

/** The archive of `entries`, with its two end blocks. */
export function tarBytes(entries: readonly TarEntry[]): Uint8Array {
  const parts = [...entries.map(block), new Uint8Array(1024)];
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

/** One pax record, `<length> <key>=<value>\n`, its length counting itself. */
export function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 2;
  if (`${length}${body}`.length !== length) length += 1;
  return `${length}${body}`;
}
