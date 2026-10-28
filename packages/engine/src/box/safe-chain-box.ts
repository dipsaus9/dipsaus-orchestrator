// dipo's web route with Safe-Chain in a box of its own (DIPO-343; 0004, 0008). It replaces the
// Safe-Chain proxy that ran on the Mac in an `srt` sandbox behind a gate (DIPO-84). One route per
// box network, started with the first box that uses it and stopped with the last (`BoxWebRoute`):
//
// 1. The web proxy on the box network's host address (`startBoxWebProxy`). Until step 6 every
//    registry tunnel is refused, since no Safe-Chain runs yet.
// 2. The upstream listener (`startSafeChainUpstreamProxy`), which takes connections only from the
//    Safe-Chain box and reaches only the hosts Safe-Chain checks and its malware lists.
// 3. The machine-wide Safe-Chain image, reused or built (`ensureSafeChainImage`) in a build box
//    through the web proxy: it needs no registry, so no Safe-Chain.
// 4. The Safe-Chain box, `dipo-safe-chain-<id>`, made from that image with its box network tools,
//    started, and its firewall set: out only to the upstream listener, in only from the Mac's
//    address on `SAFE_CHAIN_BOX_PORTS`. So no other box reaches it directly.
// 5. The start script runs in it as the box user (`safeChainStartScript`): a fresh Safe-Chain with
//    a fresh CA, its two processes and their forwarders; dipo reads the ready line, then the CA
//    bundle (PEM certificates only), which it writes to `caFile` for the boxes.
// 6. The web proxy sends registry tunnels to the box, and the check runs through the web proxy
//    itself, with no model: `is-number@7.0.0` downloads, and Safe-Chain's own test package
//    `safe-chain-test` is refused with 403.
//
// Fail-closed: any step that fails stops what was started (the box deleted, both listeners
// closed) and returns the reason; the caller refuses the box's start. Once started, Safe-Chain ending or
// its box going away makes the route send no more tunnels to it, so installs fail closed, and
// `onRoute` hears of it. `stop` deletes the box, so it
// lives exactly as long as the route. A Safe-Chain box a killed daemon left is deleted at the next
// daemon start (`BoxWorkers.finishEnded`).

import { mkdir, rm, writeFile } from "node:fs/promises";
import { connect as tlsConnect } from "node:tls";
import { dirname } from "node:path";

import type { Clock } from "@dipsaus-orchestrator/contract";

import { ignoreRejection } from "../platform/background";
import { connectToBox } from "./box-connect";
import { type BoxImageDeps, ensureSafeChainImage } from "./build-box";
import { type BoxNetwork, type BoxPort, type BoxProcess, boxName } from "./port";
import {
  isCertificateBundle,
  SAFE_CHAIN_BOX_PORTS,
  SAFE_CHAIN_BOX_RUN_PREFIX,
  SAFE_CHAIN_START_SCRIPT,
  SAFE_CHAIN_TMP_DIR,
} from "./safe-chain";
import {
  admittedUrl,
  BoxAdmissions,
  type BoxWebProxyDeps,
  type BoxWebRouteStart,
  type RunningBoxWebProxy,
  type RunningBoxWebRoute,
  type SafeChainTarget,
  startBoxWebProxy,
  startSafeChainUpstreamProxy,
} from "./web-proxy";

/** How long the Safe-Chain box may take to report ready (both processes fetch their lists). */
export const SAFE_CHAIN_READY_TIMEOUT_MS = 180_000;
/** How long one request of the Safe-Chain check may take. */
export const SAFE_CHAIN_CHECK_TIMEOUT_MS = 30_000;
/** The Safe-Chain check's downloads: one allowed small package and Safe-Chain's own test malware. */
export const SAFE_CHAIN_CHECK_ALLOWED_URL =
  "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz";
export const SAFE_CHAIN_CHECK_BLOCKED_URL =
  "https://registry.npmjs.org/safe-chain-test/-/safe-chain-test-0.0.1-security.tgz";
/** How many times the allowed download may be tried before it counts as failed (DIPO-211). */
export const SAFE_CHAIN_CHECK_ATTEMPTS = 3;
/** Time on the clock between two tries of the allowed download. */
export const SAFE_CHAIN_CHECK_RETRY_DELAY_MS = 2_000;

/** The box calls the route makes for the Safe-Chain box and its image. */
export type SafeChainBoxes = BoxImageDeps["boxes"] & Pick<BoxPort, "address">;

export interface SafeChainRouteDeps {
  readonly boxes: SafeChainBoxes;
  readonly clock: Clock;
  /** dipo's private folder for build folders (the image's build). */
  readonly scratchRoot: string;
  /** dipo's root of the box network tools. */
  readonly toolsRoot: string;
  /** Where the Safe-Chain CA bundle is written on the Mac, for the boxes. */
  readonly caFile: string;
  /** The Safe-Chain box's id; random by default. Told before the box exists. */
  readonly boxId?: () => string;
  /** The Safe-Chain image build box's id; random by default. Told before the box exists. */
  readonly buildId?: () => string;
  readonly onEvent?: BoxImageDeps["onEvent"];
  /** What happened to a running route's Safe-Chain box that dipo must hear of (the daemon logs it). */
  readonly onRoute?: (event: SafeChainRouteEvent) => void;
  /**
   * One HTTPS GET of the check through the web proxy at `proxyUrl`, trusting `ca` only; its status.
   * A CONNECT and TLS from the box network's host address by default; tests pass their own.
   */
  readonly download?: (proxyUrl: string, ca: string, url: string) => Promise<number>;
  /** Overrides `SAFE_CHAIN_READY_TIMEOUT_MS`. */
  readonly readyTimeoutMs?: number;
  /**
   * Tests and the escape probe only: told the Safe-Chain box, its address and the upstream
   * listener once the box is ready, so they can try to reach them. dipo never passes it.
   */
  readonly onSafeChain?: (box: SafeChainBoxInfo) => void;
}

/** What happened to the Safe-Chain box of a route, outside its start's own result. */
export type SafeChainRouteEvent =
  /**
   * Safe-Chain's start script ended, or its box went away, while the route ran: from then on the
   * route sends no tunnel to it, so every registry install fails (fail-closed).
   */
  | { readonly kind: "safeChainEnded"; readonly box: string; readonly code: number | null }
  /** The Safe-Chain box could not be deleted when the route stopped or failed to start. */
  | { readonly kind: "safeChainDeleteFailed"; readonly box: string; readonly reason: string };

/** The Safe-Chain box of a started route, for tests and the escape probe. */
export interface SafeChainBoxInfo {
  readonly name: string;
  readonly address: string;
  readonly upstreamUrl: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/** What the start script printed: ready with its CA bundle, or why not. */
type ReadyLine = { readonly ready: boolean; readonly bundle?: unknown; readonly reason?: unknown };

/** Reads stdout lines until one parses as the start script's ready line, or the stream ends. */
export async function readReadyLine(stream: ReadableStream<Uint8Array>): Promise<ReadyLine | null> {
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
          return parsed as ReadyLine;
        }
      } catch {
        // Not the ready line.
      }
    }
  }
}

/** Keeps a stream drained, so the box's process never blocks on a full pipe. */
function drain(stream: ReadableStream<Uint8Array>, into?: (text: string) => void): void {
  const decoder = new TextDecoder();
  ignoreRejection(
    (async () => {
      for await (const chunk of stream) into?.(decoder.decode(chunk, { stream: true }));
    })(),
  );
}

/** The status code of the first HTTP status line in `text`, or null before it is whole. */
function statusOf(text: string): number | null {
  const line = /^HTTP\/1\.[01] (\d{3})[^\r\n]*\r\n/.exec(text);
  return line === null ? null : Number(line[1]);
}

/**
 * The status of one HTTPS GET through the web proxy, as a box makes it: a CONNECT tunnel, then TLS
 * that trusts the CA bundle only. The connection to the proxy leaves from the box network's host
 * address (`connectToBox`), since the proxy listens there and a VPN may route the box subnet into
 * its tunnel. A refused tunnel answers with the proxy's own status.
 */
function proxiedStatus(
  proxy: { readonly host: string; readonly port: number },
  hostAddress: string,
  ca: string,
  url: string,
): Promise<number> {
  const target = new URL(url);
  return new Promise((resolveStatus, reject) => {
    const socket = connectToBox({ address: proxy.host, port: proxy.port, hostAddress });
    let head = "";
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.once("error", fail);
    socket.once("connect", () =>
      socket.write(
        `CONNECT ${target.hostname}:443 HTTP/1.1\r\nHost: ${target.hostname}:443\r\n\r\n`,
      ),
    );
    const onHead = (chunk: Buffer) => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      socket.off("data", onHead);
      const tunnel = statusOf(head);
      if (tunnel !== 200) {
        socket.destroy();
        resolveStatus(tunnel ?? 0);
        return;
      }
      const secure = tlsConnect({ socket, servername: target.hostname, ca });
      let answer = "";
      secure.once("error", fail);
      secure.once("secureConnect", () =>
        secure.write(
          `GET ${target.pathname} HTTP/1.1\r\nHost: ${target.hostname}\r\nConnection: close\r\n\r\n`,
        ),
      );
      secure.on("data", (data: Buffer) => {
        answer += data.toString("latin1");
        const status = statusOf(answer);
        if (status === null) return;
        secure.destroy();
        resolveStatus(status);
      });
    };
    socket.on("data", onHead);
  });
}

/**
 * Pure: the Safe-Chain check's verdict from its two results (a status, or the error's message).
 * Null when Safe-Chain checks installs as it must.
 */
export function safeChainCheckProblem(results: {
  /** The last try of the allowed download. */
  readonly allowed: number | string;
  /** How many tries of the allowed download were made. */
  readonly attempts: number;
  readonly blocked: number | string;
}): string | null {
  if (results.allowed !== 200) {
    const tries = results.attempts === 1 ? "attempt" : "attempts";
    return `downloading is-number@7.0.0 through Safe-Chain did not work after ${results.attempts} ${tries} (${results.allowed})`;
  }
  if (results.blocked !== 403) {
    return `Safe-Chain did not refuse its test package safe-chain-test (${results.blocked}); installs would not be checked`;
  }
  return null;
}

/** One download of the check, with its timeout: the status, or the error's message. */
async function attemptOnce(
  clock: Clock,
  download: (url: string) => Promise<number>,
  url: string,
): Promise<number | string> {
  try {
    return await withTimeout(clock, SAFE_CHAIN_CHECK_TIMEOUT_MS, download(url), url);
  } catch (error) {
    return messageOf(error);
  }
}

/**
 * The Safe-Chain check: the allowed download is tried up to SAFE_CHAIN_CHECK_ATTEMPTS times, the
 * retry waiting SAFE_CHAIN_CHECK_RETRY_DELAY_MS on the clock (DIPO-211); the blocked download is
 * tried once, since a pass for it is Safe-Chain failing its check.
 */
export async function runSafeChainCheck(
  clock: Clock,
  download: (url: string) => Promise<number>,
): Promise<string | null> {
  let allowed: number | string = "";
  let attempts = 0;
  while (attempts < SAFE_CHAIN_CHECK_ATTEMPTS) {
    if (attempts > 0) {
      await new Promise<void>((resolveWait) =>
        clock.setTimeout(resolveWait, SAFE_CHAIN_CHECK_RETRY_DELAY_MS),
      );
    }
    attempts += 1;
    allowed = await attemptOnce(clock, download, SAFE_CHAIN_CHECK_ALLOWED_URL);
    if (allowed === 200) break;
  }
  return safeChainCheckProblem({
    allowed,
    attempts,
    blocked: await attemptOnce(clock, download, SAFE_CHAIN_CHECK_BLOCKED_URL),
  });
}

/** What a started route holds, so a failure or `stop` ends exactly what was started. */
interface Started {
  proxy: RunningBoxWebProxy | null;
  upstream: RunningBoxWebProxy | null;
  box: string | null;
  process: BoxProcess | null;
  /** Set once the route stops (or its start failed): the end of Safe-Chain is then expected. */
  stopping: boolean;
}

async function stopStarted(deps: SafeChainRouteDeps, started: Started): Promise<void> {
  started.stopping = true;
  started.process?.kill("SIGKILL");
  const box = started.box;
  if (box !== null) {
    await deps.boxes.delete(box).catch((error: unknown) => {
      deps.onRoute?.({ kind: "safeChainDeleteFailed", box, reason: messageOf(error) });
    });
  }
  await started.proxy?.stop().catch(() => undefined);
  await started.upstream?.stop().catch(() => undefined);
  await rm(deps.caFile, { force: true }).catch(() => undefined);
}

/**
 * Steps 3 to 5 of the file comment: the image, the box with its firewall, the start script, and
 * the CA bundle written to `caFile`. Returns the box's target; throws with the reason.
 */
async function startSafeChainBox(
  deps: SafeChainRouteDeps,
  network: BoxNetwork,
  started: Started,
  listeners: { readonly proxy: RunningBoxWebProxy; readonly upstream: RunningBoxWebProxy },
  setSource: (address: string) => void,
): Promise<{ target: SafeChainTarget; ca: string }> {
  const { boxes } = deps;
  const { proxy, upstream } = listeners;
  const image = await ensureSafeChainImage({
    boxes,
    route: {
      acquire: async () => ({ url: proxy.url, caFile: null }),
      release: async () => {},
    },
    scratchRoot: deps.scratchRoot,
    toolsRoot: deps.toolsRoot,
    clock: deps.clock,
    ...(deps.buildId === undefined ? {} : { buildId: deps.buildId }),
    ...(deps.onEvent === undefined ? {} : { onEvent: deps.onEvent }),
  });
  const id = deps.boxId?.() ?? crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const runId = `${SAFE_CHAIN_BOX_RUN_PREFIX}${id}`;
  started.box = boxName(runId);
  const name = started.box;
  await boxes.create({ runId, image: image.tag, network, netTools: image.netTools });
  await boxes.start(name);
  await boxes.firewall(name, {
    hostAddress: network.hostAddress,
    ports: [upstream.port],
    inbound: Object.values(SAFE_CHAIN_BOX_PORTS),
  });
  const address = await boxes.address(name);
  if (address === null) throw new Error("the Safe-Chain box has no address on the box network");
  setSource(address);
  const process = boxes.execLive(name, [SAFE_CHAIN_START_SCRIPT], {
    env: { HTTPS_PROXY: upstream.url },
  });
  started.process = process;
  let stderr = "";
  drain(process.stderr, (text) => (stderr = (stderr + text).slice(-2_000)));
  const ready = await withTimeout(
    deps.clock,
    deps.readyTimeoutMs ?? SAFE_CHAIN_READY_TIMEOUT_MS,
    readReadyLine(process.stdout),
    "the Safe-Chain box's start",
  );
  drain(process.stdout);
  const bundle = ready?.ready === true && typeof ready.bundle === "string" ? ready.bundle : null;
  if (bundle === null) {
    const why = typeof ready?.reason === "string" ? ready.reason : "it stopped before it was ready";
    throw new Error(`Safe-Chain did not start in its box: ${why} ${stderr.trim()}`.trim());
  }
  if (!bundle.startsWith(`${SAFE_CHAIN_TMP_DIR}/`) || bundle.includes("/../")) {
    throw new Error(`Safe-Chain named a CA bundle outside its temp folder: ${bundle}`);
  }
  const read = await boxes.exec(name, ["cat", "--", bundle]);
  if (read.code !== 0 || !isCertificateBundle(read.stdout)) {
    throw new Error("the Safe-Chain CA bundle is not PEM certificates");
  }
  await mkdir(dirname(deps.caFile), { recursive: true, mode: 0o700 });
  await rm(deps.caFile, { force: true });
  await writeFile(deps.caFile, read.stdout, { flag: "wx", mode: 0o600 });
  return { target: { address, ports: SAFE_CHAIN_BOX_PORTS }, ca: read.stdout };
}

/**
 * Starts dipo's web route on `network` with Safe-Chain in its box behind it (file comment), and
 * checks it; `stop` stops the listeners and deletes the box. Fail-closed: what started is stopped
 * and the reason returned when any step fails.
 */
export async function startBoxWebRoute(
  network: BoxNetwork,
  deps: SafeChainRouteDeps,
  proxyDeps: BoxWebProxyDeps,
): Promise<BoxWebRouteStart> {
  const started: Started = {
    proxy: null,
    upstream: null,
    box: null,
    process: null,
    stopping: false,
  };
  let target: SafeChainTarget | null = null;
  let source: string | null = null;
  const admissions = new BoxAdmissions();
  try {
    const proxy = await startBoxWebProxy(
      { network, safeChain: () => target, admissions },
      proxyDeps,
    );
    started.proxy = proxy;
    const upstream = await startSafeChainUpstreamProxy(
      { network, source: () => source },
      proxyDeps,
    );
    started.upstream = upstream;
    const box = await startSafeChainBox(deps, network, started, { proxy, upstream }, (address) => {
      source = address;
    });
    target = box.target;
    // Safe-Chain ending, or its box going away, ends the start script's exec: from then on no
    // tunnel goes to the box, and no connection is taken as the box's (DIPO-343, fail-closed).
    const watched = started.process;
    void watched?.exited.then(
      (exit) => {
        if (started.stopping) return;
        target = null;
        source = null;
        deps.onRoute?.({ kind: "safeChainEnded", box: started.box ?? "", code: exit.code });
      },
      () => {
        target = null;
        source = null;
      },
    );
    deps.onSafeChain?.({
      name: started.box ?? "",
      address: box.target.address,
      upstreamUrl: upstream.url,
    });
    const problem = await runSafeChainCheck(deps.clock, (url) =>
      deps.download === undefined
        ? proxiedStatus(proxy, network.hostAddress, box.ca, url)
        : deps.download(proxy.url, box.ca, url),
    );
    if (problem !== null) throw new Error(`the Safe-Chain check failed: ${problem}`);
  } catch (error) {
    await stopStarted(deps, started);
    return { ok: false, reason: `the box web route did not start: ${messageOf(error)}` };
  }
  return { ok: true, route: running(deps, started, admissions) };
}

/** The started route as the boxes use it; `stop` ends all of it, the Safe-Chain box included. */
function running(
  deps: SafeChainRouteDeps,
  started: Started,
  admissions: BoxAdmissions,
): RunningBoxWebRoute {
  const proxy = started.proxy as RunningBoxWebProxy;
  let stopping: Promise<void> | null = null;
  return {
    host: proxy.host,
    port: proxy.port,
    url: proxy.url,
    caFile: deps.caFile,
    admit: (box, ports) => admittedUrl(proxy.url, admissions.admit(box, ports)),
    stop() {
      stopping ??= stopStarted(deps, started);
      return stopping;
    },
  };
}
