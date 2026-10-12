import { describe, expect, it } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { OFFICE_DEFAULTS } from "../../src/config";
import { plan, REPORT_SCHEMA_FILE, SETTINGS_FILE } from "../../src/workers/claude-cli/plan";
import type { ClaudeLaunchContext } from "../../src/workers/claude-cli/plan";
import { WORKER_REPORT_JSON_SCHEMA } from "../../src/workers/claude-cli/report-schema";
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

function flag(launch: LaunchPlan, name: string): string | undefined {
  const index = launch.argv.indexOf(name);
  return index === -1 ? undefined : launch.argv[index + 1];
}

async function matchGolden(name: string, value: unknown): Promise<void> {
  const path = join(GOLDEN_DIR, name);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (process.env.DIPO_UPDATE_GOLDEN === "1") await writeFile(path, text);
  expect(JSON.parse(text)).toEqual(JSON.parse(await readFile(path, "utf8")));
}

describe("claude-cli plan", () => {
  for (const tier of ["S", "M", "L"] as const) {
    it(`matches the golden argv, environment and settings file for tier ${tier}`, async () => {
      const launch = plan(spec(tier), context());
      await matchGolden(`plan-${tier}.json`, {
        argv: launch.argv,
        env: launch.env,
        cwd: launch.cwd,
        settings: settingsOf(launch),
        stdin: launch.stdin,
      });
      const caps = OFFICE_DEFAULTS.tiers[tier];
      expect(flag(launch, "--model")).toBe(caps.model);
      expect(flag(launch, "--effort")).toBe(caps.effort);
      expect(flag(launch, "--max-turns")).toBe(String(caps.maxTurns));
    });
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

  it("holds only allowlisted variables, declared tool variables and the four run variables", () => {
    const launch = plan(spec("M"), context());
    expect(Object.keys(launch.env).toSorted()).toEqual([
      "CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS",
      "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
      "DIPO_HOST_SOCKET",
      "DIPO_RUN",
      "HOME",
      "JAVA_HOME",
      "LANG",
      "PATH",
      "SHELL",
      "TERM",
      "TMPDIR",
      "USER",
    ]);
    expect(launch.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe("1");
    expect(launch.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
    expect(launch.env.DIPO_RUN).toBe("run-0001");
    expect(launch.env.DIPO_HOST_SOCKET).toBe("/home/maintainer/.dipo/run/hosts/run-0001.sock");
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
    expect(settings.permissions.allow).toEqual(["Read(./**)", "Edit(./**)", "Write(./**)"]);
    expect(settings.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    const deny = settings.permissions.deny;
    for (const rule of [
      "Edit(./.git)",
      "Write(./.git/**)",
      "Edit(./backlog/**)",
      "Write(./.dipo/**)",
      "Edit(./.claude/settings.local.json)",
      "Read(./**/.env*)",
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

  it("refuses the known kinds M0 does not plan", () => {
    for (const kind of ["review", "session"]) {
      expect(() => plan(spec("S", { kind }), context())).toThrow(`"${kind}"`);
    }
  });

  it("refuses hook relay until hooks are registered", () => {
    expect(() => plan(spec("S", { hookRelay: true }), context())).toThrow(/hook relay/);
  });

  it("refuses a session id that is not a UUID", () => {
    const bad = spec("S", { session: { id: "--bare", resume: false } });
    expect(() => plan(bad, context())).toThrow(PlanError);
  });

  it("refuses a model that would read as a flag", () => {
    expect(() => plan(spec("S", { model: "--bare" }), context())).toThrow(PlanError);
  });

  it("is pure: the same input gives the same plan", () => {
    expect(plan(spec("L"), context())).toEqual(plan(spec("L"), context()));
  });
});
