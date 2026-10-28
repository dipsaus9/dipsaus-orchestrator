// `probe` for the Claude CLI adapter (DIPO-43 AC #1, 0008 section 2): `claude --version` and
// `claude auth status`, refusing a version below 2.1.285 or any authMethod but `claude.ai`.

import { describe, expect, it } from "bun:test";

import { ManualClock } from "@dipsaus-orchestrator/testkit";

import {
  compareVersions,
  evaluateProbe,
  MIN_CLAUDE_VERSION,
  parseClaudeVersion,
  probe,
} from "../../src/workers/claude-cli/probe";
import { scriptedClaude } from "./launch-fixtures";

const CLAUDE = "/home/maintainer/.local/bin/claude";
const ENV = { PATH: "/usr/bin:/bin", HOME: "/home/maintainer" };

function out(version: string, authMethod: string) {
  return {
    version: { code: 0, stdout: `${version} (Claude Code)\n` },
    auth: { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod }) },
  };
}

describe("(unit) Claude Code probe", () => {
  it("reads and compares versions", () => {
    expect(parseClaudeVersion("2.1.296 (Claude Code)")).toBe("2.1.296");
    expect(parseClaudeVersion("Claude Code")).toBeNull();
    expect(compareVersions("2.1.284", MIN_CLAUDE_VERSION)).toBeLessThan(0);
    expect(compareVersions("2.1.285", MIN_CLAUDE_VERSION)).toBe(0);
    expect(compareVersions("2.2.0", MIN_CLAUDE_VERSION)).toBeGreaterThan(0);
    expect(compareVersions("10.0.0", "9.9.9")).toBeGreaterThan(0);
  });

  it("refuses version 2.1.284, naming it", () => {
    const status = evaluateProbe(out("2.1.284", "claude.ai"));
    expect(status.ok).toBe(false);
    expect(status.version).toBe("2.1.284");
    expect(status.reason).toContain("2.1.284");
    expect(status.reason).toContain("2.1.285");
  });

  it('refuses authMethod "api-key", naming it', () => {
    const status = evaluateProbe(out("2.1.296", "api-key"));
    expect(status.ok).toBe(false);
    expect(status.login).toBe("api-key");
    expect(status.reason).toContain("api-key");
  });

  it("accepts the minimum version on a claude.ai login and lists the capabilities", () => {
    const status = evaluateProbe(out("2.1.285", "claude.ai"));
    expect(status).toMatchObject({ ok: true, version: "2.1.285", login: "claude.ai" });
    expect(status.capabilities).toContain("resume");
    expect(status.capabilities).not.toContain("hooks");
  });

  it("refuses when either command fails or prints nothing usable", () => {
    expect(evaluateProbe({ version: null, auth: null }).ok).toBe(false);
    expect(evaluateProbe({ version: { code: 1, stdout: "" }, auth: null }).ok).toBe(false);
    const noJson = evaluateProbe({
      version: { code: 0, stdout: "2.1.296" },
      auth: { code: 0, stdout: "Logged in" },
    });
    expect(noJson.ok).toBe(false);
    const loggedOut = evaluateProbe({
      version: { code: 0, stdout: "2.1.296" },
      auth: { code: 1, stdout: '{"loggedIn":false,"authMethod":"claude.ai"}' },
    });
    expect(loggedOut.ok).toBe(false);
  });

  it("runs both commands through the injected Spawn with the worker's environment", async () => {
    const clock = new ManualClock();
    const fake = scriptedClaude(clock, {});
    const status = await probe({ spawn: fake.spawn, clock, claudePath: CLAUDE, env: ENV });
    expect(status.ok).toBe(true);
    expect(fake.calls.map((call) => call.cmd)).toEqual([
      [CLAUDE, "--version"],
      [CLAUDE, "auth", "status"],
    ]);
    expect(fake.calls[0]?.env).toEqual(ENV);
  });

  it("does not ask for the login when the version is refused", async () => {
    const clock = new ManualClock();
    const fake = scriptedClaude(clock, { version: "2.1.284" });
    const status = await probe({ spawn: fake.spawn, clock, claudePath: CLAUDE, env: ENV });
    expect(status.ok).toBe(false);
    expect(fake.calls.length).toBe(1);
  });
});
