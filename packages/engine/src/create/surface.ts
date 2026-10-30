// The engine's surface to a socket server (0005, DIPO-318): commands and reads after the lifecycle
// checks of 0006 decision 7, and the streams a subscriber follows: the software stream's replay and
// live events, and an office's change log, rendered page by page. The frame protocol, the
// connections and their backpressure stay with the server; the engine keeps no per-connection
// state.

import {
  type Clock,
  type CommandReply,
  type CommandRequest,
  type Cursor,
  engineError,
  type EngineError,
  type Event,
  type IdSource,
  OfficeId,
  type OfficeSummary,
  type ReadReply,
  type ReadRequest,
  SOFTWARE_STREAM,
  type StreamName,
} from "@dipsaus-orchestrator/contract";

import { headCursor } from "../changelog/log";
import { Renderer } from "../changelog/render";
import { replay } from "../changelog/replay";
import { executeCommand, type Connection } from "../commands/execute";
import type { OfficeDirectory } from "../commands/offices";
import type { Registry } from "../commands/registry";
import type { MemoryRequestTable } from "../commands/requests";
import type { Logger } from "../log/logger";
import { executeRead } from "../reads/execute";
import type { OfficeSummarySource } from "../reads/hello";
import type { SoftwareStream } from "../software-stream";
import type { DaemonLifecycle } from "./lifecycle";
import type { OfficeChanges } from "./notify";

/** Names any connection may use in every daemon state (0005: also `starting`). */
const ALWAYS_ALLOWED: ReadonlySet<string> = new Set(["engine.hello", "commands.describe"]);

/**
 * The lifecycle check for one request (0005), null when it may run: office commands and reads get
 * `engine.recovering` in `starting` and `recovering`; in `draining` no command but `daemon.*`
 * starts, with the retryable `scheduling.off`, so a client retries it against the next daemon. `engine.hello`,
 * `commands.describe` and `daemon.*` always run.
 */
export function lifecycleGate(
  lifecycle: DaemonLifecycle,
  kind: "command" | "read",
  name: string,
): EngineError | null {
  if (ALWAYS_ALLOWED.has(name) || name.startsWith("daemon.")) return null;
  const access = lifecycle.officeAccess();
  if (access !== null) return access;
  if (kind === "command" && lifecycle.state === "draining") return lifecycle.scheduling();
  return null;
}

/** A subscription the engine opened: the software stream's replay, or an office's start. */
export type Subscribed =
  | { readonly ok: false; readonly error: EngineError }
  | {
      readonly ok: true;
      readonly from: Cursor;
      readonly office: null;
      /** The software events after `from`, up to `head`. */
      readonly events: readonly Event[];
      readonly head: Cursor;
    }
  | { readonly ok: true; readonly from: Cursor; readonly office: OfficeId };

/** One page of an office's change log after a position, rendered for its subscribers. */
export type OfficePage =
  /** The office is not loaded any more: its subscriptions end. */
  | { readonly kind: "gone" }
  | {
      readonly kind: "page";
      readonly events: readonly Event[];
      /** True when the page reached the head of the log. */
      readonly last: boolean;
    };

/** What a socket server uses of the engine. */
export interface EngineSurface {
  readonly version: string;
  /**
   * Runs one command after the lifecycle checks. Its reply goes to `send` first; only then do its
   * office's subscribers hear the new entries, so a connection that closes on a failed delivery
   * still got the reply of a command that committed.
   */
  executeCommand(
    request: CommandRequest,
    connection?: Connection,
    send?: (reply: CommandReply) => void,
  ): Promise<CommandReply>;
  /** Runs one read after the lifecycle checks. */
  executeRead(request: ReadRequest): Promise<ReadReply>;
  /** Opens a stream at `after`, or at its head; an office stream loads its office (DIPO-27). */
  subscribe(stream: StreamName, after: Cursor | undefined): Promise<Subscribed>;
  /** At most `limit` entries of an office's change log after `position`, rendered (DIPO-124). */
  officePage(office: OfficeId, position: Cursor, limit: number): OfficePage;
  /** Every live software event, as it is appended; returns the call that stops it. */
  onSoftwareEvent(listener: (event: Event) => void): () => void;
  /** Each office whose change log has new entries; returns the call that stops it. */
  onOfficeChanged(listener: (office: OfficeId) => void): () => void;
  /** The summary of every office (0005 section 5). */
  officeSummaries(): readonly OfficeSummary[];
  /** The summary of one office, or undefined when it has none. */
  officeSummary(office: OfficeId): OfficeSummary | undefined;
}

/** The parts the surface is made of; `createEngine` builds them, and tests pass their own. */
export interface SurfaceParts {
  readonly version: string;
  readonly registry: Registry;
  readonly offices: OfficeDirectory;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly softwareRequests: MemoryRequestTable;
  readonly lifecycle: DaemonLifecycle;
  readonly software: SoftwareStream;
  readonly changes: OfficeChanges;
  readonly officeSummaries: OfficeSummarySource;
  readonly officeSummary?: (office: OfficeId) => OfficeSummary | undefined;
  readonly logger: Logger;
  readonly renderer?: Renderer;
}

async function commandReply(
  parts: SurfaceParts,
  request: CommandRequest,
  connection: Connection,
): Promise<CommandReply> {
  try {
    return await executeCommand(parts, request, connection);
  } catch (error) {
    parts.logger.error("command failed", { command: request.name, error });
    return {
      ok: false,
      requestId: request.requestId,
      error: engineError("internal", "The engine failed while handling this command."),
    };
  }
}

async function runCommand(
  parts: SurfaceParts,
  request: CommandRequest,
  connection: Connection,
  send: (reply: CommandReply) => void,
): Promise<CommandReply> {
  const gate = lifecycleGate(parts.lifecycle, "command", request.name);
  if (gate !== null) {
    const refused: CommandReply = { ok: false, requestId: request.requestId, error: gate };
    send(refused);
    return refused;
  }
  const end = parts.lifecycle.beginWork();
  try {
    const reply = await commandReply(parts, request, connection);
    // The reply first, then the office's subscribers (0005 section 3).
    send(reply);
    if (reply.ok && reply.cursor !== undefined && request.office !== undefined) {
      parts.changes.notify(request.office);
    }
    return reply;
  } finally {
    end?.();
  }
}

function subscribeSoftware(parts: SurfaceParts, after: Cursor | undefined): Subscribed {
  const from = after ?? parts.software.head();
  const replayed = parts.software.since(from);
  if (!replayed.ok) return { ok: false, error: replayed.error };
  return { ok: true, from, office: null, events: replayed.events, head: replayed.head };
}

async function subscribeOffice(
  parts: SurfaceParts,
  stream: StreamName,
  after: Cursor | undefined,
): Promise<Subscribed> {
  const gate = parts.lifecycle.officeAccess();
  if (gate !== null) return { ok: false, error: gate };
  const office = OfficeId.parse(stream.slice("office:".length));
  // Subscribing loads the office's engine instance on first use (DIPO-27).
  const access = await parts.offices.load(office);
  if (!access.ok) return { ok: false, error: access.error };
  const handle = access.office;
  try {
    const from = after ?? headCursor(handle);
    // Checks the cursor; the entries are read page by page later.
    const checked = replay(handle, from, { limit: 1 });
    if (!checked.ok) return { ok: false, error: checked.error };
    return { ok: true, from, office };
  } catch (error) {
    parts.logger.error("office replay failed", { office, error });
    return {
      ok: false,
      error: engineError("internal", "The engine could not replay this office stream."),
    };
  }
}

/**
 * One rendered page. A cursor that can no longer be replayed (a restored office) throws; the
 * server closes the connection and the client subscribes again. A stored entry that does not
 * render is logged and sent as an `engine.notice` at its own cursor (DIPO-124).
 */
function pageOf(
  parts: SurfaceParts,
  renderer: Renderer,
  office: OfficeId,
  position: Cursor,
  limit: number,
): OfficePage {
  const handle = parts.offices.get(office);
  if (handle === undefined) return { kind: "gone" };
  const replayed = replay(handle, position, { limit });
  if (!replayed.ok) throw new Error(replayed.error.message);
  const events = renderer.renderForStream(office, replayed.entries, (error, entry) =>
    parts.logger.error("office change-log entry does not render", {
      office,
      seq: entry.seq,
      type: entry.type,
      error,
    }),
  );
  return { kind: "page", events, last: replayed.entries.length < limit };
}

/** The engine's surface over its parts. */
export function engineSurface(parts: SurfaceParts): EngineSurface {
  const renderer = parts.renderer ?? new Renderer();
  return {
    version: parts.version,
    executeCommand: (request, connection = {}, send = () => {}) =>
      runCommand(parts, request, connection, send),
    executeRead: async (request) => {
      const gate = lifecycleGate(parts.lifecycle, "read", request.name);
      if (gate !== null) return { ok: false, requestId: request.requestId, error: gate };
      return executeRead(parts, request);
    },
    subscribe: async (stream, after) =>
      stream === SOFTWARE_STREAM
        ? subscribeSoftware(parts, after)
        : subscribeOffice(parts, stream, after),
    officePage: (office, position, limit) => pageOf(parts, renderer, office, position, limit),
    onSoftwareEvent: (listener) => parts.software.onAppend(listener),
    onOfficeChanged: (listener) => parts.changes.listen(listener),
    officeSummaries: () => parts.officeSummaries(),
    officeSummary: (office) =>
      parts.officeSummary === undefined
        ? parts.officeSummaries().find((candidate) => candidate.office === office)
        : parts.officeSummary(office),
  };
}
