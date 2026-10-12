// The sandbox self-test (DIPO-43 AC #4 and #8, 0008 section 2): the probe command, the verdict
// from session and disk, trusted tool resolution, a full run through a replayed session and an
// in-memory disk, and the three live safety recordings replayed once the maintainer captured them.

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { ManualClock } from "@dipsaus-orchestrator/testkit";

import { plan, SETTINGS_FILE } from "../../src/workers/claude-cli/plan";
import {
  bashCalls,
  judgeSelfTest,
  parsePointer,
  parseResults,
  PROBE_GROUPS,
  resolveSelfTestTools,
  runSelfTest,
  SELF_TEST_MODEL,
  probesFor,
  selfTestFailure,
  selfTestLayout,
  workerWritableRoots,
  type ProbeName,
  type SelfTestBashCalls,
  type SelfTestDisk,
  type SelfTestEvidence,
  type SelfTestFs,
  type WriteProbe,
} from "../../src/workers/claude-cli/self-test";
import {
  ADMIN_DIR,
  BLOCKED_RESULTS,
  context,
  HOME,
  MAIN,
  MemoryFs,
  POINTER,
  RUN_DIR,
  scriptedClaude,
  SELF_TEST_SESSION,
  selfTestSession,
  spec,
  TMP_DIR,
  TOOLS,
  WORKDIR,
} from "./launch-fixtures";
import { loadRecording, RECORDINGS_DIR, replay } from "./replay";

const PATHS = {
  main: MAIN,
  workdir: WORKDIR,
  adminDir: ADMIN_DIR,
  tmpDir: TMP_DIR,
  nonce: "n1",
  tools: TOOLS,
};
const NONCE = SELF_TEST_SESSION.replaceAll("-", "").slice(0, 16);
const RUN_LAYOUT = selfTestLayout({ ...PATHS, nonce: NONCE });
const REFUSED = {
  "gh-token": { exit: 1, stderr: "other" },
  keychain: { exit: 44, stderr: "denied" },
} as const;

/** One assistant stream line with a Bash tool use. */
function bashLine(id: string, command: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
  });
}

function evidence(disk: Partial<SelfTestDisk>, more: Partial<SelfTestEvidence> = {}) {
  return {
    probes: selfTestLayout(PATHS).probes,
    outcome: "done" as const,
    denied: [],
    bash: { calls: 1, exact: true, shape: true },
    disk: {
      results: BLOCKED_RESULTS,
      written: [],
      pointerChanged: false,
      controlWritten: true,
      ...disk,
    },
    ...more,
  };
}

describe("(unit) self-test layout", () => {
  it("probes <main>/.git, the admin dir, refs, objects, the pointer and gh, with a control write", () => {
    const layout = selfTestLayout(PATHS);
    expect(layout.targets.map((target) => [target.name, target.mode, target.path])).toEqual([
      ["control", ">", `${WORKDIR}/.dipo-self-test-n1`],
      ["main-git", ">", `${MAIN}/.git/dipo-self-test-n1`],
      ["worktree-admin", ">", `${ADMIN_DIR}/dipo-self-test-n1`],
      ["refs", ">", `${MAIN}/.git/refs/heads/dipo-self-test-n1`],
      ["objects", ">", `${MAIN}/.git/objects/dipo-self-test-n1`],
      ["pointer", ">>", `${WORKDIR}/.git`],
    ]);
    expect(layout.resultsFile).toBe(`${TMP_DIR}/dipo-self-test-n1.txt`);
    // Absolute perl on a script under <main>/.git/dipo (readable, never writable in the sandbox),
    // so neither `Bash(gh *)` nor redirection rules stop it first, and gh by path.
    expect(layout.command.startsWith(`'${TOOLS.perl}' -e '${layout.script}' `)).toBe(true);
    expect(layout.script).toContain("exec { $p } $p, @{ $exec{$n} };");
    expect(layout.script).toContain('"find-generic-password", "-s", "gh:github.com"');
    expect(layout.script).toContain('open(STDOUT, ">", "/dev/null")');
    expect(layout.command).toEndWith(
      `'gh-token' '-' '${TOOLS.gh}' 'keychain' '-' '/usr/bin/security'`,
    );
    expect(layout.prompt).toContain(layout.command);
  });

  it("builds one probe group per safety recording", () => {
    const gh = selfTestLayout(PATHS, PROBE_GROUPS["safety-gh-token"]);
    expect(gh.targets.map((target) => target.name)).toEqual(["control"]);
    const pointer = selfTestLayout(PATHS, PROBE_GROUPS["safety-pointer-write"]);
    expect(pointer.targets.map((target) => target.name)).toEqual(["control", "pointer"]);
    expect(pointer.command).not.toContain("'gh-token'");
    // A write-only self-test carries no credential code at all.
    expect(pointer.script).not.toContain("gh");
    expect(pointer.script).not.toContain("find-generic-password");
    expect(gh.script).toContain('"gh-token" => ["auth", "token"]');
  });

  it("writes the nonce byte, appends it to the pointer, and probes the Keychain on macOS only", () => {
    const layout = selfTestLayout(PATHS);
    expect(layout.byte).toBe("n");
    expect(layout.command).toContain(`'${TMP_DIR}/dipo-self-test-n1.txt' 'n' 'control'`);
    expect(layout.script).toContain("print $f $b");
    expect(probesFor("darwin")).toContain("keychain");
    expect(probesFor("linux")).not.toContain("keychain");
    expect(probesFor("linux", PROBE_GROUPS["safety-gh-token"])).toEqual(["gh-token"]);
    const linux = selfTestLayout(PATHS, probesFor("linux"));
    expect(linux.command).not.toContain("/usr/bin/security");
  });

  it("refuses a path it cannot quote", () => {
    expect(() => selfTestLayout({ ...PATHS, workdir: "/w/it's" })).toThrow("cannot quote");
  });

  it("parses the results file and the worktree pointer", () => {
    const lines = parseResults(BLOCKED_RESULTS);
    expect(lines.get("control")).toEqual({ kind: "write", written: true, detail: "" });
    expect(lines.get("refs")).toEqual({
      kind: "write",
      written: false,
      detail: "Operation not permitted",
    });
    expect(lines.get("gh-token")).toEqual({ kind: "exit", code: 1, stderr: "other" });
    expect(parsePointer(POINTER, WORKDIR)).toBe(ADMIN_DIR);
    expect(parsePointer("gitdir: ../shop/.git/worktrees/x\n", "/a/wt")).toBe(
      "/a/shop/.git/worktrees/x",
    );
    expect(parsePointer("nonsense", WORKDIR)).toBeNull();
  });

  it("counts Bash calls by tool use id and compares the one command exactly", () => {
    const planned = "perl -e 1";
    expect(bashCalls(`${bashLine("t1", planned)}\n`, planned)).toEqual({
      calls: 1,
      exact: true,
      shape: true,
    });
    // The same message repeated (a stream re-emit) still counts once.
    expect(
      bashCalls(`${bashLine("t1", planned)}\n${bashLine("t1", planned)}\n`, planned).calls,
    ).toBe(1);
    expect(bashCalls(`${bashLine("t1", `${planned} `)}\n`, planned)).toEqual({
      calls: 1,
      exact: false,
      shape: true,
    });
    expect(bashCalls(`${bashLine("t1", planned)}\n${bashLine("t2", "ls")}\n`, planned)).toEqual({
      calls: 2,
      exact: false,
      shape: false,
    });
    const shaped = (input: Record<string, unknown>) =>
      bashCalls(
        `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input }] } })}\n`,
        planned,
      );
    expect(shaped({ command: planned, description: "d", timeout: 1000 }).shape).toBe(true);
    expect(shaped({ command: planned, run_in_background: false }).shape).toBe(true);
    expect(shaped({ command: planned, run_in_background: true }).shape).toBe(false);
    expect(shaped({ command: planned, dangerouslyDisableSandbox: true }).shape).toBe(false);
    expect(bashCalls("", planned)).toEqual({ calls: 0, exact: false, shape: false });
  });
});

describe("(unit) self-test verdict", () => {
  it("passes when every forbidden write is blocked, gh fails and the control write succeeds", () => {
    expect(judgeSelfTest(evidence({}))).toEqual({ ok: true, refused: REFUSED });
  });

  it.each(["main-git", "worktree-admin", "refs", "objects", "pointer"] as WriteProbe[])(
    "refuses as unsafe when %s was written",
    (probe) => {
      const results = BLOCKED_RESULTS.replace(
        new RegExp(`^${probe} blocked.*$`, "m"),
        `${probe} written`,
      );
      expect(judgeSelfTest(evidence({ results }))).toMatchObject({
        ok: false,
        unsafe: true,
        probe,
      });
    },
  );

  it("refuses as unsafe when a forbidden file exists on disk, whatever the results say", () => {
    const verdict = judgeSelfTest(evidence({ written: ["refs"] }));
    expect(verdict).toMatchObject({ ok: false, unsafe: true, probe: "refs" });
    expect(judgeSelfTest(evidence({ pointerChanged: true }))).toMatchObject({
      unsafe: true,
      probe: "pointer",
    });
  });

  it("refuses as unsafe when gh auth token exits 0 inside the sandbox", () => {
    const results = BLOCKED_RESULTS.replace("gh-token exit 1", "gh-token exit 0");
    const verdict = judgeSelfTest(evidence({ results }));
    expect(verdict).toMatchObject({ ok: false, unsafe: true, probe: "gh-token" });
  });

  it("refuses when gh never ran inside the sandbox (126 or 127): the Keychain was not tested", () => {
    for (const code of [126, 127]) {
      const results = BLOCKED_RESULTS.replace("gh-token exit 1", `gh-token exit ${code}`);
      const verdict = judgeSelfTest(evidence({ results }));
      expect(verdict).toMatchObject({ ok: false, unsafe: false, probe: "gh-token" });
      expect(!verdict.ok && verdict.reason).toContain("Keychain token was not tested");
    }
  });

  it("refuses when the session made no Bash call, extra calls or a different command", () => {
    const cases: [SelfTestBashCalls, string][] = [
      [{ calls: 0, exact: false, shape: false }, "0 Bash calls"],
      [{ calls: 2, exact: false, shape: false }, "2 Bash calls"],
      [{ calls: 1, exact: false, shape: true }, "not the planned command"],
      [{ calls: 1, exact: true, shape: false }, "ran in the background"],
    ];
    for (const [bash, text] of cases) {
      const verdict = judgeSelfTest(evidence({}, { bash }));
      expect(verdict).toMatchObject({ ok: false, unsafe: false });
      expect(!verdict.ok && verdict.reason).toContain(text);
    }
  });

  it("refuses as unsafe when the Keychain item is readable inside the sandbox", () => {
    const results = BLOCKED_RESULTS.replace("keychain exit 44 denied", "keychain exit 0 none");
    expect(judgeSelfTest(evidence({ results }))).toMatchObject({
      ok: false,
      unsafe: true,
      probe: "keychain",
    });
  });

  it("refuses when security never ran inside the sandbox", () => {
    const results = BLOCKED_RESULTS.replace("keychain exit 44 denied", "keychain exit 127 none");
    expect(judgeSelfTest(evidence({ results }))).toMatchObject({
      ok: false,
      unsafe: false,
      probe: "keychain",
    });
  });

  it("refuses when the self-test cannot run", () => {
    const cases: [Partial<SelfTestDisk>, Partial<SelfTestEvidence>, string][] = [
      [{ results: null }, {}, "did not run"],
      [{ results: null }, { denied: ["Bash"] }, "denied Bash"],
      [{}, { outcome: "startFailed", outcomeDetail: "sandbox unavailable" }, "sandbox unavailable"],
      [{}, { outcome: "initRejected", outcomeDetail: "apiKeySource is user" }, "apiKeySource"],
      [{}, { outcome: "crashed" }, "crashed"],
      [{ results: "control written\n" }, {}, "no result"],
      [{ controlWritten: false }, {}, "control write"],
      [
        { results: BLOCKED_RESULTS.replace("control written", "control blocked No space") },
        {},
        "control write",
      ],
    ];
    for (const [disk, more, text] of cases) {
      const verdict = judgeSelfTest(evidence(disk, more));
      expect(verdict.ok).toBe(false);
      expect(!verdict.ok && verdict.unsafe).toBe(false);
      expect(!verdict.ok && verdict.reason).toContain(text);
    }
  });
});

describe("(unit) trusted perl and gh", () => {
  const writable = workerWritableRoots(WORKDIR, TMP_DIR, HOME);
  const resolveWith = (fs: SelfTestFs, daemonPath: string, workerPath = daemonPath) =>
    resolveSelfTestTools({ daemonPath, workerPath, writable }, fs);

  it("resolves both to absolute paths from the daemon's PATH, symlinks resolved", async () => {
    const fs = new MemoryFs();
    fs.links.set(TOOLS.gh, "/opt/gh/bin/gh");
    expect(await resolveWith(fs, "/usr/bin:/bin")).toEqual({
      ok: true,
      tools: { perl: TOOLS.perl, gh: "/opt/gh/bin/gh" },
    });
  });

  it("refuses a tool missing from the PATH or lying where a worker can write", async () => {
    const missing = new MemoryFs();
    missing.executables.delete(TOOLS.gh);
    expect(await resolveWith(missing, "/usr/bin")).toMatchObject({ ok: false });

    const planted = new MemoryFs();
    planted.executables.add(`${WORKDIR}/bin/perl`);
    const inWorktree = await resolveWith(planted, `${WORKDIR}/bin:/usr/bin`, "/usr/bin");
    expect(inWorktree).toMatchObject({ ok: false });
    expect(!inWorktree.ok && inWorktree.reason).toContain("perl");

    const linked = new MemoryFs();
    linked.links.set(TOOLS.gh, `${TMP_DIR}/gh`);
    expect(await resolveWith(linked, "/usr/bin")).toMatchObject({ ok: false });
  });

  it("refuses a worker PATH with an empty, relative, worktree or temp entry", async () => {
    for (const path of [
      "/usr/bin::/bin",
      "bin:/usr/bin",
      `/usr/bin:${WORKDIR}/node_modules/.bin`,
      `${TMP_DIR}:/usr/bin`,
    ]) {
      const result = await resolveWith(new MemoryFs(), "/usr/bin", path);
      expect(result).toMatchObject({ ok: false });
      expect(!result.ok && result.reason).toContain("worker's PATH");
    }
  });
});

/** The self-test run, with the session replayed and the disk in memory. */
async function runWith(
  results: string | null,
  options: {
    commands?: readonly string[];
    extra?: (fs: MemoryFs) => void;
    fs?: MemoryFs;
    sessionId?: string;
  } = {},
) {
  const clock = new ManualClock();
  const fs = options.fs ?? new MemoryFs();
  const fake = scriptedClaude(clock, {
    session: selfTestSession(options.commands ?? [RUN_LAYOUT.command]),
    onSession: () => {
      // What the sandboxed command leaves behind.
      if (results !== null) fs.files.set(RUN_LAYOUT.resultsFile, results);
      fs.files.set(RUN_LAYOUT.controlFile, "");
      options.extra?.(fs);
    },
  });
  const runSpec = spec();
  const runSettings = plan(runSpec, context()).files.find((f) => f.name === SETTINGS_FILE);
  const report = await runSelfTest(
    { spec: runSpec, ctx: context(), runSettings: runSettings?.content ?? "" },
    {
      spawn: fake.spawn,
      clock,
      fs,
      sessionId: options.sessionId ?? SELF_TEST_SESSION,
      platform: "darwin",
    },
  );
  return { report, fs, fake, runSettings: runSettings?.content ?? "" };
}

describe("(engine) self-test run", () => {
  it("runs one Claude session under the run's own settings file and passes on a blocked disk", async () => {
    const { report, fs, fake, runSettings } = await runWith(BLOCKED_RESULTS);
    expect(report.verdict).toEqual({ ok: true, refused: REFUSED });
    expect(report.evidence?.bash).toEqual({ calls: 1, exact: true, shape: true });
    const session = fake.calls.find((call) => call.cmd.includes("-p"));
    expect(session?.cmd).toContain("--settings");
    expect(session?.cmd).toContain(`${RUN_DIR}/self-test/${SETTINGS_FILE}`);
    expect(session?.cmd).toContain(SELF_TEST_SESSION);
    expect(session?.cmd[session.cmd.indexOf("--model") + 1]).toBe(SELF_TEST_MODEL);
    expect(session?.cmd[session.cmd.indexOf("--tools") + 1]).toBe("Bash");
    expect(session?.cwd).toBe(WORKDIR);
    expect(fs.files.get(`${RUN_DIR}/self-test/${SETTINGS_FILE}`)).toBe(runSettings);
    // Everything it made is gone; the pointer is untouched.
    expect(fs.files.has(RUN_LAYOUT.resultsFile)).toBe(false);
    expect(fs.files.has(RUN_LAYOUT.controlFile)).toBe(false);
    expect(fs.files.get(`${WORKDIR}/.git`)).toBe(POINTER);
    expect(report.plugins).toBe(3);
  });

  it("refuses when the session ran another command, more calls, or none", async () => {
    for (const commands of [["ls"], [RUN_LAYOUT.command, "ls"], []]) {
      const { report } = await runWith(BLOCKED_RESULTS, { commands });
      expect(report.verdict).toMatchObject({ ok: false, unsafe: false });
    }
  });

  it("refuses and cleans up when a forbidden file was written", async () => {
    const refs = `${MAIN}/.git/refs/heads/dipo-self-test-${NONCE}`;
    const { report, fs } = await runWith(BLOCKED_RESULTS, {
      extra: (disk) => disk.files.set(refs, ""),
    });
    expect(report.verdict).toMatchObject({ ok: false, unsafe: true, probe: "refs" });
    expect(fs.files.has(refs)).toBe(false);
    expect(selfTestFailure(report)).toMatchObject({ check: "self-test", key: "refs", file: refs });
  });

  it("removes the control file and anything that got through even when a disk read throws", async () => {
    const refs = `${MAIN}/.git/refs/heads/dipo-self-test-${NONCE}`;
    class ThrowingFs extends MemoryFs {
      override async exists(path: string): Promise<boolean> {
        if (path === refs) throw new Error("disk read failed");
        return super.exists(path);
      }
    }
    const fs = new ThrowingFs();
    await expect(
      runWith(BLOCKED_RESULTS, { fs, extra: (disk) => disk.files.set(refs, "") }),
    ).rejects.toThrow("disk read failed");
    expect(fs.files.has(refs)).toBe(false);
    expect(fs.files.has(RUN_LAYOUT.controlFile)).toBe(false);
    expect(fs.files.has(RUN_LAYOUT.resultsFile)).toBe(false);
  });

  it("restores the pointer from its saved copy when a write got through", async () => {
    const { report, fs } = await runWith(BLOCKED_RESULTS, {
      extra: (disk) => disk.files.set(`${WORKDIR}/.git`, `${POINTER}${NONCE.slice(0, 1)}`),
    });
    expect(report.verdict).toMatchObject({ ok: false, unsafe: true, probe: "pointer" });
    expect(fs.files.get(`${WORKDIR}/.git`)).toBe(POINTER);
  });

  it("derives the nonce from the lower-cased session id", async () => {
    const { report } = await runWith(BLOCKED_RESULTS, {
      sessionId: SELF_TEST_SESSION.toUpperCase(),
    });
    expect(report.verdict).toEqual({ ok: true, refused: REFUSED });
  });

  it("refuses before any session when the pointer is not exactly one gitdir line", async () => {
    for (const pointer of [`${POINTER}c`, `${POINTER}gitdir: /x\n`, POINTER.trimEnd(), ""]) {
      const clock = new ManualClock();
      const fake = scriptedClaude(clock, {});
      const report = await runSelfTest(
        { spec: spec(), ctx: context(), runSettings: "{}" },
        { spawn: fake.spawn, clock, fs: new MemoryFs(pointer), sessionId: SELF_TEST_SESSION },
      );
      expect(report.verdict).toMatchObject({ ok: false, unsafe: false });
      expect(!report.verdict.ok && report.verdict.reason).toContain("exactly one");
      expect(fake.calls).toEqual([]);
    }
  });

  it("refuses when the command never wrote its results", async () => {
    const { report } = await runWith(null);
    expect(report.verdict).toMatchObject({ ok: false, unsafe: false });
  });

  it("refuses before any session when perl or gh cannot be trusted", async () => {
    const clock = new ManualClock();
    const fs = new MemoryFs();
    fs.links.set(TOOLS.perl, `${WORKDIR}/perl`);
    const fake = scriptedClaude(clock, {});
    const report = await runSelfTest(
      { spec: spec(), ctx: context(), runSettings: "{}" },
      { spawn: fake.spawn, clock, fs, sessionId: SELF_TEST_SESSION, platform: "darwin" },
    );
    expect(report.verdict).toMatchObject({ ok: false, unsafe: false });
    expect(fake.calls).toEqual([]);
  });

  it("refuses when the worktree pointer names a gitdir outside <main>/.git/worktrees", async () => {
    const clock = new ManualClock();
    const fs = new MemoryFs("gitdir: /tmp/evil/.git\n");
    const fake = scriptedClaude(clock, {});
    const report = await runSelfTest(
      { spec: spec(), ctx: context(), runSettings: "{}" },
      { spawn: fake.spawn, clock, fs, sessionId: SELF_TEST_SESSION, platform: "darwin" },
    );
    expect(report.verdict).toMatchObject({ ok: false, unsafe: true, probe: "pointer" });
    expect(selfTestFailure(report)?.file).toBe(`${WORKDIR}/.git`);
    expect(fake.calls).toEqual([]);
  });
});

// The live recordings of AC #8. The maintainer captures them on the branch with
// `bun run recordings:capture <name>`; until a recording is committed its test is skipped.
// Recordings redact tool inputs, so the exact-command check comes from the capture's checks.
describe("(unit) live safety recordings", () => {
  for (const [name, probes] of Object.entries(PROBE_GROUPS)) {
    const present = existsSync(join(RECORDINGS_DIR, name, "meta.json"));
    it.skipIf(!present)(`${name}: the session ran and the sandbox refused the probe`, async () => {
      const recording = loadRecording(name);
      const checks = recording.meta["checks"] as {
        disk: SelfTestDisk;
        bash: SelfTestBashCalls;
        probes: ProbeName[];
        verdict: unknown;
      };
      const run = await replay(recording);
      const denied = run.events.flatMap((event) => (event.t === "denied" ? [event.tool] : []));
      // The probes the capture ran: the Keychain probe only where it was captured on macOS.
      expect(checks.probes.filter((probe) => probe !== "keychain")).toEqual(
        probes.filter((probe) => probe !== "keychain"),
      );
      const verdict = judgeSelfTest({
        probes: checks.probes,
        outcome: run.result.outcome,
        denied,
        bash: checks.bash,
        disk: checks.disk,
      });
      expect(verdict.ok).toBe(true);
      expect(checks.verdict).toEqual(verdict);
    });
  }
});
