// The worker host's files and its steering protocol (0006 decision 8, 0007 section 2). The
// protocol is tiny, versioned and separate from the client contract: one JSON object per line on
// `<runtime>/hosts/<run-id>.sock`. A client opens with `hello`, naming the protocol versions it
// speaks and the run it expects; the host answers with the version it picked, or refuses and
// closes. After that it accepts only the ops `write`, `signal`, `closeStdin`, `status` and `watch`.
// Version 2 added the hook relay's two ops, which went with every hook (0008): it now has the ops
// of version 1. A later version adds ops without breaking older clients: the handshake lets a
// newer binary talk to an older host and the reverse, and an op is accepted only on a connection
// whose picked version has it.

import { join } from "node:path";

import { z } from "zod";

import type { LaunchPlan } from "../workers/types";

/** The host protocol version this binary speaks; recorded in `worker_hosts`. */
export const HOST_PROTOCOL_VERSION = 2;
/** Every host protocol version this binary can serve or speak, oldest first. */
export const HOST_PROTOCOL_VERSIONS: readonly number[] = [1, 2];
/** Files in `<git-common-dir>/dipo/runs/<run-id>/` (0007 section 2). */
export const EVENTS_FILE = "events.ndjson";
export const EXIT_FILE = "exit.json";
export const HOST_LOG_FILE = "host.log";
/** What the engine hands the host; the host reads it once and removes it (it holds the prompt). */
export const LAUNCH_FILE = "launch.json";
/** Host logs are capped at 5 MB by dropping the oldest half (0006 decision 13). */
export const HOST_LOG_CAP_BYTES = 5 * 1024 * 1024;

/** The directory below the runtime directory that holds the host sockets (0006 decision 3). */
export const HOSTS_DIR = "hosts";

/** `<runtime>/hosts/<run-id>.sock`. */
export function hostSocketPath(runtimeDir: string, runId: string): string {
  return join(runtimeDir, HOSTS_DIR, `${runId}.sock`);
}

/** Run ids as the engine makes them (`run_<ulid>`); the host refuses anything else. */
export const RUN_ID_PATTERN = /^run_[0-9A-HJKMNP-TV-Z]{26}$/;

export const HostSignalSchema = z.enum(["SIGINT", "SIGTERM", "SIGKILL"]);

/**
 * The name a host renames `launch.json` to before it reads it (DIPO-93). The rename is the claim:
 * the engine's recovery revokes a launch no host claimed with a rename of its own, so exactly one
 * of them wins. The host removes the claimed file once its PID marker is written.
 */
export function claimedLaunchName(pid: number): string {
  return `${LAUNCH_FILE}.claimed.${pid}`;
}

/** The engine's name for a launch it revoked after a restart; removed at once (DIPO-93). */
export const REVOKED_LAUNCH_FILE = `${LAUNCH_FILE}.revoked`;

/** The prefix of host PID markers in the run directory. */
export const HOST_MARKER_PREFIX = "host-pid.";

/**
 * The PID marker of the host for `agent` (DIPO-93): `{ run, agent, pid }`, written by the host
 * after its claim and before it removes the claimed launch, so a restart finds a host whose
 * `worker_hosts` row was still pending when the daemon stopped.
 */
export function hostMarkerName(agent: string): string {
  return `${HOST_MARKER_PREFIX}${agent}.json`;
}

/** A host PID marker. */
export const HostMarkerSchema = z.object({
  run: z.string().regex(RUN_ID_PATTERN),
  agent: z.string().min(1),
  pid: z.number().int().positive(),
});

export type HostMarker = z.infer<typeof HostMarkerSchema>;

/** Files the engine and the host write in the run directory; a plan's files may not use them. */
export const RESERVED_RUN_FILES: ReadonlySet<string> = new Set([
  LAUNCH_FILE,
  `${LAUNCH_FILE}.tmp`,
  REVOKED_LAUNCH_FILE,
  EVENTS_FILE,
  EXIT_FILE,
  `${EXIT_FILE}.tmp`,
  HOST_LOG_FILE,
]);

/** True when a plan file would take a name the host or the engine writes (DIPO-93 adds two). */
export function isReservedRunFile(name: string): boolean {
  return (
    RESERVED_RUN_FILES.has(name) ||
    name.startsWith(`${LAUNCH_FILE}.claimed.`) ||
    name.startsWith(HOST_MARKER_PREFIX)
  );
}

const LaunchFileSchema = z.object({
  name: z
    .string()
    .min(1)
    // A plain file name, or one plain directory and a plain file name (`safe-chain/zsh`, DIPO-82).
    .refine(
      (name) => {
        const parts = name.split("/");
        return parts.length <= 2 && parts.every((p) => p !== "" && p !== "." && p !== "..");
      },
      { message: "a launch file name is a plain file name, at most one directory deep" },
    )
    .refine((name) => !isReservedRunFile(name), {
      message: "a launch file may not replace a file the host writes",
    }),
  content: z.string(),
  executable: z.boolean().optional(),
});

const LineScrubSchema = z.object({
  blockTypes: z.array(z.string()),
  fields: z.array(z.string()),
});

const LaunchPlanSchema = z.object({
  argv: z.tuple([z.string().startsWith("/")], z.string()),
  env: z.record(z.string(), z.string()),
  cwd: z.string().startsWith("/"),
  files: z.array(LaunchFileSchema),
  stdin: z.array(z.string()),
  lineScrub: LineScrubSchema.optional(),
  stopCommand: z.tuple([z.string().startsWith("/")], z.string()).optional(),
});

/** `launch.json`: everything the host needs besides its run id. */
export const HostLaunchSchema = z.object({
  version: z.literal(1),
  run: z.string().regex(RUN_ID_PATTERN),
  agent: z.string().min(1),
  socket: z.string().startsWith("/"),
  plan: LaunchPlanSchema,
  /** The engine's secret of an earlier binary (DIPO-59); the host no longer reads it. */
  token: z.string().min(32).optional(),
});

export interface HostLaunch {
  readonly version: 1;
  readonly run: string;
  readonly agent: string;
  readonly socket: string;
  readonly plan: LaunchPlan;
  /** The engine's secret of an earlier binary (DIPO-59); the host no longer reads it. */
  readonly token?: string;
}

/** `exit.json`, written once when the worker has ended (0006 decision 8). */
export interface HostExitFile {
  readonly run: string;
  /** Exit code, or null when the worker ended by a signal or never started. */
  readonly code: number | null;
  /** The signal that ended the worker, read from the process or inferred (`signalInferred`). */
  readonly signal: string | null;
  /**
   * True when the process reported no signal but the host had sent one and the worker then
   * exited non-zero (DIPO-88): `signal` is the one the host sent last. A worker that handles
   * SIGTERM and exits 143, as Claude Code does, ends this way. Absent otherwise.
   */
  readonly signalInferred?: boolean;
  /** Size of `events.ndjson` after the last line the host wrote. */
  readonly finalOffset: number;
  /** Milliseconds since the Unix epoch. */
  readonly at: number;
  /** Set when the worker could not be started; code and signal are then null. */
  readonly startError?: string;
}

export const HostExitFileSchema = z.object({
  run: z.string(),
  code: z.number().int().nullable(),
  signal: z.string().nullable(),
  signalInferred: z.boolean().optional(),
  finalOffset: z.number().int().nonnegative(),
  at: z.number().int(),
  startError: z.string().optional(),
});

// Client to host.

export const HelloFrame = z.object({
  kind: z.literal("hello"),
  /** Versions the client speaks; the host picks the highest it also speaks. */
  versions: z.array(z.number().int().positive()).min(1),
  run: z.string(),
  /** The engine's secret from `launch.json` (DIPO-59); the host no longer reads it. */
  token: z.string().optional(),
});
export type HelloFrame = z.infer<typeof HelloFrame>;

const RequestId = z.number().int().nonnegative();

/** The only ops a host accepts (DIPO-44). */
export const HOST_OPS = ["write", "signal", "closeStdin", "status", "watch"] as const;
export type HostOpName = (typeof HOST_OPS)[number];

/** The protocol version that introduced each op. */
export const OP_SINCE: Readonly<Record<HostOpName, number>> = {
  write: 1,
  signal: 1,
  closeStdin: 1,
  status: 1,
  watch: 1,
};

export const OpFrame = z.discriminatedUnion("op", [
  z.object({ kind: z.literal("op"), id: RequestId, op: z.literal("write"), data: z.string() }),
  z.object({
    kind: z.literal("op"),
    id: RequestId,
    op: z.literal("signal"),
    signal: HostSignalSchema,
    afterMs: z.number().int().nonnegative().optional(),
  }),
  z.object({ kind: z.literal("op"), id: RequestId, op: z.literal("closeStdin") }),
  z.object({ kind: z.literal("op"), id: RequestId, op: z.literal("status") }),
  z.object({ kind: z.literal("op"), id: RequestId, op: z.literal("watch") }),
]);
export type OpFrame = z.infer<typeof OpFrame>;

// Host to client.

export type HostState = "running" | "exiting" | "exited";

export interface HostStatus {
  readonly run: string;
  readonly protocol: number;
  readonly hostPid: number;
  readonly workerPid: number | null;
  readonly state: HostState;
  readonly stdinOpen: boolean;
  /** Size of `events.ndjson` after the last append. */
  readonly offset: number;
  readonly exit: HostExitFile | null;
}

export type HostErrorCode =
  | "protocol.unsupported"
  | "run.mismatch"
  | "frame.invalid"
  | "op.unknown"
  | "not.permitted"
  | "worker.exited"
  | "stdin.closed"
  | "stdin.failed";

export interface HostError {
  readonly code: HostErrorCode;
  readonly message: string;
}

export type HostFrame =
  | { readonly kind: "hello"; readonly version: number; readonly run: string; readonly pid: number }
  | {
      readonly kind: "refused";
      readonly error: HostError;
      readonly versions: readonly number[];
    }
  | { readonly kind: "reply"; readonly id: number; readonly ok: true; readonly result?: unknown }
  | { readonly kind: "reply"; readonly id: number; readonly ok: false; readonly error: HostError }
  | { readonly kind: "advanced"; readonly offset: number };

export const HostFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("hello"),
    version: z.number().int(),
    run: z.string(),
    pid: z.number().int(),
  }),
  z.object({
    kind: z.literal("refused"),
    error: z.object({ code: z.string(), message: z.string() }),
    versions: z.array(z.number().int()),
  }),
  z.object({
    kind: z.literal("reply"),
    id: z.number().int(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  }),
  z.object({ kind: z.literal("advanced"), offset: z.number().int().nonnegative() }),
]);

/** The highest version both sides speak, or null. */
export function pickVersion(
  offered: readonly number[],
  own: readonly number[] = HOST_PROTOCOL_VERSIONS,
): number | null {
  const common = offered.filter((version) => own.includes(version));
  return common.length === 0 ? null : Math.max(...common);
}
