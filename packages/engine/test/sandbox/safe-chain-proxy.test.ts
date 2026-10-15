// dipo's Safe-Chain checking proxy (DIPO-84): the gate's rule, the holder report, the proxy's own
// sandbox policy, the worker's cache and CA variables, the proxy check's verdict, the per-run
// registry, and the gate on real local sockets (a fake Safe-Chain behind it, no network).

import { describe, expect, it } from "bun:test";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { systemClock } from "../../src/platform/clock";
import { handleGateConnection } from "../../src/platform/safe-chain-gate";
import { proxyCheckProblem } from "../../src/platform/safe-chain-proxy";
import { SafeChainProxies, type SafeChainProxyHandle } from "../../src/sandbox/safe-chain-proxies";
import {
  ecosystemOf,
  gateDecision,
  holderScript,
  isCertificateBundle,
  parseHolderReport,
  safeChainProxyLayout,
  safeChainProxyPolicy,
  SAFE_CHAIN_PROXY_HOSTS,
  workerCacheEnv,
  workerCaEnv,
} from "../../src/sandbox/safe-chain-proxy";

const DIR = "/private/tmp/dipo-p-abc123";
const LAYOUT = safeChainProxyLayout(DIR);

describe("(unit) the gate's rule", () => {
  it("passes only CONNECT to a registry Safe-Chain checks, on 443", () => {
    expect(gateDecision("CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: x")).toEqual({
      ok: true,
      ecosystem: "npm",
      host: "registry.npmjs.org",
      port: 443,
    });
    expect(gateDecision("CONNECT Registry.Yarnpkg.com:443 HTTP/1.1")).toMatchObject({
      ok: true,
      ecosystem: "npm",
      host: "registry.yarnpkg.com",
    });
    expect(gateDecision("CONNECT pypi.org:443 HTTP/1.1")).toMatchObject({ ecosystem: "pypi" });
    expect(gateDecision("CONNECT files.pythonhosted.org:443 HTTP/1.0")).toMatchObject({
      ecosystem: "pypi",
    });
  });

  it("refuses plain HTTP, other hosts, local addresses and other ports", () => {
    for (const [head, status, reason] of [
      ["GET http://127.0.0.1:6420/ HTTP/1.1", 403, "GET is refused"],
      ["GET http://registry.npmjs.org/is-number HTTP/1.1", 403, "only CONNECT"],
      ["CONNECT example.com:443 HTTP/1.1", 403, "not a registry"],
      ["CONNECT 127.0.0.1:6420 HTTP/1.1", 403, "not a registry"],
      ["CONNECT localhost:443 HTTP/1.1", 403, "not a registry"],
      ["CONNECT malware-list.aikido.dev:443 HTTP/1.1", 403, "not a registry"],
      ["CONNECT registry.npmjs.org.evil.com:443 HTTP/1.1", 403, "not a registry"],
      ["CONNECT registry.npmjs.org:80 HTTP/1.1", 403, "only 443"],
      ["CONNECT [::1]:443 HTTP/1.1", 400, "bad CONNECT target"],
      ["CONNECT registry.npmjs.org HTTP/1.1", 400, "bad CONNECT target"],
      ["hello", 400, "not an HTTP/1 request line"],
    ] as const) {
      const decision = gateDecision(head);
      expect(decision).toMatchObject({ ok: false, status });
      expect((decision as { reason: string }).reason).toContain(reason);
    }
    expect(ecosystemOf("example.com")).toBeNull();
  });
});

describe("(unit) the holder", () => {
  it("reports Safe-Chain's proxy and CA bundle, then waits on stdin", () => {
    const script = holderScript();
    expect(script).toStartWith("#!/bin/sh\n");
    expect(script).toContain('report="$DIPO_SAFE_CHAIN_REPORT"');
    expect(script).toContain('"$HTTPS_PROXY" "$NODE_EXTRA_CA_CERTS"');
    expect(script).toContain('mv "$report.tmp" "$report"');
    expect(script).toEndWith("exec cat > /dev/null\n");
  });

  it("accepts only a loopback port and a bundle in the proxy's temp directory", () => {
    const bundle = `${LAYOUT.tmp}/safe-chain-ca-bundle-1.pem`;
    expect(parseHolderReport(`http://127.0.0.1:50556\n${bundle}\n`, LAYOUT)).toEqual({
      port: 50556,
      bundle,
    });
    for (const text of [
      `http://10.0.0.1:50556\n${bundle}\n`,
      `http://127.0.0.1:0\n${bundle}\n`,
      `http://127.0.0.1:70000\n${bundle}\n`,
      `http://127.0.0.1:50556\n/etc/passwd\n`,
      `http://127.0.0.1:50556\n${LAYOUT.tmp}/../../etc/passwd\n`,
      `\n\n`,
    ]) {
      expect(parseHolderReport(text, LAYOUT)).toBeNull();
    }
  });
});

describe("(unit) the proxy's own sandbox", () => {
  const policy = safeChainProxyPolicy({
    platform: "darwin",
    home: "/Users/maintainer",
    uid: 501,
    layout: LAYOUT,
    dipoReads: ["/Users/maintainer/.local/bin/dipo"],
    dipoDirs: ["/Users/maintainer/Library/Application Support/dipo"],
  });

  it("reaches only the registries and Aikido's malware list, and may listen locally", () => {
    expect(policy.network).toEqual({
      allowedDomains: [
        "registry.npmjs.org",
        "registry.yarnpkg.com",
        "pypi.org",
        "files.pythonhosted.org",
        "malware-list.aikido.dev",
      ],
      deniedDomains: [],
      strictAllowlist: true,
      allowLocalBinding: true,
      allowUnixSockets: [`${DIR}/sock`],
    });
    expect(SAFE_CHAIN_PROXY_HOSTS).toEqual(policy.network.allowedDomains);
  });

  it("reads nothing of the home directory but the dipo binary, and writes only its own dirs", () => {
    expect(policy.filesystem.denyRead).toContain("/Users/maintainer");
    expect(policy.filesystem.denyRead).toContain("/run/user/501");
    expect(policy.filesystem.allowRead).toEqual([DIR, "/Users/maintainer/.local/bin/dipo"]);
    expect(policy.filesystem.allowWrite).toEqual([
      `${DIR}/sc`,
      `${DIR}/tmp`,
      `${DIR}/home`,
      `${DIR}/out`,
      `${DIR}/sock`,
    ]);
    // The holder directory is on the proxy's PATH: never writable. The copied binary neither.
    expect(policy.filesystem.allowWrite).not.toContain(LAYOUT.holders);
    expect(policy.filesystem.denyWrite).toEqual([`${DIR}/sc/bin`]);
    expect(JSON.stringify(policy)).not.toContain(".safe-chain");
  });

  it("allows Unix sockets as a whole on Linux, where seccomp cannot filter by path", () => {
    const linux = safeChainProxyPolicy({
      platform: "linux",
      home: "/home/maintainer",
      uid: 1000,
      layout: LAYOUT,
      dipoReads: [],
      dipoDirs: [],
    });
    expect(linux.network.allowAllUnixSockets).toBe(true);
    expect(linux.network.allowUnixSockets).toBeUndefined();
  });

  it("keeps the socket path short enough for macOS", () => {
    expect(safeChainProxyLayout("/private/tmp/dipo-p-AbCdEf").socket.length).toBeLessThan(100);
  });
});

describe("(unit) the worker's variables", () => {
  it("puts every install cache in the run temp directory", () => {
    expect(workerCacheEnv("/tmp/dipo-run-1")).toEqual({
      BUN_INSTALL_CACHE_DIR: "/tmp/dipo-run-1/caches/bun",
      npm_config_cache: "/tmp/dipo-run-1/caches/npm",
      YARN_CACHE_FOLDER: "/tmp/dipo-run-1/caches/yarn",
      PIP_CACHE_DIR: "/tmp/dipo-run-1/caches/pip",
      XDG_CACHE_HOME: "/tmp/dipo-run-1/caches/xdg-cache",
      XDG_DATA_HOME: "/tmp/dipo-run-1/caches/xdg-data",
    });
  });

  it("points Node, Bun, pip and OpenSSL at the proxy's CA bundle", () => {
    expect(workerCaEnv("/r/safe-chain/ca.pem")).toEqual({
      NODE_EXTRA_CA_CERTS: "/r/safe-chain/ca.pem",
      SSL_CERT_FILE: "/r/safe-chain/ca.pem",
      REQUESTS_CA_BUNDLE: "/r/safe-chain/ca.pem",
      PIP_CERT: "/r/safe-chain/ca.pem",
    });
  });

  it("copies a CA bundle only when it is PEM certificates and comments", () => {
    const cert =
      "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIBATAKBggqhkjOPQQDAjA=\n-----END CERTIFICATE-----";
    expect(isCertificateBundle(`${cert}\n`)).toBe(true);
    expect(isCertificateBundle(`# Issuer: CN=Root\n${cert}\n\n${cert}\n`)).toBe(true);
    expect(isCertificateBundle("")).toBe(false);
    expect(isCertificateBundle(`${cert}\nexport X=1\n`)).toBe(false);
    expect(
      isCertificateBundle("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n"),
    ).toBe(false);
  });
});

describe("(unit) the proxy check's verdict", () => {
  it("passes only when the package downloads, the test malware is refused and the gate refuses", () => {
    expect(proxyCheckProblem({ allowed: 200, blocked: 403, refused: 403 })).toBeNull();
    expect(proxyCheckProblem({ allowed: 502, blocked: 403, refused: 403 })).toContain(
      "is-number@7.0.0",
    );
    expect(proxyCheckProblem({ allowed: "timed out", blocked: 403, refused: 403 })).toContain(
      "timed out",
    );
    expect(proxyCheckProblem({ allowed: 200, blocked: 200, refused: 403 })).toContain(
      "would not be checked",
    );
    expect(proxyCheckProblem({ allowed: 200, blocked: 403, refused: 200 })).toContain(
      "did not refuse",
    );
    expect(proxyCheckProblem({ allowed: 200, blocked: 403, refused: "socket closed" })).toContain(
      "did not refuse",
    );
  });
});

function handle(
  port: number,
  dir = "/private/tmp/dipo-p-1",
): SafeChainProxyHandle & {
  stops: number;
  exit(): void;
} {
  let exit!: () => void;
  const exited = new Promise<void>((resolve) => {
    exit = resolve;
  });
  const proxy = {
    port,
    dir,
    exited,
    stops: 0,
    exit,
    stop: async () => {
      proxy.stops += 1;
    },
  };
  return proxy;
}

describe("(unit) the runs' proxies", () => {
  it("starts one proxy per run, replacing an earlier one, and stops it when asked", async () => {
    const clock = new ManualClock();
    const made: ReturnType<typeof handle>[] = [];
    const proxies = new SafeChainProxies({
      clock,
      start: async () => {
        const proxy = handle(50_000 + made.length);
        made.push(proxy);
        return { ok: true, proxy };
      },
    });
    const first = await proxies.start("run_1", "/r/ca.pem");
    expect(first).toMatchObject({ ok: true });
    expect(proxies.get("run_1")?.port).toBe(50_000);
    await proxies.start("run_1", "/r/ca.pem");
    expect(made[0]?.stops).toBe(1);
    expect(proxies.get("run_1")?.port).toBe(50_001);
    await proxies.stop("run_1");
    expect(made[1]?.stops).toBe(1);
    expect(proxies.get("run_1")).toBeUndefined();
  });

  it("stops a proxy whose worker host never started, and keeps one whose host did", async () => {
    const clock = new ManualClock();
    const made: ReturnType<typeof handle>[] = [];
    const proxies = new SafeChainProxies({
      clock,
      attachMs: 1_000,
      start: async () => {
        const proxy = handle(50_000);
        made.push(proxy);
        return { ok: true, proxy };
      },
    });
    await proxies.start("run_1", "/r/ca.pem");
    await proxies.start("run_2", "/r/ca.pem");
    proxies.awaitHost("run_1");
    proxies.awaitHost("run_2");
    proxies.hostStarted("run_2");
    clock.advance(1_000);
    await Promise.resolve();
    expect(made[0]?.stops).toBe(1);
    expect(proxies.get("run_1")).toBeUndefined();
    expect(made[1]?.stops).toBe(0);
    expect(proxies.get("run_2")).toBeDefined();
  });

  it("forgets a proxy whose gate exited, warns, and stops all at shutdown", async () => {
    const clock = new ManualClock();
    const warnings: string[] = [];
    const made: ReturnType<typeof handle>[] = [];
    const proxies = new SafeChainProxies({
      clock,
      start: async () => {
        const proxy = handle(50_000 + made.length);
        made.push(proxy);
        return { ok: true, proxy };
      },
      warn: (message) => warnings.push(message),
    });
    await proxies.start("run_1", "/r/ca.pem");
    await proxies.start("run_2", "/r/ca.pem");
    made[0]?.exit();
    await made[0]?.exited;
    await Promise.resolve();
    expect(proxies.get("run_1")).toBeUndefined();
    expect(warnings).toEqual(["the Safe-Chain proxy of a run stopped; its installs now fail"]);
    await proxies.stopAll();
    expect(made[1]?.stops).toBe(1);
    expect(proxies.get("run_2")).toBeUndefined();
  });

  it("passes a refusal through and keeps nothing", async () => {
    const proxies = new SafeChainProxies({
      clock: new ManualClock(),
      start: async () => ({ ok: false, reason: "no network" }),
    });
    expect(await proxies.start("run_1", "/r/ca.pem")).toEqual({ ok: false, reason: "no network" });
    expect(proxies.get("run_1")).toBeUndefined();
  });
});

function listening(server: Server): Promise<void> {
  return new Promise((resolve) => server.once("listening", () => resolve()));
}

/** Sends `text` through a new connection to `path` and resolves with all it gets back. */
function exchange(path: string, text: string, after?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(path);
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString("latin1");
      if (after !== undefined && received.includes("200 Connection Established")) {
        socket.write(after);
        after = undefined;
      }
    });
    socket.on("end", () => resolve(received));
    socket.on("close", () => resolve(received));
    socket.on("error", reject);
    socket.write(text);
  });
}

describe("(unit) the gate on local sockets", () => {
  it("forwards a registry CONNECT to that ecosystem's Safe-Chain and refuses the rest", () =>
    withTempDir(async (dir) => {
      // A fake Safe-Chain: answers the CONNECT, then echoes one line and closes.
      const seen: string[] = [];
      const fakeSafeChain = createServer((socket) => {
        let buffer = "";
        socket.on("data", (chunk) => {
          buffer += chunk.toString("latin1");
          const end = buffer.indexOf("\r\n\r\n");
          if (end >= 0 && !buffer.startsWith("done")) {
            seen.push(buffer.slice(0, end));
            socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            buffer = "done";
            return;
          }
          if (buffer.startsWith("done") && buffer.includes("\n")) {
            socket.end(`echo ${buffer.slice(4)}`);
          }
        });
      });
      fakeSafeChain.listen(0, "127.0.0.1");
      await listening(fakeSafeChain);
      const address = fakeSafeChain.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const path = join(dir, "gate.sock");
      const gate = createServer((socket) =>
        handleGateConnection(socket, { npm: port, pypi: port }, systemClock),
      );
      gate.listen(path);
      await listening(gate);
      try {
        const passed = await exchange(
          path,
          "CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n",
          "hello\n",
        );
        expect(passed).toContain("HTTP/1.1 200 Connection Established");
        expect(passed).toContain("echo hello");
        expect(seen).toEqual([
          "CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443",
        ]);

        const plain = await exchange(path, "GET http://127.0.0.1:6420/ HTTP/1.1\r\n\r\n");
        expect(plain).toStartWith("HTTP/1.1 403 Forbidden");
        const other = await exchange(path, "CONNECT example.com:443 HTTP/1.1\r\n\r\n");
        expect(other).toStartWith("HTTP/1.1 403 Forbidden");
        expect(other).toContain("example.com is not a registry Safe-Chain checks");
        const huge = await exchange(path, `CONNECT ${"a".repeat(9_000)}`);
        expect(huge).toStartWith("HTTP/1.1 400 Bad Request");
        // Nothing refused reached the fake Safe-Chain.
        expect(seen).toHaveLength(1);
      } finally {
        gate.close();
        fakeSafeChain.close();
      }
    }));
});
