// Recovery steps (DIPO-68): registration order with the migrations first, `running` at the end, and a drain during recovery lets the current step finish and runs no further step. An
// unavailable state database (DIPO-111) ends recovery in `recovering`, and `databaseFailure` says
// what to do for each kind of failure.

import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  DatabaseTooNewError,
  MigrationChecksumError,
  MigrationFailedError,
} from "../../src/db/migrations";
import { createLogger } from "../../src/log/logger";
import { ChildProcesses } from "../../src/platform/process";
import { NetworkFileSystemError } from "../../src/platform/sqlite";
import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { DaemonLifecycle } from "../../src/create/lifecycle";
import {
  databaseFailure,
  MIGRATIONS_STEP,
  newestBackup,
  RecoverySteps,
  runRecovery,
  type RecoveryContext,
  type RecoveryStep,
} from "../../src/create/recovery";

const clock = new ManualClock();

function context(): RecoveryContext {
  return {
    logger: createLogger({ clock, sinks: [], component: "test" }),
    clock,
    children: new ChildProcesses(),
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

    expect(await runRecovery({ lifecycle, steps, context: context() })).toBe(true);
    expect(order).toEqual([MIGRATIONS_STEP, "reconcile", "re-attach"]);
    expect(states).toEqual(["recovering:running recovery steps", "running:recovered"]);
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
    await runRecovery({ lifecycle, steps, context: context() });
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
    const running = runRecovery({ lifecycle, steps, context: context() });
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
    await expect(runRecovery({ lifecycle, steps, context: context() })).rejects.toThrow(
      "migration 3 failed",
    );
    await lifecycle.idle();
    expect(lifecycle.state).toBe("recovering");
  });
});

describe("an unavailable state database (DIPO-111)", () => {
  it("runs no further step and does not enter running", async () => {
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
    expect(await runRecovery({ lifecycle, steps, context: context() })).toBe(false);
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
  it("names the newest pre-migration copy that holds a schema", () =>
    withTempDir((dir) => {
      expect(newestBackup(dir)).toBeNull();
      const older = backupFile(dir, "pre-v28-20261014T080000.db", 27, 1_000_000);
      expect(newestBackup(dir)).toBe(older);
      // A daily copy of an earlier dipo is no backup any more (0007).
      backupFile(dir, "dipo-20261016.db", 29, 2_500_000);
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
        `Migration 30 of the state database failed and was rolled back (no such table: agents), so dipo.db was left as it was. No office is loaded. This dipo cannot migrate it: run \`dipo daemon stop\`, then go back to the previous dipo version or upgrade to a release with a fixed migration, and start the daemon again. Copy the backup ${backup} over dipo.db, after deleting dipo.db-wal and dipo.db-shm, only if dipo.db itself is suspect.`,
      );
      rmSync(backup);
      expect(
        databaseFailure(new MigrationFailedError(30, backup, new Error("x")), dir).text,
      ).toContain(
        `Move dipo.db away only if it is itself suspect; ${join(dir, "backups")} holds no backup.`,
      );
    }));

  it("names stop and the backup to copy in for a file SQLite finds damaged", () =>
    withTempDir((dir) => {
      const backup = backupFile(dir, "pre-v30-20261015T080000.db", 29, 1_000_000);
      const malformed = Object.assign(new Error("database disk image is malformed"), {
        code: "SQLITE_CORRUPT",
      });
      const checked = databaseFailure(malformed, dir);
      expect(checked.details).toEqual({ reason: "damaged", backup });
      expect(checked.text).toBe(
        `The state database is damaged (database disk image is malformed). No office is loaded. Run \`dipo daemon stop\`, move ${join(dir, "dipo.db")} and its -wal and -shm files away, or delete those two files and copy ${backup} over ${join(dir, "dipo.db")}, then start the daemon again.`,
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
      const notADatabase = Object.assign(new Error("file is not a database"), {
        code: "SQLITE_NOTADB",
      });
      const failure = databaseFailure(notADatabase, dir);
      expect(failure.details).toEqual({ reason: "damaged" });
      expect(failure.text).toContain(
        `Run \`dipo daemon stop\`, move ${join(dir, "dipo.db")} and its -wal and -shm files away (${join(dir, "backups")} holds no backup), then start the daemon again; \`dipo office open\` registers each repository again.`,
      );
    }));

  it("says to upgrade dipo for a too-new database, and names no backup", () =>
    withTempDir((dir) => {
      backupFile(dir, "pre-v29-20261015T080000.db", 28, 1_000_000);
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

  it("names the backup to copy in for an edited migration and for any other failure", () =>
    withTempDir((dir) => {
      const backup = backupFile(dir, "pre-v29-20261015T080000.db", 28, 1_000_000);
      const edited = databaseFailure(
        new MigrationChecksumError(4, "recorded checksum differs"),
        dir,
      );
      expect(edited.details).toEqual({ reason: "checksum", backup });
      expect(edited.text).toContain("A released migration was edited. No office is loaded.");
      const other = databaseFailure(new Error("EACCES: permission denied"), dir);
      expect(other.details).toEqual({ reason: "open", backup });
      expect(other.text).toBe(
        `The state database could not be opened (EACCES: permission denied). No office is loaded. Run \`dipo daemon stop\`, move ${join(dir, "dipo.db")} and its -wal and -shm files away, or delete those two files and copy ${backup} over ${join(dir, "dipo.db")}, then start the daemon again.`,
      );
    }));
});
