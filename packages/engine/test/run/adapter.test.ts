// The Claude CLI `WorkerAdapter` per run (DIPO-74 AC #6 and #7): `plan(spec)` is DIPO-40's
// `plan(spec, ctx)` with the run's launch context bound, the interpret half threads the parser
// state, and a path the plan refuses names itself and its character.

import { describe, expect, it } from "bun:test";

import { ManualClock } from "@dipsaus-orchestrator/testkit";

import { OFFICE_DEFAULTS } from "../../src/config";
import { planRefusedText, runWorkerSpec, sessionUuid } from "../../src/run";
import { REVIEW_SYSTEM_FILE } from "../../src/run/launch";
import {
  CLAUDE_LINE_SCRUB,
  claudeCliAdapter,
  claudeLaunchContext,
  claudeWorkerPort,
} from "../../src/workers/claude-cli/adapter";
import { initialState } from "../../src/workers/claude-cli/interpret";
import { plan } from "../../src/workers/claude-cli/plan";
import {
  REPORT_JSON_SCHEMAS,
  REVIEW_REPORT_JSON_SCHEMA,
  WORKER_REPORT_JSON_SCHEMA,
} from "../../src/workers/claude-cli/report-schema";
import { stripLocalSettings } from "../../src/workers/claude-cli/settings-check";
import { AdapterHolds } from "../../src/workers/hold";
import type { RunLaunchPaths } from "../../src/workers/port";
import { PlanError, type HostLine, type ParseState } from "../../src/workers/types";
import {
  context,
  HOME,
  MAIN,
  sessionSpec,
  RUN_DIR,
  scriptedClaude,
  SHORT_TMP_DIR,
  spec,
  TMP_DIR,
  withoutSkills,
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

/** A reviewer session's system/init line with `plugins` and `skills` (DIPO-145). */
function reviewerInit(plugins: unknown[], skills: string[] = []): HostLine {
  return {
    t: 1,
    ch: "stdout",
    data: `${JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "s",
      model: "claude-opus-5-5",
      claude_code_version: "2.1.301",
      permissionMode: "default",
      tools: ["Bash", "Glob", "Grep", "Read", "StructuredOutput"],
      apiKeySource: "none",
      plugins,
      skills,
    })}\n`,
  };
}

describe("the worker port seam (DIPO-113)", () => {
  it("hands out the Claude report schema and the local settings copy", () => {
    const port = claudeWorkerPort({
      claudePath: `${HOME}/.local/bin/claude`,
      home: HOME,
      env: { PATH: "/usr/bin:/bin", HOME },
      spawn: neverSpawn,
      clock,
      holds: new AdapterHolds({ clock, notify: () => undefined }),
    });
    expect(port.reportSchema).toBe(REPORT_JSON_SCHEMAS);
    expect(port.reportSchema.implement).toBe(WORKER_REPORT_JSON_SCHEMA);
    expect(port.reportSchema.review).toBe(REVIEW_REPORT_JSON_SCHEMA);
    expect(port.localSettings.file).toBe(".claude/settings.local.json");
    expect(port.localSettings.strip).toBe(stripLocalSettings);
  });

  it("builds a run's WorkerSpec with the port's report schema", () => {
    const reportSchema = {
      implement: { type: "object", title: "another adapter's report" },
      review: { type: "object", title: "another adapter's review report" },
    };
    const built = runWorkerSpec(
      { reportSchema },
      { runId: "run_1", agent: "agt_1", caps: OFFICE_DEFAULTS.tiers.S },
      PATHS,
      "task",
      { id: "s-1", resume: false },
    );
    expect(built.kind).toBe("implement");
    expect(built.reportSchema).toBe(reportSchema.implement);
  });

  it("gives the developer the web tools with web, and the reviewer only its own tools even with web (DIPO-164)", () => {
    const tier = OFFICE_DEFAULTS.tiers.S;
    const specOf = (facts: { web?: boolean; reviewer?: typeof OFFICE_DEFAULTS.review }) =>
      runWorkerSpec(
        { reportSchema: REPORT_JSON_SCHEMAS },
        { runId: "run_1", agent: "agt_1", caps: tier, ...facts },
        PATHS,
        "task",
        { id: "s-1", resume: false },
      );
    // The engine says only whether the web is on; the adapter names the tools (DIPO-318).
    expect(specOf({ web: true }).web).toBe(true);
    expect(specOf({ web: false }).web).toBe(false);
    const reviewer = specOf({ web: false, reviewer: OFFICE_DEFAULTS.review });
    expect(reviewer.kind).toBe("review");
    expect(reviewer.web).toBe(false);
  });

  it("builds a reviewer's WorkerSpec: kind review, the review model and effort, the ReviewReport schema (DIPO-145)", () => {
    const review = { ...OFFICE_DEFAULTS.review, model: "opus", effort: "high", maxTurns: 40 };
    const tier = OFFICE_DEFAULTS.tiers.S;
    const built = runWorkerSpec(
      { reportSchema: REPORT_JSON_SCHEMAS },
      { runId: "run_1", agent: "agt_2", caps: tier, reviewer: review },
      PATHS,
      "review task",
      // The reviewer never resumes, whatever the caller asks.
      { id: "s-2", resume: true },
      { budgetTokens: 123_000, maxTurns: tier.maxTurns, maxMinutes: tier.maxMinutes },
    );
    expect(built.kind).toBe("review");
    expect(built.model).toBe("opus");
    expect(built.effort).toBe("high");
    expect(built.caps).toEqual({
      budgetTokens: 123_000,
      maxTurns: 40,
      maxMinutes: OFFICE_DEFAULTS.review.maxMinutes,
    });
    expect(built.web).toBe(false);
    expect(built.session).toEqual({ id: "s-2", resume: false });
    expect(built.systemFile).toBe(`${RUN_DIR}/${REVIEW_SYSTEM_FILE}`);
    expect(built.reportSchema).toBe(REVIEW_REPORT_JSON_SCHEMA);
    // The ReviewReport of 0019 section 5: findings with testEntry, a summary of at most 1,500.
    const schema = built.reportSchema as {
      required: string[];
      properties: {
        summary: { maxLength: number };
        findings: { items: { properties: Record<string, unknown>; required: string[] } };
        criteria: { items: { properties: { status: { enum: string[] } } } };
      };
    };
    expect(schema.required.toSorted()).toEqual(["criteria", "findings", "summary"]);
    expect(schema.properties.summary.maxLength).toBe(1_500);
    expect(Object.keys(schema.properties.findings.items.properties).toSorted()).toEqual([
      "criterion",
      "file",
      "kind",
      "line",
      "quote",
      "severity",
      "testEntry",
      "text",
    ]);
    expect(schema.properties.findings.items.required.toSorted()).toEqual([
      "kind",
      "severity",
      "text",
    ]);
    expect(schema.properties.criteria.items.properties.status.enum).toEqual([
      "met",
      "unmet",
      "maintainer",
    ]);
  });
});

describe("the Claude CLI adapter of one run", () => {
  it("binds plan(spec) to the run's launch context", () => {
    const ctx = context();
    const adapter = claudeCliAdapter(ctx, { spawn: neverSpawn, clock });
    expect(adapter.id).toBe("claude-cli");
    expect(adapter.plan(sessionSpec())).toEqual({
      ...plan(sessionSpec(), ctx),
      lineScrub: CLAUDE_LINE_SCRUB,
    });
    // A developer session is never planned on the Mac (DIPO-240).
    expect(() => adapter.plan(spec())).toThrow(PlanError);
  });

  it("builds the launch context from the run's paths, the office sandbox and the daemon", () => {
    const deps = {
      claudePath: `${HOME}/.local/bin/claude`,
      home: HOME,
      env: { PATH: "/usr/bin:/bin", HOME },
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
      tmpDir: TMP_DIR,
      shortTmpDir: SHORT_TMP_DIR,
      sandbox: OFFICE_DEFAULTS.sandbox,
      plugins: { installed: [], allowed: [] },
    });
    const port = claudeWorkerPort({
      ...deps,
      spawn: neverSpawn,
      clock,
      holds: new AdapterHolds({ clock, notify: () => undefined }),
    });
    expect(port.adapter(PATHS, OFFICE_DEFAULTS).plan(sessionSpec())).toEqual({
      ...plan(sessionSpec(), ctx),
      lineScrub: CLAUDE_LINE_SCRUB,
    });
  });

  it("gives the plan that prepare returns for a session the line scrub (DIPO-105)", async () => {
    // Production launches take their plan from prepare, not from adapter.plan.
    const claude = scriptedClaude(clock, {});
    const port = claudeWorkerPort({
      claudePath: `${HOME}/.local/bin/claude`,
      home: HOME,
      env: { PATH: "/usr/bin:/bin", HOME },
      spawn: claude.spawn,
      clock,
      holds: new AdapterHolds({ clock, notify: () => undefined }),
      pluginFiles: { read: () => undefined, dirs: () => [] },
      launchCheckSeams: { readText: async () => undefined },
    });
    const prepared = await port.prepare(sessionSpec(), PATHS, OFFICE_DEFAULTS, "check");
    if (!prepared.ok) throw new Error(`prepare refused: ${JSON.stringify(prepared)}`);
    expect(prepared.plan.argv).toContain("--session-id");
    expect(prepared.plan.lineScrub).toEqual(CLAUDE_LINE_SCRUB);
  });

  it("switches off every installed plugin for a session, whatever worker.plugins says, reading the list per launch (DIPO-108)", () => {
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
      }).plan(sessionSpec()).files;
      return JSON.parse(
        files.find((file) => file.name === "claude-settings.json")?.content ?? "{}",
      );
    };
    expect(settingsOf().enabledPlugins).toEqual({ "warp@claude-code-warp": false });
    installed = ["dipsaus-ai@dipsaus-ai", "warp@claude-code-warp", "zeta@market"];
    expect(settingsOf().enabledPlugins).toEqual({
      "dipsaus-ai@dipsaus-ai": false,
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
    expect(() => adapter.plan(sessionSpec())).toThrow(/installed_plugins\.json/);
    expect(() => adapter.plan(sessionSpec())).toThrow(PlanError);
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

  it("refuses a reviewer whose system/init lists a plugin, even one worker.plugins allows (DIPO-145)", () => {
    const config = {
      ...OFFICE_DEFAULTS,
      worker: { ...OFFICE_DEFAULTS.worker, plugins: ["warp@claude-code-warp"] },
    };
    const ctx = claudeLaunchContext(
      {
        claudePath: `${HOME}/.local/bin/claude`,
        home: HOME,
        env: {},
        pluginFiles: { read: () => undefined, dirs: () => [] },
      },
      PATHS,
      config,
    );
    const port = claudeWorkerPort({
      claudePath: `${HOME}/.local/bin/claude`,
      home: HOME,
      env: {},
      spawn: neverSpawn,
      clock,
      holds: new AdapterHolds({ clock, notify: () => undefined }),
    });
    const adapter = claudeCliAdapter(ctx, { spawn: neverSpawn, clock });
    const warp = [{ name: "warp", source: "warp@claude-code-warp", path: "/x" }];
    const builtin = [{ name: "agents-md", source: "cc-plugin-agents-md@builtin", path: "/b" }];
    const review = spec({ kind: "review", model: "opus" });
    // The worker of the same office may load warp; the reviewer may not.
    const worker = adapter.interpret(
      reviewerInit(warp),
      port.initialState(spec({ model: "opus" })),
    );
    expect(worker.events.map((event) => event.t)).toEqual(["started"]);
    const reviewer = adapter.interpret(reviewerInit(warp), port.initialState(review));
    expect(reviewer.events.map((event) => event.t)).toEqual(["startRefused", "started"]);
    const result = adapter.result(reviewer.state, { code: 143, signal: null });
    expect(result.outcome).toBe("startFailed");
    expect(result.detail).toContain("a reviewer session loads no plugin");
    // Claude Code's own builtin plugins pass, as for workers.
    const clean = adapter.interpret(reviewerInit(builtin), port.initialState(review));
    expect(clean.events.map((event) => event.t)).toEqual(["started"]);
  });

  it("refuses a reviewer whose system/init lists a skill (DIPO-145)", () => {
    const ctx = context();
    const port = claudeWorkerPort({
      claudePath: `${HOME}/.local/bin/claude`,
      home: HOME,
      env: {},
      spawn: neverSpawn,
      clock,
      holds: new AdapterHolds({ clock, notify: () => undefined }),
    });
    const adapter = claudeCliAdapter(ctx, { spawn: neverSpawn, clock });
    const step = adapter.interpret(
      reviewerInit([], ["deploy"]),
      port.initialState(spec({ kind: "review", model: "opus" })),
    );
    expect(step.events.map((event) => event.t)).toEqual(["startRefused", "started"]);
    const result = adapter.result(step.state, { code: 143, signal: null });
    expect(result.outcome).toBe("startFailed");
    expect(result.detail).toContain("skill deploy");
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
    // Recorded before the plan passed --disable-slash-commands: its bundled skills would refuse.
    for (const line of hostLines(withoutSkills(loadRecording("success-single")))) {
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
    const workdir = "/tmp/dipo-scan (copy)/session";
    let error: unknown;
    try {
      plan(sessionSpec({ workdir }), context());
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(PlanError);
    expect((error as PlanError).refused).toEqual({ path: workdir, character: "(" });
    const text = planRefusedText("DIPO-999", error as PlanError);
    expect(text).toContain(workdir);
    expect(text).toContain('"("');
    expect(text).toContain("Move the checkout to a path without it");
  });

  it("names a worktree that holds the home directory, without a character", () => {
    let error: unknown;
    try {
      plan(sessionSpec({ workdir: "/home" }), context({ mainCheckout: "/srv/shop" }));
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
