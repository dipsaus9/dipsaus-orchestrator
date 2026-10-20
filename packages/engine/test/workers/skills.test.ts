// Skills in worker sessions (DIPO-130): every session, the self-test included, is planned with
// `--disable-slash-commands`, so no skill loads and a steer that starts with `/` expands nothing;
// a session whose `system/init` still lists a skill is stopped at its `system/init`
// (`startRefused`) and ends `startFailed` naming the skills, its turn carrying no report, while the
// story stays Ready (no park proposed). A session that lists no skill starts and runs as before.

import { describe, expect, it } from "bun:test";

import type { Spawn } from "@dipsaus-orchestrator/contract";
import { type FakeProcess, ManualClock, type Recording } from "@dipsaus-orchestrator/testkit";

import { claudeCliAdapter } from "../../src/workers/claude-cli/adapter";
import { initialState, interpret } from "../../src/workers/claude-cli/interpret";
import { prepareLaunch } from "../../src/workers/claude-cli/launch-checks";
import { CLAUDE_CLI_ADAPTER_ID, plan } from "../../src/workers/claude-cli/plan";
import { result } from "../../src/workers/claude-cli/result";
import { selfTestLayout } from "../../src/workers/claude-cli/self-test";
import { DISABLE_SLASH_COMMANDS, skillRefusal } from "../../src/workers/claude-cli/skills";
import { AdapterHolds } from "../../src/workers/hold";
import type { ParseState } from "../../src/workers/types";
import { hostLines } from "../ingest/helpers";
import {
  ADMIN_DIR,
  BLOCKED_RESULTS,
  context,
  credentialSteps,
  HOME,
  initPlugin,
  MAIN,
  MemoryFs,
  reachedStandIn,
  scriptedClaude,
  SELF_TEST_SESSION,
  selfTestSession,
  spec,
  TMP_DIR,
  TOOLS,
  withoutSkills,
  WORKDIR,
} from "./launch-fixtures";
import { loadRecording, replay } from "./replay";

/**
 * `recording` with `skills` of every `system/init` set to `names` (recordings redact them), and
 * any other `fields` set too.
 */
function withInitSkills(
  recording: Recording,
  names: readonly string[],
  fields: Record<string, unknown> = {},
): Recording {
  const lines = recording.lines.map((line) => {
    const data = line.data as { type?: string; subtype?: string };
    if (line.ch !== "stdout" || data.type !== "system" || data.subtype !== "init") return line;
    return { ...line, data: { ...data, skills: [...names], ...fields } };
  });
  return { ...recording, lines };
}

/** One `system/init` stream line; `fields` override the passing defaults. */
const initLine = (fields: Record<string, unknown> = {}) => ({
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
    skills: ["x", "dataviz"],
    ...fields,
  })}\n`,
});

const checking = () => initialState({ plannedModel: "haiku", refuseSkills: true });

describe("(unit) the plan disables slash commands and skills", () => {
  it("passes --disable-slash-commands once, on a launch and on a resume", () => {
    for (const resume of [false, true]) {
      const launch = plan(
        spec({ session: { id: spec().session.id, resume } }),
        context({ plugins: { installed: [], allowed: [] } }),
      );
      expect(launch.argv.filter((flag) => flag === DISABLE_SLASH_COMMANDS)).toHaveLength(1);
    }
  });

  it("passes it whatever the role's tools, Skill included (no session has grants yet)", () => {
    const launch = plan(spec({ tools: { allow: ["Read", "Skill"], deny: [] } }), context());
    expect(launch.argv).toContain(DISABLE_SLASH_COMMANDS);
  });
});

describe("(unit) the system/init skills check", () => {
  it("refuses a session that lists any skill, naming them, before started", () => {
    const step = interpret(initLine(), checking());
    expect(step.events.map((event) => event.t)).toEqual(["startRefused", "started"]);
    expect(step.events[0]).toEqual({ t: "startRefused", reason: skillRefusal(["x", "dataviz"]) });
    expect(step.state.skills).toEqual(["x", "dataviz"]);
    expect(step.state.startFailure).toContain("skills x, dataviz");
    const decided = result(step.state, { code: 143, signal: null });
    expect(decided.outcome).toBe("startFailed");
    expect(decided.detail).toContain(DISABLE_SLASH_COMMANDS);
    expect(decided.park).toBeUndefined();
  });

  it("starts a session with an empty skills list, or none at all, normally", () => {
    for (const fields of [{ skills: [] }, { skills: undefined }]) {
      const step = interpret(initLine(fields), checking());
      expect(step.events.map((event) => event.t)).toEqual(["started"]);
      expect(step.state.startFailure).toBeNull();
      expect(step.state.skills).toEqual([]);
    }
  });

  it("keeps the list but checks nothing without the check in the state", () => {
    const step = interpret(initLine(), initialState({ plannedModel: "haiku" }));
    expect(step.events.map((event) => event.t)).toEqual(["started"]);
    expect(step.state.skills).toEqual(["x", "dataviz"]);
  });

  it("leaves a rejected init init-rejected, and a plugin refusal the only startRefused", () => {
    const rejected = interpret(initLine({ apiKeySource: "user" }), checking());
    expect(rejected.events.map((event) => event.t)).toEqual(["initRejected", "started"]);
    expect(rejected.state.startFailure).toBeNull();

    const plugin = interpret(
      initLine({ plugins: [initPlugin("warp@claude-code-warp")] }),
      initialState({ plannedModel: "haiku", refuseSkills: true, allowedPlugins: [] }),
    );
    expect(plugin.events.filter((event) => event.t === "startRefused")).toHaveLength(1);
    expect(plugin.state.startFailure).toContain("warp@claude-code-warp");
  });
});

describe("(engine) the live recording safety-slash-skill", () => {
  // Claude Code 2.1.301 with the plan's flags on the scratch repository: a project skill x with
  // hooks in the worktree, and a steer "/x" after the first turn.
  const live = loadRecording("safety-slash-skill");

  it("records skills: [] and the flag, and runs to a done report under the check", async () => {
    expect(live.meta.flags).toContain(DISABLE_SLASH_COMMANDS);
    expect(live.meta.checks).toMatchObject({
      initSkills: [0, 0],
      skillBodyReachedModel: false,
      hookMarkerWritten: false,
      stopMarkerWritten: false,
      hookStartedLines: 0,
      control: { initSkills: [20, 20], skillBodyReachedModel: true, hookMarkerWritten: true },
    });
    // Two user messages: the task, then the steer, sent as the adapter sends one.
    expect(live.meta.steering?.filter((op) => op.op === "user").map((op) => op.priority)).toEqual([
      undefined,
      "next",
    ]);
    const run = await replay(live, { state: checking() });
    expect(run.state.skills).toEqual([]);
    expect(run.events.some((event) => event.t === "startRefused")).toBe(false);
    expect(run.events.filter((event) => event.t === "turn")).toHaveLength(2);
    // No tool call (the report is not one): the steer expanded nothing, so no skill hook ran.
    const tools = run.events.flatMap((event) =>
      event.t === "activity" && event.kind === "tool" ? [event.tool] : [],
    );
    expect(tools).toEqual([]);
    expect(run.events.some((event) => event.t === "hook")).toBe(false);
    expect(run.result.outcome).toBe("done");
  });

  it("ends startFailed with no report when the same session lists a skill", async () => {
    const run = await replay(withInitSkills(live, ["x"]), { state: checking() });
    expect(run.result.outcome).toBe("startFailed");
    expect(run.result.detail).toBe(skillRefusal(["x"]));
    expect(run.result.park).toBeUndefined();
    expect(run.result.report).toBeNull();
    const kinds = run.events.map((event) => event.t);
    expect(kinds.filter((kind) => kind === "startRefused")).toHaveLength(1);
    expect(kinds.indexOf("startRefused")).toBeLessThan(kinds.indexOf("started"));
  });
});

const neverSpawn = () => {
  throw new Error("no process may start in this test");
};

describe("(engine) the adapter checks skills on every launch", () => {
  const clock = new ManualClock();

  it("refuses a recording made before the flag, whatever the stored state held", () => {
    const adapter = claudeCliAdapter(context(), { spawn: neverSpawn, clock });
    let state = {
      ...initialState({ plannedModel: "haiku" }),
      refuseSkills: false,
    } as unknown as ParseState;
    const kinds: string[] = [];
    for (const line of hostLines(loadRecording("success-single"))) {
      const step = adapter.interpret(line, state);
      state = step.state;
      kinds.push(...step.events.map((event) => event.t));
    }
    expect(kinds).toContain("startRefused");
    const decided = adapter.result(state, { code: 0, signal: null });
    expect(decided.outcome).toBe("startFailed");
    expect(decided.detail).toContain("system/init lists skills");
  });

  it("runs the same recording to done when its system/init lists no skill", () => {
    const adapter = claudeCliAdapter(context(), { spawn: neverSpawn, clock });
    let state = initialState({ plannedModel: "haiku" }) as unknown as ParseState;
    for (const line of hostLines(withoutSkills(loadRecording("success-single")))) {
      state = adapter.interpret(line, state).state;
    }
    expect(adapter.result(state, { code: 0, signal: null }).outcome).toBe("done");
  });
});

describe("(engine) skills in the self-test session", () => {
  const LAYOUT = selfTestLayout({
    main: MAIN,
    workdir: WORKDIR,
    adminDir: ADMIN_DIR,
    tmpDir: TMP_DIR,
    nonce: SELF_TEST_SESSION.replaceAll("-", "").slice(0, 16),
    tools: TOOLS,
    home: HOME,
  });

  function run(
    skills: readonly string[],
    init: Record<string, unknown> = {},
    ctx: Parameters<typeof context>[0] = {},
  ) {
    const clock = new ManualClock();
    const holds = new AdapterHolds({ clock, notify: () => undefined });
    const fs = new MemoryFs();
    const sessions: FakeProcess[] = [];
    const calls: (readonly string[])[] = [];
    const base = scriptedClaude(clock, {
      session: withInitSkills(selfTestSession([LAYOUT.command]), skills, init),
      onSession: () => {
        fs.files.set(LAYOUT.resultsFile, BLOCKED_RESULTS);
        fs.files.set(LAYOUT.controlFile, "");
      },
    });
    const spawn: Spawn = (options) => {
      const child = base.spawn(options);
      if (options.cmd.includes("-p")) {
        sessions.push(child as FakeProcess);
        calls.push(options.cmd);
      }
      return child;
    };
    const launch = prepareLaunch(spec(), context(ctx), holds, {
      spawn,
      clock,
      selfTestSessionId: SELF_TEST_SESSION,
      standIn: reachedStandIn(),
      platform: "darwin",
      runStep: credentialSteps().runStep,
      uid: 501,
      allowProjectSettings: [],
      readText: async () => undefined,
      fs,
    });
    return { launch, holds, sessions, calls };
  }

  it("plans the self-test session with --disable-slash-commands and passes on skills: []", async () => {
    const { launch, holds, sessions, calls } = run([]);
    expect((await launch).ok).toBe(true);
    expect(holds.adapterHeld(CLAUDE_CLI_ADAPTER_ID)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(DISABLE_SLASH_COMMANDS);
    expect(sessions[0]?.signals).toEqual([]);
  });

  it("refuses startFailed, stopping the session at system/init before its Bash call", async () => {
    const { launch, holds, sessions } = run(["x"]);
    expect(await launch).toMatchObject({ ok: false, outcome: "startFailed" });
    const hold = holds.adapterHeld(CLAUDE_CLI_ADAPTER_ID);
    expect(hold).toMatchObject({ check: "self-test", key: "skills" });
    expect(hold?.detail).toContain("system/init lists skill x");
    expect(hold?.failures[0]?.fix).toContain(DISABLE_SLASH_COMMANDS);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.signals).toEqual(["SIGTERM"]);
  });

  it("reports a rejected init, not the skills or plugins, when the key source fails too", async () => {
    const warp = "warp@claude-code-warp";
    for (const [init, ctx] of [
      [{ apiKeySource: "user" }, {}],
      [
        { apiKeySource: "user", plugins: [initPlugin(warp)] },
        { plugins: { installed: [warp], allowed: [] } },
      ],
    ] as const) {
      const { launch, holds } = run(["x"], init, ctx);
      expect(await launch).toMatchObject({ ok: false, outcome: "startFailed" });
      const hold = holds.adapterHeld(CLAUDE_CLI_ADAPTER_ID);
      expect(hold?.key).toBeUndefined();
      expect(hold?.detail).toContain("ended initRejected: apiKeySource is user");
      expect(hold?.detail).not.toContain("system/init lists");
    }
  });
});
