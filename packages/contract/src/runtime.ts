// Runtime seams the engine receives by injection (0004 platform module, 0017 section 4).
// Types only: no values, no I/O. The engine platform module holds the system implementations,
// and `testkit` holds the manual clock and sequential ids, so neither imports the other.

declare const timerHandleBrand: unique symbol;

/** Opaque handle returned by `Clock.setTimeout`; only the clock that made it can clear it. */
export type TimerHandle = { readonly [timerHandleBrand]: true };

/** The only way engine code reads time or waits (0017 section 4). */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /** Calls `callback` once, no earlier than `delayMs` after `now()`. */
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  /** Cancels a pending timer; clearing a fired or cleared timer does nothing. */
  clearTimeout(handle: TimerHandle): void;
}

/** Prefixes of engine-made ids (0005 section 2). */
export type IdPrefix = "off" | "sto" | "run" | "agt" | "gat" | "qst" | "tst";

/** The only way engine code makes ids (0017 section 4). */
export interface IdSource {
  /** A new id for `prefix`; never repeats within one source. */
  next(prefix: IdPrefix): string;
}

/** Signals the engine sends to child processes (0004: SIGINT ends a turn, SIGTERM stops). */
export type Signal = "SIGINT" | "SIGTERM" | "SIGKILL" | "SIGHUP";

export interface SpawnOptions {
  /** Program and arguments; never run through a shell. */
  readonly cmd: readonly [string, ...string[]];
  readonly cwd?: string;
  /** The complete environment of the child; nothing is inherited when set. */
  readonly env?: Readonly<Record<string, string>>;
  /** `pipe` gives the child a writable stdin, `ignore` (the default) gives none. */
  readonly stdin?: "pipe" | "ignore";
  /** Start the child in its own process group so it outlives its parent (0006). */
  readonly detached?: boolean;
  /**
   * Where the child's stdout and stderr go; pipes when absent. With `to: "file"` they go to two
   * regular files (mode 0600) in a fresh private folder under `tempRoot`, so no pipe sits between
   * the child and the caller (DIPO-333). `stdout` and `stderr` then yield the files' content once
   * the child has exited, and the folder is removed after it is read, also on a failure.
   */
  readonly output?: SpawnOutputFile;
}

/** Stdout and stderr through regular files read after the child exits (`SpawnOptions.output`). */
export interface SpawnOutputFile {
  readonly to: "file";
  /** The private temp root the folder is made under; made (mode 0700) when missing. */
  readonly tempRoot: string;
}

export interface ChildStdin {
  write(chunk: string | Uint8Array): void;
  end(): void;
}

export interface ChildExit {
  /** Exit code, or null when the child ended by a signal. */
  readonly code: number | null;
  /** Name of the signal that ended the child, or null. */
  readonly signal: string | null;
}

/** A running child process, real or fake (DIPO-42, DIPO-44). */
export interface ChildProcess {
  readonly pid: number;
  /** Null unless spawned with `stdin: "pipe"`. */
  readonly stdin: ChildStdin | null;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  /** Settles once when the child has exited. */
  readonly exited: Promise<ChildExit>;
  kill(signal?: Signal): void;
}

/** Process creation, injected so tests can replace the subprocess (0017 section 2). */
export type Spawn = (options: SpawnOptions) => ChildProcess;
