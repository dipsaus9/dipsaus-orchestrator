// A TLS ClientHello built byte by byte, for the web proxy's tunnel inspector tests (DIPO-281).

function u16(value: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(value);
  return out;
}

/** One TLS extension: its type, length and data. */
export function extension(type: number, data: Buffer): Buffer {
  return Buffer.concat([u16(type), u16(data.length), data]);
}

/** The server_name extension with `names` as host names. */
export function serverName(...names: string[]): Buffer {
  const list = Buffer.concat(
    names.map((name) => Buffer.concat([Buffer.from([0]), u16(name.length), Buffer.from(name)])),
  );
  return extension(0, Buffer.concat([u16(list.length), list]));
}

/** A ClientHello handshake message (its header and body) with `extensions`. */
export function helloMessage(extensions: readonly Buffer[]): Buffer {
  const all = Buffer.concat(extensions);
  const body = Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32, 7),
    Buffer.from([0]),
    u16(2),
    Buffer.from([0x13, 0x01]),
    Buffer.from([1, 0]),
    u16(all.length),
    all,
  ]);
  const length = Buffer.alloc(3);
  length.writeUIntBE(body.length, 0, 3);
  return Buffer.concat([Buffer.from([1]), length, body]);
}

/** `message` in TLS handshake records of at most `recordSize` bytes each. */
export function records(message: Buffer, recordSize = 16_384): Buffer {
  const out: Buffer[] = [];
  for (let at = 0; at < message.length; at += recordSize) {
    const part = message.subarray(at, at + recordSize);
    out.push(Buffer.concat([Buffer.from([0x16, 3, 1]), u16(part.length), part]));
  }
  return Buffer.concat(out);
}

/** A whole ClientHello in records, naming `names`. */
export function hello(...names: string[]): Buffer {
  return records(helloMessage([serverName(...names)]));
}

export { u16 };
