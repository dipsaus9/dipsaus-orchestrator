// The worker host, `dipo daemon worker-host <run-id>` (0006 decision 8, 0008 section 1). It reads
// `launch.json` from its run directory, writes the plan's files, binds
// `<runtime>/hosts/<run-id>.sock`, starts the worker through the injected `Spawn`, writes the
// first stdin lines and appends every stdout and stderr line and the exit to
// `events.ndjson`. When the worker exits it cancels delayed signals, kills the worker's process
// group so no child of the worker outlives the run, writes `exit.json` and returns.
//
// SIGTERM to the host stops its worker (stdin closed, SIGTERM, SIGKILL 20 s later) instead of
// ending the host at once (DIPO-93): after a restart the engine stops a host whose socket does not
// answer this way, once its PID and start time are verified (0005).
//
// A daemon claims the host with its first handshake. A host no daemon claimed by the launch
// deadline in `launch.json` stops its worker the same way and refuses every later handshake, so a
// host no daemon answers for never runs on untracked (DIPO-386, 0008).
//
// A box worker (DIPO-271) is a `container exec` client on the Mac, and a killed client leaves its
// process running in the box. Its plan carries a stop command (`container stop <box>`), which the
// host runs once: when it first sends the worker SIGTERM or SIGKILL, or after the worker exited.
//
// It holds no engine logic: no budgets, gates, git or database (a lint rule keeps those imports
// out of `host/`). Time comes from the injected clock and the process from the injected spawn, so
// tests run it in-process with a fake process; only the detach test needs a real one.

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
  EVENTS_FILE,
  EXIT_FILE,
  HelloFrame,
  HOST_LOG_CAP_BYTES,
  HOST_LOG_FILE,
  HOST_OPS,
  HOST_PROTOCOL_VERSIONS,
  HostLaunchSchema,
  LAUNCH_FILE,
  OP_SINCE,
  OpFrame,
  pickVersion,
  type HostError,
  type HostExitFile,
  type HostFrame,
  type HostLaunch,
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

/**
 * How long the plan's stop command may take (DIPO-271: a box's `container stop`, which itself
 * waits a few seconds before it kills what runs in the box).
 */
export const STOP_COMMAND_TIMEOUT_MS = 60_000;

/** The most of a failed stop command's stderr the host log keeps. */
const STOP_COMMAND_STDERR_CHARS = 500;

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
 * Reads, validates and removes `launch.json`; it holds the task message, so it never stays. A
 * launch the engine's recovery removed first is gone, and this host starts nothing (0005).
 */
export function readLaunch(runDir: string, runId: string): HostLaunch {
  const path = join(runDir, LAUNCH_FILE);
  try {
    const launch = HostLaunchSchema.parse(JSON.parse(readFileSync(path, "utf8"))) as HostLaunch;
    if (launch.run !== runId) {
      throw new Error(`${LAUNCH_FILE} is for ${launch.run}, not ${runId}`);
    }
    return launch;
  } finally {
    rmSync(path, { force: true });
  }
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
  #server: LineServer | null = null;
  #child: ChildProcess | null = null;
  #steering: Steering | null = null;
  #state: HostState = "running";
  #exit: HostExitFile | null = null;
  /** Epoch ms by which a daemon's handshake must claim the host (DIPO-386). */
  readonly #deadline: number;
  /** Set by the first handshake before the deadline: a daemon follows the host. */
  #claimed = false;
  /** Set when the deadline passed unclaimed: the worker is being stopped. */
  #unclaimed = false;
  #claimTimer: TimerHandle | null = null;
  /** Set once SIGTERM to the host started stopping the worker (DIPO-93). */
  #terminating = false;
  #offTerminate: (() => void) | null = null;
  /** The plan's stop command (DIPO-271), null without one. */
  #stopCommand: readonly [string, ...string[]] | null = null;
  #stopEnv: Readonly<Record<string, string>> = {};
  /** The one run of the stop command, once it started. */
  #stopped: Promise<void> | null = null;
  #resolveDone!: (exit: HostExitFile) => void;
  #rejectDone!: (error: unknown) => void;

  private constructor(options: WorkerHostOptions, launch: HostLaunch, hostLog: HostLog) {
    this.#options = options;
    this.runId = options.runId;
    this.runDir = options.runDir;
    this.socketPath = launch.socket;
    this.#deadline = launch.deadline;
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
      launch = readLaunch(options.runDir, options.runId);
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
   * The host process got SIGTERM (DIPO-93, 0005): after a restart the engine stops a host whose
   * socket does not answer this way. The host stops its own worker as the
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
   * The launch deadline passed and no daemon claimed the host (DIPO-386): it refuses every later
   * handshake and stops its worker as on SIGTERM. True when the host is unclaimed.
   */
  #claimExpired(): boolean {
    if (this.#claimed) return false;
    if (!this.#unclaimed && this.#options.clock.now() < this.#deadline) return false;
    if (!this.#unclaimed) {
      this.#unclaimed = true;
      this.#clearClaimTimer();
      this.#logger.error("no daemon claimed the worker host by its launch deadline; stopping", {
        deadline: this.#deadline,
      });
      this.terminate();
    }
    return true;
  }

  #clearClaimTimer(): void {
    if (this.#claimTimer !== null) this.#options.clock.clearTimeout(this.#claimTimer);
    this.#claimTimer = null;
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
    const { clock } = this.#options;
    if (clock.now() >= this.#deadline) {
      // Started after its launch deadline: no daemon follows it any more, so no worker starts.
      this.#unclaimed = true;
      fail("no daemon claimed the worker host by its launch deadline", new Error("too late"));
      return;
    }
    this.#claimTimer = clock.setTimeout(() => {
      this.#claimTimer = null;
      this.#claimExpired();
    }, this.#deadline - clock.now());
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
    this.#stopCommand = plan.stopCommand ?? null;
    this.#stopEnv = plan.env;
    // A signal reaches only the worker's process on the Mac; for a box worker the stop command
    // ends what it runs in the box too (DIPO-271).
    this.#steering = new Steering(child, this.#options.clock, (signal) => {
      if (signal === "SIGTERM" || signal === "SIGKILL") void this.#stop(`worker ${signal}`);
    });
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
    // Nothing the worker started outlives it in its box either (DIPO-271).
    await this.#stop("the worker exited");
    return this.#finish(exitCause(exit, this.#steering?.lastSignal ?? null));
  }

  /**
   * Runs the plan's stop command once (DIPO-271), within `STOP_COMMAND_TIMEOUT_MS`; later calls
   * wait for that run. Never rejects: a failure is logged, and the exit is recorded as always.
   */
  #stop(why: string): Promise<void> {
    if (this.#stopCommand === null) return Promise.resolve();
    this.#stopped ??= this.#runStop(this.#stopCommand, why);
    return this.#stopped;
  }

  async #runStop(command: readonly [string, ...string[]], why: string): Promise<void> {
    this.#logger.info("running the stop command", { why, program: command[0] });
    let child: ChildProcess;
    try {
      child = this.#options.spawn({ cmd: command, env: this.#stopEnv, stdin: "ignore" });
    } catch (error) {
      this.#logger.warn("cannot run the stop command", { why, error });
      return;
    }
    const { clock } = this.#options;
    let timer: TimerHandle | null = null;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = clock.setTimeout(() => resolve("timeout"), STOP_COMMAND_TIMEOUT_MS);
    });
    const finished = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]).then(([, stderr, exit]) => ({ stderr, exit }));
    const result = await Promise.race([finished, timeout]).catch((error: unknown) => {
      this.#logger.warn("the stop command failed", { why, error });
      return null;
    });
    if (timer !== null) clock.clearTimeout(timer);
    if (result === null) return;
    if (result === "timeout") {
      child.kill("SIGKILL");
      this.#logger.warn("the stop command did not end in time; killed it", {
        why,
        timeoutMs: STOP_COMMAND_TIMEOUT_MS,
      });
      return;
    }
    if (result.exit.code === 0) {
      this.#logger.info("the stop command ended", { why });
      return;
    }
    this.#logger.warn("the stop command failed", {
      why,
      code: result.exit.code,
      signal: result.exit.signal,
      stderr: result.stderr.trim().slice(0, STOP_COMMAND_STDERR_CHARS),
    });
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
    this.#clearClaimTimer();
    this.#offTerminate?.();
    this.#offTerminate = null;
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
    const client: Client = { connection, version: null, watching: false };
    this.#clients.add(client);
    return {
      line: (text) => this.#frame(client, text),
      closed: () => {
        this.#clients.delete(client);
      },
    };
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
      if (this.#claimExpired()) {
        this.#refuse(client, {
          code: "host.unclaimed",
          message: "No daemon claimed this host by its launch deadline; it stops its worker.",
        });
        return;
      }
      this.#claimed = true;
      this.#clearClaimTimer();
      client.version = version;
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
