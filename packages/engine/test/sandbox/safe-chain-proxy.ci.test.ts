// CI only, and only on a machine with the official Safe-Chain (DIPO-84): the sandbox replay of
// worker installs, no Claude session. dipo starts its real Safe-Chain checking proxy (Safe-Chain
// and the gate inside their own sandbox), then a command runs through `dipo daemon sandbox-exec`
// under the worker's network settings: the proxy as `httpProxyPort`, local binding off. In that
// sandbox `bun add is-number@7.0.0` succeeds, `bun add safe-chain-test` is refused by Safe-Chain,
// and a local listener is reachable neither directly nor through the proxy. Needs the network to
// the registries and Aikido; GitHub's runners have no Safe-Chain, so it does not register there.

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { systemClock } from "../../src/platform/clock";
import { currentPlatform } from "../../src/platform/paths";
import { dipoCommand, sandboxExecArgv } from "../../src/platform/sandbox";
import { startSafeChainProxy } from "../../src/platform/safe-chain-proxy";
import { workerCacheEnv, workerCaEnv } from "../../src/sandbox/safe-chain-proxy";
import { CI } from "./helpers";

const INSTALL = join(homedir(), ".safe-chain");
const INSTALLED = existsSync(join(INSTALL, "bin", "safe-chain"));
const TIMEOUT_MS = 300_000;

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
            { platform, clock: systemClock, prefix: join(dir, "p-") },
          );
          if (!started.ok) throw new Error(started.reason);
          const proxy = started.proxy;
          const local = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () => new Response("local service\n"),
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
                  denyRead: [proxy.dir, INSTALL],
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
            const secret = await run(dir, policy, project, env, `ls ${proxy.dir}`);
            expect(secret.code).not.toBe(0);
          } finally {
            void local.stop(true);
            await proxy.stop();
          }
          expect(existsSync(proxy.dir)).toBe(false);
        }),
      TIMEOUT_MS,
    );
  });
}
