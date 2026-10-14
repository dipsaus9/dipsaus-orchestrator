// Restore (DIPO-76; 0007 section 10): the backup is checked with `quick_check` on a copy, every
// office gets a new epoch so an old cursor gets `stream.resetRequired`, the live `-wal` and `-shm`
// are deleted, and the copy replaces `dipo.db` by rename. A refused restore leaves `dipo.db` as it
// was.

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type OfficeId } from "@dipsaus-orchestrator/contract";
import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { RESTORE_FILE, restoreBackup, BackupRestoreError } from "../../src/backup/restore";
import { appendEntries, headCursor } from "../../src/changelog/log";
import { replay } from "../../src/changelog/replay";
import { openStateDatabase } from "../../src/db/database";
import { MIGRATIONS } from "../../src/db/schema";
import type { OfficeHandle } from "../../src/db/office";
import { vacuumInto } from "../../src/platform/sqlite";
import { addOffice, openTestState, type TestState } from "../commands/helpers";
import { localMounts, memoryLogger } from "../db/helpers";

function note(office: OfficeHandle, t: TestState, text: string): void {
  office.immediate(() =>
    appendEntries(office, [{ type: "engine.notice", delta: { level: "info", code: "x", text } }], {
      at: t.clock.now(),
    }),
  );
}

/** A state database with two offices and history, its backup, and the old cursors. */
async function backedUp(dir: string) {
  const t = await openTestState(dir);
  const a = addOffice(t, "a");
  const b = addOffice(t, "b");
  note(a, t, "one");
  note(b, t, "two");
  const cursors = { a: headCursor(a), b: headCursor(b) };
  const backup = join(dir, "dipo-20261014.db");
  await vacuumInto(t.state.connection.path, backup, { quickCheck: true });
  // History after the backup, which the restore loses.
  note(a, t, "three");
  const live = t.state.connection.path;
  t.state.close();
  return { live, backup, cursors, offices: [a.officeId, b.officeId], stateDir: join(dir, "state") };
}

function reopen(stateDir: string) {
  return openStateDatabase({
    stateDir,
    logger: memoryLogger(),
    readMounts: localMounts,
    clock: new ManualClock(),
    engineVersion: "0.0.0-test",
    checkIntegrity: true,
  });
}

describe("restore", () => {
  it("replaces a damaged dipo.db, drops its -wal and -shm, and gives every office a new epoch", () =>
    withTempDir(async (dir) => {
      const { live, backup, cursors, offices, stateDir } = await backedUp(dir);
      const backupBytes = readFileSync(backup);
      // The live file is damaged, and its sidecars belong to the damaged file.
      writeFileSync(live, "this is not a database any more");
      writeFileSync(`${live}-wal`, "stale wal");
      writeFileSync(`${live}-shm`, "stale shm");

      const result = restoreBackup({ stateDir, file: backup });

      expect(result.path).toBe(live);
      expect(result.offices).toEqual(offices);
      expect(result.schemaVersion).toBe(MIGRATIONS.at(-1)?.version ?? 0);
      expect(result.removed).toEqual([`${live}-wal`, `${live}-shm`]);
      expect(existsSync(`${live}-wal`)).toBe(false);
      expect(existsSync(`${live}-shm`)).toBe(false);
      expect(existsSync(join(stateDir, RESTORE_FILE))).toBe(false);
      // The backup itself is never changed.
      expect(readFileSync(backup).equals(backupBytes)).toBe(true);

      const state = await reopen(stateDir);
      try {
        for (const [name, cursor] of Object.entries(cursors)) {
          const office = state.office(cursor.stream.slice("office:".length) as OfficeId);
          const outcome = replay(office, cursor);
          expect(outcome.ok).toBe(false);
          if (outcome.ok) continue;
          expect(outcome.error.code).toBe("stream.resetRequired");
          const oldest = (outcome.error.details as { oldest: { epoch: string } }).oldest;
          expect(oldest.epoch, name).not.toBe(cursor.epoch);
        }
        // The rows of the backup are back; the entry written after it is not.
        const notes = state.connection.all<{ n: number }>("select count(*) as n from change_log")[0]
          ?.n;
        expect(notes).toBe(2);
      } finally {
        state.close();
      }
    }));

  it("refuses a damaged backup and leaves dipo.db as it was", () =>
    withTempDir(async (dir) => {
      const { live, backup, stateDir } = await backedUp(dir);
      const liveBytes = readFileSync(live);
      // Page 2 onwards overwritten: the file opens, its tables do not read.
      const bytes = readFileSync(backup);
      bytes.fill(0xa5, 4096, Math.min(bytes.length, 4096 * 3));
      writeFileSync(backup, bytes);
      const garbage = join(dir, "garbage.db");
      writeFileSync(garbage, "not sqlite at all, not even close to a header");

      for (const file of [backup, garbage]) {
        expect(() => restoreBackup({ stateDir, file })).toThrow(BackupRestoreError);
        expect(readFileSync(live).equals(liveBytes)).toBe(true);
        expect(existsSync(join(stateDir, RESTORE_FILE))).toBe(false);
      }
    }));

  it("says plainly when the rename fails after the live -wal and -shm were deleted", () =>
    withTempDir(async (dir) => {
      const { live, backup, stateDir } = await backedUp(dir);
      // A directory in the place of dipo.db makes the rename fail after the sidecars are gone.
      rmSync(live);
      mkdirSync(join(live, "blocker"), { recursive: true });
      writeFileSync(`${live}-wal`, "wal");
      writeFileSync(`${live}-shm`, "shm");
      let thrown: unknown;
      try {
        restoreBackup({ stateDir, file: backup });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(BackupRestoreError);
      expect((thrown as BackupRestoreError).walLost).toBe(true);
      expect((thrown as Error).message).toContain("has lost its most recent commits");
      expect((thrown as Error).message).toContain("run `dipo restore` again with a backup");
      expect(existsSync(`${live}-wal`)).toBe(false);
      expect(existsSync(join(stateDir, RESTORE_FILE))).toBe(false);

      // Without sidecars to lose, the same failure leaves dipo.db as it was.
      let plain: unknown;
      try {
        restoreBackup({ stateDir, file: backup });
      } catch (error) {
        plain = error;
      }
      expect((plain as BackupRestoreError).walLost).toBe(false);
    }));

  it("refuses a missing file, the live database itself and a newer schema", () =>
    withTempDir(async (dir) => {
      const { live, backup, stateDir } = await backedUp(dir);
      expect(() => restoreBackup({ stateDir, file: join(dir, "nope.db") })).toThrow(
        /does not exist/,
      );
      expect(() => restoreBackup({ stateDir, file: live })).toThrow(/is the live database/);
      expect(() =>
        restoreBackup({ stateDir, file: backup, migrations: MIGRATIONS.slice(0, 3) }),
      ).toThrow(/newer than this dipo knows \(3\)/);
    }));
});
