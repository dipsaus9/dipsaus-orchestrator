// Client-made request ids (0005 section 2): a bare ULID, the time part from the injected clock and
// the random part from Web Crypto, which every runtime the client targets has.

import type { Clock, RequestId } from "@dipsaus-orchestrator/contract";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Fills `bytes` with random values; injectable for tests. */
export type RandomBytes = (bytes: Uint8Array) => Uint8Array;

const webCrypto: RandomBytes = (bytes) => crypto.getRandomValues(bytes);

/** A source of fresh request ids. */
export type RequestIds = () => RequestId;

export function ulidRequestIds(clock: Clock, random: RandomBytes = webCrypto): RequestIds {
  return () => {
    let time = Math.max(0, Math.floor(clock.now()));
    let text = "";
    // 10 characters of 5 bits hold the 48-bit time; the first is at most 7.
    for (let i = 0; i < 10; i++) {
      text = CROCKFORD.charAt(time % 32) + text;
      time = Math.floor(time / 32);
    }
    const bytes = random(new Uint8Array(16));
    for (const byte of bytes) text += CROCKFORD.charAt(byte % 32);
    return text as RequestId;
  };
}
