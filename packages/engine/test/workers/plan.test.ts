import { describe, expect, it } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { getDefaultWritePaths } from "@anthropic-ai/sandbox-runtime";
import { makeTempDir, removeTempDir } from "@dipsaus-orchestrator/testkit";

import { OFFICE_DEFAULTS } from "../../src/config";
import { SRT_DEFAULT_HOME_WRITE_PATHS, SRT_DEFAULT_WRITE_PATHS } from "../../src/sandbox/policy";
import {
  CLOSED_WRITES_FILE,
  closedWritePaths,
  EMPTY_MCP_CONFIG_FILE,
  GIT_WRITE_VERBS,
  plan,
  REPORT_SCHEMA_FILE,
  REVIEW_TOOLS,
  SETTINGS_FILE,
} from "../../src/workers/claude-cli/plan";
import type { ClaudeLaunchContext } from "../../src/workers/claude-cli/plan";
import {
  GATE_CRASH_EXIT,
  HOOK_BUNFIG_FILE,
  REGISTERED_HOOKS,
} from "../../src/workers/claude-cli/hooks";
import {
  REVIEW_REPORT_JSON_SCHEMA,
  WORKER_REPORT_JSON_SCHEMA,
} from "../../src/workers/claude-cli/report-schema";
import { PlanError } from "../../src/workers/types";
import type { LaunchPlan, WorkerSpec } from "../../src/workers/types";

const GOLDEN_DIR = join(import.meta.dir, "golden");
const TASK = "<story>DIPO-999 Add a greeting</story>\n<outcome>The CLI prints hello.</outcome>";
const API_KEY = "sk-ant-api03-not-a-real-key";

type TierName = "S" | "M" | "L";

function spec(tier: TierName, overrides: Partial<WorkerSpec> = {}): WorkerSpec {
  const caps = OFFICE_DEFAULTS.tiers[tier];
  return {
    run: "run-0001",
    agent: "agt-0001",
    kind: "implement",
    workdir: "/home/maintainer/code/shop.worktrees/DIPO-999",
    model: caps.model,
    effort: caps.effort,
    caps: { budgetTokens: caps.budgetTokens, maxTurns: caps.maxTurns, maxMinutes: caps.maxMinutes },
    systemFile: "/home/maintainer/code/shop/.git/dipo/runs/run-0001/system.md",
    taskMessage: TASK,
    tools: { allow: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"], deny: [] },
    session: { id: "0e6f3f4c-5b8d-4c1e-9a2b-3c4d5e6f7a8b", resume: false },
    reportSchema: WORKER_REPORT_JSON_SCHEMA,
    hookRelay: false,
    ...overrides,
  };
}

/** The run's short temp root (DIPO-118), as `shortTempDir` makes it under macOS's /tmp. */
const SHORT_TMP = "/private/tmp/dipo-t-0123456789";

function context(overrides: Partial<ClaudeLaunchContext> = {}): ClaudeLaunchContext {
  return {
    claudePath: "/home/maintainer/.local/bin/claude",
    home: "/home/maintainer",
    env: {
      PATH: "/home/maintainer/.bun/bin:/usr/bin:/bin",
      HOME: "/home/maintainer",
      USER: "maintainer",
      SHELL: "/bin/zsh",
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
      TMPDIR: "/tmp/maintainer",
      ANTHROPIC_API_KEY: API_KEY,
      ANTHROPIC_BASE_URL: "https://example.invalid",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      GH_TOKEN: "ghp_token",
      JAVA_HOME: "/opt/java",
    },
    toolVariables: ["JAVA_HOME"],
    mainCheckout: "/home/maintainer/code/shop",
    runDir: "/home/maintainer/code/shop/.git/dipo/runs/run-0001",
    hostSocket: "/home/maintainer/.dipo/run/hosts/run-0001.sock",
    tmpDir: "/tmp/claude-501",
    shortTmpDir: SHORT_TMP,
    mcpConfig: "/home/maintainer/code/shop/.git/dipo/mcp.json",
    sandbox: OFFICE_DEFAULTS.sandbox,
    ...overrides,
  };
}

function settingsOf(launch: LaunchPlan): Record<string, unknown> {
  const file = launch.files.find((entry) => entry.name === SETTINGS_FILE);
  if (file === undefined) throw new Error("no settings file");
  return JSON.parse(file.content) as Record<string, unknown>;
}

function denyWriteOf(launch: LaunchPlan): string[] {
  const sandbox = settingsOf(launch)["sandbox"] as { filesystem: { denyWrite: string[] } };
  return sandbox.filesystem.denyWrite;
}

function flag(launch: LaunchPlan, name: string): string | undefined {
  const index = launch.argv.indexOf(name);
  return index === -1 ? undefined : launch.argv[index + 1];
}

const REPO_ROOT = join(import.meta.dir, "../../../..");
const OXFMT = join(REPO_ROOT, "node_modules/.bin/oxfmt");
const OXFMT_CONFIG = join(REPO_ROOT, ".oxfmtrc.json");

/** The golden text: JSON in the layout oxfmt gives it, so a regenerated golden passes format:check (DIPO-209). */
function goldenText(value: unknown, name: string): string {
  const result = Bun.spawnSync([OXFMT, `--stdin-filepath=${name}`, "-c", OXFMT_CONFIG], {
    stdin: Buffer.from(`${JSON.stringify(value, null, 2)}\n`),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(`oxfmt failed on ${name}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

function tierGolden(tier: TierName): Record<string, unknown> {
  const launch = plan(spec(tier), context());
  return {
    argv: launch.argv,
    env: launch.env,
    cwd: launch.cwd,
    settings: settingsOf(launch),
    stdin: launch.stdin,
  };
}

async function matchGolden(name: string, value: unknown): Promise<void> {
  const path = join(GOLDEN_DIR, name);
  const text = goldenText(value, name);
  if (process.env.DIPO_UPDATE_GOLDEN === "1") await writeFile(path, text);
  expect(JSON.parse(text)).toEqual(JSON.parse(await readFile(path, "utf8")));
}

describe("claude-cli plan", () => {
  for (const tier of ["S", "M", "L"] as const) {
    it(`matches the golden argv, environment and settings file for tier ${tier}`, async () => {
      await matchGolden(`plan-${tier}.json`, tierGolden(tier));
      const launch = plan(spec(tier), context());
      const caps = OFFICE_DEFAULTS.tiers[tier];
      expect(flag(launch, "--model")).toBe(caps.model);
      expect(flag(launch, "--effort")).toBe(caps.effort);
      expect(flag(launch, "--max-turns")).toBe(String(caps.maxTurns));
    });
  }

  for (const tier of ["S", "M", "L"] as const) {
    it(`writes the tier ${tier} golden in the formatter's layout (DIPO-209)`, async () => {
      const dir = makeTempDir();
      try {
        const file = join(dir, `plan-${tier}.json`);
        await writeFile(file, goldenText(tierGolden(tier), `plan-${tier}.json`));
        const check = Bun.spawnSync([OXFMT, "--check", "-c", OXFMT_CONFIG, file], {
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(check.exitCode).toBe(0);
      } finally {
        removeTempDir(dir);
      }
    });
  }

  // The session runs no credential probe (0008 amendment of 2026-10-13), so these denies are
  // asserted on every run settings file instead, for every tier, on launch and resume.
  for (const tier of ["S", "M", "L"] as const) {
    for (const resume of [false, true]) {
      it(`carries the Keychain and credential denies (tier ${tier}${resume ? ", resume" : ""})`, () => {
        const settings = settingsOf(
          plan(
            spec(tier, { session: { id: "0e6f3f4c-5b8d-4c1e-9a2b-3c4d5e6f7a8b", resume } }),
            context(),
          ),
        ) as {
          permissions: { allow: string[]; deny: string[] };
          sandbox: {
            filesystem: { denyRead: string[] };
            credentials: {
              files: { path: string; mode: string }[];
              envVars: { name: string; mode: string }[];
            };
          };
        };
        // The Keychain folder is a sandbox read deny, never a permission rule.
        expect(settings.sandbox.filesystem.denyRead).toEqual([
          "/home/maintainer/Library/Keychains",
        ]);
        const rules = [...settings.permissions.allow, ...settings.permissions.deny].join(" ");
        expect(rules).not.toContain("Keychains");
        expect(settings.sandbox.credentials.files).toEqual(
          [".ssh", ".aws", ".config/gh", ".gnupg", ".netrc"].map((file) => ({
            path: `/home/maintainer/${file}`,
            mode: "deny",
          })),
        );
        expect(settings.sandbox.credentials.envVars).toEqual(
          ["GH_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN"].map((name) => ({ name, mode: "deny" })),
        );
        for (const rule of [
          "Read(~/.ssh/**)",
          "Read(~/.aws/**)",
          "Read(~/.config/gh/**)",
          "Read(~/.gnupg/**)",
          "Read(~/.netrc)",
          "Bash(gh *)",
        ]) {
          expect(settings.permissions.deny).toContain(rule);
        }
      });
    }
  }

  it("starts with the absolute claude path and passes the 0008 flags", () => {
    const launch = plan(spec("M"), context());
    expect(launch.argv[0]).toBe("/home/maintainer/.local/bin/claude");
    expect(launch.argv.slice(1, 7)).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
    expect(flag(launch, "--session-id")).toBe("0e6f3f4c-5b8d-4c1e-9a2b-3c4d5e6f7a8b");
    expect(launch.argv).not.toContain("--resume");
    expect(flag(launch, "--permission-mode")).toBe("default");
    expect(flag(launch, "--permission-prompts")).toBe("none");
    expect(flag(launch, "--setting-sources")).toBe("project,local");
    expect(flag(launch, "--tools")).toBe("Read,Edit,Write,Glob,Grep,Bash");
    expect(flag(launch, "--settings")).toBe(
      `/home/maintainer/code/shop/.git/dipo/runs/run-0001/${SETTINGS_FILE}`,
    );
    expect(flag(launch, "--mcp-config")).toBe("/home/maintainer/code/shop/.git/dipo/mcp.json");
    expect(flag(launch, "--append-system-prompt-file")).toBe(spec("M").systemFile);
    expect(launch.argv).toContain("--strict-mcp-config");
    expect(launch.argv).toContain("--exclude-dynamic-system-prompt-sections");
    expect(JSON.parse(flag(launch, "--json-schema") ?? "null")).toEqual(WORKER_REPORT_JSON_SCHEMA);
    for (const banned of ["--max-budget-usd", "--bare", "--add-dir"]) {
      expect(launch.argv).not.toContain(banned);
    }
    expect(launch.cwd).toBe(spec("M").workdir);
  });

  it("resumes with --resume instead of --session-id", () => {
    const launch = plan(
      spec("S", { session: { id: spec("S").session.id, resume: true } }),
      context(),
    );
    expect(flag(launch, "--resume")).toBe(spec("S").session.id);
    expect(launch.argv).not.toContain("--session-id");
  });

  it("resumes with the full flag set: only the session flag differs (DIPO-51, 0008 section 8)", () => {
    const fresh = plan(spec("M"), context());
    const resumed = plan(
      spec("M", { session: { id: spec("M").session.id, resume: true } }),
      context(),
    );
    expect([...resumed.argv]).toEqual(
      fresh.argv.map((arg) => (arg === "--session-id" ? "--resume" : arg)),
    );
    expect(resumed.env).toEqual(fresh.env);
    expect(resumed.files).toEqual(fresh.files);
  });

  it("keeps --strict-mcp-config when the office has no mcp.json", () => {
    const { mcpConfig: _none, ...rest } = context();
    const launch = plan(spec("S"), rest);
    expect(launch.argv).toContain("--strict-mcp-config");
    expect(launch.argv).not.toContain("--mcp-config");
  });

  it("refuses a claude path that is not absolute", () => {
    expect(() => plan(spec("S"), context({ claudePath: "claude" }))).toThrow(PlanError);
  });

  it("sends the task message as the first stdin line and never on argv", () => {
    const launch = plan(spec("M"), context());
    expect(launch.stdin).toHaveLength(1);
    const line = launch.stdin[0] ?? "";
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      type: "user",
      message: { role: "user", content: TASK },
      parent_tool_use_id: null,
    });
    for (const arg of launch.argv) {
      expect(arg).not.toContain("DIPO-999");
      expect(arg).not.toContain("prints hello");
    }
  });

  it("keeps an ANTHROPIC_API_KEY in the daemon environment out of the plan", () => {
    const launch = plan(spec("M"), context());
    expect(launch.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(JSON.stringify(launch)).not.toContain(API_KEY);
  });

  it("holds only allowlisted variables, declared tool variables and the six run variables", () => {
    const launch = plan(spec("M"), context());
    expect(Object.keys(launch.env).toSorted()).toEqual([
      "CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS",
      "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
      "DIPO_HOST_SOCKET",
      "DIPO_RUN",
      "DIPO_TMP",
      "HOME",
      "JAVA_HOME",
      "LANG",
      "PATH",
      "SHELL",
      "TERM",
      "TMPDIR",
      "USER",
      "npm_config_logs_dir",
    ]);
    expect(launch.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe("1");
    expect(launch.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
    expect(launch.env.DIPO_RUN).toBe("run-0001");
    expect(launch.env.DIPO_HOST_SOCKET).toBe("/home/maintainer/.dipo/run/hosts/run-0001.sock");
    expect(launch.env.DIPO_TMP).toBe(SHORT_TMP);
  });

  it("sets DIPO_TMP to the run's short temp root, never from the daemon's environment (DIPO-118)", () => {
    const env = { ...context().env, DIPO_TMP: "/home/maintainer/long/daemon/tmp" };
    expect(plan(spec("M"), context({ env })).env.DIPO_TMP).toBe(SHORT_TMP);
    // Not an office tool variable either, so nothing but the engine sets it.
    expect(() => plan(spec("M"), context({ env, toolVariables: ["DIPO_TMP"] }))).toThrow(
      "tool variable DIPO_TMP may not reach a worker",
    );
    // Without a short temp root (the recordings capture) the worker gets none at all.
    const { shortTmpDir: _, ...without } = context({ env });
    expect(plan(spec("M"), without).env).not.toHaveProperty("DIPO_TMP");
  });

  it("grows the sandbox by the short temp root only: one write path and its Unix sockets (DIPO-118)", () => {
    const { shortTmpDir: _, ...ctx } = context();
    const before = settingsOf(plan(spec("M"), ctx));
    const after = settingsOf(plan(spec("M"), context()));
    const sandbox = after["sandbox"] as {
      filesystem: { allowWrite: string[] };
      network: Record<string, unknown>;
    };
    const base = before["sandbox"] as typeof sandbox;
    expect(sandbox.filesystem.allowWrite).toEqual([
      "/home/maintainer/code/shop.worktrees/DIPO-999",
      "/tmp/claude-501",
      SHORT_TMP,
    ]);
    expect(sandbox.filesystem.allowWrite).toEqual([...base.filesystem.allowWrite, SHORT_TMP]);
    expect(sandbox.network).toEqual({ ...base.network, allowUnixSockets: [SHORT_TMP] });
    // Everything else in the settings file is the same, permission rules included.
    const rest: Record<string, unknown> = {
      ...after,
      sandbox: { ...sandbox, filesystem: base.filesystem, network: base.network },
    };
    expect(rest).toEqual(before);
  });

  it("refuses a short temp root that is the root, holds home or lies under a closed path", () => {
    for (const dir of ["/", "/home/maintainer", "/home"]) {
      expect(() => plan(spec("S"), context({ shortTmpDir: dir }))).toThrow(/shortTmpDir/);
    }
    expect(() => plan(spec("S"), context({ shortTmpDir: "/tmp/claude/dipo-t-1" }))).toThrow(
      /may not write/,
    );
    expect(() => plan(spec("S"), context({ shortTmpDir: "/private/tmp" }))).toThrow(
      /must not hold/,
    );
    expect(() => plan(spec("S"), context({ shortTmpDir: "dipo-t-1" }))).toThrow(/absolute/);
  });

  it("points npm's debug logs into the run temp directory, never home (DIPO-98)", () => {
    // Claude Code's own `npm root --global` at start runs outside the sandbox.
    expect(plan(spec("M"), context()).env.npm_config_logs_dir).toBe("/tmp/claude-501/npm-logs");
    for (const name of ["npm_config_logs_dir", "NPM_CONFIG_LOGS_DIR", "npm_config_logs_max"]) {
      expect(() => plan(spec("M"), context({ toolVariables: [name] }))).toThrow(
        `tool variable ${name} may not reach a worker`,
      );
    }
  });

  it("refuses tool variables that carry credentials", () => {
    for (const name of [
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "AWS_PROFILE",
      "GH_TOKEN",
    ]) {
      expect(() => plan(spec("S"), context({ toolVariables: [name] }))).toThrow(name);
    }
  });

  it("writes the 0008 rules and sandbox into the run settings file", () => {
    const settings = settingsOf(plan(spec("M"), context())) as {
      includeGitInstructions: boolean;
      attribution: unknown;
      permissions: {
        allow: string[];
        deny: string[];
        blockReadsOutsideWorkingDirectories: boolean;
      };
      sandbox: {
        enabled: boolean;
        failIfUnavailable: boolean;
        allowUnsandboxedCommands: boolean;
        excludedCommands?: unknown;
        filesystem: { allowWrite: string[]; denyWrite: string[]; allowRead: string[] };
        network: { allowedDomains: string[]; strictAllowlist: boolean };
        credentials: { files: { path: string; mode: string }[]; envVars: unknown[] };
      };
      hooks?: unknown;
    };
    expect(settings.includeGitInstructions).toBe(false);
    expect(settings.attribution).toEqual({ commit: "", pr: "" });
    expect(settings.hooks).toBeUndefined();
    const wt = "//home/maintainer/code/shop.worktrees/DIPO-999";
    expect(settings.permissions.allow).toEqual([
      `Read(${wt}/**)`,
      `Edit(${wt}/**)`,
      `Write(${wt}/**)`,
      "Bash",
    ]);
    expect(settings.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    const deny = settings.permissions.deny;
    for (const rule of [...settings.permissions.allow, ...deny]) {
      expect(rule).not.toMatch(/\(\.\//);
    }
    for (const rule of [
      `Edit(${wt}/.git)`,
      `Write(${wt}/.git)`,
      `Edit(${wt}/.git/**)`,
      `Write(${wt}/.git/**)`,
      `Edit(${wt}/backlog/**)`,
      `Write(${wt}/backlog/**)`,
      `Edit(${wt}/.dipo/**)`,
      `Write(${wt}/.dipo/**)`,
      `Edit(${wt}/.claude/settings.json)`,
      `Write(${wt}/.claude/settings.json)`,
      `Edit(${wt}/.claude/settings.local.json)`,
      `Write(${wt}/.claude/settings.local.json)`,
      `Read(${wt}/**/.env*)`,
      "Read(~/.ssh/**)",
      "Read(~/.netrc)",
      "Bash(git commit *)",
      "Bash(git push *)",
      "Bash(backlog *)",
      "Bash(gh *)",
      "Edit(//home/maintainer/code/shop/.git/**)",
      "Write(//home/maintainer/code/shop/.git/**)",
      "Edit(//home/maintainer/code/shop/**)",
      "Write(//home/maintainer/code/shop/**)",
    ]) {
      expect(deny).toContain(rule);
    }
    const sandbox = settings.sandbox;
    expect(sandbox.enabled).toBe(true);
    expect(sandbox.failIfUnavailable).toBe(true);
    expect(sandbox.allowUnsandboxedCommands).toBe(false);
    expect(sandbox.excludedCommands).toBeUndefined();
    expect(sandbox.network.strictAllowlist).toBe(true);
    expect(sandbox.network.allowedDomains).toEqual([]);
    expect(sandbox.filesystem.denyWrite).toContain("/home/maintainer/code/shop/.git");
    expect(sandbox.filesystem.denyWrite).toContain(
      "/home/maintainer/code/shop.worktrees/DIPO-999/.git",
    );
    // The toolchain read list, so ~/.bun/bin stays readable (0008 amendment of 2026-10-12); the
    // install caches are for engine steps only.
    expect(sandbox.filesystem.allowRead).toEqual([
      "/home/maintainer/.bun",
      "/home/maintainer/.npm",
      "/home/maintainer/.cache",
    ]);
    expect(sandbox.credentials.files.map((file) => file.path)).toEqual([
      "/home/maintainer/.ssh",
      "/home/maintainer/.aws",
      "/home/maintainer/.config/gh",
      "/home/maintainer/.gnupg",
      "/home/maintainer/.netrc",
    ]);
    const paths = [
      ...sandbox.filesystem.allowWrite,
      ...sandbox.filesystem.denyWrite,
      ...sandbox.filesystem.allowRead,
      ...sandbox.credentials.files.map((file) => file.path),
    ];
    for (const path of paths) expect(path.startsWith("/")).toBe(true);
  });

  it("writes the report schema next to the settings file", () => {
    const file = plan(spec("S"), context()).files.find(
      (entry) => entry.name === REPORT_SCHEMA_FILE,
    );
    expect(JSON.parse(file?.content ?? "null")).toEqual(WORKER_REPORT_JSON_SCHEMA);
  });

  it("refuses an office path that does not expand to an absolute one", () => {
    const sandbox = { ...OFFICE_DEFAULTS.sandbox, allowRead: ["relative/dir"] };
    expect(() => plan(spec("S"), context({ sandbox }))).toThrow(PlanError);
  });

  it("refuses a worktree root inside the main checkout", () => {
    const inside = spec("S", { workdir: "/home/maintainer/code/shop/.worktrees/DIPO-999" });
    expect(() => plan(inside, context())).toThrow(/outside the main checkout/);
    const same = spec("S", { workdir: "/home/maintainer/code/shop/" });
    expect(() => plan(same, context())).toThrow(/outside the main checkout/);
    const dotted = spec("S", { workdir: "/home/maintainer/code/x/../shop/wt" });
    expect(() => plan(dotted, context())).toThrow(/outside the main checkout/);
  });

  it("accepts a sibling directory whose name starts with the main checkout's", () => {
    const sibling = spec("S", { workdir: "/home/maintainer/code/shop-wt/DIPO-999" });
    expect(() => plan(sibling, context())).not.toThrow();
  });

  it("type-checks an unknown kind and refuses it naming the kind", () => {
    const later: WorkerSpec = spec("S", { kind: "pair-programming" });
    expect(() => plan(later, context())).toThrow(PlanError);
    expect(() => plan(later, context())).toThrow('"pair-programming"');
  });

  it("refuses the known kinds it does not plan", () => {
    for (const kind of ["session"]) {
      expect(() => plan(spec("S", { kind }), context())).toThrow(`"${kind}"`);
    }
  });

  it("holds no gh deny rule with the hook relay, and keeps both without it (DIPO-195)", () => {
    const withRelay = settingsOf(
      plan(spec("S", { hookRelay: true }), context({ hookCommand: ["/opt/dipo/bin/dipo"] })),
    ) as { permissions: { deny: string[] } };
    expect(withRelay.permissions.deny).not.toContain("Bash(gh)");
    expect(withRelay.permissions.deny).not.toContain("Bash(gh *)");
    const withoutRelay = settingsOf(plan(spec("S"), context())) as {
      permissions: { deny: string[] };
    };
    expect(withoutRelay.permissions.deny).toContain("Bash(gh)");
    expect(withoutRelay.permissions.deny).toContain("Bash(gh *)");
  });

  it("registers the 0008 hooks with the binary's own path when the spec asks for the relay (DIPO-59)", () => {
    const dipo = "/opt/dipo's tools/bin/dipo";
    const launch = plan(
      spec("S", { hookRelay: true }),
      context({ hookCommand: [dipo], permissionWaitSeconds: 120 }),
    );
    const file = launch.files.find((f) => f.name === SETTINGS_FILE);
    const hooks = (JSON.parse(file?.content ?? "{}") as { hooks: Record<string, unknown> }).hooks;
    expect(Object.keys(hooks)).toEqual([...REGISTERED_HOOKS]);
    const quoted = `cd '${context().runDir}' && '/opt/dipo'\\''s tools/bin/dipo'`;
    expect(hooks["Stop"]).toEqual([
      { hooks: [{ type: "command", command: `${quoted} hook Stop`, timeout: 5 }] },
    ]);
    // A compiled binary needs no Bun config file.
    expect(launch.files.map((f) => f.name)).not.toContain(HOOK_BUNFIG_FILE);
    // The host holds the call 10 s past the engine's wait; the hook timeout is 30 s above the wait.
    expect(hooks["PermissionRequest"]).toEqual([
      {
        hooks: [
          {
            type: "command",
            command: `${quoted} hook PermissionRequest --wait 130`,
            timeout: 150,
          },
        ],
      },
    ]);
    // Hooks reach the host through the plan's environment.
    expect(launch.env["DIPO_HOST_SOCKET"]).toBe(context().hostSocket);
    expect(launch.env["DIPO_RUN"]).toBe("run-0001");
  });

  it("refuses the relay without a hook command, with one inside the worktree, or a bad wait", () => {
    expect(() => plan(spec("S", { hookRelay: true }), context())).toThrow(/hook relay/);
    expect(() =>
      plan(
        spec("S", { hookRelay: true }),
        context({ hookCommand: ["/home/maintainer/code/shop.worktrees/DIPO-999/dipo"] }),
      ),
    ).toThrow(/outside the worktree/);
    expect(() =>
      plan(
        spec("S", { hookRelay: true }),
        context({ hookCommand: ["/opt/dipo"], permissionWaitSeconds: 0 }),
      ),
    ).toThrow(/permissionWaitSeconds/);
  });

  it("refuses a session id that is not a UUID", () => {
    const bad = spec("S", { session: { id: "--bare", resume: false } });
    expect(() => plan(bad, context())).toThrow(PlanError);
  });

  it("refuses a model that would read as a flag", () => {
    expect(() => plan(spec("S", { model: "--bare" }), context())).toThrow(PlanError);
  });

  it("refuses tool variables that change process start or git resolution", () => {
    for (const name of [
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "DYLD_INSERT_LIBRARIES",
      "NODE_OPTIONS",
      "BASH_ENV",
      "ENV",
      "GIT_DIR",
      "GIT_CONFIG_GLOBAL",
    ]) {
      expect(() => plan(spec("S"), context({ toolVariables: [name] }))).toThrow(name);
    }
  });

  it("allows Bash and keeps every Bash deny, the read block and the sandbox", () => {
    const settings = settingsOf(plan(spec("S"), context())) as {
      permissions: {
        allow: string[];
        deny: string[];
        blockReadsOutsideWorkingDirectories: boolean;
      };
      sandbox: {
        enabled: boolean;
        allowUnsandboxedCommands: boolean;
        credentials: { files: unknown[]; envVars: unknown[] };
      };
    };
    expect(settings.permissions.allow).toContain("Bash");
    // Deny wins over allow in Claude Code, so each of these still stops its command.
    for (const command of [...GIT_WRITE_VERBS.map((verb) => `git ${verb}`), "backlog", "gh"]) {
      expect(settings.permissions.deny).toContain(`Bash(${command})`);
      expect(settings.permissions.deny).toContain(`Bash(${command} *)`);
    }
    expect(settings.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    expect(settings.sandbox.enabled).toBe(true);
    expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);
    expect(settings.sandbox.credentials.files).toHaveLength(5);
    expect(settings.sandbox.credentials.envVars).toHaveLength(3);
  });

  it("denies the further git verbs bare and with arguments", () => {
    const { permissions } = settingsOf(plan(spec("S"), context())) as {
      permissions: { deny: string[] };
    };
    for (const verb of [
      "branch",
      "fetch",
      "config",
      "apply",
      "submodule",
      "symbolic-ref",
      "notes",
      "commit-tree",
    ]) {
      expect(permissions.deny).toContain(`Bash(git ${verb})`);
      expect(permissions.deny).toContain(`Bash(git ${verb} *)`);
    }
  });

  it("denies git branch and keeps git rev-parse open so a worker can read its branch", () => {
    const { permissions } = settingsOf(plan(spec("S"), context())) as {
      permissions: { deny: string[] };
    };
    expect(permissions.deny).toContain("Bash(git branch)");
    expect(permissions.deny).toContain("Bash(git branch *)");
    expect(permissions.deny.filter((rule) => rule.startsWith("Bash(git rev-parse"))).toEqual([]);
  });

  it("denies the git write verbs after the global options -C and -c (DIPO-204)", () => {
    const { permissions } = settingsOf(plan(spec("S"), context())) as {
      permissions: { deny: string[] };
    };
    expect(permissions.deny).toContain("Bash(git -C * commit)");
    expect(permissions.deny).toContain("Bash(git -C * commit *)");
    expect(permissions.deny).toContain("Bash(git -C * branch)");
    expect(permissions.deny).toContain("Bash(git -C * branch *)");
    expect(permissions.deny).toContain("Bash(git -c * push)");
    expect(permissions.deny).toContain("Bash(git -c * push *)");
    for (const verb of GIT_WRITE_VERBS) {
      for (const option of ["-C *", "-c *"]) {
        expect(permissions.deny).toContain(`Bash(git ${option} ${verb})`);
        expect(permissions.deny).toContain(`Bash(git ${option} ${verb} *)`);
      }
    }
    const readRules = permissions.deny.filter((rule) =>
      /^Bash\(git (-[Cc] \* )?rev-parse/.test(rule),
    );
    expect(readRules).toEqual([]);
  });

  it("refuses a workdir or tmpDir that is the root, the home directory or holds it", () => {
    for (const dir of ["/", "/home/maintainer", "/home", "/home/maintainer/"]) {
      expect(() => plan(spec("S", { workdir: dir }), context())).toThrow(PlanError);
      expect(() => plan(spec("S"), context({ tmpDir: dir }))).toThrow(PlanError);
    }
  });

  it("refuses a run dir, system file or mcp.json inside the worktree", () => {
    const workdir = spec("S").workdir;
    expect(() => plan(spec("S"), context({ runDir: `${workdir}/.run` }))).toThrow(/runDir/);
    expect(() => plan(spec("S", { systemFile: `${workdir}/system.md` }), context())).toThrow(
      /systemFile/,
    );
    expect(() => plan(spec("S"), context({ mcpConfig: `${workdir}/mcp.json` }))).toThrow(
      /mcpConfig/,
    );
  });

  it("refuses a main checkout or workdir with characters that mean something in rules", () => {
    for (const special of ["*", "?", "[", "]", "(", ")", "{", "}", "\\", "!", "\n"]) {
      const main = `/home/maintainer/code/sh${special}op`;
      expect(() => plan(spec("S"), context({ mainCheckout: main }))).toThrow(PlanError);
      const workdir = `/home/maintainer/code/wt${special}/DIPO-999`;
      expect(() => plan(spec("S", { workdir }), context())).toThrow(PlanError);
    }
  });

  it("is pure: the same input gives the same plan", () => {
    expect(plan(spec("L"), context())).toEqual(plan(spec("L"), context()));
  });
});

describe("claude-cli plan closes srt's default write paths (DIPO-98)", () => {
  const CLOSED = [
    "/home/maintainer/.claude/debug",
    "/home/maintainer/.npm/_logs",
    "/tmp/claude",
    "/private/tmp/claude",
  ];

  it("denies writes to every srt default write path, for every tier, on launch and resume", () => {
    for (const tier of ["S", "M", "L"] as const) {
      for (const resume of [false, true]) {
        const launch = plan(
          spec(tier, {
            session: { id: "0e6f3f4c-5b8d-4c1e-9a2b-3c4d5e6f7a8b", resume },
          }),
          context(),
        );
        expect(denyWriteOf(launch).slice(-CLOSED.length)).toEqual(CLOSED);
      }
    }
  });

  it("knows every default write path of the installed srt but its /dev entries", () => {
    // An srt upgrade that adds a default fails here until it is closed or accepted on purpose.
    const home = homedir();
    const installed = getDefaultWritePaths()
      .filter((path) => !path.startsWith("/dev/"))
      .map((path) => (path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path));
    expect(installed.toSorted()).toEqual(
      [
        ...SRT_DEFAULT_WRITE_PATHS,
        ...SRT_DEFAULT_HOME_WRITE_PATHS.map((rel) => `~/${rel}`),
      ].toSorted(),
    );
  });

  it("names every path srt opens by default, each with a reason", () => {
    const closed = closedWritePaths("/h");
    expect(closed.map((entry) => entry.path).toSorted()).toEqual(
      [
        ...SRT_DEFAULT_WRITE_PATHS,
        ...SRT_DEFAULT_HOME_WRITE_PATHS.map((rel) => `/h/${rel}`),
      ].toSorted(),
    );
    for (const entry of closed) expect(entry.reason.length).toBeGreaterThan(20);
  });

  it("writes the closed paths with their reasons into the run directory for the dry run", () => {
    const launch = plan(spec("M"), context());
    const file = launch.files.find((f) => f.name === CLOSED_WRITES_FILE);
    const shown = JSON.parse(file?.content ?? "") as {
      reason: string;
      denyWrite: { path: string; reason: string }[];
    };
    expect(shown.denyWrite.map((entry) => entry.path)).toEqual(CLOSED);
    expect(shown.denyWrite).toEqual(closedWritePaths("/home/maintainer"));
    expect(shown.reason).toContain("sandbox.filesystem.denyWrite");
  });

  it("opens none of them again: not as a write path, and no read path re-opens a write", () => {
    const launch = plan(spec("M"), context());
    const sandbox = sandboxOf(launch);
    for (const path of CLOSED) {
      for (const write of sandbox.filesystem.allowWrite) {
        expect(path === write || path.startsWith(`${write}/`)).toBe(false);
      }
    }
    // The toolchain read path ~/.npm stays readable; a read path never makes anything writable.
    expect(sandbox.filesystem.allowRead).toContain("/home/maintainer/.npm");
  });

  it("refuses a worktree or run temp directory under a closed path", () => {
    for (const dir of ["/tmp/claude", "/tmp/claude/run-1", "/private/tmp/claude/x"]) {
      expect(() => plan(spec("S"), context({ tmpDir: dir }))).toThrow(/may not write/);
      expect(() => plan(spec("S", { workdir: `${dir}/wt` }), context())).toThrow(/may not write/);
    }
    // Nor one that holds a closed path.
    for (const dir of ["/tmp", "/private/tmp", "/private"]) {
      expect(() => plan(spec("S"), context({ tmpDir: dir }))).toThrow(/must not hold/);
      expect(() => plan(spec("S", { workdir: dir }), context())).toThrow(/must not hold/);
    }
    // A sibling whose name only starts with a closed path's is fine.
    expect(() => plan(spec("S"), context({ tmpDir: "/tmp/claude-501" }))).not.toThrow();
  });
});

function sandboxOf(launch: LaunchPlan) {
  return settingsOf(launch)["sandbox"] as {
    filesystem: { allowRead: string[]; denyRead: string[]; allowWrite: string[] };
    network: Record<string, unknown> & { allowedDomains: string[]; allowLocalBinding: boolean };
  };
}

describe("claude-cli plan with Safe-Chain (DIPO-82, DIPO-84)", () => {
  const RUN_DIR = "/home/maintainer/code/shop/.git/dipo/runs/run-0001";
  const SHELL_DIR = `${RUN_DIR}/safe-chain`;
  const PROXY_DIR = "/private/tmp/dipo-p/abc123";
  const safeChain = {
    root: "/home/maintainer/.safe-chain",
    shell: "/bin/zsh",
    path: "/home/maintainer/.bun/bin-originals:/usr/bin:/bin",
    demoted: [],
    dropped: [],
    probe: "bun",
    shellDir: SHELL_DIR,
    route: { port: 50123, dir: PROXY_DIR },
  };

  it("routes the sandbox network only through dipo's proxy and reads nothing of the install", () => {
    const launch = plan(spec("M"), context({ safeChain }));
    expect(launch.env["CLAUDE_CODE_SHELL"]).toBe(`${SHELL_DIR}/zsh`);
    // The worker's own environment keeps the daemon's PATH; the wrapper sets the shell's.
    expect(launch.env["PATH"]).toBe("/home/maintainer/.bun/bin:/usr/bin:/bin");
    const sandbox = sandboxOf(launch);
    const base = sandboxOf(plan(spec("M"), context()));
    expect(sandbox.filesystem.allowRead).toEqual([...base.filesystem.allowRead, SHELL_DIR]);
    expect(JSON.stringify(sandbox.filesystem.allowRead)).not.toContain(".safe-chain");
    expect(sandbox.filesystem.denyRead).toEqual([
      ...base.filesystem.denyRead,
      "/home/maintainer/.claude/shell-snapshots",
      // The parent of every proxy directory, not only this run's (DIPO-84 review).
      "/private/tmp/dipo-p",
    ]);
    // Writes as before: the worktree, the run temp directory, where the caches go, and the
    // short temp root (DIPO-118).
    expect(sandbox.filesystem.allowWrite).toEqual(base.filesystem.allowWrite);
    expect(sandbox.network).toEqual({
      allowedDomains: [],
      strictAllowlist: true,
      allowLocalBinding: false,
      httpProxyPort: 50123,
      allowUnixSockets: [SHORT_TMP],
    });
  });

  it("keeps srt's default write paths closed: the same denyWrite as without Safe-Chain (DIPO-98)", () => {
    const withSafeChain = plan(spec("M"), context({ safeChain }));
    expect(denyWriteOf(withSafeChain)).toEqual(denyWriteOf(plan(spec("M"), context())));
    for (const closed of closedWritePaths("/home/maintainer")) {
      expect(denyWriteOf(withSafeChain)).toContain(closed.path);
    }
    // npm's cache, and so its logs, go to the run temp directory, not ~/.npm.
    const wrapper = withSafeChain.files.find((f) => f.name === "safe-chain/zsh")?.content ?? "";
    expect(wrapper).toContain("export npm_config_cache='/tmp/claude-501/caches/npm'");
    expect(wrapper).not.toContain(".npm/_logs");
    // A dry run shows the same closed paths.
    const { route, ...withoutRoute } = safeChain;
    expect(route.port).toBe(50123);
    const preview = plan(spec("M"), context({ safeChain: withoutRoute }));
    expect(denyWriteOf(preview)).toEqual(denyWriteOf(withSafeChain));
  });

  it("writes the wrapper (executable), its init file and the proxy description", () => {
    const files = plan(spec("M"), context({ safeChain })).files;
    expect(files.find((f) => f.name === "safe-chain/zsh")).toMatchObject({ executable: true });
    expect(files.find((f) => f.name === "safe-chain/zsh")?.content).toContain(
      "export BUN_INSTALL_CACHE_DIR='/tmp/claude-501/caches/bun'",
    );
    expect(files.find((f) => f.name === "safe-chain/.zshenv")?.content).not.toContain(
      "init-posix.sh",
    );
    const proxy = JSON.parse(files.find((f) => f.name === "safe-chain/proxy.json")?.content ?? "");
    expect(proxy.worker.httpProxyPort).toBe(50123);
    // A self-test plan, whose run directory differs, uses the run's wrapper and writes none.
    const self = plan(spec("M"), context({ safeChain, runDir: `${RUN_DIR}/self-test` }));
    expect(self.env["CLAUDE_CODE_SHELL"]).toBe(`${SHELL_DIR}/zsh`);
    expect(self.files.some((f) => f.name.startsWith("safe-chain/"))).toBe(false);
  });

  it("shows placeholders in a dry run, before the run starts its proxy", () => {
    const { route: _route, ...detected } = safeChain;
    const launch = plan(spec("M"), context({ safeChain: detected }));
    const sandbox = sandboxOf(launch);
    expect(sandbox.network["httpProxyPort"]).toBe(0);
    expect(sandbox.filesystem.denyRead).toContain("/tmp/dipo-p");
  });

  it("refuses an office that allows domains or local binding", () => {
    const sandbox = OFFICE_DEFAULTS.sandbox;
    expect(() =>
      plan(
        spec("M"),
        context({ safeChain, sandbox: { ...sandbox, allowedDomains: ["example.com"] } }),
      ),
    ).toThrow("sandbox.allowedDomains");
    expect(() =>
      plan(spec("M"), context({ safeChain, sandbox: { ...sandbox, allowLocalBinding: true } })),
    ).toThrow("sandbox.allowLocalBinding");
    // Without Safe-Chain both stay the office's choice.
    const open = plan(
      spec("M"),
      context({
        sandbox: { ...sandbox, allowedDomains: ["example.com"], allowLocalBinding: true },
      }),
    );
    expect(sandboxOf(open).network).toEqual({
      allowedDomains: ["example.com"],
      strictAllowlist: true,
      allowLocalBinding: true,
      allowUnixSockets: [SHORT_TMP],
    });
  });

  it("launches exactly as before without Safe-Chain", () => {
    const launch = plan(spec("M"), context());
    expect(launch.env["CLAUDE_CODE_SHELL"]).toBeUndefined();
    expect(launch.files.map((f) => f.name)).toEqual([
      SETTINGS_FILE,
      REPORT_SCHEMA_FILE,
      CLOSED_WRITES_FILE,
    ]);
    const text = JSON.stringify(settingsOf(launch));
    for (const word of ["safe-chain", "shell-snapshots", "httpProxyPort", "dipo-p"]) {
      expect(text).not.toContain(word);
    }
  });

  it("refuses a wrapper directory inside the worktree", () => {
    expect(() =>
      plan(
        spec("M"),
        context({
          safeChain: { ...safeChain, shellDir: "/home/maintainer/code/shop.worktrees/DIPO-999/x" },
        }),
      ),
    ).toThrow(PlanError);
  });
});

describe("claude-cli plan of the review kind (DIPO-145, 0019 section 4)", () => {
  const WORKDIR = "/home/maintainer/code/shop.worktrees/DIPO-999";
  const RUN_DIR = "/home/maintainer/code/shop/.git/dipo/runs/run-0001";

  function reviewSpec(overrides: Partial<WorkerSpec> = {}): WorkerSpec {
    return spec("M", {
      kind: "review",
      model: OFFICE_DEFAULTS.review.model,
      effort: OFFICE_DEFAULTS.review.effort,
      caps: {
        budgetTokens: 200_000,
        maxTurns: OFFICE_DEFAULTS.review.maxTurns,
        maxMinutes: OFFICE_DEFAULTS.review.maxMinutes,
      },
      systemFile: `${RUN_DIR}/system-review.md`,
      tools: { allow: [...REVIEW_TOOLS], deny: [] },
      reportSchema: REVIEW_REPORT_JSON_SCHEMA,
      ...overrides,
    });
  }

  interface ReviewSettings {
    permissions: { allow: string[]; deny: string[] };
    sandbox: {
      filesystem: { allowWrite: string[]; denyWrite: string[]; denyRead: string[] };
      network: Record<string, unknown>;
    };
    enabledPlugins?: Record<string, boolean>;
  }

  it("passes Read, Glob, Grep and Bash, the review model and effort and the ReviewReport schema", () => {
    const launch = plan(reviewSpec(), context());
    expect(flag(launch, "--tools")).toBe("Read,Glob,Grep,Bash");
    expect(flag(launch, "--model")).toBe("opus");
    expect(flag(launch, "--effort")).toBe("high");
    expect(flag(launch, "--max-turns")).toBe(String(OFFICE_DEFAULTS.review.maxTurns));
    expect(JSON.parse(flag(launch, "--json-schema") ?? "null")).toEqual(REVIEW_REPORT_JSON_SCHEMA);
    const written = launch.files.find((file) => file.name === REPORT_SCHEMA_FILE)?.content ?? "";
    expect(JSON.parse(written)).toEqual(REVIEW_REPORT_JSON_SCHEMA);
    expect(launch.cwd).toBe(WORKDIR);
    for (const tool of ["Edit", "Write", "WebSearch", "WebFetch"]) {
      expect(launch.argv.join(" ")).not.toContain(tool);
    }
  });

  it("refuses Edit, Write, WebSearch, WebFetch or any other tool in a review spec", () => {
    for (const tool of ["Edit", "Write", "WebSearch", "WebFetch", "Agent"]) {
      const extra = reviewSpec({ tools: { allow: [...REVIEW_TOOLS, tool], deny: [] } });
      expect(() => plan(extra, context())).toThrow(PlanError);
      expect(() => plan(extra, context())).toThrow(`not ${tool}`);
    }
  });

  it("loads no MCP server, skill or slash command: an empty --mcp-config, never the office's", () => {
    const launch = plan(reviewSpec(), context());
    expect(launch.argv).toContain("--strict-mcp-config");
    expect(flag(launch, "--mcp-config")).toBe(`${RUN_DIR}/${EMPTY_MCP_CONFIG_FILE}`);
    expect(launch.argv).not.toContain("/home/maintainer/code/shop/.git/dipo/mcp.json");
    const empty = launch.files.find((file) => file.name === EMPTY_MCP_CONFIG_FILE)?.content;
    expect(JSON.parse(empty ?? "null")).toEqual({ mcpServers: {} });
    expect(launch.argv).toContain("--disable-slash-commands");
    expect(flag(launch, "--setting-sources")).toBe("project,local");
  });

  it("allows reads and Bash only, and denies Edit and Write on the whole worktree", () => {
    const settings = settingsOf(plan(reviewSpec(), context())) as unknown as ReviewSettings;
    expect(settings.permissions.allow).toEqual([`Read(/${WORKDIR}/**)`, "Bash"]);
    expect(settings.permissions.deny).toContain(`Edit(/${WORKDIR}/**)`);
    expect(settings.permissions.deny).toContain(`Write(/${WORKDIR}/**)`);
    // Every deny rule of a worker stays.
    const worker = settingsOf(plan(spec("M"), context())) as unknown as ReviewSettings;
    for (const rule of worker.permissions.deny) expect(settings.permissions.deny).toContain(rule);
  });

  it("puts the worktree in denyWrite next to <main>/.git and the pointer; only the temp roots stay writable", () => {
    const settings = settingsOf(plan(reviewSpec(), context())) as unknown as ReviewSettings;
    const { allowWrite, denyWrite } = settings.sandbox.filesystem;
    expect(allowWrite).toEqual(["/tmp/claude-501", SHORT_TMP]);
    expect(allowWrite).not.toContain(WORKDIR);
    for (const path of ["/home/maintainer/code/shop/.git", `${WORKDIR}/.git`, WORKDIR]) {
      expect(denyWrite).toContain(path);
    }
    for (const closed of closedWritePaths("/home/maintainer")) {
      expect(denyWrite).toContain(closed.path);
    }
    // The worker's own denies are all there too.
    const worker = settingsOf(plan(spec("M"), context())) as unknown as ReviewSettings;
    for (const path of worker.sandbox.filesystem.denyWrite) expect(denyWrite).toContain(path);
  });

  it("closes the network whatever the office allows its workers, with no Unix sockets", () => {
    const sandbox = OFFICE_DEFAULTS.sandbox;
    const open = context({
      sandbox: { ...sandbox, allowedDomains: ["example.com"], allowLocalBinding: true },
    });
    const settings = settingsOf(plan(reviewSpec(), open)) as unknown as ReviewSettings;
    expect(settings.sandbox.network).toEqual({
      allowedDomains: [],
      strictAllowlist: true,
      allowLocalBinding: false,
    });
  });

  it("runs with no Safe-Chain proxy, wrapper or shell even where Safe-Chain is installed", () => {
    const safeChain = {
      root: "/home/maintainer/.safe-chain",
      shell: "/bin/zsh",
      path: "/home/maintainer/.bun/bin-originals:/usr/bin:/bin",
      demoted: [],
      dropped: [],
      probe: "bun",
      shellDir: `${RUN_DIR}/safe-chain`,
      route: { port: 50123, dir: "/private/tmp/dipo-p/abc123" },
    };
    const launch = plan(reviewSpec(), context({ safeChain }));
    expect(launch.env["CLAUDE_CODE_SHELL"]).toBeUndefined();
    expect(launch.files.some((file) => file.name.startsWith("safe-chain/"))).toBe(false);
    const settings = settingsOf(launch) as unknown as ReviewSettings;
    expect(settings.sandbox.network["httpProxyPort"]).toBeUndefined();
    expect(JSON.stringify(settings)).not.toContain("safe-chain");
    expect(JSON.stringify(settings)).not.toContain("dipo-p");
    expect(settings.sandbox.network).toEqual({
      allowedDomains: [],
      strictAllowlist: true,
      allowLocalBinding: false,
    });
  });

  it("gets the detected PATH and a closed shell snapshot where Safe-Chain is installed (DIPO-250)", () => {
    const safeChain = {
      root: "/home/maintainer/.safe-chain",
      shell: "/bin/zsh",
      path: "/home/maintainer/.bun/bin-originals:/usr/bin:/bin:/home/maintainer/.bun/bin",
      demoted: [{ entry: "/home/maintainer/.bun/bin", reason: "wrapped command unreadable" }],
      dropped: [{ entry: "/home/maintainer/.safe-chain/shims", reason: "sandbox cannot read it" }],
      probe: "bun",
      shellDir: `${RUN_DIR}/safe-chain`,
      route: { port: 50123, dir: "/private/tmp/dipo-p/abc123" },
    };
    const launch = plan(reviewSpec(), context({ safeChain }));
    expect(launch.env["PATH"]).toBe(safeChain.path);
    expect(launch.env["CLAUDE_CODE_SHELL"]).toBeUndefined();
    const settings = settingsOf(launch) as unknown as ReviewSettings;
    const sandbox = settings.sandbox as unknown as {
      filesystem: { denyRead: string[]; allowRead: string[] };
    };
    expect(sandbox.filesystem.denyRead).toEqual([
      "/home/maintainer/Library/Keychains",
      "/home/maintainer/.claude/shell-snapshots",
    ]);
    expect(sandbox.filesystem.allowRead).not.toContain(safeChain.shellDir);
    expect(JSON.stringify(settings.sandbox.network)).not.toContain("50123");
    // The worker's own plan keeps the Safe-Chain shell.
    expect(plan(spec("M"), context({ safeChain })).env["CLAUDE_CODE_SHELL"]).toBeDefined();
  });

  it("is unchanged without Safe-Chain: the daemon's PATH and an open snapshot directory", () => {
    const launch = plan(reviewSpec(), context());
    expect(launch.env["PATH"]).toBe("/home/maintainer/.bun/bin:/usr/bin:/bin");
    const sandbox = settingsOf(launch)["sandbox"] as { filesystem: { denyRead: string[] } };
    expect(sandbox.filesystem.denyRead).toEqual(["/home/maintainer/Library/Keychains"]);
  });

  it("switches off every installed plugin, also those worker.plugins allows", () => {
    const plugins = {
      installed: ["dipsaus-ai@dipsaus-ai", "warp@claude-code-warp"],
      allowed: ["dipsaus-ai@dipsaus-ai"],
    };
    const review = settingsOf(
      plan(reviewSpec(), context({ plugins })),
    ) as unknown as ReviewSettings;
    expect(review.enabledPlugins).toEqual({
      "dipsaus-ai@dipsaus-ai": false,
      "warp@claude-code-warp": false,
    });
    const worker = settingsOf(plan(spec("M"), context({ plugins }))) as unknown as ReviewSettings;
    expect(worker.enabledPlugins).toEqual({ "warp@claude-code-warp": false });
  });

  it("leaves the implement plan as it was", () => {
    const launch = plan(spec("M"), context());
    expect(launch.files.map((file) => file.name)).not.toContain(EMPTY_MCP_CONFIG_FILE);
    expect(flag(launch, "--mcp-config")).toBe("/home/maintainer/code/shop/.git/dipo/mcp.json");
  });
});

// DIPO-164, 0020 section 11b: with worker.web the developer role gets the two web tools.
describe("web tools (DIPO-164)", () => {
  const WEB = ["WebSearch", "WebFetch"];
  const M0_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "Bash"];
  const webSpec = (web: boolean) =>
    spec("M", {
      hookRelay: true,
      tools: { allow: web ? [...M0_TOOLS, ...WEB] : M0_TOOLS, deny: [] },
    });
  const WEB_CONTEXT = context({ hookCommand: ["/opt/dipo"] });
  interface Settings {
    permissions: { allow: string[] };
    sandbox: { network: { allowedDomains: string[] } };
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
  }

  it("adds the tools and their allow rules, and registers the PreToolUse gate", () => {
    const launch = plan(webSpec(true), WEB_CONTEXT);
    expect(flag(launch, "--tools")).toBe("Read,Edit,Write,Glob,Grep,Bash,WebSearch,WebFetch");
    const settings = settingsOf(launch) as unknown as Settings;
    expect(settings.permissions.allow).toEqual(expect.arrayContaining(WEB));
    const gate = settings.hooks["PreToolUse"]?.[0];
    expect(gate?.matcher).toBe("WebFetch|WebSearch");
    expect(gate?.hooks[0]?.command.endsWith(` hook PreToolUse --gate${GATE_CRASH_EXIT}`)).toBe(
      true,
    );
    const bash = settings.hooks["PreToolUse"]?.[1];
    expect(bash?.matcher).toBe("Bash");
    expect(bash?.hooks[0]?.command.endsWith(" hook PreToolUse --bash")).toBe(true);
  });

  it("keeps the Bash sandbox network closed", () => {
    const settings = settingsOf(plan(webSpec(true), WEB_CONTEXT)) as unknown as Settings;
    expect(settings.sandbox.network.allowedDomains).toEqual([]);
  });

  it("restores the M0 tool list without web: no tool, no allow rule, no web gate, the Bash check stays", () => {
    const launch = plan(webSpec(false), WEB_CONTEXT);
    expect(flag(launch, "--tools")).toBe(M0_TOOLS.join(","));
    const settings = settingsOf(launch) as unknown as Settings;
    for (const tool of WEB) expect(settings.permissions.allow).not.toContain(tool);
    expect(settings.hooks["PreToolUse"]?.map((entry) => entry.matcher)).toEqual(["Bash"]);
    expect(JSON.stringify(settings)).not.toContain("WebFetch");
  });

  it("gives the reviewer no web tools, whatever the office says", () => {
    const launch = plan(
      spec("M", {
        kind: "review",
        tools: { allow: [...REVIEW_TOOLS], deny: [] },
        reportSchema: REVIEW_REPORT_JSON_SCHEMA,
        hookRelay: true,
      }),
      WEB_CONTEXT,
    );
    expect(flag(launch, "--tools")).toBe("Read,Glob,Grep,Bash");
    const settings = settingsOf(launch) as unknown as Settings;
    for (const tool of WEB) expect(settings.permissions.allow).not.toContain(tool);
    expect(settings.hooks["PreToolUse"]?.map((entry) => entry.matcher)).toEqual(["Bash"]);
  });

  it("refuses web tools without the hook relay that checks them", () => {
    const unchecked = spec("M", {
      hookRelay: false,
      tools: { allow: [...M0_TOOLS, ...WEB], deny: [] },
    });
    expect(() => plan(unchecked, context())).toThrow(/hook relay/);
  });
});
