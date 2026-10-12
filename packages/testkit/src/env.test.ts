import { describe, expect, it } from "bun:test";

import { cleanEnv, withCleanEnv } from "./env";

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
