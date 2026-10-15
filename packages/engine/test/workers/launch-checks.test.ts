// The launch checks and the adapter hold (DIPO-43 AC #5 to #7, 0008 sections 2 and 7): a refusal
// is `startFailed`, holds the adapter for every office and emits an `engine.notice`; a later pass
// lifts it; the checks run before a launch and before a resume.

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Event } from "@dipsaus-orchestrator/contract";
import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { SoftwareStream } from "../../src/software-stream/stream";
import { prepareLaunch } from "../../src/workers/claude-cli/launch-checks";
import { CLAUDE_CLI_ADAPTER_ID } from "../../src/workers/claude-cli/plan";
import { selfTestLayout } from "../../src/workers/claude-cli/self-test";
import {
  AdapterHolds,
  gateLaunch,
  HOLD_NOTICE_CODE,
  RELEASE_NOTICE_CODE,
} from "../../src/workers/hold";
import {
  ADMIN_DIR,
  BLOCKED_RESULTS,
  context,
  HOME,
  MAIN,
  MemoryFs,
  RUN_DIR,
  scriptedClaude,
  credentialSteps,
  SELF_TEST_SESSION,
  selfTestSession,
  spec,
  TMP_DIR,
  TOOLS,
  WORKDIR,
} from "./launch-fixtures";

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

const NONCE = SELF_TEST_SESSION.replaceAll("-", "").slice(0, 16);
const LAYOUT_PATHS = {
  main: MAIN,
  workdir: WORKDIR,
  adminDir: ADMIN_DIR,
  tmpDir: TMP_DIR,
  nonce: NONCE,
  tools: TOOLS,
  home: HOME,
};
const LAYOUT = selfTestLayout(LAYOUT_PATHS);

/** A self-test whose sandboxed command leaves `results` behind. */
function claudeWith(clock: ManualClock, fs: MemoryFs, results: string) {
  return scriptedClaude(clock, {
    session: selfTestSession([LAYOUT.command]),
    onSession: () => {
      fs.files.set(LAYOUT.resultsFile, results);
      fs.files.set(LAYOUT.controlFile, "");
    },
  });
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

describe("(engine) Claude launch checks", () => {
  it("a failed self-test holds the adapter with the reason and the notice; a later pass lifts it", async () => {
    const { clock, holds, notices } = setup();
    const deps = (fs: MemoryFs, results: string) => ({
      spawn: claudeWith(clock, fs, results).spawn,
      clock,
      selfTestSessionId: SELF_TEST_SESSION,
      platform: "darwin" as const,
      runStep: credentialSteps().runStep,
      uid: 501,
      allowProjectSettings: [],
      readText: async () => undefined,
      fs,
    });

    const leaked = BLOCKED_RESULTS.replace("refs blocked Operation not permitted", "refs written");
    const refused = await prepareLaunch(spec(), context(), holds, deps(new MemoryFs(), leaked));
    expect(refused).toMatchObject({ ok: false, outcome: "startFailed" });
    const hold = holds.adapterHeld(CLAUDE_CLI_ADAPTER_ID);
    expect(hold).toMatchObject({ check: "self-test", key: "refs" });
    expect(hold?.detail).toContain("<main>/.git/refs");
    const notice = notices.at(-1);
    expect(notice?.type).toBe("engine.notice");
    expect(notice?.data).toMatchObject({ level: "error", code: HOLD_NOTICE_CODE });
    const noticeText = String((notice?.data as { text?: string } | undefined)?.text);
    expect(noticeText).toContain("<main>/.git/refs");
    expect(noticeText).toContain("every office");

    // An explicit work.run repeats the checks; they pass, the hold lifts.
    const passed = await prepareLaunch(
      spec(),
      context(),
      holds,
      deps(new MemoryFs(), BLOCKED_RESULTS),
    );
    expect(passed.ok).toBe(true);
    expect(holds.adapterHeld(CLAUDE_CLI_ADAPTER_ID)).toBeNull();
    expect(notices.at(-1)?.data).toMatchObject({ level: "info", code: RELEASE_NOTICE_CODE });
  });

  it('a worktree whose .claude/settings.json holds {"hooks":{}} fails with a notice naming hooks and the file', async () => {
    await withTempDir(async (root) => {
      const workdir = join(root, "shop.worktrees", "DIPO-999");
      const main = join(root, "shop");
      mkdirSync(join(workdir, ".claude"), { recursive: true });
      const file = join(workdir, ".claude", "settings.json");
      writeFileSync(file, '{"hooks":{}}');
      const { clock, holds, notices } = setup();
      const fake = scriptedClaude(clock, {});
      const ctx = context({
        mainCheckout: main,
        runDir: join(main, ".git", "dipo", "runs", "run-0001"),
        tmpDir: join(root, "tmp"),
        hostSocket: join(root, "host.sock"),
      });
      const result = await prepareLaunch(spec({ workdir }), ctx, holds, {
        spawn: fake.spawn,
        clock,
        selfTestSessionId: SELF_TEST_SESSION,
        platform: "darwin" as const,
        runStep: credentialSteps().runStep,
        uid: 501,
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
      // The self-test never started: no `claude -p`.
      expect(fake.calls.some((call) => call.cmd.includes("-p"))).toBe(false);
    });
  });

  it("a refused probe holds before the settings and self-test run", async () => {
    const { clock, holds } = setup();
    const fake = scriptedClaude(clock, { auth: '{"loggedIn":true,"authMethod":"api-key"}' });
    const result = await prepareLaunch(spec(), context(), holds, {
      spawn: fake.spawn,
      clock,
      selfTestSessionId: SELF_TEST_SESSION,
      platform: "darwin" as const,
      runStep: credentialSteps().runStep,
      uid: 501,
      allowProjectSettings: [],
      readText: async () => undefined,
      fs: new MemoryFs(),
    });
    expect(result.ok).toBe(false);
    expect(holds.adapterHeld(CLAUDE_CLI_ADAPTER_ID)).toMatchObject({ check: "probe" });
    expect(holds.adapterHeld(CLAUDE_CLI_ADAPTER_ID)?.detail).toContain("api-key");
    // The probe runs on the worker's allowlisted environment: no API key reaches it.
    expect(fake.calls[0]?.env?.["ANTHROPIC_API_KEY"]).toBeUndefined();
  });

  it("runs every check before a resume too, and returns the resume plan", async () => {
    const { clock, holds } = setup();
    const fs = new MemoryFs();
    const fake = claudeWith(clock, fs, BLOCKED_RESULTS);
    const resume = spec({ session: { id: "0e6f3f4c-5b8d-4c1e-9a2b-3c4d5e6f7a8b", resume: true } });
    const result = await prepareLaunch(resume, context(), holds, {
      spawn: fake.spawn,
      clock,
      selfTestSessionId: SELF_TEST_SESSION,
      platform: "darwin" as const,
      runStep: credentialSteps().runStep,
      uid: 501,
      allowProjectSettings: [],
      readText: async () => undefined,
      fs,
    });
    expect(result.ok && result.plan.argv).toContain("--resume");
    expect(fake.calls.map((call) => call.cmd[1])).toEqual(["--version", "auth", "-p"]);
    // The self-test is always a new session, never the run's.
    expect(fake.calls[2]?.cmd).toContain("--session-id");
    expect(fake.calls[2]?.cmd).not.toContain("--resume");
  });
});

describe("(engine) roles with unchecked tools", () => {
  it.each(["Agent", "Task", "Skill"])(
    "refuses a role that allows %s before any check runs",
    async (tool) => {
      const { clock, holds } = setup();
      const fake = scriptedClaude(clock, {});
      const result = await prepareLaunch(
        spec({ tools: { allow: ["Read", "Bash", tool], deny: [] } }),
        context(),
        holds,
        {
          spawn: fake.spawn,
          clock,
          selfTestSessionId: SELF_TEST_SESSION,
          platform: "darwin" as const,
          runStep: credentialSteps().runStep,
          uid: 501,
          allowProjectSettings: [],
          readText: async () => undefined,
          fs: new MemoryFs(),
        },
      );
      expect(result).toMatchObject({ ok: false, outcome: "startFailed" });
      expect(holds.adapterHeld(CLAUDE_CLI_ADAPTER_ID)).toMatchObject({ check: "tools", key: tool });
      expect(fake.calls).toEqual([]);
    },
  );
});

async function runCredentials(
  code: number | "startFailed" | { readonly wrapperExit: number },
  platform: "darwin" | "linux" = "darwin",
) {
  const { clock, holds } = setup();
  const steps = credentialSteps(code);
  const fake = scriptedClaude(clock, {});
  const result = await prepareLaunch(spec(), context(), holds, {
    spawn: fake.spawn,
    clock,
    selfTestSessionId: SELF_TEST_SESSION,
    platform,
    runStep: steps.runStep,
    uid: 501,
    allowProjectSettings: [],
    readText: async () => undefined,
    fs: new MemoryFs(),
  });
  return { result, holds, steps, fake };
}

describe("(engine) credential check under srt", () => {
  it("runs gh auth token and, on macOS, the Keychain lookup with output to /dev/null", async () => {
    const { steps } = await runCredentials(0, "darwin");
    expect(steps.commands[0]).toEqual([
      "/bin/sh",
      "-c",
      '"$0" "$@" >/dev/null 2>&1; echo "dipo-credential-exit $?"',
      TOOLS.gh,
      "auth",
      "token",
    ]);
    const linux = await runCredentials(1, "linux");
    expect(linux.steps.commands).toHaveLength(1);
  });

  it("holds the adapter when a credential command succeeds inside srt, before any session", async () => {
    const { result, holds, fake } = await runCredentials(0);
    expect(result).toMatchObject({ ok: false, outcome: "startFailed" });
    expect(holds.adapterHeld(CLAUDE_CLI_ADAPTER_ID)).toMatchObject({
      check: "credential-check",
      key: "gh-token",
    });
    expect(fake.calls.some((call) => call.cmd.includes("-p"))).toBe(false);
  });

  it("holds the adapter when the check cannot run or the program is missing", async () => {
    for (const code of [
      "startFailed",
      127,
      126,
      { wrapperExit: 125 },
      { wrapperExit: 1 },
      { wrapperExit: 2 },
    ] as const) {
      const { result, holds } = await runCredentials(code);
      expect(result.ok).toBe(false);
      expect(holds.adapterHeld(CLAUDE_CLI_ADAPTER_ID)?.check).toBe("credential-check");
    }
  });
});

/** A fake of the daemon's Safe-Chain proxies (DIPO-84) that records its calls. */
function proxies(start: "ok" | "fail") {
  const calls: string[] = [];
  return {
    calls,
    start: async (runId: string, caFile: string) => {
      calls.push(`start ${runId} ${caFile}`);
      if (start === "fail") return { ok: false as const, reason: "the proxy check failed" };
      const proxy = {
        port: 50123,
        dir: "/private/tmp/dipo-p/abc123",
        exited: new Promise<void>(() => {}),
        stop: async () => {},
      };
      return { ok: true as const, proxy };
    },
    stop: async (runId: string) => {
      calls.push(`stop ${runId}`);
    },
    awaitHost: (runId: string) => {
      calls.push(`awaitHost ${runId}`);
    },
  };
}

/** Launch check deps whose self-test leaves `results`, with the given proxies. */
function proxyDeps(
  clock: ManualClock,
  fs: MemoryFs,
  results: string,
  safeChainProxies?: ReturnType<typeof proxies>,
) {
  const layout = selfTestLayout({ ...LAYOUT_PATHS, safeChainInstall: true });
  return {
    spawn: scriptedClaude(clock, {
      session: selfTestSession([layout.command]),
      onSession: () => {
        fs.files.set(layout.resultsFile, results);
        fs.files.set(layout.controlFile, "");
      },
    }).spawn,
    clock,
    selfTestSessionId: SELF_TEST_SESSION,
    platform: "darwin" as const,
    runStep: credentialSteps().runStep,
    uid: 501,
    allowProjectSettings: [],
    readText: async () => undefined,
    fs,
    ...(safeChainProxies === undefined ? {} : { safeChainProxies }),
  };
}

describe("(engine) Safe-Chain proxy at launch (DIPO-84)", () => {
  const safeChain = {
    root: "/home/maintainer/.safe-chain",
    shell: "/bin/zsh",
    path: "/usr/bin:/bin",
    demoted: [],
    dropped: [],
    probe: "bun",
    shellDir: `${RUN_DIR}/safe-chain`,
  };
  const INSTALL_OK = `${BLOCKED_RESULTS}safe-chain-install exit 0\nsafe-chain-blocked exit 1\n`;

  it("starts the run's proxy, plans with its port and keeps it for the host", async () => {
    const { clock, holds } = setup();
    const fake = proxies("ok");
    const result = await prepareLaunch(
      spec(),
      context({ safeChain }),
      holds,
      proxyDeps(clock, new MemoryFs(), INSTALL_OK, fake),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const settings = JSON.parse(
      result.plan.files.find((f) => f.name === "claude-settings.json")?.content ?? "{}",
    );
    expect(settings.sandbox.network).toEqual({
      allowedDomains: [],
      strictAllowlist: true,
      allowLocalBinding: false,
      httpProxyPort: 50123,
    });
    // The parent of every proxy directory.
    expect(settings.sandbox.filesystem.denyRead).toContain("/private/tmp/dipo-p");
    expect(fake.calls).toEqual([
      `start run-0001 ${RUN_DIR}/safe-chain/ca.pem`,
      "awaitHost run-0001",
    ]);
  });

  it("refuses the launch with a hold when the proxy cannot run, before any session", async () => {
    const { clock, holds } = setup();
    const fake = proxies("fail");
    const spawned: string[] = [];
    const base = proxyDeps(clock, new MemoryFs(), INSTALL_OK, fake);
    const result = await prepareLaunch(spec(), context({ safeChain }), holds, {
      ...base,
      spawn: (options) => {
        spawned.push(options.cmd.join(" "));
        return base.spawn(options);
      },
    });
    expect(result).toMatchObject({ ok: false, outcome: "startFailed" });
    const hold = holds.adapterHeld(CLAUDE_CLI_ADAPTER_ID);
    expect(hold).toMatchObject({ check: "safe-chain", key: "proxy" });
    expect(hold?.detail).toContain("the proxy check failed");
    expect(hold?.detail).toContain("the run is refused");
    expect(spawned).toEqual([]);
    expect(fake.calls).toEqual([`start run-0001 ${RUN_DIR}/safe-chain/ca.pem`, "stop run-0001"]);

    // A dipo without proxies refuses the same way.
    const none = await prepareLaunch(
      spec(),
      context({ safeChain }),
      holds,
      proxyDeps(clock, new MemoryFs(), INSTALL_OK),
    );
    expect(none).toMatchObject({ ok: false, outcome: "startFailed" });
    expect(holds.adapterHeld(CLAUDE_CLI_ADAPTER_ID)?.detail).toContain("no Safe-Chain proxy");
  });

  it("stops the proxy when a later check refuses the launch", async () => {
    const { clock, holds } = setup();
    const fake = proxies("ok");
    const failedInstall = `${BLOCKED_RESULTS}safe-chain-install exit 1\nsafe-chain-blocked exit 1\n`;
    const result = await prepareLaunch(
      spec(),
      context({ safeChain }),
      holds,
      proxyDeps(clock, new MemoryFs(), failedInstall, fake),
    );
    expect(result).toMatchObject({ ok: false, outcome: "startFailed" });
    expect(holds.adapterHeld(CLAUDE_CLI_ADAPTER_ID)).toMatchObject({
      check: "self-test",
      key: "safe-chain",
    });
    expect(fake.calls.at(-1)).toBe("stop run-0001");
  });
});
