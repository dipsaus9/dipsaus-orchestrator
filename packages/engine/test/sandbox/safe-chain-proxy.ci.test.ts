// CI only, and only on a machine with the official Safe-Chain (DIPO-84): the sandbox replay of
// worker installs, no Claude session. dipo starts its real Safe-Chain checking proxy (Safe-Chain
// and the gate inside their own sandbox), then a command runs through `dipo daemon sandbox-exec`
// under the worker's network settings: the proxy as `httpProxyPort`, local binding off. In that
// sandbox `bun add is-number@7.0.0` succeeds, `bun add safe-chain-test` is refused by Safe-Chain,
// and a local listener is reachable neither directly nor through the proxy. Needs the network to
// the registries and Aikido; GitHub's runners have no Safe-Chain, so it does not register there.

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { connect as tlsConnect } from "node:tls";
import { dirname, join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { systemClock } from "../../src/platform/clock";
import { currentPlatform } from "../../src/platform/paths";
import { dipoCommand, sandboxExecArgv } from "../../src/platform/sandbox";
import { startSafeChainProxy } from "../../src/platform/safe-chain-proxy";
import { SafeChainProxies } from "../../src/sandbox/safe-chain-proxies";
import { workerCacheEnv, workerCaEnv } from "../../src/sandbox/safe-chain-proxy";
import { CI } from "./helpers";

const INSTALL = join(homedir(), ".safe-chain");
const INSTALLED = existsSync(join(INSTALL, "bin", "safe-chain"));
const TIMEOUT_MS = 300_000;

/** Sends one raw request inside a `CONNECT registry.npmjs.org:443` tunnel through the proxy. */
function throughTunnel(port: number, ca: string, request: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () =>
      socket.write(
        "CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n",
      ),
    );
    let head = "";
    let answer = "";
    const done = () => resolve(answer);
    const onData = (chunk: Buffer) => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      if (!head.startsWith("HTTP/1.1 200")) {
        resolve(head);
        return;
      }
      const tls = tlsConnect({ socket, servername: "registry.npmjs.org", ca }, () =>
        tls.write(request),
      );
      tls.on("data", (data: Buffer) => {
        answer += data.toString("latin1");
      });
      tls.on("end", done);
      tls.on("close", done);
      tls.on("error", (error) => resolve(`TLS error: ${error.message}`));
    };
    socket.on("data", onData);
    socket.on("error", (error) => resolve(`socket error: ${error.message}`));
  });
}

async function run(
  dir: string,
  policy: string,
  cwd: string,
  env: Record<string, string>,
  script: string,
): Promise<{ code: number; out: string }> {
  const child = Bun.spawn({
    cmd: sandboxExecArgv(dipoCommand(), policy, ["/bin/sh", "-c", script], cwd),
    cwd: "/",
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  writeFileSync(join(dir, `last-${code}.log`), `${out}\n${err}`);
  return { code, out: `${out}\n${err}` };
}

if (CI && INSTALLED) {
  describe("Safe-Chain installs in the worker sandbox (sandbox replay)", () => {
    it(
      "installs a small package, refuses Safe-Chain's test malware and keeps localhost closed",
      () =>
        withTempDir(async (dir) => {
          const platform = currentPlatform();
          const caFile = join(dir, "run", "safe-chain", "ca.pem");
          const started = await startSafeChainProxy(
            {
              installRoot: INSTALL,
              caFile,
              home: homedir(),
              uid: process.getuid?.() ?? 0,
              env: process.env,
            },
            { platform, clock: systemClock, root: join(dir, "p") },
          );
          if (!started.ok) throw new Error(started.reason);
          const proxy = started.proxy;
          let hits = 0;
          const local = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () => {
              hits += 1;
              return new Response("local service\n");
            },
          });
          try {
            const project = join(dir, "project");
            const tmp = join(dir, "tmp");
            mkdirSync(project, { recursive: true });
            mkdirSync(tmp, { recursive: true });
            writeFileSync(join(project, "package.json"), '{"name":"replay","version":"0.0.0"}\n');
            const policy = join(dir, "worker-policy.json");
            writeFileSync(
              policy,
              JSON.stringify({
                network: {
                  allowedDomains: [],
                  deniedDomains: [],
                  strictAllowlist: true,
                  allowLocalBinding: false,
                  httpProxyPort: proxy.port,
                },
                filesystem: {
                  // The parent of every proxy directory, as the worker plan denies it.
                  denyRead: [dirname(proxy.dir), INSTALL],
                  allowWrite: [project, tmp],
                  denyWrite: [],
                },
              }),
            );
            const env = {
              // Bun first; the rest for `rg`, which the sandbox needs on macOS.
              PATH: `${dirname(process.execPath)}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
              HOME: tmp,
              TMPDIR: tmp,
              ...workerCacheEnv(tmp),
              ...workerCaEnv(caFile),
            };
            const added = await run(dir, policy, project, env, "bun add is-number@7.0.0");
            if (added.code !== 0) throw new Error(`bun add failed (${added.code}): ${added.out}`);
            expect(await Bun.file(join(project, "package.json")).text()).toContain("is-number");
            expect(existsSync(join(tmp, "caches", "bun"))).toBe(true);

            const blocked = await run(dir, policy, project, env, "bun add safe-chain-test");
            expect(blocked.code).not.toBe(0);
            expect(blocked.out).toContain("403");

            const url = `http://127.0.0.1:${local.port}/`;
            const direct = await run(
              dir,
              policy,
              project,
              env,
              `curl -s -m 5 --noproxy '*' ${url}`,
            );
            expect(direct.out).not.toContain("local service");
            const proxied = await run(
              dir,
              policy,
              project,
              env,
              `curl -s -m 5 --noproxy '' -x "$HTTP_PROXY" ${url}`,
            );
            expect(proxied.out).not.toContain("local service");
            expect(proxied.out).toContain("only CONNECT is allowed");
            for (const path of [
              dirname(proxy.dir),
              proxy.dir,
              `${proxy.dir}/sc/certs/ca-key.pem`,
            ]) {
              const secret = await run(dir, policy, project, env, `cat ${path} || ls ${path}`);
              expect(secret.code).not.toBe(0);
            }

            // Inside a tunnel the gate passed, Safe-Chain sends every request to the registry of
            // the CONNECT, whatever the Host header or an absolute URI names.
            const ca = readFileSync(caFile, "utf8");
            for (const request of [
              `GET /is-number HTTP/1.1\r\nHost: 127.0.0.1:${local.port}\r\nConnection: close\r\n\r\n`,
              `GET ${url} HTTP/1.1\r\nHost: 127.0.0.1:${local.port}\r\nConnection: close\r\n\r\n`,
              `GET https://127.0.0.1:${local.port}/ HTTP/1.1\r\nHost: registry.npmjs.org\r\nConnection: close\r\n\r\n`,
              "GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n",
              "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n",
            ]) {
              const answer = await throughTunnel(proxy.port, ca, request);
              expect(answer).not.toContain("local service");
              expect(answer).not.toContain("Example Domain");
            }
            expect(hits).toBe(0);
          } finally {
            void local.stop(true);
            await proxy.stop();
          }
          expect(existsSync(proxy.dir)).toBe(false);
        }),
      TIMEOUT_MS,
    );

    it(
      "closes the port and removes the proxy directory when its gate exits on its own",
      () =>
        withTempDir(async (dir) => {
          const root = join(dir, "p");
          const warnings: string[] = [];
          const proxies = new SafeChainProxies({
            clock: systemClock,
            start: ({ caFile }) =>
              startSafeChainProxy(
                {
                  installRoot: INSTALL,
                  caFile,
                  home: homedir(),
                  uid: process.getuid?.() ?? 0,
                  env: process.env,
                },
                { platform: currentPlatform(), clock: systemClock, root },
              ),
            warn: (message) => warnings.push(message),
          });
          const started = await proxies.start("run_1", join(dir, "run", "safe-chain", "ca.pem"));
          if (!started.ok) throw new Error(started.reason);
          const { port, dir: proxyDir } = started.proxy;
          const gate = Bun.spawnSync(["pgrep", "-f", `safe-chain-gate --dir ${proxyDir}`]);
          const pids = gate.stdout
            .toString()
            .trim()
            .split("\n")
            .filter((pid) => pid !== "");
          expect(pids.length).toBeGreaterThan(0);
          for (const pid of pids) process.kill(Number(pid), "SIGKILL");
          await started.proxy.exited;
          for (let i = 0; i < 100 && existsSync(proxyDir); i += 1) await Bun.sleep(50);
          expect(existsSync(proxyDir)).toBe(false);
          expect(existsSync(`${proxyDir}.policy.json`)).toBe(false);
          expect(proxies.get("run_1")).toBeUndefined();
          expect(warnings).toHaveLength(1);
          const refused = await new Promise<boolean>((resolve) => {
            const socket = connect(port, "127.0.0.1");
            socket.on("connect", () => {
              socket.destroy();
              resolve(false);
            });
            socket.on("error", () => resolve(true));
          });
          expect(refused).toBe(true);
        }),
      TIMEOUT_MS,
    );
  });
}
