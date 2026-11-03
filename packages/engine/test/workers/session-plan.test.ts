// The Claude adapter's `session` kind (DIPO-310 criterion 1; 0021): the scan
// fallback's session is planned on the Mac with no box, in an empty folder dipo made, with no
// worktree, branch or story, every tool off (no read, shell or web), no hooks or MCP server, every
// plugin off, the fallback's structured-output schema, and the model, effort and turn cap of its
// spec. Its result carries the structured output for the engine to check; it never resumes.

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { OFFICE_DEFAULTS } from "../../src/config";
import { SCAN_ANSWER_JSON_SCHEMA } from "../../src/scan/answer";
import { SCAN_DEFAULTS } from "../../src/scan/feature";
import { SCAN_MAX_TURNS } from "../../src/scan/fallback";
import {
  type ClaudeParseState,
  initialState,
  interpret,
  SUBAGENT_TOOLS,
} from "../../src/workers/claude-cli/interpret";
import {
  EMPTY_MCP_CONFIG_FILE,
  ENV_ALLOWLIST,
  plan,
  REPORT_SCHEMA_FILE,
  SESSION_DENIED_TOOLS,
  SETTINGS_FILE,
  type ClaudeLaunchContext,
} from "../../src/workers/claude-cli/plan";
import { result } from "../../src/workers/claude-cli/result";
import {
  checkProjectSettings,
  LOCAL_SETTINGS_FILE,
  PROJECT_SETTINGS_FILE,
} from "../../src/workers/claude-cli/settings-check";
import {
  allowedTools,
  DEVELOPER_TOOLS,
  REVIEW_TOOLS,
  WEB_TOOLS,
} from "../../src/workers/claude-cli/tools";
import { type HostLine, type LaunchPlan, type WorkerSpec } from "../../src/workers/types";

const HOME = "/home/maintainer";
const RUN_DIR = "/home/maintainer/code/shop/.git/dipo/runs/run-0002";
const FOLDER = "/tmp/dipo-scan-run-0002-agt-0002/session";
const MODEL = "claude-sonnet-5";

function spec(overrides: Partial<WorkerSpec> = {}): WorkerSpec {
  return {
    run: "run-0002",
    agent: "agt-0002",
    kind: "session",
    workdir: FOLDER,
    model: SCAN_DEFAULTS.model,
    effort: SCAN_DEFAULTS.effort,
    caps: {
      budgetTokens: SCAN_DEFAULTS.budgetTokens,
      maxTurns: SCAN_MAX_TURNS,
      maxMinutes: SCAN_DEFAULTS.maxMinutes,
    },
    systemFile: `${RUN_DIR}/system-scan.md`,
    taskMessage: "<scan_request>\n- verify: unresolved\n</scan_request>",
    web: false,
    session: { id: "1e6f3f4c-5b8d-4c1e-9a2b-3c4d5e6f7a8b" },
    reportSchema: SCAN_ANSWER_JSON_SCHEMA,
    ...overrides,
  };
}

function context(overrides: Partial<ClaudeLaunchContext> = {}): ClaudeLaunchContext {
  return {
    claudePath: "/home/maintainer/.local/bin/claude",
    home: HOME,
    env: { PATH: "/usr/bin:/bin", HOME, ANTHROPIC_API_KEY: "sk-not-real" },
    toolVariables: [],
    mainCheckout: "/home/maintainer/code/shop",
    runDir: RUN_DIR,
    tmpDir: "/tmp/claude-run-0002",
    shortTmpDir: "/private/tmp/dipo-t-0002",
    plugins: { installed: ["warp@claude-code-warp"], allowed: ["warp@claude-code-warp"] },
    ...overrides,
  };
}

function flag(launch: LaunchPlan, name: string): string | undefined {
  const index = launch.argv.indexOf(name);
  return index === -1 ? undefined : launch.argv[index + 1];
}

function settingsOf(launch: LaunchPlan): Record<string, unknown> {
  const file = launch.files.find((entry) => entry.name === SETTINGS_FILE);
  if (file === undefined) throw new Error("no settings file");
  return JSON.parse(file.content) as Record<string, unknown>;
}

describe("the scan session's launch plan", () => {
  const launch = plan(spec(), context());

  it("defaults to sonnet, low effort, 100000 budget tokens, 5 minutes and one turn plus a retry", () => {
    expect(SCAN_DEFAULTS).toEqual(OFFICE_DEFAULTS.scan);
    expect(OFFICE_DEFAULTS.scan).toEqual({
      model: "sonnet",
      effort: "low",
      budgetTokens: 100_000,
      maxMinutes: 5,
    });
    expect(flag(launch, "--model")).toBe("sonnet");
    expect(flag(launch, "--effort")).toBe("low");
    expect(flag(launch, "--max-turns")).toBe("2");
  });

  it("runs on the Mac in its empty folder, with no box, worktree or branch", () => {
    expect(launch.argv[0]).toBe("/home/maintainer/.local/bin/claude");
    expect(launch.cwd).toBe(FOLDER);
    expect(launch.stopCommand).toBeUndefined();
    expect(launch.argv.join(" ")).not.toContain("container");
    expect(launch.argv.join(" ")).not.toContain("/home/maintainer/code/shop ");
  });

  it("turns every tool off: an empty tool list and a deny rule for each tool by name", () => {
    expect(flag(launch, "--tools")).toBe("");
    const permissions = settingsOf(launch)["permissions"] as { allow: string[]; deny: string[] };
    expect(permissions.allow).toEqual([]);
    for (const tool of ["Read", "Glob", "Grep", "Bash", "Edit", "Write", "WebFetch", "WebSearch"]) {
      expect(permissions.deny).toContain(tool);
    }
    expect(permissions.deny).toEqual([...SESSION_DENIED_TOOLS]);
  });

  it("has no hooks, no MCP server and every plugin off, the office's allowed one too", () => {
    const settings = settingsOf(launch);
    expect(settings["hooks"]).toBeUndefined();
    expect(settings["enabledPlugins"]).toEqual({ "warp@claude-code-warp": false });
    expect(launch.argv).toContain("--strict-mcp-config");
    expect(flag(launch, "--mcp-config")).toBe(`${RUN_DIR}/${EMPTY_MCP_CONFIG_FILE}`);
  });

  it("passes the fallback's schema as the structured output and the task as first message", () => {
    expect(JSON.parse(flag(launch, "--json-schema") ?? "null")).toEqual(SCAN_ANSWER_JSON_SCHEMA);
    expect(launch.files.map((file) => file.name)).toContain(REPORT_SCHEMA_FILE);
    expect(launch.stdin).toHaveLength(1);
    expect(launch.stdin[0]).toContain("verify: unresolved");
    expect(flag(launch, "--session-id")).toBe(spec().session.id);
  });

  it("refuses a session with a tool or a folder in the checkout", () => {
    expect(() => plan(spec({ web: true }), context())).toThrow(/every tool off/);
    expect(() => plan(spec({ workdir: "/home/maintainer/code/shop/sub" }), context())).toThrow(
      /outside the main checkout/,
    );
  });
});

function out(data: unknown): HostLine {
  return { t: 0, ch: "stdout", data: JSON.stringify(data) };
}

function feed(lines: readonly HostLine[]): ClaudeParseState {
  let state = initialState({ reportKind: "session", plannedModel: MODEL });
  for (const line of lines) state = interpret(line, state).state;
  return state;
}

const resultLine = (extra: Record<string, unknown> = {}) =>
  out({
    type: "result",
    subtype: "success",
    session_id: "session-2",
    is_error: false,
    num_turns: 1,
    terminal_reason: "completed",
    permission_denials: [],
    structured_output: { proposals: [] },
    modelUsage: {
      [MODEL]: {
        inputTokens: 900,
        outputTokens: 120,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
    },
    ...extra,
  });

describe("the scan session's result", () => {
  it("carries the structured output, cleaned at the door, as the answer", () => {
    const answer = { proposals: [{ capability: "verify", evidence: ["Makefile\u001b[2J"] }] };
    const state = feed([resultLine({ structured_output: answer })]);
    expect(state.lastTurn?.answer).toEqual({
      proposals: [{ capability: "verify", evidence: ["Makefile"] }],
    });
    const done = result(state, { code: 0, signal: null });
    expect(done.outcome).toBe("done");
    expect(done.answer).toEqual(state.lastTurn?.answer);
    expect(done.park).toBeUndefined();
    expect(done.usage[MODEL]).toMatchObject({ input: 900, output: 120 });
  });

  it("ends blocked with no park and no feedback turn when there is no answer", () => {
    const state = feed([resultLine({ structured_output: undefined })]);
    const ended = result(state, { code: 0, signal: null });
    expect(ended).toMatchObject({ outcome: "blocked" });
    expect(ended.park).toBeUndefined();
    expect(ended.retry).toBeUndefined();
    expect(ended.detail).toContain("no structured_output");
  });

  it("reads a 429 as a plan limit, which the fallback waits on", () => {
    const state = feed([resultLine({ subtype: "error_during_execution", api_error_status: 429 })]);
    expect(result(state, { code: 1, signal: null }).outcome).toBe("plan-limit");
  });
});

// The scan session has no Bash sandbox (0008): with every tool off there is no command for one to
// hold. These tests run the real plan builder and the real project settings check, and fail when a
// tool, a permission or a settings source that could hand the session a tool comes back.
describe("the scan session without a Bash sandbox", () => {
  const launch = plan(spec(), context());
  const settings = settingsOf(launch);
  const denied = (settings["permissions"] as { deny: string[] }).deny;

  /** True when the plan gives the session none of `tools`: not on `--tools`, each denied by name. */
  function closed(tools: readonly string[]): void {
    expect(flag(launch, "--tools")).toBe("");
    for (const tool of tools) expect(denied).toContain(tool);
  }

  // What the old sandbox settings caught, each for the shell commands it held; the session runs
  // none, and every tool that could do the same is off.
  it("writes outside the run's temp roots (its folder, the checkout, .git, srt's defaults): no writing tool", () =>
    closed(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"]));

  it("reads of the Keychain and credential files: no reading tool, reads closed outside its folder", () => {
    closed(["Bash", "Read", "Grep", "Glob", "LS", "NotebookRead"]);
    const permissions = settings["permissions"] as Record<string, unknown>;
    expect(permissions["blockReadsOutsideWorkingDirectories"]).toBe(true);
  });

  it("credential variables masked for commands: none reaches the session at all", () => {
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN"]) {
      const env = plan(spec(), context({ env: { ...context().env, [name]: "secret" } })).env;
      expect(env[name]).toBeUndefined();
      expect(() => plan(spec(), context({ toolVariables: [name] }))).toThrow(/may not reach/);
    }
  });

  it("the network and local binding: no shell, web or MCP tool", () => {
    closed(["Bash", "WebFetch", "WebSearch"]);
    expect(launch.argv).toContain("--strict-mcp-config");
    expect(flag(launch, "--mcp-config")).toBe(`${RUN_DIR}/${EMPTY_MCP_CONFIG_FILE}`);
  });

  it("commands run outside the sandbox: no command tool at all", () =>
    closed(["Bash", "BashOutput", "KillShell"]));

  it("fails closed: every tool any kind or subagent has is denied by name, and none is allowed", () => {
    expect(allowedTools({ kind: "session", web: false })).toEqual([]);
    closed([...DEVELOPER_TOOLS, ...WEB_TOOLS, ...REVIEW_TOOLS, ...SUBAGENT_TOOLS]);
    expect(settings).toEqual({
      includeGitInstructions: false,
      claudeMdExcludes: ["/home/maintainer/code/shop/**"],
      attribution: { commit: "", pr: "" },
      permissions: {
        allow: [],
        deny: [...SESSION_DENIED_TOOLS],
        blockReadsOutsideWorkingDirectories: true,
      },
      enabledPlugins: { "warp@claude-code-warp": false },
    });
    expect(flag(launch, "--permission-mode")).toBe("default");
    expect(launch.argv.filter((arg) => arg === "--tools")).toHaveLength(1);
    for (const arg of [
      "--allowedTools",
      "--allowed-tools",
      "--disallowedTools",
      "--add-dir",
      "--dangerously-skip-permissions",
      "--plugin-dir",
      "--agents",
    ]) {
      expect(launch.argv).not.toContain(arg);
    }
  });

  it("ignores a tool list on the spec that would turn Bash back on", () => {
    const asked = { ...spec(), tools: ["Bash"], allowedTools: ["Bash"] } as WorkerSpec;
    expect(plan(asked, context())).toEqual(launch);
    expect(() => plan(spec({ web: true }), context())).toThrow(/every tool off/);
  });

  it("keeps a quoted flag in the model or task as one value, never a second tool list", () => {
    const quoted = plan(
      spec({ model: "sonnet --tools Bash", taskMessage: '--tools "Bash" && --allowedTools Bash' }),
      context(),
    );
    expect(quoted.argv.filter((arg) => arg === "--tools")).toHaveLength(1);
    expect(flag(quoted, "--tools")).toBe("");
    expect(flag(quoted, "--model")).toBe("sonnet --tools Bash");
    expect(quoted.argv.join(" ")).not.toContain("--allowedTools");
    expect(() => plan(spec({ model: "--tools=Bash" }), context())).toThrow(/must be a non-empty/);
  });

  it("passes no variable that changes permissions, settings or where Claude Code reads its config", () => {
    const risky = {
      CLAUDE_CONFIG_DIR: "/tmp/evil-config",
      CLAUDE_CODE_SHELL: "/tmp/evil-shell",
      CLAUDE_CODE_SHELL_PREFIX: "/tmp/evil-prefix",
      ANTHROPIC_BASE_URL: "https://example.invalid",
      NODE_OPTIONS: "--require /tmp/evil.js",
      BASH_ENV: "/tmp/evil.sh",
    };
    const env = plan(
      spec(),
      context({ env: { ...context().env, ...risky, HOME: "/tmp/evil" } }),
    ).env;
    for (const name of Object.keys(risky)) expect(env[name]).toBeUndefined();
    expect(env["HOME"]).toBe(HOME);
    const set = new Set<string>([
      ...ENV_ALLOWLIST,
      "CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS",
      "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
      "DIPO_RUN",
      "DIPO_TMP",
      "npm_config_logs_dir",
    ]);
    for (const name of Object.keys(env)) expect(set.has(name)).toBe(true);
    for (const name of Object.keys(risky)) {
      expect(() => plan(spec(), context({ toolVariables: [name] }))).toThrow(/may not reach/);
    }
  });

  it("loads no user settings, and no settings file of the scanned repository", () =>
    withTempDir(async (dir) => {
      expect(flag(launch, "--setting-sources")).toBe("project,local");
      // A scanned repository whose settings would turn Bash on and let it run unchecked.
      const repo = join(dir, "repo");
      mkdirSync(join(repo, ".claude"), { recursive: true });
      const turnsBashOn = {
        permissions: { allow: ["Bash"], defaultMode: "bypassPermissions" },
        sandbox: { enabled: false },
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "touch /tmp/x" }] }] },
        env: { CLAUDE_CONFIG_DIR: "/tmp/evil-config" },
      };
      writeFileSync(join(repo, PROJECT_SETTINGS_FILE), JSON.stringify(turnsBashOn));
      writeFileSync(join(repo, LOCAL_SETTINGS_FILE), JSON.stringify(turnsBashOn));
      const session = join(dir, "session");
      mkdirSync(session);
      const inRepo = context({ mainCheckout: repo });
      // The session never runs in the repository, below it or above it.
      for (const workdir of [repo, join(repo, "sub"), dir]) {
        expect(() => plan(spec({ workdir }), inRepo)).toThrow(/outside the main checkout/);
      }
      expect(plan(spec({ workdir: session }), inRepo).cwd).toBe(session);
      expect(settingsOf(plan(spec({ workdir: session }), inRepo))["claudeMdExcludes"]).toEqual([
        `${repo}/**`,
      ]);
      // And the real settings check refuses each key if a session folder ever held the file.
      expect(await checkProjectSettings(session)).toEqual([]);
      const keys = (await checkProjectSettings(repo)).map((failure) => failure.key);
      for (const key of [
        "permissions.allow",
        "permissions.defaultMode",
        "sandbox",
        "hooks",
        "env",
      ]) {
        expect(keys).toContain(key);
      }
    }));
});
