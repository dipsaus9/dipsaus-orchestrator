// A fake `container` CLI for the box backend tests (DIPO-265): a `Spawn` that answers each argv
// from a script of replies, recorded from `container` 1.6.0's output shapes. A reply may hang
// until it is killed, so deadlines are tested on the manual clock.

import type {
  ChildExit,
  ChildProcess,
  ChildStdin,
  Signal,
  Spawn,
  SpawnOptions,
} from "@dipsaus-orchestrator/contract";

/** What one `container` call prints and how it ends. */
export interface CliReply {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  /** Never exits on its own; only a kill ends it. */
  readonly hang?: boolean;
}

/** Picks the reply of one call from its arguments after the program; undefined: not scripted. */
export type CliScript = (args: readonly string[]) => CliReply | undefined;

export interface FakeChild extends ChildProcess {
  readonly signals: Signal[];
  readonly stdinWrites: string[];
}

export interface FakeContainer {
  readonly spawn: Spawn;
  readonly calls: SpawnOptions[];
  readonly children: FakeChild[];
  /** The argv of every call after the program, in order. */
  args(): string[][];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function textStream(text: string): {
  stream: ReadableStream<Uint8Array>;
  close: () => void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
      if (text.length > 0) c.enqueue(encoder.encode(text));
    },
  });
  return {
    stream,
    close: () => {
      if (closed) return;
      closed = true;
      controller.close();
    },
  };
}

function fakeChild(reply: CliReply, pid: number, stdin: "pipe" | "ignore"): FakeChild {
  const out = textStream(reply.stdout ?? "");
  const err = textStream(reply.stderr ?? "");
  let resolveExit!: (exit: ChildExit) => void;
  const exited = new Promise<ChildExit>((resolve) => {
    resolveExit = resolve;
  });
  let done = false;
  const finish = (exit: ChildExit) => {
    if (done) return;
    done = true;
    out.close();
    err.close();
    resolveExit(exit);
  };
  const signals: Signal[] = [];
  const stdinWrites: string[] = [];
  const pipe: ChildStdin = {
    write: (chunk) => {
      stdinWrites.push(typeof chunk === "string" ? chunk : decoder.decode(chunk));
    },
    end: () => {},
  };
  if (reply.hang !== true) finish({ code: reply.code ?? 0, signal: null });
  return {
    pid,
    stdin: stdin === "pipe" ? pipe : null,
    stdout: out.stream,
    stderr: err.stream,
    exited,
    signals,
    stdinWrites,
    kill: (signal: Signal = "SIGTERM") => {
      signals.push(signal);
      finish({ code: null, signal });
    },
  };
}

/** A `Spawn` that answers from `script`; an unscripted call fails the test loudly. */
export function fakeContainer(script: CliScript): FakeContainer {
  const calls: SpawnOptions[] = [];
  const children: FakeChild[] = [];
  const spawn: Spawn = (options) => {
    calls.push(options);
    const args = options.cmd.slice(1);
    const reply = script(args);
    if (reply === undefined) throw new Error(`fake container: no reply for ${args.join(" ")}`);
    const child = fakeChild(reply, 5000 + children.length, options.stdin ?? "ignore");
    children.push(child);
    return child;
  };
  return { spawn, calls, children, args: () => calls.map((call) => call.cmd.slice(1)) };
}

/** A `Spawn` that throws as Bun does for a program that does not exist. */
export const missingContainer: Spawn = () => {
  throw new Error("ENOENT: no such file or directory, posix_spawn 'container'");
};

/** `container --version` of 1.6.0. */
export const VERSION_1_6_0 = "container CLI version 1.6.0 (build: release, commit: ca4884f)\n";

/** `container system status --format json` with the service running (fields trimmed). */
export const STATUS_RUNNING = JSON.stringify({
  status: "running",
  client: { version: "1.6.0" },
  server: { version: "1.6.0" },
});

/** One network of `container network list --format json`. */
export function networkJson(name: string, mode: string, gateway = "192.0.2.1"): unknown {
  return {
    id: name,
    configuration: { name, mode, labels: { dipo: "network" }, plugin: "container-network-vmnet" },
    status: { ipv4Gateway: gateway, ipv4Subnet: "192.0.2.0/24" },
  };
}

/** One box of `container list --all --format json`. */
export function boxJson(
  id: string,
  state: string,
  labels: Readonly<Record<string, unknown>> = {},
): unknown {
  return {
    id,
    configuration: { id, labels, image: { reference: "docker.io/library/alpine:3.20" } },
    status: { state, networks: [] },
  };
}
