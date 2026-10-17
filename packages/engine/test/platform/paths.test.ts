// Software directories (DIPO-23): the anchor, logs, runtime directory candidates and checks.

import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import {
  checkRuntimeDir,
  chooseRuntimeDir,
  longestRuntimePathBytes,
  readRuntimeRecord,
  resolveSoftwareDirs,
  RUNTIME_PATH_LIMIT,
  runtimeCandidates,
  RuntimeDirError,
  systemRuntimeDirFs,
  writeRuntimeRecord,
  type RuntimeDirFs,
} from "../../src/platform/paths";

const uid = process.getuid?.() ?? 0;
const mode = (path: string) => statSync(path).mode & 0o777;

// Variables that differ between a shell, launchd, systemd and SSH; the anchor ignores them.
const NOISY_ENV = {
  XDG_STATE_HOME: "/elsewhere/state",
  TMPDIR: "/var/folders/xy/T/",
  XDG_RUNTIME_DIR: "/run/user/1000",
};

describe("resolveSoftwareDirs", () => {
  it("anchors macOS state and logs in the passwd home", () => {
    const dirs = resolveSoftwareDirs({
      platform: "darwin",
      env: { ...NOISY_ENV, HOME: "/Users/dennis" },
      home: "/Users/dennis",
    });
    expect(dirs.state).toBe("/Users/dennis/Library/Application Support/dipo");
    expect(dirs.logs).toBe("/Users/dennis/Library/Logs/dipo");
    expect(dirs.homeMismatch).toBeNull();
  });

  it("anchors Linux state in ~/.local/state/dipo with logs inside it", () => {
    const dirs = resolveSoftwareDirs({
      platform: "linux",
      env: { ...NOISY_ENV, HOME: "/home/dennis/" },
      home: "/home/dennis",
    });
    expect(dirs.state).toBe("/home/dennis/.local/state/dipo");
    expect(dirs.logs).toBe("/home/dennis/.local/state/dipo/logs");
    expect(dirs.homeMismatch).toBeNull();
  });

  it("reports a $HOME that differs from the passwd home and still uses the passwd home", () => {
    const dirs = resolveSoftwareDirs({
      platform: "linux",
      env: { HOME: "/tmp/fake-home" },
      home: "/home/dennis",
    });
    expect(dirs.state).toBe("/home/dennis/.local/state/dipo");
    expect(dirs.homeMismatch).toEqual({ env: "/tmp/fake-home", passwd: "/home/dennis" });
  });

  it("lets DIPO_HOME replace the anchor on both platforms", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const dirs = resolveSoftwareDirs({
        platform,
        env: { ...NOISY_ENV, DIPO_HOME: "/tmp/dipo-test/state" },
        home: "/home/dennis",
      });
      expect(dirs.state).toBe("/tmp/dipo-test/state");
      expect(dirs.logs).toBe("/tmp/dipo-test/state/logs");
    }
  });
});

describe("runtimeCandidates", () => {
  it("orders macOS candidates: DIPO_RUNTIME_DIR, $TMPDIR/dipo, /tmp/dipo-<uid>", () => {
    const candidates = runtimeCandidates({
      platform: "darwin",
      env: { DIPO_RUNTIME_DIR: "/tmp/t/run", TMPDIR: "/var/folders/xy/T/" },
      uid: 501,
      lingering: false,
    });
    expect(candidates).toEqual([
      { path: "/tmp/t/run", source: "DIPO_RUNTIME_DIR" },
      { path: "/var/folders/xy/T/dipo", source: "TMPDIR" },
      { path: "/tmp/dipo-501", source: "tmp" },
    ]);
  });

  it("skips $TMPDIR on macOS when it is unset", () => {
    const candidates = runtimeCandidates({
      platform: "darwin",
      env: {},
      uid: 501,
      lingering: false,
    });
    expect(candidates).toEqual([{ path: "/tmp/dipo-501", source: "tmp" }]);
  });

  it("uses $XDG_RUNTIME_DIR/dipo on Linux only when lingering is on", () => {
    const env = { XDG_RUNTIME_DIR: "/run/user/1000", TMPDIR: "/var/tmp" };
    expect(runtimeCandidates({ platform: "linux", env, uid: 1000, lingering: true })).toEqual([
      { path: "/run/user/1000/dipo", source: "XDG_RUNTIME_DIR" },
      { path: "/tmp/dipo-1000", source: "tmp" },
    ]);
    expect(runtimeCandidates({ platform: "linux", env, uid: 1000, lingering: false })).toEqual([
      { path: "/tmp/dipo-1000", source: "tmp" },
    ]);
  });
});

describe("chooseRuntimeDir", () => {
  it("lets DIPO_RUNTIME_DIR under DIPO_TMP win over every other candidate", async () => {
    await withTempDir((dir) => {
      const override = join(dir, "run");
      const candidates = runtimeCandidates({
        platform: process.platform === "linux" ? "linux" : "darwin",
        env: { DIPO_RUNTIME_DIR: override, TMPDIR: dir, XDG_RUNTIME_DIR: dir },
        uid,
        lingering: true,
      });
      const choice = chooseRuntimeDir({ candidates, uid, tmpBase: dir });
      expect(choice).toEqual({ path: override, source: "DIPO_RUNTIME_DIR", rejected: [] });
      expect(mode(override)).toBe(0o700);
    });
  });

  it("accepts an existing directory owned by the user with mode 0700", async () => {
    await withTempDir((dir) => {
      const path = join(dir, "run");
      mkdirSync(path, { mode: 0o700 });
      chmodSync(path, 0o700);
      expect(checkRuntimeDir(path, uid, systemRuntimeDirFs)).toBeNull();
    });
  });

  it("rejects a candidate whose host socket paths would pass 100 bytes", async () => {
    await withTempDir((dir) => {
      const long = join(dir, "x".repeat(RUNTIME_PATH_LIMIT));
      const short = join(dir, "run");
      expect(longestRuntimePathBytes(long)).toBeGreaterThan(RUNTIME_PATH_LIMIT);
      const choice = chooseRuntimeDir({
        candidates: [
          { path: long, source: "DIPO_RUNTIME_DIR" },
          { path: short, source: "tmp" },
        ],
        uid,
        tmpBase: dir,
      });
      expect(choice.path).toBe(short);
      expect(choice.rejected).toHaveLength(1);
      expect(choice.rejected[0]?.reason).toContain("100-byte limit");
    });
  });

  it("counts the limit in bytes, not characters", () => {
    const base = `/tmp/${"é".repeat(30)}`;
    expect(longestRuntimePathBytes(base)).toBe(Buffer.byteLength(base) + 42);
  });

  it("falls back to a fresh mkdtemp directory when the candidates are squatted", async () => {
    await withTempDir((dir) => {
      const symlinked = join(dir, "symlinked");
      mkdirSync(join(dir, "target"), { mode: 0o700 });
      symlinkSync(join(dir, "target"), symlinked);
      const open = join(dir, "open");
      mkdirSync(open);
      chmodSync(open, 0o755);
      const file = join(dir, "file");
      writeFileSync(file, "");
      // Short, so the fresh directory's socket paths stay under the 100-byte limit in a deep temp dir.
      const tmpBase = join(dir, "b");
      mkdirSync(tmpBase);

      const choice = chooseRuntimeDir({
        candidates: [
          { path: symlinked, source: "DIPO_RUNTIME_DIR" },
          { path: open, source: "TMPDIR" },
          { path: file, source: "tmp" },
        ],
        uid,
        tmpBase,
      });
      expect(choice.source).toBe("mkdtemp");
      expect(dirname(choice.path)).toBe(tmpBase);
      expect(mode(choice.path)).toBe(0o700);
      expect(choice.rejected.map((r) => r.reason)).toEqual([
        "it is a symlink",
        "its mode is 0755, not 0700",
        "it is not a directory",
      ]);
    });
  });

  it("rejects a directory owned by another user", () => {
    const fs: RuntimeDirFs = {
      lstat: () => ({ isSymbolicLink: false, isDirectory: true, uid: uid + 1, mode: 0o700 }),
      mkdir: () => {
        throw new Error("not called");
      },
      mkdtemp: () => {
        throw new Error("not called");
      },
    };
    expect(checkRuntimeDir("/tmp/dipo-squat", uid, fs)).toBe(
      `it is owned by uid ${uid + 1}, not ${uid}`,
    );
  });

  it("refuses to start and names the squatted paths when the fallback fails too", () => {
    const squatted = { isSymbolicLink: false, isDirectory: true, uid: uid + 1, mode: 0o777 };
    const fs: RuntimeDirFs = {
      lstat: () => squatted,
      mkdir: () => undefined,
      mkdtemp: (prefix) => `${prefix}abc123`,
    };
    let error: unknown;
    try {
      chooseRuntimeDir({
        candidates: [{ path: "/tmp/dipo-1000", source: "tmp" }],
        uid,
        tmpBase: "/tmp",
        fs,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RuntimeDirError);
    expect((error as Error).message).toContain("/tmp/dipo-1000");
    expect((error as RuntimeDirError).rejected.map((r) => r.path)).toEqual([
      "/tmp/dipo-1000",
      "/tmp/dipo-abc123",
    ]);
  });
});

describe("runtime.json", () => {
  it("round-trips with mode 0600", async () => {
    await withTempDir(async (dir) => {
      const record = {
        runtimeDir: join(dir, "run"),
        socket: join(dir, "run", "dipo.sock"),
        pid: 4242,
        startTimeMs: 1_767_225_600_000,
        version: "0.0.0-dev",
      };
      writeRuntimeRecord(dir, record);
      expect(mode(join(dir, "runtime.json"))).toBe(0o600);
      expect(await readRuntimeRecord(dir)).toEqual(record);
    });
  });

  it("reads a missing or damaged file as null", async () => {
    await withTempDir(async (dir) => {
      expect(await readRuntimeRecord(dir)).toBeNull();
      writeFileSync(join(dir, "runtime.json"), "{not json");
      expect(await readRuntimeRecord(dir)).toBeNull();
    });
  });
});
