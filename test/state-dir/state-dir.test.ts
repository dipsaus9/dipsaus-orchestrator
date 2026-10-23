// The client finds the daemon only if both resolve the same `<state>` (0006 decision 3). `client`
// may not import `engine` (0004), so `client/node` repeats the anchor rule; this test sits outside
// both packages, where neither boundary applies, and runs the two functions on the same inputs.
// It imports the two source files by path because the repository root has no package links.

import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

import { withTempDir } from "../../packages/testkit/src/index";

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
];

/** The error code `fn` throws, or "none". */
function codeOf(fn: () => unknown): string {
  try {
    fn();
    return "none";
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
}

/** Both sides refuse the same inputs with the same code (DIPO-316). */
function expectBothRefuse(c: Omit<Case, "name">, code: string): void {
  const daemon = codeOf(() => resolveSoftwareDirs(c));
  const client = codeOf(() => stateDir(c.env, c.platform, c.home));
  expect([daemon, client]).toEqual([code, code]);
}

describe("client and daemon agree on <state>", () => {
  for (const c of cases) {
    it(c.name, () => {
      const daemon = resolveSoftwareDirs({ platform: c.platform, env: c.env, home: c.home }).state;
      expect(stateDir(c.env, c.platform, c.home)).toBe(daemon);
    });
  }

  // The test runner's setup file sets the test marker, so this machine's real folders are refused
  // on both sides, on both platforms, by default and through DIPO_HOME.
  it("refuses this machine's passwd home on both sides under the test marker", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expectBothRefuse({ env: {}, platform, home: userInfo().homedir }, "paths.realStateInTest");
    }
    const real = join(userInfo().homedir, "Library", "Application Support", "dipo");
    expectBothRefuse(
      { env: { DIPO_HOME: real }, platform: "linux", home: "/home/me" },
      "paths.realStateInTest",
    );
  });

  it("refuses a DIPO_HOME dipo cannot use on both sides", () =>
    withTempDir((dir) => {
      const file = join(dir, "file");
      writeFileSync(file, "");
      for (const home of ["relative/state", file, join(file, "state")]) {
        expectBothRefuse(
          { env: { DIPO_HOME: home }, platform: "darwin", home: "/Users/me" },
          "paths.stateDirUnusable",
        );
      }
    }));
});
