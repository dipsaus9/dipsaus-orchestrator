// The capture's fixture host for the `web` scenario (DIPO-164 review; 0020 section 11b), offline:
// with `webGate` it answers a waiting `PreToolUse` call as the engine does, from the env file the
// scenario's `prepare` writes into the workdir: the URL holding its value gets Claude's deny naming
// the file and key, the clean search and fetch get the adapter's marker without a decision, and a
// `PermissionRequest` stays unanswered. No `claude` runs.

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  APPROVAL_COMMAND,
  CLAUDE_GATE_NO_DECISION_MARKER,
  PROBE_GROUPS,
  refusalText,
  relayHookPayload,
  SELF_TEST_DENY_REASON,
  selfTestLayout,
  selfTestSocketPath,
  systemClock,
} from "../../packages/engine/src/index";
import { withTempDir } from "../../packages/testkit/src/index";
import { fixtureHost, hostAnswer, sessionSocketOf, webGateAnswer } from "./capture";
import type { Envelope } from "./format";
import type { Scenario } from "./scenarios";
import {
  findScenario,
  selfTestPaths,
  turnText,
  WEB_ENV_FILE,
  WEB_ENV_KEY,
  WEB_ENV_VALUE,
  WEB_QUERY,
  WEB_REFUSED_URL,
  WEB_URL,
} from "./scenarios";

const web = (tool: string, input: Record<string, unknown>) => ({
  hook_event_name: "PreToolUse",
  tool_name: tool,
  tool_input: input,
});

const DENY = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: refusalText("WebFetch", { file: WEB_ENV_FILE, key: WEB_ENV_KEY }),
  },
};

/** The `web` scenario's workdir, prepared as the capture prepares it. */
function prepared(dir: string): string {
  const scenario = findScenario("web");
  expect(scenario?.webGate).toBe(true);
  const workdir = join(dir, "repo.worktrees", "story");
  mkdirSync(workdir, { recursive: true });
  scenario?.prepare?.({ root: dir, main: join(dir, "repo"), workdir, runDir: join(dir, "run") });
  return workdir;
}

describe("the web scenario's gate answer (DIPO-164 review)", () => {
  it("denies the URL holding the env value, naming the file and key, and allows the clean calls", () =>
    withTempDir(async (dir) => {
      const workdir = prepared(dir);
      const refused = webGateAnswer(workdir, web("WebFetch", { url: WEB_REFUSED_URL }));
      expect(JSON.parse(refused ?? "")).toEqual(DENY);
      expect(refused).not.toContain(WEB_ENV_VALUE);
      expect(webGateAnswer(workdir, web("WebFetch", { url: WEB_URL }))).toBe(
        CLAUDE_GATE_NO_DECISION_MARKER,
      );
      expect(webGateAnswer(workdir, web("WebSearch", { query: WEB_QUERY }))).toBe(
        CLAUDE_GATE_NO_DECISION_MARKER,
      );
      // Only a web tool's PreToolUse call is answered.
      expect(webGateAnswer(workdir, { hook_event_name: "PermissionRequest" })).toBeNull();
      expect(webGateAnswer(workdir, web("Bash", { command: "ls" }))).toBeNull();
    }));

  it("answers through the capture's fixture host the relay reaches, and leaves a PermissionRequest unanswered", () =>
    withTempDir(async (dir) => {
      const workdir = prepared(dir);
      const socket = join(dir, "host.sock");
      const seen: unknown[] = [];
      // The answer the capture gives its host: the gate's for `web`, none for `permission-wait`.
      expect(hostAnswer(findScenario("permission-wait") as Scenario, workdir)).toBeUndefined();
      const answer = hostAnswer(findScenario("web") as Scenario, workdir);
      expect(answer).toBeDefined();
      const host = fixtureHost(socket, (payload) => seen.push(payload), answer);
      const relay = (payload: unknown, waitMs: number) =>
        relayHookPayload({
          socketPath: socket,
          runId: "run-0001",
          payload: `${JSON.stringify(payload)}\n`,
          clock: systemClock,
          timeoutMs: 1_500,
          waitMs,
          graceMs: 100,
        });
      try {
        expect(
          JSON.parse((await relay(web("WebFetch", { url: WEB_REFUSED_URL }), 1_000)) ?? ""),
        ).toEqual(DENY);
        expect(await relay(web("WebFetch", { url: WEB_URL }), 1_000)).toBe(
          CLAUDE_GATE_NO_DECISION_MARKER,
        );
        expect(
          await relay({ hook_event_name: "PermissionRequest", tool_name: "Bash" }, 50),
        ).toBeNull();
        expect(seen).toHaveLength(3);
      } finally {
        await host.stop();
      }
    }));
});

/** One stdout line of a fake session. */
function line(data: unknown): Envelope {
  return { t: 0, ch: "stdout", data };
}

describe("the launch self-test's two calls (DIPO-244)", () => {
  const scenario = findScenario("safety-gitdir-write") as Scenario;
  const probes = PROBE_GROUPS["safety-gitdir-write"];

  /** The self-test's paths and layout under a temp directory, laid out as the capture does. */
  function selfTest(dir: string) {
    const paths = {
      root: dir,
      main: join(dir, "repo"),
      workdir: join(dir, "repo.worktrees", "story"),
      runDir: join(dir, "run"),
    };
    return { paths, layout: selfTestLayout(selfTestPaths(paths), probes) };
  }

  it("plans the probe and the approval call, and gives the session its own socket", () =>
    withTempDir(async (dir) => {
      expect(scenario.standIn).toBe(true);
      const { paths, layout } = selfTest(dir);
      const prompt = turnText(scenario.turns[0] ?? "", paths);
      expect(prompt).toContain(`\n${layout.command}\n`);
      expect(prompt).toContain(`\n${APPROVAL_COMMAND}\n`);
      const hostSocket = join(dir, "host.sock");
      expect(sessionSocketOf(scenario, hostSocket)).toBe(selfTestSocketPath(hostSocket));
      expect(sessionSocketOf(findScenario("web") as Scenario, hostSocket)).toBe(hostSocket);
    }));

  it("writes the approval evidence and judges a session whose approval call reached dipo ok", () =>
    withTempDir(async (dir) => {
      const { paths, layout } = selfTest(dir);
      mkdirSync(paths.workdir, { recursive: true });
      mkdirSync(join(dir, "tmp"), { recursive: true });
      writeFileSync(
        join(paths.workdir, ".git"),
        `gitdir: ${join(paths.main, ".git", "worktrees", "story")}\n`,
      );
      writeFileSync(layout.controlFile, "");
      writeFileSync(
        layout.resultsFile,
        [
          "control written",
          ...probes.map((probe) => `${probe} blocked Operation not permitted`),
          "",
        ].join("\n"),
      );
      // A fake session: the probe, the approval call with dipo's deny, and a done report.
      const raw: Envelope[] = [
        line({
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "t1", name: "Bash", input: { command: layout.command } },
            ],
          },
        }),
        line({
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: "t1", content: "", is_error: false }],
          },
        }),
        line({
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "t2", name: "Bash", input: { command: APPROVAL_COMMAND } },
            ],
          },
        }),
        line({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "t2",
                content: SELF_TEST_DENY_REASON,
                is_error: true,
              },
            ],
          },
        }),
        line({
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "fake-session",
          num_turns: 1,
          usage: { input_tokens: 0, output_tokens: 0 },
          modelUsage: {},
          structured_output: {
            status: "done",
            criteria: [{ n: 1, met: true, evidence: "fixture" }],
            summary: "Ran the probes.",
            commitSubject: "chore: record sandbox probes",
          },
        }),
        { t: 1, ch: "exit", data: { code: 0, signal: null } },
      ];
      const reached = [{ tool: "Bash", command: APPROVAL_COMMAND }];
      const checks = await scenario.verify?.(paths, raw, reached);
      expect(checks).toMatchObject({
        approval: { result: SELF_TEST_DENY_REASON, cliDenied: false, reached: true },
        bash: { calls: 2, exact: true, shape: true },
        verdict: { ok: true },
      });
      // Without the stand-in's PermissionRequest the approval call never reached dipo: refused.
      const unreached = await scenario.verify?.(paths, raw, []);
      expect(unreached).toMatchObject({ approval: { reached: false }, verdict: { ok: false } });
    }));
});
