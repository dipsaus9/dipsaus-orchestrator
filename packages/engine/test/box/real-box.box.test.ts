// One real box on Apple container (DIPO-265), opt-in: it registers only with DIPO_TEST_BOX=1 and
// never in CI, because it needs macOS with Apple container 1.6.0 or newer and its service running,
// pulls an image on its first run, and creates a real box and the host-only box network. The
// maintainer runs it by hand:
//
//   DIPO_TEST_BOX=1 bun test packages/engine/test/box/real-box.box.test.ts
//
// It checks the start check, the start time, copy in and out, exec, a long-running exec, memory,
// the list, files kept after stop and start, and delete. The box network stays for later runs.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { cleanEnv, withTempDir } from "@dipsaus-orchestrator/testkit";

import { AppleContainerBoxes } from "../../src/box/apple-container";
import { boxName } from "../../src/box/port";
import { systemClock } from "../../src/platform/clock";
import { systemSpawn } from "../../src/platform/process";

const IMAGE = "docker.io/library/alpine:3.20";
/** A first run pulls the image; later calls keep the 60 s default. */
const PULL_TIMEOUT_MS = 300_000;

const registers =
  process.env["DIPO_TEST_BOX"] === "1" &&
  process.env["DIPO_TEST_CI"] !== "1" &&
  process.env["CI"] === undefined;

if (registers) {
  describe("a real box on Apple container", () => {
    it(
      "starts, copies in and out, runs commands, keeps its files over stop and start, and is deleted",
      async () => {
        const env = cleanEnv();
        const boxes = new AppleContainerBoxes({
          spawn: systemSpawn,
          clock: systemClock,
          env: { PATH: env["PATH"] ?? "/usr/bin:/bin:/usr/local/bin", HOME: env["HOME"] ?? "/" },
        });
        const check = await boxes.check();
        expect(check).toMatchObject({ ok: true });

        const network = await boxes.network();
        expect(network.mode).toBe("hostOnly");

        const runId = `test-${crypto.randomUUID().slice(0, 8)}`;
        const name = boxName(runId);
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
            const startMs = performance.now() - before;
            console.error(`box start: ${Math.round(startMs)} ms`);

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

            const live = boxes.execLive(name, ["cat"]);
            live.stdin.write("echoed\n");
            live.stdin.end();
            expect(await new Response(live.stdout).text()).toBe("echoed\n");
            expect((await live.exited).code).toBe(0);

            const memory = await boxes.memory(name);
            expect(memory?.usedBytes).toBeGreaterThan(0);
            console.error(`box memory: ${memory?.usedBytes} of ${memory?.limitBytes} bytes`);

            await boxes.stop(name);
            expect(await boxes.list()).toContainEqual({ name, runId, state: "stopped" });
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
  });
}
