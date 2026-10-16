// Plugins in worker runs (DIPO-108, 0008 amendment of 2026-10-12): Claude Code's plugin lists are
// read without the engine knowing their layout, the run settings switch off every plugin the office
// does not name, and a session whose `system/init` lists another plugin ends `startFailed` naming
// it, its turn carrying no report, while the story stays Ready (no park proposed).

import { describe, expect, it } from "bun:test";

import { initialState } from "../../src/workers/claude-cli/interpret";
import { plan, SETTINGS_FILE } from "../../src/workers/claude-cli/plan";
import {
  enabledPluginsSetting,
  INSTALLED_PLUGINS_FILE,
  parseInstalledPlugins,
  parseSyncedPlugins,
  pluginRefusal,
  readInstalledPlugins,
  refusedPlugins,
  SYNCED_PLUGINS_DIR,
  type PluginFiles,
} from "../../src/workers/claude-cli/plugins";
import { PlanError } from "../../src/workers/types";
import { context, HOME, spec, withInitPlugins } from "./launch-fixtures";
import { loadRecording, replay } from "./replay";

const WARP = "warp@claude-code-warp";
const LEARNING = "learning-output-style@claude-plugins-official";
const BUILTINS = [
  "cc-plugin-agents-md@builtin",
  "cc-plugin-telemetry@builtin",
  "cc-plugin-plugin-authoring@builtin",
];

/** Claude Code's `installed_plugins.json`, version 2, as the live machine had it. */
function installedJson(ids: readonly string[]): string {
  const plugins = Object.fromEntries(
    ids.map((id) => [id, [{ scope: "user", installPath: `${HOME}/x`, version: "1.0.0" }]]),
  );
  return JSON.stringify({ version: 2, plugins });
}

function files(entries: Record<string, string>, dirs: Record<string, string[]> = {}): PluginFiles {
  return { read: (path) => entries[path], dirs: (path) => dirs[path] ?? [] };
}

function settingsOf(ctx: ReturnType<typeof context>): Record<string, unknown> {
  const file = plan(spec(), ctx).files.find((entry) => entry.name === SETTINGS_FILE);
  return JSON.parse(file?.content ?? "{}") as Record<string, unknown>;
}

describe("(unit) Claude Code's plugin lists", () => {
  it("reads the installed ids of every scope, sorted", () => {
    expect(parseInstalledPlugins(installedJson([WARP, LEARNING, "dipsaus-ai@dipsaus-ai"]))).toEqual(
      ["dipsaus-ai@dipsaus-ai", LEARNING, WARP],
    );
    expect(() => parseInstalledPlugins("[]")).toThrow('"plugins" object');
    expect(() => parseInstalledPlugins('{"plugins":[]}')).toThrow('"plugins" object');
  });

  it("names synced plugins <name>@synced, as system/init does", () => {
    expect(
      parseSyncedPlugins(JSON.stringify({ plugins: [{ name: "engineering", pluginId: "p_1" }] })),
    ).toEqual(["engineering@synced"]);
    expect(() => parseSyncedPlugins("{}")).toThrow('"plugins" list');
    expect(() => parseSyncedPlugins('{"plugins":[{}]}')).toThrow("without a name");
  });

  it("joins the installed list and every synced bucket under home, without doubles", () => {
    const synced = `${HOME}/${SYNCED_PLUGINS_DIR}`;
    const read = readInstalledPlugins(
      HOME,
      files(
        {
          [`${HOME}/${INSTALLED_PLUGINS_FILE}`]: installedJson([WARP]),
          [`${synced}/b2/manifest.json`]: JSON.stringify({ plugins: [{ name: "engineering" }] }),
          [`${synced}/b1/manifest.json`]: JSON.stringify({
            plugins: [{ name: "engineering" }, { name: "sales" }],
          }),
        },
        { [synced]: ["b2", "b1", "empty"] },
      ),
    );
    expect(read).toEqual(["engineering@synced", "sales@synced", WARP]);
  });

  it("reads no plugin when Claude Code has none", () => {
    expect(readInstalledPlugins(HOME, files({}))).toEqual([]);
  });

  it("returns an error naming the file it cannot read or parse, never throws", () => {
    const bad = readInstalledPlugins(
      HOME,
      files({ [`${HOME}/${INSTALLED_PLUGINS_FILE}`]: "{ not json" }),
    );
    expect(bad).toEqual({ error: expect.stringContaining(INSTALLED_PLUGINS_FILE) as string });
    const synced = `${HOME}/${SYNCED_PLUGINS_DIR}`;
    const badManifest = readInstalledPlugins(
      HOME,
      files({ [`${synced}/b1/manifest.json`]: "[]" }, { [synced]: ["b1"] }),
    );
    expect(badManifest).toEqual({ error: expect.stringContaining("b1/manifest.json") as string });
    const unreadable = readInstalledPlugins(HOME, {
      read: () => {
        throw new Error("EACCES: permission denied");
      },
      dirs: () => [],
    });
    expect(unreadable).toEqual({ error: expect.stringContaining("EACCES") as string });
  });
});

describe("(unit) the run settings switch plugins off", () => {
  it("sets enabledPlugins false for every installed plugin worker.plugins does not name", () => {
    expect(enabledPluginsSetting([LEARNING, WARP], [])).toEqual({
      [LEARNING]: false,
      [WARP]: false,
    });
    expect(enabledPluginsSetting([LEARNING, WARP], [WARP])).toEqual({ [LEARNING]: false });
    expect(enabledPluginsSetting([], [WARP])).toEqual({});
  });

  it("writes the block into claude-settings.json", () => {
    const settings = settingsOf(
      context({ plugins: { installed: [LEARNING, WARP, "engineering@synced"], allowed: [WARP] } }),
    );
    expect(settings["enabledPlugins"]).toEqual({ [LEARNING]: false, "engineering@synced": false });
    expect(
      settingsOf(context({ plugins: { installed: [], allowed: [] } }))["enabledPlugins"],
    ).toEqual({});
  });

  it("writes no block when the context carries no plugin lists (the recordings capture)", () => {
    expect("enabledPlugins" in settingsOf(context())).toBe(false);
  });

  it("refuses the plan when the plugin list could not be read", () => {
    const ctx = context({
      plugins: {
        installed: { error: "cannot read Claude Code's plugin list /x: boom" },
        allowed: [],
      },
    });
    expect(() => plan(spec(), ctx)).toThrow(PlanError);
    expect(() => plan(spec(), ctx)).toThrow("cannot switch Claude Code plugins off");
  });
});

describe("(unit) the system/init plugin check", () => {
  it("refuses plugins worker.plugins does not name, but not Claude Code's builtin ones", () => {
    expect(refusedPlugins([...BUILTINS, WARP, LEARNING], [LEARNING])).toEqual([WARP]);
    expect(refusedPlugins(BUILTINS, [])).toEqual([]);
    expect(refusedPlugins(["engineering@synced"], [])).toEqual(["engineering@synced"]);
    // A plugin without a <plugin>@<marketplace> id is refused, never guessed.
    expect(refusedPlugins(["builtin"], [])).toEqual(["builtin"]);
    expect(pluginRefusal([WARP])).toContain(`plugin ${WARP}, not in worker.plugins`);
    expect(pluginRefusal([WARP, LEARNING])).toContain(`plugins ${WARP}, ${LEARNING}`);
  });
});

describe("(engine) a session that loaded an unlisted plugin, through a fake stream", () => {
  // The live recording of DIPO-108 with the plugins of its system/init named, since the
  // committed recording redacts them.
  const live = loadRecording("safety-plugin-off");

  it("ends startFailed naming the plugin, with no report and no park (the story stays Ready)", async () => {
    const run = await replay(withInitPlugins(live, [...BUILTINS, WARP]), {
      state: initialState({ plannedModel: "haiku", allowedPlugins: [] }),
    });
    expect(run.state.plugins).toEqual([...BUILTINS, WARP]);
    expect(run.state.startFailure).toBe(pluginRefusal([WARP]));
    expect(run.result.outcome).toBe("startFailed");
    expect(run.result.detail).toContain(WARP);
    expect(run.result.park).toBeUndefined();
    expect(run.result.report).toBeNull();
    // The turn carries the start failure and no report, so verify and commit never run on it.
    const turn = run.events.find((event) => event.t === "turn");
    expect(turn).toMatchObject({
      report: null,
      problem: { kind: "startFailed", detail: pluginRefusal([WARP]) },
    });
    expect(run.events.some((event) => event.t === "initRejected")).toBe(false);
  });

  it("runs as recorded when worker.plugins names the plugin, or only builtin ones load", async () => {
    for (const [listed, allowed] of [
      [[...BUILTINS, WARP], [WARP]],
      [BUILTINS, []],
    ] as const) {
      const run = await replay(withInitPlugins(live, listed), {
        state: initialState({ plannedModel: "haiku", allowedPlugins: allowed }),
      });
      expect(run.state.startFailure).toBeNull();
      expect(run.result.outcome).toBe("done");
    }
  });

  it("keeps the list but checks nothing without worker.plugins in the state", async () => {
    const run = await replay(withInitPlugins(live, [WARP]));
    expect(run.state.plugins).toEqual([WARP]);
    expect(run.result.outcome).toBe("done");
  });
});
