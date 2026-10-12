// The allowlisted step environment (DIPO-37 AC #9 and review item 8).

import { describe, expect, it } from "bun:test";

import { isRuntimeOptionName, stepEnv } from "../../src/sandbox/env";

describe("stepEnv", () => {
  const source = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/m",
    GH_TOKEN: "t",
    NPM_TOKEN: "t",
    SSH_AUTH_SOCK: "/tmp/ssh-x/agent.1",
    BUN_OPTIONS: "--preload ./planted.ts",
    NODE_OPTIONS: "--require ./planted.js",
    BUN_CONFIG_REGISTRY: "https://evil.example",
    TMPDIR: "/var/folders/x",
  };

  it("passes only allowlisted names and points TMPDIR and DIPO_TMP at the temp root", () => {
    expect(stepEnv(source, "/tmp/dipo-s-1")).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/home/m",
      TMPDIR: "/tmp/dipo-s-1",
      DIPO_TMP: "/tmp/dipo-s-1",
    });
  });

  it("never passes BUN_OPTIONS, NODE_OPTIONS or BUN_CONFIG_*, not even as engine extras", () => {
    const env = stepEnv(source, "/tmp/dipo-s-1", {
      PORT: "4100",
      BUN_OPTIONS: "--preload x",
      NODE_OPTIONS: "-r x",
      BUN_CONFIG_NO_CLEAR_TERMINAL_ON_RELOAD: "1",
      BUN_FEATURE_FLAG_NO_ORPHANS: "1",
      TMPDIR: "/elsewhere",
    });
    expect(env).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/home/m",
      PORT: "4100",
      TMPDIR: "/tmp/dipo-s-1",
      DIPO_TMP: "/tmp/dipo-s-1",
    });
    expect(isRuntimeOptionName("BUN_CONFIG_ANYTHING")).toBe(true);
    expect(isRuntimeOptionName("BUNDLE")).toBe(false);
  });
});
