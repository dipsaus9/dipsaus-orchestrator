import { describe, expect, it } from "bun:test";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { tempRoot, withTempDir } from "./temp";

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

  it("uses $DIPO_TMP when set and /tmp otherwise", async () => {
    await withTempDir(async (outer) => {
      await withEnv("DIPO_TMP", outer, async () => {
        expect(tempRoot()).toBe(outer);
        await withTempDir((dir) => expect(dirname(dir)).toBe(outer));
      });
      await withEnv("DIPO_TMP", undefined, async () => expect(tempRoot()).toBe("/tmp"));
    });
  });

  it("keeps the directory when DIPO_TEST_KEEP=1", async () => {
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
