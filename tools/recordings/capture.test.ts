// The capture's fixture host for the `web` scenario (DIPO-164 review; 0020 section 11b), offline:
// with `webGate` it answers a waiting `PreToolUse` call as the engine does, from the env file the
// scenario's `prepare` writes into the workdir: the URL holding its value gets Claude's deny naming
// the file and key, the clean search and fetch get the adapter's marker without a decision, and a
// `PermissionRequest` stays unanswered. No `claude` runs.

import { describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  CLAUDE_GATE_NO_DECISION_MARKER,
  refusalText,
  relayHookPayload,
  systemClock,
} from "../../packages/engine/src/index";
import { withTempDir } from "../../packages/testkit/src/index";
import { fixtureHost, hostAnswer, webGateAnswer } from "./capture";
import type { Scenario } from "./scenarios";
import {
  findScenario,
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
