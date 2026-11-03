// The model proxy (0021, DIPO-269): the one place a box's Claude Code reaches the model. It runs on
// the Mac, listens only on the box network's host address, passes only model requests and adds the
// maintainer's subscription login on the way out, so the token never enters a box. Ported from the
// reviewed probe proxy (tools/box-probe/model-proxy.ts):
//
// - only `POST /v1/messages` and `POST /v1/messages/count_tokens` pass; every other path gets a 404
//   and every other method a 405, and neither is forwarded;
// - every credential the box sends is dropped, with the hop-by-hop headers; the proxy sets
//   `Authorization: Bearer <token>` and adds the OAuth beta to `anthropic-beta`;
// - redirects are never followed: a 3xx goes back to the box as it came, without the token;
// - the token is read from the Keychain once, at start (`token.ts`), and lives only in this
//   proxy's closure. The proxy lends it out only as a `TokenMatcher`, for the post-run check.
//
// The count (0008, DIPO-425): every program in a box that calls the model spends the maintainer's
// subscription here, so the proxy counts it, and that count is the token total the caps, the tier
// budget and the spend alerts read.
//
// - The sender is known only by its peer address: the box-address registry `BoxWorkers` keeps
//   (`ModelUsageLedger.owner`) names the run and agent of the box at that address. A header or a
//   body that names a run is never read. An address no running session owns is refused (403).
// - Before any request goes on, the owner's account is opened (`ModelUsageLedger.open`), a
//   write to the run's records. When the owner cannot be told or the write fails, the request is
//   refused (403, 503) and nothing is forwarded: no token is spent that nobody counts. Once the
//   run's (or the reviewer's) token cap is reached, a new request is refused with 429.
// - The usage of each answer it passes is added to that run as the upstream sends it: the JSON
//   body's `usage`, or a stream's `message_start` usage (input and cache at once) and each later
//   `message_delta` usage over it (their numbers are totals so far, so only the change is added).
//   A stream is read from the upstream at the upstream's pace, whether or not the box reads it, so a
//   box that holds a stream open unread still has what was spent counted; one that goes away ends
//   the upstream stream. A stream cut off counts what arrived. A `count_tokens` request is
//   forwarded and adds nothing.
//
// A box gets only `boxModelEnvironment`: a placeholder key, the proxy's URL and NO_PROXY for its
// address, so Claude Code sends model requests here rather than to the web proxy.

import { isIP } from "node:net";

import { peerAddress } from "../platform/peer";

import type { BoxNetwork } from "./port";
import { BoxError } from "./port";
import {
  readBoxToken,
  type SecretToken,
  type TokenMatcher,
  type TokenReadDeps,
  type TokenScanner,
} from "./token";

/** Where model requests go. */
export const MODEL_UPSTREAM = "https://api.anthropic.com";
/** The only paths passed on: model requests. Account and login endpoints never get the token. */
export const MODEL_PATHS: ReadonlySet<string> = new Set([
  "/v1/messages",
  "/v1/messages/count_tokens",
]);
/** The only method passed on. */
export const MODEL_METHOD = "POST";
/** The beta a subscription token needs on the Messages API, as the probe sent it. */
export const OAUTH_BETA = "oauth-2025-04-20";
/** The largest request body passed on. */
export const MODEL_PROXY_MAX_BODY_BYTES = 64 * 1024 * 1024;
/** The key a box has; it unlocks nothing, the proxy drops it. */
export const BOX_PLACEHOLDER_API_KEY = "dipo-box-placeholder";

/**
 * Request headers never passed on: every credential a box could send, the box's host and the
 * hop-by-hop headers (RFC 9110 section 7.6.1).
 */
export const DROPPED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "cookie",
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Response headers not passed back: the body is re-encoded and re-framed for the box. */
const DROPPED_RESPONSE_HEADERS: readonly string[] = [
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
];

/** The upstream call; `fetch` in the daemon, a fake in tests. */
export type UpstreamFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * One request's handler: `peer` is the address the connection came from, as the listener saw it
 * (an IPv4-mapped form already unmapped), or null when it cannot say.
 */
export type ProxyHandler = (request: Request, peer: string | null) => Promise<Response>;

/** An HTTP listener on one address; `systemListenHttp` in the platform module. */
export type ListenHttp = (options: {
  readonly hostname: string;
  /** 0 lets the system pick a free one. */
  readonly port: number;
  readonly maxRequestBodyBytes: number;
  readonly fetch: ProxyHandler;
}) => ListeningHttp;

/** Who sent a model request: the run and agent of the session whose box has the address. */
export interface ProxyOwner {
  readonly office: string;
  readonly run: string;
  readonly agent: string;
}

/** The tokens of one model answer, as the proxy read them from its `usage`. */
export interface ProxiedUsage {
  /** The model the answer names; the requested one when the answer names none. */
  readonly model: string;
  readonly input: number;
  readonly output: number;
  /** Cache creation, the sum of the two parts below. */
  readonly cacheCreate: number;
  readonly cacheCreate5m: number;
  readonly cacheCreate1h: number;
  readonly cacheRead: number;
}

/**
 * Adds tokens of one answer, as they arrive, to the account `open` opened; throws when it cannot.
 * Each call adds what is new since the one before.
 */
export type ProxyAccount = (usage: ProxiedUsage) => void;

/** Thrown by `ModelUsageLedger.open` when the owner's token cap is reached: the proxy answers 429. */
export class ModelUseCapped extends Error {}

/**
 * Where the proxy counts (DIPO-425): the box-address registry of `BoxWorkers` and the run's usage
 * records. Each may throw; the proxy then refuses the request.
 */
export interface ModelUsageLedger {
  /** The owner of a box address now; null when no running session's box has it. */
  owner(address: string): ProxyOwner | null;
  /**
   * Opens `owner`'s account for one request to `model` (as the request names it): a write that
   * must go through first. Throws `ModelUseCapped` once the owner's token cap is reached.
   */
  open(owner: ProxyOwner, model: string): ProxyAccount;
}

export interface ListeningHttp {
  readonly port: number;
  stop(): Promise<void>;
}

/** The text of a refusal; it names no header and no token. `why` is for dipo's log only. */
function refusal(status: number, text: string, why?: string): Response {
  return new Response(`${text}\n`, {
    status,
    ...(why === undefined ? {} : { statusText: why }),
    headers: { "content-type": "text/plain" },
  });
}

/** `anthropic-beta` with the OAuth beta added once. */
export function withOauthBeta(beta: string | null): string {
  if (beta === null || beta.trim() === "") return OAUTH_BETA;
  const parts = beta.split(",").map((part) => part.trim());
  return parts.includes(OAUTH_BETA) ? beta : `${beta},${OAUTH_BETA}`;
}

/** The headers passed on for one box request: the box's own, without credentials, plus the login. */
export function upstreamHeaders(from: Headers, token: SecretToken): Headers {
  // Headers a box lists in `Connection` are hop-by-hop too.
  const listed = new Set(
    (from.get("connection") ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name !== ""),
  );
  const headers = new Headers();
  from.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (!DROPPED_REQUEST_HEADERS.has(lower) && !listed.has(lower)) headers.set(lower, value);
  });
  headers.set("authorization", `Bearer ${token.reveal()}`);
  headers.set("anthropic-beta", withOauthBeta(from.get("anthropic-beta")));
  return headers;
}

/** True when a box may send `method` to `pathname`. */
export function isModelRequest(method: string, pathname: string): boolean {
  return method === MODEL_METHOD && MODEL_PATHS.has(pathname);
}

/** A non-negative whole count, 0 for anything else. */
function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The usage fields an answer reported so far; each later report replaces what it names. */
type UsageFields = Partial<Record<keyof Omit<ProxiedUsage, "model" | "cacheCreate5m">, number>>;

/** `usage` as the Messages API reports it, the fields it names only. */
function usageFields(usage: unknown): UsageFields | null {
  if (!isRecord(usage)) return null;
  const fields: Record<string, number> = {};
  if ("input_tokens" in usage) fields["input"] = tokens(usage["input_tokens"]);
  if ("output_tokens" in usage) fields["output"] = tokens(usage["output_tokens"]);
  if ("cache_read_input_tokens" in usage)
    fields["cacheRead"] = tokens(usage["cache_read_input_tokens"]);
  if ("cache_creation_input_tokens" in usage) {
    fields["cacheCreate"] = tokens(usage["cache_creation_input_tokens"]);
  }
  // A report without the split keeps the 1 hour share an earlier one gave.
  const split = usage["cache_creation"];
  if (isRecord(split)) fields["cacheCreate1h"] = tokens(split["ephemeral_1h_input_tokens"]);
  return fields;
}

/** What one answer used: its usage fields so far, and the model it names. */
export class UsageMeter {
  #fields: UsageFields = {};
  #model: string | null = null;
  #seen = false;
  #pending = "";
  /** What `take` handed out so far. */
  #taken: ProxiedUsage | null = null;
  readonly #decoder = new TextDecoder();

  constructor(readonly requested: string) {}

  /** True once any usage was read. */
  get seen(): boolean {
    return this.#seen;
  }

  /** A whole JSON answer (`stream: false`). */
  readJson(body: unknown): void {
    if (!isRecord(body)) return;
    if (typeof body["model"] === "string") this.#model = body["model"];
    this.#add(body["usage"]);
  }

  /** The next bytes of a server-sent event stream. */
  push(chunk: Uint8Array): void {
    this.#pending += this.#decoder.decode(chunk, { stream: true });
    const lines = this.#pending.split("\n");
    this.#pending = lines.pop() ?? "";
    for (const line of lines) this.#line(line);
  }

  /** The stream ended or was cut off: a last line without its newline still counts. */
  end(): void {
    this.#pending += this.#decoder.decode();
    if (this.#pending !== "") this.#line(this.#pending);
    this.#pending = "";
  }

  #line(raw: string): void {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.startsWith("data:")) return;
    let event: unknown;
    try {
      event = JSON.parse(line.slice(5));
    } catch {
      return;
    }
    if (!isRecord(event)) return;
    if (event["type"] === "message_start" && isRecord(event["message"])) {
      this.readJson(event["message"]);
    } else if (event["type"] === "message_delta") {
      this.#add(event["usage"]);
    }
  }

  #add(usage: unknown): void {
    const fields = usageFields(usage);
    if (fields === null) return;
    this.#seen = true;
    this.#fields = { ...this.#fields, ...fields };
  }

  /** The tokens read so far. */
  usage(): ProxiedUsage {
    const f = this.#fields;
    const cacheCreate = f.cacheCreate ?? 0;
    const cacheCreate1h = Math.min(cacheCreate, f.cacheCreate1h ?? 0);
    return {
      model: this.#model ?? this.requested,
      input: f.input ?? 0,
      output: f.output ?? 0,
      cacheCreate,
      cacheCreate5m: cacheCreate - cacheCreate1h,
      cacheCreate1h,
      cacheRead: f.cacheRead ?? 0,
    };
  }

  /** What was read since the last `take`, never below 0; null when nothing grew. */
  take(): ProxiedUsage | null {
    const now = this.usage();
    const before = this.#taken;
    const grown = (field: Exclude<keyof ProxiedUsage, "model">): number =>
      Math.max(0, now[field] - (before?.[field] ?? 0));
    const change: ProxiedUsage = {
      model: now.model,
      input: grown("input"),
      output: grown("output"),
      cacheCreate: grown("cacheCreate"),
      cacheCreate5m: grown("cacheCreate5m"),
      cacheCreate1h: grown("cacheCreate1h"),
      cacheRead: grown("cacheRead"),
    };
    this.#taken = {
      model: now.model,
      input: Math.max(now.input, before?.input ?? 0),
      output: Math.max(now.output, before?.output ?? 0),
      cacheCreate: Math.max(now.cacheCreate, before?.cacheCreate ?? 0),
      cacheCreate5m: Math.max(now.cacheCreate5m, before?.cacheCreate5m ?? 0),
      cacheCreate1h: Math.max(now.cacheCreate1h, before?.cacheCreate1h ?? 0),
      cacheRead: Math.max(now.cacheRead, before?.cacheRead ?? 0),
    };
    const grew =
      change.input + change.output + change.cacheCreate + change.cacheRead > 0 ||
      change.cacheCreate5m + change.cacheCreate1h > 0;
    return grew ? change : null;
  }
}

/** The `model` a request body names, or `unknown`; the body is never kept. */
function requestedModel(body: ArrayBuffer): string {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
    if (isRecord(parsed) && typeof parsed["model"] === "string" && parsed["model"] !== "") {
      return parsed["model"].slice(0, 200);
    }
  } catch {
    // Not JSON: the upstream answers it.
  }
  return "unknown";
}

export interface ModelProxyHandlerOptions {
  readonly fetch?: UpstreamFetch;
  /** `MODEL_UPSTREAM` unless a test names a fake. */
  readonly upstream?: string;
  /** One line per request: method, path and status; never a header. */
  readonly log?: (line: string) => void;
  /** A model answer whose usage could not be read or recorded (DIPO-425). */
  readonly warn?: (line: string) => void;
  readonly maxBodyBytes?: number;
}

/** The proxy's request handler, holding `token` and counting into `ledger`. */
export function createModelProxyHandler(
  token: SecretToken,
  ledger: ModelUsageLedger,
  options: ModelProxyHandlerOptions = {},
): ProxyHandler {
  const upstreamFetch: UpstreamFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const upstream = options.upstream ?? MODEL_UPSTREAM;
  const maxBodyBytes = options.maxBodyBytes ?? MODEL_PROXY_MAX_BODY_BYTES;
  const log = options.log ?? (() => {});
  const warn = options.warn ?? log;
  return async (request, peer) => {
    // The parsed path: dot segments are resolved before the check, and only the checked path
    // is sent on, to the fixed upstream; the host the box named is never used.
    const url = new URL(request.url);
    const shown = JSON.stringify(url.pathname.slice(0, 200));
    if (!MODEL_PATHS.has(url.pathname)) {
      log(`${request.method} ${shown} -> 404 (not a model path)`);
      return refusal(404, "not a model path");
    }
    if (!isModelRequest(request.method, url.pathname)) {
      log(`${request.method} ${shown} -> 405 (not ${MODEL_METHOD})`);
      return refusal(405, `only ${MODEL_METHOD}`);
    }
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      log(`${request.method} ${shown} -> 413`);
      return refusal(413, "request too large");
    }
    const body = await request.arrayBuffer();
    if (body.byteLength > maxBodyBytes) {
      log(`${request.method} ${shown} -> 413`);
      return refusal(413, "request too large");
    }
    const requested = requestedModel(body);
    const opened = openAccount(ledger, peer, requested);
    if (opened instanceof Response) {
      log(`${request.method} ${shown} -> ${opened.status} (${opened.statusText})`);
      return opened;
    }
    // Only a model request is counted; a count of tokens spends none.
    const account = url.pathname === "/v1/messages" ? opened.account : null;
    let response: Response;
    try {
      response = await upstreamFetch(`${upstream}${url.pathname}${url.search}`, {
        method: MODEL_METHOD,
        headers: upstreamHeaders(request.headers, token),
        body,
        redirect: "manual",
      });
    } catch {
      // The fetch error is not shown: the box learns only that the model was not reached.
      log(`${request.method} ${shown} -> 502 (upstream unreachable)`);
      return refusal(502, "the model API could not be reached");
    }
    log(`${request.method} ${shown} -> ${response.status}`);
    const headers = new Headers(response.headers);
    for (const name of DROPPED_RESPONSE_HEADERS) headers.delete(name);
    const init = { status: response.status, statusText: response.statusText, headers };
    // Only a model answer carries usage; an error, a redirect or a count goes back as it came.
    if (account === null || response.status < 200 || response.status > 299) {
      return new Response(response.body, init);
    }
    return countedAnswer(response, init, {
      meter: new UsageMeter(requested),
      account,
      warn: (line) => warn(`${request.method} ${shown}${line}`),
    });
  };
}

/**
 * Who sent a request, by the peer address through the registry (DIPO-425), and its owner's
 * account, opened before anything is spent; a refusal when either cannot be had.
 */
function openAccount(
  ledger: ModelUsageLedger,
  peer: string | null,
  model: string,
): Response | { readonly account: ProxyAccount } {
  const address = peerAddress(peer);
  let owner: ProxyOwner | null = null;
  try {
    owner = address === null ? null : ledger.owner(address);
  } catch {
    owner = null;
  }
  if (owner === null) {
    return refusal(
      403,
      "this address runs no session dipo counts",
      "no running session owns the sender",
    );
  }
  try {
    return { account: ledger.open(owner, model) };
  } catch (error) {
    if (error instanceof ModelUseCapped) {
      return refusal(429, "the run's token budget is used up", "the token cap is reached");
    }
    return refusal(
      503,
      "the model use cannot be counted now",
      "the run's usage cannot be recorded",
    );
  }
}

/** A model answer passed back with its usage added to `account`: read whole, or as it streams. */
async function countedAnswer(
  response: Response,
  init: ResponseInit,
  how: {
    readonly meter: UsageMeter;
    readonly account: ProxyAccount;
    readonly warn: (line: string) => void;
  },
): Promise<Response> {
  const { meter, account, warn } = how;
  const streamed = (response.headers.get("content-type") ?? "").includes("text/event-stream");
  if (streamed && response.body !== null) {
    return new Response(meteredStream(response.body, meter, account, warn), init);
  }
  const bytes = await response.arrayBuffer();
  try {
    meter.readJson(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
  } catch {
    // Not JSON: nothing to read, which the warning below says.
  }
  if (!meter.seen) warn(": the answer reported no usage");
  try {
    const change = meter.take();
    if (change !== null) account(change);
  } catch {
    warn(" -> 503 (the answer's usage could not be recorded)");
    return refusal(503, "the model use could not be counted");
  }
  return new Response(bytes, init);
}

/**
 * `body` passed on to the box, read from the upstream at the upstream's pace whatever the box
 * reads, so each change of its usage is added to `account` as it arrives. A box that goes away
 * ends the upstream stream; a count that cannot be recorded ends both, and fails the box's.
 */
function meteredStream(
  body: ReadableStream<Uint8Array>,
  meter: UsageMeter,
  account: ProxyAccount,
  warn: (line: string) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let box: ReadableStreamDefaultController<Uint8Array> | null = null;
  let gone = false;
  const count = (): void => {
    const change = meter.take();
    if (change !== null) account(change);
  };
  const pump = async (): Promise<void> => {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        meter.push(next.value);
        count();
        if (!gone) box?.enqueue(next.value);
      }
      meter.end();
      count();
      if (!meter.seen) warn(": the answer reported no usage");
      if (!gone) box?.close();
    } catch (error) {
      // The upstream was cut, or a count could not be recorded: what arrived counts, if it can.
      try {
        meter.end();
        count();
      } catch {
        warn(": the answer's usage could not be recorded");
      }
      await reader.cancel().catch(() => undefined);
      if (!gone) box?.error(error);
    }
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      box = controller;
      void pump();
    },
    async cancel(reason) {
      gone = true;
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

/** True for one unicast IP address that is not loopback, unspecified or IPv4-mapped. */
function isHostAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return address !== "0.0.0.0" && !address.startsWith("127.");
  if (family !== 6 || address.includes("%")) return false;
  // The URL parser gives the compressed form, so every spelling of `::` and `::1` is caught.
  const canonical = new URL(`http://[${address}]/`).hostname;
  return canonical !== "[::]" && canonical !== "[::1]" && !canonical.startsWith("[::ffff:");
}

/**
 * Refuses a listen address that is not one host address of the box network: not an IP address,
 * every interface, loopback or an IPv4-mapped form. The box network's host address is also
 * reachable from the Mac itself, so this does not keep the Mac's own programs out; it keeps the
 * proxy from listening wider than the box network.
 */
export function checkListenAddress(address: string): string {
  if (!isHostAddress(address)) {
    throw new BoxError(
      "box.refused",
      `the model proxy listens only on the box network's host address, not ${JSON.stringify(address)}.`,
      false,
      { address },
    );
  }
  return address;
}

export interface ModelProxyDeps {
  /** The box network; the proxy listens on its host address only. */
  readonly network: Pick<BoxNetwork, "hostAddress">;
  /** Who sent each request and where its usage is counted (DIPO-425). */
  readonly ledger: ModelUsageLedger;
  /** How the token is read from the Keychain at start. */
  readonly keychain: TokenReadDeps;
  readonly listen: ListenHttp;
  /** 0 (the default) lets the system pick a free port. */
  readonly port?: number;
  readonly fetch?: UpstreamFetch;
  readonly upstream?: string;
  readonly log?: (line: string) => void;
  /** A model answer whose usage could not be read or recorded; `log` without it. */
  readonly warn?: (line: string) => void;
}

/** A running model proxy. It looks for its token on request, but never hands it out. */
export interface RunningModelProxy extends TokenMatcher {
  readonly hostAddress: string;
  readonly port: number;
  /** The base URL a box's Claude Code uses. */
  readonly url: string;
  stop(): Promise<void>;
}

/** `http://<address>:<port>`, with an IPv6 address in brackets. */
export function proxyUrl(hostAddress: string, port: number): string {
  return isIP(hostAddress) === 6
    ? `http://[${hostAddress}]:${port}`
    : `http://${hostAddress}:${port}`;
}

/**
 * Reads the token from the Keychain and starts the proxy on the box network's host address.
 * Fails with the token's code (`token.missing`, `token.invalid`, ...) before it listens.
 */
export async function startModelProxy(deps: ModelProxyDeps): Promise<RunningModelProxy> {
  const hostAddress = checkListenAddress(deps.network.hostAddress);
  const token = await readBoxToken(deps.keychain);
  const handler = createModelProxyHandler(token, deps.ledger, {
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    ...(deps.upstream === undefined ? {} : { upstream: deps.upstream }),
    ...(deps.log === undefined ? {} : { log: deps.log }),
    ...(deps.warn === undefined ? {} : { warn: deps.warn }),
  });
  const listening = deps.listen({
    hostname: hostAddress,
    port: deps.port ?? 0,
    maxRequestBodyBytes: MODEL_PROXY_MAX_BODY_BYTES,
    fetch: handler,
  });
  return {
    hostAddress,
    port: listening.port,
    url: proxyUrl(hostAddress, listening.port),
    scanner: (): TokenScanner => token.scanner(),
    redact: (text: string) => token.redact(text),
    stop: () => listening.stop(),
  };
}

/** The only model variables a box gets: a placeholder key, the proxy's URL and NO_PROXY for it. */
export interface BoxModelEnvironment {
  readonly ANTHROPIC_API_KEY: string;
  readonly ANTHROPIC_BASE_URL: string;
  readonly NO_PROXY: string;
}

/** The box environment of the model route: these three variables and nothing else. */
export function boxModelEnvironment(
  proxy: Pick<RunningModelProxy, "hostAddress" | "port">,
): BoxModelEnvironment {
  return {
    ANTHROPIC_API_KEY: BOX_PLACEHOLDER_API_KEY,
    ANTHROPIC_BASE_URL: proxyUrl(proxy.hostAddress, proxy.port),
    NO_PROXY: proxy.hostAddress,
  };
}
