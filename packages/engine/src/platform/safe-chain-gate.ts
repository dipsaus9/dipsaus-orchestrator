// The inside of `dipo daemon safe-chain-gate --dir <dir>` (DIPO-84): runs in the Safe-Chain proxy's
// own sandbox (`dipo daemon sandbox-exec`, policy from `safeChainProxyPolicy`). It starts the two
// Safe-Chain processes (npm and PyPI) with the holder in place of the package manager, waits for
// both holders to report Safe-Chain's local port and CA bundle, then listens on the gate's Unix
// socket and prints one ready line (`{"ready":true,"bundle":...}`) on stdout. Each connection
// passes only `CONNECT <checked registry>:443` (`gateDecision`), forwarded to the Safe-Chain process
// of that registry's ecosystem; anything else gets a 4xx and is closed. It stops when its stdin
// closes (the daemon ends the proxy or exits) or a Safe-Chain process exits; it never runs on
// without both.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";

import type { ChildProcess, Clock, Spawn, TimerHandle } from "@dipsaus-orchestrator/contract";

import {
  gateDecision,
  GATE_HEAD_LIMIT_BYTES,
  GATE_HEAD_TIMEOUT_MS,
  HOLDER_REPORT_ENV,
  holderReportPath,
  parseHolderReport,
  SAFE_CHAIN_ECOSYSTEMS,
  SAFE_CHAIN_HOLDER_COMMANDS,
  safeChainProxyLayout,
  type HolderReport,
  type SafeChainEcosystem,
  type SafeChainProxyLayout,
} from "../sandbox/safe-chain-proxy";

/** How long one Safe-Chain process may take to start its proxy (it fetches the malware lists). */
export const SAFE_CHAIN_START_TIMEOUT_MS = 90_000;
/** How often the gate looks for a holder report. */
const REPORT_POLL_MS = 100;
/** Bytes of a Safe-Chain process's stderr kept for the refusal message. */
const STDERR_TAIL_BYTES = 2_000;

export interface SafeChainGateOptions {
  readonly dir: string;
  readonly clock: Clock;
  readonly spawn: Spawn;
  /** The gate's environment (inside the sandbox: srt's proxy variables and TMPDIR). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Resolves when the gate's stdin closes. */
  readonly stdinClosed: Promise<void>;
  readonly writeLine: (line: string) => void;
  readonly writeError: (line: string) => void;
}

interface Running {
  readonly ecosystem: SafeChainEcosystem;
  readonly child: ChildProcess;
  stderr: string;
  exited: boolean;
}

function delay(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => clock.setTimeout(resolve, ms));
}

async function collect(stream: ReadableStream<Uint8Array>, into: (text: string) => void) {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    into(decoder.decode(value, { stream: true }));
  }
}

function start(
  options: SafeChainGateOptions,
  layout: SafeChainProxyLayout,
  ecosystem: SafeChainEcosystem,
): Running {
  const report = holderReportPath(layout, ecosystem);
  rmSync(report, { force: true });
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.env)) {
    if (value !== undefined) env[name] = value;
  }
  // The holder stands in for the package manager; nothing of the maintainer's home is used.
  env["PATH"] = `${layout.holders}:/usr/bin:/bin`;
  env["HOME"] = layout.home;
  env[HOLDER_REPORT_ENV] = report;
  const child = options.spawn({
    cmd: [layout.binary, ...SAFE_CHAIN_HOLDER_COMMANDS[ecosystem]],
    cwd: layout.home,
    env,
    stdin: "pipe",
  });
  const running: Running = { ecosystem, child, stderr: "", exited: false };
  void collect(child.stdout, () => {}).catch(() => {});
  void collect(child.stderr, (text) => {
    running.stderr = (running.stderr + text).slice(-STDERR_TAIL_BYTES);
  }).catch(() => {});
  void child.exited.then(() => {
    running.exited = true;
  });
  return running;
}

async function awaitReport(
  options: SafeChainGateOptions,
  layout: SafeChainProxyLayout,
  running: Running,
): Promise<HolderReport | string> {
  const path = holderReportPath(layout, running.ecosystem);
  const deadline = options.clock.now() + SAFE_CHAIN_START_TIMEOUT_MS;
  for (;;) {
    if (existsSync(path)) {
      const report = parseHolderReport(readFileSync(path, "utf8"), layout);
      return report ?? `the ${running.ecosystem} Safe-Chain process reported no usable proxy`;
    }
    if (running.exited) {
      const tail = running.stderr.trim();
      return `the ${running.ecosystem} Safe-Chain process exited before its proxy started${tail === "" ? "" : `: ${tail}`}`;
    }
    if (options.clock.now() >= deadline) {
      return `the ${running.ecosystem} Safe-Chain process did not start its proxy within ${SAFE_CHAIN_START_TIMEOUT_MS / 1000} s`;
    }
    await delay(options.clock, REPORT_POLL_MS);
  }
}

function refuse(socket: Socket, status: 400 | 403, reason: string): void {
  const text = status === 400 ? "Bad Request" : "Forbidden";
  socket.end(
    `HTTP/1.1 ${status} ${text}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\ndipo Safe-Chain gate: ${reason}\n`,
  );
}

/** Handles one connection: reads the request head, then refuses or forwards it. */
export function handleGateConnection(
  socket: Socket,
  ports: Readonly<Record<SafeChainEcosystem, number>>,
  clock: Clock,
): void {
  let head = Buffer.alloc(0);
  let decided = false;
  const timer: TimerHandle = clock.setTimeout(() => {
    if (!decided) socket.destroy();
  }, GATE_HEAD_TIMEOUT_MS);
  socket.on("error", () => socket.destroy());
  const onData = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end < 0) {
      if (head.length > GATE_HEAD_LIMIT_BYTES) {
        decided = true;
        clock.clearTimeout(timer);
        socket.off("data", onData);
        refuse(socket, 400, "request head too large");
      }
      return;
    }
    decided = true;
    clock.clearTimeout(timer);
    socket.off("data", onData);
    socket.pause();
    const decision = gateDecision(head.subarray(0, end).toString("latin1"));
    if (!decision.ok) {
      refuse(socket, decision.status, decision.reason);
      return;
    }
    const rest = head.subarray(end + 4);
    const upstream = connect(ports[decision.ecosystem], "127.0.0.1", () => {
      upstream.write(
        `CONNECT ${decision.host}:${decision.port} HTTP/1.1\r\nHost: ${decision.host}:${decision.port}\r\n\r\n`,
      );
      if (rest.length > 0) upstream.write(rest);
      socket.pipe(upstream);
      upstream.pipe(socket);
      socket.resume();
    });
    upstream.on("error", () => {
      if (!socket.destroyed) socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
  };
  socket.on("data", onData);
}

function listen(path: string, onConnection: (socket: Socket) => void): Promise<Server> {
  rmSync(path, { force: true });
  return new Promise((resolve, reject) => {
    const server = createServer(onConnection);
    server.once("error", reject);
    server.listen(path, () => resolve(server));
  });
}

function stopAll(running: readonly Running[]): void {
  for (const process of running) {
    process.child.stdin?.end();
    process.child.kill("SIGTERM");
  }
}

/** Runs the gate until its stdin closes; resolves to the exit code. */
export async function runSafeChainGate(options: SafeChainGateOptions): Promise<number> {
  const layout = safeChainProxyLayout(options.dir);
  const running: Running[] = [];
  const fail = (reason: string): number => {
    stopAll(running);
    options.writeLine(JSON.stringify({ ready: false, reason }));
    options.writeError(`dipo safe-chain-gate: ${reason}`);
    return 1;
  };
  const ports: Partial<Record<SafeChainEcosystem, number>> = {};
  let bundle: string | null = null;
  // One after the other: the first creates the proxy's CA, the second loads the same one.
  for (const ecosystem of SAFE_CHAIN_ECOSYSTEMS) {
    const process = start(options, layout, ecosystem);
    running.push(process);
    const report = await awaitReport(options, layout, process);
    if (typeof report === "string") return fail(report);
    ports[ecosystem] = report.port;
    bundle ??= report.bundle;
  }
  const routes = ports as Record<SafeChainEcosystem, number>;
  let server: Server;
  try {
    server = await listen(layout.socket, (socket) =>
      handleGateConnection(socket, routes, options.clock),
    );
  } catch (error) {
    return fail(
      `the gate could not listen on ${layout.socket}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  options.writeLine(JSON.stringify({ ready: true, bundle }));
  const ended = await Promise.race([
    options.stdinClosed.then(() => "stdin" as const),
    ...running.map((process) => process.child.exited.then(() => process.ecosystem)),
  ]);
  server.close();
  stopAll(running);
  rmSync(layout.socket, { force: true });
  if (ended === "stdin") return 0;
  options.writeError(`dipo safe-chain-gate: the ${ended} Safe-Chain process exited; gate closed`);
  return 1;
}
