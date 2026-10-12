// The client finds the daemon only if both resolve the same `<state>` (0006 decision 3). `client`
// may not import `engine` (0004), so `client/node` repeats the anchor rule; this test sits outside
// both packages, where neither boundary applies, and runs the two functions on the same inputs.
// It imports the two source files by path because the repository root has no package links.

import { describe, expect, it } from "bun:test";
import { userInfo } from "node:os";

import { stateDir } from "../../packages/client/src/node/runtime";
import { resolveSoftwareDirs } from "../../packages/engine/src/platform/paths";

type Case = {
  name: string;
  env: Record<string, string>;
  platform: "darwin" | "linux";
  home: string;
};

const cases: Case[] = [
  {
    name: "DIPO_HOME on macOS",
    env: { DIPO_HOME: "/tmp/dipo-a/state" },
    platform: "darwin",
    home: "/Users/me",
  },
  {
    name: "DIPO_HOME on Linux",
    env: { DIPO_HOME: "/tmp/dipo-b/state" },
    platform: "linux",
    home: "/home/me",
  },
  {
    name: "empty DIPO_HOME on macOS",
    env: { DIPO_HOME: "" },
    platform: "darwin",
    home: "/Users/me",
  },
  { name: "macOS default", env: {}, platform: "darwin", home: "/Users/me" },
  { name: "Linux default", env: {}, platform: "linux", home: "/home/me" },
  {
    name: "$HOME differing from the passwd home",
    env: { HOME: "/elsewhere", XDG_STATE_HOME: "/xdg", TMPDIR: "/t" },
    platform: "linux",
    home: "/home/me",
  },
  { name: "this machine's passwd home", env: {}, platform: "darwin", home: userInfo().homedir },
];

describe("client and daemon agree on <state>", () => {
  for (const c of cases) {
    it(c.name, () => {
      const daemon = resolveSoftwareDirs({ platform: c.platform, env: c.env, home: c.home }).state;
      expect(stateDir(c.env, c.platform, c.home)).toBe(daemon);
    });
  }

  it("uses the passwd home by default on both sides", () => {
    const platform = process.platform === "darwin" ? "darwin" : "linux";
    const env = { HOME: "/not/the/passwd/home" };
    expect(stateDir(env, platform)).toBe(
      resolveSoftwareDirs({ platform, env, home: userInfo().homedir }).state,
    );
  });
});
