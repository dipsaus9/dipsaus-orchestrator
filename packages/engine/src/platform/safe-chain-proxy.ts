// The daemon side of dipo's Safe-Chain checking proxy (DIPO-84). One proxy per worker session of a
// run, on a machine with the official Safe-Chain install:
//
// 1. A fresh `/tmp/dipo-p/<random>` directory (0700, under the private parent `/tmp/dipo-p`) gets
//    a copy of `~/.safe-chain/bin/safe-chain` (so Safe-Chain makes its own CA there and never
//    writes `~/.safe-chain`), the holder scripts, an owner file with the daemon's process id and
//    the proxy's sandbox settings (`safeChainProxyPolicy`).
// 2. `dipo daemon sandbox-exec` runs `dipo daemon safe-chain-gate` in that sandbox; the gate starts
//    Safe-Chain for npm and PyPI and prints one ready line.
// 3. dipo copies Safe-Chain's CA bundle (PEM certificates only) to the run's Safe-Chain shell
//    directory, where the worker's package managers read it.
// 4. dipo listens on 127.0.0.1 with an ephemeral port and forwards each connection, byte for byte,
//    to the gate's Unix socket. That port is the worker's `httpProxyPort`. This side never parses
//    worker traffic; the gate does, inside the sandbox.
// 5. The proxy check, with no model: through that port `is-number@7.0.0` downloads, Safe-Chain's
//    own test package `safe-chain-test` is refused with 403, and a host that is not a checked
//    registry is refused by the gate. Anything else stops the proxy and refuses the launch.
//
// Fail-closed: any step that fails stops what was started and returns the reason; the caller
// refuses the launch. The proxy also stops when its stdin closes, so it never outlives the daemon.

import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { basename, dirname, resolve } from "node:path";

import type { Clock } from "@dipsaus-orchestrator/contract";

import { refusalPathFor } from "../sandbox/step";
import { ignoreRejection } from "./background";
import {
  holderScript,
  isCertificateBundle,
  safeChainProxyLayout,
  safeChainProxyPolicy,
  SAFE_CHAIN_HOLDER_COMMANDS,
  SAFE_CHAIN_ECOSYSTEMS,
  PROXY_DIR_NAME,
  SAFE_CHAIN_PROXY_ROOT,
  type SafeChainProxyLayout,
} from "../sandbox/safe-chain-proxy";
import type { DipoPlatform } from "./paths";
import {
  dipoCommand,
  isCompiled,
  resolveTools,
  sandboxExecArgv,
  systemDipoDirs,
  TRUSTED_CWD,
} from "./sandbox";

/** How long the gate may take to report ready (both Safe-Chain processes fetch their lists). */
export const PROXY_READY_TIMEOUT_MS = 180_000;
/** How long one request of the proxy check may take. */
export const PROXY_CHECK_TIMEOUT_MS = 30_000;
/** Time between closing the gate's stdin and killing it. */
export const PROXY_STOP_GRACE_MS = 3_000;

/** The proxy check's downloads: one allowed small package and Safe-Chain's own test malware. */
export const PROXY_CHECK_ALLOWED_URL = "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz";
export const PROXY_CHECK_BLOCKED_URL =
  "https://registry.npmjs.org/safe-chain-test/-/safe-chain-test-0.0.1-security.tgz";
/** A host the gate must refuse (not a checked registry). */
export const PROXY_CHECK_REFUSED_URL = "https://example.com/";

export interface SafeChainProxyRequest {
  /** The official install, `~/.safe-chain`; only its binary is read (copied). */
  readonly installRoot: string;
  /** Where the worker's CA bundle is written (`<runDir>/safe-chain/ca.pem`). */
  readonly caFile: string;
  readonly home: string;
  readonly uid: number;
  /** The daemon's environment: PATH for `rg` (and `bwrap`, `socat` on Linux). */
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface RunningSafeChainProxy {
  /** The local port the worker's sandbox proxy setting names. */
  readonly port: number;
  /** The proxy directory; the worker sandbox may not read it. */
  readonly dir: string;
  readonly caFile: string;
  /** Settles when the gate process has exited. */
  readonly exited: Promise<void>;
  /** Stops the gate, closes the port and removes the proxy directory. */
  stop(): Promise<void>;
}

export type SafeChainProxyStart =
  | { readonly ok: true; readonly proxy: RunningSafeChainProxy }
  | { readonly ok: false; readonly reason: string };

/**
 * Closes a pipe to a child without an unhandled rejection (DIPO-117): Bun's `FileSink.end()` may
 * return a promise, which rejects when the child already exited; a throw means it was closed. In
 * the daemon an unhandled rejection is a crash.
 */
export function endQuietly(sink: { end(): unknown }): void {
  try {
    ignoreRejection(sink.end());
  } catch {
    // Already closed.
  }
}

export interface SafeChainProxyDeps {
  readonly platform: DipoPlatform;
  readonly clock: Clock;
  /** How to run `dipo` (`dipoCommand()`); tests run it from source. */
  readonly dipo?: readonly string[];
  /** The proxies' private parent (`SAFE_CHAIN_PROXY_ROOT`); tests pass one under DIPO_TMP. */
  readonly root?: string;
}

/**
 * Makes the proxies' parent a private directory of this user, or refuses: a parent someone else
 * owns or can enter, or a link, could hand a proxy files dipo did not make.
 */
export async function ensureProxyRoot(root: string): Promise<string> {
  await mkdir(root, { mode: 0o700 }).catch((error: unknown) => {
    if ((error as { code?: string }).code !== "EEXIST") throw error;
  });
  const info = await lstat(root);
  const uid = process.getuid?.() ?? info.uid;
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${root} is not a directory`);
  }
  if (info.uid !== uid || (info.mode & 0o077) !== 0) {
    throw new Error(`${root} is not a private (0700) directory of this user`);
  }
  return realpath(root);
}

/** True when a process with this id runs (the owner of a proxy directory). */
function processRuns(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

/**
 * Removes proxy directories a daemon left behind when it was killed (DIPO-84): only under a
 * private root, only names `mkdtemp` makes, only directories this user owns, and only when their
 * owner process no longer runs. Their policy and refusal files go with them. Returns what it removed.
 */
export async function sweepSafeChainProxies(
  root: string = SAFE_CHAIN_PROXY_ROOT,
  running: (pid: number) => boolean = processRuns,
): Promise<string[]> {
  let real: string;
  try {
    const info = await lstat(root);
    if (!info.isDirectory()) return [];
    real = await ensureProxyRoot(root);
  } catch {
    return [];
  }
  const uid = process.getuid?.() ?? -1;
  const removed: string[] = [];
  for (const name of await readdir(real)) {
    if (!PROXY_DIR_NAME.test(name)) continue;
    const layout = safeChainProxyLayout(`${real}/${name}`);
    const info = await lstat(layout.dir).catch(() => null);
    if (info === null || !info.isDirectory() || info.uid !== uid) continue;
    const owner = Number((await readFile(layout.owner, "utf8").catch(() => "")).trim());
    if (Number.isInteger(owner) && owner > 0 && running(owner)) continue;
    await removeLayout(layout);
    removed.push(layout.dir);
  }
  return removed;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What the sandboxed `dipo` must read: its binary, or Bun and the source tree. */
async function dipoReads(dipo: readonly string[]): Promise<string[]> {
  const paths =
    isCompiled() || dipo.length === 1
      ? [dipo[0] ?? process.execPath]
      : [dipo[0] ?? process.execPath, resolve(dipo[1] ?? "", "../../../..")];
  const all: string[] = [];
  for (const path of paths) {
    all.push(path);
    const real = await realpath(path).catch(() => path);
    if (real !== path) all.push(real);
  }
  return all;
}

async function prepare(
  request: SafeChainProxyRequest,
  deps: SafeChainProxyDeps,
  dipo: readonly string[],
): Promise<SafeChainProxyLayout> {
  // mkdtemp makes the directory 0700 with an unpredictable name; the real path, because the
  // sandbox paths must name the directory itself (`/tmp` is a link on macOS).
  const root = await ensureProxyRoot(deps.root ?? SAFE_CHAIN_PROXY_ROOT);
  const dir = await mkdtemp(`${root}/`);
  const layout = safeChainProxyLayout(dir);
  // The sweep at the next daemon start leaves a proxy alone while this process runs.
  await writeFile(layout.owner, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  for (const path of [
    dirname(layout.binary),
    layout.holders,
    layout.tmp,
    layout.home,
    layout.reports,
    layout.sockets,
  ]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  // A copy, not a link: the sandbox could otherwise reach the maintainer's binary.
  await copyFile(
    `${request.installRoot}/bin/safe-chain`,
    layout.binary,
    constants.COPYFILE_FICLONE,
  );
  await chmod(layout.binary, 0o700);
  for (const ecosystem of SAFE_CHAIN_ECOSYSTEMS) {
    const [manager] = SAFE_CHAIN_HOLDER_COMMANDS[ecosystem];
    await writeFile(`${layout.holders}/${manager}`, holderScript(), { mode: 0o700, flag: "wx" });
  }
  const tools = await resolveTools(deps.platform, request.env["PATH"]);
  const settings = {
    ...safeChainProxyPolicy({
      platform: deps.platform,
      home: request.home,
      uid: request.uid,
      layout,
      dipoReads: await dipoReads(dipo),
      dipoDirs: await systemDipoDirs(deps.platform, request.env),
    }),
    ...(tools.rg === null ? {} : { ripgrep: { command: tools.rg } }),
    ...(deps.platform === "linux" && tools.bwrap !== null ? { bwrapPath: tools.bwrap } : {}),
    ...(deps.platform === "linux" && tools.socat !== null ? { socatPath: tools.socat } : {}),
  };
  await writeFile(layout.policy, `${JSON.stringify(settings, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return layout;
}

async function removeLayout(layout: SafeChainProxyLayout): Promise<void> {
  // Only ever a directory `mkdtemp` made under a root, never anything a bug could name.
  if (!PROXY_DIR_NAME.test(basename(layout.dir)) || dirname(layout.dir) === layout.dir) return;
  await rm(refusalPathFor(layout.policy), { force: true }).catch(() => {});
  await rm(layout.policy, { force: true }).catch(() => {});
  await rm(layout.dir, { recursive: true, force: true }).catch(() => {});
}

/** Reads stdout lines until one parses as the gate's ready report, or the stream ends. */
async function readyLine(
  stream: ReadableStream<Uint8Array>,
): Promise<{ ready: boolean; bundle?: unknown; reason?: unknown } | null> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return null;
    buffer += decoder.decode(value, { stream: true });
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf("\n");
      try {
        const parsed = JSON.parse(line) as { ready?: unknown };
        if (typeof parsed.ready === "boolean") {
          reader.releaseLock();
          return parsed as { ready: boolean };
        }
      } catch {
        // Not the report line.
      }
    }
  }
}

function forward(socketPath: string): Promise<Server> {
  return new Promise((resolveServer, reject) => {
    const server = createServer((client) => {
      const gate = connect(socketPath);
      client.on("error", () => gate.destroy());
      gate.on("error", () => client.destroy());
      client.pipe(gate);
      gate.pipe(client);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveServer(server));
  });
}

function withTimeout<T>(clock: Clock, ms: number, work: Promise<T>, label: string): Promise<T> {
  return new Promise((resolveWork, reject) => {
    const timer = clock.setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    work.then(
      (value) => {
        clock.clearTimeout(timer);
        resolveWork(value);
      },
      (error: unknown) => {
        clock.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** The status of one HTTPS GET through the proxy; the TLS trust is the proxy's CA bundle only. */
async function statusThrough(port: number, ca: string, url: string): Promise<number> {
  const response = await fetch(url, {
    proxy: `http://127.0.0.1:${port}`,
    tls: { ca },
    redirect: "manual",
  } as RequestInit);
  await response.arrayBuffer().catch(() => undefined);
  return response.status;
}

/**
 * Pure: the proxy check's verdict from the three results (a status, or the error's message).
 * Null when the proxy checks installs as it must.
 */
export function proxyCheckProblem(results: {
  readonly allowed: number | string;
  readonly blocked: number | string;
  readonly refused: number | string;
}): string | null {
  if (results.allowed !== 200) {
    return `downloading is-number@7.0.0 through the proxy did not work (${results.allowed})`;
  }
  if (results.blocked !== 403) {
    return `Safe-Chain did not refuse its test package safe-chain-test (${results.blocked}); installs would not be checked`;
  }
  if (results.refused !== 403) {
    return `the gate did not refuse a host that is not a checked registry (${results.refused})`;
  }
  return null;
}

async function check(clock: Clock, port: number, ca: string): Promise<string | null> {
  const attempt = async (url: string): Promise<number | string> => {
    try {
      return await withTimeout(clock, PROXY_CHECK_TIMEOUT_MS, statusThrough(port, ca, url), url);
    } catch (error) {
      return messageOf(error);
    }
  };
  return proxyCheckProblem({
    allowed: await attempt(PROXY_CHECK_ALLOWED_URL),
    blocked: await attempt(PROXY_CHECK_BLOCKED_URL),
    refused: await attempt(PROXY_CHECK_REFUSED_URL),
  });
}

/** Starts one proxy, checks it, and returns it; or the reason it cannot run. */
export async function startSafeChainProxy(
  request: SafeChainProxyRequest,
  deps: SafeChainProxyDeps,
): Promise<SafeChainProxyStart> {
  const dipo = deps.dipo ?? dipoCommand();
  let layout: SafeChainProxyLayout;
  try {
    layout = await prepare(request, deps, dipo);
  } catch (error) {
    return {
      ok: false,
      reason: `the Safe-Chain proxy directory could not be prepared: ${messageOf(error)}`,
    };
  }
  let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    child = Bun.spawn({
      cmd: sandboxExecArgv(
        dipo,
        layout.policy,
        [...dipo, "daemon", "safe-chain-gate", "--dir", layout.dir],
        layout.dir,
      ),
      // Never a directory the sandbox can write: Bun would load its bunfig.toml before srt starts.
      cwd: TRUSTED_CWD,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: layout.home,
        TMPDIR: layout.tmp,
        ...(request.env["LANG"] === undefined ? {} : { LANG: request.env["LANG"] }),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    await removeLayout(layout);
    return { ok: false, reason: `the Safe-Chain proxy did not start: ${messageOf(error)}` };
  }
  let stderr = "";
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) stderr = (stderr + decoder.decode(chunk)).slice(-2_000);
  })().catch(() => {});
  const exited = child.exited.then(() => undefined);
  let server: Server | null = null;
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    server?.close();
    endQuietly(child.stdin);
    // The gate stops when its stdin closes; one that does not gets SIGTERM, then SIGKILL.
    const term = deps.clock.setTimeout(() => child.kill("SIGTERM"), PROXY_STOP_GRACE_MS);
    const kill = deps.clock.setTimeout(() => child.kill("SIGKILL"), 2 * PROXY_STOP_GRACE_MS);
    await exited;
    deps.clock.clearTimeout(term);
    deps.clock.clearTimeout(kill);
    await removeLayout(layout);
  };
  const refuse = async (reason: string): Promise<SafeChainProxyStart> => {
    // The sandbox's refusal first: `stop` removes it with the proxy directory.
    const refusal = await readFile(refusalPathFor(layout.policy), "utf8").catch(() => null);
    await stop();
    const tail = (refusal ?? stderr).trim();
    return {
      ok: false,
      reason: tail === "" ? reason : `${reason}: ${tail.split("\n").slice(-3).join(" ")}`,
    };
  };

  let ready;
  try {
    ready = await withTimeout(
      deps.clock,
      PROXY_READY_TIMEOUT_MS,
      readyLine(child.stdout),
      "the Safe-Chain proxy start",
    );
  } catch (error) {
    return refuse(messageOf(error));
  }
  if (ready === null) {
    const refusal = await readFile(refusalPathFor(layout.policy), "utf8").catch(() => null);
    return refuse(
      refusal === null
        ? "the Safe-Chain proxy stopped before it was ready"
        : "the proxy's sandbox refused to start",
    );
  }
  if (!ready.ready || typeof ready.bundle !== "string") {
    return refuse(
      typeof ready.reason === "string"
        ? ready.reason
        : "the Safe-Chain proxy reported no CA bundle",
    );
  }
  void (async () => {
    // Keep stdout drained; nothing more is expected on it.
    for await (const _ of child.stdout) {
      // Discard.
    }
  })().catch(() => {});
  const bundlePath = ready.bundle;
  if (!bundlePath.startsWith(`${layout.tmp}/`) || bundlePath.includes("/../")) {
    return refuse(
      `the Safe-Chain proxy named a CA bundle outside its temp directory: ${bundlePath}`,
    );
  }
  let ca: string;
  try {
    ca = await readFile(bundlePath, "utf8");
  } catch (error) {
    return refuse(`the Safe-Chain CA bundle could not be read: ${messageOf(error)}`);
  }
  if (!isCertificateBundle(ca)) return refuse("the Safe-Chain CA bundle is not PEM certificates");
  try {
    await mkdir(dirname(request.caFile), { recursive: true, mode: 0o700 });
    await rm(request.caFile, { force: true });
    await writeFile(request.caFile, ca, { flag: "wx", mode: 0o600 });
  } catch (error) {
    return refuse(`the worker's CA bundle could not be written: ${messageOf(error)}`);
  }
  try {
    server = await forward(layout.socket);
  } catch (error) {
    return refuse(`dipo could not open the proxy's local port: ${messageOf(error)}`);
  }
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const problem = await check(deps.clock, port, ca);
  if (problem !== null) return refuse(`the Safe-Chain proxy check failed: ${problem}`);
  return {
    ok: true,
    proxy: { port, dir: layout.dir, caFile: request.caFile, exited, stop },
  };
}
