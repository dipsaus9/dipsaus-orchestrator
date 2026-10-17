// The worker host, `dipo daemon worker-host <run-id>` (0006 decision 8, 0008 section 1). It reads
// `launch.json` from its run directory, writes the plan's files, binds
// `<runtime>/hosts/<run-id>.sock`, starts the worker through the injected `Spawn`, writes the
// first stdin lines and appends every stdout and stderr line, hook payload and the exit to
// `events.ndjson`. When the worker exits it cancels delayed signals, kills the worker's process
// group so no child of the worker outlives the run, writes `exit.json` and returns.
//
// It claims `launch.json` by a rename and writes its PID marker before it starts the worker, and
// SIGTERM to the host stops its worker (stdin closed, SIGTERM, SIGKILL 20 s later) instead of
// ending the host at once (DIPO-93): the engine stops a follow-only host this way.
//
// Hook relay (0008 section 5, DIPO-59): `dipo hook <event>` sends the payload with the `hook` op;
// the host appends it as a `hook` line. A call with `waitMs` is held under its line's end offset
// until the engine answers it with `hookReply`, `waitMs` passes, the worker exits, or no engine
// watches the host any more; while no engine watches (the daemon is down) it is answered at once
// with no output. The host never decides anything about a hook: no output means no decision.
//
// It holds no engine logic: no budgets, gates, git or database (a lint rule keeps those imports
// out of `host/`). Time comes from the injected clock and the process from the injected spawn, so
// tests run it in-process with a fake process; only the detach test needs a real one.

import { timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type {
  ChildProcess,
  Clock,
  LogLevel,
  Signal,
  Spawn,
  TimerHandle,
} from "@dipsaus-orchestrator/contract";

import { createLogger, type Logger, type LogSink } from "../log/logger";
import { listenLineSocket, type LineConnection, type LineServer } from "../platform/line-socket";
import { ensurePrivateDir } from "../platform/paths";
import { removeSocketFile } from "../platform/socket";
import { EventLog, LineSplitter, type EventChannel } from "./events";
import { openHostLog, type HostLog } from "./host-log";
import { LineScrubber, MAX_SCRUB_LINE } from "./scrub";
import {
  claimedLaunchName,
  EVENTS_FILE,
  EXIT_FILE,
  HelloFrame,
  HOST_LOG_CAP_BYTES,
  HOST_LOG_FILE,
  HOST_OPS,
  HOST_PROTOCOL_VERSIONS,
  HostLaunchSchema,
  hostMarkerName,
  LAUNCH_FILE,
  OP_SINCE,
  OpFrame,
  pickVersion,
  type HostError,
  type HostExitFile,
  type HostFrame,
  type HostLaunch,
  type HostMarker,
  type HostState,
  type HostStatus,
} from "./protocol";
import type { LineScrub } from "../workers/types";
import { hostOpOf, Steering } from "./steering";

/** How long the host waits for the worker's output to end after it killed the group. */
export const OUTPUT_GRACE_MS = 5000;

/**
 * When the host itself gets SIGTERM (DIPO-93), the SIGKILL to its worker follows the SIGTERM it
 * sends after this long, unless the worker exited first: the gap between the two signals of the
 * 0008 stop sequence (SIGTERM at 10 s, SIGKILL at 30 s).
 */
export const TERM_KILL_AFTER_MS = 20_000;

export interface WorkerHostOptions {
  readonly runId: string;
  /** `<git-common-dir>/dipo/runs/<run-id>`, holding `launch.json`. */
  readonly runDir: string;
  readonly clock: Clock;
  readonly spawn: Spawn;
  /** Signals a process group only (`signalGroup`); tests record the call instead. */
  readonly killGroup: (pgid: number, signal: Signal) => void;
  /** This host's PID, reported in the handshake and status. */
  readonly pid: number;
  readonly logLevel?: LogLevel;
  /** More sinks for the host's log lines next to `host.log`. */
  readonly logSinks?: readonly LogSink[];
  /** Replaces the 5 MB `host.log` cap; tests use a small one. */
  readonly logCapBytes?: number;
  /**
   * Subscribes `stop` to the host process's SIGTERM and returns the unsubscribe (DIPO-93): the
   * daemon's `worker-host` form passes `process.on("SIGTERM")`. Without it SIGTERM is not handled.
   */
  readonly onTerminate?: (stop: () => void) => () => void;
}

/** The worker's exit as the host records it (`exit.json` and the exit line). */
export interface ExitCause {
  readonly code: number | null;
  readonly signal: string | null;
  readonly signalInferred?: boolean;
}

/**
 * The exit to record from the process's report and the signal the host sent last (DIPO-88). A
 * process that handles the signal and exits with a code reports no signal: Claude Code catches
 * SIGTERM in print mode and exits 143. When the host had sent a signal and the worker then exited
 * non-zero, that signal is recorded as the cause and marked inferred. A signal the process
 * reports always wins; an exit 0 stays a clean exit, and with no signal sent nothing is inferred.
 */
export function exitCause(
  exit: { readonly code: number | null; readonly signal: string | null },
  lastSignal: Signal | null,
): ExitCause {
  if (exit.signal !== null || lastSignal === null) return { code: exit.code, signal: exit.signal };
  if (exit.code === null || exit.code === 0) return { code: exit.code, signal: null };
  return { code: exit.code, signal: lastSignal, signalInferred: true };
}

/**
 * Claims, reads, validates and removes `launch.json`; it holds the task message, so it never
 * stays. The claim is a rename to `launch.json.claimed.<pid>` (DIPO-93): a launch the engine's
 * recovery revoked first is gone, and this host starts nothing. Before the claimed file is
 * removed the host writes its PID marker (`host-pid.<agent>.json`), so from the claim on one of
 * the two files always names this host.
 */
export function readLaunch(runDir: string, runId: string, pid: number): HostLaunch {
  const claimed = join(runDir, claimedLaunchName(pid));
  renameSync(join(runDir, LAUNCH_FILE), claimed);
  try {
    const launch = HostLaunchSchema.parse(JSON.parse(readFileSync(claimed, "utf8"))) as HostLaunch;
    if (launch.run !== runId) {
      throw new Error(`${LAUNCH_FILE} is for ${launch.run}, not ${runId}`);
    }
    writeMarker(runDir, { run: runId, agent: launch.agent, pid });
    return launch;
  } finally {
    rmSync(claimed, { force: true });
  }
}

function writeMarker(runDir: string, marker: HostMarker): void {
  const path = join(runDir, hostMarkerName(marker.agent));
  writeFileSync(`${path}.tmp`, JSON.stringify(marker), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

function writeExitFile(runDir: string, exit: HostExitFile): void {
  const path = join(runDir, EXIT_FILE);
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(exit)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

interface Client {
  readonly connection: LineConnection;
  version: number | null;
  watching: boolean;
  /** It presented the engine's token in its hello (DIPO-59). */
  engine: boolean;
}

/** A hook call waiting for the engine's reply, held under its line's end offset. */
interface PendingHook {
  readonly client: Client;
  /** The `hook` op's request id, which the reply answers. */
  readonly id: number;
  readonly timer: TimerHandle;
}

/** Compares a presented token with the launch's in constant time. */
function tokenMatches(presented: string | undefined, token: string): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

/** A hook payload as one compact JSON line when it parses, else the text as given. */
function hookLineData(payload: string): string {
  try {
    return JSON.stringify(JSON.parse(payload));
  } catch {
    return payload.trim();
  }
}

export class WorkerHost {
  readonly runId: string;
  readonly runDir: string;
  readonly socketPath: string;
  /** Settles with the exit record once `exit.json` is written and the socket is closed. */
  readonly done: Promise<HostExitFile>;

  readonly #options: WorkerHostOptions;
  readonly #logger: Logger;
  readonly #hostLog: HostLog;
  readonly #events: EventLog;
  readonly #startedAt: number;
  readonly #clients = new Set<Client>();
  readonly #pendingHooks = new Map<number, PendingHook>();
  /**
   * The engine's secret from `launch.json` (DIPO-59), null for a launch without one. Only a
   * connection that presented it answers hook calls and counts as the engine watching.
   */
  readonly #token: string | null;
  #server: LineServer | null = null;
  #child: ChildProcess | null = null;
  #steering: Steering | null = null;
  #state: HostState = "running";
  #exit: HostExitFile | null = null;
  /** Set once SIGTERM to the host started stopping the worker (DIPO-93). */
  #terminating = false;
  #offTerminate: (() => void) | null = null;
  #resolveDone!: (exit: HostExitFile) => void;
  #rejectDone!: (error: unknown) => void;

  private constructor(options: WorkerHostOptions, launch: HostLaunch, hostLog: HostLog) {
    this.#options = options;
    this.runId = options.runId;
    this.runDir = options.runDir;
    this.socketPath = launch.socket;
    this.#token = launch.token ?? null;
    this.#hostLog = hostLog;
    this.#logger = createLogger({
      clock: options.clock,
      sinks: [hostLog.sink, ...(options.logSinks ?? [])],
      level: options.logLevel ?? "info",
      component: "worker-host",
    }).child({ run: options.runId });
    this.#startedAt = options.clock.now();
    this.#events = EventLog.open(join(options.runDir, EVENTS_FILE));
    this.done = new Promise((resolve, reject) => {
      this.#resolveDone = resolve;
      this.#rejectDone = reject;
    });
  }

  /**
   * Prepares the run directory, binds the socket and starts the worker. Resolves once the worker
   * runs (or failed to start, which still ends in `exit.json`); `done` settles at the end.
   */
  static start(options: WorkerHostOptions): WorkerHost {
    // The run directory holds the raw stream and the prompt files: owner only (0007 section 8).
    chmodSync(options.runDir, 0o700);
    const hostLog = openHostLog(
      join(options.runDir, HOST_LOG_FILE),
      options.logCapBytes ?? HOST_LOG_CAP_BYTES,
    );
    let launch: HostLaunch;
    try {
      launch = readLaunch(options.runDir, options.runId, options.pid);
    } catch (error) {
      createLogger({ clock: options.clock, sinks: [hostLog.sink], component: "worker-host" })
        .child({ run: options.runId })
        .error("cannot read the launch file", { error });
      hostLog.close();
      throw error;
    }
    const host = new WorkerHost(options, launch, hostLog);
    host.#begin(launch);
    if (host.#state === "running") {
      host.#offTerminate = options.onTerminate?.(() => host.terminate()) ?? null;
    }
    return host;
  }

  /**
   * The host process got SIGTERM (DIPO-93, 0006 decision 8 amendment): the engine stops a
   * follow-only host, whose socket it cannot reach, this way. The host stops its own worker as the
   * stop sequence does without its stop message: it closes the worker's stdin, sends it SIGTERM
   * and arms SIGKILL `TERM_KILL_AFTER_MS` later, cancelled when the worker exits. Then it ends as
   * always, with the exit line and `exit.json`. A second SIGTERM, or one after the worker exited,
   * changes nothing. True when this call started the stop.
   */
  terminate(): boolean {
    const steering = this.#steering;
    if (this.#terminating || this.#state !== "running" || steering === null) return false;
    this.#terminating = true;
    this.#logger.warn("SIGTERM received; stopping the worker", {
      workerPid: this.#child?.pid ?? null,
      killAfterMs: TERM_KILL_AFTER_MS,
    });
    steering.apply({ closeStdin: true });
    steering.apply({ signal: "SIGTERM" });
    steering.apply({ signal: "SIGKILL", afterMs: TERM_KILL_AFTER_MS });
    return true;
  }

  /**
   * Appends a hook payload as a `hook` line (0008 section 5); `dipo hook` reaches it through the
   * `hook` op. Returns the line's end offset, the id a waiting call is held under, or null when
   * the host has stopped.
   */
  relayHook(payload: unknown): number | null {
    if (this.#state === "exited") return null;
    return this.#append(
      "hook",
      typeof payload === "string" ? hookLineData(payload) : JSON.stringify(payload),
    );
  }

  /** Hook calls waiting for the engine's reply, by id. */
  get pendingHooks(): readonly number[] {
    return [...this.#pendingHooks.keys()];
  }

  status(): HostStatus {
    return {
      run: this.runId,
      protocol: Math.max(...HOST_PROTOCOL_VERSIONS),
      hostPid: this.#options.pid,
      workerPid: this.#child?.pid ?? null,
      state: this.#state,
      stdinOpen: this.#steering?.stdinOpen ?? false,
      offset: this.#events.offset,
      exit: this.#exit,
    };
  }

  #begin(launch: HostLaunch): void {
    const { plan } = launch;
    this.#logger.info("worker host starting", {
      pid: this.#options.pid,
      agent: launch.agent,
      offset: this.#events.offset,
    });
    const fail = (what: string, error: unknown) => {
      const message = `${what}: ${error instanceof Error ? error.message : String(error)}`;
      this.#logger.error(what, { error: message });
      // exit.json always exists once the host ran, so the engine never sees a silent end.
      void this.#finish({ code: null, signal: null }, message).then(
        this.#resolveDone,
        this.#rejectDone,
      );
    };
    try {
      for (const file of plan.files) {
        const path = join(this.runDir, file.name);
        // A file in a subdirectory (the Safe-Chain shell, DIPO-82) gets a private directory, and
        // the wrapper is executable; the mode is set again in case the file already existed.
        if (dirname(path) !== this.runDir) ensurePrivateDir(dirname(path));
        const mode = file.executable === true ? 0o700 : 0o600;
        writeFileSync(path, file.content, { mode });
        chmodSync(path, mode);
      }
      // The hosts directory carries the socket's access control (0006 decision 11).
      ensurePrivateDir(dirname(this.socketPath));
      // The engine never starts a host for a run whose old host is alive (0006 decision 8), so a
      // file left at this path is a leftover.
      removeSocketFile(this.socketPath);
      this.#server = listenLineSocket(this.socketPath, (connection) => this.#accept(connection));
    } catch (error) {
      fail("cannot prepare the host socket", error);
      return;
    }

    let child: ChildProcess;
    try {
      child = this.#options.spawn({
        cmd: plan.argv,
        cwd: plan.cwd,
        env: plan.env,
        stdin: "pipe",
        detached: true,
      });
    } catch (error) {
      fail("cannot start the worker", error);
      return;
    }
    this.#child = child;
    this.#steering = new Steering(child, this.#options.clock);
    this.#logger.info("worker started", { workerPid: child.pid });
    for (const line of plan.stdin) {
      const result = this.#steering.apply({ write: line });
      if (!result.ok) this.#logger.warn("cannot write the first stdin line", { ...result.error });
    }
    const output = Promise.all([
      this.#pump(child.stdout, "stdout", plan.lineScrub),
      this.#pump(child.stderr, "stderr"),
    ]);
    void this.#watchExit(child, output).then(this.#resolveDone, this.#rejectDone);
  }

  async #watchExit(child: ChildProcess, output: Promise<unknown>): Promise<HostExitFile> {
    const exit = await child.exited;
    this.#state = "exiting";
    const cancelled = this.#steering?.workerExited() ?? 0;
    if (cancelled > 0) this.#logger.info("delayed signals cancelled", { cancelled });
    // No child of the worker outlives the run: the worker leads its own process group.
    this.#options.killGroup(child.pid, "SIGKILL");
    let timer: TimerHandle | null = null;
    const grace = new Promise<"timeout">((resolve) => {
      timer = this.#options.clock.setTimeout(() => resolve("timeout"), OUTPUT_GRACE_MS);
    });
    const ended = await Promise.race([output.then(() => "ended" as const), grace]);
    if (timer !== null) this.#options.clock.clearTimeout(timer);
    if (ended === "timeout") {
      this.#logger.warn("worker output still open after the group kill; closing it", {
        graceMs: OUTPUT_GRACE_MS,
      });
      await Promise.allSettled([child.stdout.cancel(), child.stderr.cancel()]);
    }
    return this.#finish(exitCause(exit, this.#steering?.lastSignal ?? null));
  }

  async #pump(
    stream: ReadableStream<Uint8Array>,
    ch: "stdout" | "stderr",
    scrub?: LineScrub,
  ): Promise<void> {
    const splitter = new LineSplitter();
    // The plan's scrub (DIPO-105) runs before a stdout line is appended, so the event file never
    // holds what it removes. A line the splitter cut into pieces is scrubbed whole (DIPO-175).
    const scrubber =
      ch === "stdout" && scrub !== undefined
        ? new LineScrubber(scrub, MAX_SCRUB_LINE, (held) =>
            this.#logger.warn("dropped a stdout line over the scrub cap", { ch, held }),
          )
        : null;
    const keep = (piece: string): void => {
      const data = scrubber === null ? piece : scrubber.push(piece);
      if (data !== null) this.#append(ch, data);
    };
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const piece of splitter.push(value)) keep(piece);
      }
    } catch (error) {
      this.#logger.warn("reading worker output failed", { ch, error });
    } finally {
      reader.releaseLock();
      const rest = splitter.flush();
      if (rest !== null) keep(rest);
      const tail = scrubber?.flush() ?? null;
      if (tail !== null) this.#append(ch, tail);
    }
  }

  #append(ch: EventChannel, data: string): number {
    const offset = this.#events.append({
      t: this.#options.clock.now() - this.#startedAt,
      ch,
      data,
    });
    const frame = JSON.stringify({ kind: "advanced", offset } satisfies HostFrame);
    for (const client of this.#clients) {
      if (client.watching) client.connection.send(frame);
    }
    return offset;
  }

  async #finish(exit: ExitCause, startError?: string): Promise<HostExitFile> {
    this.#state = "exiting";
    this.#offTerminate?.();
    this.#offTerminate = null;
    // A hook call still waiting gets no decision: the worker it asked for has gone.
    this.#answerAllHooks("");
    const inferred = exit.signalInferred === true ? { signalInferred: true } : {};
    this.#append("exit", JSON.stringify({ code: exit.code, signal: exit.signal, ...inferred }));
    const record: HostExitFile = {
      run: this.runId,
      code: exit.code,
      signal: exit.signal,
      ...inferred,
      finalOffset: this.#events.offset,
      at: this.#options.clock.now(),
      ...(startError === undefined ? {} : { startError }),
    };
    writeExitFile(this.runDir, record);
    this.#exit = record;
    this.#state = "exited";
    this.#logger.info("worker exited", { ...exit, finalOffset: record.finalOffset });
    this.#events.close();
    await this.#server?.stop();
    this.#clients.clear();
    this.#logger.info("worker host stopped");
    this.#hostLog.close();
    return record;
  }

  #accept(connection: LineConnection): { line(text: string): void; closed(): void } {
    const client: Client = { connection, version: null, watching: false, engine: false };
    this.#clients.add(client);
    return {
      line: (text) => this.#frame(client, text),
      closed: () => {
        this.#clients.delete(client);
        for (const [hook, pending] of this.#pendingHooks) {
          if (pending.client !== client) continue;
          this.#options.clock.clearTimeout(pending.timer);
          this.#pendingHooks.delete(hook);
        }
        // The last engine stopped watching (the daemon is down): nobody will answer, so every
        // waiting call gets no decision now.
        if (client.watching && this.#isEngine(client) && !this.#watched()) this.#answerAllHooks("");
      },
    };
  }

  /** The engine's connection: it presented the token; any connection when the launch had none. */
  #isEngine(client: Client): boolean {
    return this.#token === null || client.engine;
  }

  /** True while an engine watches this host. */
  #watched(): boolean {
    for (const client of this.#clients) if (client.watching && this.#isEngine(client)) return true;
    return false;
  }

  /** Answers the waiting hook call `hook` with `output`; false when none waits under that id. */
  #answerHook(hook: number, output: string): boolean {
    const pending = this.#pendingHooks.get(hook);
    if (pending === undefined) return false;
    this.#pendingHooks.delete(hook);
    this.#options.clock.clearTimeout(pending.timer);
    this.#send(pending.client, { kind: "reply", id: pending.id, ok: true, result: { output } });
    return true;
  }

  #answerAllHooks(output: string): void {
    // A Map iterates safely while `#answerHook` deletes the entry it answered.
    for (const hook of this.#pendingHooks.keys()) this.#answerHook(hook, output);
  }

  /** The `hook` op: append the payload, then answer at once or hold the call (file comment). */
  #hook(client: Client, id: number, payload: string, waitMs: number | undefined): void {
    const answer = (output: string) =>
      this.#send(client, { kind: "reply", id, ok: true, result: { output } });
    const hook = this.relayHook(payload);
    if (hook === null) {
      answer("");
      return;
    }
    if (waitMs === undefined || waitMs === 0 || this.#state !== "running" || !this.#watched()) {
      answer("");
      return;
    }
    const timer = this.#options.clock.setTimeout(() => {
      this.#logger.info("a hook call waited without a reply; answering it with no output", {
        hook,
        waitMs,
      });
      this.#answerHook(hook, "");
    }, waitMs);
    this.#pendingHooks.set(hook, { client, id, timer });
  }

  #send(client: Client, frame: HostFrame): void {
    client.connection.send(JSON.stringify(frame));
  }

  #refuse(client: Client, error: HostError): void {
    this.#send(client, { kind: "refused", error, versions: HOST_PROTOCOL_VERSIONS });
    client.connection.close();
  }

  #frame(client: Client, text: string): void {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      value = undefined;
    }
    if (client.version === null) {
      const hello = HelloFrame.safeParse(value);
      if (!hello.success) {
        this.#refuse(client, { code: "frame.invalid", message: "The first frame must be hello." });
        return;
      }
      if (hello.data.run !== this.runId) {
        this.#refuse(client, {
          code: "run.mismatch",
          message: `This host runs ${this.runId}, not ${hello.data.run}.`,
        });
        return;
      }
      const version = pickVersion(hello.data.versions);
      if (version === null) {
        this.#refuse(client, {
          code: "protocol.unsupported",
          message: `This host speaks protocol ${HOST_PROTOCOL_VERSIONS.join(", ")}.`,
        });
        return;
      }
      client.version = version;
      client.engine = this.#token !== null && tokenMatches(hello.data.token, this.#token);
      this.#send(client, { kind: "hello", version, run: this.runId, pid: this.#options.pid });
      return;
    }
    const parsed = OpFrame.safeParse(value);
    if (!parsed.success) {
      const id = (value as { id?: unknown } | undefined)?.id;
      const op = (value as { op?: unknown } | undefined)?.op;
      if (typeof id !== "number") {
        this.#refuse(client, { code: "frame.invalid", message: "A frame needs a numeric id." });
        return;
      }
      const unknown = typeof op === "string" && !(HOST_OPS as readonly string[]).includes(op);
      this.#send(client, {
        kind: "reply",
        id,
        ok: false,
        error: unknown
          ? { code: "op.unknown", message: `Unknown op ${JSON.stringify(op)}.` }
          : { code: "frame.invalid", message: "The op frame is malformed." },
      });
      return;
    }
    const frame = parsed.data;
    if (OP_SINCE[frame.op] > client.version) {
      this.#send(client, {
        kind: "reply",
        id: frame.id,
        ok: false,
        error: {
          code: "op.unknown",
          message: `Op ${frame.op} needs protocol ${OP_SINCE[frame.op]}; this connection speaks ${client.version}.`,
        },
      });
      return;
    }
    if (frame.op === "hook") {
      this.#hook(client, frame.id, frame.payload, frame.waitMs);
      return;
    }
    if (frame.op === "hookReply") {
      // Only the engine answers a hook call: any other client that reaches the socket could
      // otherwise allow a pending permission request.
      if (!this.#isEngine(client)) {
        this.#send(client, {
          kind: "reply",
          id: frame.id,
          ok: false,
          error: { code: "not.permitted", message: "Only the engine answers a hook call." },
        });
        return;
      }
      const answered = this.#answerHook(frame.hook, frame.output);
      this.#logger.debug("hook reply", { hook: frame.hook, answered });
      this.#send(
        client,
        answered
          ? { kind: "reply", id: frame.id, ok: true }
          : {
              kind: "reply",
              id: frame.id,
              ok: false,
              error: { code: "hook.unknown", message: `No hook call waits as ${frame.hook}.` },
            },
      );
      return;
    }
    if (frame.op === "status") {
      this.#send(client, { kind: "reply", id: frame.id, ok: true, result: this.status() });
      return;
    }
    if (frame.op === "watch") {
      client.watching = true;
      this.#send(client, {
        kind: "reply",
        id: frame.id,
        ok: true,
        result: { offset: this.#events.offset },
      });
      return;
    }
    const op = hostOpOf(frame);
    const steering = this.#steering;
    if (op === null || steering === null || this.#state !== "running") {
      this.#send(client, {
        kind: "reply",
        id: frame.id,
        ok: false,
        error: { code: "worker.exited", message: "The worker has exited." },
      });
      return;
    }
    const result = steering.apply(op);
    this.#logger.debug("steering op", { op: frame.op, ok: result.ok });
    this.#send(
      client,
      result.ok
        ? { kind: "reply", id: frame.id, ok: true }
        : { kind: "reply", id: frame.id, ok: false, error: result.error },
    );
  }
}

/** Runs the host to the end; resolves to the process exit code. */
export async function runWorkerHost(options: WorkerHostOptions): Promise<number> {
  if (!existsSync(options.runDir))
    throw new Error(`the run directory ${options.runDir} is missing`);
  const host = WorkerHost.start(options);
  await host.done;
  return 0;
}
