// The Claude CLI launch plan on the Mac, which is only a `session`'s (DIPO-310). A developer or
// reviewer session is never planned here (DIPO-240, DIPO-347): each runs only in a box, with no run
// settings file, Bash sandbox, permission rules or hooks (`box-plan.test.ts`). The session's own
// tools and settings are `session-plan.test.ts`; this file holds the rest of the plan: the refusal
// of a developer and a reviewer, argv, the allowlisted environment, the credential denies, srt's
// closed default write paths (DIPO-98) and the path checks.

import { describe, expect, it } from "bun:test";
import { OFFICE_DEFAULTS } from "../../src/config";
import {
  CLOSED_WRITES_FILE,
  closedWritePaths,
  DEVELOPER_ON_MAC_REFUSED,
  REVIEWER_ON_MAC_REFUSED,
  EMPTY_MCP_CONFIG_FILE,
  plan,
  REPORT_SCHEMA_FILE,
  SETTINGS_FILE,
  SRT_DEFAULT_HOME_WRITE_PATHS,
  SRT_DEFAULT_WRITE_PATHS,
} from "../../src/workers/claude-cli/plan";
import type { ClaudeLaunchContext } from "../../src/workers/claude-cli/plan";
import {
  REVIEW_REPORT_JSON_SCHEMA,
  WORKER_REPORT_JSON_SCHEMA,
} from "../../src/workers/claude-cli/report-schema";
import { PlanError } from "../../src/workers/types";
import type { LaunchPlan, WorkerSpec } from "../../src/workers/types";

const TASK = "<story>DIPO-999 Add a greeting</story>\n<outcome>The CLI prints hello.</outcome>";
const API_KEY = "sk-ant-api03-not-a-real-key";
const HOME = "/home/maintainer";
const RUN_DIR = "/home/maintainer/code/shop/.git/dipo/runs/run-0001";
const SESSION_DIR = "/tmp/dipo-scan-run-0001-agt-0001/session";

function spec(overrides: Partial<WorkerSpec> = {}): WorkerSpec {
  return {
    run: "run-0001",
    agent: "agt-0001",
    kind: "session",
    workdir: SESSION_DIR,
    model: "opus",
    effort: "high",
    caps: { budgetTokens: 200_000, maxTurns: 60, maxMinutes: 30 },
    systemFile: `${RUN_DIR}/system-review.md`,
    taskMessage: TASK,
    web: false,
    session: { id: "0e6f3f4c-5b8d-4c1e-9a2b-3c4d5e6f7a8b", resume: false },
    reportSchema: REVIEW_REPORT_JSON_SCHEMA,
    ...overrides,
  };
}

/** The run's short temp root (DIPO-118), as `shortTempDir` makes it under macOS's /tmp. */
const SHORT_TMP = "/private/tmp/dipo-t-0123456789";

function context(overrides: Partial<ClaudeLaunchContext> = {}): ClaudeLaunchContext {
  return {
    claudePath: "/home/maintainer/.local/bin/claude",
    home: HOME,
    env: {
      PATH: "/home/maintainer/.bun/bin:/usr/bin:/bin",
      HOME,
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
    runDir: RUN_DIR,
    tmpDir: "/tmp/claude-501",
    shortTmpDir: SHORT_TMP,
    sandbox: OFFICE_DEFAULTS.sandbox,
    ...overrides,
  };
}

function settingsOf(launch: LaunchPlan): Record<string, unknown> {
  const file = launch.files.find((entry) => entry.name === SETTINGS_FILE);
  if (file === undefined) throw new Error("no settings file");
  return JSON.parse(file.content) as Record<string, unknown>;
}

function sandboxOf(launch: LaunchPlan) {
  return settingsOf(launch)["sandbox"] as {
    filesystem: {
      allowRead: string[];
      denyRead: string[];
      allowWrite: string[];
      denyWrite: string[];
    };
    network: Record<string, unknown> & { allowedDomains: string[]; allowLocalBinding: boolean };
    credentials: { files: { path: string }[]; envVars: { name: string }[] };
  };
}

function flag(launch: LaunchPlan, name: string): string | undefined {
  const index = launch.argv.indexOf(name);
  return index === -1 ? undefined : launch.argv[index + 1];
}

describe("a developer or reviewer session on the Mac (DIPO-240, DIPO-347)", () => {
  it("never plans a developer: it runs only in its box", () => {
    const developer = spec({
      kind: "implement",
      workdir: "/home/maintainer/code/shop.worktrees/DIPO-999",
      web: false,
      reportSchema: WORKER_REPORT_JSON_SCHEMA,
      systemFile: `${RUN_DIR}/system.md`,
    });
    expect(() => plan(developer, context())).toThrow(DEVELOPER_ON_MAC_REFUSED);
    expect(() =>
      plan({ ...developer, session: { ...developer.session, resume: true } }, context()),
    ).toThrow(PlanError);
  });

  it("never plans a reviewer: it runs only in a read-only box of its own (0002)", () => {
    const reviewer = spec({
      kind: "review",
      workdir: "/home/maintainer/code/shop.worktrees/DIPO-999",
      web: false,
    });
    expect(() => plan(reviewer, context())).toThrow(REVIEWER_ON_MAC_REFUSED);
  });

  it("type-checks an unknown kind and refuses it naming the kind", () => {
    expect(() => plan(spec({ kind: "plan" }), context())).toThrow(/worker kind "plan"/);
  });
});

describe("a session's plan", () => {
  it("starts with the absolute claude path and passes the 0008 flags", () => {
    const launch = plan(spec(), context());
    expect(launch.argv[0]).toBe("/home/maintainer/.local/bin/claude");
    expect(launch.argv).toContain("-p");
    expect(flag(launch, "--permission-mode")).toBe("default");
    expect(flag(launch, "--permission-prompts")).toBe("none");
    expect(flag(launch, "--settings")).toBe(`${RUN_DIR}/${SETTINGS_FILE}`);
    expect(flag(launch, "--setting-sources")).toBe("project,local");
    expect(flag(launch, "--mcp-config")).toBe(`${RUN_DIR}/${EMPTY_MCP_CONFIG_FILE}`);
    expect(flag(launch, "--session-id")).toBe("0e6f3f4c-5b8d-4c1e-9a2b-3c4d5e6f7a8b");
    expect(launch.argv).toContain("--strict-mcp-config");
    expect(launch.argv).toContain("--disable-slash-commands");
    expect(launch.cwd).toBe(SESSION_DIR);
  });

  it("refuses a claude path that is not absolute", () => {
    expect(() => plan(spec(), context({ claudePath: "claude" }))).toThrow(PlanError);
  });

  it("sends the task message as the first stdin line and never on argv", () => {
    const launch = plan(spec(), context());
    expect(launch.argv.join(" ")).not.toContain("DIPO-999 Add a greeting");
    const first = JSON.parse(launch.stdin[0] ?? "") as { message: { content: string } };
    expect(first.message.content).toBe(TASK);
  });

  it("keeps an ANTHROPIC_API_KEY and every credential variable out of the plan", () => {
    const launch = plan(spec(), context());
    expect(JSON.stringify(launch)).not.toContain(API_KEY);
    for (const name of [
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "GH_TOKEN",
    ]) {
      expect(launch.env[name]).toBeUndefined();
    }
    expect(launch.env["JAVA_HOME"]).toBe("/opt/java");
    expect(launch.env["DIPO_RUN"]).toBe("run-0001");
    expect(launch.env["DIPO_TMP"]).toBe(SHORT_TMP);
    expect(launch.env["npm_config_logs_dir"]).toBe("/tmp/claude-501/npm-logs");
    // No Safe-Chain shell for a session that runs no command.
    expect(launch.env["CLAUDE_CODE_SHELL"]).toBeUndefined();
  });

  it("refuses tool variables that carry credentials or change process start", () => {
    for (const name of [
      "GH_TOKEN",
      "ANTHROPIC_API_KEY",
      "DIPO_TMP",
      "NODE_OPTIONS",
      "GIT_DIR",
      "npm_config_logs_dir",
    ]) {
      expect(() => plan(spec(), context({ toolVariables: [name] }))).toThrow(/may not reach/);
    }
  });

  it("writes the report schema next to the settings file", () => {
    const launch = plan(spec(), context());
    const file = launch.files.find((entry) => entry.name === REPORT_SCHEMA_FILE);
    expect(JSON.parse(file?.content ?? "")).toEqual(REVIEW_REPORT_JSON_SCHEMA);
  });

  it("carries the Keychain and credential denies, and opens no write path but its temp roots", () => {
    const sandbox = sandboxOf(plan(spec(), context()));
    expect(sandbox.filesystem.denyRead).toEqual([`${HOME}/Library/Keychains`]);
    expect(sandbox.credentials.files.map((file) => file.path)).toContain(`${HOME}/.ssh`);
    expect(sandbox.credentials.envVars.map((variable) => variable.name)).toContain("GH_TOKEN");
    expect(sandbox.filesystem.allowWrite).toEqual(["/tmp/claude-501", SHORT_TMP]);
    expect(sandbox.filesystem.denyWrite).toContain(SESSION_DIR);
    expect(sandbox.network).toEqual({
      allowedDomains: [],
      strictAllowlist: true,
      allowLocalBinding: false,
    });
  });

  it("is pure: the same input gives the same plan", () => {
    expect(plan(spec(), context())).toEqual(plan(spec(), context()));
  });
});

describe("a session's plan refuses paths it cannot use", () => {
  it("refuses a session id that is not a UUID, and a model that would read as a flag", () => {
    expect(() => plan(spec({ session: { id: "nope", resume: false } }), context())).toThrow(/UUID/);
    expect(() => plan(spec({ model: "--dangerous" }), context())).toThrow(
      /must be a non-empty value/,
    );
  });

  it("refuses a session folder inside the main checkout", () => {
    expect(() => plan(spec({ workdir: "/home/maintainer/code/shop/sub" }), context())).toThrow(
      /outside the main checkout/,
    );
  });

  it("refuses a run dir or system file inside the session folder", () => {
    expect(() => plan(spec(), context({ runDir: `${SESSION_DIR}/run` }))).toThrow(
      /must lie outside the session's folder/,
    );
    expect(() => plan(spec({ systemFile: `${SESSION_DIR}/system.md` }), context())).toThrow(
      /must lie outside the session's folder/,
    );
  });

  it("refuses a main checkout or session folder with characters that mean something in rules", () => {
    expect(() => plan(spec(), context({ mainCheckout: "/home/maintainer/code/sh*p" }))).toThrow(
      /meaning in permission rules/,
    );
    expect(() => plan(spec({ workdir: "/tmp/dipo-scan-[x]/session" }), context())).toThrow(
      PlanError,
    );
  });

  it("refuses a session folder or temp directory that is the root or holds home", () => {
    expect(() => plan(spec(), context({ tmpDir: "/" }))).toThrow(PlanError);
    expect(() => plan(spec(), context({ tmpDir: "/home" }))).toThrow(/hold the home directory/);
  });
});

describe("a session's plan closes srt's default write paths (DIPO-98)", () => {
  const CLOSED = [
    "/home/maintainer/.claude/debug",
    "/home/maintainer/.npm/_logs",
    "/tmp/claude",
    "/private/tmp/claude",
  ];

  it("denies writes to every srt default write path", () => {
    expect(sandboxOf(plan(spec(), context())).filesystem.denyWrite.slice(-CLOSED.length)).toEqual(
      CLOSED,
    );
  });

  it("names every path srt opens by default, each with a reason, in the run directory", () => {
    const closed = closedWritePaths("/h");
    expect(closed.map((entry) => entry.path).toSorted()).toEqual(
      [
        ...SRT_DEFAULT_WRITE_PATHS,
        ...SRT_DEFAULT_HOME_WRITE_PATHS.map((rel) => `/h/${rel}`),
      ].toSorted(),
    );
    for (const entry of closed) expect(entry.reason.length).toBeGreaterThan(20);
    const file = plan(spec(), context()).files.find((f) => f.name === CLOSED_WRITES_FILE);
    const shown = JSON.parse(file?.content ?? "") as { denyWrite: { path: string }[] };
    expect(shown.denyWrite.map((entry) => entry.path)).toEqual(CLOSED);
  });

  it("refuses a temp directory under or holding a closed path", () => {
    for (const dir of ["/tmp/claude", "/tmp/claude/run-1", "/private/tmp/claude/x"]) {
      expect(() => plan(spec(), context({ tmpDir: dir }))).toThrow(/may not write/);
    }
    for (const dir of ["/tmp", "/private/tmp", "/private"]) {
      expect(() => plan(spec(), context({ tmpDir: dir }))).toThrow(/must not hold/);
    }
    expect(() => plan(spec(), context({ tmpDir: "/tmp/claude-501" }))).not.toThrow();
  });
});
