// One real box on Apple container (DIPO-265), opt-in: it registers only with DIPO_TEST_BOX=1 and
// never in CI, because it needs macOS with Apple container 1.6.0 or newer and its service running,
// pulls an image on its first run, and creates a real box and the host-only box network. The
// maintainer runs it by hand:
//
//   DIPO_TEST_BOX=1 bun test packages/engine/test/box/real-box.box.test.ts
//
// It checks the start check, the start time, copy in and out, exec, a long-running exec, memory,
// the list, files kept after stop and start, and delete. The box network stays for later runs.
// It also prints, with `fact:` lines, three behaviours of `container` the backend relies on:
// - what `container copy` out does with a symlink in the box that points outside the copied folder;
// - whether a killed `container exec` client leaves its process running in the box;
// - whether `container stats` on a stopped box exits non-zero.
//
// The image build (DIPO-266) registers only when the maintainer also names a running build proxy:
// DIPO_TEST_BOX_PROXY (`http://<host>:<port>`, reachable from the builder on the default network)
// and DIPO_TEST_BOX_CA (the Safe-Chain CA bundle that proxy wrote). Until dipo's web proxy
// (DIPO-268) exists, the probe's proxy serves, on the default network's host address:
//
//   bun tools/box-probe/web-proxy.ts <host address> <port> <ca-file>
//
// It builds the office image of a small description (minutes on a cold builder), builds it again
// to see the image reused, and checks the box it runs: Claude Code at its pinned version, with
// auto-update and nonessential traffic off, and neither the build proxy, the build CA nor git in
// the image.

import { lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { cleanEnv, withTempDir } from "@dipsaus-orchestrator/testkit";

import { statsArgs } from "../../src/box/apple-args";
import { boxImageTag, describeBox, ensureBoxImage } from "../../src/box/image";
import { AppleContainerBoxes } from "../../src/box/apple-container";
import { boxName, isBoxTimedOut } from "../../src/box/port";
import { systemClock } from "../../src/platform/clock";
import { systemSpawn } from "../../src/platform/process";

const IMAGE = "docker.io/library/alpine:3.20";
/** A first run pulls the image; later calls keep the 60 s default. */
const PULL_TIMEOUT_MS = 300_000;

/** The build proxy the image build needs; the build test registers only with both. */
const BUILD_PROXY = process.env["DIPO_TEST_BOX_PROXY"];
const BUILD_CA = process.env["DIPO_TEST_BOX_CA"];
/** An image build takes minutes. */
const BUILD_TIMEOUT_MS = 40 * 60_000;

const registers =
  process.env["DIPO_TEST_BOX"] === "1" &&
  process.env["DIPO_TEST_CI"] !== "1" &&
  process.env["CI"] === undefined;

/** A line the maintainer's run shows: one observed behaviour of `container`. */
function fact(text: string): void {
  console.log(`fact: ${text}`);
}

/** What the host path `path` is, without following a symlink. */
function describePath(path: string): string {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return "missing";
  }
  if (stat.isSymbolicLink()) return `a symlink to ${readlinkSync(path)}`;
  if (stat.isFile()) return `a regular file of ${stat.size} bytes`;
  return stat.isDirectory() ? "a folder" : "another kind of file";
}

if (registers) {
  describe("a real box on Apple container", () => {
    it(
      "starts, copies in and out, runs commands, keeps its files over stop and start, and is deleted",
      async () => {
        const env = cleanEnv();
        const cliEnv = {
          PATH: env["PATH"] ?? "/usr/bin:/bin:/usr/local/bin",
          HOME: env["HOME"] ?? "/",
        };
        const boxes = new AppleContainerBoxes({
          spawn: systemSpawn,
          clock: systemClock,
          env: cliEnv,
        });
        const check = await boxes.check();
        expect(check).toMatchObject({ ok: true });

        const network = await boxes.network();
        expect(network.mode).toBe("hostOnly");

        const runId = `test-${crypto.randomUUID().slice(0, 8)}`;
        const name = boxName(runId);
        /** The box's processes whose command line holds `marker`. */
        const running = async (marker: string) =>
          (await boxes.exec(name, ["ps", "-o", "pid,args"])).stdout
            .split("\n")
            .filter((line) => line.includes(marker));
        await withTempDir(async (dir) => {
          const code = join(dir, "code");
          mkdirSync(code);
          writeFileSync(join(code, "hello.txt"), "hello from the host\n");
          try {
            await boxes.create(
              { runId, image: IMAGE, network, packageCache: code },
              { timeoutMs: PULL_TIMEOUT_MS },
            );
            const before = performance.now();
            await boxes.start(name);
            fact(`box start took ${Math.round(performance.now() - before)} ms`);

            expect(await boxes.list()).toContainEqual({ name, runId, state: "running" });

            await boxes.copyIn(name, code, "/work");
            const cat = await boxes.exec(name, ["cat", "/work/hello.txt"]);
            expect(cat).toMatchObject({ code: 0, stdout: "hello from the host\n" });

            // The package cache is read-only inside the box.
            const write = await boxes.exec(name, ["sh", "-c", "touch /dipo/package-cache/x"]);
            expect(write.code).not.toBe(0);

            const printed = await boxes.exec(name, ["env"], { env: { DIPO_BOX: "1" } });
            expect(printed.stdout).toContain("DIPO_BOX=1");
            expect(printed.stdout).not.toContain(`HOME=${process.env["HOME"] ?? "-"}\n`);

            await boxes.exec(name, ["sh", "-c", "echo made in the box > /work/out.txt"]);
            const out = join(dir, "out.txt");
            await boxes.copyOut(name, "/work/out.txt", out);
            expect(readFileSync(out, "utf8")).toBe("made in the box\n");

            // A symlink in the box that points outside the copied folder.
            await boxes.exec(name, [
              "sh",
              "-c",
              "mkdir -p /work/links && echo inside > /work/links/plain.txt && ln -s /etc/hostname /work/links/hostname-link",
            ]);
            const links = join(dir, "links");
            const copied = await boxes
              .copyOut(name, "/work/links", links)
              .then(() => "succeeded")
              .catch(
                (error: unknown) =>
                  `failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            fact(`copy out of a folder holding a symlink to /etc/hostname ${copied}`);
            fact(`the copied plain file is ${describePath(join(links, "plain.txt"))}`);
            fact(`the copied symlink is ${describePath(join(links, "hostname-link"))}`);

            const live = boxes.execLive(name, ["cat"]);
            live.stdin.write("echoed\n");
            live.stdin.end();
            expect(await new Response(live.stdout).text()).toBe("echoed\n");
            expect((await live.exited).code).toBe(0);

            // A long-running exec whose client is killed.
            const sleeper = boxes.execLive(name, ["sleep", "6061"]);
            await Bun.sleep(1000);
            sleeper.kill("SIGKILL");
            fact(`the killed exec client ended with ${JSON.stringify(await sleeper.exited)}`);
            await Bun.sleep(1000);
            const leftLive = await running("sleep 6061");
            fact(
              `after its client was killed, the exec's process ${leftLive.length > 0 ? `still runs in the box: ${leftLive.join("; ").trim()}` : "is gone from the box"}`,
            );

            // An exec killed at its deadline.
            const timedOut = await boxes
              .exec(name, ["sleep", "6062"], { timeoutMs: 2000 })
              .then(() => false)
              .catch((error: unknown) => isBoxTimedOut(error));
            expect(timedOut).toBe(true);
            await Bun.sleep(1000);
            const leftShort = await running("sleep 6062");
            fact(
              `after box.timedOut, the exec's process ${leftShort.length > 0 ? `still runs in the box: ${leftShort.join("; ").trim()}` : "is gone from the box"}`,
            );

            const memory = await boxes.memory(name);
            expect(memory?.usedBytes).toBeGreaterThan(0);
            fact(`box memory: ${memory?.usedBytes} of ${memory?.limitBytes} bytes`);

            await boxes.stop(name);
            expect(await boxes.list()).toContainEqual({ name, runId, state: "stopped" });
            const stats = systemSpawn({ cmd: ["container", ...statsArgs(name)], env: cliEnv });
            const [statsOut, statsErr, statsExit] = await Promise.all([
              new Response(stats.stdout).text(),
              new Response(stats.stderr).text(),
              stats.exited,
            ]);
            fact(
              `container stats on a stopped box exits ${statsExit.code}, stdout ${JSON.stringify(statsOut.trim())}, stderr ${JSON.stringify(statsErr.trim())}`,
            );
            expect(await boxes.memory(name)).toBeNull();
            await boxes.start(name);
            const kept = await boxes.exec(name, ["cat", "/work/out.txt"]);
            expect(kept).toMatchObject({ code: 0, stdout: "made in the box\n" });
          } finally {
            await boxes.delete(name).catch(() => {});
          }
          expect((await boxes.list()).map((box) => box.name)).not.toContain(name);
        });
      },
      PULL_TIMEOUT_MS + 120_000,
    );

    if (BUILD_PROXY !== undefined && BUILD_CA !== undefined) {
      it(
        "builds the office image once through the build proxy, and runs Claude Code from it",
        async () => {
          const env = cleanEnv();
          const boxes = new AppleContainerBoxes({
            spawn: systemSpawn,
            clock: systemClock,
            env: { PATH: env["PATH"] ?? "/usr/bin:/bin:/usr/local/bin", HOME: env["HOME"] ?? "/" },
          });
          // Bun from .bun-version, as the scan detects it; the rest from dipo's defaults.
          const { image } = describeBox(
            { packages: ["jq"] },
            { bun: { version: "1.4.2", evidence: ".bun-version" } },
          );
          await withTempDir(async (dir) => {
            const request = {
              boxes,
              image,
              proxy: { url: BUILD_PROXY, caFile: BUILD_CA },
              scratchRoot: dir,
            };
            const before = performance.now();
            const first = await ensureBoxImage(request);
            const took = Math.round(performance.now() - before);
            fact(`image ${first.tag} ${first.built ? "built" : "reused"} in ${took} ms`);
            expect(first.tag).toBe(boxImageTag(image));
            expect(await ensureBoxImage(request)).toEqual({ tag: first.tag, built: false });

            const network = await boxes.network();
            const runId = `test-${crypto.randomUUID().slice(0, 8)}`;
            const name = boxName(runId);
            try {
              await boxes.create({ runId, image: first.tag, network });
              await boxes.start(name);
              const claude = await boxes.exec(name, ["claude", "--version"]);
              expect(claude.code).toBe(0);
              expect(claude.stdout).toContain(image.claudeCode);
              const bun = await boxes.exec(name, ["bun", "--version"]);
              expect(bun.stdout.trim()).toBe("1.4.2");
              const printed = (await boxes.exec(name, ["env"])).stdout;
              expect(printed).toContain("DISABLE_AUTOUPDATER=1");
              expect(printed).toContain("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1");
              expect(printed).not.toContain("DIPO_PROXY");
              expect(printed).not.toContain(BUILD_PROXY);
              // The build CA was mounted for the npm step only; it is not in the image.
              const ca = await boxes.exec(name, ["test", "-e", "/run/dipo/safe-chain-ca.pem"]);
              expect(ca.code).not.toBe(0);
              const git = await boxes.exec(name, ["sh", "-c", "command -v git || echo none"]);
              expect(git.stdout.trim()).toBe("none");
            } finally {
              await boxes.delete(name).catch(() => {});
            }
          });
        },
        BUILD_TIMEOUT_MS,
      );
    }
  });
}
