// Plugins in worker runs (DIPO-108, 0008 amendment of 2026-10-12): Claude Code's plugin lists are
// read without the engine knowing their layout, the run settings switch off every plugin the office
// does not name, and a session whose `system/init` lists another plugin ends `startFailed` naming
// it, its turn carrying no report, while the story stays Ready (no park proposed).

import { describe, expect, it } from "bun:test";

import { initialState, interpret } from "../../src/workers/claude-cli/interpret";
import { result } from "../../src/workers/claude-cli/result";
import { plan, SETTINGS_FILE } from "../../src/workers/claude-cli/plan";
import {
  checkKnownMarketplaces,
  enabledPluginsSetting,
  INSTALLED_PLUGINS_FILE,
  KNOWN_MARKETPLACES_FILE,
  parseInstalledPlugins,
  parseSyncedPlugins,
  pluginRefusal,
  readInstalledPlugins,
  refusedPlugins,
  SYNCED_PLUGINS_DIR,
  type PluginFiles,
} from "../../src/workers/claude-cli/plugins";
import { PlanError } from "../../src/workers/types";
import {
  BUILTIN_PLUGINS,
  context,
  HOME,
  initPlugin,
  sessionSpec,
  withBuiltinPlugins,
  withInitPlugins,
} from "./launch-fixtures";
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

/** The run settings of a `session`'s plan, the one session dipo plans on the Mac (DIPO-240, DIPO-347). */
function settingsOf(ctx: ReturnType<typeof context>): Record<string, unknown> {
  const file = plan(sessionSpec(), ctx).files.find((entry) => entry.name === SETTINGS_FILE);
  return JSON.parse(file?.content ?? "{}") as Record<string, unknown>;
}

describe("(unit) Claude Code's plugin lists", () => {
  it("reads the installed ids of every scope, sorted", () => {
    expect(parseInstalledPlugins(installedJson([WARP, LEARNING, "dipsaus-ai@dipsaus-ai"]))).toEqual(
      ["dipsaus-ai@dipsaus-ai", LEARNING, WARP],
    );
    expect(() => parseInstalledPlugins("[]")).toThrow("expected an object");
    expect(() => parseInstalledPlugins('{"version":2,"plugins":[]}')).toThrow('"plugins" object');
  });

  it("refuses another file version, a key that is no id and a value that is no list", () => {
    expect(() => parseInstalledPlugins(JSON.stringify({ version: 3, plugins: {} }))).toThrow(
      "expected version 2, got 3",
    );
    expect(() => parseInstalledPlugins(JSON.stringify({ plugins: {} }))).toThrow(
      "expected version 2",
    );
    for (const key of ["warp", "warp@", "a@b@c", "warp @x"]) {
      expect(() =>
        parseInstalledPlugins(JSON.stringify({ version: 2, plugins: { [key]: [] } })),
      ).toThrow("is not a <plugin>@<marketplace> id");
    }
    expect(() =>
      parseInstalledPlugins(JSON.stringify({ version: 2, plugins: { [WARP]: { scope: "user" } } })),
    ).toThrow("expected a list of installs");
  });

  it("refuses a plugin, synced plugin or marketplace that calls itself builtin", () => {
    expect(() => parseInstalledPlugins(installedJson(["fake@builtin"]))).toThrow(
      'names the marketplace "builtin"',
    );
    expect(() =>
      parseSyncedPlugins(JSON.stringify({ plugins: [{ name: "x", marketplaceName: "builtin" }] })),
    ).toThrow('names the marketplace "builtin"');
    expect(() => checkKnownMarketplaces(JSON.stringify({ builtin: {}, other: {} }))).toThrow(
      "marketplace builtin",
    );
    expect(() => checkKnownMarketplaces("[]")).toThrow("keyed by marketplace");
    expect(() => checkKnownMarketplaces(JSON.stringify({ "claude-code-warp": {} }))).not.toThrow();
    const read = readInstalledPlugins(
      HOME,
      files({
        [`${HOME}/${INSTALLED_PLUGINS_FILE}`]: installedJson([WARP]),
        [`${HOME}/${KNOWN_MARKETPLACES_FILE}`]: JSON.stringify({ builtin: {} }),
      }),
    );
    expect(read).toEqual({ error: expect.stringContaining(KNOWN_MARKETPLACES_FILE) as string });
  });

  it("names synced plugins <name>@synced, as system/init does", () => {
    expect(
      parseSyncedPlugins(JSON.stringify({ plugins: [{ name: "engineering", pluginId: "p_1" }] })),
    ).toEqual(["engineering@synced"]);
    expect(() => parseSyncedPlugins("{}")).toThrow('"plugins" list');
    expect(() => parseSyncedPlugins('{"plugins":[{}]}')).toThrow("without a plain name");
    expect(() => parseSyncedPlugins('{"plugins":[{"name":"a@b"}]}')).toThrow(
      "without a plain name",
    );
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

  it("writes the block into a session's claude-settings.json, switching off every plugin whatever worker.plugins names", () => {
    const settings = settingsOf(
      context({
        plugins: { installed: [LEARNING, WARP, "engineering@synced"], allowed: [WARP] },
      }),
    );
    expect(settings["enabledPlugins"]).toEqual({
      [LEARNING]: false,
      [WARP]: false,
      "engineering@synced": false,
    });
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
    expect(() => plan(sessionSpec(), ctx)).toThrow(PlanError);
    expect(() => plan(sessionSpec(), ctx)).toThrow("cannot switch Claude Code plugins off");
  });
});

describe("(unit) the system/init plugin check", () => {
  it("refuses plugins the session may not load, but not Claude Code's builtin ones", () => {
    expect(refusedPlugins([...BUILTINS, WARP, LEARNING], [LEARNING])).toEqual([WARP]);
    expect(refusedPlugins(BUILTINS, [])).toEqual([]);
    expect(refusedPlugins(["engineering@synced"], [])).toEqual(["engineering@synced"]);
    // A plugin without a <plugin>@<marketplace> id is refused, never guessed.
    expect(refusedPlugins(["builtin"], [])).toEqual(["builtin"]);
    // An @builtin id that is also installed or synced is compared like any other.
    const telemetry = "cc-plugin-telemetry@builtin";
    expect(refusedPlugins(BUILTINS, [], [telemetry])).toEqual([telemetry]);
    expect(pluginRefusal([WARP])).toContain(`plugin ${WARP}, but no session loads a plugin`);
    expect(pluginRefusal([WARP, LEARNING])).toContain(`plugins ${WARP}, ${LEARNING}`);
  });
});

/** One `system/init` line listing warp, with `fields` changed. */
const initLine = (fields: Record<string, unknown>) => ({
  t: 1,
  ch: "stdout" as const,
  data: `${JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "s",
    model: "claude-haiku-5-5",
    claude_code_version: "2.1.301",
    permissionMode: "default",
    tools: ["Read"],
    apiKeySource: "none",
    plugins: [initPlugin(WARP)],
    ...fields,
  })}\n`,
});
/** A parser state that checks plugins against an empty `worker.plugins`. */
const checkingState = () => initialState({ plannedModel: "haiku", allowedPlugins: [] });

describe("(unit) the order of the system/init checks", () => {
  it("keeps a session that fails the key source or model check and lists a plugin init-rejected", () => {
    for (const fields of [{ apiKeySource: "user" }, { model: "claude-opus-4-5" }]) {
      const step = interpret(initLine(fields), checkingState());
      const kinds = step.events.map((event) => event.t);
      expect(kinds).toContain("initRejected");
      expect(kinds).not.toContain("startRefused");
      expect(step.state.startFailure).toBeNull();
      const decided = result(step.state, { code: 143, signal: null });
      expect(decided.outcome).toBe("initRejected");
      expect(decided.park?.reason).toBe("worker-failed");
    }
  });

  it("refuses the plugin when the key source and model pass", () => {
    const step = interpret(initLine({}), checkingState());
    expect(step.events.map((event) => event.t)).toEqual(["startRefused", "started"]);
    expect(result(step.state, { code: 143, signal: null }).outcome).toBe("startFailed");
  });
});

describe("(unit) withBuiltinPlugins", () => {
  it("names only redacted plugins, so an explicit list passes through", () => {
    const live = loadRecording("safety-plugin-off");
    const initOf = (recording: typeof live) =>
      recording.lines
        .map((line) => line.data as { subtype?: string; plugins?: { source?: string }[] })
        .find((data) => data.subtype === "init");
    expect(initOf(withBuiltinPlugins(live))?.plugins?.map((p) => p.source)).toEqual([
      ...BUILTIN_PLUGINS,
    ]);
    const named = withBuiltinPlugins(withInitPlugins(live, [WARP]));
    expect(initOf(named)?.plugins?.map((p) => p.source)).toEqual([WARP]);
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
    // Stopped at system/init: the refusal comes before `started`, so the engine acts on it first.
    const kinds = run.events.map((event) => event.t);
    expect(kinds.filter((kind) => kind === "startRefused")).toHaveLength(1);
    expect(kinds.indexOf("startRefused")).toBeLessThan(kinds.indexOf("started"));
    expect(run.events.find((event) => event.t === "startRefused")).toEqual({
      t: "startRefused",
      reason: pluginRefusal([WARP]),
    });
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
