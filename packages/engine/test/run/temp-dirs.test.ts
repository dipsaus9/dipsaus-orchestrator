// Run temp directories (DIPO-102): `<tmpRoot>/dipo-run-<run id>` goes once its run ended and its
// worker hosts exited, swept after each worker exit (`ended`) and at daemon start (`recovery`).
// Live, held and re-attachable runs keep theirs; only real directories directly under the temp
// root are removed, never through a link; an unknown run's directory goes only at daemon start and
// only when this daemon's database made it.

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RunId } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import type { OfficeHandle } from "../../src/db/office";
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
             branch, worktree, budget_unit, budget_limit, loop_cap, config_hash, started_at,
             ended_at, end_kind)
           values ($office_id, $run, 'story', $key, 'DIPO-1', 'M', 'developer', 'haiku', 'a',
             'DIPO-1/x', '/trees/DIPO-1', 'tokens', 1, 3, 'h', 0, $ended, $kind)`,
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
          `insert into claims (office_id, run_id, key, story_id, branch, worktree, base, base_sha,
             start_sha, reused, admin_dir, snap_commondir, snap_gitdir, snap_pointer, claimed_at,
             released_at)
           values ($office_id, $run, $key, 'DIPO-1', $branch, '/w', 'main', 'a', 'a', 0, '/a', '/c',
             '/g', '/p', 0, $released)`,
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
    expect(wrapped.onPlanWarning).toBeUndefined();
  });
});
