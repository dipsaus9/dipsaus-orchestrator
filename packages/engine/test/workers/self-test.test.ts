// The sandbox self-test (DIPO-43 AC #4 and #8, 0008 section 2): the probe command, the verdict
// from session and disk, a full run through a replayed session and an in-memory disk, and the
// three live safety recordings replayed once the maintainer has captured them.

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { ManualClock } from "@dipsaus-orchestrator/testkit";

import { plan, SETTINGS_FILE } from "../../src/workers/claude-cli/plan";
import {
  judgeSelfTest,
  parsePointer,
  parseResults,
  PROBE_GROUPS,
  runSelfTest,
  SELF_TEST_MODEL,
  selfTestFailure,
  selfTestLayout,
  type SelfTestDisk,
  type SelfTestEvidence,
  type WriteProbe,
} from "../../src/workers/claude-cli/self-test";
import {
  ADMIN_DIR,
  BLOCKED_RESULTS,
  context,
  MAIN,
  MemoryFs,
  POINTER,
  RUN_DIR,
  scriptedClaude,
  SELF_TEST_SESSION,
  spec,
  TMP_DIR,
  WORKDIR,
} from "./launch-fixtures";
import { loadRecording, RECORDINGS_DIR, replay } from "./replay";

const PATHS = { main: MAIN, workdir: WORKDIR, adminDir: ADMIN_DIR, tmpDir: TMP_DIR, nonce: "n1" };

function evidence(disk: Partial<SelfTestDisk>, more: Partial<SelfTestEvidence> = {}) {
  return {
    probes: selfTestLayout(PATHS).probes,
    outcome: "done" as const,
    denied: [],
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
    // The command starts with perl, so neither `Bash(gh *)` nor redirection rules stop it first.
    expect(layout.command.startsWith("perl -e '")).toBe(true);
    expect(layout.command).toContain("gh auth token >/dev/null 2>&1");
    expect(layout.command).toEndWith("'gh-token' '-' '-'");
    expect(layout.prompt).toContain(layout.command);
  });

  it("builds one probe group per safety recording", () => {
    const gh = selfTestLayout(PATHS, PROBE_GROUPS["safety-gh-token"]);
    expect(gh.targets.map((target) => target.name)).toEqual(["control"]);
    const pointer = selfTestLayout(PATHS, PROBE_GROUPS["safety-pointer-write"]);
    expect(pointer.targets.map((target) => target.name)).toEqual(["control", "pointer"]);
    expect(pointer.command).not.toContain("'gh-token'");
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
    expect(lines.get("gh-token")).toEqual({ kind: "exit", code: 1 });
    expect(parsePointer(POINTER, WORKDIR)).toBe(ADMIN_DIR);
    expect(parsePointer("gitdir: ../shop/.git/worktrees/x\n", "/a/wt")).toBe(
      "/a/shop/.git/worktrees/x",
    );
    expect(parsePointer("nonsense", WORKDIR)).toBeNull();
  });
});

describe("(unit) self-test verdict", () => {
  it("passes when every forbidden write is blocked, gh fails and the control write succeeds", () => {
    expect(judgeSelfTest(evidence({}))).toEqual({ ok: true, ghExit: 1 });
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

/** The self-test run, with the session replayed from a recording and the disk in memory. */
async function runWith(results: string | null, extra: (fs: MemoryFs) => void = () => {}) {
  const clock = new ManualClock();
  const fs = new MemoryFs();
  const layout = selfTestLayout({
    ...PATHS,
    nonce: SELF_TEST_SESSION.replaceAll("-", "").slice(0, 16),
  });
  const fake = scriptedClaude(clock, {
    session: loadRecording("safety-main-git"),
    onSession: () => {
      // What the sandboxed command leaves behind.
      if (results !== null) fs.files.set(layout.resultsFile, results);
      fs.files.set(layout.controlFile, "");
      extra(fs);
    },
  });
  const runSpec = spec();
  const runSettings = plan(runSpec, context()).files.find((f) => f.name === SETTINGS_FILE);
  const report = await runSelfTest(
    { spec: runSpec, ctx: context(), runSettings: runSettings?.content ?? "" },
    { spawn: fake.spawn, clock, fs, sessionId: SELF_TEST_SESSION },
  );
  return { report, fs, fake, layout, runSettings: runSettings?.content ?? "" };
}

describe("(engine) self-test run", () => {
  it("runs one Claude session under the run's own settings file and passes on a blocked disk", async () => {
    const { report, fs, fake, layout, runSettings } = await runWith(BLOCKED_RESULTS);
    expect(report.verdict).toEqual({ ok: true, ghExit: 1 });
    const session = fake.calls.find((call) => call.cmd.includes("-p"));
    expect(session?.cmd).toContain("--settings");
    expect(session?.cmd).toContain(`${RUN_DIR}/self-test/${SETTINGS_FILE}`);
    expect(session?.cmd).toContain(SELF_TEST_SESSION);
    expect(session?.cmd[session.cmd.indexOf("--model") + 1]).toBe(SELF_TEST_MODEL);
    expect(session?.cmd[session.cmd.indexOf("--tools") + 1]).toBe("Bash");
    expect(session?.cwd).toBe(WORKDIR);
    expect(fs.files.get(`${RUN_DIR}/self-test/${SETTINGS_FILE}`)).toBe(runSettings);
    // Everything it made is gone; the pointer is untouched.
    expect(fs.files.has(layout.resultsFile)).toBe(false);
    expect(fs.files.has(layout.controlFile)).toBe(false);
    expect(fs.files.get(`${WORKDIR}/.git`)).toBe(POINTER);
    expect(report.plugins).toBe(3);
  });

  it("refuses and cleans up when a forbidden file was written", async () => {
    const refs = `${MAIN}/.git/refs/heads/dipo-self-test-${SELF_TEST_SESSION.replaceAll("-", "").slice(0, 16)}`;
    const { report, fs } = await runWith(BLOCKED_RESULTS, (disk) => disk.files.set(refs, ""));
    expect(report.verdict).toMatchObject({ ok: false, unsafe: true, probe: "refs" });
    expect(fs.files.has(refs)).toBe(false);
    expect(selfTestFailure(report)).toMatchObject({ check: "self-test", key: "refs", file: refs });
  });

  it("refuses when the command never wrote its results", async () => {
    const { report } = await runWith(null);
    expect(report.verdict).toMatchObject({ ok: false, unsafe: false });
  });

  it("refuses when the worktree pointer names a gitdir outside <main>/.git/worktrees", async () => {
    const clock = new ManualClock();
    const fs = new MemoryFs("gitdir: /tmp/evil/.git\n");
    const fake = scriptedClaude(clock, {});
    const report = await runSelfTest(
      { spec: spec(), ctx: context(), runSettings: "{}" },
      { spawn: fake.spawn, clock, fs, sessionId: SELF_TEST_SESSION },
    );
    expect(report.verdict).toMatchObject({ ok: false, unsafe: true, probe: "pointer" });
    expect(selfTestFailure(report)?.file).toBe(`${WORKDIR}/.git`);
    expect(fake.calls).toEqual([]);
  });
});

// The live recordings of AC #8. The maintainer captures them on the branch with
// `bun run recordings:capture <name>`; until a recording is committed its test is skipped.
describe("(unit) live safety recordings", () => {
  for (const [name, probes] of Object.entries(PROBE_GROUPS)) {
    const present = existsSync(join(RECORDINGS_DIR, name, "meta.json"));
    it.skipIf(!present)(`${name}: the session ran and the sandbox refused the probe`, async () => {
      const recording = loadRecording(name);
      const checks = recording.meta["checks"] as { disk: SelfTestDisk; verdict: unknown };
      const run = await replay(recording);
      const denied = run.events.flatMap((event) => (event.t === "denied" ? [event.tool] : []));
      const verdict = judgeSelfTest({
        probes,
        outcome: run.result.outcome,
        denied,
        disk: checks.disk,
      });
      expect(verdict.ok).toBe(true);
      expect(checks.verdict).toEqual(verdict);
    });
  }
});
