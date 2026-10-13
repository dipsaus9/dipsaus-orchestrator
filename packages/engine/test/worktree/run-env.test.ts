// The run environment of a story worktree (DIPO-39; 0010 section 8): the DIPO_* variables, named
// ports or PORT, and env entries with only the documented placeholders substituted.

import { describe, expect, it } from "bun:test";

import { buildRunEnv, type RunEnvInput, RunEnvError, substitute } from "../../src/worktree";

const BASE: RunEnvInput = {
  slot: 3,
  stride: 10,
  story: "TASK-7",
  worktree: "/w/TASK-7",
  named: {},
  devPort: 5173,
  env: {},
};

describe("the run environment", () => {
  it("sets the DIPO variables and PORT from the dev port plus the offset", () => {
    expect(buildRunEnv(BASE)).toEqual({
      PORT: "5203",
      DIPO_SLOT: "3",
      DIPO_PORT_OFFSET: "30",
      DIPO_STORY: "TASK-7",
      DIPO_WORKTREE: "/w/TASK-7",
    });
  });

  it("uses the named ports instead of PORT, and no PORT without a dev port", () => {
    const named = buildRunEnv({ ...BASE, named: { PORT: 5173, API_PORT: 8787 } });
    expect(named["PORT"]).toBe("5203");
    expect(named["API_PORT"]).toBe("8817");
    const web = buildRunEnv({ ...BASE, named: { WEB_PORT: 3000 } });
    expect(web["WEB_PORT"]).toBe("3030");
    expect("PORT" in web).toBe(false);
    expect("PORT" in buildRunEnv({ ...BASE, devPort: null })).toBe(false);
  });

  it("substitutes only {slot}, {offset}, {port:N}, {id} and {worktree}, with no shell expansion", () => {
    const env = buildRunEnv({
      ...BASE,
      env: {
        VITE_HMR_PORT: "{port:24678}",
        LABEL: "{id} in {worktree} at slot {slot} (+{offset})",
        RAW: "$HOME/{home} `id` $(whoami) {port:x} {PORT}",
      },
    });
    expect(env["VITE_HMR_PORT"]).toBe("24708");
    expect(env["LABEL"]).toBe("TASK-7 in /w/TASK-7 at slot 3 (+30)");
    expect(env["RAW"]).toBe("$HOME/{home} `id` $(whoami) {port:x} {PORT}");
    expect(substitute("{slot}{slot}", { slot: 1, offset: 10, story: "S", worktree: "/w" })).toBe(
      "11",
    );
  });

  it("refuses bad names, the engine's own names and ports past 65535", () => {
    expect(() => buildRunEnv({ ...BASE, env: { "BAD-NAME": "x" } })).toThrow(RunEnvError);
    expect(() => buildRunEnv({ ...BASE, env: { DIPO_SLOT: "9" } })).toThrow(RunEnvError);
    expect(() => buildRunEnv({ ...BASE, named: { PORT: 65_530 } })).toThrow(RunEnvError);
    expect(() => buildRunEnv({ ...BASE, env: { P: "{port:65530}" } })).toThrow(RunEnvError);
    expect(() => buildRunEnv({ ...BASE, env: { PORT: "1" } })).toThrow(RunEnvError);
  });
});
