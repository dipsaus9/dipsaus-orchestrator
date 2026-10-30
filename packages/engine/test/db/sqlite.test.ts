// Platform SQLite module (DIPO-21): pragmas, file modes, network filesystem refusal, synchronous
// transactions and the `VACUUM INTO` Worker.

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join, relative } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import {
  AsyncTransactionError,
  type ClosableDatabase,
  closeCleanly,
  COMPILED_SQLITE_WORKER_PATH,
  sqliteWorkerUrl,
  IntegrityCheckError,
  isNetworkFsType,
  mountFor,
  NetworkFileSystemError,
  openSqlite,
  parseMountInfo,
  parseMountOutput,
  vacuumInto,
} from "../../src/platform/sqlite";
import { localMounts, memoryLogger } from "./helpers";

const mode = (path: string) => statSync(path).mode & 0o777;

const MACOS_MOUNT = [
  "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
  "/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect)",
  "//dennis@nas.local/home on /Volumes/home (smbfs, nodev, nosuid, mounted by dennis)",
  "nas:/export/state on /Volumes/nfs state (nfs, nodev, nosuid, mounted by dennis)",
  "map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)",
].join("\n");

const LINUX_MOUNTINFO = [
  "22 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw,errors=remount-ro",
  "40 22 0:35 / /proc rw,nosuid,nodev,noexec,relatime shared:13 - proc proc rw",
  "51 22 0:44 / /mnt/nfs rw,relatime shared:30 - nfs4 nas:/export rw,vers=4.2",
  "52 22 0:45 / /mnt/smb\\040share rw,relatime shared:31 - cifs //nas/share rw,vers=3.1.1",
  "53 22 0:46 / /home/dennis/nfs rw,relatime shared:32 - nfs nas:/home rw",
].join("\n");

describe("mount table parsing", () => {
  it("reads macOS mount output and classifies apfs, smbfs and nfs", () => {
    const mounts = parseMountOutput(MACOS_MOUNT);
    expect(mounts).toContainEqual({ mountPoint: "/", fsType: "apfs" });
    expect(mounts).toContainEqual({ mountPoint: "/Volumes/home", fsType: "smbfs" });
    expect(mounts).toContainEqual({ mountPoint: "/Volumes/nfs state", fsType: "nfs" });

    const at = (path: string) => mountFor(path, mounts)?.fsType ?? "none";
    expect(at("/Users/dennis/Library/Application Support/dipo")).toBe("apfs");
    expect(at("/Volumes/home/dipo")).toBe("smbfs");
    expect(at("/Volumes/nfs state/dipo")).toBe("nfs");
    expect(at("/Volumes/homework")).toBe("apfs");
    expect(isNetworkFsType(at("/Volumes/home/dipo"))).toBe(true);
    expect(isNetworkFsType(at("/Volumes/nfs state/dipo"))).toBe(true);
    expect(isNetworkFsType(at("/Users/dennis"))).toBe(false);
  });

  it("reads Linux mountinfo and classifies ext4, nfs, nfs4 and cifs", () => {
    const mounts = parseMountInfo(LINUX_MOUNTINFO);
    const at = (path: string) => mountFor(path, mounts)?.fsType ?? "none";
    expect(at("/home/dennis/.local/state/dipo")).toBe("ext4");
    expect(at("/home/dennis/nfs/dipo")).toBe("nfs");
    expect(at("/mnt/nfs/dipo")).toBe("nfs4");
    expect(at("/mnt/smb share/dipo")).toBe("cifs");
    expect(isNetworkFsType("ext4")).toBe(false);
    expect(isNetworkFsType("apfs")).toBe(false);
    for (const type of ["nfs", "nfs4", "cifs", "smbfs"]) expect(isNetworkFsType(type)).toBe(true);
  });
});

describe("openSqlite", () => {
  it("creates <state> 0700 and dipo.db 0600 with the 0007 pragmas, and logs sqlite_version", () =>
    withTempDir(async (dir) => {
      const stateDir = join(dir, "state");
      const logger = memoryLogger();
      const db = await openSqlite({ stateDir, logger, readMounts: localMounts });
      try {
        expect(db.created).toBe(true);
        db.immediate(() => db.exec("create table t (x integer) strict"));
        db.immediate(() => db.run("insert into t (x) values ($x)", { x: 1 }));

        expect(mode(stateDir)).toBe(0o700);
        for (const file of ["dipo.db", "dipo.db-wal", "dipo.db-shm"]) {
          expect(existsSync(join(stateDir, file))).toBe(true);
          expect(mode(join(stateDir, file))).toBe(0o600);
        }

        const pragma = (name: string) => Object.values(db.get(`pragma ${name}`) ?? {})[0];
        expect(pragma("journal_mode")).toBe("wal");
        expect(pragma("synchronous")).toBe(2); // FULL
        expect(pragma("foreign_keys")).toBe(1);
        expect(pragma("busy_timeout")).toBe(5000);
        expect(pragma("journal_size_limit")).toBe(67_108_864);
        expect(pragma("auto_vacuum")).toBe(2); // INCREMENTAL

        expect(db.sqliteVersion).toMatch(/^3\.\d+\.\d+$/);
        const opened = logger.lines.find((line) => line.message === "opened state database");
        expect(opened?.fields?.["sqliteVersion"]).toBe(db.sqliteVersion);
      } finally {
        db.close();
      }
    }));

  it("tightens the modes of an existing <state> and file", () =>
    withTempDir(async (dir) => {
      const stateDir = join(dir, "state");
      mkdirSync(stateDir, { mode: 0o755 });
      chmodSync(stateDir, 0o755);
      writeFileSync(join(stateDir, "dipo.db"), "", { mode: 0o644 });
      chmodSync(join(stateDir, "dipo.db"), 0o644);
      const db = await openSqlite({ stateDir, logger: memoryLogger(), readMounts: localMounts });
      db.close();
      expect(db.created).toBe(false);
      expect(mode(stateDir)).toBe(0o700);
      expect(mode(join(stateDir, "dipo.db"))).toBe(0o600);
    }));

  it("refuses a <state> on a network filesystem with an error naming the path", () =>
    withTempDir(async (dir) => {
      const stateDir = join(dir, "state");
      const open = openSqlite({
        stateDir,
        logger: memoryLogger(),
        readMounts: async () => [
          { mountPoint: "/", fsType: "apfs" },
          { mountPoint: dir, fsType: "smbfs" },
        ],
      });
      const error = await open.then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(NetworkFileSystemError);
      expect((error as Error).message).toContain(stateDir);
      expect(existsSync(join(stateDir, "dipo.db"))).toBe(false);
    }));

  it("reads the real mount table and opens a local temp directory", () =>
    withTempDir(async (dir) => {
      const db = await openSqlite({ stateDir: join(dir, "state"), logger: memoryLogger() });
      db.close();
    }));

  it("runs quick_check after an unclean exit and refuses a damaged file", () =>
    withTempDir(async (dir) => {
      const stateDir = join(dir, "state");
      const options = { stateDir, logger: memoryLogger(), readMounts: localMounts };
      mkdirSync(stateDir, { mode: 0o700 });
      const path = join(stateDir, "dipo.db");
      const raw = new Database(path, { create: true });
      raw.exec("create table t (x integer primary key, y text); create index ty on t (y);");
      const insert = raw.query("insert into t (y) values ($y)");
      // One transaction: 2000 separate commits each wait for the disk and can exceed the
      // test timeout on a busy machine.
      raw.transaction(() => {
        for (let i = 0; i < 2000; i++) insert.run({ $y: `row ${i} ${"x".repeat(50)}` });
      })();
      raw.close();

      const healthy = await openSqlite({ ...options, checkIntegrity: true });
      healthy.close();

      // Overwrite part of a b-tree page; the header stays valid, so only quick_check notices.
      const fd = openSync(path, "r+");
      writeSync(fd, Buffer.alloc(4096, 0xff), 0, 4096, 4096 * 5 + 100);
      closeSync(fd);
      const error = await openSqlite({ ...options, checkIntegrity: true }).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(IntegrityCheckError);
      expect((error as Error).message).toContain(join(stateDir, "backups"));
    }));
});

describe("transactions", () => {
  it("rolls back and throws when a callback returns a promise", () =>
    withTempDir(async (dir) => {
      const db = await openSqlite({
        stateDir: join(dir, "state"),
        logger: memoryLogger(),
        readMounts: localMounts,
      });
      try {
        db.immediate(() => db.exec("create table t (x integer) strict"));
        expect(() =>
          db.immediate(async () => {
            db.run("insert into t (x) values (1)");
          }),
        ).toThrow(AsyncTransactionError);
        expect(() => db.deferred(() => Promise.resolve())).toThrow(AsyncTransactionError);
        expect(db.get<{ n: number }>("select count(*) as n from t")?.n).toBe(0);

        expect(db.immediate(() => db.run("insert into t (x) values (2)").changes)).toBe(1);
        expect(() =>
          db.immediate(() => {
            db.run("insert into t (x) values (3)");
            throw new Error("boom");
          }),
        ).toThrow("boom");
        expect(db.all<{ x: number }>("select x from t")).toEqual([{ x: 2 }]);
      } finally {
        db.close();
      }
    }));
});

describe("shutdown (DIPO-87)", () => {
  it("checkpoints and closes, leaving only dipo.db with every write in it", () =>
    withTempDir(async (dir) => {
      const stateDir = join(dir, "state");
      const logger = memoryLogger();
      const db = await openSqlite({ stateDir, logger, readMounts: localMounts });
      db.immediate(() => db.exec("create table t (x integer) strict; insert into t values (7);"));
      expect(existsSync(`${db.path}-wal`)).toBe(true);

      db.shutdown(logger);

      expect(existsSync(db.path)).toBe(true);
      expect(existsSync(`${db.path}-wal`)).toBe(false);
      expect(existsSync(`${db.path}-shm`)).toBe(false);
      expect(logger.lines.filter((line) => line.level === "warn")).toEqual([]);
      const closed = logger.lines.find((line) => line.message === "closed state database");
      expect(closed?.fields).toMatchObject({ path: db.path, checkpoint: { busy: 0 } });
      // Read-write: a WAL file without -shm cannot be opened read-only.
      const copy = new Database(db.path);
      try {
        expect(copy.query("select x from t").all()).toEqual([{ x: 7 }]);
      } finally {
        copy.close();
      }
    }));

  it("logs a busy checkpoint at warn and still closes without throwing", () =>
    withTempDir(async (dir) => {
      const logger = memoryLogger();
      const db = await openSqlite({
        stateDir: join(dir, "state"),
        logger,
        readMounts: localMounts,
      });
      db.immediate(() => db.exec("create table t (x integer) strict; insert into t values (1);"));
      // A reader holds an old snapshot, so TRUNCATE cannot reset the WAL.
      const reader = new Database(db.path, { readonly: true });
      try {
        reader.run("begin");
        reader.query("select count(*) from t").get();
        db.immediate(() => db.run("insert into t (x) values (2)"));
        db.exec("pragma busy_timeout = 20");

        expect(() => db.shutdown(logger)).not.toThrow();

        const warn = logger.lines.find((line) => line.level === "warn");
        expect(warn?.message).toContain("closing checkpoint was busy");
        expect(warn?.fields).toMatchObject({ busy: 1 });
        expect(typeof warn?.fields?.["reason"]).toBe("string");
        expect(logger.lines.at(-1)?.message).toBe("closed state database");
        reader.run("commit");
      } finally {
        reader.close();
      }
    }));

  it("logs a failed checkpoint and a failed close at warn with the reason, and never throws", () => {
    const logger = memoryLogger();
    const closes: (boolean | undefined)[] = [];
    const db: ClosableDatabase = {
      query: (() => {
        throw new Error("database is locked");
      }) as unknown as ClosableDatabase["query"],
      fileControl: () => 0,
      close: (throwOnError?: boolean) => {
        closes.push(throwOnError);
        if (throwOnError === true) throw new Error("unable to close due to unfinalized statements");
      },
    };

    expect(() => closeCleanly(db, "/state/dipo.db", logger)).not.toThrow();

    expect(logger.lines).toEqual([
      {
        level: "warn",
        message: "the closing checkpoint failed",
        fields: { path: "/state/dipo.db", reason: "database is locked" },
      },
      {
        level: "warn",
        message: "could not close the state database cleanly",
        fields: { path: "/state/dipo.db", reason: "unable to close due to unfinalized statements" },
      },
    ]);
    // The fallback close releases the handle once the open statements finish.
    expect(closes).toEqual([true, false]);
  });
});

describe("sqliteWorkerUrl", () => {
  it("points next to the module from source and at the build entrypoint in a binary", () => {
    expect(existsSync(new URL(sqliteWorkerUrl()).pathname)).toBe(true);
    expect(sqliteWorkerUrl("file:///$bunfs/root/dipo")).toBe(COMPILED_SQLITE_WORKER_PATH);
    const packages = join(import.meta.dir, "..", "..", "..");
    const worker = join(packages, "engine", "src", "platform", "sqlite-worker.ts");
    expect(existsSync(worker)).toBe(true);
    expect(COMPILED_SQLITE_WORKER_PATH).toBe(`/$bunfs/root/${relative(packages, worker)}`);
  });
});

describe("vacuumInto", () => {
  it("writes a 0600 snapshot from a Worker", () =>
    withTempDir(async (dir) => {
      const db = await openSqlite({
        stateDir: join(dir, "state"),
        logger: memoryLogger(),
        readMounts: localMounts,
      });
      try {
        db.immediate(() => db.exec("create table t (x integer) strict; insert into t values (7);"));
        const target = join(dir, "state", "backups", "copy.db");
        await vacuumInto(db.path, target);
        expect(mode(target)).toBe(0o600);
        expect(mode(join(dir, "state", "backups"))).toBe(0o700);
        const copy = new Database(target, { readonly: true });
        expect(copy.query("select x from t").all()).toEqual([{ x: 7 }]);
        copy.close();

        const error = await vacuumInto(db.path, target).then(
          () => null,
          (caught: unknown) => caught,
        );
        expect((error as Error).message).toContain("VACUUM INTO");
      } finally {
        db.close();
      }
    }));
});
