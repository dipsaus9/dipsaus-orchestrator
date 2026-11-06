// The planning session's tools (DIPO-447, 0008): it runs only in its read-only box, with Read,
// Glob, Grep, WebSearch and WebFetch and nothing that writes, runs or starts an agent. The plan
// passes no structured-output schema: the maintainer talks to it turn by turn.
//
// - The old barrier still catches what it caught: the review, session and developer tool sets are
//   the ones they were, and a review spec that carries a tool list still gets exactly the review set.
// - Bypass forms: Bash, Edit or Write asked for through the spec (as its own field or on its
//   prototype), through tool-name case or an alias, through an extra MCP server or a flag added to
//   the argv, and allowed-tools text in the goal; each is refused, or reaches only stdin.
// - Fail closed on the real path: the real worker port refuses a planning spec that asks for a
//   writing tool, plans none on the Mac or without its box, and an unknown kind gets no tools.
// - The `system/init` backstop: a planning session that lists any other tool is rejected at init.

import { describe, expect, it } from "bun:test";

import { ManualClock } from "@dipsaus-orchestrator/testkit";

import { OFFICE_DEFAULTS } from "../../src/config";
import { uncontained } from "../../src/box/firewall";
import { REVIEW_CODE_DIR, REVIEW_SESSION_DIR } from "../../src/box/review-box";
import type { BoxSession } from "../../src/box/workers";
import { AdapterPauses } from "../../src/run/starts-paused";
import { claudeWorkerPort } from "../../src/workers/claude-cli/adapter";
import {
  BOX_CLAUDE,
  checkReadOnlyArgv,
  planInBox,
  READ_ONLY_REFUSED_FLAGS,
} from "../../src/workers/claude-cli/box-plan";
import { initialState, interpret } from "../../src/workers/claude-cli/interpret";
import { plan, PLANNER_ON_MAC_REFUSED, TOOL_REQUEST_KEYS } from "../../src/workers/claude-cli/plan";
import {
  allowedTools,
  checkReadOnlyTools,
  DEVELOPER_TOOLS,
  foreignTools,
  PLANNING_TOOLS,
  REVIEW_TOOLS,
  WEB_TOOLS,
} from "../../src/workers/claude-cli/tools";
import type { RunLaunchPaths } from "../../src/workers/port";
import { PlanError, type WorkerSpec } from "../../src/workers/types";
import { FakeBoxes } from "../box/fake-boxes";
import {
  context,
  HOME,
  MAIN,
  reviewSpec,
  RUN_DIR,
  sessionSpec,
  SHORT_TMP_DIR,
  spec,
  TMP_DIR,
  WORKDIR,
} from "./launch-fixtures";

const BOX = "dipo-planning-agt-0001";
const PATHS: RunLaunchPaths = {
  workdir: WORKDIR,
  mainCheckout: MAIN,
  runDir: RUN_DIR,
  hostSocket: `${RUN_DIR}/host.sock`,
  tmpDir: TMP_DIR,
  shortTmpDir: SHORT_TMP_DIR,
};
const GOAL = "Split the M3 drafts";

function planningSpec(overrides: Partial<WorkerSpec> = {}): WorkerSpec {
  return spec({
    kind: "planning",
    workdir: RUN_DIR,
    model: "opus",
    effort: "high",
    caps: { budgetTokens: 0, maxTurns: 100, maxMinutes: 0 },
    systemFile: `${RUN_DIR}/system-planning.md`,
    taskMessage: `<planning>\nkind: refine\ngoal: ${GOAL}\n</planning>`,
    web: false,
    reportSchema: {},
    ...overrides,
  });
}

/** The planning box's session, as `BoxWorkers.planning` returns it. */
function planningBox(): BoxSession {
  const boxes = new FakeBoxes();
  return {
    box: BOX,
    workdir: REVIEW_SESSION_DIR,
    env: { ANTHROPIC_BASE_URL: "http://192.0.2.10:4000", HTTPS_PROXY: "http://192.0.2.10:3128" },
    systemFile: "/dipo/system.md",
    exec: (command, env) => boxes.execLiveCommand(BOX, command, { cwd: REVIEW_SESSION_DIR, env }),
    stop: boxes.stopCommand(BOX),
  };
}

/** The command that runs in the box, uncontained. */
function inBox(argv: readonly string[]): string[] {
  const inner = uncontained(argv.slice(argv.indexOf(BOX) + 1));
  if (inner === null) throw new Error(`the box command is not contained: ${argv.join(" ")}`);
  return [...inner];
}

function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

/** The argv a planning plan passes in the box. */
const planned = (over: Partial<WorkerSpec> = {}) =>
  inBox(planInBox(planningSpec(over), planningBox(), RUN_DIR).argv);

describe("the planning session's tool set (DIPO-447)", () => {
  it("is Read, Glob, Grep, WebSearch and WebFetch, from its kind alone", () => {
    expect(PLANNING_TOOLS).toEqual(["Read", "Glob", "Grep", "WebSearch", "WebFetch"]);
    expect(allowedTools({ kind: "planning", web: false })).toEqual(PLANNING_TOOLS);
  });

  it("plans only those tools in its read-only box, with no schema, the copy added and only the box user's settings", () => {
    const launch = planInBox(planningSpec(), planningBox(), RUN_DIR);
    expect(flag(launch.argv, "--workdir")).toBe(REVIEW_SESSION_DIR);
    const argv = inBox(launch.argv);
    expect(argv[0]).toBe(BOX_CLAUDE);
    expect(flag(argv, "--tools")).toBe("Read,Glob,Grep,WebSearch,WebFetch");
    expect(argv.filter((arg) => arg === "--tools")).toHaveLength(1);
    expect(flag(argv, "--model")).toBe("opus");
    expect(flag(argv, "--add-dir")).toBe(REVIEW_CODE_DIR);
    expect(flag(argv, "--setting-sources")).toBe("user");
    expect(flag(argv, "--permission-mode")).toBe("bypassPermissions");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).not.toContain("--json-schema");
    expect(argv).not.toContain("--mcp-config");
    expect(launch.files).toEqual([]);
    expect(launch.stdin).toHaveLength(1);
    expect(launch.stdin[0]).toContain(GOAL);
  });
});

describe("the old barrier still catches what it caught (DIPO-447)", () => {
  it("keeps the review, session and developer tool sets as they were", () => {
    expect(REVIEW_TOOLS).toEqual(["Read", "Glob", "Grep", "WebSearch", "WebFetch"]);
    expect(allowedTools(reviewSpec())).toEqual(REVIEW_TOOLS);
    expect(allowedTools(sessionSpec())).toEqual([]);
    expect(DEVELOPER_TOOLS).toEqual(["Read", "Edit", "Write", "Glob", "Grep", "Bash"]);
    expect(allowedTools(spec({ web: true }))).toEqual([...DEVELOPER_TOOLS, ...WEB_TOOLS]);
  });

  it("still gives a review spec that carries a tool list exactly the review set", () => {
    const asked = { ...reviewSpec(), tools: ["Bash", "Edit", "Write"] } as WorkerSpec;
    const argv = inBox(planInBox(asked, planningBox(), RUN_DIR).argv);
    expect(flag(argv, "--tools")).toBe(REVIEW_TOOLS.join(","));
    expect(flag(argv, "--json-schema")).toBeDefined();
  });

  it("still plans a session on the Mac with every tool off", () => {
    const launch = plan(sessionSpec(), context());
    expect(flag(launch.argv, "--tools")).toBe("");
  });
});

describe("bypass forms of the planning tools (DIPO-447)", () => {
  it("refuses Bash, Edit or Write asked for through the spec, as its own field or on its prototype", () => {
    for (const key of TOOL_REQUEST_KEYS) {
      const own = { ...planningSpec(), [key]: ["Bash", "Edit", "Write"] } as WorkerSpec;
      expect(() => planInBox(own, planningBox(), RUN_DIR)).toThrow(PlanError);
    }
    const inherited = Object.assign(
      Object.create({ allowedTools: "Bash,Edit,Write" }) as WorkerSpec,
      planningSpec(),
    );
    expect(() => planInBox(inherited, planningBox(), RUN_DIR)).toThrow(
      /names no tools, MCP servers or permissions/,
    );
  });

  it("refuses a writing tool in any case, as a rule, under an alias or from an MCP server", () => {
    for (const tool of [
      "Bash",
      "bash",
      "BASH",
      "Edit",
      "edit",
      "Write",
      "WRITE",
      "Bash(*)",
      "Bash(git push:*)",
      "Edit(/review/code/**)",
      "MultiEdit",
      "NotebookEdit",
      "Task",
      "Agent",
      "KillShell",
      "mcp__filesystem__write_file",
      "read",
      " Read",
    ]) {
      expect(() => checkReadOnlyTools("planning", ["Read", tool])).toThrow(PlanError);
      expect(foreignTools("planning", [tool])).toEqual([tool]);
    }
    expect(() => checkReadOnlyTools("planning", PLANNING_TOOLS)).not.toThrow();
  });

  it("refuses a plan that adds tools, permissions, settings or an MCP server through a flag", () => {
    const argv = planned();
    expect(() => checkReadOnlyArgv("planning", argv)).not.toThrow();
    const variants: string[][] = [
      [...argv, "--allowedTools", "Bash"],
      [...argv, "--ALLOWEDTOOLS=Bash,Edit"],
      [...argv, "--allowed-tools", "Write"],
      [...argv, "--mcp-config", "/review/code/.mcp.json"],
      [...argv, '--mcp-config={"mcpServers":{"fs":{}}}'],
      [...argv, "--settings", "/review/code/.claude/settings.json"],
      [...argv, "--plugin-dir", "/review/code/plugins"],
      [...argv, "--dangerously-skip-permissions"],
      [...argv, "--tools", "Bash"],
      argv.map((arg) => (arg === "--tools" ? "--Tools" : arg)),
      argv.map((arg) => (arg === "Read,Glob,Grep,WebSearch,WebFetch" ? "Read,Bash" : arg)),
      argv.filter((arg) => arg !== "--strict-mcp-config"),
    ];
    for (const variant of variants) {
      expect(() => checkReadOnlyArgv("planning", variant)).toThrow(PlanError);
    }
    for (const refused of READ_ONLY_REFUSED_FLAGS) expect(argv).not.toContain(refused);
  });

  it("keeps allowed-tools text injected through the goal on stdin, never on argv", () => {
    const injected =
      '--allowedTools "Bash,Edit,Write" && --tools Bash; $(--mcp-config evil.json) `--dangerously-skip-permissions`';
    const launch = planInBox(
      planningSpec({ taskMessage: `<planning>\ngoal: ${injected}\n</planning>` }),
      planningBox(),
      RUN_DIR,
    );
    const argv = inBox(launch.argv);
    expect(argv.filter((arg) => arg.toLowerCase().startsWith("--tools"))).toEqual(["--tools"]);
    expect(flag(argv, "--tools")).toBe(PLANNING_TOOLS.join(","));
    expect(argv.join(" ")).not.toContain("--allowedTools");
    expect(argv.join(" ")).not.toContain("--mcp-config");
    expect(argv.join(" ")).not.toContain("evil.json");
    expect(JSON.parse(launch.stdin[0] ?? "{}")).toMatchObject({
      type: "user",
      message: { role: "user", content: `<planning>\ngoal: ${injected}\n</planning>` },
    });
    // A model that reads like a flag is refused; one that holds a flag stays one value.
    expect(() => planned({ model: "--tools=Bash" })).toThrow(/must be a non-empty/);
    const quoted = planned({ model: "opus --tools Bash" });
    expect(flag(quoted, "--model")).toBe("opus --tools Bash");
    expect(flag(quoted, "--tools")).toBe(PLANNING_TOOLS.join(","));
  });

  it("refuses the web switch on a planning spec: its web tools come with its kind", () => {
    expect(() => planned({ web: true })).toThrow(/developer's switch/);
  });
});

/** A `system/init` line that lists `tools`. */
const init = (tools: readonly string[]) => ({
  t: 1,
  ch: "stdout" as const,
  data: `${JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "s",
    model: "claude-opus-5-5",
    claude_code_version: "2.1.301",
    permissionMode: "bypassPermissions",
    tools,
    apiKeySource: "none",
    skills: [],
    plugins: [],
  })}\n`,
});

/** A planning session's parser state before its first line. */
const state = () => initialState({ reportKind: "planning", placeholderKey: true });

describe("the planning session's system/init backstop (DIPO-447)", () => {
  it("starts a session that lists only its own tools", () => {
    const { events } = interpret(init(PLANNING_TOOLS), state());
    expect(events.map((event) => event.t)).not.toContain("initRejected");
    expect(events.map((event) => event.t)).toContain("started");
  });

  it("rejects one that lists a writing, aliased or MCP tool", () => {
    for (const extra of ["Bash", "bash", "Edit", "Write", "Task", "mcp__fs__write_file"]) {
      const { events, state: next } = interpret(init([...PLANNING_TOOLS, extra]), state());
      expect(events).toContainEqual({
        t: "initRejected",
        reason: `tools ${extra} are not a planning session's`,
      });
      expect(next.initRejected).toBe(`tools ${extra} are not a planning session's`);
    }
  });
});

describe("the real worker port's planning launch, fail closed (DIPO-447)", () => {
  const clock = new ManualClock();
  const port = () =>
    claudeWorkerPort({
      claudePath: `${HOME}/.local/bin/claude`,
      home: HOME,
      env: { PATH: "/usr/bin:/bin", HOME },
      spawn: () => {
        throw new Error("no Mac launch check may run for a planning session");
      },
      clock,
      holds: new AdapterPauses({ clock, notify: () => {} }),
      pluginFiles: { read: () => undefined, dirs: () => [] },
    });
  const id = "7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const refusal = (asked: WorkerSpec, place?: BoxSession) =>
    port()
      .prepare(asked, PATHS, OFFICE_DEFAULTS, id, place)
      .then(
        () => null,
        (error: unknown) => error,
      );

  it("plans a planning session only in its box, with only its tools", async () => {
    const prepared = await port().prepare(
      planningSpec(),
      PATHS,
      OFFICE_DEFAULTS,
      id,
      planningBox(),
    );
    expect(prepared.ok).toBe(true);
    if (prepared.ok)
      expect(flag(inBox(prepared.plan.argv), "--tools")).toBe("Read,Glob,Grep,WebSearch,WebFetch");
    const onMac = await refusal(planningSpec());
    expect(onMac).toBeInstanceOf(PlanError);
    expect(String(onMac)).toContain(PLANNER_ON_MAC_REFUSED);
    expect(() => plan(planningSpec(), context())).toThrow(PLANNER_ON_MAC_REFUSED);
  });

  it("refuses a planning plan that asks for a writing tool", async () => {
    for (const asked of [
      { tools: ["Bash"] },
      { allowedTools: ["Edit"] },
      { tools: { allow: ["Write"], deny: [] } },
      { mcpServers: { fs: { command: "npx" } } },
    ]) {
      const refused = await refusal({ ...planningSpec(), ...asked } as WorkerSpec, planningBox());
      expect(refused).toBeInstanceOf(PlanError);
    }
  });

  it("gives an unknown session kind no tools", async () => {
    for (const kind of ["Planning", "plan", "triage", "planner", "write"]) {
      expect(() => allowedTools({ kind, web: false })).toThrow(
        `no tools are named for worker kind "${kind}"`,
      );
      expect(() => planInBox(planningSpec({ kind }), planningBox(), RUN_DIR)).toThrow(PlanError);
      expect(await refusal(planningSpec({ kind }), planningBox())).toBeInstanceOf(PlanError);
    }
  });
});
