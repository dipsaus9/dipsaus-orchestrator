// Probes of the Bun runtime features the daemon relies on, run by the hidden `dipo self-check`
// (DIPO-17) so a feature that breaks under `bun build --compile` shows up in the smoke jobs, not in a
// later story. Each probe uses its own temporary directory under `tmpRoot` and removes it.

import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

/** One probe of the hidden `dipo self-check`; it throws when the feature does not work. */
export type SelfCheck = {
  readonly name: string;
  readonly run: () => Promise<void> | void;
};

const TIMEOUT_MS = 10_000;

export function platformSelfChecks(tmpRoot: string): SelfCheck[] {
  return [
    { name: "sqlite-wal", run: () => withTempDir(tmpRoot, checkSqliteWal) },
    { name: "worker", run: () => withTempDir(tmpRoot, checkWorker) },
    { name: "unix-websocket", run: () => withTempDir(tmpRoot, checkUnixWebSocket) },
    { name: "yaml", run: checkYaml },
    { name: "sandbox-runtime", run: checkSandboxRuntime },
  ];
}

async function withTempDir(tmpRoot: string, fn: (dir: string) => Promise<void>): Promise<void> {
  await mkdir(tmpRoot, { recursive: true });
  const dir = await mkdtemp(join(tmpRoot, "dipo-self-check-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function openWal(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  const mode = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode = WAL").get();
  if (mode?.journal_mode !== "wal") {
    db.close();
    throw new Error(`journal_mode is ${mode?.journal_mode ?? "unknown"}, expected wal`);
  }
  db.run("CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  db.transaction(() => {
    const insert = db.prepare("INSERT INTO probe (value) VALUES (?)");
    for (const value of ["a", "b", "c"]) insert.run(value);
  }).immediate();
  return db;
}

async function checkSqliteWal(dir: string): Promise<void> {
  const db = openWal(join(dir, "probe.db"));
  try {
    const values = db
      .query<{ value: string }, []>("SELECT value FROM probe ORDER BY id")
      .all()
      .map((row) => row.value);
    if (values.join(",") !== "a,b,c") throw new Error(`read back ${JSON.stringify(values)}`);
  } finally {
    db.close();
  }
}

/**
 * Path of the worker entrypoint inside a compiled binary. `scripts/build.ts` passes the worker to
 * `bun build --compile` as an extra entrypoint with `--root=packages`, so it keeps its path below
 * `packages/` under the binary's virtual root.
 */
export const COMPILED_WORKER_PATH = "/$bunfs/root/engine/src/platform/self-check-worker.ts";

export function selfCheckWorkerUrl(moduleUrl: string = import.meta.url): string {
  // In the binary every module is bundled into the entry at `/$bunfs/root/<outfile>`, so a URL
  // relative to this module would point next to the entry instead of at the worker.
  if (new URL(moduleUrl).pathname.startsWith("/$bunfs/")) return COMPILED_WORKER_PATH;
  return new URL("./self-check-worker.ts", moduleUrl).href;
}

type WorkerReply = { ok: true; rows: number } | { ok: false; error: string };

async function checkWorker(dir: string): Promise<void> {
  const databasePath = join(dir, "probe.db");
  const db = openWal(databasePath);
  const worker = new Worker(selfCheckWorkerUrl());
  try {
    const reply = await withTimeout(
      new Promise<WorkerReply>((resolve, reject) => {
        worker.addEventListener("message", (event: MessageEvent<WorkerReply>) =>
          resolve(event.data),
        );
        worker.addEventListener("error", (event) => reject(new Error(event.message)));
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a Worker has no target origin
        worker.postMessage({ databasePath, snapshotPath: join(dir, "snapshot.db") });
      }),
      "worker reply",
    );
    if (!reply.ok) throw new Error(reply.error);
    if (reply.rows !== 3) throw new Error(`worker counted ${reply.rows} rows, expected 3`);
  } finally {
    worker.terminate();
    db.close();
  }
}

async function checkUnixWebSocket(dir: string): Promise<void> {
  const socketPath = join(dir, "probe.sock");
  const server = Bun.serve({
    unix: socketPath,
    fetch(request, srv) {
      if (srv.upgrade(request, { data: undefined })) return undefined;
      return new Response("expected a WebSocket upgrade", { status: 426 });
    },
    websocket: {
      message(ws, message) {
        ws.send(`echo:${String(message)}`);
      },
    },
  });
  const client = new WebSocket(`ws+unix://${socketPath}`);
  try {
    const reply = await withTimeout(
      new Promise<string>((resolve, reject) => {
        client.addEventListener("open", () => client.send("ping"));
        client.addEventListener("message", (event) => resolve(String(event.data)));
        client.addEventListener("error", () =>
          reject(new Error(`WebSocket error on ws+unix://${socketPath}`)),
        );
      }),
      "WebSocket echo",
    );
    if (reply !== "echo:ping") throw new Error(`unexpected reply ${JSON.stringify(reply)}`);
  } finally {
    client.close();
    await server.stop(true);
  }
}

function checkYaml(): void {
  // YAML 1.2: `no` stays a string (0017 section 5).
  const parsed: unknown = Bun.YAML.parse("version: 1\ntiers:\n  - small\n  - large\nanswer: no\n");
  const expected = { version: 1, tiers: ["small", "large"], answer: "no" };
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
    throw new Error(`parsed ${JSON.stringify(parsed)}`);
  }
}

// No network, no writes. Initialising starts the in-process proxies and checks the platform
// dependencies (bubblewrap, socat and ripgrep on Linux); running a command is DIPO-37's
// `dipo daemon sandbox-exec`.
const DENY_ALL: SandboxRuntimeConfig = {
  network: { allowedDomains: [], deniedDomains: [] },
  filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
};

async function checkSandboxRuntime(): Promise<void> {
  try {
    await SandboxManager.initialize(DENY_ALL);
    if (!SandboxManager.isSandboxingEnabled()) {
      throw new Error("sandboxing is not enabled after initialize");
    }
  } finally {
    await SandboxManager.reset();
  }
}

function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${TIMEOUT_MS} ms`)),
      TIMEOUT_MS,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
