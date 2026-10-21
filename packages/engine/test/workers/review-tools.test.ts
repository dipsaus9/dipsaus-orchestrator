// The reviewer's tools and run settings (0021 sections 10 and 14, DIPO-276): read-only on dipo's
// copy of the pushed commit plus web search and fetch; no shell, no write, no gh. The copy is an
// added directory of the run settings, never the working directory, so no project settings, hooks
// or CLAUDE.md load from it.

import { describe, expect, it } from "bun:test";

import { OFFICE_DEFAULTS } from "../../src/config";
import { REVIEWER_TOOLS } from "../../src/run/launch";
import { EMPTY_MCP_CONFIG_FILE, plan, SETTINGS_FILE } from "../../src/workers/claude-cli/plan";
import { REVIEW_REPORT_JSON_SCHEMA } from "../../src/workers/claude-cli/report-schema";
import { PlanError } from "../../src/workers/types";
import type { LaunchPlan } from "../../src/workers/types";
import {
  HOME,
  MAIN,
  REVIEW_COPY,
  REVIEW_FOLDER,
  REVIEW_SESSION,
  reviewContext,
  reviewSpec,
  RUN_DIR,
  SHORT_TMP_DIR,
  spec,
  TMP_DIR,
  WORKDIR,
} from "./launch-fixtures";

interface ReviewSettings {
  claudeMdExcludes?: string[];
  permissions: {
    allow: string[];
    deny: string[];
    additionalDirectories?: string[];
    blockReadsOutsideWorkingDirectories?: boolean;
  };
  sandbox: {
    filesystem: { allowWrite: string[]; denyWrite: string[] };
    network: Record<string, unknown>;
  };
  hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
  enabledPlugins?: Record<string, boolean>;
}

function settingsOf(launch: LaunchPlan): ReviewSettings {
  const file = launch.files.find((entry) => entry.name === SETTINGS_FILE);
  if (file === undefined) throw new Error("no settings file");
  return JSON.parse(file.content) as ReviewSettings;
}

function flag(launch: LaunchPlan, name: string): string | undefined {
  const index = launch.argv.indexOf(name);
  return index === -1 ? undefined : launch.argv[index + 1];
}

describe("the reviewer's tool set (DIPO-276)", () => {
  it("is Read, Glob, Grep, WebSearch and WebFetch for the reviewer role", () => {
    expect([...REVIEWER_TOOLS]).toEqual(["Read", "Glob", "Grep", "WebSearch", "WebFetch"]);
  });

  it("passes only those tools, the review model and effort and the ReviewReport schema", () => {
    const launch = plan(reviewSpec(), reviewContext());
    expect(flag(launch, "--tools")).toBe("Read,Glob,Grep,WebSearch,WebFetch");
    expect(flag(launch, "--model")).toBe("opus");
    expect(flag(launch, "--effort")).toBe("high");
    expect(JSON.parse(flag(launch, "--json-schema") ?? "null")).toEqual(REVIEW_REPORT_JSON_SCHEMA);
    const tools = (flag(launch, "--tools") ?? "").split(",");
    for (const tool of ["Bash", "Edit", "Write", "NotebookEdit", "Agent"]) {
      expect(tools).not.toContain(tool);
    }
  });

  it("refuses a shell, a write tool or any other tool in a review spec", () => {
    for (const tool of ["Bash", "Edit", "Write", "NotebookEdit", "Agent", "Task"]) {
      const extra = reviewSpec({ tools: { allow: [...REVIEWER_TOOLS, tool], deny: [] } });
      expect(() => plan(extra, reviewContext())).toThrow(PlanError);
      expect(() => plan(extra, reviewContext())).toThrow(`not ${tool}`);
    }
  });

  it("allows reads only on the copy, plus the two web tools, and nothing else", () => {
    const { permissions } = settingsOf(plan(reviewSpec(), reviewContext()));
    expect(permissions.allow).toEqual([`Read(/${REVIEW_COPY}/**)`, "WebSearch", "WebFetch"]);
    expect(permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    // No Bash rule and no rule on the story worktree or the main checkout.
    expect(JSON.stringify(permissions.allow)).not.toContain(WORKDIR);
    expect(JSON.stringify(permissions.allow)).not.toContain(MAIN);
    for (const rule of [
      `Edit(/${REVIEW_COPY}/**)`,
      `Write(/${REVIEW_COPY}/**)`,
      `Edit(/${REVIEW_SESSION}/**)`,
      `Write(/${REVIEW_SESSION}/**)`,
      `Read(/${REVIEW_COPY}/**/.env*)`,
      "Read(~/.ssh/**)",
      "Read(~/.config/gh/**)",
    ]) {
      expect(permissions.deny).toContain(rule);
    }
  });

  it("checks every web call with the hook relay's gate", () => {
    const settings = settingsOf(plan(reviewSpec(), reviewContext()));
    const gate = settings.hooks?.["PreToolUse"]?.[0];
    expect(gate?.matcher).toBe("WebFetch|WebSearch");
    expect(() => plan(reviewSpec({ hookRelay: false }), reviewContext())).toThrow(/hook relay/);
  });

  it("closes the sandbox network and writes, whatever the office allows its workers", () => {
    const open = reviewContext({
      sandbox: {
        ...OFFICE_DEFAULTS.sandbox,
        allowedDomains: ["example.com"],
        allowLocalBinding: true,
      },
    });
    const { sandbox } = settingsOf(plan(reviewSpec(), open));
    expect(sandbox.network).toEqual({
      allowedDomains: [],
      strictAllowlist: true,
      allowLocalBinding: false,
    });
    expect(sandbox.filesystem.allowWrite).toEqual([TMP_DIR, SHORT_TMP_DIR]);
    expect(sandbox.filesystem.denyWrite).toContain(REVIEW_SESSION);
    expect(sandbox.filesystem.denyWrite).toContain(REVIEW_COPY);
  });

  it("loads no MCP server, skill, slash command or plugin", () => {
    const plugins = { installed: ["warp@claude-code-warp"], allowed: ["warp@claude-code-warp"] };
    const launch = plan(reviewSpec(), reviewContext({ plugins }));
    expect(launch.argv).toContain("--strict-mcp-config");
    expect(flag(launch, "--mcp-config")).toBe(`${RUN_DIR}/${EMPTY_MCP_CONFIG_FILE}`);
    expect(launch.argv).toContain("--disable-slash-commands");
    expect(settingsOf(launch).enabledPlugins).toEqual({ "warp@claude-code-warp": false });
  });
});

describe("the reviewer's working directory and copy (DIPO-276)", () => {
  it("runs in its empty folder and reaches the copy only as an added directory of the run settings", () => {
    const launch = plan(reviewSpec(), reviewContext());
    expect(launch.cwd).toBe(REVIEW_SESSION);
    const settings = settingsOf(launch);
    expect(settings.permissions.additionalDirectories).toEqual([REVIEW_COPY]);
    // `--add-dir` would load skills, commands, agents and plugin settings from the copy.
    expect(launch.argv).not.toContain("--add-dir");
    expect(launch.argv.some((arg) => arg.startsWith(REVIEW_FOLDER))).toBe(false);
    expect(flag(launch, "--setting-sources")).toBe("project,local");
    // Claude Code loads CLAUDE.md of an added directory only with this variable; it never gets it.
    expect(launch.env["CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD"]).toBeUndefined();
  });

  it("excludes every CLAUDE.md of the copy by path", () => {
    expect(settingsOf(plan(reviewSpec(), reviewContext())).claudeMdExcludes).toEqual([
      `${REVIEW_COPY}/**`,
    ]);
  });

  it("refuses a copy that is, holds or lies in its working directory, the main checkout or home", () => {
    const cases = [
      { readOnlyDir: REVIEW_SESSION },
      { readOnlyDir: `${REVIEW_SESSION}/copy` },
      { workdir: `${REVIEW_COPY}/inside`, readOnlyDir: REVIEW_COPY },
      { readOnlyDir: `${MAIN}/copy` },
      { readOnlyDir: `${HOME}/copy` },
      { readOnlyDir: `${TMP_DIR}/copy` },
      { readOnlyDir: "relative/copy" },
    ];
    for (const overrides of cases) {
      expect(() => plan(reviewSpec(overrides), reviewContext())).toThrow(PlanError);
    }
  });

  it("refuses a run directory, system file or hook command inside the copy", () => {
    expect(() => plan(reviewSpec(), reviewContext({ runDir: `${REVIEW_COPY}/run` }))).toThrow(
      PlanError,
    );
    expect(() =>
      plan(reviewSpec({ systemFile: `${REVIEW_COPY}/system.md` }), reviewContext()),
    ).toThrow(PlanError);
    expect(() =>
      plan(reviewSpec(), reviewContext({ hookCommand: [`${REVIEW_COPY}/bin/dipo`] })),
    ).toThrow(/outside the review copy/);
  });

  it("refuses a review spec without its copy, and a worker spec with one", () => {
    const { readOnlyDir: _dropped, ...without } = reviewSpec();
    expect(() => plan(without, reviewContext())).toThrow(/read-only copy/);
    expect(() => plan(spec({ readOnlyDir: REVIEW_COPY }), reviewContext())).toThrow(
      /only a review session/,
    );
  });

  it("leaves the implement plan as it was: the worktree as cwd, no copy and the office MCP config", () => {
    const launch = plan(spec(), reviewContext({ mcpConfig: `${MAIN}/.git/dipo/mcp.json` }));
    expect(launch.cwd).toBe(WORKDIR);
    expect(launch.files.map((file) => file.name)).not.toContain(EMPTY_MCP_CONFIG_FILE);
    const settings = settingsOf(launch);
    expect(settings.claudeMdExcludes).toBeUndefined();
    expect(settings.permissions.additionalDirectories).toBeUndefined();
    expect(settings.permissions.allow).toContain("Bash");
  });
});
