// The update of dipo from its base (DIPO-485): the steps with a stand-in `bun` and a real process
// for each, the refusals, and the bypass forms. Nothing here builds dipo.

import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { CommandError } from "../../src/commands/errors";
import { DaemonLifecycle } from "../../src/create/lifecycle";
import { lifecycleGate } from "../../src/create/surface";
import { createLogger } from "../../src/log/logger";
import { systemClock } from "../../src/platform/clock";
import { systemSpawn } from "../../src/platform/process";
import type { SpawnDetached } from "../../src/platform/process";
import { type BehindFact, SelfUpdate, type UpdateDeps } from "../../src/update/self-update";

const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z00000001" as OfficeId;
const TIP = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
const OTHER_TIP = "ffffffffffffffffffffffffffffffffffffffff";
const COMMIT = TIP.slice(0, 12);

type Build = "ok" | "fail" | "none" | "plain-file" | "garbage" | "other-commit" | "link-out";

interface Stand {
  readonly installExit?: number;
  readonly build?: Build;
}

/** A stand-in for `bun`: logs `cwd argv`, and `run build` writes `dist/dipo` as `build` says. */
function standInBun(dir: string, stand: Stand): string {
  const path = join(dir, "fake-bun");
  const product = join(dir, "product");
  const kind = stand.build ?? "ok";
  const content: Partial<Record<Build, string>> = {
    ok: `#!/bin/sh\necho '{"commit":"${COMMIT}"}'\n`,
    "other-commit": `#!/bin/sh\necho '{"commit":"${OTHER_TIP.slice(0, 12)}"}'\n`,
    garbage: "#!/bin/sh\necho not json\n",
    "plain-file": "#!/bin/sh\necho x\n",
  };
  writeFileSync(product, content[kind] ?? "");
  chmodSync(product, kind === "plain-file" ? 0o644 : 0o755);
  const builds: Record<Build, string> = {
    ok: `cp "${product}" dist/dipo`,
    "other-commit": `cp "${product}" dist/dipo`,
    garbage: `cp "${product}" dist/dipo`,
    "plain-file": `cp "${product}" dist/dipo`,
    "link-out": `ln -s "$OUTSIDE" dist/dipo`,
    fail: "echo 'build exploded' >&2; exit 3",
    none: "true",
  };
  writeFileSync(
    path,
    `#!/bin/sh
echo "$PWD $*" >> "$STAND_LOG"
case "$1 $2" in
  "install --frozen-lockfile") exit ${stand.installExit ?? 0} ;;
  "run build") mkdir -p dist; ${builds[kind]} ;;
esac
`,
  );
  chmodSync(path, 0o755);
  return path;
}

interface Fixture {
  readonly update: SelfUpdate;
  readonly lifecycle: DaemonLifecycle;
  readonly home: string;
  readonly binary: string;
  readonly log: () => string;
  readonly restarts: Parameters<SpawnDetached>[0][];
  readonly added: string[];
  readonly removed: string[];
  readonly outside: string;
}

async function withFixture(
  options: {
    stand?: Stand;
    running?: { stories: number; sessions: number };
    behind?: () => BehindFact | undefined;
    onAdd?: (path: string) => void;
    noBinary?: boolean;
    deps?: Partial<UpdateDeps>;
  },
  body: (f: Fixture) => Promise<void>,
): Promise<void> {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const bin = join(dir, "bin");
    const outside = join(dir, "outside");
    mkdirSync(home);
    mkdirSync(bin);
    mkdirSync(outside);
    const binary = join(bin, "dipo");
    writeFileSync(binary, "#!/bin/sh\necho old\n");
    chmodSync(binary, 0o755);
    const logFile = join(dir, "stand.log");
    writeFileSync(logFile, "");
    const lifecycle = new DaemonLifecycle();
    lifecycle.transition("recovering", "test");
    lifecycle.transition("running", "test");
    const restarts: Parameters<SpawnDetached>[0][] = [];
    const added: string[] = [];
    const removed: string[] = [];
    const update = new SelfUpdate({
      clock: systemClock,
      logger: createLogger({ clock: systemClock, sinks: [], component: "test" }),
      lifecycle,
      spawn: systemSpawn,
      spawnDetached: (spawn) => {
        restarts.push(spawn);
        return { pid: 1 };
      },
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        STAND_LOG: logFile,
        OUTSIDE: join(outside, "elsewhere"),
      },
      home,
      binary: options.noBinary === true ? undefined : binary,
      restartLog: join(dir, "update.log"),
      behind: options.behind ?? (() => ({ commits: 3, tip: TIP, titles: ["a", "b", "c"] })),
      running: () => options.running ?? { stories: 0, sessions: 0 },
      worktrees: {
        add: async (_office, path) => {
          mkdirSync(path, { recursive: true });
          added.push(path);
          options.onAdd?.(path);
        },
        remove: async (_office, path) => {
          removed.push(path);
        },
      },
      bun: standInBun(dir, options.stand ?? {}),
      ...options.deps,
    });
    writeFileSync(join(outside, "elsewhere"), '#!/bin/sh\necho \'{"commit":"' + COMMIT + "\"}'\n");
    chmodSync(join(outside, "elsewhere"), 0o755);
    await body({
      update,
      lifecycle,
      home,
      binary,
      log: () => readFileSync(logFile, "utf8"),
      restarts,
      added,
      removed,
      outside,
    });
  });
}

async function refusal(promise: Promise<unknown>): Promise<CommandError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CommandError) return error;
    throw error;
  }
  throw new Error("the update was expected to be refused");
}

const OLD = "#!/bin/sh\necho old\n";

describe("SelfUpdate.run (DIPO-485)", () => {
  it("pauses starts, builds the pinned commit in a worktree of dipo's home and swaps the binary", async () => {
    let during: { updating: boolean; start: string | undefined } | null = null;
    let lifecycleRef: DaemonLifecycle | null = null;
    await withFixture(
      {
        onAdd: () => {
          const gate =
            lifecycleRef === null ? null : lifecycleGate(lifecycleRef, "command", "work.run");
          during = { updating: lifecycleRef?.updating ?? false, start: gate?.code };
        },
      },
      async (f) => {
        lifecycleRef = f.lifecycle;
        const before = statSync(f.binary).ino;
        const result = await f.update.run(OFFICE);
        expect(result).toEqual({ commit: COMMIT, commits: 3 });
        // New starts were refused while it ran, as "dipo is updating".
        expect(during).toEqual({ updating: true, start: "daemon.updating" });
        // Install and build ran in the worktree under dipo's home, install frozen.
        const worktree = join(f.home, "update", COMMIT);
        const lines = f.log().trim().split("\n");
        expect(lines.map((line) => line.replace(/^\S+ /, ""))).toEqual([
          "install --frozen-lockfile",
          "run build",
        ]);
        for (const line of lines)
          expect(line.startsWith(`${join(realpathSync(join(f.home, "update")), COMMIT)} `)).toBe(
            true,
          );
        // A new file moved over the old binary: another inode, the built content.
        expect(statSync(f.binary).ino).not.toBe(before);
        expect(readFileSync(f.binary, "utf8")).toContain(COMMIT);
        expect(statSync(f.binary).mode & 0o111).not.toBe(0);
        // `dipo daemon restart` from the new binary, detached; the worktree is gone.
        expect(f.restarts.map((spawn) => spawn.cmd)).toEqual([[f.binary, "daemon", "restart"]]);
        expect(f.removed).toEqual(f.added);
        expect(existsSync(worktree)).toBe(false);
        // The pause stays until the daemon is replaced.
        expect(f.lifecycle.updating).toBe(true);
      },
    );
  });

  it("keeps the pause held after success and refuses a second update", async () => {
    await withFixture({}, async (f) => {
      await f.update.run(OFFICE);
      const error = await refusal(f.update.run(OFFICE));
      expect(error.error.code).toBe("update.refused");
      expect(error.error.details).toEqual({ reason: "updating" });
    });
  });

  it("is refused while a story run or a session is open, and changes nothing", async () => {
    for (const running of [
      { stories: 1, sessions: 0 },
      { stories: 0, sessions: 1 },
    ]) {
      await withFixture({ running }, async (f) => {
        const error = await refusal(f.update.run(OFFICE));
        expect(error.error.code).toBe("update.refused");
        expect(error.error.details).toEqual({ reason: "busy" });
        expect(error.error.message).toMatch(/story run|session/);
        expect(readFileSync(f.binary, "utf8")).toBe(OLD);
        expect(f.lifecycle.updating).toBe(false);
        expect(f.added).toEqual([]);
        expect(f.restarts).toEqual([]);
      });
    }
  });

  it("is refused when the base has no engine commits, and from source", async () => {
    await withFixture({ behind: () => undefined }, async (f) => {
      expect((await refusal(f.update.run(OFFICE))).error.details).toEqual({ reason: "current" });
      expect(f.lifecycle.updating).toBe(false);
    });
    await withFixture({ noBinary: true }, async (f) => {
      expect((await refusal(f.update.run(OFFICE))).error.details).toEqual({
        reason: "unavailable",
      });
    });
  });

  it("refuses a start asked for during the build, and accepts it again after a failure", async () => {
    let codes: (string | undefined)[] = [];
    let ref: DaemonLifecycle | null = null;
    await withFixture(
      {
        stand: { build: "fail" },
        onAdd: () => {
          codes = ["work.run", "nextUp.confirm", "work.resume", "planning.start", "story.park"].map(
            (name) => (ref === null ? undefined : lifecycleGate(ref, "command", name)?.code),
          );
        },
      },
      async (f) => {
        ref = f.lifecycle;
        await refusal(f.update.run(OFFICE));
        expect(codes).toEqual([
          "daemon.updating",
          "daemon.updating",
          "daemon.updating",
          "daemon.updating",
          undefined,
        ]);
        // The pause lifted: a start is accepted again.
        expect(lifecycleGate(f.lifecycle, "command", "work.run")).toBeNull();
      },
    );
  });

  it("keeps the old binary and lifts the pause when the frozen install fails (lockfile mismatch)", async () => {
    await withFixture({ stand: { installExit: 1 } }, async (f) => {
      const error = await refusal(f.update.run(OFFICE));
      expect(error.error.code).toBe("update.failed");
      expect(error.error.message).toContain("install failed");
      expect(f.log().trim().split("\n")).toHaveLength(1);
      expect(readFileSync(f.binary, "utf8")).toBe(OLD);
      expect(f.lifecycle.updating).toBe(false);
      expect(f.restarts).toEqual([]);
      expect(f.removed).toEqual(f.added);
    });
  });

  it("builds the commit it pinned when the base moves during the build", async () => {
    let moved = false;
    await withFixture(
      {
        behind: () =>
          moved
            ? { commits: 5, tip: OTHER_TIP, titles: [] }
            : { commits: 3, tip: TIP, titles: ["a"] },
        onAdd: () => {
          moved = true;
        },
      },
      async (f) => {
        const result = await f.update.run(OFFICE);
        expect(result.commit).toBe(COMMIT);
        expect(readFileSync(f.binary, "utf8")).toContain(COMMIT);
        expect(f.added[0]?.endsWith(COMMIT)).toBe(true);
      },
    );
  });

  const bad: readonly (readonly [string, Build, RegExp])[] = [
    ["a failing build", "fail", /build failed .*build exploded/s],
    ["a build that writes no binary", "none", /wrote no dist\/dipo/],
    ["a build output that is no executable", "plain-file", /not an executable file/],
    ["a build output that prints no version", "garbage", /printed no version/],
    ["a build output that reports another commit", "other-commit", /reports commit/],
    ["a build output that is a link out of the worktree", "link-out", /link out of the build/],
  ];
  for (const [name, build, message] of bad) {
    it(`keeps the old binary on ${name}`, async () => {
      await withFixture({ stand: { build } }, async (f) => {
        const error = await refusal(f.update.run(OFFICE));
        expect(error.error.code).toBe("update.failed");
        expect(error.error.message).toMatch(message);
        expect(readFileSync(f.binary, "utf8")).toBe(OLD);
        expect(f.lifecycle.updating).toBe(false);
        expect(f.restarts).toEqual([]);
        expect(f.removed).toEqual(f.added);
      });
    });
  }

  it("refuses an update folder that links out of dipo's home", async () => {
    await withFixture({}, async (f) => {
      symlinkSync(f.outside, join(f.home, "update"));
      const error = await refusal(f.update.run(OFFICE));
      expect(error.error.code).toBe("update.failed");
      expect(error.error.message).toContain("is a link");
      expect(f.added).toEqual([]);
      expect(readFileSync(f.binary, "utf8")).toBe(OLD);
      expect(f.lifecycle.updating).toBe(false);
    });
  });

  it("refuses a worktree path that is a link, leaving what it points at alone", async () => {
    await withFixture({}, async (f) => {
      mkdirSync(join(f.home, "update"));
      symlinkSync(f.outside, join(f.home, "update", COMMIT));
      const error = await refusal(f.update.run(OFFICE));
      expect(error.error.code).toBe("update.failed");
      expect(existsSync(join(f.outside, "elsewhere"))).toBe(true);
      expect(f.added).toEqual([]);
      expect(readFileSync(f.binary, "utf8")).toBe(OLD);
    });
  });

  it("refuses a worktree that resolves outside dipo's home after the checkout", async () => {
    await withFixture(
      {
        onAdd: (path) => {
          // The checkout turned its own folder into a link out of the home.
          writeFileSync(join(path, "marker"), "x");
        },
        deps: {
          worktrees: {
            add: async (_office, path) => {
              symlinkSync(join(path, "..", "..", "..", "outside"), path);
            },
            remove: async () => {},
          },
        },
      },
      async (f) => {
        const error = await refusal(f.update.run(OFFICE));
        expect(error.error.code).toBe("update.failed");
        expect(error.error.message).toContain("outside dipo's home");
        expect(readFileSync(f.binary, "utf8")).toBe(OLD);
        expect(existsSync(join(f.outside, "elsewhere"))).toBe(true);
      },
    );
  });

  it("says so when the restart cannot start after the swap, and lifts the pause", async () => {
    await withFixture(
      {
        deps: {
          spawnDetached: () => {
            throw new Error("no fork");
          },
        },
      },
      async (f) => {
        const error = await refusal(f.update.run(OFFICE));
        expect(error.error.message).toContain("dipo daemon restart");
        expect(f.lifecycle.updating).toBe(false);
      },
    );
  });
});

describe("SelfUpdate.offer (DIPO-485)", () => {
  it("offers the update when behind and idle, with the commits' titles", async () => {
    await withFixture({}, async (f) => {
      expect(f.update.offer(OFFICE)).toEqual({ commits: 3, titles: ["a", "b", "c"] });
    });
  });

  it("offers nothing while a run or a session is open, when current, or while updating", async () => {
    await withFixture({ running: { stories: 1, sessions: 0 } }, async (f) => {
      expect(f.update.offer(OFFICE)).toBeNull();
    });
    await withFixture({ running: { stories: 0, sessions: 1 } }, async (f) => {
      expect(f.update.offer(OFFICE)).toBeNull();
    });
    await withFixture({ behind: () => ({ commits: 0, tip: TIP, titles: [] }) }, async (f) => {
      expect(f.update.offer(OFFICE)).toBeNull();
    });
    await withFixture({}, async (f) => {
      f.lifecycle.beginUpdate();
      expect(f.update.offer(OFFICE)).toBeNull();
    });
  });
});
