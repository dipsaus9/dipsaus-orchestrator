// The maintainer's subscription login for boxes (0021 section 4 and its amendment of 2026-10-21,
// DIPO-269): one token, kept in the macOS Keychain under a dipo entry and read by the model proxy
// alone. Both ways in go through the `security` program, and the token is never one of its
// arguments, since any process on the Mac can read a process list:
//
// - storing runs `security add-generic-password ... -w` with `-w` last and no value, on the
//   maintainer's terminal: `security` prompts for the token itself, so it never passes through
//   dipo's memory, its argv or its pipes;
// - reading runs `security find-generic-password ... -w`, which prints the token on a pipe only
//   dipo reads.
//
// The token is held in a `SecretToken`, which prints as `[box login]` in a string, JSON or log
// line. No error message or detail carries it, and dipo never writes it to disk.

import type { ChildExit, Clock, Spawn, TimerHandle } from "@dipsaus-orchestrator/contract";

import { BoxError } from "./port";

/** The `security` program; an absolute path, so no PATH entry can stand in for it. */
export const SECURITY_CLI = "/usr/bin/security";
/** The Keychain entry: a generic password with this service and account. */
export const TOKEN_KEYCHAIN_SERVICE = "dipo";
export const TOKEN_KEYCHAIN_ACCOUNT = "box-login";
/** The entry's label, as Keychain Access shows it. */
export const TOKEN_KEYCHAIN_LABEL = "dipo box login";
/** How long a Keychain read may take; a locked Keychain can wait on the maintainer. */
export const TOKEN_READ_TIMEOUT_MS = 60_000;
/** `security`'s exit code when the entry does not exist (errSecItemNotFound). */
export const SECURITY_ITEM_NOT_FOUND = 44;
/** Bounds of a token that fits an HTTP header; a subscription token is about 100 characters. */
const TOKEN_MIN_LENGTH = 20;
const TOKEN_MAX_LENGTH = 4096;
/** Visible ASCII only: no space, no control character, nothing a header could split on. */
const TOKEN_SHAPE = /^[\x21-\x7e]+$/;
/** What a token prints as anywhere it is turned into text. */
export const TOKEN_REDACTED = "[box login]";

/** The argv after `security` that reads the token; it prints the token alone on stdout. */
export function findTokenArgs(): string[] {
  return [
    "find-generic-password",
    "-s",
    TOKEN_KEYCHAIN_SERVICE,
    "-a",
    TOKEN_KEYCHAIN_ACCOUNT,
    "-w",
  ];
}

/**
 * The argv after `security` that stores or replaces the token. `-w` is last and has no value, so
 * `security` asks for the token on the terminal; `-U` replaces an existing entry.
 */
export function storeTokenArgs(): string[] {
  return [
    "add-generic-password",
    "-U",
    "-s",
    TOKEN_KEYCHAIN_SERVICE,
    "-a",
    TOKEN_KEYCHAIN_ACCOUNT,
    "-l",
    TOKEN_KEYCHAIN_LABEL,
    "-w",
  ];
}

/** Looks for the token in a stream of chunks, across chunk boundaries, without keeping the stream. */
export interface TokenScanner {
  push(chunk: Uint8Array): void;
  readonly found: boolean;
}

/** What may look for the token without being handed it: the model proxy and the post-run check. */
export interface TokenMatcher {
  /** A new scanner for one stream. */
  scanner(): TokenScanner;
  /** `text` with every occurrence of the token replaced by `TOKEN_REDACTED`. */
  redact(text: string): string;
}

/**
 * The token. Only `reveal()` gives its text, for the one header the model proxy sets; every other
 * way of turning it into text gives `TOKEN_REDACTED`.
 */
export class SecretToken implements TokenMatcher {
  readonly #value: string;
  readonly #bytes: Uint8Array;

  constructor(value: string) {
    this.#value = value;
    this.#bytes = new TextEncoder().encode(value);
  }

  reveal(): string {
    return this.#value;
  }

  scanner(): TokenScanner {
    const needle = this.#bytes;
    let tail: Uint8Array = new Uint8Array(0);
    let found = false;
    return {
      push(chunk) {
        if (found || chunk.byteLength === 0) return;
        const joined = new Uint8Array(tail.byteLength + chunk.byteLength);
        joined.set(tail, 0);
        joined.set(chunk, tail.byteLength);
        if (Buffer.from(joined.buffer, joined.byteOffset, joined.byteLength).indexOf(needle) >= 0) {
          found = true;
          tail = new Uint8Array(0);
          return;
        }
        // Keep only what could begin a match that the next chunk completes.
        tail = joined.slice(Math.max(0, joined.byteLength - (needle.byteLength - 1)));
      },
      get found() {
        return found;
      },
    };
  }

  redact(text: string): string {
    return text.split(this.#value).join(TOKEN_REDACTED);
  }

  toString(): string {
    return TOKEN_REDACTED;
  }

  toJSON(): string {
    return TOKEN_REDACTED;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return TOKEN_REDACTED;
  }
}

/** True when `text` can be a token: one header-safe word of a plausible length. */
export function isTokenShaped(text: string): boolean {
  return (
    text.length >= TOKEN_MIN_LENGTH && text.length <= TOKEN_MAX_LENGTH && TOKEN_SHAPE.test(text)
  );
}

export interface TokenReadDeps {
  readonly spawn: Spawn;
  readonly clock: Clock;
  /** The environment of `security`: PATH and HOME are enough; nothing else is passed. */
  readonly env: Readonly<Record<string, string>>;
  /** The `security` program; `SECURITY_CLI` by default. */
  readonly cli?: string;
  readonly timeoutMs?: number;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
}

function joinText(chunks: readonly Uint8Array[]): string {
  const decoder = new TextDecoder();
  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") + decoder.decode();
}

/**
 * Reads the token from the Keychain. Fails with `token.missing` when no entry exists,
 * `token.invalid` when the entry is not token-shaped, `token.unreadable` when `security` fails and
 * `token.timedOut` at the deadline. No failure carries the token or what `security` printed on
 * stdout.
 */
export async function readBoxToken(deps: TokenReadDeps): Promise<SecretToken> {
  const cli = deps.cli ?? SECURITY_CLI;
  const timeoutMs = deps.timeoutMs ?? TOKEN_READ_TIMEOUT_MS;
  let child;
  try {
    child = deps.spawn({ cmd: [cli, ...findTokenArgs()], env: deps.env, stdin: "ignore" });
  } catch {
    throw new BoxError("token.unreadable", `${cli} could not be started.`, false, { cli });
  }
  let timer: TimerHandle | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = deps.clock.setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new BoxError(
          "token.timedOut",
          `reading the box login from the Keychain took over ${Math.round(timeoutMs / 1000)} s; is the Keychain locked?`,
          false,
          { timeoutMs },
        ),
      );
    }, timeoutMs);
  });
  let stdout: Uint8Array[];
  let stderr: Uint8Array[];
  let exit: ChildExit;
  try {
    [stdout, stderr, exit] = await Promise.race([
      Promise.all([readAll(child.stdout), readAll(child.stderr), child.exited]),
      timedOut,
    ]);
  } finally {
    if (timer !== undefined) deps.clock.clearTimeout(timer);
  }
  const text = joinText(stdout);
  if (exit.code === SECURITY_ITEM_NOT_FOUND) {
    throw new BoxError(
      "token.missing",
      "no box login is stored in the Keychain; set it with `dipo login box`.",
      false,
      { service: TOKEN_KEYCHAIN_SERVICE, account: TOKEN_KEYCHAIN_ACCOUNT },
    );
  }
  if (exit.code !== 0) {
    // What `security` printed on stdout is never shown; stderr is shown without any of it.
    const printed = text.trim();
    const raw = joinText(stderr);
    const said = (printed === "" ? raw : raw.split(printed).join(TOKEN_REDACTED))
      .trim()
      .split("\n")[0];
    throw new BoxError(
      "token.unreadable",
      `security could not read the box login: ${said || `exit ${exit.code ?? exit.signal}`}`,
      false,
      { code: exit.code, signal: exit.signal },
    );
  }
  const value = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (!isTokenShaped(value)) {
    throw new BoxError(
      "token.invalid",
      "the box login in the Keychain is not a token (one line of visible characters, 20 or more); set it again with `dipo login box`.",
      false,
      { length: value.length },
    );
  }
  return new SecretToken(value);
}

/**
 * Runs a program on the maintainer's terminal: stdin, stdout and stderr are the terminal's, so the
 * program reads what the maintainer types without dipo seeing it. Resolves when it exits.
 */
export type SpawnInteractive = (options: {
  readonly cmd: readonly [string, ...string[]];
  readonly env: Readonly<Record<string, string>>;
}) => Promise<ChildExit>;

export interface TokenStoreDeps {
  readonly spawnInteractive: SpawnInteractive;
  /** The environment of `security`: PATH and HOME are enough; nothing else is passed. */
  readonly env: Readonly<Record<string, string>>;
  readonly cli?: string;
}

export type TokenStoreResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "token.storeFailed"; readonly reason: string };

/**
 * Stores or replaces the token: `security` asks for it on the terminal. dipo passes no token and
 * reads none; it learns only whether `security` succeeded.
 */
export async function storeBoxToken(deps: TokenStoreDeps): Promise<TokenStoreResult> {
  const cli = deps.cli ?? SECURITY_CLI;
  let exit: ChildExit;
  try {
    exit = await deps.spawnInteractive({ cmd: [cli, ...storeTokenArgs()], env: deps.env });
  } catch {
    return { ok: false, code: "token.storeFailed", reason: `${cli} could not be started.` };
  }
  if (exit.code === 0) return { ok: true };
  return {
    ok: false,
    code: "token.storeFailed",
    reason:
      exit.code === null
        ? `security ended by ${exit.signal ?? "a signal"}; nothing was stored.`
        : `security exited ${exit.code}; nothing was stored.`,
  };
}
