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
//    a fresh CA, its two processes and their forwarders, then each process loads its malware list
//    through the upstream listener (DIPO-383), which Safe-Chain otherwise does only at the first
//    package it checks; dipo reads the ready line, then the CA bundle (PEM certificates only),
//    which it writes to `caFile` for the boxes. Until then no tunnel goes to the box.
// 6. The web proxy sends registry tunnels to the box, and the check runs through the web proxy
//    itself, with no model: `is-number@7.0.0` downloads, and Safe-Chain's own test package
//    `safe-chain-test` is refused with 403. No box is admitted before it passes, so its requests
//    are the only traffic to the box until then, and Safe-Chain must still run when it ends.
//
// A start that fails once the start script ran says, in its reason, what the Safe-Chain box
// printed and what the upstream listener did (`safeChainFailureDetail`, DIPO-383).
//
// Fail-closed: any step that fails stops what was started (the box deleted, both listeners
// closed) and returns the reason; the caller refuses the box's start. Once started, Safe-Chain ending or
// its box going away makes the route send no more tunnels to it, so installs fail closed, and
// `onRoute` hears of it. `stop` deletes the box, so it
// lives exactly as long as the route. A Safe-Chain box a killed daemon left is deleted at the next
// daemon start (`BoxWorkers.finishEnded`).
//
// Its refusals (DIPO-376): each Safe-Chain process writes its log file in the box as it goes
// (`safeChainLogFile`). `markSafeChain` counts each log's lines when a session starts, and
// `readSafeChain` reads the refusals among the lines each gained when it ends; a log that cannot be
// read then is unknown. Both read the box's clock against the Mac's, and the read keeps only the
// refusals the session's own box asked for, by their time and the web proxy's registry tunnels
// (`refusalsOfBox`, DIPO-396); one whose box cannot be told is unknown. The box workers keep both
// on the run (`BoxWorkers.sessionEnded`).

import { mkdir, rm, writeFile } from "node:fs/promises";
import { connect as tlsConnect } from "node:tls";
import { dirname } from "node:path";

import type { Clock } from "@dipsaus-orchestrator/contract";

import { ignoreRejection } from "../platform/background";
import type {
  SafeChainEcosystem,
  SafeChainFound,
  SafeChainRefusal,
  SafeChainUnknown,
} from "../prompts/safe-chain";
import { connectToBox } from "./box-connect";
import { cleanDoorText } from "./door";
import { type BoxImageDeps, ensureSafeChainImage } from "./build-box";
import { type BoxNetwork, type BoxPort, type BoxProcess, boxName } from "./port";
import {
  boxClockOffset,
  type ClockOffset,
  isCertificateBundle,
  refusalsOfBox,
  SAFE_CHAIN_BOX_PORTS,
  SAFE_CHAIN_BOX_RUN_PREFIX,
  SAFE_CHAIN_LOAD_SECONDS_ENV,
  SAFE_CHAIN_RUN_DIR,
  SAFE_CHAIN_ECOSYSTEMS,
  SAFE_CHAIN_REFUSAL_LINES,
  SAFE_CHAIN_START_SCRIPT,
  SAFE_CHAIN_TMP_DIR,
  type SafeChainMark,
  safeChainLogFile,
  safeChainRefusalsOf,
  sessionClockOffset,
} from "./safe-chain";
import {
  admittedUrl,
  BoxAdmissions,
  type BoxWebProxyDeps,
  RegistryTunnels,
  type BoxWebRouteStart,
  type RunningBoxWebProxy,
  type RunningBoxWebRoute,
  type SafeChainTarget,
  startBoxWebProxy,
  startSafeChainUpstreamProxy,
  type WebProxyEvent,
} from "./web-proxy";

/** How long the Safe-Chain box may take to report ready (both processes load their lists). */
export const SAFE_CHAIN_READY_TIMEOUT_MS = 180_000;
/**
 * How much of that wait the start script leaves after its deadline for loading the malware lists
 * (`SAFE_CHAIN_LOAD_SECONDS_ENV`): its last load request and its ready line.
 */
const SAFE_CHAIN_LOAD_MARGIN_MS = 20_000;

/** The start script's deadline for loading the malware lists, in seconds from its start. */
export function safeChainLoadSeconds(readyTimeoutMs: number): number {
  return Math.max(1, Math.floor((readyTimeoutMs - SAFE_CHAIN_LOAD_MARGIN_MS) / 1_000));
}
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
/**
 * The most lines a failed start's reason carries, its first included: after it, the Safe-Chain box's
 * last output and the upstream listener's events (DIPO-383), so the cause is readable without
 * debug logs.
 */
export const SAFE_CHAIN_FAILURE_LINES = 40;
/** The most upstream listener events a failed start's reason shows; the box's output takes the rest. */
const FAILURE_EVENT_LINES = 15;
/** The most characters of one line of a failed start's reason. */
const FAILURE_LINE_MAX = 200;
/** How many lines of each Safe-Chain process's log a failed start reads from the box. */
const SAFE_CHAIN_LOG_LINES = 20;
/** How long reading those logs from the box may take. */
const SAFE_CHAIN_LOG_TIMEOUT_MS = 10_000;

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
  /**
   * Tests only: the Safe-Chain image's tag in place of the machine-wide `safeChainImageTag()`, so
   * a real-box test can remove and rebuild an image of its own (DIPO-383). dipo never passes it.
   */
  readonly imageTag?: string;
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

/**
 * Reads stdout lines until one parses as the start script's ready line, or the stream ends; `into`
 * hears all of it.
 */
export async function readReadyLine(
  stream: ReadableStream<Uint8Array>,
  into?: (text: string) => void,
): Promise<ReadyLine | null> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return null;
    const text = decoder.decode(value, { stream: true });
    into?.(text);
    buffer += text;
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
 * its tunnel. Only the status inside TLS counts: a tunnel the proxy refuses (any status but 200)
 * rejects, so the proxy's own 403 can never pass for Safe-Chain's refusal. The connection is
 * closed when the attempt ends, also when it ran out of time (`SAFE_CHAIN_CHECK_TIMEOUT_MS`).
 */
export function proxiedStatus(
  proxy: { readonly host: string; readonly port: number },
  hostAddress: string,
  ca: string,
  url: string,
  clock: Clock,
): Promise<number> {
  const target = new URL(url);
  return new Promise((resolveStatus, reject) => {
    const socket = connectToBox({ address: proxy.host, port: proxy.port, hostAddress });
    let head = "";
    const timer = clock.setTimeout(
      () => fail(new Error(`${url} timed out`)),
      SAFE_CHAIN_CHECK_TIMEOUT_MS,
    );
    const fail = (error: Error) => {
      clock.clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const done = (status: number) => {
      clock.clearTimeout(timer);
      socket.destroy();
      resolveStatus(status);
    };
    socket.once("error", fail);
    socket.once("close", () => fail(new Error("the web proxy closed the connection")));
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
        fail(new Error(`the web proxy refused the tunnel (${tunnel ?? "no status"})`));
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
        done(status);
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

/** One line of a failed start's reason: cleaned of control characters, cut to one line's length. */
function failureLine(text: string): string {
  return cleanDoorText(text).replaceAll(/\s+/g, " ").trim().slice(0, FAILURE_LINE_MAX);
}

/**
 * Pure: what a failed start's reason carries after its first line (DIPO-383), so that the whole
 * reason has at most SAFE_CHAIN_FAILURE_LINES lines: the upstream listener's last events (at most
 * 15, or none), and the Safe-Chain box's last output lines in the rest. Empty when there is no box.
 */
export function safeChainFailureDetail(input: {
  readonly box: string | null;
  /** What the Safe-Chain box printed: its start script and the logs of its two processes. */
  readonly output: string;
  readonly events: readonly WebProxyEvent[];
}): string {
  if (input.box === null) return "";
  const events = input.events
    .slice(-FAILURE_EVENT_LINES)
    .map((event) => `  ${failureLine(JSON.stringify(event))}`);
  const eventLines =
    events.length === 0
      ? ["the upstream listener's events: none"]
      : [
          `the upstream listener's events (last ${events.length} of ${input.events.length}):`,
          ...events,
        ];
  // The reason's first line and the output's heading take one line each.
  const room = SAFE_CHAIN_FAILURE_LINES - 1 - eventLines.length - 1;
  const output = input.output
    .split("\n")
    .map(failureLine)
    .filter((line) => line.length > 0)
    .slice(-room)
    .map((line) => `  ${line}`);
  const outputLines =
    output.length === 0
      ? [`the Safe-Chain box ${input.box} printed nothing`]
      : [`the Safe-Chain box ${input.box} printed (last ${output.length} lines):`, ...output];
  return [...outputLines, ...eventLines].join("\n");
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
  /** The start script's last output, both streams (DIPO-383). */
  output: string;
  /** The upstream listener's events so far, the last ones kept (DIPO-383). */
  readonly upstreamEvents: WebProxyEvent[];
}

/** How many characters of the start script's output a route keeps. */
const OUTPUT_KEPT = 8_000;
/** How many upstream listener events a route keeps. */
const EVENTS_KEPT = 100;

/**
 * What a failed start's reason carries after its first line (`safeChainFailureDetail`): the
 * start script's output, the logs of Safe-Chain's two processes read from the box, and the
 * upstream listener's events. Empty before the start script ran.
 */
async function failureDetail(deps: SafeChainRouteDeps, started: Started): Promise<string> {
  if (started.box === null || started.process === null) return "";
  const box = started.box;
  const logs = await deps.boxes
    .exec(
      box,
      [
        "tail",
        "-n",
        String(SAFE_CHAIN_LOG_LINES),
        `${SAFE_CHAIN_RUN_DIR}/npm.log`,
        `${SAFE_CHAIN_RUN_DIR}/pypi.log`,
      ],
      { timeoutMs: SAFE_CHAIN_LOG_TIMEOUT_MS },
    )
    .then(
      (read) => `${read.stdout}\n${read.stderr}`,
      (error: unknown) => `the Safe-Chain logs could not be read: ${messageOf(error)}`,
    );
  return safeChainFailureDetail({
    box,
    output: `${started.output}\n${logs}`,
    events: started.upstreamEvents,
  });
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
  const image = await ensureSafeChainImage(
    {
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
    },
    deps.imageTag,
  );
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
  const readyTimeoutMs = deps.readyTimeoutMs ?? SAFE_CHAIN_READY_TIMEOUT_MS;
  const process = boxes.execLive(name, [SAFE_CHAIN_START_SCRIPT], {
    env: {
      HTTPS_PROXY: upstream.url,
      [SAFE_CHAIN_LOAD_SECONDS_ENV]: String(safeChainLoadSeconds(readyTimeoutMs)),
    },
  });
  started.process = process;
  // Both streams go to the failure's detail only (`safeChainFailureDetail`), which caps them.
  const keep = (text: string) => (started.output = (started.output + text).slice(-OUTPUT_KEPT));
  drain(process.stderr, keep);
  const ready = await withTimeout(
    deps.clock,
    readyTimeoutMs,
    readReadyLine(process.stdout, keep),
    "the Safe-Chain box's start",
  );
  drain(process.stdout, keep);
  const bundle = ready?.ready === true && typeof ready.bundle === "string" ? ready.bundle : null;
  if (bundle === null) {
    const why = typeof ready?.reason === "string" ? ready.reason : "it stopped before it was ready";
    throw new Error(`Safe-Chain did not start in its box: ${failureLine(why)}`);
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
    output: "",
    upstreamEvents: [],
  };
  let target: SafeChainTarget | null = null;
  let source: string | null = null;
  const admissions = new BoxAdmissions();
  const tunnels = new RegistryTunnels(proxyDeps.clock);
  try {
    const proxy = await startBoxWebProxy(
      { network, safeChain: () => target, admissions, tunnels },
      proxyDeps,
    );
    started.proxy = proxy;
    const upstream = await startSafeChainUpstreamProxy(
      { network, source: () => source },
      {
        ...proxyDeps,
        onEvent: (event) => {
          started.upstreamEvents.push(event);
          if (started.upstreamEvents.length > EVENTS_KEPT) started.upstreamEvents.shift();
          proxyDeps.onEvent?.(event);
        },
      },
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
        ? proxiedStatus(proxy, network.hostAddress, box.ca, url, deps.clock)
        : deps.download(proxy.url, box.ca, url),
    );
    if (problem !== null) throw new Error(`the Safe-Chain check failed: ${problem}`);
    // Fail-closed: a Safe-Chain that ended while it was checked never passes (DIPO-383).
    if (target === null) throw new Error("the Safe-Chain check failed: Safe-Chain ended during it");
  } catch (error) {
    const detail = await failureDetail(deps, started);
    await stopStarted(deps, started);
    const reason = `the box web route did not start: ${messageOf(error)}`;
    return { ok: false, reason: detail === "" ? reason : `${reason}\n${detail}` };
  }
  return { ok: true, route: running(deps, started, admissions, tunnels) };
}

/** The started route as the boxes use it; `stop` ends all of it, the Safe-Chain box included. */
function running(
  deps: SafeChainRouteDeps,
  started: Started,
  admissions: BoxAdmissions,
  tunnels: RegistryTunnels,
): RunningBoxWebRoute {
  const proxy = started.proxy as RunningBoxWebProxy;
  let stopping: Promise<void> | null = null;
  return {
    host: proxy.host,
    port: proxy.port,
    url: proxy.url,
    caFile: deps.caFile,
    admit: (box, ports) => admittedUrl(proxy.url, admissions.admit(box, ports)),
    tunnels,
    stop() {
      stopping ??= stopStarted(deps, started);
      return stopping;
    },
  };
}

/**
 * How long one count or read of a Safe-Chain log in its box may take. A session's start and its end
 * each make one per log (two), so neither waits more than about 8 seconds; past it the log is
 * unknown.
 */
export const SAFE_CHAIN_LOG_READ_TIMEOUT_MS = 4_000;
/** The exit of `READ_REFUSALS` for a log shorter than at the session's start: cut or replaced. */
const LOG_SHRANK = 4;

/** Prints the box's clock as one line `clock <seconds>.<nanoseconds>` (DIPO-396). */
const PRINT_CLOCK = `printf 'clock %s\\n' "$(date -u +%s.%N)"`;
/** Prints the box's clock, then the complete lines of the log `$1`; exit 3 when it is not there. */
const COUNT_LINES = `[ -r "$1" ] || exit 3; ${PRINT_CLOCK}; wc -l < "$1"`;
/**
 * Prints the box's clock, then the lines of the log `$1` after its first `$2` lines (the mark)
 * that hold either refusal line (`$3`, `$4`); exit 3 when it is not there to read, `LOG_SHRANK`
 * when it holds fewer lines than the mark (it was cut or replaced, so `tail` would print nothing),
 * grep's 2 when grep failed.
 */
const READ_REFUSALS = [
  '[ -r "$1" ] || exit 3',
  'n=$(wc -l < "$1") || exit 3',
  `[ "$n" -ge "$2" ] || exit ${LOG_SHRANK}`,
  PRINT_CLOCK,
  'tail -n "+$(($2 + 1))" -- "$1" | grep -F -e "$3" -e "$4"; [ "$?" -le 1 ]',
].join("; ");

/** One command in the Safe-Chain box: its exit, its output after the clock line, and the clock. */
async function execTimed(
  boxes: Pick<BoxPort, "exec">,
  box: string,
  clock: Pick<Clock, "now">,
  command: readonly [string, ...string[]],
): Promise<{
  readonly code: number | null;
  readonly rest: string;
  readonly clock: ClockOffset | null;
  /** The Mac's time the command ended. */
  readonly after: number;
}> {
  const before = clock.now();
  const got = await boxes.exec(box, command, { timeoutMs: SAFE_CHAIN_LOG_READ_TIMEOUT_MS });
  const after = clock.now();
  const end = got.stdout.indexOf("\n");
  const first = end === -1 ? got.stdout : got.stdout.slice(0, end);
  if (!first.startsWith("clock ")) return { code: got.code, rest: got.stdout, clock: null, after };
  return {
    code: got.code,
    rest: end === -1 ? "" : got.stdout.slice(end + 1),
    clock: boxClockOffset(first.slice("clock ".length), before, after),
    after,
  };
}

/**
 * Where a session starts in the Safe-Chain logs of box `box` (DIPO-376): the complete lines each log
 * holds now; null for a log that cannot be read. With the box's clock against the Mac's `clock`
 * (DIPO-396), the narrowest range a count bounds it to, and the Mac's time the mark began; both
 * null when no count could read the clock. Never rejects.
 */
export async function markSafeChain(
  boxes: Pick<BoxPort, "exec">,
  box: string | null,
  clock: Pick<Clock, "now">,
): Promise<SafeChainMark> {
  const lines: Record<SafeChainEcosystem, number | null> = { npm: null, pypi: null };
  let offset: ClockOffset | null = null;
  if (box === null) return { box, lines, clock: offset, markedAt: null };
  // Before its first count: every line the session reads was written after it.
  const markedAt = clock.now();
  for (const ecosystem of SAFE_CHAIN_ECOSYSTEMS) {
    try {
      const got = await execTimed(boxes, box, clock, [
        "sh",
        "-c",
        COUNT_LINES,
        "sh",
        safeChainLogFile(ecosystem),
      ]);
      const count = Number(got.rest.trim());
      if (got.code === 0 && got.rest.trim() !== "" && Number.isSafeInteger(count) && count >= 0) {
        lines[ecosystem] = count;
      }
      if (got.clock !== null && (offset === null || width(got.clock) < width(offset))) {
        offset = got.clock;
      }
    } catch {
      // Unknown: the end of the session says so.
    }
  }
  return { box, lines, clock: offset, markedAt: offset === null ? null : markedAt };
}

function width(offset: ClockOffset): number {
  return offset.high - offset.low;
}

/** Whose refusals `readSafeChain` reads (DIPO-396). */
export interface SafeChainReader {
  /** The Mac's clock, the one `tunnels` keeps its times by. */
  readonly clock: Pick<Clock, "now">;
  /** The box of the session: only the refusals it asked for are its. */
  readonly client: string;
  /** The web route's registry tunnels; null when none runs, so no refusal is tied to a box. */
  readonly tunnels: Pick<RegistryTunnels, "during"> | null;
}

/**
 * The refusals of one session (DIPO-376): the lines each Safe-Chain log of box `box` gained since
 * `mark`, of which only those the session's own box asked for (`reader`, DIPO-396); a refusal
 * another box asked for is left out, and one whose box cannot be told is unknown. A log is unknown,
 * never empty, when the session's start could not count it, when the Safe-Chain box is another
 * than at its start (the route started again, so its logs are gone), or when it cannot be read now.
 * Never rejects.
 */
export async function readSafeChain(
  boxes: Pick<BoxPort, "exec">,
  box: string | null,
  mark: SafeChainMark,
  reader: SafeChainReader,
): Promise<SafeChainFound> {
  const refusals: SafeChainRefusal[] = [];
  const unknown: SafeChainUnknown[] = [];
  for (const ecosystem of SAFE_CHAIN_ECOSYSTEMS) {
    const from = mark.lines[ecosystem];
    if (mark.box === null || from === null) {
      unknown.push({
        ecosystem,
        why: "its Safe-Chain log could not be read when the session started",
      });
      continue;
    }
    if (box !== mark.box) {
      unknown.push({
        ecosystem,
        why: "the Safe-Chain box it ran with is gone, and its log with it",
      });
      continue;
    }
    let got: Awaited<ReturnType<typeof execTimed>>;
    try {
      got = await execTimed(boxes, box, reader.clock, [
        "sh",
        "-c",
        READ_REFUSALS,
        "sh",
        safeChainLogFile(ecosystem),
        String(from),
        SAFE_CHAIN_REFUSAL_LINES.blocking,
        SAFE_CHAIN_REFUSAL_LINES.malware,
      ]);
    } catch (error) {
      unknown.push({ ecosystem, why: `its Safe-Chain log could not be read: ${messageOf(error)}` });
      continue;
    }
    if (got.code === LOG_SHRANK) {
      unknown.push({
        ecosystem,
        why: "its Safe-Chain log holds fewer lines than when the session started, so it was cut or replaced",
      });
      continue;
    }
    if (got.code !== 0) {
      unknown.push({
        ecosystem,
        why: `its Safe-Chain log could not be read (exit ${got.code ?? "none"})`,
      });
      continue;
    }
    const tunnels = reader.tunnels;
    const own = refusalsOfBox(
      safeChainRefusalsOf(ecosystem, got.rest),
      reader.client,
      sessionClockOffset(mark, { clock: got.clock, at: got.after }),
      (of, start, end) => tunnels?.during(of, start, end) ?? { kind: "forgotten" },
    );
    refusals.push(...own.refusals);
    unknown.push(...own.unknown);
  }
  return { refusals, unknown };
}
