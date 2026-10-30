// What Safe-Chain refused in one session (DIPO-376): `markSafeChain` counts each log's lines in the
// Safe-Chain box when a session starts, and `readSafeChain` reads the lines each gained when it
// ends. The box commands run here with `sh` on log files in a temp folder, so their shell is
// tested too. A log that cannot be read is unknown, never "no refusals". Safe-Chain's wording in
// a real box is pinned by safe-chain-refusals.box.test.ts.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import type { BoxExecResult } from "../../src/box/port";
import { SAFE_CHAIN_LOG_DIR, type SafeChainMark } from "../../src/box/safe-chain";
import { markSafeChain, readSafeChain } from "../../src/box/safe-chain-box";

const BOX = "dipo-safe-chain-0123456789abcdef";

function logLine(message: string): string {
  return `${JSON.stringify({ timestamp: "2026-10-30T10:57:30.565Z", level: "verbose", message })}\n`;
}

const ROUTE_CHECK =
  logLine("Safe-chain: Package safe-chain-test@0.0.1-security is marked as malware: MALWARE") +
  logLine(
    "Safe-chain: Blocking request to https://registry.npmjs.org/safe-chain-test/-/safe-chain-test-0.0.1-security.tgz",
  );

/**
 * Box calls that run each command with `sh` here, the box's log folder being `dir`; only `box`
 * exists. `fail` makes every call throw.
 */
function boxesIn(dir: string, options: { fail?: boolean } = {}) {
  const calls: string[][] = [];
  return {
    calls,
    async exec(name: string, command: readonly [string, ...string[]]): Promise<BoxExecResult> {
      calls.push([name, ...command]);
      if (options.fail === true) throw new Error("box.failed: the box is not running");
      if (name !== BOX) throw new Error(`no box ${name}`);
      const argv = command.map((arg) => arg.replace(SAFE_CHAIN_LOG_DIR, dir));
      const done = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
      return {
        code: done.exitCode,
        stdout: done.stdout.toString(),
        stderr: done.stderr.toString(),
      };
    },
  };
}

async function logs(run: (dir: string) => Promise<void>): Promise<void> {
  await withTempDir(async (tmp) => {
    const dir = join(tmp, "log");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "npm.ndjson"),
      logLine("Log started, command: bun install") + ROUTE_CHECK,
    );
    writeFileSync(join(dir, "pypi.ndjson"), logLine("Log started, command: pip3 install x"));
    await run(dir);
  });
}

describe("the refusals of one session in Safe-Chain's logs (DIPO-376)", () => {
  it("reads only the lines a log gained since the session's mark", () =>
    logs(async (dir) => {
      const boxes = boxesIn(dir);
      const mark = await markSafeChain(boxes, BOX);
      // The route's own check refused safe-chain-test before the session: not the session's.
      expect(mark).toEqual({ box: BOX, lines: { npm: 3, pypi: 1 } });
      appendFileSync(
        join(dir, "npm.ndjson"),
        logLine("Safe-chain: Package left-pad@1.3.0 is clean"),
      );
      appendFileSync(join(dir, "npm.ndjson"), ROUTE_CHECK);
      appendFileSync(
        join(dir, "pypi.ndjson"),
        logLine("Safe-chain: Package six@1.16.0 is clean") +
          logLine(
            "Safe-chain: Blocking request to https://files.pythonhosted.org/packages/xx/yy/six-1.16.0.tar.gz",
          ),
      );
      expect(await readSafeChain(boxes, BOX, mark)).toEqual({
        refusals: [
          {
            ecosystem: "npm",
            package: "safe-chain-test@0.0.1-security",
            reason: "Aikido's malware list marks it MALWARE",
          },
          {
            ecosystem: "pypi",
            package: "six-1.16.0.tar.gz",
            reason:
              "the version is newer than Safe-Chain's minimum package age, so it was released too recently",
          },
        ],
        unknown: [],
      });
      // A session that met no refusal reads none.
      const quiet = await markSafeChain(boxes, BOX);
      expect(await readSafeChain(boxes, BOX, quiet)).toEqual({ refusals: [], unknown: [] });
    }));

  it("keeps a log as unknown when the Safe-Chain box is another than at the session's start", () =>
    logs(async (dir) => {
      const boxes = boxesIn(dir);
      const mark: SafeChainMark = { box: "dipo-safe-chain-gone", lines: { npm: 0, pypi: 0 } };
      const found = await readSafeChain(boxes, BOX, mark);
      expect(found.refusals).toEqual([]);
      expect(found.unknown).toEqual([
        { ecosystem: "npm", why: "the Safe-Chain box it ran with is gone, and its log with it" },
        { ecosystem: "pypi", why: "the Safe-Chain box it ran with is gone, and its log with it" },
      ]);
      // No route runs now: the same.
      expect((await readSafeChain(boxes, null, mark)).unknown).toHaveLength(2);
      expect(boxes.calls).toEqual([]);
    }));

  it("keeps a log as unknown when it could not be counted at the start or read at the end", () =>
    logs(async (dir) => {
      const failing = boxesIn(dir, { fail: true });
      // No count at the start: the end reads nothing and says so.
      const unmarked = await markSafeChain(failing, BOX);
      expect(unmarked).toEqual({ box: BOX, lines: { npm: null, pypi: null } });
      expect((await readSafeChain(boxesIn(dir), BOX, unmarked)).unknown).toEqual([
        { ecosystem: "npm", why: "its Safe-Chain log could not be read when the session started" },
        { ecosystem: "pypi", why: "its Safe-Chain log could not be read when the session started" },
      ]);
      expect(await markSafeChain(failing, null)).toEqual({
        box: null,
        lines: { npm: null, pypi: null },
      });
      // A call that fails at the end, and a log that is gone at the end.
      const mark = await markSafeChain(boxesIn(dir), BOX);
      expect((await readSafeChain(failing, BOX, mark)).unknown).toEqual([
        {
          ecosystem: "npm",
          why: "its Safe-Chain log could not be read: box.failed: the box is not running",
        },
        {
          ecosystem: "pypi",
          why: "its Safe-Chain log could not be read: box.failed: the box is not running",
        },
      ]);
      Bun.spawnSync(["rm", join(dir, "pypi.ndjson")]);
      const found = await readSafeChain(boxesIn(dir), BOX, mark);
      expect(found.unknown).toEqual([
        { ecosystem: "pypi", why: "its Safe-Chain log could not be read (exit 3)" },
      ]);
    }));
});
