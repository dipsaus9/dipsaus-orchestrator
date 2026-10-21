// The model proxy (0021 section 4 and its amendment of 2026-10-21, DIPO-269): the one place a
// box's Claude Code reaches the model. It runs on the Mac, listens only on the box network's host
// address, passes only model requests and adds the maintainer's subscription login on the way out,
// so the token never enters a box. Ported from the reviewed probe proxy
// (tools/box-probe/model-proxy.ts):
//
// - only `POST /v1/messages` and `POST /v1/messages/count_tokens` pass; every other path gets a 404
//   and every other method a 405, and neither is forwarded;
// - every credential the box sends is dropped, with the hop-by-hop headers; the proxy sets
//   `Authorization: Bearer <token>` and adds the OAuth beta to `anthropic-beta`;
// - redirects are never followed: a 3xx goes back to the box as it came, without the token;
// - the token is read from the Keychain once, at start (`token.ts`), and lives only in this
//   proxy's closure. The proxy lends it out only as a `TokenMatcher`, for the post-run check.
//
// A box gets only `boxModelEnvironment`: a placeholder key, the proxy's URL and NO_PROXY for its
// address, so Claude Code sends model requests here rather than to the web proxy.

import { isIP } from "node:net";

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

/** An HTTP listener on one address; `systemListenHttp` in the platform module. */
export type ListenHttp = (options: {
  readonly hostname: string;
  /** 0 lets the system pick a free one. */
  readonly port: number;
  readonly maxRequestBodyBytes: number;
  readonly fetch: (request: Request) => Promise<Response>;
}) => ListeningHttp;

export interface ListeningHttp {
  readonly port: number;
  stop(): Promise<void>;
}

/** The text of a refusal; it names no header and no token. */
function refusal(status: number, text: string): Response {
  return new Response(`${text}\n`, { status, headers: { "content-type": "text/plain" } });
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

export interface ModelProxyHandlerOptions {
  readonly fetch?: UpstreamFetch;
  /** `MODEL_UPSTREAM` unless a test names a fake. */
  readonly upstream?: string;
  /** One line per request: method, path and status; never a header. */
  readonly log?: (line: string) => void;
  readonly maxBodyBytes?: number;
}

/** The proxy's request handler, holding `token`. */
export function createModelProxyHandler(
  token: SecretToken,
  options: ModelProxyHandlerOptions = {},
): (request: Request) => Promise<Response> {
  const upstreamFetch: UpstreamFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const upstream = options.upstream ?? MODEL_UPSTREAM;
  const maxBodyBytes = options.maxBodyBytes ?? MODEL_PROXY_MAX_BODY_BYTES;
  const log = options.log ?? (() => {});
  return async (request) => {
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
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
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
  /** How the token is read from the Keychain at start. */
  readonly keychain: TokenReadDeps;
  readonly listen: ListenHttp;
  /** 0 (the default) lets the system pick a free port. */
  readonly port?: number;
  readonly fetch?: UpstreamFetch;
  readonly upstream?: string;
  readonly log?: (line: string) => void;
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
  const handler = createModelProxyHandler(token, {
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    ...(deps.upstream === undefined ? {} : { upstream: deps.upstream }),
    ...(deps.log === undefined ? {} : { log: deps.log }),
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
