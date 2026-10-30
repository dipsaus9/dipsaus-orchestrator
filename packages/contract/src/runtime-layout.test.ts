// The runtime layout both the daemon and the client read (DIPO-320): the folder rule, the folder
// checks, the records and the environment of a detached process. The parsers of the process probe
// are tested with the engine's probe (`packages/engine/test/platform/process.test.ts`).

import { describe, expect, it } from "bun:test";

import {
  detachedEnv,
  hasTestMarker,
  inDir,
  isWithin,
  normalizePath,
  longestRuntimePathBytes,
  parsePidRecord,
  parseRuntimeRecord,
  RUNTIME_PATH_LIMIT,
  runtimeDirReason,
  runtimePathReason,
  softwareDirsOf,
  stateDirReason,
} from "./runtime-layout";

describe("the software folders", () => {
  it("are under the passwd home's Library, or under DIPO_HOME for tests", () => {
    expect(softwareDirsOf({ HOME: "/elsewhere" }, "/Users/me")).toEqual({
      state: "/Users/me/Library/Application Support/dipo",
      logs: "/Users/me/Library/Logs/dipo",
      override: null,
    });
    expect(softwareDirsOf({ DIPO_HOME: "/tmp/d.1/state/" }, "/Users/me")).toEqual({
      state: "/tmp/d.1/state/",
      logs: "/tmp/d.1/state/logs",
      override: "/tmp/d.1/state/",
    });
    expect(softwareDirsOf({ DIPO_HOME: "" }, "/Users/me").override).toBeNull();
  });

  it("never count <dir>/../x as inside <dir>, and resolve . and .. before they compare", () => {
    expect(isWithin("/a/b/../x", "/a/b")).toBe(false);
    expect(isWithin("/a/b/../b/c", "/a/b")).toBe(true);
    expect(isWithin("/a/b/./c", "/a/b")).toBe(true);
    expect(isWithin("/a/b", "/a/b/c/..")).toBe(true);
    expect(isWithin("/x", "/")).toBe(true);
    expect(normalizePath("/a/./b/../../../c//d/")).toBe("/c/d");
    expect(normalizePath("a/../../b")).toBe("../b");
    expect(normalizePath("./")).toBe(".");
    expect(inDir("/a/./b/..", "c")).toBe("/a/c");
    // A DIPO_HOME with .. puts its logs where the folder really is.
    expect(softwareDirsOf({ DIPO_HOME: "/tmp/d.1/x/../state" }, "/Users/me").logs).toBe(
      "/tmp/d.1/state/logs",
    );
  });

  it("tell a folder inside another apart from one that only shares a prefix", () => {
    expect(isWithin("/a/b/c", "/a/b/")).toBe(true);
    expect(isWithin("/a/b", "/a/b")).toBe(true);
    expect(isWithin("/a/bc", "/a/b")).toBe(false);
    expect(inDir("/a//", "b")).toBe("/a/b");
    expect(inDir("/", "b")).toBe("/b");
    expect(inDir(`/a${"/".repeat(10_000)}`, "b")).toBe("/a/b");
  });

  it("see the test marker in any of the environments", () => {
    expect(hasTestMarker({}, { DIPO_TEST: "1" })).toBe(true);
    expect(hasTestMarker({ DIPO_TEST: "0" })).toBe(false);
  });
});

describe("the folder checks", () => {
  const good = { isSymbolicLink: false, isDirectory: true, uid: 501, mode: 0o700 };

  it("take a private directory of this user, and say why another is refused", () => {
    expect(runtimeDirReason(good, 501)).toBeNull();
    expect(runtimeDirReason({ ...good, isSymbolicLink: true }, 501)).toBe("it is a symlink");
    expect(runtimeDirReason({ ...good, isDirectory: false }, 501)).toBe("it is not a directory");
    expect(runtimeDirReason(good, 502)).toBe("it is owned by uid 501, not 502");
    expect(runtimeDirReason({ ...good, mode: 0o755 }, 501)).toBe("its mode is 0755, not 0700");
    expect(stateDirReason(good, 501)).toBeNull();
    expect(stateDirReason({ isDirectory: false, uid: 501 }, 501)).toBe("it is not a directory");
    expect(stateDirReason(good, -1)).toBeNull();
    // The runtime folder guards the sockets: an unknown user id refuses it, fail closed.
    expect(runtimeDirReason(good, -1)).toBe(
      "this process cannot tell its user id, so it cannot check the owner",
    );
  });

  it("refuse a runtime directory too long for every socket path", () => {
    const fits = `/${"a".repeat(RUNTIME_PATH_LIMIT - longestRuntimePathBytes("/") - 1)}`;
    expect(longestRuntimePathBytes(fits)).toBe(RUNTIME_PATH_LIMIT);
    expect(runtimePathReason(fits)).toBeNull();
    expect(runtimePathReason(`${fits}a`)).toBe(
      `socket paths would be ${RUNTIME_PATH_LIMIT + 1} bytes, over the ${RUNTIME_PATH_LIMIT}-byte limit`,
    );
  });
});

describe("the records", () => {
  it("read a runtime record only with every field", () => {
    const record = {
      runtimeDir: "/run",
      socket: "/run/dipo.sock",
      pid: 7,
      startTimeMs: 1,
      version: "0.0.0",
    };
    expect(parseRuntimeRecord(record)).toEqual(record);
    expect(parseRuntimeRecord({ ...record, socket: "run/dipo.sock" })).toBeNull();
    expect(parseRuntimeRecord({ ...record, version: undefined })).toBeNull();
    expect(parseRuntimeRecord(null)).toBeNull();
  });

  it("read a PID record with a null runtime directory, and refuse a broken one", () => {
    expect(parsePidRecord('{"pid":4242,"startTimeMs":1,"version":"x","runtimeDir":null}')).toEqual({
      pid: 4242,
      startTimeMs: 1,
      version: "x",
      runtimeDir: null,
    });
    for (const raw of ['{"pid":0,"startTimeMs":1,"version":"x","runtimeDir":null}', "{", ""]) {
      expect(parsePidRecord(raw)).toBeNull();
    }
  });
});

describe("the environment of a detached process", () => {
  it("drops the Bun flag and supervisor variables and unset values", () => {
    expect(
      detachedEnv({
        PATH: "/bin",
        BUN_OPTIONS: "--smol",
        BUN_FEATURE_FLAG_NO_ORPHANS: "1",
        XPC_SERVICE_NAME: "dipo.daemon",
        GONE: undefined,
      }),
    ).toEqual({ PATH: "/bin" });
  });
});
