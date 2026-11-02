import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import { cleanEnv, daemonTestEnv, withCleanEnv } from "./env";
import { withTempDir } from "./temp";

const SOURCE = {
  PATH: "/usr/bin",
  ANTHROPIC_API_KEY: "secret",
  CLAUDE_CODE_ENTRYPOINT: "cli",
  GH_TOKEN: "secret",
  GITHUB_ACTIONS: "true",
  MY_CLAUDE_NOTE: "kept",
  UNSET: undefined,
};

describe("cleanEnv", () => {
  it("drops ANTHROPIC_*, CLAUDE_* and GH_* and keeps everything else", () => {
    expect(cleanEnv(SOURCE)).toEqual({
      PATH: "/usr/bin",
      GITHUB_ACTIONS: "true",
      MY_CLAUDE_NOTE: "kept",
    });
  });
});

describe("withCleanEnv", () => {
  it("hides the removed variables from process.env and restores them afterwards", async () => {
    const names = ["ANTHROPIC_TESTKIT_PROBE", "CLAUDE_TESTKIT_PROBE", "GH_TESTKIT_PROBE"];
    for (const name of names) process.env[name] = "probe";
    try {
      const seen = await withCleanEnv(() => names.map((name) => process.env[name]));
      expect(seen).toEqual([undefined, undefined, undefined]);
      expect(names.map((name) => process.env[name])).toEqual(["probe", "probe", "probe"]);

      await expect(
        withCleanEnv(() => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(names.map((name) => process.env[name])).toEqual(["probe", "probe", "probe"]);
    } finally {
      for (const name of names) delete process.env[name];
    }
  });
});

describe("daemonTestEnv", () => {
  it("drops every PATH directory that holds a container CLI unless DIPO_TEST_BOX=1 (DIPO-423)", () =>
    withTempDir((root) => {
      const withCli = join(root, "with-cli");
      const withoutCli = join(root, "without-cli");
      const notExecutable = join(root, "not-executable");
      for (const dir of [withCli, withoutCli, notExecutable]) mkdirSync(dir);
      writeFileSync(join(withCli, "container"), "#!/bin/sh\n");
      chmodSync(join(withCli, "container"), 0o755);
      writeFileSync(join(notExecutable, "container"), "");
      chmodSync(join(notExecutable, "container"), 0o644);
      const path = [withCli, "", withoutCli, notExecutable, join(root, "missing")].join(delimiter);
      const dir = join(root, "daemon");

      expect(daemonTestEnv(dir, { ...SOURCE, PATH: path }).PATH).toEqual(
        ["", withoutCli, notExecutable, join(root, "missing")].join(delimiter),
      );
      expect(daemonTestEnv(dir, { ...SOURCE, PATH: path, DIPO_TEST_BOX: "1" }).PATH).toBe(path);
      expect(daemonTestEnv(dir, { ...SOURCE, PATH: path, DIPO_TEST_BOX: "0" }).PATH).not.toContain(
        withCli,
      );
    }));
});
