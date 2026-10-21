// The model proxy (DIPO-269): the path rule, the header handling, no redirect following, the
// listen address, the start that reads the token from a fake `security`, and the box environment.
// The upstream is a fake fetch, or a local test server where a real fetch must show it does not
// follow a redirect.

import { afterEach, describe, expect, it } from "bun:test";

import { ManualClock } from "@dipsaus-orchestrator/testkit";

import {
  BOX_PLACEHOLDER_API_KEY,
  boxModelEnvironment,
  checkListenAddress,
  createModelProxyHandler,
  type ListenHttp,
  MODEL_UPSTREAM,
  OAUTH_BETA,
  startModelProxy,
  type UpstreamFetch,
  withOauthBeta,
} from "../../src/box/model-proxy";
import { BoxError } from "../../src/box/port";
import { SecretToken } from "../../src/box/token";
import { type FakeContainer, fakeContainer } from "./fake-container";

const TOKEN_TEXT = "fake-box-login-for-tests-0123456789";
const TOKEN = new SecretToken(TOKEN_TEXT);
const HOST = "192.0.2.1";

interface Forwarded {
  readonly url: string;
  readonly init: RequestInit;
}

function fakeUpstream(response: () => Response = () => new Response("{}", { status: 200 })): {
  fetch: UpstreamFetch;
  calls: Forwarded[];
} {
  const calls: Forwarded[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return response();
    },
  };
}

function boxRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`http://${HOST}:4000${path}`, { method: "POST", body: "{}", ...init });
}

function headersOf(call: Forwarded | undefined): Headers {
  if (call === undefined) throw new Error("nothing was forwarded");
  return call.init.headers as Headers;
}

describe("the path rule", () => {
  it("passes the two model paths, with their query, to the fixed upstream", async () => {
    const upstream = fakeUpstream();
    const handle = createModelProxyHandler(TOKEN, { fetch: upstream.fetch });
    expect((await handle(boxRequest("/v1/messages?beta=true"))).status).toBe(200);
    expect((await handle(boxRequest("/v1/messages/count_tokens"))).status).toBe(200);
    expect(upstream.calls.map((call) => call.url)).toEqual([
      `${MODEL_UPSTREAM}/v1/messages?beta=true`,
      `${MODEL_UPSTREAM}/v1/messages/count_tokens`,
    ]);
  });

  it("answers every other path with 404 and forwards nothing", async () => {
    const upstream = fakeUpstream();
    const handle = createModelProxyHandler(TOKEN, { fetch: upstream.fetch });
    for (const path of [
      "/",
      "/v1/messages/",
      "/v1/messages/batches",
      "/v1/messages/count_tokens/x",
      "/v1/models",
      "/v1/oauth/token",
      "/api/oauth/profile",
      "/v1/messages/../oauth/token",
      "/v1/messages/%2e%2e/oauth/token",
      "/v1/messages%2Fcount_tokens",
      "/V1/MESSAGES",
      "//v1/messages",
    ]) {
      const response = await handle(boxRequest(path));
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(TOKEN_TEXT);
    }
    expect(upstream.calls).toEqual([]);
  });

  it("answers another method on a model path with 405 and forwards nothing", async () => {
    const upstream = fakeUpstream();
    const handle = createModelProxyHandler(TOKEN, { fetch: upstream.fetch });
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const init: RequestInit = method === "GET" ? { method } : { method, body: "{}" };
      expect((await handle(boxRequest("/v1/messages", init))).status).toBe(405);
    }
    expect(upstream.calls).toEqual([]);
  });

  it("sends the request to the fixed upstream whatever host the box names", async () => {
    const upstream = fakeUpstream();
    const handle = createModelProxyHandler(TOKEN, { fetch: upstream.fetch });
    await handle(
      new Request("http://elsewhere.example/v1/messages", { method: "POST", body: "{}" }),
    );
    expect(upstream.calls[0]?.url).toBe(`${MODEL_UPSTREAM}/v1/messages`);
  });

  it("refuses a body over the limit without forwarding it", async () => {
    const upstream = fakeUpstream();
    const handle = createModelProxyHandler(TOKEN, { fetch: upstream.fetch, maxBodyBytes: 8 });
    expect((await handle(boxRequest("/v1/messages", { body: "0123456789" }))).status).toBe(413);
    expect(upstream.calls).toEqual([]);
  });
});

describe("the headers", () => {
  it("drops every credential the box sends and adds the Bearer login and the OAuth beta", async () => {
    const upstream = fakeUpstream();
    const handle = createModelProxyHandler(TOKEN, { fetch: upstream.fetch });
    await handle(
      boxRequest("/v1/messages", {
        headers: {
          "x-api-key": BOX_PLACEHOLDER_API_KEY,
          authorization: "Bearer box-made-this-up",
          "proxy-authorization": "Basic Ym94OmJveA==",
          cookie: "session=box",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "x-stainless-lang": "js",
        },
      }),
    );
    const headers = headersOf(upstream.calls[0]);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN_TEXT}`);
    expect(headers.get("anthropic-beta")).toBe(OAUTH_BETA);
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("proxy-authorization")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("host")).toBeNull();
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-stainless-lang")).toBe("js");
    expect(upstream.calls[0]?.init.method).toBe("POST");
  });

  it("drops the hop-by-hop headers and the ones the box lists in Connection", async () => {
    const upstream = fakeUpstream();
    const handle = createModelProxyHandler(TOKEN, { fetch: upstream.fetch });
    await handle(
      boxRequest("/v1/messages", {
        headers: {
          connection: "keep-alive, x-smuggled",
          "keep-alive": "timeout=5",
          "x-smuggled": "1",
          upgrade: "websocket",
          te: "trailers",
        },
      }),
    );
    const headers = headersOf(upstream.calls[0]);
    for (const name of ["connection", "keep-alive", "x-smuggled", "upgrade", "te"]) {
      expect(headers.get(name)).toBeNull();
    }
  });

  it("adds the OAuth beta once to the betas the box asks for", () => {
    expect(withOauthBeta(null)).toBe(OAUTH_BETA);
    expect(withOauthBeta("")).toBe(OAUTH_BETA);
    expect(withOauthBeta("claude-code-20250219")).toBe(`claude-code-20250219,${OAUTH_BETA}`);
    expect(withOauthBeta(`a, ${OAUTH_BETA}`)).toBe(`a, ${OAUTH_BETA}`);
  });

  it("passes the answer back, streamed, without its encoding, length or cookies", async () => {
    const upstream = fakeUpstream(
      () =>
        new Response("event: message_start\n\n", {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "content-encoding": "gzip",
            "content-length": "999",
            "set-cookie": "a=b",
            "request-id": "req_1",
          },
        }),
    );
    const handle = createModelProxyHandler(TOKEN, { fetch: upstream.fetch });
    const response = await handle(boxRequest("/v1/messages"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("event: message_start\n\n");
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("request-id")).toBe("req_1");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).not.toBe("999");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("answers 502 without the error when the upstream cannot be reached", async () => {
    const lines: string[] = [];
    const handle = createModelProxyHandler(TOKEN, {
      fetch: async () => {
        throw new Error(`connect failed with Bearer ${TOKEN_TEXT}`);
      },
      log: (line) => lines.push(line),
    });
    const response = await handle(boxRequest("/v1/messages"));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(TOKEN_TEXT);
    expect(lines.join("\n")).not.toContain(TOKEN_TEXT);
  });

  it("logs method, path and status only", async () => {
    const lines: string[] = [];
    const upstream = fakeUpstream();
    const handle = createModelProxyHandler(TOKEN, {
      fetch: upstream.fetch,
      log: (l) => lines.push(l),
    });
    await handle(boxRequest("/v1/messages"));
    await handle(boxRequest("/v1/models"));
    expect(lines).toEqual([
      'POST "/v1/messages" -> 200',
      'POST "/v1/models" -> 404 (not a model path)',
    ]);
  });
});

describe("redirects", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  afterEach(async () => {
    await server?.stop(true);
    server = undefined;
  });

  it("asks fetch not to follow them", async () => {
    const upstream = fakeUpstream();
    const handle = createModelProxyHandler(TOKEN, { fetch: upstream.fetch });
    await handle(boxRequest("/v1/messages"));
    expect(upstream.calls[0]?.init.redirect).toBe("manual");
  });

  it("returns an upstream redirect to the box and never requests its target", async () => {
    const hits: { path: string; authorization: string | null }[] = [];
    server = Bun.serve({
      hostname: "localhost",
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname;
        hits.push({ path, authorization: request.headers.get("authorization") });
        if (path === "/v1/messages") {
          return new Response(null, { status: 307, headers: { location: "/v1/oauth/steal" } });
        }
        if (path === "/v1/messages/count_tokens") {
          return new Response(null, { status: 302, headers: { location: "/elsewhere" } });
        }
        return new Response("followed", { status: 200 });
      },
    });
    const origin = new URL(server.url).origin;
    const handle = createModelProxyHandler(TOKEN, { upstream: origin });

    const first = await handle(boxRequest("/v1/messages", { headers: { "x-api-key": "box" } }));
    expect(first.status).toBe(307);
    expect(first.headers.get("location")).toBe("/v1/oauth/steal");
    const second = await handle(boxRequest("/v1/messages/count_tokens"));
    expect(second.status).toBe(302);

    expect(hits).toEqual([
      { path: "/v1/messages", authorization: `Bearer ${TOKEN_TEXT}` },
      { path: "/v1/messages/count_tokens", authorization: `Bearer ${TOKEN_TEXT}` },
    ]);
  });
});

describe("the listen address", () => {
  it("accepts a host address of the box network", () => {
    expect(checkListenAddress("192.0.2.1")).toBe("192.0.2.1");
    expect(checkListenAddress("2001:db8::1")).toBe("2001:db8::1");
  });

  it("refuses every interface, loopback, names and mapped addresses", () => {
    for (const address of [
      "",
      "0.0.0.0",
      "::",
      "0:0:0:0:0:0:0:0",
      "127.0.0.1",
      "127.1.2.3",
      "::1",
      "0:0:0:0:0:0:0:1",
      "::ffff:127.0.0.1",
      "::ffff:192.0.2.1",
      "fe80::1%en0",
      "localhost",
      "box.example",
      "*",
    ]) {
      expect(() => checkListenAddress(address)).toThrow(BoxError);
    }
  });
});

/** A fake `security` that prints the token for a read; every argv is kept for the argv check. */
function fakeSecurity(): FakeContainer {
  return fakeContainer((args) =>
    args[0] === "find-generic-password" ? { stdout: `${TOKEN_TEXT}\n` } : undefined,
  );
}

function fakeListen(): {
  listen: ListenHttp;
  seen: { hostname: string; port: number }[];
  stopped: number[];
} {
  const seen: { hostname: string; port: number }[] = [];
  const stopped: number[] = [];
  return {
    seen,
    stopped,
    listen: (options) => {
      seen.push({ hostname: options.hostname, port: options.port });
      return { port: 4100, stop: async () => void stopped.push(4100) };
    },
  };
}

describe("startModelProxy", () => {
  it("reads the token once from the Keychain and listens only on the host address", async () => {
    const security = fakeSecurity();
    const listening = fakeListen();
    const proxy = await startModelProxy({
      network: { hostAddress: HOST },
      keychain: { spawn: security.spawn, clock: new ManualClock(), env: { PATH: "/usr/bin:/bin" } },
      listen: listening.listen,
    });
    expect(listening.seen).toEqual([{ hostname: HOST, port: 0 }]);
    expect(proxy.url).toBe(`http://${HOST}:4100`);
    expect(security.args()).toEqual([
      ["find-generic-password", "-s", "dipo", "-a", "box-login", "-w"],
    ]);
    for (const call of security.calls) expect(call.cmd.join(" ")).not.toContain(TOKEN_TEXT);
    // The proxy never hands out its token, but can say whether text holds it.
    expect(JSON.stringify(proxy)).not.toContain(TOKEN_TEXT);
    expect(proxy.redact(`a ${TOKEN_TEXT} b`)).toBe("a [box login] b");
    const scanner = proxy.scanner();
    scanner.push(new TextEncoder().encode(`x${TOKEN_TEXT}y`));
    expect(scanner.found).toBe(true);
    await proxy.stop();
    expect(listening.stopped).toEqual([4100]);
  });

  it("refuses a wildcard address before it reads the Keychain", async () => {
    const security = fakeSecurity();
    const listening = fakeListen();
    await expect(
      startModelProxy({
        network: { hostAddress: "0.0.0.0" },
        keychain: { spawn: security.spawn, clock: new ManualClock(), env: {} },
        listen: listening.listen,
      }),
    ).rejects.toThrow(BoxError);
    expect(security.calls).toEqual([]);
    expect(listening.seen).toEqual([]);
  });

  it("does not listen without a token", async () => {
    const missing = fakeContainer(() => ({
      code: 44,
      stderr: "The specified item could not be found in the keychain.\n",
    }));
    const listening = fakeListen();
    const error = await startModelProxy({
      network: { hostAddress: HOST },
      keychain: { spawn: missing.spawn, clock: new ManualClock(), env: {} },
      listen: listening.listen,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BoxError);
    expect((error as BoxError).code).toBe("token.missing");
    expect(listening.seen).toEqual([]);
  });
});

describe("boxModelEnvironment", () => {
  it("gives a box only a placeholder key, the proxy's URL and NO_PROXY for its address", () => {
    const env = boxModelEnvironment({ hostAddress: HOST, port: 4100 });
    expect(env).toEqual({
      ANTHROPIC_API_KEY: BOX_PLACEHOLDER_API_KEY,
      ANTHROPIC_BASE_URL: `http://${HOST}:4100`,
      NO_PROXY: HOST,
    });
    expect(Object.keys(env).toSorted()).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "NO_PROXY",
    ]);
    expect(JSON.stringify(env)).not.toContain(TOKEN_TEXT);
  });

  it("brackets an IPv6 host address in the URL only", () => {
    const env = boxModelEnvironment({ hostAddress: "2001:db8::1", port: 4100 });
    expect(env.ANTHROPIC_BASE_URL).toBe("http://[2001:db8::1]:4100");
    expect(env.NO_PROXY).toBe("2001:db8::1");
  });
});
