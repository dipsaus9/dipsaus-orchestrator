import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { guardRuns } from "./guard";
import {
  longestTestSocketBytes,
  MAX_TEMP_ROOT_BYTES,
  RUNTIME_PATH_LIMIT,
  TEMP_DIR_TEMPLATE,
  testRuntimeDir,
  testStateDir,
} from "./runtime";
import { makeTempDir, tempRoot, tempRootFits, withDaemonTempDir, withTempDir } from "./temp";

/** Runs `fn` with one environment variable set or unset, restoring it afterwards. */
async function withEnv<T>(name: string, value: string | undefined, fn: () => Promise<T>) {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

/**
 * Whether a temp directory under this suite's temp root can itself be `DIPO_TMP` (DIPO-109). The
 * tests that nest one are skipped, visibly, under a `DIPO_TMP` longer than about 25 bytes.
 */
const NESTED_ROOT_FITS = guardRuns(
  "NESTED_ROOT_FITS",
  "a temp directory under DIPO_TMP is too long to be a DIPO_TMP itself (DIPO-109)",
  tempRootFits(join(realpathSync(tempRoot()), TEMP_DIR_TEMPLATE)),
);

describe("withTempDir", () => {
  it("creates dipo-XXXXXX under the temp root and removes it afterwards", async () => {
    let seen = "";
    await withEnv("DIPO_TEST_KEEP", undefined, () =>
      withTempDir((dir) => {
        seen = dir;
        expect(basename(dir)).toMatch(/^dipo-[A-Za-z0-9]{6}$/);
        expect(dirname(dir)).toBe(realpathSync(tempRoot()));
        writeFileSync(join(dir, "file.txt"), "x");
      }),
    );
    expect(seen).not.toBe("");
    expect(existsSync(seen)).toBe(false);
  });

  it("removes the directory when the test body throws", async () => {
    let seen = "";
    await expect(
      withEnv("DIPO_TEST_KEEP", undefined, () =>
        withTempDir((dir) => {
          seen = dir;
          throw new Error("boom");
        }),
      ),
    ).rejects.toThrow("boom");
    expect(existsSync(seen)).toBe(false);
  });

  it.skipIf(!NESTED_ROOT_FITS)("uses $DIPO_TMP when set and /tmp otherwise", async () => {
    await withTempDir(async (outer) => {
      await withEnv("DIPO_TMP", outer, async () => {
        expect(tempRoot()).toBe(outer);
        await withTempDir((dir) => expect(dirname(dir)).toBe(outer));
      });
      await withEnv("DIPO_TMP", undefined, async () => expect(tempRoot()).toBe("/tmp"));
    });
  });

  it.skipIf(!NESTED_ROOT_FITS)("keeps the directory when DIPO_TEST_KEEP=1", async () => {
    await withTempDir(async (outer) => {
      let kept = "";
      await withEnv("DIPO_TMP", outer, () =>
        withEnv("DIPO_TEST_KEEP", "1", () =>
          withTempDir((dir) => {
            kept = dir;
          }),
        ),
      );
      // The kept directory sits inside `outer`, which this test's own withTempDir removes.
      expect(existsSync(kept)).toBe(true);
    });
  });
});

/** A directory under `outer` whose path is `bytes` long. */
function rootOfLength(outer: string, bytes: number): string {
  const pad = bytes - Buffer.byteLength(outer) - 1;
  if (pad < 1) throw new Error(`no room for a ${bytes}-byte root under ${outer}`);
  return join(outer, "r".repeat(pad));
}

/**
 * Whether a root of exactly `MAX_TEMP_ROOT_BYTES` fits under this suite's temp root: its
 * `dipo-XXXXXX` directory, a slash and at least one byte of padding. The test that needs it is
 * skipped, visibly, under a longer `DIPO_TMP`.
 */
const LONGEST_ROOT_FITS = guardRuns(
  "LONGEST_ROOT_FITS",
  "DIPO_TMP is too long for a root of the longest length the limit allows (DIPO-109)",
  tempRootFits(join(realpathSync(tempRoot()), TEMP_DIR_TEMPLATE, "r")),
);

describe("the temp root limit (DIPO-109)", () => {
  it("refuses a DIPO_TMP too long for a test daemon's socket paths, naming the limit", async () => {
    await withTempDir(async (outer) => {
      const long = join(outer, "x".repeat(MAX_TEMP_ROOT_BYTES));
      await withEnv("DIPO_TMP", long, async () => {
        expect(() => tempRoot()).toThrow(
          `over the ${RUNTIME_PATH_LIMIT}-byte Unix socket path limit`,
        );
        expect(() => makeTempDir()).toThrow(`at most ${MAX_TEMP_ROOT_BYTES} bytes`);
        await expect(withTempDir(() => "never runs")).rejects.toThrow(`DIPO_TMP ${long}`);
      });
    });
  });

  it.skipIf(!LONGEST_ROOT_FITS)(
    "accepts a temp root of exactly the longest length, and refuses one byte more",
    async () => {
      await withTempDir(async (outer) => {
        const atLimit = rootOfLength(outer, MAX_TEMP_ROOT_BYTES);
        const over = rootOfLength(outer, MAX_TEMP_ROOT_BYTES + 1);
        await withEnv("DIPO_TMP", atLimit, async () => {
          expect(longestTestSocketBytes(makeTempDir())).toBe(RUNTIME_PATH_LIMIT);
        });
        await withEnv("DIPO_TMP", over, async () => {
          expect(() => makeTempDir()).toThrow(`${RUNTIME_PATH_LIMIT + 1} bytes`);
        });
      });
    },
  );

  it("measures the temp root after symlinks", async () => {
    await withTempDir(async (outer) => {
      const target = join(outer, "t".repeat(MAX_TEMP_ROOT_BYTES));
      mkdirSync(target);
      const link = join(outer, "l");
      symlinkSync(target, link);
      await withEnv("DIPO_TMP", link, async () => {
        expect(() => tempRoot()).toThrow(`(${target})`);
      });
    });
  });
});

/** Writes a daemon log in `dir` that names `path` and `source` as the chosen runtime directory. */
function writeLog(dir: string, path: string, source: string): void {
  mkdirSync(join(testStateDir(dir), "logs"), { recursive: true });
  writeFileSync(
    join(testStateDir(dir), "logs", "daemon.log"),
    `${JSON.stringify({ msg: "runtime directory chosen", path, source })}\n`,
  );
}

describe("withDaemonTempDir", () => {
  it("passes when the daemon log names its DIPO_RUNTIME_DIR, or no choice at all", async () => {
    expect(await withDaemonTempDir(() => "no daemon")).toBe("no daemon");
    const seen = await withDaemonTempDir((dir) => {
      writeLog(dir, testRuntimeDir(dir), "DIPO_RUNTIME_DIR");
      return dir;
    });
    expect(existsSync(seen)).toBe(false);
  });

  it("fails when the daemon chose another runtime directory, also after a failed body", async () => {
    await expect(withDaemonTempDir((dir) => writeLog(dir, "/tmp/dipo-501", "tmp"))).rejects.toThrow(
      "a test daemon chose runtime directory /tmp/dipo-501 (source tmp)",
    );
    await expect(
      withDaemonTempDir((dir) => {
        writeLog(dir, "/tmp/dipo-501", "tmp");
        throw new Error("the test body failed");
      }),
    ).rejects.toThrow("(source tmp)");
  });
});

/** A path of exactly `bytes` bytes. It is computed, never created, so it needs no DIPO_TMP. */
function pathOfLength(bytes: number): string {
  return `/${"c".repeat(bytes - 1)}`;
}

describe("the temp root limits on computed paths (DIPO-191)", () => {
  // Unlike the guarded tests above, these run under any DIPO_TMP, the worker's 30-byte one too.
  it("accepts a root of exactly MAX_TEMP_ROOT_BYTES, and refuses one byte more", () => {
    expect(tempRootFits(pathOfLength(MAX_TEMP_ROOT_BYTES))).toBe(true);
    expect(tempRootFits(pathOfLength(MAX_TEMP_ROOT_BYTES + 1))).toBe(false);
  });

  it("accepts a nested temp directory that fits as DIPO_TMP, and refuses one byte more", () => {
    const outerBytes = MAX_TEMP_ROOT_BYTES - TEMP_DIR_TEMPLATE.length - 1;
    expect(tempRootFits(join(pathOfLength(outerBytes), TEMP_DIR_TEMPLATE))).toBe(true);
    expect(tempRootFits(join(pathOfLength(outerBytes + 1), TEMP_DIR_TEMPLATE))).toBe(false);
  });
});
