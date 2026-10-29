// Run temp directories (DIPO-102): `<tmpRoot>/dipo-run-<run id>` goes once its run ended and its
// worker hosts exited, swept after each worker exit (`ended`) and at daemon start (`recovery`).
// Live, held and re-attachable runs keep theirs; only real directories directly under the temp
// root are removed, never through a link; an unknown run's directory goes only at daemon start and
// only when this daemon's database made it. Each run's short temp root `<tmpRoot>/dipo-t-<hash>`
// (DIPO-118) goes with it, mapped to its run by its run file and its name. At daemon start the
// output folders of spawned children a crash left (`dipo-out-*`, DIPO-333) go once nothing in them
// changed for a few minutes.

import { describe, expect, it } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { RunId } from "@dipsaus-orchestrator/contract";
import { MAX_TEMP_ROOT_BYTES, ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import type { OfficeHandle } from "../../src/db/office";
import { OUTPUT_DIR_PREFIX, OUTPUT_SWEEP_AGE_MS } from "../../src/platform/output-files";
import type { ProcessInfo, ProcessProbe } from "../../src/platform/process";
import {
  afterRunExits,
  prepareRunTempDir,
  readRunTempOwner,
  removeRunTempDir,
  RUN_TEMP_OWNER_FILE,
  RunTempDirs,
  runTempDir,
  runTempOwner,
  type RunOutcomesPort,
} from "../../src/run";
import {
  prepareRunTempDirs,
  prepareShortTempDir,
  readShortTempRun,
  removeShortTempDir,
  SHORT_TEMP_MAX_BYTES,
  SHORT_TEMP_RUN_FILE,
  shortTempDir,
} from "../../src/run/temp-dirs";
import { recordWorkerHost } from "../../src/runs/worker-hosts";
import { addOffice, openTestState, type TestState } from "../commands/helpers";

const DEAD: ProcessProbe = async () => null;
const ALIVE: ProcessProbe = async (pid): Promise<ProcessInfo> => ({
  pid,
  startTimeMs: 0,
  zombie: false,
  command: "dipo host",
});

interface Fixture {
  readonly t: TestState;
  readonly office: OfficeHandle;
  readonly tmpRoot: string;
  readonly dirs: (probe?: ProcessProbe) => RunTempDirs;
  /** A run row; ended when `endedAt` is given. */
  readonly run: (options?: { endedAt?: number }) => RunId;
  /** A worker host row of `run`; exited when `exited`. */
  readonly host: (run: RunId, exited: boolean) => void;
  readonly claim: (run: string, released: boolean) => void;
  /** Makes the run temp directory with a file inside, as a worker would. */
  readonly make: (run: string, owner?: string) => string;
}

async function fixture(dir: string): Promise<Fixture> {
  const t = await openTestState(dir);
  const office = addOffice(t);
  const tmpRoot = join(dir, "tmp");
  mkdirSync(tmpRoot);
  return {
    t,
    office,
    tmpRoot,
    dirs: (probe = DEAD) => new RunTempDirs({ tmpRoot, database: () => t.state, probe }),
    run: (options = {}) => {
      const run = t.ids.next("run") as RunId;
      office.immediate(() =>
        office.run(
          `insert into runs (office_id, run_id, kind, key, story_id, tier, role, model, start_sha,
             branch, budget_unit, budget_limit, loop_cap, config_hash, started_at, ended_at,
             end_kind)
           values ($office_id, $run, 'story', $key, 'DIPO-1', 'M', 'developer', 'haiku', 'a',
             'DIPO-1/x', 'tokens', 1, 3, 'h', 0, $ended, $kind)`,
          {
            run,
            key: `sto-${run}`,
            ended: options.endedAt ?? null,
            kind: options.endedAt === undefined ? null : "in-review",
          },
        ),
      );
      return run;
    },
    host: (run, exited) => {
      const agent = t.ids.next("agt");
      recordWorkerHost(
        office,
        {
          pid: 4242,
          startTimeMs: 0,
          runId: run,
          agentId: agent,
          socketPath: join(dir, `${agent}.sock`),
          protocolVersion: 1,
          runDir: join(dir, "runs", run),
          eventFile: join(dir, "runs", run, "events.ndjson"),
        },
        t.clock,
      );
      if (exited) {
        office.immediate(() =>
          office.run(
            `update worker_hosts set exit_code = 0 where office_id = $office_id and agent_id = $agent`,
            { agent },
          ),
        );
      }
    },
    claim: (run, released) =>
      office.immediate(() =>
        office.run(
          `insert into claims (office_id, run_id, key, story_id, branch, base, base_sha,
             start_sha, reused, claimed_at, released_at)
           values ($office_id, $run, $key, 'DIPO-1', $branch, 'main', 'a', 'a', 0, 0, $released)`,
          { run, key: `sto-${run}`, branch: `DIPO-1/${run}`, released: released ? 1 : null },
        ),
      ),
    make: (run, owner) => {
      const tmpDir = runTempDir(tmpRoot, run);
      prepareRunTempDir(tmpDir, owner);
      mkdirSync(join(tmpDir, "caches", "npm"), { recursive: true });
      writeFileSync(join(tmpDir, "caches", "npm", "index"), "cached\n");
      return tmpDir;
    },
  };
}

describe("removeRunTempDir", () => {
  it("removes a real dipo-run directory and never follows a link inside it", () =>
    withTempDir((dir) => {
      const outside = join(dir, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "keep"), "keep\n");
      const tmpDir = runTempDir(dir, "run_1");
      prepareRunTempDir(tmpDir, undefined);
      symlinkSync(outside, join(tmpDir, "link"));
      symlinkSync(join(outside, "keep"), join(tmpDir, "file-link"));

      expect(removeRunTempDir(dir, "run_1")).toBe(true);
      expect(existsSync(tmpDir)).toBe(false);
      expect(readFileSync(join(outside, "keep"), "utf8")).toBe("keep\n");
    }));

  it("leaves a dipo-run link, a file and a name that is not a run id", () =>
    withTempDir((dir) => {
      const target = join(dir, "target");
      mkdirSync(target);
      writeFileSync(join(target, "keep"), "keep\n");
      symlinkSync(target, runTempDir(dir, "run_link"));
      writeFileSync(runTempDir(dir, "run_file"), "x");
      mkdirSync(join(dir, "dipo-run-a"));
      mkdirSync(join(dir, "sub"));

      expect(removeRunTempDir(dir, "run_link")).toBe(false);
      expect(removeRunTempDir(dir, "run_file")).toBe(false);
      expect(removeRunTempDir(dir, "../sub")).toBe(false);
      expect(removeRunTempDir(dir, "a/..")).toBe(false);
      expect(existsSync(join(target, "keep"))).toBe(true);
      expect(existsSync(runTempDir(dir, "run_file"))).toBe(true);
      expect(existsSync(join(dir, "sub"))).toBe(true);
    }));

  it("leaves a directory another uid owns", () =>
    withTempDir((dir) => {
      prepareRunTempDir(runTempDir(dir, "run_2"), undefined);
      const other = (process.getuid?.() ?? 0) + 1;
      expect(removeRunTempDir(dir, "run_2", other)).toBe(false);
      expect(existsSync(runTempDir(dir, "run_2"))).toBe(true);
    }));
});

describe("the owner file", () => {
  it("names the database and replaces a link instead of writing through it", () =>
    withTempDir((dir) => {
      const victim = join(dir, "victim");
      writeFileSync(victim, "precious\n");
      const tmpDir = runTempDir(dir, "run_3");
      mkdirSync(tmpDir, { mode: 0o700 });
      symlinkSync(victim, join(tmpDir, RUN_TEMP_OWNER_FILE));

      prepareRunTempDir(tmpDir, "owner-a");
      expect(readFileSync(victim, "utf8")).toBe("precious\n");
      expect(readRunTempOwner(tmpDir)).toBe("owner-a");
      expect(runTempOwner("/state/dipo.db")).not.toBe(runTempOwner("/other/dipo.db"));
    }));

  it("is not read through a link", () =>
    withTempDir((dir) => {
      const tmpDir = runTempDir(dir, "run_4");
      mkdirSync(tmpDir, { mode: 0o700 });
      writeFileSync(join(dir, "forged"), "owner-a\n");
      symlinkSync(join(dir, "forged"), join(tmpDir, RUN_TEMP_OWNER_FILE));
      expect(readRunTempOwner(tmpDir)).toBeNull();
    }));
});

describe("the sweep after a worker exit (ended)", () => {
  it("removes the directory of an ended run whose hosts exited", () =>
    withTempDir(async (dir) => {
      const f = await fixture(dir);
      const run = f.run({ endedAt: 1 });
      f.host(run, true);
      const tmpDir = f.make(run);

      expect(await f.dirs().sweep("ended")).toEqual([tmpDir]);
      expect(existsSync(tmpDir)).toBe(false);
    }));

  it("keeps a live run's directory, and an ended run's while its host still runs", () =>
    withTempDir(async (dir) => {
      const f = await fixture(dir);
      const live = f.run();
      f.claim(live, false);
      f.host(live, false);
      const ending = f.run({ endedAt: 1 });
      f.host(ending, false);
      const liveDir = f.make(live);
      const endingDir = f.make(ending);

      expect(await f.dirs(ALIVE).sweep("ended")).toEqual([]);
      expect(existsSync(liveDir)).toBe(true);
      expect(existsSync(endingDir)).toBe(true);

      // Once its host is gone the ended run's directory goes; the live run keeps its own.
      expect(await f.dirs(DEAD).sweep("ended")).toEqual([endingDir]);
      expect(existsSync(liveDir)).toBe(true);
    }));

  it("keeps the directory of a parked run that reopens while the sweep checks its host", () =>
    withTempDir(async (dir) => {
      const f = await fixture(dir);
      const run = f.run({ endedAt: 1 });
      f.host(run, false);
      const tmpDir = f.make(run);
      // The answer to the park reopens the run (DIPO-75) while the host is being probed.
      const reopening: ProcessProbe = async () => {
        f.office.immediate(() =>
          f.office.run(
            "update runs set ended_at = null where office_id = $office_id and run_id = $run",
            { run },
          ),
        );
        return null;
      };

      expect(await f.dirs(reopening).sweep("ended")).toEqual([]);
      expect(existsSync(tmpDir)).toBe(true);
    }));

  it("never removes an unknown run's directory, even its own", () =>
    withTempDir(async (dir) => {
      const f = await fixture(dir);
      const dirs = f.dirs();
      const tmpDir = f.make("run_01UNKNOWN", dirs.owner());

      expect(await dirs.sweep("ended")).toEqual([]);
      expect(existsSync(tmpDir)).toBe(true);
    }));
});

describe("the sweep at daemon start (recovery)", () => {
  it("removes ended and unknown runs of this daemon and keeps live, re-attachable and foreign ones", () =>
    withTempDir(async (dir) => {
      const f = await fixture(dir);
      const dirs = f.dirs(ALIVE);
      const owner = dirs.owner();
      expect(owner).toBe(runTempOwner(f.t.state.connection.path));

      // A run re-attach follows again: not ended, its host alive.
      const live = f.run();
      f.claim(live, false);
      f.host(live, false);
      // A held run between sessions: not ended, its host exited.
      const held = f.run();
      f.claim(held, false);
      f.host(held, true);
      const ended = f.run({ endedAt: 1 });
      f.host(ended, true);
      // A claim whose setup was under way, and one rolled back, both without a run row.
      const claiming = "run_01CLAIMING";
      f.claim(claiming, false);
      const rolledBack = "run_01ROLLEDBACK";
      f.claim(rolledBack, true);

      const keep = [
        f.make(live, owner),
        f.make(held, owner),
        f.make(claiming, owner),
        f.make("run_01FOREIGN", "another-daemon"),
        f.make("run_01NOOWNER"),
      ];
      const gone = [f.make(ended, owner), f.make(rolledBack, owner), f.make("run_01MINE", owner)];

      expect((await dirs.sweep("recovery")).toSorted()).toEqual(gone.toSorted());
      for (const path of keep) expect(existsSync(path)).toBe(true);
      for (const path of gone) expect(existsSync(path)).toBe(false);
    }));

  it("removes this user's output folders left by a crash once they are old enough (DIPO-333)", () =>
    withTempDir(async (dir) => {
      const f = await fixture(dir);
      const clock = new ManualClock();
      const dirs = new RunTempDirs({
        tmpRoot: f.tmpRoot,
        database: () => f.t.state,
        probe: DEAD,
        clock,
      });
      /** An output folder whose folder and files last changed `age` ms before the clock. */
      const output = (name: string, age: number, fileAge = age): string => {
        const path = join(f.tmpRoot, `${OUTPUT_DIR_PREFIX}${name}`);
        mkdirSync(path);
        for (const file of ["stdout", "stderr"]) {
          writeFileSync(join(path, file), "x");
          const at = (clock.now() - fileAge) / 1000;
          utimesSync(join(path, file), at, at);
        }
        utimesSync(path, (clock.now() - age) / 1000, (clock.now() - age) / 1000);
        return path;
      };
      const old = output("old", OUTPUT_SWEEP_AGE_MS + 60_000);
      const fresh = output("fresh", 60_000);
      // An old folder whose output file a running child still writes.
      const writing = output("writing", OUTPUT_SWEEP_AGE_MS + 60_000, 1_000);
      const target = output("target", OUTPUT_SWEEP_AGE_MS + 60_000);
      const link = join(f.tmpRoot, `${OUTPUT_DIR_PREFIX}link`);
      symlinkSync(target, link);
      const file = join(f.tmpRoot, `${OUTPUT_DIR_PREFIX}file`);
      writeFileSync(file, "");
      const unrelated = join(f.tmpRoot, "other-old");
      mkdirSync(unrelated);
      utimesSync(unrelated, 0, 0);

      expect(await dirs.sweep("ended")).toEqual([]);
      expect(existsSync(old)).toBe(true);
      expect((await dirs.sweep("recovery")).toSorted()).toEqual([old, target].toSorted());
      for (const path of [fresh, writing, file, unrelated]) expect(existsSync(path)).toBe(true);
      // The link stays, though the folder it pointed at went as an old folder of its own.
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(existsSync(old)).toBe(false);
    }));

  it("leaves another uid's output folders", () =>
    withTempDir(async (dir) => {
      const f = await fixture(dir);
      const clock = new ManualClock();
      clock.advance(10 * 365 * 24 * 3_600_000);
      const uid = (process.getuid?.() ?? 0) + 1;
      const dirs = new RunTempDirs({
        tmpRoot: f.tmpRoot,
        database: () => f.t.state,
        probe: DEAD,
        clock,
        uid,
      });
      const path = join(f.tmpRoot, `${OUTPUT_DIR_PREFIX}foreign`);
      mkdirSync(path);
      expect(await dirs.sweep("recovery")).toEqual([]);
      expect(existsSync(path)).toBe(true);
    }));

  it("sweeps nothing before the database is open", () =>
    withTempDir(async (dir) => {
      const f = await fixture(dir);
      const tmpDir = f.make("run_01MINE", f.dirs().owner());
      const closed = new RunTempDirs({ tmpRoot: f.tmpRoot, database: () => null, probe: DEAD });
      expect(closed.owner()).toBeUndefined();
      expect(await closed.sweep("recovery")).toEqual([]);
      expect(existsSync(tmpDir)).toBe(true);
    }));
});

/** Both temp directories of `run`, as a launch makes them (DIPO-118). */
function makeBoth(tmpRoot: string, run: string, owner?: string): [string, string] {
  const paths = { tmpDir: runTempDir(tmpRoot, run), shortTmpDir: shortTempDir(tmpRoot, run) };
  prepareRunTempDirs(paths, run, owner);
  writeFileSync(join(paths.shortTmpDir, "test.sock"), "");
  return [paths.tmpDir, paths.shortTmpDir];
}

describe("the short temp root (DIPO-118)", () => {
  const RUN = "run_01JA2B3C4D5E6F7G8H9J0K1M2N";

  it("is at most 37 bytes on macOS and Linux, whatever the run id's length", () => {
    expect(SHORT_TEMP_MAX_BYTES).toBe(MAX_TEMP_ROOT_BYTES);
    for (const run of [RUN, "r", "x".repeat(128)]) {
      expect(Buffer.byteLength(shortTempDir("/private/tmp", run))).toBe(30);
      expect(Buffer.byteLength(shortTempDir("/tmp", run))).toBe(22);
    }
    // The daemon's default temp root, after symlinks, on this machine.
    const real = shortTempDir(realpathSync("/tmp"), RUN);
    expect(Buffer.byteLength(real)).toBeLessThanOrEqual(MAX_TEMP_ROOT_BYTES);
    expect(shortTempDir("/tmp", RUN)).toMatch(/^\/tmp\/dipo-t-[0-9a-f]{10}$/);
    expect(shortTempDir("/tmp", RUN)).not.toBe(shortTempDir("/tmp", `${RUN}X`));
  });

  it("is made 0700 with its run file and owner file, and reused for the same run", () =>
    withTempDir((dir) => {
      const short = shortTempDir(dir, RUN);
      prepareShortTempDir(short, RUN, "owner-a");
      expect(statSync(short).mode & 0o777).toBe(0o700);
      expect(readShortTempRun(short)).toBe(RUN);
      expect(readRunTempOwner(short)).toBe("owner-a");
      writeFileSync(join(short, "keep"), "x");
      prepareShortTempDir(short, RUN, "owner-a");
      expect(existsSync(join(short, "keep"))).toBe(true);
    }));

  it("refuses a link, another run's root with the same name and another uid's directory", () =>
    withTempDir((dir) => {
      const target = join(dir, "target");
      mkdirSync(target);
      const linked = shortTempDir(dir, "run_link");
      symlinkSync(target, linked);
      expect(() => prepareShortTempDir(linked, "run_link", undefined)).toThrow(/not a directory/);
      expect(existsSync(join(target, SHORT_TEMP_RUN_FILE))).toBe(false);

      // Another run's root at this run's path (a hash shared by two run ids).
      const shared = shortTempDir(dir, RUN);
      prepareShortTempDir(shared, "run_other", undefined);
      expect(() => prepareShortTempDir(shared, RUN, undefined)).toThrow(/belongs to run run_other/);
      expect(removeShortTempDir(dir, RUN)).toBe(false);
      expect(existsSync(shared)).toBe(true);

      const owned = shortTempDir(dir, "run_mine");
      const other = (process.getuid?.() ?? 0) + 1;
      mkdirSync(owned, { mode: 0o700 });
      expect(() => prepareShortTempDir(owned, "run_mine", undefined, other)).toThrow(
        /not a directory/,
      );
    }));

  it("replaces a link at the run file instead of writing through it", () =>
    withTempDir((dir) => {
      const victim = join(dir, "victim");
      writeFileSync(victim, "precious\n");
      const short = shortTempDir(dir, RUN);
      mkdirSync(short, { mode: 0o700 });
      symlinkSync(victim, join(short, SHORT_TEMP_RUN_FILE));
      expect(readShortTempRun(short)).toBeNull();
      prepareShortTempDir(short, RUN, undefined);
      expect(readFileSync(victim, "utf8")).toBe("precious\n");
      expect(readShortTempRun(short)).toBe(RUN);
    }));

  it("goes with the run temp directory once the run ended and its hosts exited", () =>
    withTempDir(async (dir) => {
      const f = await fixture(dir);
      const ended = f.run({ endedAt: 1 });
      f.host(ended, true);
      const live = f.run();
      f.claim(live, false);
      f.host(live, false);
      const endedDirs = makeBoth(f.tmpRoot, ended);
      const liveDirs = makeBoth(f.tmpRoot, live);

      expect((await f.dirs(ALIVE).sweep("ended")).toSorted()).toEqual(endedDirs.toSorted());
      for (const path of endedDirs) expect(existsSync(path)).toBe(false);
      for (const path of liveDirs) expect(existsSync(path)).toBe(true);
    }));

  it("goes alone when its run temp directory is already gone, mapped by its run file", () =>
    withTempDir(async (dir) => {
      const f = await fixture(dir);
      const ended = f.run({ endedAt: 1 });
      f.host(ended, true);
      const short = shortTempDir(f.tmpRoot, ended);
      prepareShortTempDir(short, ended, undefined);

      expect(await f.dirs().sweep("ended")).toEqual([short]);
      expect(existsSync(short)).toBe(false);
    }));

  it("stays when its run file is missing, names a run with another hash, or it is a link", () =>
    withTempDir(async (dir) => {
      const f = await fixture(dir);
      const ended = f.run({ endedAt: 1 });
      f.host(ended, true);
      const owner = f.dirs().owner();
      // Named for one run, its run file naming another (ended) run: not that run's.
      const misnamed = shortTempDir(f.tmpRoot, "run_01SOMEONE");
      prepareShortTempDir(misnamed, ended, owner);
      // No run file: nothing maps it to a run by itself.
      const unnamed = shortTempDir(f.tmpRoot, "run_01NOFILE");
      mkdirSync(unnamed, { mode: 0o700 });
      // A link named like a short temp root, to a directory whose run file names the ended run.
      const target = join(dir, "target");
      prepareShortTempDir(target, ended, owner);
      const linked = shortTempDir(f.tmpRoot, ended);
      symlinkSync(target, linked);

      expect(await f.dirs().sweep("recovery")).toEqual([]);
      for (const path of [misnamed, unnamed, linked, target]) expect(existsSync(path)).toBe(true);
    }));

  it("goes at daemon start for an unknown run only when its own owner file names this database", () =>
    withTempDir(async (dir) => {
      const f = await fixture(dir);
      const dirs = f.dirs();
      const owner = dirs.owner();
      const mine = makeBoth(f.tmpRoot, "run_01MINE", owner);
      const foreign = makeBoth(f.tmpRoot, "run_01FOREIGN", "another-daemon");
      const unowned = makeBoth(f.tmpRoot, "run_01NOOWNER");
      // The run temp directory went before; the short temp root of this daemon's run remains.
      const leftover = shortTempDir(f.tmpRoot, "run_01LEFTOVER");
      prepareShortTempDir(leftover, "run_01LEFTOVER", owner);

      expect(await dirs.sweep("ended")).toEqual([]);
      expect((await dirs.sweep("recovery")).toSorted()).toEqual([...mine, leftover].toSorted());
      for (const path of [...foreign, ...unowned]) expect(existsSync(path)).toBe(true);
    }));
});

describe("afterRunExits", () => {
  it("calls back once each exit and lost host is decided, also when the decision throws", async () => {
    const calls: string[] = [];
    const port: RunOutcomesPort = {
      onTurnProblem: async () => undefined,
      onPlanLimit: () => undefined,
      onModelSwitched: () => undefined,
      answered: () => calls.push("answered"),
      onExit: async () => {
        calls.push("exit");
        throw new Error("decision failed");
      },
      onHostLost: async () => {
        calls.push("lost");
      },
    };
    const wrapped = afterRunExits(port, () => calls.push("after"));
    await expect(wrapped.onExit({} as never)).rejects.toThrow("decision failed");
    await wrapped.onHostLost?.({} as never);
    wrapped.answered({} as never);
    expect(calls).toEqual(["exit", "after", "lost", "after", "answered"]);
  });
});
