// The launch checks and the adapter hold (DIPO-43 AC #5 to #7, 0008 sections 2 and 7): a refusal
// is `startFailed`, holds the adapter for every office and emits an `engine.notice`; a later pass
// lifts it; the checks run before a launch and before a resume. An npm auth key the sandbox can
// read refuses one run without a hold (DIPO-172).

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Event, Spawn } from "@dipsaus-orchestrator/contract";
import { type FakeProcess, ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { OFFICE_DEFAULTS } from "../../src/config";
import { SoftwareStream } from "../../src/software-stream/stream";
import { prepareLaunch } from "../../src/workers/claude-cli/launch-checks";
import { CLAUDE_CLI_ADAPTER_ID } from "../../src/workers/claude-cli/plan";
import { REVIEW_PROBES, selfTestLayout } from "../../src/workers/claude-cli/self-test";
import {
  AdapterHolds,
  gateLaunch,
  HOLD_NOTICE_CODE,
  RELEASE_NOTICE_CODE,
} from "../../src/workers/hold";
import { PlanError } from "../../src/workers/types";
import {
  ADMIN_DIR,
  BLOCKED_RESULTS,
  context,
  HOME,
  MAIN,
  MemoryFs,
  REVIEW_BLOCKED_RESULTS,
  reviewSpec,
  RUN_DIR,
  scriptedClaude,
  credentialSteps,
  SELF_TEST_SESSION,
  selfTestSession,
  SHORT_TMP_DIR,
  spec,
  TMP_DIR,
  TOOLS,
  withInitPlugins,
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

describe("(engine) the review kind's launch checks (DIPO-145, 0019 section 4)", () => {
  const REVIEW_LAYOUT = selfTestLayout({ ...LAYOUT_PATHS, review: true }, REVIEW_PROBES);

  function reviewDeps(clock: ManualClock, fs: MemoryFs, results: string) {
    const fake = scriptedClaude(clock, {
      session: selfTestSession([REVIEW_LAYOUT.command]),
      onSession: () => {
        fs.files.set(REVIEW_LAYOUT.resultsFile, results);
        fs.files.set(REVIEW_LAYOUT.controlFile, "");
      },
    });
    return {
      fake,
      deps: {
        spawn: fake.spawn,
        clock,
        selfTestSessionId: SELF_TEST_SESSION,
        platform: "darwin" as const,
        runStep: credentialSteps().runStep,
        uid: 501,
        allowProjectSettings: [],
        readText: async () => undefined,
        fs,
      },
    };
  }

  it("runs probe, credential check and the review self-test, and returns the review plan", async () => {
    const { clock, holds } = setup();
    const { fake, deps } = reviewDeps(clock, new MemoryFs(), REVIEW_BLOCKED_RESULTS);
    const result = await prepareLaunch(reviewSpec(), context(), holds, deps);
    if (!result.ok) throw new Error(`refused: ${JSON.stringify(result)}`);
    expect(result.plan.argv[result.plan.argv.indexOf("--tools") + 1]).toBe("Read,Glob,Grep,Bash");
    expect(fake.calls.map((call) => call.cmd[1])).toEqual(["--version", "auth", "-p"]);
    expect(holds.adapterHeld(CLAUDE_CLI_ADAPTER_ID)).toBeNull();
  });

  it("holds the adapter, as for a worker, when the review self-test's install succeeded", async () => {
    const { clock, holds, notices } = setup();
    const installed = REVIEW_BLOCKED_RESULTS.replace("install exit 1", "install exit 0");
    const { deps } = reviewDeps(clock, new MemoryFs(), installed);
    const result = await prepareLaunch(reviewSpec(), context(), holds, deps);
    expect(result).toMatchObject({ ok: false, outcome: "startFailed" });
    expect(holds.adapterHeld(CLAUDE_CLI_ADAPTER_ID)).toMatchObject({
      check: "self-test",
      key: "install",
    });
    expect(notices.at(-1)?.data).toMatchObject({ level: "error", code: HOLD_NOTICE_CODE });
  });

  it("holds with a reviewer's reason and fix when the review self-test lists a plugin", async () => {
    const { clock, holds } = setup();
    const warp = "warp@claude-code-warp";
    const fs = new MemoryFs();
    const fake = scriptedClaude(clock, {
      session: withInitPlugins(selfTestSession([REVIEW_LAYOUT.command]), [warp]),
      onSession: () => {
        fs.files.set(REVIEW_LAYOUT.resultsFile, REVIEW_BLOCKED_RESULTS);
        fs.files.set(REVIEW_LAYOUT.controlFile, "");
      },
    });
    const { deps } = reviewDeps(clock, fs, REVIEW_BLOCKED_RESULTS);
    // worker.plugins names the plugin, which a reviewer does not load all the same.
    const ctx = context({ plugins: { installed: [warp], allowed: [warp] } });
    const result = await prepareLaunch(reviewSpec(), ctx, holds, { ...deps, spawn: fake.spawn });
    expect(result).toMatchObject({ ok: false, outcome: "startFailed" });
    expect(holds.adapterHeld(CLAUDE_CLI_ADAPTER_ID)?.failures[0]).toEqual({
      check: "self-test",
      detail:
        "the sandbox self-test could not run: system/init lists plugin warp@claude-code-warp, but a reviewer session loads no plugin: a plugin's hooks run outside the sandbox, so the session refuses to run (0019 section 4)",
      key: "plugins",
      fix: "Claude Code loaded a plugin the run settings did not switch off. A reviewer session loads no plugins (0019 section 4), so worker.plugins does not apply to it; the plugin comes from the user scope or the project. Remove or disable it for this machine or this project, then start the review again.",
    });
  });

  it("holds the adapter when the worktree took the self-test's write", async () => {
    const { clock, holds } = setup();
    const written = REVIEW_BLOCKED_RESULTS.replace(
      "worktree blocked Operation not permitted",
      "worktree written",
    );
    const { deps } = reviewDeps(clock, new MemoryFs(), written);
    const result = await prepareLaunch(reviewSpec(), context(), holds, deps);
    expect(result).toMatchObject({ ok: false, outcome: "startFailed" });
    expect(holds.adapterHeld(CLAUDE_CLI_ADAPTER_ID)).toMatchObject({ key: "worktree" });
  });

  it("holds on a refused probe before the review self-test runs, as for a worker", async () => {
    const { clock, holds } = setup();
    const fake = scriptedClaude(clock, { auth: '{"loggedIn":true,"authMethod":"api-key"}' });
    const result = await prepareLaunch(reviewSpec(), context(), holds, {
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
    expect(fake.calls.some((call) => call.cmd.includes("-p"))).toBe(false);
  });

  it("starts no Safe-Chain proxy for a review, even with Safe-Chain installed", async () => {
    const { clock, holds } = setup();
    const { deps } = reviewDeps(clock, new MemoryFs(), REVIEW_BLOCKED_RESULTS);
    const started: string[] = [];
    const safeChain = {
      root: `${HOME}/.safe-chain`,
      shell: "/bin/zsh",
      path: "/usr/bin:/bin",
      demoted: [],
      dropped: [],
      probe: "bun",
      shellDir: `${RUN_DIR}/safe-chain`,
    };
    const result = await prepareLaunch(reviewSpec(), context({ safeChain }), holds, {
      ...deps,
      safeChainProxies: {
        start: async (run) => {
          started.push(run);
          return { ok: false, reason: "no proxy in this test" };
        },
        stop: async () => undefined,
        awaitHost: () => undefined,
      },
    });
    expect(result.ok).toBe(true);
    expect(started).toEqual([]);
    expect(result.ok && result.plan.env["CLAUDE_CODE_SHELL"]).toBeUndefined();
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
      allowUnixSockets: [SHORT_TMP_DIR],
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

describe("(engine) plugins in the self-test session (DIPO-108)", () => {
  const WARP = "warp@claude-code-warp";
  const BUILTIN = "cc-plugin-telemetry@builtin";

  function run(listed: readonly string[], allowed: readonly string[]) {
    const { clock, holds, notices } = setup();
    const fs = new MemoryFs();
    const sessions: FakeProcess[] = [];
    const base = scriptedClaude(clock, {
      session: withInitPlugins(selfTestSession([LAYOUT.command]), listed),
      onSession: () => {
        fs.files.set(LAYOUT.resultsFile, BLOCKED_RESULTS);
        fs.files.set(LAYOUT.controlFile, "");
      },
    });
    const spawn: Spawn = (options) => {
      const child = base.spawn(options);
      if (options.cmd.includes("-p")) sessions.push(child as FakeProcess);
      return child;
    };
    const ctx = context({ plugins: { installed: [WARP], allowed } });
    const launch = prepareLaunch(spec(), ctx, holds, {
      spawn,
      clock,
      selfTestSessionId: SELF_TEST_SESSION,
      platform: "darwin",
      runStep: credentialSteps().runStep,
      uid: 501,
      allowProjectSettings: [],
      readText: async () => undefined,
      fs,
    });
    return { launch, holds, notices, sessions };
  }

  it("refuses startFailed, stopping the session at system/init before its Bash call", async () => {
    const { launch, holds, sessions } = run([BUILTIN, WARP], []);
    const refused = await launch;
    expect(refused).toMatchObject({ ok: false, outcome: "startFailed" });
    const hold = holds.adapterHeld(CLAUDE_CLI_ADAPTER_ID);
    expect(hold).toMatchObject({ check: "self-test", key: "plugins" });
    expect(hold?.detail).toContain(`plugin ${WARP}, not in worker.plugins`);
    expect(hold?.failures[0]?.fix).toContain("add it to worker.plugins");
    // Stopped at its init: SIGTERM, and the replay never reached the Bash tool call.
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.signals).toEqual(["SIGTERM"]);
  });

  it("passes when the session lists only builtin or allowed plugins", async () => {
    for (const [listed, allowed] of [
      [[BUILTIN], []],
      [[BUILTIN, WARP], [WARP]],
    ] as const) {
      const { launch, holds, sessions } = run(listed, allowed);
      expect((await launch).ok).toBe(true);
      expect(holds.adapterHeld(CLAUDE_CLI_ADAPTER_ID)).toBeNull();
      expect(sessions[0]?.signals).toEqual([]);
    }
  });

  it("writes the switch-off into the settings file the self-test runs under", async () => {
    const { launch, sessions } = run([BUILTIN], []);
    const prepared = await launch;
    expect(prepared.ok).toBe(true);
    const settings = prepared.ok
      ? prepared.plan.files.find((file) => file.name === "claude-settings.json")?.content
      : undefined;
    expect(JSON.parse(settings ?? "{}").enabledPlugins).toEqual({ [WARP]: false });
    expect(sessions).toHaveLength(1);
  });
});

// Not a real token; the refusal must never show it.
const NPM_SECRET = "npm_FAKEfakeFAKEfake0123456789";

/** A directory of node installs for `office` under `root`, one install whose etc/npmrc is `npmrc`. */
function nodeInstalls(root: string, office: string, npmrc: string): string {
  const etc = join(root, office, "node", "v22.11.0", "etc");
  mkdirSync(etc, { recursive: true });
  writeFileSync(join(etc, "npmrc"), npmrc);
  return join(root, office, "node");
}

/** The default sandbox with `dir` added to the toolchain read paths. */
function sandboxWith(dir: string) {
  return {
    ...OFFICE_DEFAULTS.sandbox,
    toolchainReadPaths: [...OFFICE_DEFAULTS.sandbox.toolchainReadPaths, dir],
  };
}

describe("(engine) npm auth keys the worker sandbox can read (DIPO-172)", () => {
  it("refuses one office's run naming the file without a hold; another office's run still starts", async () => {
    await withTempDir(async (root) => {
      const withToken = nodeInstalls(root, "a", `//registry.npmjs.org/:_authToken=${NPM_SECRET}\n`);
      const clean = nodeInstalls(root, "b", "registry=https://registry.npmjs.org/\n");
      const { clock, holds, notices } = setup();
      const deps = (fs: MemoryFs) => {
        const fake = claudeWith(clock, fs, BLOCKED_RESULTS);
        return {
          fake,
          deps: {
            spawn: fake.spawn,
            clock,
            selfTestSessionId: SELF_TEST_SESSION,
            platform: "darwin" as const,
            runStep: credentialSteps().runStep,
            uid: 501,
            allowProjectSettings: [],
            readText: async () => undefined,
            fs,
          },
        };
      };

      const a = deps(new MemoryFs());
      const refused = await prepareLaunch(
        spec(),
        context({ sandbox: sandboxWith(withToken) }),
        holds,
        a.deps,
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(PlanError);
      const message = (refused as PlanError).message;
      expect(message).toContain(join(withToken, "v22.11.0", "etc", "npmrc"));
      expect(message).toContain("_authToken");
      expect(message).toContain("~/.npmrc");
      expect(message).not.toContain(NPM_SECRET);
      // Refused before any check: no probe, no session, no hold and no hold notice.
      expect(a.fake.calls).toEqual([]);
      expect(holds.adapterHeld(CLAUDE_CLI_ADAPTER_ID)).toBeNull();
      expect(notices).toEqual([]);

      const b = deps(new MemoryFs());
      const started = await prepareLaunch(
        spec(),
        context({ sandbox: sandboxWith(clean) }),
        holds,
        b.deps,
      );
      expect(started.ok).toBe(true);
      expect(holds.adapterHeld(CLAUDE_CLI_ADAPTER_ID)).toBeNull();
    });
  });
});

describe("(engine) verify tools the worker sandbox cannot start (DIPO-173)", () => {
  it("refuses one office's run without a hold; another office's run, whose verify resolves, starts", async () => {
    await withTempDir(async (home) => {
      const bin = join(home, ".nvm", "versions", "node", "v22.11.0", "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "node"), "", { mode: 0o755 });
      const office = (name: string, scripts: Record<string, string>, tool: boolean) => {
        const root = join(home, name);
        mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
        writeFileSync(join(root, "package.json"), JSON.stringify({ scripts }));
        if (tool) {
          writeFileSync(join(root, "node_modules", ".bin", "oxfmt"), "#!/usr/bin/env node\n", {
            mode: 0o755,
          });
        }
        return root;
      };
      const needsNode = office("a", { verify: "oxfmt --check" }, true);
      const verify = { commands: [["bun", "run", "verify"]], cwd: "." };
      const ctx = context({ home, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home } });
      const { clock, holds, notices } = setup();
      const fs = new MemoryFs();
      const fake = claudeWith(clock, fs, BLOCKED_RESULTS);
      const deps = {
        spawn: fake.spawn,
        clock,
        selfTestSessionId: SELF_TEST_SESSION,
        platform: "darwin" as const,
        runStep: credentialSteps().runStep,
        uid: 501,
        allowProjectSettings: [],
        readText: async () => undefined,
        fs,
      };

      const refused = await prepareLaunch(
        { ...spec(), workdir: needsNode },
        ctx,
        holds,
        deps,
        verify,
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(PlanError);
      expect((refused as PlanError).message).toContain("sandbox.toolchainReadPaths");
      expect(fake.calls).toEqual([]);
      expect(holds.adapterHeld(CLAUDE_CLI_ADAPTER_ID)).toBeNull();
      expect(notices).toEqual([]);

      // The self-test's layout is that of the fixture worktree, so the second office's checkout
      // is the fixture one: verify runs no program from node_modules/.bin there.
      const started = await prepareLaunch(spec(), ctx, holds, deps, verify);
      expect(started.ok).toBe(true);
      expect(holds.adapterHeld(CLAUDE_CLI_ADAPTER_ID)).toBeNull();
    });
  });
});
