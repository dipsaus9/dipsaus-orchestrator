// The sandbox self-test (DIPO-43 AC #4 and #8, 0008 section 2): the probe command, the verdict
// from session and disk, trusted tool resolution, a full run through a replayed session and an
// in-memory disk, and the three live safety recordings replayed once the maintainer captured them.

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { hostSocketPath } from "../../src/host/protocol";
import { relayHookPayload } from "../../src/host/relay";
import { systemClock } from "../../src/platform/clock";
import { plan, SETTINGS_FILE } from "../../src/workers/claude-cli/plan";
import {
  APPROVAL_COMMAND,
  approvalFacts,
  bashCalls,
  judgeSelfTest,
  parsePointer,
  parseResults,
  PROBE_GROUPS,
  resolveSelfTestTools,
  REVIEW_PROBES,
  runSelfTest,
  SELF_TEST_BASH_CALLS,
  SELF_TEST_DENY_REASON,
  SELF_TEST_MODEL,
  selfTestSocketPath,
  startHostStandIn,
  selfTestFailure,
  selfTestLayout,
  workerWritableRoots,
  type ProbeName,
  type SelfTestApproval,
  type SelfTestBashCalls,
  type SelfTestDisk,
  type SelfTestEvidence,
  type SelfTestFs,
  type WriteProbe,
} from "../../src/workers/claude-cli/self-test";
import {
  ADMIN_DIR,
  BLOCKED_RESULTS,
  CLI_NO_APPROVAL_TEXT,
  context,
  fakeStandIn,
  type FakeStandIn,
  HOME,
  MAIN,
  MemoryFs,
  POINTER,
  reachedStandIn,
  REVIEW_BLOCKED_RESULTS,
  reviewSpec,
  RUN_DIR,
  scriptedClaude,
  SELF_TEST_SESSION,
  selfTestSession,
  type SelfTestSessionOptions,
  SHORT_TMP_DIR,
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
  home: HOME,
};
const NONCE = SELF_TEST_SESSION.replaceAll("-", "").slice(0, 16);
const RUN_LAYOUT = selfTestLayout({ ...PATHS, nonce: NONCE });

/** One assistant stream line with a Bash tool use. */
function bashLine(id: string, command: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
  });
}

/** One user stream line with the tool result of the call `t2`. */
function toolResult(content: unknown): string {
  return `${JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t2", content, is_error: true }] },
  })}\n`;
}

function evidence(disk: Partial<SelfTestDisk>, more: Partial<SelfTestEvidence> = {}) {
  return {
    probes: selfTestLayout(PATHS).probes,
    outcome: "done" as const,
    denied: [],
    bash: {
      calls: 2,
      exact: true,
      shape: true,
      commands: [selfTestLayout(PATHS).command, APPROVAL_COMMAND],
    },
    approval: { result: SELF_TEST_DENY_REASON, cliDenied: false, reached: true },
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
      ["npm-logs", ">", `${HOME}/.npm/_logs/dipo-self-test-n1`],
    ]);
    expect(layout.resultsFile).toBe(`${TMP_DIR}/dipo-self-test-n1.txt`);
    // Absolute perl with the program inline, so no redirection rule stops it first.
    expect(layout.command.startsWith(`'${TOOLS.perl}' -e '${layout.script}' `)).toBe(true);
    // No credential probe runs in the session (0008 amendment of 2026-10-13).
    expect(layout.script).not.toContain("auth");
    expect(layout.script).not.toContain("find-generic-password");
    expect(layout.script).not.toContain("opendir");
    expect(layout.command).not.toContain("Keychains");
    expect(layout.command).toContain(`'pointer' '>>' '${WORKDIR}/.git'`);
    expect(layout.prompt).toContain(layout.command);
  });

  it("names the npm-logs probe relative to $HOME, so the command names no path in home (DIPO-98)", () => {
    const layout = selfTestLayout(PATHS);
    expect(layout.command).toEndWith(`'npm-logs' '~>' '.npm/_logs/dipo-self-test-n1'`);
    expect(layout.command).not.toContain(`${HOME}/.npm`);
    expect(layout.script).toContain('$p = "$ENV{HOME}/$p"');
    expect(layout.prompt).toContain("npm's log directory");
    // The recording groups stay as they were; without a home the probe cannot be laid out.
    for (const probes of Object.values(PROBE_GROUPS)) {
      expect(probes as readonly ProbeName[]).not.toContain("npm-logs");
    }
    expect(() => selfTestLayout({ ...PATHS, home: undefined })).toThrow("home directory");
  });

  it("builds one probe group per safety recording", () => {
    const gh = selfTestLayout(PATHS, PROBE_GROUPS["safety-gh-token"]);
    expect(gh.targets.map((target) => target.name)).toEqual(["control"]);
    const pointer = selfTestLayout(PATHS, PROBE_GROUPS["safety-pointer-write"]);
    expect(pointer.targets.map((target) => target.name)).toEqual(["control", "pointer"]);
    // safety-gh-token makes only the control write; its check is the engine's, under srt.
    expect(PROBE_GROUPS["safety-gh-token"]).toEqual([]);
    expect(gh.command).not.toContain("Keychains");
  });

  it("writes the nonce byte and appends it to the pointer", () => {
    const layout = selfTestLayout(PATHS);
    expect(layout.byte).toBe("n");
    expect(layout.command).toContain(`'${TMP_DIR}/dipo-self-test-n1.txt' 'n' 'control'`);
    expect(layout.script).toContain("print $f $b");
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
    expect(parsePointer(POINTER, WORKDIR)).toBe(ADMIN_DIR);
    expect(parsePointer("gitdir: ../shop/.git/worktrees/x\n", "/a/wt")).toBe(
      "/a/shop/.git/worktrees/x",
    );
    expect(parsePointer("nonsense", WORKDIR)).toBeNull();
  });

  it("counts Bash calls by tool use id and compares the planned commands exactly, in order", () => {
    const probe = "perl -e 1";
    const planned = [probe, APPROVAL_COMMAND];
    const both = `${bashLine("t1", probe)}\n${bashLine("t2", APPROVAL_COMMAND)}\n`;
    expect(bashCalls(both, planned)).toEqual({
      calls: 2,
      exact: true,
      shape: true,
      commands: planned,
    });
    // The same message repeated (a stream re-emit) still counts once.
    expect(bashCalls(`${both}${bashLine("t2", APPROVAL_COMMAND)}\n`, planned).calls).toBe(2);
    expect(
      bashCalls(`${bashLine("t1", `${probe} `)}\n${bashLine("t2", APPROVAL_COMMAND)}\n`, planned),
    ).toEqual({
      calls: 2,
      exact: false,
      shape: true,
      commands: [`${probe} `, APPROVAL_COMMAND],
    });
    // The right commands in the wrong order, one call short, one call too many.
    const swapped = `${bashLine("t1", APPROVAL_COMMAND)}\n${bashLine("t2", probe)}\n`;
    expect(bashCalls(swapped, planned)).toMatchObject({ calls: 2, exact: false });
    expect(bashCalls(`${bashLine("t1", probe)}\n`, planned)).toMatchObject({
      calls: 1,
      exact: false,
    });
    expect(bashCalls(`${both}${bashLine("t3", "ls")}\n`, planned)).toMatchObject({
      calls: 3,
      exact: false,
    });
    // Each command is cut to 300 characters, the others are kept whole (DIPO-230).
    const long = `echo ${"x".repeat(400)}`;
    expect(bashCalls(`${bashLine("t1", long)}\n`, planned).commands).toEqual([long.slice(0, 300)]);
    const shaped = (input: Record<string, unknown>) =>
      bashCalls(
        `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input }] } })}\n`,
        [probe],
      );
    expect(shaped({ command: probe, description: "d", timeout: 1000 }).shape).toBe(true);
    expect(shaped({ command: probe, run_in_background: false }).shape).toBe(true);
    expect(shaped({ command: probe, run_in_background: true }).shape).toBe(false);
    expect(shaped({ command: probe, dangerouslyDisableSandbox: true }).shape).toBe(false);
    expect(bashCalls("", planned)).toEqual({ calls: 0, exact: false, shape: false, commands: [] });
  });

  it("reads the approval call's tool result and the CLI's own denial from the session", () => {
    const asked = `${bashLine("t2", APPROVAL_COMMAND)}\n`;
    expect(approvalFacts(`${asked}${toolResult(SELF_TEST_DENY_REASON)}`, true)).toEqual({
      result: SELF_TEST_DENY_REASON,
      cliDenied: false,
      reached: true,
    });
    // A result as text blocks, and one for another call, which is ignored.
    expect(
      approvalFacts(
        `${asked}${toolResult([
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ])}`,
        false,
      ),
    ).toEqual({
      result: "a\nb",
      cliDenied: false,
      reached: false,
    });
    const other = toolResult("x").replace('"t2"', '"t9"');
    expect(approvalFacts(`${asked}${other}`, true).result).toBeNull();
    const denied = `${JSON.stringify({
      type: "system",
      subtype: "permission_denied",
      tool_name: "Bash",
      tool_use_id: "t2",
      message: "No approval surface in this session; permission request denied automatically",
    })}\n`;
    expect(approvalFacts(`${asked}${denied}`, false).cliDenied).toBe(true);
    // A permission_denied event without that text is not the CLI's own denial.
    const plain = denied.replace(/No approval surface[^"]*/, "denied by a rule");
    expect(approvalFacts(`${asked}${plain}`, true).cliDenied).toBe(false);
  });
});

describe("(unit) self-test verdict", () => {
  it("passes when every forbidden write is blocked, gh fails and the control write succeeds", () => {
    expect(judgeSelfTest(evidence({}))).toEqual({ ok: true });
  });

  it.each(["main-git", "worktree-admin", "refs", "objects", "pointer", "npm-logs"] as WriteProbe[])(
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

  it("counts the npm-logs probe as blocked only on a sandbox refusal (DIPO-98)", () => {
    for (const detail of ["Permission denied", "Read-only file system"]) {
      const results = BLOCKED_RESULTS.replace(
        "npm-logs blocked Operation not permitted",
        `npm-logs blocked ${detail}`,
      );
      expect(judgeSelfTest(evidence({ results }))).toEqual({ ok: true });
    }
    const missing = BLOCKED_RESULTS.replace(
      "npm-logs blocked Operation not permitted",
      "npm-logs blocked No such file or directory",
    );
    const verdict = judgeSelfTest(evidence({ results: missing }));
    expect(verdict).toMatchObject({ ok: false, unsafe: false, probe: "npm-logs" });
    expect(!verdict.ok && verdict.reason).toContain("not a sandbox refusal");
    expect(judgeSelfTest(evidence({ written: ["npm-logs"] }))).toMatchObject({
      ok: false,
      unsafe: true,
      probe: "npm-logs",
    });
  });

  it("refuses when the session made no Bash call, extra calls or a different command", () => {
    const cases: [SelfTestBashCalls, string][] = [
      [{ calls: 0, exact: false, shape: false, commands: [] }, "0 Bash calls"],
      [{ calls: 1, exact: false, shape: false, commands: ["ls"] }, "1 Bash calls"],
      [{ calls: 3, exact: false, shape: false, commands: ["ls", "pwd", "ls"] }, "3 Bash calls"],
      [{ calls: 2, exact: false, shape: true, commands: ["ls", "pwd"] }, "not the planned command"],
      [
        { calls: 2, exact: true, shape: false, commands: ["perl -e 1", "cd .; ls"] },
        "in the background",
      ],
    ];
    for (const [bash, text] of cases) {
      const verdict = judgeSelfTest(evidence({}, { bash }));
      expect(verdict).toMatchObject({ ok: false, unsafe: false, bash: true });
      expect(!verdict.ok && verdict.reason).toContain(text);
    }
  });

  it("names each Bash command the session ran in the refusal (DIPO-230)", () => {
    const verdict = judgeSelfTest(
      evidence({}, { bash: { calls: 2, exact: false, shape: true, commands: ["ls -la", "pwd"] } }),
    );
    expect(verdict).toEqual({
      ok: false,
      unsafe: false,
      bash: true,
      reason:
        'the sandbox self-test could not run: the session\'s Bash calls were not the planned commands, in order; the commands it ran: "ls -la", "pwd"',
    });
    const none = judgeSelfTest(
      evidence({}, { bash: { calls: 0, exact: false, shape: false, commands: [] } }),
    );
    expect(!none.ok && none.reason).toContain("the commands it ran: none");
  });

  it("passes a session with exactly the probe call and the approval call that dipo denied (DIPO-231)", () => {
    expect(judgeSelfTest(evidence({}))).toEqual({ ok: true });
    // The tool result may carry more than the reason, such as the CLI's wrapper text.
    const wrapped = {
      result: `Permission denied: ${SELF_TEST_DENY_REASON}`,
      cliDenied: false,
      reached: true,
    };
    expect(judgeSelfTest(evidence({}, { approval: wrapped }))).toEqual({ ok: true });
  });

  it("refuses as could not run, key approval, when the approval call did not get dipo's decision (DIPO-231)", () => {
    const cases: [SelfTestApproval, string][] = [
      // The CLI denied it on its own; it never reached dipo either.
      [{ result: "denied", cliDenied: true, reached: false }, "no approval surface"],
      // The CLI's own denial wins even when a request reached the stand-in.
      [{ result: SELF_TEST_DENY_REASON, cliDenied: true, reached: true }, "no approval surface"],
      // No PermissionRequest for the call reached dipo: inconclusive, never a pass.
      [{ result: SELF_TEST_DENY_REASON, cliDenied: false, reached: false }, "never reached dipo"],
      // The tool result does not hold dipo's reason.
      [{ result: "Permission denied", cliDenied: false, reached: true }, "self-test reason"],
      [{ result: "", cliDenied: false, reached: true }, "self-test reason"],
      [{ result: null, cliDenied: false, reached: true }, "self-test reason"],
    ];
    for (const [approval, text] of cases) {
      const verdict = judgeSelfTest(evidence({}, { approval }));
      expect(verdict).toMatchObject({ ok: false, unsafe: false, probe: "approval" });
      expect(!verdict.ok && verdict.reason).toStartWith("the sandbox self-test could not run: ");
      expect(!verdict.ok && verdict.reason).toContain(text);
    }
    // What got through the sandbox is still judged first.
    expect(
      judgeSelfTest(
        evidence(
          { written: ["refs"] },
          { approval: { result: null, cliDenied: true, reached: false } },
        ),
      ),
    ).toMatchObject({ unsafe: true, probe: "refs" });
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
  const writable = workerWritableRoots(WORKDIR, TMP_DIR, SHORT_TMP_DIR, HOME);
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

    // The short temp root is worker-writable too (DIPO-118).
    const short = new MemoryFs();
    short.links.set(TOOLS.perl, `${SHORT_TMP_DIR}/dipo-abc/perl`);
    expect(await resolveWith(short, "/usr/bin")).toMatchObject({ ok: false });
  });

  it("counts the short temp root among the worker-writable roots, and nothing else new", () => {
    expect(writable.slice(0, 3)).toEqual([WORKDIR, TMP_DIR, SHORT_TMP_DIR]);
    expect(workerWritableRoots(WORKDIR, TMP_DIR, undefined, HOME)).toEqual(
      writable.filter((root) => root !== SHORT_TMP_DIR),
    );
  });

  it("refuses a worker PATH with an empty, relative, worktree or temp entry", async () => {
    for (const path of [
      "/usr/bin::/bin",
      "bin:/usr/bin",
      `/usr/bin:${WORKDIR}/node_modules/.bin`,
      `${TMP_DIR}:/usr/bin`,
      `/usr/bin:${SHORT_TMP_DIR}/bin`,
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
    session?: SelfTestSessionOptions;
    standIn?: FakeStandIn;
  } = {},
) {
  const clock = new ManualClock();
  const fs = options.fs ?? new MemoryFs();
  const standIn = options.standIn ?? fakeStandIn();
  const fake = scriptedClaude(clock, {
    session: selfTestSession(options.commands ?? [RUN_LAYOUT.command], options.session),
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
      standIn: standIn.start,
      sessionId: options.sessionId ?? SELF_TEST_SESSION,
    },
  );
  return { report, fs, fake, standIn, runSettings: runSettings?.content ?? "" };
}

describe("(engine) self-test run", () => {
  it("runs one Claude session under the run's own settings file and passes on a blocked disk", async () => {
    const { report, fs, fake, standIn, runSettings } = await runWith(BLOCKED_RESULTS);
    expect(report.verdict).toEqual({ ok: true });
    expect(report.evidence?.bash).toMatchObject({ calls: 2, exact: true, shape: true });
    expect(report.evidence?.bash.commands).toHaveLength(2);
    expect(report.evidence?.bash.commands[0]).toStartWith("'/usr/bin/perl' -e '");
    expect(report.evidence?.bash.commands[1]).toBe("cd .; ls");
    expect(report.evidence?.approval).toEqual({
      result: SELF_TEST_DENY_REASON,
      cliDenied: false,
      reached: true,
    });
    // The stand-in listened at the self-test's own socket, never the run host's (a resume's earlier
    // host may still be removing its own), and was stopped.
    expect(standIn.started).toEqual([{ socketPath: `${RUN_DIR}/host.self`, run: "run-0001" }]);
    expect(standIn.stopped).toBe(1);
    // The prompt names both calls.
    expect(RUN_LAYOUT.prompt).toContain(`\n${APPROVAL_COMMAND}\n`);
    const session = fake.calls.find((call) => call.cmd.includes("-p"));
    // The session's hooks relay to that same socket.
    expect(session?.env?.["DIPO_HOST_SOCKET"]).toBe(`${RUN_DIR}/host.self`);
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
    // A session of the old one-call shape lacks the approval call.
    const { report } = await runWith(BLOCKED_RESULTS, { session: { approval: false } });
    expect(report.verdict).toMatchObject({ ok: false, unsafe: false, bash: true });
  });

  it("refuses as could not run, key approval, when the CLI denied the approval call before dipo decided (DIPO-231)", async () => {
    // The CLI's own denial: nothing reached the stand-in, the tool result is the CLI's text.
    const denied = await runWith(BLOCKED_RESULTS, {
      session: { approvalResult: CLI_NO_APPROVAL_TEXT, cliDenied: true },
      standIn: fakeStandIn({ reached: false }),
    });
    expect(denied.report.verdict).toMatchObject({ ok: false, unsafe: false, probe: "approval" });
    expect(!denied.report.verdict.ok && denied.report.verdict.reason).toContain(
      "no approval surface",
    );
    expect(denied.report.evidence?.approval).toMatchObject({ cliDenied: true, reached: false });
    // It is a launch check failure with its own key, which holds the adapter like any other.
    expect(selfTestFailure(denied.report)).toMatchObject({
      check: "self-test",
      key: "approval",
    });
  });

  it("refuses as could not run when the approval call never reached dipo: inconclusive, not a pass (DIPO-231)", async () => {
    // The session's tool result looks like a denial by dipo, but the stand-in saw no request.
    const { report, standIn } = await runWith(BLOCKED_RESULTS, {
      standIn: fakeStandIn({ reached: false }),
    });
    expect(report.verdict).toMatchObject({ ok: false, unsafe: false, probe: "approval" });
    expect(!report.verdict.ok && report.verdict.reason).toContain("never reached dipo");
    expect(standIn.stopped).toBe(1);
  });

  it("refuses as could not run when the approval call's tool result lacks dipo's reason (DIPO-231)", async () => {
    for (const approvalResult of ["The user doesn't want to proceed", ""]) {
      const { report } = await runWith(BLOCKED_RESULTS, { session: { approvalResult } });
      expect(report.verdict).toMatchObject({ ok: false, unsafe: false, probe: "approval" });
      expect(!report.verdict.ok && report.verdict.reason).toContain("self-test reason");
    }
  });

  it("cannot run, without a session, when the stand-in cannot listen at the host socket (DIPO-231)", async () => {
    const standIn = fakeStandIn({ failWith: "EADDRINUSE" });
    const { report, fake, fs } = await runWith(BLOCKED_RESULTS, { standIn });
    expect(report.verdict).toMatchObject({ ok: false, unsafe: false, probe: "approval" });
    expect(!report.verdict.ok && report.verdict.reason).toContain("EADDRINUSE");
    expect(fake.calls.find((call) => call.cmd.includes("-p"))).toBeUndefined();
    expect(fs.files.has(RUN_LAYOUT.resultsFile)).toBe(false);
  });

  it("writes the hook config the run's hooks need into the run directory for the session only", async () => {
    const hookCommand = ["/opt/dipo/bin/bun", "/opt/dipo/src/main.ts"] as [string, ...string[]];
    const runCtx = context({ hookCommand });
    const runSpec = spec({ hookRelay: true });
    const launch = plan(runSpec, runCtx);
    const bunfig = `${RUN_DIR}/hook-bunfig.toml`;
    expect(launch.files.map((file) => file.name)).toContain("hook-bunfig.toml");
    const clock = new ManualClock();
    const fs = new MemoryFs();
    let during: string | undefined;
    const fake = scriptedClaude(clock, {
      session: selfTestSession([RUN_LAYOUT.command]),
      onSession: () => {
        during = fs.files.get(bunfig);
        fs.files.set(RUN_LAYOUT.resultsFile, BLOCKED_RESULTS);
        fs.files.set(RUN_LAYOUT.controlFile, "");
      },
    });
    const report = await runSelfTest(
      {
        spec: runSpec,
        ctx: runCtx,
        runSettings: launch.files.find((f) => f.name === SETTINGS_FILE)?.content ?? "",
        runFiles: launch.files,
      },
      { spawn: fake.spawn, clock, fs, standIn: fakeStandIn().start, sessionId: SELF_TEST_SESSION },
    );
    expect(report.verdict).toEqual({ ok: true });
    expect(during).toBe("");
    expect(fs.files.has(bunfig)).toBe(false);
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

  it("makes a missing ~/.npm/_logs for the probe and removes only what it made (DIPO-98)", async () => {
    const fs = new MemoryFs();
    let during: boolean[] = [];
    const { report } = await runWith(BLOCKED_RESULTS, {
      fs,
      extra: (disk) => {
        during = [disk.dirs.has(`${HOME}/.npm`), disk.dirs.has(`${HOME}/.npm/_logs`)];
      },
    });
    expect(report.verdict).toEqual({ ok: true });
    expect(during).toEqual([true, true]);
    expect(fs.removedDirs).toEqual([`${HOME}/.npm/_logs`, `${HOME}/.npm`]);

    // An existing ~/.npm is left alone; only the log directory it made goes.
    const kept = new MemoryFs();
    kept.dirs.add(`${HOME}/.npm`);
    await runWith(BLOCKED_RESULTS, { fs: kept });
    expect(kept.removedDirs).toEqual([`${HOME}/.npm/_logs`]);
    expect(kept.dirs.has(`${HOME}/.npm`)).toBe(true);
  });

  it("cannot run, before any session, when ~/.npm/_logs cannot be made or written by the daemon user", async () => {
    const npm = `${HOME}/.npm`;
    const logs = `${HOME}/.npm/_logs`;
    const cases: [string, (fs: MemoryFs) => void, string, string[]][] = [
      ["mkdir fails", (fs) => (fs.failMkdir = logs), "could not be made", [npm]],
      [
        "root-owned",
        (fs) => {
          fs.dirs.add(npm);
          fs.dirs.add(logs);
          fs.readOnlyDirs.add(logs);
        },
        "not a directory the daemon user can write",
        [],
      ],
      // A dangling symlink counts as present: never replaced, and not writable.
      [
        "dangling symlink",
        (fs) => {
          fs.dirs.add(npm);
          fs.dangling.add(logs);
        },
        "not a directory the daemon user can write",
        [],
      ],
    ];
    for (const [label, setup, text, removed] of cases) {
      const clock = new ManualClock();
      const fs = new MemoryFs();
      setup(fs);
      const fake = scriptedClaude(clock, {});
      const runSpec = spec();
      const report = await runSelfTest(
        { spec: runSpec, ctx: context(), runSettings: "{}" },
        { spawn: fake.spawn, clock, fs, standIn: reachedStandIn(), sessionId: SELF_TEST_SESSION },
      );
      expect([label, report.verdict]).toMatchObject([label, { ok: false, unsafe: false }]);
      expect(!report.verdict.ok && report.verdict.reason).toContain(text);
      expect(selfTestFailure(report)?.key).toBe("npm-logs");
      expect(fake.calls.filter((call) => call.cmd.includes("-p"))).toEqual([]);
      expect(fs.removedDirs).toEqual(removed);
      expect(fs.dirs.has(logs)).toBe(label !== "mkdir fails" && label !== "dangling symlink");
    }
  });

  it("refuses as unsafe and removes the file when a write into ~/.npm/_logs got through", async () => {
    const probe = `${HOME}/.npm/_logs/dipo-self-test-${NONCE}`;
    const { report, fs } = await runWith(BLOCKED_RESULTS, {
      extra: (disk) => disk.files.set(probe, "7"),
    });
    expect(report.verdict).toMatchObject({ ok: false, unsafe: true, probe: "npm-logs" });
    expect(selfTestFailure(report)).toMatchObject({ key: "npm-logs", file: probe });
    expect(fs.files.has(probe)).toBe(false);
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
    expect(report.verdict).toEqual({ ok: true });
  });

  it("refuses before any session when the pointer is not exactly one gitdir line", async () => {
    for (const pointer of [`${POINTER}c`, `${POINTER}gitdir: /x\n`, POINTER.trimEnd(), ""]) {
      const clock = new ManualClock();
      const fake = scriptedClaude(clock, {});
      const report = await runSelfTest(
        { spec: spec(), ctx: context(), runSettings: "{}" },
        {
          spawn: fake.spawn,
          clock,
          fs: new MemoryFs(pointer),
          sessionId: SELF_TEST_SESSION,
        },
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
      { spawn: fake.spawn, clock, fs, standIn: reachedStandIn(), sessionId: SELF_TEST_SESSION },
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
      { spawn: fake.spawn, clock, fs, standIn: reachedStandIn(), sessionId: SELF_TEST_SESSION },
    );
    expect(report.verdict).toMatchObject({ ok: false, unsafe: true, probe: "pointer" });
    expect(selfTestFailure(report)?.file).toBe(`${WORKDIR}/.git`);
    expect(fake.calls).toEqual([]);
  });
});

/**
 * The bash and approval evidence a safety recording is judged with (DIPO-244). A recording that
 * holds approval evidence is a capture of the two-call session: it is judged with its own evidence
 * and its recorded call count. A recording without it predates the approval call (DIPO-231): its one
 * probe call stands for the two planned calls and the approval call is given as dipo-denied, so it
 * proves the sandbox probes only; a live two-call recording is the maintainer's check.
 */
function judgedCalls(checks: {
  bash: Omit<SelfTestBashCalls, "commands">;
  approval?: SelfTestApproval;
}): { bash: SelfTestBashCalls; approval: SelfTestApproval } {
  if (checks.approval !== undefined) {
    return { bash: { commands: [], ...checks.bash }, approval: checks.approval };
  }
  return {
    bash: { commands: [], ...checks.bash, calls: SELF_TEST_BASH_CALLS },
    approval: { result: SELF_TEST_DENY_REASON, cliDenied: false, reached: true },
  };
}

describe("(unit) safety recording judgement (DIPO-244)", () => {
  const GRANTED: SelfTestApproval = {
    result: SELF_TEST_DENY_REASON,
    cliDenied: false,
    reached: true,
  };
  const bash = { calls: SELF_TEST_BASH_CALLS, exact: true, shape: true };

  it("judges a recording with approval evidence with that evidence and its own call count", () => {
    expect(judgedCalls({ bash, approval: GRANTED })).toEqual({
      bash: { commands: [], ...bash },
      approval: GRANTED,
    });
  });

  it("keeps the two-call override only for a recording without approval evidence", () => {
    expect(judgedCalls({ bash: { calls: 1, exact: true, shape: true } })).toEqual({
      bash: { commands: [], calls: SELF_TEST_BASH_CALLS, exact: true, shape: true },
      approval: GRANTED,
    });
  });

  it("refuses a recorded one-call session even when it holds approval evidence", () => {
    const judged = judgedCalls({ bash: { calls: 1, exact: true, shape: true }, approval: GRANTED });
    expect(judgeSelfTest(evidence({}, judged))).toMatchObject({ ok: false, bash: true });
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
        bash: Omit<SelfTestBashCalls, "commands">;
        approval?: SelfTestApproval;
        probes: ProbeName[];
        verdict: unknown;
      };
      const run = await replay(recording);
      const denied = run.events.flatMap((event) => (event.t === "denied" ? [event.tool] : []));
      expect(checks.probes).toEqual([...probes]);
      const verdict = judgeSelfTest({
        probes: checks.probes,
        outcome: run.result.outcome,
        denied,
        ...judgedCalls(checks),
        disk: checks.disk,
      });
      expect(verdict.ok).toBe(true);
      // Only ok is compared: verdict fields that held removed probes do not void a recording.
      expect((checks.verdict as { ok: boolean }).ok).toBe(true);
      if (name !== "safety-gh-token") return;
      // This recording's evidence is the engine check under srt: each lookup ran (not 126 or
      // 127) and was refused. The Keychain lookup runs only on macOS.
      const credential = recording.meta["checks"] as {
        engineCredentialCheck: { ok: boolean; refused: Record<string, number> };
      };
      expect(credential.engineCredentialCheck.ok).toBe(true);
      const refused = credential.engineCredentialCheck.refused;
      const lookups = process.platform === "darwin" ? ["gh-token", "keychain"] : ["gh-token"];
      for (const probe of lookups) {
        expect(refused[probe]).toBeNumber();
        expect([0, 126, 127]).not.toContain(refused[probe]);
      }
    });
  }
});

describe("(unit) Safe-Chain install check (DIPO-84)", () => {
  const SAFE_CHAIN = { root: `${HOME}/.safe-chain` };
  const OK = `${BLOCKED_RESULTS}safe-chain-install exit 0\nsafe-chain-blocked exit 1\n`;

  it("runs both installs in a fresh project first and hands their exit codes to perl", () => {
    const layout = selfTestLayout({ ...PATHS, safeChainInstall: true });
    const plain = selfTestLayout(PATHS);
    const dir = `${PATHS.tmpDir}/dipo-self-test-${PATHS.nonce}-install`;
    expect(layout.installDir).toBe(dir);
    expect(layout.command).toBe(
      `bun add --cwd='${dir}' is-number@7.0.0 >/dev/null 2>&1; a=$?; ` +
        `bun add --cwd='${dir}' safe-chain-test >/dev/null 2>&1; b=$?; ` +
        `${plain.command} 'safe-chain-install' 'exit' "$a" 'safe-chain-blocked' 'exit' "$b"`,
    );
    expect(layout.prompt).toContain(layout.command);
    expect(layout.prompt).toContain("expected to refuse");
    // Without Safe-Chain the command is the plain perl call.
    expect(plain.installDir).toBeNull();
    expect(plain.command.startsWith(`'${TOOLS.perl}'`)).toBe(true);
  });

  it("parses both exit lines next to the write lines", () => {
    const lines = parseResults(OK);
    expect(lines.get("safe-chain-install")).toEqual({ kind: "exit", code: 0 });
    expect(lines.get("safe-chain-blocked")).toEqual({ kind: "exit", code: 1 });
    expect(lines.get("control")).toMatchObject({ kind: "write", written: true });
  });

  it("passes when the install works and the test malware is refused", () => {
    expect(judgeSelfTest(evidence({ results: OK }, { safeChain: SAFE_CHAIN }))).toEqual({
      ok: true,
    });
  });

  it("refuses clearly when the install fails or a result is missing", () => {
    const failed = judgeSelfTest(
      evidence(
        { results: `${BLOCKED_RESULTS}safe-chain-install exit 1\nsafe-chain-blocked exit 1\n` },
        { safeChain: SAFE_CHAIN },
      ),
    );
    expect(failed).toEqual({
      ok: false,
      unsafe: false,
      probe: "safe-chain",
      reason: `Safe-Chain is installed at ${HOME}/.safe-chain, but \`bun add is-number@7.0.0\` through dipo's Safe-Chain proxy exited 1 inside the worker sandbox, so worker installs cannot work`,
    });
    const failure = selfTestFailure({
      verdict: failed,
      evidence: null,
      plugins: null,
      targets: [],
    });
    expect(failure).toMatchObject({ check: "self-test", key: "safe-chain" });
    expect(failure?.fix).toContain("safe-chain/proxy.json");

    expect(judgeSelfTest(evidence({}, { safeChain: SAFE_CHAIN }))).toMatchObject({
      ok: false,
      unsafe: false,
      probe: "safe-chain",
    });
    // Without Safe-Chain no exit line is asked for.
    expect(judgeSelfTest(evidence({}))).toEqual({ ok: true });
  });

  it("refuses as unsafe when Safe-Chain let its test malware install", () => {
    const verdict = judgeSelfTest(
      evidence(
        { results: `${BLOCKED_RESULTS}safe-chain-install exit 0\nsafe-chain-blocked exit 0\n` },
        { safeChain: SAFE_CHAIN },
      ),
    );
    expect(verdict).toMatchObject({ ok: false, unsafe: true, probe: "safe-chain" });
    expect((verdict as { reason: string }).reason).toContain("did not refuse its own test malware");
  });

  it("records both exit codes with the real perl program", async () => {
    const perl = "/usr/bin/perl";
    if (!existsSync(perl)) return;
    await withTempDir(async (dir) => {
      const results = join(dir, "results.txt");
      const layout = selfTestLayout({ ...PATHS, safeChainInstall: true });
      const child = Bun.spawn(
        [
          perl,
          "-e",
          layout.script,
          results,
          "n",
          "control",
          ">",
          join(dir, "c"),
          "safe-chain-install",
          "exit",
          "0",
          "safe-chain-blocked",
          "exit",
          "1",
        ],
        { stdout: "ignore" },
      );
      expect(await child.exited).toBe(0);
      expect(await Bun.file(results).text()).toBe(
        "control written\nsafe-chain-install exit 0\nsafe-chain-blocked exit 1\n",
      );
    });
  });

  it("runs the run's wrapper and a fresh install project, and removes the project", async () => {
    const clock = new ManualClock();
    const fs = new MemoryFs();
    const safeChain = {
      root: `${HOME}/.safe-chain`,
      shell: "/bin/zsh",
      path: "/usr/bin:/bin",
      demoted: [],
      dropped: [],
      probe: "bun",
      shellDir: `${RUN_DIR}/safe-chain`,
      route: { port: 50123, dir: "/private/tmp/dipo-p/abc123" },
    };
    const ctx = context({ safeChain });
    const layout = selfTestLayout({ ...PATHS, nonce: NONCE, safeChainInstall: true });
    let installProject: string | null = null;
    const fake = scriptedClaude(clock, {
      session: selfTestSession([layout.command]),
      onSession: () => {
        // The install project exists while the session runs.
        installProject = fs.files.get(`${layout.installDir}/package.json`) ?? null;
        fs.files.set(layout.resultsFile, OK);
        fs.files.set(layout.controlFile, "");
      },
    });
    const runPlan = plan(spec(), ctx);
    const runSettings = runPlan.files.find((f) => f.name === SETTINGS_FILE)?.content ?? "";
    const report = await runSelfTest(
      { spec: spec(), ctx, runSettings, runFiles: runPlan.files },
      { spawn: fake.spawn, clock, fs, standIn: reachedStandIn(), sessionId: SELF_TEST_SESSION },
    );
    expect(report.verdict).toEqual({ ok: true });
    expect(fs.executableWrites).toEqual(new Set([`${RUN_DIR}/safe-chain/zsh`]));
    expect(fs.files.get(`${RUN_DIR}/safe-chain/.zshenv`)).not.toContain("init-posix.sh");
    expect(fs.files.get(`${RUN_DIR}/safe-chain/zsh`)).toContain("BUN_INSTALL_CACHE_DIR");
    expect(String(installProject)).toContain("dipo-self-test");
    expect(fs.removedTrees).toEqual([layout.installDir ?? ""]);
    const session = fake.calls.find((call) => call.cmd.includes("-p"));
    expect(session?.env?.["CLAUDE_CODE_SHELL"]).toBe(`${RUN_DIR}/safe-chain/zsh`);
    expect(fs.files.get(`${RUN_DIR}/self-test/${SETTINGS_FILE}`)).toBe(runSettings);

    // Without the run's files the check cannot run.
    const missing = await runSelfTest(
      { spec: spec(), ctx, runSettings },
      {
        spawn: fake.spawn,
        clock,
        fs: new MemoryFs(),
        standIn: reachedStandIn(),
        sessionId: SELF_TEST_SESSION,
      },
    );
    expect(missing.verdict).toMatchObject({ ok: false, unsafe: false, probe: "safe-chain" });
  });
});

describe("(unit) npm-logs probe program (DIPO-98)", () => {
  it("writes $HOME/<path> for the ~> mode with the real perl program", async () => {
    const perl = "/usr/bin/perl";
    if (!existsSync(perl)) return;
    await withTempDir(async (dir) => {
      mkdirSync(join(dir, ".npm", "_logs"), { recursive: true });
      const results = join(dir, "results.txt");
      const layout = selfTestLayout({ ...PATHS, home: dir });
      const child = Bun.spawn(
        [perl, "-e", layout.script, results, "n", "npm-logs", "~>", ".npm/_logs/probe"],
        { stdout: "pipe", stderr: "pipe", env: { HOME: dir } },
      );
      expect(await child.exited).toBe(0);
      expect(await Bun.file(results).text()).toBe("npm-logs written\n");
      expect(await Bun.file(join(dir, ".npm", "_logs", "probe")).text()).toBe("n");
      // Every result is printed too, so the model has nothing to add (live finding on PR #120).
      expect(await new Response(child.stdout).text()).toBe(
        "npm-logs written\ndipo-self-test finished\n",
      );
      expect(await new Response(child.stderr).text()).toBe("");
    });
  });

  it("tells the model to add nothing to the command (live finding on PR #120)", () => {
    const layout = selfTestLayout({ ...PATHS, safeChainInstall: true });
    expect(layout.prompt).toContain("Add nothing before or after it");
    expect(layout.prompt).toContain("no cat, no exit-code check");
    expect(layout.prompt).toContain("prints every result itself");
  });
});

/** A review self-test's evidence (0019 section 4): the review probes, an install that must fail. */
function reviewEvidence(disk: Partial<SelfTestDisk>, more: Partial<SelfTestEvidence> = {}) {
  return evidence(
    { results: REVIEW_BLOCKED_RESULTS, ...disk },
    { probes: REVIEW_PROBES, installMustFail: true, ...more },
  );
}

describe("(unit) review self-test (DIPO-145, 0019 section 4)", () => {
  const REVIEW_LAYOUT = selfTestLayout({ ...PATHS, nonce: NONCE, review: true }, REVIEW_PROBES);

  it("writes its control file in the run temp root, probes the worktree, and installs first", () => {
    const layout = selfTestLayout({ ...PATHS, review: true }, REVIEW_PROBES);
    const name = `dipo-self-test-${PATHS.nonce}`;
    expect(layout.controlFile).toBe(`${TMP_DIR}/.${name}`);
    expect(layout.controlFile.startsWith(`${WORKDIR}/`)).toBe(false);
    expect(layout.targets.find((target) => target.name === "worktree")).toEqual({
      name: "worktree",
      mode: ">",
      path: `${WORKDIR}/.${name}`,
    });
    const dir = `${TMP_DIR}/${name}-install`;
    expect(layout.installDir).toBe(dir);
    const plain = selfTestLayout({ ...PATHS, review: false }, REVIEW_PROBES);
    expect(layout.command).toBe(
      `bun add --cwd='${dir}' --no-cache is-number@7.0.0 >/dev/null 2>&1; a=$?; ` +
        `${plain.command.replace(`${WORKDIR}/.${name}' 'main-git`, `${TMP_DIR}/.${name}' 'main-git`)} 'install' 'exit' "$a"`,
    );
    expect(layout.prompt).toContain(layout.command);
    expect(layout.prompt).toContain("a control file in the run's temp directory");
    expect(layout.prompt).toContain("the install is expected to fail");
    expect(layout.prompt).toContain("a file inside this worktree");
  });

  it("passes only when the worktree write is refused and the install failed", () => {
    expect(judgeSelfTest(reviewEvidence({}))).toEqual({ ok: true });
  });

  const INSTALL_FIX =
    "Put a real bun on the daemon's PATH, outside directories a worker can write: a reviewer runs with that PATH, and its self-test needs bun to show that an install fails on the closed network. Then start the review again.";

  it("cannot run when bun was not found (exit 127): the install proves nothing", () => {
    const missing = REVIEW_BLOCKED_RESULTS.replace("install exit 1", "install exit 127");
    const verdict = judgeSelfTest(reviewEvidence({ results: missing }));
    expect(verdict).toEqual({
      ok: false,
      unsafe: false,
      probe: "install",
      reason:
        "the sandbox self-test could not run: `bun add` exited 127 inside the reviewer sandbox: bun was not found on the reviewer's PATH, so the failed install does not show that the network is closed",
    });
    expect(selfTestFailure({ verdict, evidence: null, plugins: null, targets: [] })).toEqual({
      check: "self-test",
      detail:
        "the sandbox self-test could not run: `bun add` exited 127 inside the reviewer sandbox: bun was not found on the reviewer's PATH, so the failed install does not show that the network is closed",
      key: "install",
      fix: INSTALL_FIX,
    });
  });

  it("cannot run when bun could not be executed (exit 126): the install proves nothing", () => {
    const denied = REVIEW_BLOCKED_RESULTS.replace("install exit 1", "install exit 126");
    const verdict = judgeSelfTest(reviewEvidence({ results: denied }));
    expect(verdict).toEqual({
      ok: false,
      unsafe: false,
      probe: "install",
      reason:
        "the sandbox self-test could not run: `bun add` exited 126 inside the reviewer sandbox: bun was found on the reviewer's PATH but could not be executed, so the failed install does not show that the network is closed",
    });
    expect(selfTestFailure({ verdict, evidence: null, plugins: null, targets: [] })).toEqual({
      check: "self-test",
      detail:
        "the sandbox self-test could not run: `bun add` exited 126 inside the reviewer sandbox: bun was found on the reviewer's PATH but could not be executed, so the failed install does not show that the network is closed",
      key: "install",
      fix: INSTALL_FIX,
    });
  });

  it("refuses as unsafe when the install succeeded, by its exit code or on disk", () => {
    const succeeded = REVIEW_BLOCKED_RESULTS.replace("install exit 1", "install exit 0");
    const verdict = judgeSelfTest(reviewEvidence({ results: succeeded }));
    expect(verdict).toMatchObject({ ok: false, unsafe: true, probe: "install" });
    expect((verdict as { reason: string }).reason).toContain(
      "succeeded inside the reviewer sandbox",
    );
    expect(judgeSelfTest(reviewEvidence({ installed: true }))).toMatchObject({
      ok: false,
      unsafe: true,
      probe: "install",
    });
    const failure = selfTestFailure({ verdict, evidence: null, plugins: null, targets: [] });
    expect(failure).toMatchObject({ check: "self-test", key: "install" });
    expect(failure?.fix).toContain("network");
  });

  it("refuses as unsafe when the worktree write got through", () => {
    const written = REVIEW_BLOCKED_RESULTS.replace(
      "worktree blocked Operation not permitted",
      "worktree written",
    );
    expect(judgeSelfTest(reviewEvidence({ results: written }))).toMatchObject({
      ok: false,
      unsafe: true,
      probe: "worktree",
    });
    expect(judgeSelfTest(reviewEvidence({ written: ["worktree"] }))).toMatchObject({
      ok: false,
      unsafe: true,
      probe: "worktree",
    });
  });

  it("cannot run without the install result or the control write in the run temp root", () => {
    const noInstall = REVIEW_BLOCKED_RESULTS.replace("install exit 1\n", "");
    expect(judgeSelfTest(reviewEvidence({ results: noInstall }))).toMatchObject({
      ok: false,
      unsafe: false,
      probe: "install",
    });
    const noControl = judgeSelfTest(reviewEvidence({ controlWritten: false }));
    expect(noControl).toMatchObject({ ok: false, unsafe: false, probe: "control" });
    expect((noControl as { reason: string }).reason).toContain("inside the run temp root");
  });

  it("runs under the review run's settings, control file in the temp root, and cleans up", async () => {
    const clock = new ManualClock();
    const fs = new MemoryFs();
    let installProject: string | null = null;
    const fake = scriptedClaude(clock, {
      session: selfTestSession([REVIEW_LAYOUT.command]),
      onSession: () => {
        installProject = fs.files.get(`${REVIEW_LAYOUT.installDir}/package.json`) ?? null;
        fs.files.set(REVIEW_LAYOUT.resultsFile, REVIEW_BLOCKED_RESULTS);
        fs.files.set(REVIEW_LAYOUT.controlFile, "");
      },
    });
    // Safe-Chain on the machine gives a reviewer the detected PATH and a closed shell snapshot
    // (DIPO-250), but no proxy, no wrapper and no install through it.
    const safeChain = {
      root: `${HOME}/.safe-chain`,
      shell: "/bin/zsh",
      path: "/usr/bin:/bin:/demoted/bin",
      demoted: [],
      dropped: [],
      probe: "bun",
      shellDir: `${RUN_DIR}/safe-chain`,
      route: { port: 50123, dir: "/private/tmp/dipo-p/abc123" },
    };
    const ctx = context({ safeChain });
    const runPlan = plan(reviewSpec(), ctx);
    const runSettings = runPlan.files.find((f) => f.name === SETTINGS_FILE)?.content ?? "";
    const report = await runSelfTest(
      { spec: reviewSpec(), ctx, runSettings, runFiles: runPlan.files },
      { spawn: fake.spawn, clock, fs, standIn: reachedStandIn(), sessionId: SELF_TEST_SESSION },
    );
    expect(report.verdict).toEqual({ ok: true });
    expect(report.evidence?.probes).toEqual(REVIEW_PROBES);
    expect(report.evidence?.installMustFail).toBe(true);
    expect(report.evidence?.safeChain).toBeUndefined();
    expect(String(installProject)).toContain("dipo-self-test");
    // The session runs the review run's own settings file, byte for byte, and its argv.
    expect(fs.files.get(`${RUN_DIR}/self-test/${SETTINGS_FILE}`)).toBe(runSettings);
    const session = fake.calls.find((call) => call.cmd.includes("-p"));
    expect(session?.env?.["CLAUDE_CODE_SHELL"]).toBeUndefined();
    expect(session?.env?.["PATH"]).toBe(safeChain.path);
    expect(runSettings).toContain(`${HOME}/.claude/shell-snapshots`);
    expect(session?.cmd[session.cmd.indexOf("--mcp-config") + 1]).toBe(
      `${RUN_DIR}/self-test/mcp-empty.json`,
    );
    expect(fs.executableWrites.size).toBe(0);
    // Everything it made is gone: control file, results, worktree probe and install project.
    expect(fs.files.has(REVIEW_LAYOUT.controlFile)).toBe(false);
    expect(fs.files.has(REVIEW_LAYOUT.resultsFile)).toBe(false);
    expect(fs.removedTrees).toEqual([REVIEW_LAYOUT.installDir ?? ""]);
    expect(fs.files.get(`${WORKDIR}/.git`)).toBe(POINTER);
  });

  it("refuses the session when the install got through on disk", async () => {
    const clock = new ManualClock();
    const fs = new MemoryFs();
    const installed = `${REVIEW_LAYOUT.installDir}/node_modules/is-number/package.json`;
    const fake = scriptedClaude(clock, {
      session: selfTestSession([REVIEW_LAYOUT.command]),
      onSession: () => {
        fs.files.set(REVIEW_LAYOUT.resultsFile, REVIEW_BLOCKED_RESULTS);
        fs.files.set(REVIEW_LAYOUT.controlFile, "");
        fs.files.set(installed, "{}");
      },
    });
    const runSettings =
      plan(reviewSpec(), context()).files.find((f) => f.name === SETTINGS_FILE)?.content ?? "";
    const report = await runSelfTest(
      { spec: reviewSpec(), ctx: context(), runSettings },
      { spawn: fake.spawn, clock, fs, standIn: reachedStandIn(), sessionId: SELF_TEST_SESSION },
    );
    expect(report.verdict).toMatchObject({ ok: false, unsafe: true, probe: "install" });
  });

  it("records the install exit code with the real perl program", async () => {
    const perl = "/usr/bin/perl";
    if (!existsSync(perl)) return;
    await withTempDir(async (dir) => {
      const results = join(dir, "results.txt");
      const layout = selfTestLayout({ ...PATHS, review: true }, REVIEW_PROBES);
      const child = Bun.spawn(
        [
          perl,
          "-e",
          layout.script,
          results,
          "n",
          "control",
          ">",
          join(dir, "c"),
          "install",
          "exit",
          "1",
        ],
        { stdout: "ignore" },
      );
      expect(await child.exited).toBe(0);
      expect(await Bun.file(results).text()).toBe("control written\ninstall exit 1\n");
      expect(parseResults(await Bun.file(results).text()).get("install")).toEqual({
        kind: "exit",
        code: 1,
      });
    });
  });
});

/** A hook payload of a Bash call, as Claude Code hands it to `dipo hook <event>`. */
function hook(command: string, event = "PermissionRequest"): string {
  return JSON.stringify({ hook_event_name: event, tool_name: "Bash", tool_input: { command } });
}

describe("(engine) self-test stand-in host (DIPO-231)", () => {
  const RUN = "run_01JZ0000000000000000000009";

  /** The hook relay's call, as `dipo hook <event>` makes it. */
  const relay = (socket: string, payload: string, waitMs?: number) =>
    relayHookPayload({
      socketPath: socket,
      runId: RUN,
      payload,
      clock: systemClock,
      timeoutMs: 1500,
      ...(waitMs === undefined ? {} : { waitMs }),
    });

  it("answers the approval call's PermissionRequest with the self-test deny and every other hook with no output", async () => {
    await withTempDir(async (dir) => {
      const socket = hostSocketPath(join(dir, "rt"), RUN);
      const standIn = await startHostStandIn({ socketPath: socket, run: RUN });
      try {
        const denied = await relay(socket, hook(APPROVAL_COMMAND), 5000);
        expect(JSON.parse(denied ?? "null")).toEqual({
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: { behavior: "deny", message: SELF_TEST_DENY_REASON },
          },
        });
        // Non-waiting hooks, and a PermissionRequest for another call, get no output.
        expect(await relay(socket, hook("ls", "PostToolUse"))).toBe("");
        expect(await relay(socket, hook("echo hi"), 5000)).toBe("");
        expect(await relay(socket, "not json")).toBe("");
        expect(standIn.permissionRequests).toEqual([
          { tool: "Bash", command: APPROVAL_COMMAND },
          { tool: "Bash", command: "echo hi" },
        ]);
      } finally {
        await standIn.stop();
      }
      // Stopped: the socket file is gone and nothing answers.
      expect(existsSync(socket)).toBe(false);
      expect(await relay(socket, hook(APPROVAL_COMMAND), 5000)).toBeNull();
    });
  });

  it("binds the self-test's own socket, so the run host's socket file is left alone", async () => {
    await withTempDir(async (dir) => {
      const hostSocket = hostSocketPath(join(dir, "rt"), RUN);
      const selfSocket = selfTestSocketPath(hostSocket);
      expect(selfSocket).toHaveLength(hostSocket.length);
      expect(selfSocket).not.toBe(hostSocket);
      // An earlier host's socket file, as a resume may meet while that host is still ending.
      mkdirSync(dirname(hostSocket), { recursive: true });
      writeFileSync(hostSocket, "");
      const standIn = await startHostStandIn({ socketPath: selfSocket, run: RUN });
      try {
        expect(existsSync(hostSocket)).toBe(true);
        expect(await relay(selfSocket, hook(APPROVAL_COMMAND), 5000)).not.toBe("");
      } finally {
        await standIn.stop();
      }
      expect(existsSync(hostSocket)).toBe(true);
    });
  });

  it("refuses a hello for another run, and replaces a leftover socket file", async () => {
    await withTempDir(async (dir) => {
      const socket = hostSocketPath(join(dir, "rt"), RUN);
      const first = await startHostStandIn({ socketPath: socket, run: RUN });
      // Not stopped on purpose: the file stays behind, as after a crash.
      void first;
      const standIn = await startHostStandIn({ socketPath: socket, run: RUN });
      try {
        const other = await relayHookPayload({
          socketPath: socket,
          runId: "run_01JZ0000000000000000000008",
          payload: hook(APPROVAL_COMMAND),
          clock: systemClock,
          timeoutMs: 1500,
        });
        expect(other).toBeNull();
        expect(standIn.permissionRequests).toEqual([]);
        expect(await relay(socket, hook(APPROVAL_COMMAND), 5000)).not.toBe("");
      } finally {
        await standIn.stop();
        await first.stop();
      }
    });
  });
});
