// The address a connection came from (DIPO-425): what the model proxy knows a box by.

/** The address a peer is known by: an IPv4-mapped IPv6 form as its IPv4 address; null for none. */
export function peerAddress(peer: string | null | undefined): string | null {
  if (peer === null || peer === undefined || peer === "") return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(peer);
  return mapped?.[1] ?? peer;
}
