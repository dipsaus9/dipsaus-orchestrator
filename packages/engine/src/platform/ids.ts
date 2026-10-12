// The system id source: a 0005 prefix plus a ULID, implemented here with no dependency.
// A ULID is 10 Crockford base32 characters of millisecond time and 16 of randomness. Ids made
// in the same millisecond increment the random part, so ids from one source sort in creation
// order (monotonic ULID).

import type { Clock, IdPrefix, IdSource } from "@dipsaus-orchestrator/contract";

import { systemClock } from "./clock";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;
const MAX_TIME = 2 ** 48 - 1;

export type RandomFill = (bytes: Uint8Array) => void;

/** The system randomness: `crypto.getRandomValues`. */
export const cryptoFill: RandomFill = (bytes) => {
  crypto.getRandomValues(bytes);
};

function encodeTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_TIME) {
    throw new RangeError(`ULID time out of range: ${ms}`);
  }
  let out = "";
  let rest = ms;
  for (let i = 0; i < TIME_LENGTH; i++) {
    out = ALPHABET.charAt(rest % 32) + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

/** Adds one to a base32 digit array in place; throws when all 80 bits are set. */
function increment(digits: number[]): void {
  for (let i = digits.length - 1; i >= 0; i--) {
    const digit = digits[i] ?? 0;
    if (digit < 31) {
      digits[i] = digit + 1;
      return;
    }
    digits[i] = 0;
  }
  throw new RangeError("ULID random part overflowed within one millisecond");
}

/** Returns a function that makes monotonic ULIDs from the given clock and randomness. */
export function createUlid(clock: Clock, fill: RandomFill = cryptoFill): () => string {
  let lastTime = -1;
  let lastRandom: number[] = [];
  return () => {
    const now = clock.now();
    if (now > lastTime) {
      const bytes = new Uint8Array(RANDOM_LENGTH);
      fill(bytes);
      // 256 is a multiple of 32, so masking each byte keeps every digit uniform.
      lastRandom = Array.from(bytes, (byte) => byte & 31);
      lastTime = now;
    } else {
      // Same millisecond, or the clock stepped back: stay on the last time and count up.
      increment(lastRandom);
    }
    return encodeTime(lastTime) + lastRandom.map((digit) => ALPHABET.charAt(digit)).join("");
  };
}

/** The production `IdSource`: `<prefix>_<ulid>` (0005 section 2). */
export function createSystemIds(clock: Clock = systemClock, fill?: RandomFill): IdSource {
  const ulid = createUlid(clock, fill);
  return { next: (prefix: IdPrefix) => `${prefix}_${ulid()}` };
}

export const systemIds: IdSource = createSystemIds();
