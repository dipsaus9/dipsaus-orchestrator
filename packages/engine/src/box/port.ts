// The box interface (0021 sections 1 and 6, DIPO-265): what dipo needs from one real box per
// story, with no box technology named. A backend (today Apple `container`, `apple-container.ts`)
// implements it; a Linux backend can be added later behind the same interface. Every call but
// `execLive` has a deadline and fails with `box.timedOut` when it passes.

import type { ChildExit, ChildStdin, Signal } from "@dipsaus-orchestrator/contract";

/** Every box dipo makes is named `dipo-<run id>`. */
export const BOX_NAME_PREFIX = "dipo-";
/** The label key every box and network dipo makes carries; a box's value is its run id. */
export const BOX_LABEL = "dipo";
/** Where the office package cache (0021 section 5, DIPO-267) appears in a box, read-only. */
export const BOX_PACKAGE_CACHE_PATH = "/dipo/package-cache";
/** The deadline of one box call unless the call names another. */
export const BOX_CALL_TIMEOUT_MS = 60_000;

/** A run id a box name may carry: what `IdSource` makes (`run_<ulid>`), and test ids. */
const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
/** The longest box name; Apple `container` allows a DNS label (63). */
const MAX_BOX_NAME = 63;

/** A box failure; `code` is dotted like the contract's error codes, `box.timedOut` among them. */
export class BoxError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "BoxError";
  }
}

/** True when `error` is a box call killed at its deadline. */
export function isBoxTimedOut(error: unknown): error is BoxError {
  return error instanceof BoxError && error.code === "box.timedOut";
}

/** The box name of `runId`; refuses a run id the name cannot carry. */
export function boxName(runId: string): string {
  const name = `${BOX_NAME_PREFIX}${runId}`;
  if (!RUN_ID.test(runId) || name.length > MAX_BOX_NAME) {
    throw new BoxError("box.refused", `run id ${JSON.stringify(runId)} cannot name a box.`, false, {
      runId,
    });
  }
  return name;
}

/** The run id of a dipo box name, or null when the name is not one of dipo's. */
export function runIdOfBox(name: string): string | null {
  if (!name.startsWith(BOX_NAME_PREFIX)) return null;
  const runId = name.slice(BOX_NAME_PREFIX.length);
  return RUN_ID.test(runId) ? runId : null;
}

/** What the start check found: the backend's version, or why boxes cannot run. */
export type BoxCheck =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly reason: string; readonly version: string | null };

/**
 * The only network mode a box may join (0021 section 3 and its amendment): host-only, no route
 * out. dipo's web proxy on the network's host address is the box's one way out.
 */
export type BoxNetworkMode = "hostOnly";

/** The network boxes join, as `network()` prepared it. */
export interface BoxNetwork {
  readonly name: string;
  readonly mode: BoxNetworkMode;
  /** The Mac's address on the network, where dipo's proxies listen for the boxes. */
  readonly hostAddress: string;
}

/** What one box is made from. Nothing of the maintainer's is attached (0021 section 2). */
export interface BoxSpec {
  readonly runId: string;
  /** The office's box image (0021 section 5, DIPO-266). */
  readonly image: string;
  readonly network: BoxNetwork;
  /**
   * The host folder of the office package cache (DIPO-267), mounted read-only at
   * `BOX_PACKAGE_CACHE_PATH`; the only host folder a box ever sees. Absent: nothing is mounted.
   */
  readonly packageCache?: string;
}

export type BoxState = "running" | "stopped" | "unknown";

/** One of dipo's boxes, as `list()` sees it. */
export interface BoxInfo {
  readonly name: string;
  readonly runId: string;
  readonly state: BoxState;
}

/** Options of a command run in a box. */
export interface BoxExecOptions {
  /** Absolute working directory inside the box. */
  readonly cwd?: string;
  /** The command's environment additions, set inside the box; nothing comes from the host. */
  readonly env?: Readonly<Record<string, string>>;
  /** Overrides the call's deadline (`exec` only). */
  readonly timeoutMs?: number;
}

/** A finished command in a box. A non-zero exit is a result, not an error. */
export interface BoxExecResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** A long-running command in a box, with its stdin and stdout; it has no deadline. */
export interface BoxProcess {
  readonly stdin: ChildStdin;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<ChildExit>;
  kill(signal?: Signal): void;
}

/** The memory a running box uses. */
export interface BoxMemory {
  readonly usedBytes: number;
  /** The box's memory limit; null when the backend does not say. */
  readonly limitBytes: number | null;
}

/** Per-call deadline override for the lifecycle calls. */
export interface BoxCallOptions {
  readonly timeoutMs?: number;
}

export interface BoxPort {
  /** The backend id, for example `apple-container`. */
  readonly id: string;
  /** The start check: refuses with a reason when boxes cannot run on this machine. */
  check(options?: BoxCallOptions): Promise<BoxCheck>;
  /** Prepares the host-only box network, or reuses it; refuses one that is not host-only. */
  network(options?: BoxCallOptions): Promise<BoxNetwork>;
  /** Creates a stopped box from `spec` and returns its name, `dipo-<run id>`. */
  create(spec: BoxSpec, options?: BoxCallOptions): Promise<string>;
  start(name: string, options?: BoxCallOptions): Promise<void>;
  /** Stops a box; its files are kept for the next `start`. */
  stop(name: string, options?: BoxCallOptions): Promise<void>;
  /** Deletes a box and its files, also while it runs. */
  delete(name: string, options?: BoxCallOptions): Promise<void>;
  /** Copies the host path `from` to `to` inside the box. */
  copyIn(name: string, from: string, to: string, options?: BoxCallOptions): Promise<void>;
  /** Copies `from` inside the box to the host path `to`. */
  copyOut(name: string, from: string, to: string, options?: BoxCallOptions): Promise<void>;
  /** Runs a command in a running box to its end, within the deadline. */
  exec(
    name: string,
    command: readonly [string, ...string[]],
    options?: BoxExecOptions,
  ): Promise<BoxExecResult>;
  /** Starts a long-running command in a running box with stdin and stdout; no deadline. */
  execLive(
    name: string,
    command: readonly [string, ...string[]],
    options?: Omit<BoxExecOptions, "timeoutMs">,
  ): BoxProcess;
  /** The memory a box uses; null when it is not running. */
  memory(name: string, options?: BoxCallOptions): Promise<BoxMemory | null>;
  /** dipo's own boxes, running or stopped; never another program's. */
  list(options?: BoxCallOptions): Promise<BoxInfo[]>;
}
