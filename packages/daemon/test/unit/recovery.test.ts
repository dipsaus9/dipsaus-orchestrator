// Recovery steps (DIPO-68): registration order with the migrations first, `running` or `safe` at
// the end, and a drain during recovery lets the current step finish and runs no further step. An
// unavailable state database (DIPO-111) ends recovery in `recovering`, and `databaseFailure` says
// what to do for each kind of failure.

import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  ChildProcesses,
  createLogger,
  DatabaseTooNewError,
  IntegrityCheckError,
  MigrationChecksumError,
  MigrationFailedError,
  NetworkFileSystemError,
  type StateDatabase,
} from "@dipsaus-orchestrator/engine";
import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { DaemonLifecycle } from "../../src/lifecycle";
import {
  databaseFailure,
  MIGRATIONS_STEP,
  needsCheckAfter,
  newestBackup,
  RecoverySteps,
  runRecovery,
  type RecoveryContext,
  type RecoveryStep,
} from "../../src/recovery";

const clock = new ManualClock();

function context(): RecoveryContext {
  return {
    logger: createLogger({ clock, sinks: [], component: "test" }),
    clock,
    children: new ChildProcesses(),
    database: () => ({}) as StateDatabase,
  };
}

function recordingStep(name: string, order: string[]): RecoveryStep {
  return {
    name,
    run: async () => {
      order.push(name);
    },
  };
}

describe("runRecovery", () => {
  it("runs the migrations first, then the steps in registration order, then running", async () => {
    const order: string[] = [];
    const steps = new RecoverySteps(recordingStep(MIGRATIONS_STEP, order));
    steps.register(recordingStep("reconcile", order));
    steps.register(recordingStep("re-attach", order));
    const lifecycle = new DaemonLifecycle();
    const states: string[] = [];
    lifecycle.onTransition((change) => states.push(`${change.to}:${change.reason}`));

    expect(await runRecovery({ lifecycle, steps, context: context(), crashLoop: false })).toBe(
      true,
    );
    expect(order).toEqual([MIGRATIONS_STEP, "reconcile", "re-attach"]);
    expect(states).toEqual(["recovering:running recovery steps", "running:recovered"]);
  });

  it("enters safe with reason crash loop when the crash counter requires it", async () => {
    const steps = new RecoverySteps(recordingStep(MIGRATIONS_STEP, []));
    const lifecycle = new DaemonLifecycle();
    await runRecovery({ lifecycle, steps, context: context(), crashLoop: true });
    expect(lifecycle.state).toBe("safe");
    expect(lifecycle.reason).toBe("crash loop");
  });

  it("keeps office access closed while a step runs", async () => {
    const lifecycle = new DaemonLifecycle();
    const seen: (string | null)[] = [];
    const steps = new RecoverySteps({
      name: MIGRATIONS_STEP,
      run: async () => {
        seen.push(lifecycle.officeAccess()?.code ?? null);
      },
    });
    await runRecovery({ lifecycle, steps, context: context(), crashLoop: false });
    expect(seen).toEqual(["engine.recovering"]);
    expect(lifecycle.officeAccess()).toBeNull();
  });

  it("refuses a second step with the same name", () => {
    const steps = new RecoverySteps(recordingStep(MIGRATIONS_STEP, []));
    expect(() => steps.register(recordingStep(MIGRATIONS_STEP, []))).toThrow("already registered");
  });

  it("lets the running step finish and runs no further step once draining starts", async () => {
    const order: string[] = [];
    const lifecycle = new DaemonLifecycle();
    const gate = Promise.withResolvers<void>();
    const steps = new RecoverySteps({
      name: MIGRATIONS_STEP,
      run: async () => {
        order.push("migrations started");
        await gate.promise;
        order.push("migrations finished");
      },
    });
    steps.register(recordingStep("reconcile", order));
    const running = runRecovery({ lifecycle, steps, context: context(), crashLoop: false });
    await Promise.resolve();
    expect(lifecycle.inFlight).toBe(1);
    lifecycle.transition("draining", "SIGTERM");
    const idle = lifecycle.idle();
    gate.resolve();
    await idle;
    expect(await running).toBe(false);
    expect(order).toEqual(["migrations started", "migrations finished"]);
    expect(lifecycle.state).toBe("draining");
  });

  it("rejects when a step fails and ends its work", async () => {
    const lifecycle = new DaemonLifecycle();
    const steps = new RecoverySteps({
      name: MIGRATIONS_STEP,
      run: async () => {
        throw new Error("migration 3 failed");
      },
    });
    await expect(
      runRecovery({ lifecycle, steps, context: context(), crashLoop: false }),
    ).rejects.toThrow("migration 3 failed");
    await lifecycle.idle();
    expect(lifecycle.state).toBe("recovering");
  });
});

describe("an unavailable state database (DIPO-111)", () => {
  it("runs no further step and enters neither running nor safe", async () => {
    const order: string[] = [];
    const lifecycle = new DaemonLifecycle();
    const steps = new RecoverySteps({
      name: MIGRATIONS_STEP,
      run: async () => {
        order.push(MIGRATIONS_STEP);
        lifecycle.holdUnavailable({ details: { reason: "migration" }, text: "failed" });
      },
    });
    steps.register(recordingStep("reconcile", order));
    expect(await runRecovery({ lifecycle, steps, context: context(), crashLoop: true })).toBe(
      false,
    );
    expect(order).toEqual([MIGRATIONS_STEP]);
    expect(lifecycle.state).toBe("recovering");
    expect(lifecycle.inFlight).toBe(0);
  });
});

/** A file with a SQLite header whose `user_version` (offset 60) is `version`, written at `at`. */
function backupFile(dir: string, name: string, version: number, at: number): string {
  const path = join(dir, "backups", name);
  mkdirSync(join(dir, "backups"), { recursive: true });
  const header = Buffer.alloc(100);
  header.write("SQLite format 3\0", 0, "latin1");
  header.writeUInt32BE(version, 60);
  writeFileSync(path, header);
  utimesSync(path, at / 1000, at / 1000);
  return path;
}

describe("newestBackup", () => {
  it("names the newest daily or pre-migration copy that holds a schema", () =>
    withTempDir((dir) => {
      expect(newestBackup(dir)).toBeNull();
      const daily = backupFile(dir, "dipo-20261014.db", 29, 1_000_000);
      backupFile(dir, "dipo-20261013.db", 29, 500_000);
      expect(newestBackup(dir)).toBe(daily);
      const pre = backupFile(dir, "pre-v30-20261015T080000.db", 29, 2_000_000);
      expect(newestBackup(dir)).toBe(pre);
      // A copy of a database that was still empty restores nothing; other files are no backups.
      backupFile(dir, "pre-v29-20261016T080000.db", 0, 3_000_000);
      backupFile(dir, "notes.db", 29, 4_000_000);
      expect(newestBackup(dir)).toBe(pre);
    }));
});

describe("databaseFailure", () => {
  it("says the file was left as it was after a failed migration and names the backup", () =>
    withTempDir((dir) => {
      const backup = backupFile(dir, "pre-v30-20261016T080000.db", 29, 1_000_000);
      const failure = databaseFailure(
        new MigrationFailedError(30, backup, new Error("no such table: agents")),
        dir,
      );
      expect(failure.details).toEqual({ reason: "migration", backup });
      expect(failure.text).toBe(
        `Migration 30 of the state database failed and was rolled back (no such table: agents), so dipo.db was left as it was. No office is loaded. This dipo cannot migrate it: run \`dipo daemon stop\`, then go back to the previous dipo version or upgrade to a release with a fixed migration, and start the daemon again. Restore the backup only if dipo.db itself is suspect: \`dipo restore ${backup}\`.`,
      );
      rmSync(backup);
      expect(
        databaseFailure(new MigrationFailedError(30, backup, new Error("x")), dir).text,
      ).toContain(
        `Restore a backup only if dipo.db itself is suspect; ${join(dir, "backups")} holds none.`,
      );
    }));

  it("names stop and restore for a damaged file, from quick_check or from SQLite", () =>
    withTempDir((dir) => {
      const backup = backupFile(dir, "dipo-20261015.db", 29, 1_000_000);
      const checked = databaseFailure(
        new IntegrityCheckError(join(dir, "dipo.db"), ["Tree 5 page 5: btreeInitPage error 11"]),
        dir,
      );
      expect(checked.details).toEqual({ reason: "damaged", backup });
      expect(checked.text).toBe(
        `The state database is damaged (PRAGMA quick_check reported: Tree 5 page 5: btreeInitPage error 11). No office is loaded. Run \`dipo daemon stop\`, then \`dipo restore ${backup}\`.`,
      );
      const notADatabase = Object.assign(new Error("file is not a database"), {
        code: "SQLITE_NOTADB",
      });
      expect(databaseFailure(notADatabase, dir).details).toEqual({ reason: "damaged", backup });
      const corruptStep = new MigrationFailedError(
        30,
        backup,
        Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" }),
      );
      expect(databaseFailure(corruptStep, dir).details.reason).toBe("damaged");
    }));

  it("says where a backup would be when there is none", () =>
    withTempDir((dir) => {
      const failure = databaseFailure(new IntegrityCheckError(join(dir, "dipo.db"), ["x"]), dir);
      expect(failure.details).toEqual({ reason: "damaged" });
      expect(failure.text).toContain(
        `Run \`dipo daemon stop\`, then \`dipo restore <file>\` with a copy of dipo.db; ${join(dir, "backups")} holds no backup.`,
      );
    }));

  it("says to upgrade dipo for a too-new database, and names no backup", () =>
    withTempDir((dir) => {
      backupFile(dir, "dipo-20261015.db", 29, 1_000_000);
      const failure = databaseFailure(new DatabaseTooNewError(31, 29), dir);
      expect(failure.details).toEqual({ reason: "tooNew" });
      expect(failure.text).toBe(
        "The state database is at schema version 31, newer than this dipo supports (29). No office is loaded. Upgrade dipo, then run `dipo daemon restart`.",
      );
    }));

  it("says to move the state directory for a network filesystem", () =>
    withTempDir((dir) => {
      const failure = databaseFailure(new NetworkFileSystemError("/Volumes/share", "smbfs"), dir);
      expect(failure.details).toEqual({ reason: "networkFilesystem" });
      expect(failure.text).toBe(
        "The state directory /Volumes/share is on a network filesystem (smbfs), and SQLite needs a local disk. No office is loaded. Run `dipo daemon stop`, move the state directory to a local disk (set DIPO_HOME to a local directory), then start the daemon again.",
      );
    }));

  it("names restore for an edited migration and for any other failure", () =>
    withTempDir((dir) => {
      const backup = backupFile(dir, "dipo-20261015.db", 29, 1_000_000);
      const edited = databaseFailure(
        new MigrationChecksumError(4, "recorded checksum differs"),
        dir,
      );
      expect(edited.details).toEqual({ reason: "checksum", backup });
      expect(edited.text).toContain("A released migration was edited. No office is loaded.");
      const other = databaseFailure(new Error("EACCES: permission denied"), dir);
      expect(other.details).toEqual({ reason: "open", backup });
      expect(other.text).toBe(
        `The state database could not be opened (EACCES: permission denied). No office is loaded. Run \`dipo daemon stop\`, then \`dipo restore ${backup}\`.`,
      );
    }));
});

describe("needsCheckAfter", () => {
  it("keeps a check pending after damage, and after a failure before the check could pass", () => {
    expect(needsCheckAfter("damaged", false)).toBe(true);
    expect(needsCheckAfter("damaged", true)).toBe(true);
    expect(needsCheckAfter("networkFilesystem", true)).toBe(true);
    expect(needsCheckAfter("open", true)).toBe(true);
  });

  it("clears it when quick_check passed before the failure, and sets none without a check", () => {
    for (const reason of ["tooNew", "migration", "checksum"]) {
      expect(needsCheckAfter(reason, true)).toBe(false);
    }
    for (const reason of ["tooNew", "migration", "checksum", "networkFilesystem", "open"]) {
      expect(needsCheckAfter(reason, false)).toBe(false);
    }
  });
});
