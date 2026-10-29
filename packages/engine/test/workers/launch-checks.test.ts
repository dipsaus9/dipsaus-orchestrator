// The launch checks and the adapter hold (DIPO-43 AC #5 to #7, 0008 sections 2 and 7): a refusal
// is `startFailed`, holds the adapter for every office and emits an `engine.notice`; a later pass
// lifts it. Only a `session` launches on the Mac now (DIPO-240, DIPO-347): its checks are the tools,
// the probe and the project settings, with no self-test session, credential check or Safe-Chain
// proxy, and a developer or reviewer session is refused as a plan, since each runs only in a box.
//
// DIPO-257's two hold scopes rested on the self-test's could-not-run verdict; with the self-test
// gone every launch-check failure is one kind again and holds the adapter in every office, as an
// unsafe verdict did (criterion 6, kept); there is no could-not-run hold left to scope or back off.

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Event } from "@dipsaus-orchestrator/contract";
import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { SoftwareStream } from "../../src/software-stream/stream";
import { prepareLaunch, uncheckedTools } from "../../src/workers/claude-cli/launch-checks";
import { allowedTools } from "../../src/workers/claude-cli/tools";
import {
  CLAUDE_CLI_ADAPTER_ID,
  DEVELOPER_ON_MAC_REFUSED,
  REVIEWER_ON_MAC_REFUSED,
} from "../../src/workers/claude-cli/plan";
import {
  AdapterHolds,
  gateLaunch,
  HOLD_NOTICE_CODE,
  RELEASE_NOTICE_CODE,
} from "../../src/workers/hold";
import { PlanError } from "../../src/workers/types";
import { context, reviewSpec, scriptedClaude, sessionSpec, spec } from "./launch-fixtures";

function setup() {
  const clock = new ManualClock();
  const stream = new SoftwareStream({ clock, fill: (bytes) => bytes.fill(1) });
  const notices: Event[] = [];
  stream.onAppend((event) => notices.push(event));
  const holds = new AdapterHolds({
    clock,
    notify: (notice) => stream.append("engine.notice", notice),
  });
  return { clock, holds, notices };
}

/** Launch check deps for a session: a scripted claude and no project settings. */
function reviewDeps(clock: ManualClock, auth?: string) {
  const fake = scriptedClaude(clock, auth === undefined ? {} : { auth });
  return {
    fake,
    deps: {
      spawn: fake.spawn,
      clock,
      allowProjectSettings: [],
      readText: async () => undefined,
    },
  };
}

describe("(engine) adapter hold", () => {
  it("holds for every caller of adapterHeld until lifted, with a notice each way", () => {
    const { holds, notices } = setup();
    expect(holds.adapterHeld("claude-cli")).toBeNull();
    const hold = holds.hold("claude-cli", [
      { check: "settings", detail: "not allowed", file: "/w/.claude/settings.json", key: "hooks" },
    ]);
    expect(holds.adapterHeld("claude-cli")).toEqual(hold);
    expect(holds.adapterHeld("other")).toBeNull();
    expect(holds.lift("claude-cli")).toBe(true);
    expect(holds.lift("claude-cli")).toBe(false);
    expect(notices.map((event) => (event.data as { code: string }).code)).toEqual([
      HOLD_NOTICE_CODE,
      RELEASE_NOTICE_CODE,
    ]);
  });

  it("turns checks that throw into a hold", async () => {
    const { holds } = setup();
    const gate = await gateLaunch("claude-cli", holds, () => Promise.reject(new Error("boom")));
    expect(gate).toMatchObject({ ok: false, outcome: "startFailed" });
    expect(holds.adapterHeld("claude-cli")?.detail).toContain("boom");
  });
});

describe("(engine) a session's launch checks (DIPO-145, DIPO-240, DIPO-310)", () => {
  // A session has no tool at all, so no credential check or sandbox self-test runs for it: both
  // proved what sandboxed commands can reach, and a session runs none.
  it("runs the probe and the settings check only, with no session, and returns the plan", async () => {
    const { clock, holds } = setup();
    const { fake, deps } = reviewDeps(clock);
    const result = await prepareLaunch(sessionSpec(), context(), holds, deps);
    if (!result.ok) throw new Error(`refused: ${JSON.stringify(result)}`);
    expect(result.plan.argv[result.plan.argv.indexOf("--tools") + 1]).toBe("");
    expect(fake.calls.map((call) => call.cmd[1])).toEqual(["--version", "auth"]);
    expect(holds.adapterHeld(CLAUDE_CLI_ADAPTER_ID)).toBeNull();
    // No Safe-Chain shell in the session's plan.
    expect(result.plan.env["CLAUDE_CODE_SHELL"]).toBeUndefined();
  });

  it("holds on a refused probe in every office, with its reason, and a later pass lifts it", async () => {
    const { clock, holds, notices } = setup();
    const refused = reviewDeps(clock, '{"loggedIn":true,"authMethod":"api-key"}');
    const result = await prepareLaunch(sessionSpec(), context(), holds, refused.deps);
    expect(result).toMatchObject({ ok: false, outcome: "startFailed" });
    expect(holds.adapterHeld(CLAUDE_CLI_ADAPTER_ID)).toMatchObject({ check: "probe" });
    expect(holds.adapterHeld(CLAUDE_CLI_ADAPTER_ID)?.detail).toContain("api-key");
    expect(refused.fake.calls.some((call) => call.cmd.includes("-p"))).toBe(false);
    // The probe runs on the session's allowlisted environment: no API key reaches it.
    expect(refused.fake.calls[0]?.env?.["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(notices.map((event) => (event.data as { code: string }).code)).toEqual([
      HOLD_NOTICE_CODE,
    ]);
    const passed = await prepareLaunch(sessionSpec(), context(), holds, reviewDeps(clock).deps);
    expect(passed.ok).toBe(true);
    expect(holds.adapterHeld(CLAUDE_CLI_ADAPTER_ID)).toBeNull();
  });

  it('holds when the session folder\'s .claude/settings.json holds {"hooks":{}}, naming the key and the file', async () => {
    await withTempDir(async (root) => {
      const workdir = join(root, "dipo-scan-run-0001-agt-0001", "session");
      mkdirSync(join(workdir, ".claude"), { recursive: true });
      const file = join(workdir, ".claude", "settings.json");
      writeFileSync(file, '{"hooks":{}}');
      const { clock, holds, notices } = setup();
      const { fake } = reviewDeps(clock);
      const result = await prepareLaunch(sessionSpec({ workdir }), context(), holds, {
        spawn: fake.spawn,
        clock,
        allowProjectSettings: [],
      });
      expect(result).toMatchObject({ ok: false, outcome: "startFailed" });
      expect(holds.adapterHeld(CLAUDE_CLI_ADAPTER_ID)).toMatchObject({
        check: "settings",
        key: "hooks",
        file,
      });
      const text = String((notices.at(-1)?.data as { text?: string } | undefined)?.text);
      expect(text).toContain("hooks");
      expect(text).toContain(file);
      expect(text).toContain("worker.allowProjectSettings");
    });
  });
});

describe("(engine) a developer or reviewer session is never planned on the Mac (DIPO-240, DIPO-347)", () => {
  it("refuses it as a plan, holding nothing and running no check", async () => {
    const { clock, holds } = setup();
    const { fake, deps } = reviewDeps(clock);
    const refused = await prepareLaunch(spec(), context(), holds, deps).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(PlanError);
    expect((refused as PlanError).message).toBe(DEVELOPER_ON_MAC_REFUSED);
    expect(holds.adapterHeld(CLAUDE_CLI_ADAPTER_ID)).toBeNull();
    expect(fake.calls).toEqual([]);
  });

  it("refuses a reviewer as a plan too: it runs only in a read-only box of its own", async () => {
    const { clock, holds } = setup();
    const { fake, deps } = reviewDeps(clock);
    const refused = await prepareLaunch(reviewSpec(), context(), holds, deps).catch(
      (e: unknown) => e,
    );
    expect((refused as PlanError).message).toBe(REVIEWER_ON_MAC_REFUSED);
    expect(holds.adapterHeld(CLAUDE_CLI_ADAPTER_ID)).toBeNull();
    expect(fake.calls).toEqual([]);
  });
});

describe("(engine) roles with unchecked tools", () => {
  it.each(["Agent", "Task", "Skill"])("finds %s among a role's tools as unchecked", (tool) => {
    expect(uncheckedTools(["Read", tool])).toEqual([tool]);
  });

  it("gives no kind of session a tool that loads project agents or skills (DIPO-318)", () => {
    for (const kind of ["implement", "review", "session"] as const) {
      for (const web of [true, false]) {
        expect(uncheckedTools(allowedTools({ kind, web }))).toEqual([]);
      }
    }
  });
});
