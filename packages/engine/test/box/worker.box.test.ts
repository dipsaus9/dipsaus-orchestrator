// One box worker on a real box (DIPO-271), opt-in: it registers only with DIPO_TEST_BOX=1 and never
// in CI. It needs macOS with Apple container 1.6.0 or newer and its service running, the
// internet (the web route builds its Safe-Chain box from the pinned release, DIPO-343), and the box login stored
// with `dipo login box`. It runs one live Claude Code request in the box, so the maintainer runs
// it by hand:
//
//   DIPO_TEST_BOX=1 bun test packages/engine/test/box/worker.box.test.ts
//
// Without a stored box login it starts nothing and says so. The presence check runs `security`
// without `-w`, which shows the entry's attributes, never the token; only the model proxy reads it.
//
// It makes the box of a small repository through `BoxWorkers` (the office image built in a build
// box on its first run, which takes minutes), plans a trivial developer session with `planInBox`,
// runs the plan's `container exec` client with stream-json in and out until the result, checks the
// stream came from the box with all permissions, runs the plan's stop command, and ends the run:
// the post-run token check must find no token, and the box is deleted.

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { cleanEnv, ManualClock, withTempDir, withTempRepo } from "@dipsaus-orchestrator/testkit";

import { AppleContainerBoxes } from "../../src/box/apple-container";
import { readBaseBox } from "../../src/box/image";
import { startModelProxy } from "../../src/box/model-proxy";
import { BOX_TOKEN_CHECK } from "../../src/box/token-check";
import { SECURITY_CLI, TOKEN_KEYCHAIN_ACCOUNT, TOKEN_KEYCHAIN_SERVICE } from "../../src/box/token";
import type { BoxNetwork } from "../../src/box/port";
import { startBoxWebRoute } from "../../src/box/safe-chain-box";
import type { RouteBoxIds } from "../../src/box/workers";
import { BOX_INDEX_DIR, BoxWorkers } from "../../src/box/workers";
import { OfficeGit, spawnGitExec } from "../../src/git";
import { systemListenHttp } from "../../src/platform/box-host";
import { systemClock } from "../../src/platform/clock";
import { systemSpawn } from "../../src/platform/process";
import { planInBox } from "../../src/workers/claude-cli/box-plan";
import { REPORT_JSON_SCHEMAS } from "../../src/workers/claude-cli/report-schema";
import { AdapterHolds } from "../../src/workers/hold";
import { cleanUpRealBoxes } from "./real-box-cleanup";

const registers =
  process.env["DIPO_TEST_BOX"] === "1" &&
  process.env["DIPO_TEST_CI"] !== "1" &&
  process.env["CI"] === undefined;

/** The image build on a cold builder, the box and one model request. */
const TIMEOUT_MS = 45 * 60_000;
/** How long the one request may take. */
const SESSION_MS = 5 * 60_000;
const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z0000BOX1" as OfficeId;

function fact(text: string): void {
  console.log(`fact: ${text}`);
}

/** True when the box login entry exists; `security` without `-w` never prints the token. */
async function boxLoginStored(env: Record<string, string>): Promise<boolean> {
  const child = systemSpawn({
    cmd: [
      SECURITY_CLI,
      "find-generic-password",
      "-s",
      TOKEN_KEYCHAIN_SERVICE,
      "-a",
      TOKEN_KEYCHAIN_ACCOUNT,
    ],
    env,
  });
  const [, , exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return exit.code === 0;
}

/** Reads stream-json lines from `stdout` until a `result` line or the deadline. */
async function untilResult(stdout: ReadableStream<Uint8Array>): Promise<Record<string, unknown>[]> {
  const lines: Record<string, unknown>[] = [];
  const decoder = new TextDecoder();
  const reader = stdout.getReader();
  let pending = "";
  const deadline = performance.now() + SESSION_MS;
  while (performance.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let at = pending.indexOf("\n");
    while (at >= 0) {
      const text = pending.slice(0, at);
      pending = pending.slice(at + 1);
      at = pending.indexOf("\n");
      if (text.trim() === "") continue;
      const line = JSON.parse(text) as Record<string, unknown>;
      lines.push(line);
      if (line["type"] === "result") {
        reader.releaseLock();
        return lines;
      }
    }
  }
  reader.releaseLock();
  return lines;
}

if (registers) {
  // Every box this run makes is deleted after its tests, and one an earlier run left is reported.
  const cleanup = cleanUpRealBoxes(import.meta.path);
  describe("a box worker on a real box", () => {
    it(
      "runs Claude Code in its box with stream-json, stops it, and finds no token at the end",
      async () => {
        const env = cleanEnv();
        const home = homedir();
        const keychainEnv = { PATH: "/usr/bin:/bin", HOME: home };
        if (!(await boxLoginStored(keychainEnv))) {
          fact("no box login is stored (`dipo login box`): the box worker test started nothing");
          return;
        }
        const cliEnv = { PATH: env["PATH"] ?? "/usr/bin:/bin:/usr/local/bin", HOME: home };
        const boxes = new AppleContainerBoxes({
          stateLabel: cleanup.stateLabel,
          spawn: systemSpawn,
          clock: systemClock,
          cli: "/usr/local/bin/container",
          env: cliEnv,
        });
        expect(await boxes.check()).toMatchObject({ ok: true });

        await withTempDir(async (tmp) => {
          await withTempRepo(async (repo) => {
            writeFileSync(join(repo.dir, "README.md"), "# a box worker test\n");
            const commit = await repo.commitAll("start");
            await repo.git("update-ref", "refs/remotes/origin/main", commit);
            const real = realpathSync(repo.dir);
            const git = new OfficeGit({
              officeId: OFFICE,
              mainWorktree: real,
              commonDir: join(real, ".git"),
              settings: { remote: "origin", base: "main" },
              runner: { exec: spawnGitExec(systemSpawn), env: repo.env, sleep: async () => {} },
              clock: new ManualClock(),
            });
            let routes = 0;
            const routeBoxes = new AppleContainerBoxes({
              stateLabel: cleanup.stateLabel,
              spawn: systemSpawn,
              clock: systemClock,
              cli: "/usr/local/bin/container",
              env: cliEnv,
              netToolsRoot: join(tmp, "state", "box-net-tools"),
            });
            const startRoute = (network: BoxNetwork, ids: RouteBoxIds) => {
              routes += 1;
              return startBoxWebRoute(
                network,
                {
                  boxes: routeBoxes,
                  clock: systemClock,
                  scratchRoot: tmp,
                  toolsRoot: join(tmp, "state", "box-net-tools"),
                  caFile: join(tmp, `route-${routes}`, "ca.pem"),
                  boxId: ids.boxId,
                  buildId: ids.buildId,
                },
                { clock: systemClock },
              );
            };
            const holds = new AdapterHolds({ clock: systemClock, notify: () => {} });
            const workers = new BoxWorkers({
              // Every box of the office image mounts its box network tools from here (DIPO-281).
              boxes: new AppleContainerBoxes({
                stateLabel: cleanup.stateLabel,
                spawn: systemSpawn,
                clock: systemClock,
                cli: "/usr/local/bin/container",
                env: cliEnv,
                netToolsRoot: join(tmp, "state", "box-net-tools"),
              }),
              startWebRoute: startRoute,
              startModelProxy: (network) =>
                startModelProxy({
                  network,
                  keychain: { spawn: systemSpawn, clock: systemClock, env: keychainEnv },
                  listen: systemListenHttp,
                }),
              readBaseBox,
              code: { spawn: systemSpawn, clock: systemClock },
              holds,
              adapter: "claude-cli",
              tmpRoot: tmp,
              indexDir: join(tmp, "state", BOX_INDEX_DIR),
              scratchRoot: tmp,
              netToolsRoot: join(tmp, "state", "box-net-tools"),
              warn: (message, fields) => fact(`${message} ${JSON.stringify(fields)}`),
            });
            const runId = `test-${crypto.randomUUID().slice(0, 8)}`;
            const runDir = join(tmp, "runs", runId);
            mkdirSync(runDir, { recursive: true });
            const systemFile = join(runDir, "system.md");
            writeFileSync(systemFile, "You are a test worker. Answer briefly.\n");
            try {
              const before = performance.now();
              await workers.create({ office: OFFICE, runId, runDir, git, startCommit: commit });
              fact(`the box was ready in ${Math.round(performance.now() - before)} ms`);
              const session = await workers.session({ runId, runDir, systemFile });
              const plan = planInBox(
                {
                  run: runId,
                  agent: "agt-box-test",
                  kind: "implement",
                  workdir: "/work",
                  model: "haiku",
                  effort: "low",
                  caps: { budgetTokens: 100_000, maxTurns: 2, maxMinutes: 5 },
                  systemFile,
                  taskMessage: "Reply in one word, OK, and report status done with no criteria.",
                  web: false,
                  session: { id: crypto.randomUUID(), resume: false },
                  reportSchema: REPORT_JSON_SCHEMAS.implement,
                },
                session,
                runDir,
              );
              const child = systemSpawn({
                cmd: plan.argv,
                env: plan.env,
                cwd: plan.cwd,
                stdin: "pipe",
              });
              for (const line of plan.stdin) child.stdin?.write(line);
              const lines = await untilResult(child.stdout);
              child.stdin?.end();
              const init = lines.find((line) => line["subtype"] === "init");
              fact(
                `init: cwd ${String(init?.["cwd"])}, permissionMode ${String(init?.["permissionMode"])}, apiKeySource ${String(init?.["apiKeySource"])}`,
              );
              expect(init?.["cwd"]).toBe("/work");
              expect(init?.["permissionMode"]).toBe("bypassPermissions");
              const result = lines.find((line) => line["type"] === "result");
              fact(
                `result: ${String(result?.["subtype"])}, is_error ${String(result?.["is_error"])}`,
              );
              expect(result).toBeDefined();

              const stop = systemSpawn({
                cmd: plan.stopCommand ?? ["/usr/bin/true"],
                env: plan.env,
              });
              expect((await stop.exited).code).toBe(0);
              fact(`the worker's client ended with ${JSON.stringify(await child.exited)}`);

              const finished = await workers.finish(runId);
              fact(`the end of the run: ${JSON.stringify(finished)}`);
              expect(finished).toMatchObject({
                kind: "checked",
                check: { code: "box.tokenAbsent" },
              });
              expect(holds.adapterHeld("claude-cli")?.check).not.toBe(BOX_TOKEN_CHECK);
            } finally {
              await boxes.delete(`dipo-${runId}`).catch(() => {});
              await workers.close();
            }
          });
        });
      },
      TIMEOUT_MS,
    );
  });
}
