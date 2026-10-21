// The box interface (0021 sections 1 and 6, DIPO-265): what dipo needs from one real box per
// story, with no box technology named. A backend (today Apple `container`, `apple-container.ts`)
// implements it; a Linux backend can be added later behind the same interface. Every call but
// `execLive` has a deadline and fails with `box.timedOut` when it passes. A deadline kills only
// the backend's client program, not what it already set going: after `box.timedOut` the caller
// stops or deletes the box (see `create` and `exec`).

import type { ChildExit, ChildStdin, Signal } from "@dipsaus-orchestrator/contract";

/** Every box dipo makes is named `dipo-<run id>`. */
export const BOX_NAME_PREFIX = "dipo-";
/** The label key every box and network dipo makes carries; a box's value is its run id. */
export const BOX_LABEL = "dipo";
/** Where the office package cache (0021 section 5, DIPO-267) appears in a box, read-only. */
export const BOX_PACKAGE_CACHE_PATH = "/dipo/package-cache";
/** The deadline of one box call unless the call names another. */
export const BOX_CALL_TIMEOUT_MS = 60_000;
/**
 * The deadline of one image build (DIPO-266): a build installs the toolchain and Claude Code over
 * the network and takes minutes.
 */
export const BOX_BUILD_TIMEOUT_MS = 30 * 60_000;
/** The repository name of every box image dipo builds; the tag is a hash of its description. */
export const BOX_IMAGE_REPOSITORY = "dipo-box";
/** The build file dipo writes into its own build folder; never a file from the repository. */
export const BOX_BUILD_FILE = "Containerfile";
/** The Safe-Chain CA bundle dipo copies into its build folder for the build's npm installs. */
export const BOX_BUILD_CA_FILE = "safe-chain-ca.pem";

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
   * `BOX_PACKAGE_CACHE_PATH`; the only host folder a box ever sees. It must resolve, with realpath,
   * to a folder under dipo's package cache root, or the box is refused. Absent: nothing is mounted.
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

/**
 * One image build (DIPO-266). `contextDir` is a folder dipo made and filled itself: the build file
 * `BOX_BUILD_FILE` it wrote from the office's box description and the CA bundle `BOX_BUILD_CA_FILE`,
 * nothing from the repository.
 */
export interface BoxImageBuild {
  /** `dipo-box:<hash of the description>`. */
  readonly tag: string;
  readonly contextDir: string;
  /**
   * The address of dipo's proxy the build reaches the network through, `http://<host>:<port>`:
   * registries through Safe-Chain, other hosts on the public internet only.
   */
  readonly proxyUrl: string;
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
  /**
   * Creates a stopped box from `spec` and returns its name, `dipo-<run id>`. On `box.timedOut`
   * only the client was killed: a create already sent may still finish, so the caller deletes
   * the box by its name before it tries again.
   */
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
  /**
   * Writes the box's whole filesystem as a tar archive to the host path `to`. The backend makes
   * it from the host, so nothing in the box can shape what it holds (the post-run token check).
   */
  exportFiles(name: string, to: string, options?: BoxCallOptions): Promise<void>;
  /**
   * Runs a command in a running box to its end, within the deadline. On `box.timedOut` only the
   * client was killed: the command may still run inside the box, so the caller stops or deletes
   * the box.
   */
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
  /** The memory a box uses; null when it is not running. Unreadable figures fail the call. */
  memory(name: string, options?: BoxCallOptions): Promise<BoxMemory | null>;
  /** dipo's own boxes, running or stopped; never another program's. */
  list(options?: BoxCallOptions): Promise<BoxInfo[]>;
  /** True when the image `tag` exists on this machine, so a build can be skipped. */
  hasImage(tag: string, options?: BoxCallOptions): Promise<boolean>;
  /**
   * Builds the image of `build`, within `BOX_BUILD_TIMEOUT_MS` unless the call names another
   * deadline. On `box.timedOut` only the client was killed; the builder may still finish the image.
   */
  buildImage(build: BoxImageBuild, options?: BoxCallOptions): Promise<void>;
}
