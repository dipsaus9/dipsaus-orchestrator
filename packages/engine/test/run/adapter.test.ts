// The Claude CLI `WorkerAdapter` per run (DIPO-74 AC #6 and #7): `plan(spec)` is DIPO-40's
// `plan(spec, ctx)` with the run's launch context bound, the interpret half threads the parser
// state, and a path the plan refuses names itself and its character.

import { describe, expect, it } from "bun:test";

import { ManualClock } from "@dipsaus-orchestrator/testkit";

import { OFFICE_DEFAULTS } from "../../src/config";
import { planRefusedText, runWorkerSpec, sessionUuid } from "../../src/run";
import {
  claudeCliAdapter,
  claudeLaunchContext,
  claudeWorkerPort,
} from "../../src/workers/claude-cli/adapter";
import { initialState } from "../../src/workers/claude-cli/interpret";
import { plan } from "../../src/workers/claude-cli/plan";
import { WORKER_REPORT_JSON_SCHEMA } from "../../src/workers/claude-cli/report-schema";
import { stripLocalSettings } from "../../src/workers/claude-cli/settings-check";
import { AdapterHolds } from "../../src/workers/hold";
import type { RunLaunchPaths } from "../../src/workers/port";
import { PlanError, type ParseState } from "../../src/workers/types";
import {
  context,
  HOME,
  MAIN,
  RUN_DIR,
  SHORT_TMP_DIR,
  spec,
  TMP_DIR,
  WORKDIR,
} from "../workers/launch-fixtures";
import { hostLines } from "../ingest/helpers";
import { loadRecording } from "../workers/replay";

const clock = new ManualClock();
const neverSpawn = () => {
  throw new Error("no process may start in this test");
};
const PATHS: RunLaunchPaths = {
  workdir: WORKDIR,
  mainCheckout: MAIN,
  runDir: RUN_DIR,
  hostSocket: `${RUN_DIR}/host.sock`,
  tmpDir: TMP_DIR,
  shortTmpDir: SHORT_TMP_DIR,
};

describe("the worker port seam (DIPO-113)", () => {
  it("hands out the Claude report schema and the local settings copy", () => {
    const port = claudeWorkerPort({
      claudePath: `${HOME}/.local/bin/claude`,
      home: HOME,
      env: { PATH: "/usr/bin:/bin", HOME },
      dipoCommand: ["/opt/dipo/bin/dipo"],
      spawn: neverSpawn,
      clock,
      holds: new AdapterHolds({ clock, notify: () => undefined }),
      platform: "darwin",
      runStep: async () => {
        throw new Error("no step may run in this test");
      },
      uid: 501,
    });
    expect(port.reportSchema).toBe(WORKER_REPORT_JSON_SCHEMA);
    expect(port.localSettings.file).toBe(".claude/settings.local.json");
    expect(port.localSettings.strip).toBe(stripLocalSettings);
  });

  it("builds a run's WorkerSpec with the port's report schema", () => {
    const reportSchema = { type: "object", title: "another adapter's report" };
    const built = runWorkerSpec(
      { reportSchema },
      { runId: "run_1", agent: "agt_1", caps: OFFICE_DEFAULTS.tiers.S },
      PATHS,
      "task",
      { id: "s-1", resume: false },
    );
    expect(built.reportSchema).toBe(reportSchema);
  });
});

describe("the Claude CLI adapter of one run", () => {
  it("binds plan(spec) to the run's launch context", () => {
    const ctx = context();
    const adapter = claudeCliAdapter(ctx, { spawn: neverSpawn, clock });
    expect(adapter.id).toBe("claude-cli");
    expect(adapter.plan(spec())).toEqual(plan(spec(), ctx));
  });

  it("builds the launch context from the run's paths, the office sandbox and the daemon", () => {
    const deps = {
      claudePath: `${HOME}/.local/bin/claude`,
      home: HOME,
      env: { PATH: "/usr/bin:/bin", HOME },
      dipoCommand: ["/opt/dipo/bin/dipo"] as [string],
      pluginFiles: { read: () => undefined, dirs: () => [] },
    };
    const ctx = claudeLaunchContext(deps, PATHS, OFFICE_DEFAULTS);
    expect(ctx).toEqual({
      claudePath: deps.claudePath,
      home: HOME,
      env: deps.env,
      toolVariables: [],
      mainCheckout: MAIN,
      runDir: RUN_DIR,
      hostSocket: `${RUN_DIR}/host.sock`,
      tmpDir: TMP_DIR,
      shortTmpDir: SHORT_TMP_DIR,
      sandbox: OFFICE_DEFAULTS.sandbox,
      plugins: { installed: [], allowed: [] },
      hookCommand: ["/opt/dipo/bin/dipo"],
      permissionWaitSeconds: 300,
    });
    const port = claudeWorkerPort({
      ...deps,
      spawn: neverSpawn,
      clock,
      holds: new AdapterHolds({ clock, notify: () => undefined }),
      platform: "darwin",
      runStep: async () => {
        throw new Error("no step may run in this test");
      },
      uid: 501,
    });
    expect(port.adapter(PATHS, OFFICE_DEFAULTS).plan(spec())).toEqual(plan(spec(), ctx));
  });

  it("detects Safe-Chain at launch and gives the plan its wrapper in the run directory (DIPO-82, DIPO-84)", () => {
    const seen: unknown[] = [];
    const found = {
      root: `${HOME}/.safe-chain`,
      shell: "/bin/zsh",
      path: "/usr/bin:/bin",
      demoted: [],
      dropped: [],
      probe: "bun",
    };
    const deps = {
      claudePath: `${HOME}/.local/bin/claude`,
      home: HOME,
      env: { PATH: "/usr/bin:/bin", HOME },
      detectSafeChain: (input: unknown) => {
        seen.push(input);
        return found;
      },
    };
    const ctx = claudeLaunchContext(deps, PATHS, OFFICE_DEFAULTS);
    expect(ctx.safeChain).toEqual({ ...found, shellDir: `${RUN_DIR}/safe-chain` });
    // Detection reads the office's toolchain and allowRead paths, with ~ expanded.
    expect(seen).toEqual([
      {
        home: HOME,
        env: deps.env,
        readPaths: [`${HOME}/.bun`, `${HOME}/.npm`, `${HOME}/.cache`],
      },
    ]);
    // The dry run shows the wrapper, its init file and the proxy description among the run
    // directory's files, with placeholders for the proxy a real run starts (DIPO-84).
    const files = claudeCliAdapter(ctx, { spawn: neverSpawn, clock }).plan(spec()).files;
    const names = files.map((file) => file.name);
    expect(names).toContain("safe-chain/zsh");
    expect(names).toContain("safe-chain/.zshenv");
    expect(names).toContain("safe-chain/proxy.json");
    const settings = files.find((file) => file.name === "claude-settings.json")?.content ?? "{}";
    expect(JSON.parse(settings).sandbox.network.httpProxyPort).toBe(0);
    // A machine without Safe-Chain: no field at all.
    const none = claudeLaunchContext(
      { ...deps, detectSafeChain: () => null },
      PATHS,
      OFFICE_DEFAULTS,
    );
    expect("safeChain" in none).toBe(false);
  });

  it("switches off every installed plugin but worker.plugins, reading the list per launch (DIPO-108)", () => {
    const read: string[] = [];
    let installed = ["warp@claude-code-warp"];
    const deps = {
      claudePath: `${HOME}/.local/bin/claude`,
      home: HOME,
      env: { PATH: "/usr/bin:/bin", HOME },
      pluginFiles: {
        read: (path: string) => {
          read.push(path);
          if (!path.endsWith("installed_plugins.json")) return undefined;
          return JSON.stringify({
            version: 2,
            plugins: Object.fromEntries(installed.map((id) => [id, []])),
          });
        },
        dirs: () => [],
      },
    };
    const config = {
      ...OFFICE_DEFAULTS,
      worker: { ...OFFICE_DEFAULTS.worker, plugins: ["dipsaus-ai@dipsaus-ai"] },
    };
    const settingsOf = () => {
      const files = claudeCliAdapter(claudeLaunchContext(deps, PATHS, config), {
        spawn: neverSpawn,
        clock,
      }).plan(spec()).files;
      return JSON.parse(
        files.find((file) => file.name === "claude-settings.json")?.content ?? "{}",
      );
    };
    expect(settingsOf().enabledPlugins).toEqual({ "warp@claude-code-warp": false });
    installed = ["dipsaus-ai@dipsaus-ai", "warp@claude-code-warp", "zeta@market"];
    expect(settingsOf().enabledPlugins).toEqual({
      "warp@claude-code-warp": false,
      "zeta@market": false,
    });
    const once = [
      `${HOME}/.claude/plugins/installed_plugins.json`,
      `${HOME}/.claude/plugins/known_marketplaces.json`,
    ];
    expect(read).toEqual([...once, ...once]);
  });

  it("refuses to plan when the plugin list cannot be read, but still interprets (DIPO-108)", () => {
    const ctx = claudeLaunchContext(
      {
        claudePath: `${HOME}/.local/bin/claude`,
        home: HOME,
        env: {},
        pluginFiles: { read: () => "{ not json", dirs: () => [] },
      },
      PATHS,
      OFFICE_DEFAULTS,
    );
    const adapter = claudeCliAdapter(ctx, { spawn: neverSpawn, clock });
    expect(() => adapter.plan(spec())).toThrow(/installed_plugins\.json/);
    expect(() => adapter.plan(spec())).toThrow(PlanError);
    const step = adapter.interpret(
      { t: 1, ch: "stdout", data: "" },
      initialState() as unknown as ParseState,
    );
    expect(step.events).toEqual([]);
  });

  it("checks system/init against worker.plugins in the adapter's parser (DIPO-108)", () => {
    const ctx = claudeLaunchContext(
      {
        claudePath: `${HOME}/.local/bin/claude`,
        home: HOME,
        env: {},
        pluginFiles: { read: () => undefined, dirs: () => [] },
      },
      PATHS,
      OFFICE_DEFAULTS,
    );
    const adapter = claudeCliAdapter(ctx, { spawn: neverSpawn, clock });
    const init = {
      type: "system",
      subtype: "init",
      session_id: "s",
      model: "claude-haiku-5-5",
      claude_code_version: "2.1.301",
      permissionMode: "default",
      tools: ["Read"],
      apiKeySource: "none",
      plugins: [{ name: "warp", source: "warp@claude-code-warp", path: "/x" }],
    };
    // The launch's configuration decides, whatever the stored state held (a null included).
    const stored = { ...initialState({ plannedModel: "haiku" }), allowedPlugins: null };
    const step = adapter.interpret(
      { t: 1, ch: "stdout", data: `${JSON.stringify(init)}\n` },
      stored as unknown as ParseState,
    );
    expect(step.events.map((event) => event.t)).toEqual(["startRefused", "started"]);
    const state = step.state as unknown as { startFailure: string | null; plugins: string[] };
    expect(state.plugins).toEqual(["warp@claude-code-warp"]);
    expect(state.startFailure).toContain("warp@claude-code-warp");
    const result = adapter.result(step.state, { code: 143, signal: null });
    expect(result.outcome).toBe("startFailed");
    expect(result.detail).toContain("plugin warp@claude-code-warp, not in worker.plugins");
    expect(result.park).toBeUndefined();
  });

  it("refuses to plan without a resolved claude", () => {
    expect(() =>
      claudeLaunchContext({ claudePath: undefined, home: HOME, env: {} }, PATHS, OFFICE_DEFAULTS),
    ).toThrow(PlanError);
  });

  it("threads the parser state through interpret and reads the result", () => {
    const adapter = claudeCliAdapter(context(), { spawn: neverSpawn, clock });
    let state = initialState({ plannedModel: "haiku" }) as unknown as ParseState;
    const kinds: string[] = [];
    for (const line of hostLines(loadRecording("success-single"))) {
      const step = adapter.interpret(line, state);
      state = step.state;
      kinds.push(...step.events.map((event) => event.t));
    }
    expect(kinds).toContain("started");
    expect(kinds).toContain("turn");
    expect(adapter.result(state, { code: 0, signal: null }).outcome).toBe("done");
  });
});

describe("a path the plan refuses", () => {
  it("names the path and the character, and suggests moving the checkout or the worktree root", () => {
    const workdir = "/home/maintainer/code/shop (copy).worktrees/DIPO-999";
    let error: unknown;
    try {
      plan(spec({ workdir }), context());
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(PlanError);
    expect((error as PlanError).refused).toEqual({ path: workdir, character: "(" });
    const text = planRefusedText("DIPO-999", error as PlanError);
    expect(text).toContain(workdir);
    expect(text).toContain('"("');
    expect(text).toContain("Move the checkout, or set worktree.root in .dipo/office.yaml");
  });

  it("names a worktree that holds the home directory, without a character", () => {
    let error: unknown;
    try {
      plan(spec({ workdir: "/home" }), context({ mainCheckout: "/srv/shop" }));
    } catch (thrown) {
      error = thrown;
    }
    expect((error as PlanError).refused).toEqual({ path: "/home" });
  });
});

describe("session ids", () => {
  it("are version 4 UUIDs, the same for the same engine id", () => {
    const id = sessionUuid("agt_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(sessionUuid("agt_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D")).toBe(id);
    expect(sessionUuid("agt_01J9ZK5Q8W3V4X6Y7Z8A9B0C1E")).not.toBe(id);
  });
});
