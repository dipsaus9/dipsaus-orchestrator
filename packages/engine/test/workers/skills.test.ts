// Skills in worker sessions (DIPO-130): every session, a reviewer's and a box developer's, is planned with
// `--disable-slash-commands`, so no skill loads and a steer that starts with `/` expands nothing;
// a session whose `system/init` still lists a skill is stopped at its `system/init`
// (`startRefused`) and ends `startFailed` naming the skills, its turn carrying no report, while the
// story stays Ready (no park proposed). A session that lists no skill starts and runs as before.

import { describe, expect, it } from "bun:test";

import { ManualClock, type Recording } from "@dipsaus-orchestrator/testkit";

import type { BoxSession } from "../../src/box/workers";
import { boxClaudeArgv } from "../../src/workers/claude-cli/box-plan";

import { claudeCliAdapter } from "../../src/workers/claude-cli/adapter";
import { initialState, interpret } from "../../src/workers/claude-cli/interpret";
import { plan } from "../../src/workers/claude-cli/plan";
import { result } from "../../src/workers/claude-cli/result";
import { DISABLE_SLASH_COMMANDS, skillRefusal } from "../../src/workers/claude-cli/skills";
import type { ParseState } from "../../src/workers/types";
import { hostLines } from "../ingest/helpers";
import {
  context,
  initPlugin,
  reviewContext,
  reviewSpec,
  spec,
  withoutSkills,
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

/** A box developer's argv (DIPO-240): only its system file comes from the box session. */
const BOX_DEVELOPER_ARGV = boxClaudeArgv(spec(), { systemFile: "/dipo/system.md" } as BoxSession);

const checking = () => initialState({ plannedModel: "haiku", refuseSkills: true });

describe("(unit) the plan disables slash commands and skills", () => {
  it("passes --disable-slash-commands once, on a launch and on a resume", () => {
    for (const resume of [false, true]) {
      const launch = plan(
        reviewSpec({ session: { id: reviewSpec().session.id, resume } }),
        reviewContext({ plugins: { installed: [], allowed: [] } }),
      );
      expect(launch.argv.filter((flag) => flag === DISABLE_SLASH_COMMANDS)).toHaveLength(1);
    }
  });

  it("passes it in a box developer's session too (DIPO-240)", () => {
    expect(BOX_DEVELOPER_ARGV).toContain(DISABLE_SLASH_COMMANDS);
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
