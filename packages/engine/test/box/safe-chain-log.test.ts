// What Safe-Chain refused in one session (DIPO-376): `markSafeChain` counts each log's lines in the
// Safe-Chain box when a session starts, and `readSafeChain` reads the lines each gained when it
// ends. The box commands run here with `sh` on log files in a temp folder, so their shell is
// tested too, `date` among it: the box's clock is the Mac's here. A log that cannot be read is
// unknown, never "no refusals". Of what a log gained, only the refusals the session's own box asked
// for are its (DIPO-396), by their time and the web route's registry tunnels; one whose box cannot
// be told is unknown. Safe-Chain's wording in a real box is pinned by
// safe-chain-refusals.box.test.ts.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { systemClock } from "../../src/platform/clock";
import { BoxError, type BoxExecOptions, type BoxExecResult } from "../../src/box/port";
import { SAFE_CHAIN_LOG_DIR, type SafeChainMark } from "../../src/box/safe-chain";
import {
  markSafeChain,
  readSafeChain,
  SAFE_CHAIN_LOG_READ_TIMEOUT_MS,
  type SafeChainReader,
} from "../../src/box/safe-chain-box";
import { RegistryTunnels } from "../../src/box/web-proxy";

const BOX = "dipo-safe-chain-0123456789abcdef";
/** The session's own box. */
const CLIENT = "dipo-run_a";

function logLine(message: string, at: number = systemClock.now()): string {
  return `${JSON.stringify({ timestamp: new Date(at).toISOString(), level: "verbose", message })}\n`;
}

const malwareLines = (pkg: string, url: string, at?: number): string =>
  logLine(`Safe-chain: Package ${pkg} is marked as malware: MALWARE`, at) +
  logLine(`Safe-chain: Blocking request to ${url}`, at);

const ROUTE_CHECK = malwareLines(
  "safe-chain-test@0.0.1-security",
  "https://registry.npmjs.org/safe-chain-test/-/safe-chain-test-0.0.1-security.tgz",
);

/**
 * Box calls that run each command with `sh` here, the box's log folder being `dir`; only `box`
 * exists. `fail` makes every call throw; `clock` replaces what `date` prints.
 */
function boxesIn(dir: string, options: { fail?: boolean; clock?: () => string } = {}) {
  const calls: string[][] = [];
  return {
    calls,
    async exec(name: string, command: readonly [string, ...string[]]): Promise<BoxExecResult> {
      calls.push([name, ...command]);
      if (options.fail === true) throw new Error("box.failed: the box is not running");
      if (name !== BOX) throw new Error(`no box ${name}`);
      const clock = options.clock;
      const argv = command.map((arg) => {
        const local = arg.replace(SAFE_CHAIN_LOG_DIR, dir);
        return clock === undefined ? local : local.replace("date -u +%s.%N", `echo ${clock()}`);
      });
      const done = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
      return {
        code: done.exitCode,
        stdout: done.stdout.toString(),
        stderr: done.stderr.toString(),
      };
    },
  };
}

/** The session's box with a registry tunnel of each ecosystem open since a minute ago. */
function ownTunnels(): RegistryTunnels {
  const tunnels = new RegistryTunnels(systemClock);
  tunnels.opened(CLIENT, "npm", systemClock.now() - 60_000);
  tunnels.opened(CLIENT, "pypi", systemClock.now() - 60_000);
  return tunnels;
}

const reader = (tunnels: RegistryTunnels | null = ownTunnels()): SafeChainReader => ({
  clock: systemClock,
  client: CLIENT,
  tunnels,
});

const untied = (ecosystem: "npm" | "pypi", why: string) => ({
  ecosystem,
  why: `Safe-Chain refused a package ${why}, so dipo cannot tell which box asked for it`,
});

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
      const mark = await markSafeChain(boxes, BOX, systemClock);
      // The route's own check refused safe-chain-test before the session: not the session's.
      expect(mark).toMatchObject({ box: BOX, lines: { npm: 3, pypi: 1 } });
      // The box's clock is the Mac's here: the range holds 0 and is narrow.
      expect(mark.clock?.low ?? 1).toBeLessThanOrEqual(0);
      expect(mark.clock?.high ?? -1).toBeGreaterThanOrEqual(0);
      expect((mark.clock?.high ?? 0) - (mark.clock?.low ?? -9_999)).toBeLessThan(2_000);
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
      expect(await readSafeChain(boxes, BOX, mark, reader())).toEqual({
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
      const quiet = await markSafeChain(boxes, BOX, systemClock);
      expect(await readSafeChain(boxes, BOX, quiet, reader())).toEqual({
        refusals: [],
        unknown: [],
      });
    }));

  it("keeps a log as unknown when the Safe-Chain box is another than at the session's start", () =>
    logs(async (dir) => {
      const boxes = boxesIn(dir);
      const mark: SafeChainMark = {
        box: "dipo-safe-chain-gone",
        lines: { npm: 0, pypi: 0 },
        clock: { low: 0, high: 0 },
        markedAt: 0,
      };
      const found = await readSafeChain(boxes, BOX, mark, reader());
      expect(found.refusals).toEqual([]);
      expect(found.unknown).toEqual([
        { ecosystem: "npm", why: "the Safe-Chain box it ran with is gone, and its log with it" },
        { ecosystem: "pypi", why: "the Safe-Chain box it ran with is gone, and its log with it" },
      ]);
      // No route runs now: the same.
      expect((await readSafeChain(boxes, null, mark, reader(null))).unknown).toHaveLength(2);
      expect(boxes.calls).toEqual([]);
    }));

  it("keeps a log as unknown when it could not be counted at the start or read at the end", () =>
    logs(async (dir) => {
      const failing = boxesIn(dir, { fail: true });
      // No count at the start: the end reads nothing and says so.
      const unmarked = await markSafeChain(failing, BOX, systemClock);
      expect(unmarked).toEqual({
        box: BOX,
        lines: { npm: null, pypi: null },
        clock: null,
        markedAt: null,
      });
      expect((await readSafeChain(boxesIn(dir), BOX, unmarked, reader())).unknown).toEqual([
        { ecosystem: "npm", why: "its Safe-Chain log could not be read when the session started" },
        { ecosystem: "pypi", why: "its Safe-Chain log could not be read when the session started" },
      ]);
      expect(await markSafeChain(failing, null, systemClock)).toEqual({
        box: null,
        lines: { npm: null, pypi: null },
        clock: null,
        markedAt: null,
      });
      // A call that fails at the end, and a log that is gone at the end.
      const mark = await markSafeChain(boxesIn(dir), BOX, systemClock);
      expect((await readSafeChain(failing, BOX, mark, reader())).unknown).toEqual([
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
      const found = await readSafeChain(boxesIn(dir), BOX, mark, reader());
      expect(found.unknown).toEqual([
        { ecosystem: "pypi", why: "its Safe-Chain log could not be read (exit 3)" },
      ]);
    }));

  it("keeps a log as unknown, not as no refusals, when it holds fewer lines than at the mark", () =>
    logs(async (dir) => {
      const boxes = boxesIn(dir);
      const mark = await markSafeChain(boxes, BOX, systemClock);
      // The log was cut or replaced in the same box: a refusal written since is not lost unseen.
      writeFileSync(join(dir, "npm.ndjson"), ROUTE_CHECK.split("\n")[0] + "\n");
      expect(await readSafeChain(boxes, BOX, mark, reader())).toEqual({
        refusals: [],
        unknown: [
          {
            ecosystem: "npm",
            why: "its Safe-Chain log holds fewer lines than when the session started, so it was cut or replaced",
          },
        ],
      });
      // As long as at the mark: nothing new, and nothing unknown.
      writeFileSync(join(dir, "npm.ndjson"), "a\nb\nc\n");
      expect(await readSafeChain(boxes, BOX, mark, reader())).toEqual({
        refusals: [],
        unknown: [],
      });
    }));

  it("bounds each count and read by a short deadline, and a log past it is unknown", async () => {
    expect(SAFE_CHAIN_LOG_READ_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
    const deadlines: (number | undefined)[] = [];
    const slow = {
      async exec(
        _name: string,
        _command: readonly [string, ...string[]],
        options?: BoxExecOptions,
      ): Promise<BoxExecResult> {
        deadlines.push(options?.timeoutMs);
        throw new BoxError("box.timedOut", "the exec ran past its deadline");
      },
    };
    expect(await markSafeChain(slow, BOX, systemClock)).toEqual({
      box: BOX,
      lines: { npm: null, pypi: null },
      clock: null,
      markedAt: null,
    });
    const found = await readSafeChain(
      slow,
      BOX,
      { box: BOX, lines: { npm: 0, pypi: 0 }, clock: { low: 0, high: 0 }, markedAt: 0 },
      reader(),
    );
    expect(found).toEqual({
      refusals: [],
      unknown: [
        {
          ecosystem: "npm",
          why: "its Safe-Chain log could not be read: the exec ran past its deadline",
        },
        {
          ecosystem: "pypi",
          why: "its Safe-Chain log could not be read: the exec ran past its deadline",
        },
      ],
    });
    // Two per mark, two per read, each with the short deadline.
    expect(deadlines).toEqual(Array(4).fill(SAFE_CHAIN_LOG_READ_TIMEOUT_MS));
  });
});

/** The npm tarball of `name` at 1.0.0. */
const url = (name: string) => `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`;

/**
 * A ledger of registry tunnels of npm, each `[client, opened, closed]` by the Mac's ms: its clock
 * reads each close's time when that tunnel closes.
 */
function ledger(spans: ReadonlyArray<readonly [string | null, number, number]>): RegistryTunnels {
  let closeAt = 0;
  const tunnels = new RegistryTunnels({ now: () => closeAt });
  for (const [client, opened, closed] of spans) {
    const close = tunnels.opened(client, "npm", opened);
    closeAt = closed;
    close();
  }
  return tunnels;
}

/** A mark as `markSafeChain` takes it, of a session that started a minute ago. */
async function startedAMinuteAgo(boxes: ReturnType<typeof boxesIn>): Promise<SafeChainMark> {
  const mark = await markSafeChain(boxes, BOX, systemClock);
  return { ...mark, markedAt: (mark.markedAt ?? 0) - 60_000 };
}

describe("the refusals of one session's own box (DIPO-396)", () => {
  it("keeps two scoped packages with the same base name each on the run of the box that asked", () =>
    logs(async (dir) => {
      const boxes = boxesIn(dir);
      const mark = await startedAMinuteAgo(boxes);
      const now = systemClock.now();
      const tunnels = ledger([
        [CLIENT, now - 40_000, now - 39_000],
        ["dipo-run_b", now - 30_000, now - 29_000],
      ]);
      // Both malware lines before either Blocking line: a pair by base name would swap them.
      appendFileSync(
        join(dir, "npm.ndjson"),
        logLine("Safe-chain: Package @a/foo@1.0.0 is marked as malware: MALWARE", now - 39_500) +
          logLine(
            "Safe-chain: Package @b/foo@1.0.0 is marked as malware: PROTESTWARE",
            now - 39_400,
          ) +
          logLine(
            "Safe-chain: Blocking request to https://registry.npmjs.org/@a/foo/-/foo-1.0.0.tgz",
            now - 39_300,
          ) +
          logLine(
            "Safe-chain: Blocking request to https://registry.npmjs.org/@b/foo/-/foo-1.0.0.tgz",
            now - 29_500,
          ),
      );
      const of = (client: string) =>
        readSafeChain(boxes, BOX, mark, { clock: systemClock, client, tunnels });
      expect(await of(CLIENT)).toEqual({
        refusals: [
          {
            ecosystem: "npm",
            package: "@a/foo@1.0.0",
            reason: "Aikido's malware list marks it MALWARE",
          },
        ],
        unknown: [],
      });
      expect(await of("dipo-run_b")).toEqual({
        refusals: [
          {
            ecosystem: "npm",
            package: "@b/foo@1.0.0",
            reason: "Aikido's malware list marks it PROTESTWARE",
          },
        ],
        unknown: [],
      });
    }));

  it("keeps a refusal from before the session's mark as unknown: the box's clock jumped and came back", () =>
    logs(async (dir) => {
      const boxes = boxesIn(dir);
      // The clock agrees at the mark and at the read.
      const mark = await markSafeChain(boxes, BOX, systemClock);
      const now = systemClock.now();
      const tunnels = ledger([[CLIENT, now - 3_600_000, now]]);
      // Written after the mark, by its line, but stamped ten minutes before it.
      appendFileSync(join(dir, "npm.ndjson"), malwareLines("x@1.0.0", url("x"), now - 600_000));
      expect(
        await readSafeChain(boxes, BOX, mark, { clock: systemClock, client: CLIENT, tunnels }),
      ).toEqual({
        refusals: [],
        unknown: [
          untied(
            "npm",
            "at a time outside the session, while the Safe-Chain box's clock moved against the Mac's",
          ),
        ],
      });
    }));

  it("keeps only the refusals its box asked for: another box's are left out, a shared span's unknown", () =>
    logs(async (dir) => {
      const boxes = boxesIn(dir);
      const mark = await startedAMinuteAgo(boxes);
      const now = systemClock.now();
      // Its box, then another box, then both at once, then a tunnel with no admitted password.
      const tunnels = ledger([
        [CLIENT, now - 40_000, now - 39_000],
        ["dipo-run_b", now - 30_000, now - 29_000],
        [CLIENT, now - 20_000, now - 19_000],
        ["dipo-run_b", now - 20_000, now - 19_000],
        [null, now - 10_000, now - 9_000],
      ]);
      appendFileSync(
        join(dir, "npm.ndjson"),
        malwareLines("own@1.0.0", url("own"), now - 39_500) +
          malwareLines("theirs@1.0.0", url("theirs"), now - 29_500) +
          malwareLines("both@1.0.0", url("both"), now - 19_500) +
          malwareLines("nobody@1.0.0", url("nobody"), now - 9_500) +
          malwareLines("idle@1.0.0", url("idle"), now - 5_000),
      );
      const found = await readSafeChain(boxes, BOX, mark, {
        clock: systemClock,
        client: CLIENT,
        tunnels,
      });
      expect(found.refusals).toEqual([
        {
          ecosystem: "npm",
          package: "own@1.0.0",
          reason: "Aikido's malware list marks it MALWARE",
        },
      ]);
      expect(found.unknown).toEqual([
        untied("npm", "while more than one box had a registry tunnel open"),
        untied("npm", "while a registry tunnel that named no box dipo admitted was open"),
        untied("npm", "while no box had a registry tunnel open"),
      ]);
      // The other box's session reads the same lines and keeps only its own.
      const theirs = await readSafeChain(boxes, BOX, mark, {
        clock: systemClock,
        client: "dipo-run_b",
        tunnels,
      });
      expect(theirs.refusals.map((refusal) => refusal.package)).toEqual(["theirs@1.0.0"]);
      expect(theirs.unknown).toEqual(found.unknown);
      expect(JSON.stringify([found, theirs])).not.toMatch(/both|nobody|idle/);
    }));

  it("keeps every refusal as unknown when the box's clock cannot be read or moved during the session", () =>
    logs(async (dir) => {
      const mark = await markSafeChain(boxesIn(dir), BOX, systemClock);
      appendFileSync(join(dir, "npm.ndjson"), ROUTE_CHECK);
      for (const [clock, why] of [
        [() => "not-a-time", "while the Safe-Chain box's clock could not be read"],
        // A minute ahead at the end of the session: its clock moved.
        [
          () => ((systemClock.now() + 60_000) / 1_000).toFixed(9),
          "while the Safe-Chain box's clock moved against the Mac's",
        ],
      ] as const) {
        expect(await readSafeChain(boxesIn(dir, { clock }), BOX, mark, reader())).toEqual({
          refusals: [],
          unknown: [untied("npm", why)],
        });
      }
      // A clock that could not be read at the start: the same.
      const unclocked = await markSafeChain(boxesIn(dir, { clock: () => "x" }), BOX, systemClock);
      expect(unclocked.clock).toBeNull();
      appendFileSync(join(dir, "npm.ndjson"), ROUTE_CHECK);
      expect((await readSafeChain(boxesIn(dir), BOX, unclocked, reader())).unknown).toEqual([
        untied("npm", "while the Safe-Chain box's clock could not be read"),
      ]);
      // No registry tunnels known: never a refusal of this box.
      const later = await markSafeChain(boxesIn(dir), BOX, systemClock);
      appendFileSync(join(dir, "npm.ndjson"), ROUTE_CHECK);
      expect(await readSafeChain(boxesIn(dir), BOX, later, reader(null))).toEqual({
        refusals: [],
        unknown: [untied("npm", "longer ago than dipo keeps its registry tunnels")],
      });
    }));
});
