// Verify and commit at In Review (DIPO-49 test plan), fast and local: the pure rules (scope check
// with lockfile pairing, gate changes, the verify plan, the commit subject, the backstop compare),
// and the flow through run control on a migrated state database with a fake story git, a fake
// sandboxed step and scripted worker turns. The same flow on real git, the pinned Backlog CLI and
// a bare remote is in verify-commit.ci.test.ts.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { StoryId, type WorkRef } from "@dipsaus-orchestrator/contract";

import { OFFICE_DEFAULTS, type OfficeConfig } from "../../src/config";
import { GitError } from "../../src/git";
import {
  backstopEvidence,
  type BackstopSnapshot,
  checkScope,
  dependencyFiles,
  feedbackItemMax,
  workspaceDirsOf,
  commitMessage,
  findRun,
  gateChanges,
  insertRun,
  RunControl,
  runIntents,
  runOutcome,
  runSummary,
  scopeDetail,
  type StoryGit,
  VerifyCommit,
  verifyPlan,
  verifyResults,
} from "../../src/run";
import type { StepRequest, StepResult } from "../../src/sandbox/step";
import { detect, type RunProfile } from "../../src/scan/detect";
import { addStory } from "../../src/stories/keys";
import { encode } from "../../src/workers/claude-cli/encode";
import type { HostOp, WorkerEvent, WorkerReport } from "../../src/workers/types";
import { TASK_FIELD_ERROR } from "../../src/backlog/runner";
import { findClaim, insertClaim } from "../../src/worktree/records";
import { type IngestFixture, ingestFixture, loggedEvents } from "../ingest/helpers";

function profileOf(scripts: Record<string, string>, workspaces: string[] = []): RunProfile {
  return detect({
    texts: {
      "package.json": JSON.stringify({
        name: "p",
        packageManager: "bun@1.4.2",
        scripts,
        workspaces,
      }),
      ...Object.fromEntries(
        workspaces.map((dir) => [`${dir}/package.json`, JSON.stringify({ name: dir })]),
      ),
    },
    lockfiles: ["bun.lock"],
    workspaceDirs: workspaces,
    configImports: {},
    envFiles: [],
  });
}

const SNAP: BackstopSnapshot = {
  head: "c".repeat(40),
  branch: "refs/heads/DIPO-1/add-a-greeting",
  stash: "",
  backlogStatus: "",
};

describe("rules", () => {
  it("checks every changed path against scope, the task file and paired lockfiles", () => {
    const result = checkScope({
      paths: [
        "src/a.ts",
        "packages/export/package.json",
        "packages/export/bun.lock",
        "bun.lock",
        "backlog/tasks/dipo-1 - A.md",
        "README.md",
        "srcx/b.ts",
      ],
      scope: ["src/", "packages/export"],
      taskFile: "backlog/tasks/dipo-1 - A.md",
      workspaceDirs: ["packages/export"],
    });
    expect(result.code).toEqual([
      "bun.lock",
      "packages/export/bun.lock",
      "packages/export/package.json",
      "src/a.ts",
    ]);
    expect(result.outside).toEqual(["README.md", "srcx/b.ts"]);
    // Without an in-scope manifest a lockfile is outside scope.
    expect(checkScope({ paths: ["bun.lock"], scope: ["src/"], taskFile: "t" }).outside).toEqual([
      "bun.lock",
    ]);
  });

  it("exempts only the story's own task file from scope", () => {
    const own = "backlog/tasks/dipo-185 - State-the-exemption.md";
    const other = "backlog/tasks/dipo-184 - Another-story.md";
    const result = checkScope({
      paths: [own, other, "backlog/config.yml", "backlog/decisions/0001-x.md", "src/a.ts"],
      scope: ["src/"],
      taskFile: own,
    });
    expect(result.code).toEqual(["src/a.ts"]);
    expect(result.outside).toEqual([
      "backlog/config.yml",
      "backlog/decisions/0001-x.md",
      "backlog/tasks/dipo-184 - Another-story.md",
    ]);
    expect(result.code).not.toContain(own);
    expect(result.outside).not.toContain(own);
  });

  it("says in the scope-violation detail that the story's own task file is exempt", () => {
    const detail = scopeDetail(["README.md"], ["src/"]);
    expect(detail).toBe(
      "Paths written outside the declared scope: README.md. Declared scope: src/. The story's own task file, written by dipo, is exempt from scope.",
    );
    expect(scopeDetail(["README.md"], [])).toContain("Declared scope: none.");
  });

  it("lists gate script and command changes, and runs the base verify only when it differs", () => {
    const base = profileOf({ verify: "bun test", test: "bun test" });
    const same = gateChanges({
      baseScripts: { verify: "bun test" },
      branchScripts: { verify: "bun test" },
      base,
      branch: base,
    });
    expect(same).toEqual([]);
    const branch = profileOf({ lint: "true", test: "true" });
    const changes = gateChanges({
      baseScripts: { verify: "bun test", test: "bun test" },
      branchScripts: { lint: "true", test: "true" },
      base,
      branch,
    });
    expect(changes).toContain('scripts.verify: "bun test" -> none');
    expect(changes).toContain('scripts.test: "bun test" -> "true"');
    expect(changes.some((line) => line.startsWith("verify: bun run verify -> "))).toBe(true);
    expect(verifyPlan({ base, branch, changed: true }).map((s) => s.profile)).toEqual([
      "branch",
      "base",
    ]);
    expect(verifyPlan({ base, branch: base, changed: true }).map((s) => s.profile)).toEqual([
      "branch",
    ]);
  });

  it("builds the commit subject from the worker's proposal and the story id", () => {
    expect(commitMessage("DIPO-1", "print a greeting\nmore", "Title")).toBe(
      "DIPO-1: print a greeting",
    );
    expect(commitMessage("DIPO-1", "DIPO-1: print it", "Title")).toBe("DIPO-1: print it");
    expect(commitMessage("DIPO-1", "  ", "Add a greeting")).toBe("DIPO-1: Add a greeting");
  });

  it("names every change of the backstop snapshot", () => {
    expect(backstopEvidence(SNAP, SNAP)).toEqual([]);
    const evidence = backstopEvidence(SNAP, {
      head: "d".repeat(40),
      branch: "",
      stash: "e".repeat(40),
      backlogStatus: " M backlog/tasks/x.md\0",
    });
    expect(evidence).toHaveLength(4);
    expect(evidence[1]).toContain("to a detached HEAD");
    expect(evidence[3]).toContain(" M backlog/tasks/x.md");
  });
});

// ---- the flow through run control -----------------------------------------------------------------

interface World {
  readonly dir: string;
  readonly f: IngestFixture;
  readonly control: RunControl;
  readonly work: WorkRef;
  readonly sent: HostOp[][];
  readonly calls: string[];
  readonly steps: StepRequest[];
  changed: string[];
  snapshot: BackstopSnapshot;
  exitCodes: number[];
  startFailed: string | null;
  base: RunProfile;
  branch: RunProfile;
  branchScripts: string | null;
  config?: OfficeConfig;
  scanFails?: boolean;
  /** Called inside every verify step, while the capped done path is running. */
  duringStep?: () => void;
  pushRejected: boolean;
  /** A push failure that is not a rejection, such as a network error. */
  pushError?: string;
  /** The story's task file holds fields dipo does not know (DIPO-270). */
  taskFieldRefused?: boolean;
}

const TASK_FILE = "backlog/tasks/dipo-1 - Add-a-greeting.md";
let w: World;

function fakeStoryGit(world: () => World): StoryGit {
  return {
    snapshot: async () => world().snapshot,
    changedPaths: async () => world().changed,
    story: async () => {
      if (world().taskFieldRefused === true) {
        throw new GitError(TASK_FIELD_ERROR, "dipo refuses DIPO-1's task file: unknown fields.");
      }
      return {
        taskFile: TASK_FILE,
        title: "Add a greeting",
        status: "In Progress",
        criteria: [1, 2],
      };
    },
    showAt: async () => JSON.stringify({ scripts: { verify: "bun test" } }),
    commitPaths: async (_o, _w, paths, message) => {
      world().calls.push(`commit ${message} [${paths.join(", ")}]`);
      return "f".repeat(40);
    },
    codeTreeKey: async () => "k".repeat(64),
    markInReview: async (_o, input) => {
      world().calls.push(`in-review [${input.criteria.join(", ")}]`);
      return "a".repeat(40);
    },
    push: async (_o, branch) => {
      world().calls.push(`push ${branch}`);
      const { pushError } = world();
      if (pushError !== undefined) return { pushed: false, rejected: false, error: pushError };
      return world().pushRejected
        ? { pushed: false, rejected: true, error: "pushing failed ([rejected] non-fast-forward)" }
        : { pushed: true, rejected: false, error: null };
    },
    diffstat: async (_o, _w, from, branch) => {
      if (branch !== undefined) world().calls.push(`diffstat ${from}..${branch}`);
      return " src/greet.ts | 2 +-\n 1 file changed";
    },
    changedFiles: async (_o, branch, from) => {
      world().calls.push(`changed files ${from}..${branch}`);
      return [];
    },
  };
}

beforeEach(async () => {
  const dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "verify-commit-"));
  const f = await ingestFixture(dir);
  const base = profileOf({ verify: "bun test" });
  const world = {
    dir,
    f,
    sent: [],
    calls: [],
    steps: [],
    changed: ["src/greet.ts"],
    snapshot: SNAP,
    exitCodes: [0],
    startFailed: null,
    base,
    branch: base,
    branchScripts: null,
    pushRejected: false,
  } as unknown as World;
  const config: OfficeConfig = {
    ...OFFICE_DEFAULTS,
    timeouts: { ...OFFICE_DEFAULTS.timeouts },
  };
  const finisher = new VerifyCommit({
    clock: f.t.clock,
    story: fakeStoryGit(() => w),
    mainCheckout: () => join(dir, "main"),
    runStep: async (request): Promise<StepResult> => {
      w.steps.push(request);
      w.duringStep?.();
      if (w.startFailed !== null) return { outcome: "startFailed", reason: w.startFailed };
      const code = w.exitCodes.shift() ?? 0;
      const text =
        code === 0
          ? "1 pass\n"
          : `error: expected 1 to be 2\n      at <anonymous> (${join(dir, "trees", "DIPO-1", "test", "greet.test.ts")}:7:15)\n1 fail\n`;
      request.onOutput?.(text);
      return {
        outcome: "exited",
        code,
        signal: null,
        timedOut: false,
        stdout: { text, truncated: false },
        stderr: { text: "", truncated: false },
        warnings: [],
      };
    },
    config: () => w.config ?? config,
    profile: () => w.base,
    scanWorktree: async () => {
      if (w.scanFails) throw new Error("git ls-files failed");
      return w.branch;
    },
    host: { home: dir, uid: 501, env: { PATH: "/usr/bin:/bin" } },
  });
  const control = new RunControl({
    clock: f.t.clock,
    offices: { get: () => f.office },
    writer: {
      write: async () => ({
        commit: "c".repeat(40),
        lastGoodCommit: "a".repeat(40),
        from: "In Progress",
        pushed: true,
        pushError: null,
      }),
    },
    steering: {
      send: async (_office, _run, ops) => {
        w.sent.push([...ops]);
        return { ok: true };
      },
    },
    encode,
    finisher,
  });
  (world as { control: RunControl }).control = control;
  const { office, run } = f;
  const { key } = office.immediate(() =>
    addStory(office, f.t.ids, { story: StoryId.parse("DIPO-1") }, f.t.clock.now()),
  );
  (world as { work: WorkRef }).work = { ...f.work, key };
  w = world;
  office.immediate(() => {
    insertRun(office, {
      runId: run,
      kind: "story",
      key,
      story: "DIPO-1",
      tier: "S",
      role: "developer",
      model: "haiku",
      startSha: "b".repeat(40),
      branch: "DIPO-1/add-a-greeting",
      worktree: join(dir, "trees", "DIPO-1"),
      slot: 1,
      budgetUnit: "tokens",
      budgetLimit: 300_000,
      loopCap: 2,
      reviewRoundCap: null,
      configHash: "h",
      overrideKeys: null,
      runProfileId: null,
      startedAt: f.t.clock.now(),
      scope: ["src/", "test/"],
    });
    insertClaim(office, {
      runId: run,
      key,
      story: "DIPO-1",
      branch: "DIPO-1/add-a-greeting",
      worktree: join(dir, "trees", "DIPO-1"),
      base: "main",
      baseSha: "b".repeat(40),
      startSha: "b".repeat(40),
      claimSha: "c".repeat(40),
      reused: false,
      snapshot: { path: "/x", adminDir: "/x", commondir: "/x", gitdir: "/x", pointer: "/x" },
      firstFeedback: null,
      claimedAt: f.t.clock.now(),
    });
  });
  control.track(office.officeId, {
    runId: run,
    work: w.work,
    caps: { budgetTokens: 300_000, maxTurns: 100, maxMinutes: 30 },
    startedAt: f.t.clock.now(),
    snapshot: SNAP,
  });
});

afterEach(() => {
  w.control.close();
  w.f.t.state.close();
  rmSync(w.dir, { recursive: true, force: true });
});

const DONE: WorkerReport = {
  status: "done",
  criteria: [
    { n: 1, met: true, evidence: "tested" },
    { n: 2, met: false, evidence: "not yet" },
    { n: 9, met: true, evidence: "no such criterion" },
  ],
  summary: "Prints a greeting.",
  commitSubject: "print a greeting",
};

function turn(report: WorkerReport | null): WorkerEvent {
  return { t: "turn", report, totals: {}, numTurns: 1, terminal: "success" };
}

async function play(report: WorkerReport | null = DONE): Promise<void> {
  w.control.onWorkerEvents(w.f.run, [turn(report)]);
  await w.control.idle();
}

function events(type: string): Record<string, unknown>[] {
  return loggedEvents(w.f.office)
    .filter((event) => event.type === type)
    .map((event) => event.data as Record<string, unknown>);
}

function parks(): { reason: string; cause: string | null; detail: string }[] {
  return w.f.office.all("select reason, cause, detail from parks where office_id = $office_id");
}

describe("review fixes", () => {
  it("budgets the feedback item by the run's tier, M when the tier has none", () => {
    const config = {
      ...OFFICE_DEFAULTS,
      prompt: {
        ...OFFICE_DEFAULTS.prompt,
        budgets: {
          ...OFFICE_DEFAULTS.prompt.budgets,
          feedbackItem: { S: 500, M: 3_000, L: 4_000, XL: 5_000 },
        },
      },
    } as OfficeConfig;
    expect(feedbackItemMax(config, "S")).toBe(500);
    expect(feedbackItemMax(config, "L")).toBe(4_000);
    expect(feedbackItemMax(config, "Q")).toBe(3_000);
    expect(feedbackItemMax(config, null)).toBe(3_000);
  });

  it("sends a feedback item within the S tier budget", async () => {
    w.config = {
      ...OFFICE_DEFAULTS,
      prompt: {
        ...OFFICE_DEFAULTS.prompt,
        budgets: {
          ...OFFICE_DEFAULTS.prompt.budgets,
          feedbackItem: { ...OFFICE_DEFAULTS.prompt.budgets.feedbackItem, S: 300 },
        },
      },
    } as OfficeConfig;
    w.exitCodes = [1];
    await play();
    const message = w.sent[0]?.[0];
    const line = message !== undefined && "write" in message ? message.write : "{}";
    const text = (JSON.parse(line) as { message: { content: string } }).message.content;
    expect(text.length).toBeLessThanOrEqual(300);
  });

  it("pairs the root lockfile with a workspace package the branch adds", async () => {
    w.branch = profileOf({ verify: "bun test" }, ["src/pkg"]);
    expect(workspaceDirsOf(w.base, w.branch)).toEqual(["src/pkg"]);
    w.changed = ["src/pkg/package.json", "src/pkg/index.ts", "bun.lock"];
    await play();
    expect(parks()).toEqual([]);
    expect(w.calls[0]).toBe(
      "commit DIPO-1: print a greeting [bun.lock, src/pkg/index.ts, src/pkg/package.json]",
    );
  });
});

describe("a failed branch scan", () => {
  it("keeps the scope-violation park, pairing with the base workspaces", async () => {
    w.scanFails = true;
    w.changed = ["src/greet.ts", "README.md"];
    await play();
    expect(parks().map((p) => p.reason)).toEqual(["scope-violation"]);
    expect(parks()[0]?.detail).toContain("README.md");
  });

  it("surfaces the scan error when every path is in scope", async () => {
    w.scanFails = true;
    await play();
    expect(parks()).toEqual([]);
    expect(w.steps).toEqual([]);
    expect(w.calls).toEqual([]);
  });
});

describe("verify and commit", () => {
  it("green: commits the scope paths, checks off met criteria, moves to In Review and pushes", async () => {
    w.changed = ["src/greet.ts", "test/greet.test.ts", TASK_FILE];
    await play();
    expect(w.calls).toEqual([
      "commit DIPO-1: print a greeting [src/greet.ts, test/greet.test.ts]",
      "in-review [1]",
      "push DIPO-1/add-a-greeting",
    ]);
    // Verify ran sandboxed with the verify policy and the run environment.
    expect(w.steps.map((s) => [s.kind, s.script, s.command.join(" ")])).toEqual([
      ["verify", "verify", "bun run verify"],
    ]);
    expect(w.steps[0]?.extraEnv?.["DIPO_STORY"]).toBe("DIPO-1");
    const [result] = verifyResults(w.f.office, w.f.run);
    expect(result?.passed).toBe(true);
    expect(result?.exitCode).toBe(0);
    expect(result?.codeTreeKey).toBe("k".repeat(64));
    expect(result?.outputTo).toBeGreaterThan(result?.outputFrom ?? 0);
    // work.phase verify, then the output as work.output with source verify.
    expect(events("work.phase").map((e) => e["phase"])).toEqual(["verify"]);
    const outputs = events("work.output");
    expect(outputs.map((e) => e["source"])).toEqual(["verify"]);
    expect(outputs[0]?.["text"]).toContain("1 pass");
    // story.state to In Review; the run ended with its outcome and summary; stdin closed.
    const [state] = events("story.state");
    expect([state?.["from"], state?.["to"]]).toEqual(["In Progress", "In Review"]);
    const run = findRun(w.f.office, w.f.run);
    expect(run?.endKind).toBe("in-review");
    expect(w.sent).toEqual([[{ closeStdin: true }]]);
    const outcome = runOutcome(w.f.office, w.f.run);
    expect(outcome).toMatchObject({
      outcome: "in-review",
      parkReasons: [],
      tier: "S",
      role: "developer",
      model: "haiku",
      loops: 0,
      verifyFailures: 0,
      scopeSize: 2,
    });
    const summary = runSummary(w.f.office, w.f.run);
    expect(summary?.report?.commitSubject).toBe("print a greeting");
    expect(summary?.diffstat).toContain("1 file changed");
    expect(summary?.verify?.passed).toBe(true);
    expect(summary?.outputTail).toContain("1 pass");
  });

  it("red below the cap sends feedback with file:line, then parks verify-failing at the cap", async () => {
    w.exitCodes = [1, 1];
    await play();
    expect(parks()).toEqual([]);
    expect(w.sent).toHaveLength(1);
    const message = w.sent[0]?.[0];
    const text = message !== undefined && "write" in message ? message.write : "";
    expect(text).toContain("test/greet.test.ts:7:15");
    expect(text).toContain("Exit code: 1");
    expect(runIntents(w.f.office, w.f.run).map((i) => [i.kind, i.state])).toEqual([
      ["steer", "sent"],
    ]);
    const progress = events("work.phase").at(-1)?.["progress"] as Record<string, unknown>;
    expect(events("work.phase").map((e) => e["phase"])).toEqual(["verify", "build"]);
    expect([progress["loop"], progress["verify"]]).toEqual([1, "failing"]);

    await play();
    expect(parks().map((p) => [p.reason, p.cause])).toEqual([["verify-failing", "loops"]]);
    expect(parks()[0]?.detail).toContain("verify failed 2 of 2 times");
    expect(parks()[0]?.detail).toContain("test/greet.test.ts:7:15");
    expect(w.calls).toEqual([]);
    const outcome = runOutcome(w.f.office, w.f.run);
    expect(outcome).toMatchObject({
      outcome: "parked",
      parkReasons: ["verify-failing"],
      loops: 1,
      verifyFailures: 2,
    });
    expect(runSummary(w.f.office, w.f.run)?.verify?.passed).toBe(false);
  });

  it("parks scope-violation with the paths outside scope at done", async () => {
    w.changed = ["src/greet.ts", "README.md", "package.json"];
    await play();
    expect(parks().map((p) => [p.reason, p.cause])).toEqual([["scope-violation", "paths"]]);
    expect(parks()[0]?.detail).toBe(
      "Paths written outside the declared scope: README.md, package.json. Declared scope: src/, test/. The story's own task file, written by dipo, is exempt from scope.",
    );
    expect(w.steps).toEqual([]);
    expect(runOutcome(w.f.office, w.f.run)?.parkReasons).toEqual(["scope-violation"]);
  });

  it("parks scope-violation, commits nothing and runs no verify when the task file holds fields dipo does not know", async () => {
    w.taskFieldRefused = true;
    await play();
    expect(parks().map((p) => [p.reason, p.cause])).toEqual([["scope-violation", "task-file"]]);
    expect(parks()[0]?.detail).toContain("unknown fields");
    expect(w.steps).toEqual([]);
    expect(w.calls).toEqual([]);
  });

  it("parks scope-violation when a turn moved HEAD, whatever the report", async () => {
    w.snapshot = { ...SNAP, head: "9".repeat(40) };
    await play(null);
    expect(parks().map((p) => [p.reason, p.cause])).toEqual([["scope-violation", "backstop"]]);
    expect(parks()[0]?.detail).toContain(`HEAD moved from ${"c".repeat(40)} to ${"9".repeat(40)}`);
  });

  it("runs the base verify too when the branch changed a gate script, and records the changes", async () => {
    w.branch = profileOf({ test: "bun test" });
    await play();
    expect(w.steps.map((s) => s.command.join(" "))).toEqual(["bun run test", "bun run verify"]);
    expect(verifyResults(w.f.office, w.f.run).map((r) => r.profile)).toEqual(["branch", "base"]);
    const run = findRun(w.f.office, w.f.run);
    expect(run?.gateChanges?.some((line) => line.startsWith("verify: bun run verify ->"))).toBe(
      true,
    );
  });

  it("never runs verify unsandboxed: a refused sandbox parks verify-failing", async () => {
    w.startFailed = "sandbox unavailable: rg not found";
    await play();
    expect(parks().map((p) => [p.reason, p.cause, p.detail])).toEqual([
      ["verify-failing", "refused", "verify could not run: sandbox unavailable: rg not found"],
    ]);
  });

  it("parks conflict when the push is rejected as non-fast-forward", async () => {
    w.pushRejected = true;
    await play();
    expect(parks().map((p) => [p.reason, p.cause])).toEqual([["conflict", "push-rejected"]]);
    expect(events("story.state").map((e) => e["to"])).toEqual(["Parked"]);
  });

  it("records the In Review push on the claim at the run's end (DIPO-144)", async () => {
    await play();
    const run = findRun(w.f.office, w.f.run);
    expect(run?.endKind).toBe("in-review");
    expect(findClaim(w.f.office, w.f.run)?.pushedAt).toBe(run?.endedAt ?? -1);
  });

  it("leaves the claim's push unrecorded when the In Review push fails (DIPO-144)", async () => {
    w.pushError = "pushing failed (network is down)";
    await play();
    expect(findRun(w.f.office, w.f.run)?.endKind).toBe("in-review");
    expect(findClaim(w.f.office, w.f.run)?.pushedAt).toBeNull();
  });

  it("writes an outcome row for a budget-exceeded park too", async () => {
    w.control.close();
    const control = new RunControl({
      clock: w.f.t.clock,
      offices: { get: () => w.f.office },
      writer: {
        write: async () => ({
          commit: null,
          lastGoodCommit: "a".repeat(40),
          from: "In Progress",
          pushed: true,
          pushError: null,
        }),
      },
      steering: { send: async () => ({ ok: true }) },
      encode,
    });
    control.track(w.f.office.officeId, {
      runId: w.f.run,
      work: w.work,
      caps: { budgetTokens: 1, maxTurns: 100, maxMinutes: 1 },
      startedAt: w.f.t.clock.now(),
    });
    w.f.t.clock.advance(2 * 60_000);
    await control.idle();
    control.close();
    expect(runOutcome(w.f.office, w.f.run)).toMatchObject({
      outcome: "parked",
      parkReasons: ["budget-exceeded"],
      minutes: 2,
    });
  });
});

describe("dependency files (DIPO-84)", () => {
  it("finds manifests, lockfiles and requirements files anywhere in the tree", () => {
    expect(
      dependencyFiles([
        "src/greet.ts",
        "package.json",
        "packages/a/package.json",
        "bun.lock",
        "bun.lockb",
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "requirements.txt",
        "py/requirements-dev.txt",
        "pyproject.toml",
        "poetry.lock",
        "uv.lock",
        "docs/package.json.md",
        "requirements.md",
        "src/requirements.txt.bak",
      ]),
    ).toEqual([
      "bun.lock",
      "bun.lockb",
      "package-lock.json",
      "package.json",
      "packages/a/package.json",
      "pnpm-lock.yaml",
      "poetry.lock",
      "py/requirements-dev.txt",
      "pyproject.toml",
      "requirements.txt",
      "uv.lock",
      "yarn.lock",
    ]);
    expect(dependencyFiles(["src/greet.ts", "README.md"])).toEqual([]);
  });

  it("raises a notice on the run and story naming the committed dependency files", async () => {
    w.changed = ["src/greet.ts", "src/package.json", "src/bun.lock", "test/greet.test.ts"];
    await play();
    expect(w.calls[0]).toBe(
      "commit DIPO-1: print a greeting [src/bun.lock, src/greet.ts, src/package.json, test/greet.test.ts]",
    );
    const notices = loggedEvents(w.f.office).filter(
      (event) =>
        event.type === "engine.notice" &&
        (event.data as { code?: string }).code === "verify.dependenciesChanged",
    );
    expect(notices).toHaveLength(1);
    // On the run and the story.
    const rows = w.f.office.all<{ run_id: string | null; key: string | null }>(
      "select run_id, key from change_log where office_id = $office_id and type = 'engine.notice'",
    );
    expect(rows).toEqual([{ run_id: w.f.run, key: w.work.key }]);
    expect(notices[0]?.data).toEqual({
      level: "warn",
      code: "verify.dependenciesChanged",
      text: "DIPO-1 changed dependency files: src/bun.lock, src/package.json. Review the added or changed packages before you merge.",
    });
  });

  it("raises no notice when no dependency file changed", async () => {
    w.changed = ["src/greet.ts"];
    await play();
    expect(
      events("engine.notice").filter((n) => n["code"] === "verify.dependenciesChanged"),
    ).toEqual([]);
  });
});

// ---- a done report on the turn that crosses a cap (DIPO-205) --------------------------------------

const MODEL = "claude-haiku-5-5";
const setRun = (column: "max_turns" | "budget_limit" | "loop_cap", value: number): void => {
  w.f.office.run(
    `update runs set ${column} = $value where office_id = $office_id and run_id = $run`,
    { value, run: w.f.run },
  );
};
const capSteps = () =>
  w.f.office.all<{ value: string }>(
    `select value from run_steps where office_id = $office_id and run_id = $run
      and kind = 'cap'`,
    { run: w.f.run },
  );
/**
 * One ingestion pass as run control sees it: the usage the events folded in is stored, then
 * every `usage` and `turn` event is applied (the cap marks) before the pass is handled.
 */
async function pass(
  pending: readonly WorkerEvent[],
  used: { readonly turns: number; readonly tokens: number },
): Promise<void> {
  w.f.office.immediate(() => {
    w.f.office.run(
      `insert or ignore into agents (office_id, agent_id, run_id, role, model, session_id,
         started_at) values ($office_id, $agent, $run, 'developer', $model, 's-1', 0)`,
      { agent: w.f.agent, run: w.f.run, model: MODEL },
    );
    w.f.office.run(
      `insert into usage_totals (office_id, run_id, agent_id, model, role, tier, input, turns,
         updated_at)
       values ($office_id, $run, $agent, $model, 'developer', 'S', $tokens, $turns, 0)`,
      { agent: w.f.agent, run: w.f.run, model: MODEL, tokens: used.tokens, turns: used.turns },
    );
  });
  for (const event of pending) {
    if (event.t === "usage" || event.t === "turn") w.control.onEventApplied(w.f.run, event);
  }
  w.control.onWorkerEvents(w.f.run, pending);
  await w.control.idle();
}
const usage = (input: number): WorkerEvent => ({
  t: "usage",
  messageId: "msg-1",
  model: MODEL,
  input,
  output: 0,
  cacheCreate: 0,
  cacheCreate5m: 0,
  cacheCreate1h: 0,
  cacheRead: 0,
});
const feedbackSent = () => w.sent.flat().some((op) => "write" in op);
const committed = [
  "commit DIPO-1: print a greeting [src/greet.ts]",
  "in-review [1]",
  "push DIPO-1/add-a-greeting",
];

describe("a done report on the turn that crosses a cap (DIPO-205)", () => {
  it("takes the done path on the turn that reaches the engine turn cap and records the cap", async () => {
    setRun("max_turns", 1);
    await pass([turn(DONE)], { turns: 1, tokens: 10 });
    expect(parks()).toEqual([]);
    expect(w.calls).toEqual(committed);
    expect(findRun(w.f.office, w.f.run)?.endKind).toBe("in-review");
    expect(capSteps()).toEqual([{ value: "maxTurns: turn cap reached: 1 of 1 turns" }]);
    expect(runIntents(w.f.office, w.f.run).map((i) => i.kind)).not.toContain("cap");
  });

  it("takes the done path on the turn that reaches the token budget and records the cap", async () => {
    setRun("budget_limit", 1_000);
    await pass([turn(DONE)], { turns: 1, tokens: 2_000 });
    expect(parks()).toEqual([]);
    expect(w.calls).toEqual(committed);
    expect(findRun(w.f.office, w.f.run)?.endKind).toBe("in-review");
    expect(capSteps().map((step) => step.value)).toEqual([
      "budgetTokens: token budget reached: 2,000 of 1,000 budget tokens (input, output and cache creation)",
    ]);
  });

  it("takes the done path when the crossing usage event comes before the done turn in one pass", async () => {
    setRun("budget_limit", 1_000);
    await pass([usage(2_000), turn(DONE)], { turns: 1, tokens: 2_000 });
    expect(parks()).toEqual([]);
    expect(w.calls).toEqual(committed);
    expect(capSteps()).toHaveLength(1);
  });

  it("takes the done path on a done turn that ended at the CLI --max-turns backstop", async () => {
    const capped: WorkerEvent = {
      t: "turn",
      report: DONE,
      totals: {},
      numTurns: 61,
      terminal: "max_turns",
      capped: "turn cap (--max-turns) after 61 turns",
    };
    w.control.onWorkerEvents(w.f.run, [capped]);
    await w.control.idle();
    expect(parks()).toEqual([]);
    expect(w.calls).toEqual(committed);
    expect(findRun(w.f.office, w.f.run)?.endKind).toBe("in-review");
    expect(capSteps()).toEqual([{ value: "maxTurns: turn cap (--max-turns) after 61 turns" }]);
  });

  it("parks verify-failing with cause capped when that verify fails, and sends no feedback turn", async () => {
    setRun("max_turns", 1);
    w.exitCodes = [1];
    await pass([turn(DONE)], { turns: 1, tokens: 10 });
    expect(parks().map((p) => [p.reason, p.cause])).toEqual([["verify-failing", "capped"]]);
    expect(parks()[0]?.detail).toContain("Exit code: 1");
    expect(parks()[0]?.detail).toContain("test/greet.test.ts:7:15");
    expect(feedbackSent()).toBe(false);
    expect(w.sent).toEqual([[{ closeStdin: true }]]);
    expect(w.calls).toEqual([]);
    expect(capSteps()).toHaveLength(1);
  });

  it("lets capped win over loops when the same verify reaches the loop cap", async () => {
    setRun("max_turns", 1);
    setRun("loop_cap", 1);
    w.exitCodes = [1];
    await pass([turn(DONE)], { turns: 1, tokens: 10 });
    expect(parks().map((p) => [p.reason, p.cause])).toEqual([["verify-failing", "capped"]]);
    expect(feedbackSent()).toBe(false);
  });

  it("still parks budget-exceeded with the cap detail when the crossing turn has no done report", async () => {
    setRun("max_turns", 1);
    await pass([turn(null)], { turns: 1, tokens: 10 });
    expect(parks().map((p) => [p.reason, p.cause, p.detail])).toEqual([
      ["budget-exceeded", "build", "turn cap reached: 1 of 1 turns"],
    ]);
    expect(w.calls).toEqual([]);
    expect(capSteps()).toEqual([]);
  });

  it("writes no cap step while verify runs, and exactly one with the In Review end", async () => {
    setRun("max_turns", 1);
    const during: number[] = [];
    w.duringStep = () => during.push(capSteps().length);
    await pass([turn(DONE)], { turns: 1, tokens: 10 });
    expect(during).toEqual([0]);
    expect(findRun(w.f.office, w.f.run)?.endKind).toBe("in-review");
    expect(capSteps()).toHaveLength(1);
  });

  it("writes no cap step while verify runs, and exactly one with the verify-failing park", async () => {
    setRun("max_turns", 1);
    w.exitCodes = [1];
    const during: number[] = [];
    w.duringStep = () => during.push(capSteps().length);
    await pass([turn(DONE)], { turns: 1, tokens: 10 });
    expect(during).toEqual([0]);
    expect(parks().map((p) => [p.reason, p.cause])).toEqual([["verify-failing", "capped"]]);
    expect(capSteps()).toEqual([{ value: "maxTurns: turn cap reached: 1 of 1 turns" }]);
  });

  it("ends no run for a cap while the capped done path runs", async () => {
    setRun("max_turns", 1);
    await pass([turn(DONE), usage(1), turn(null)], { turns: 1, tokens: 10 });
    expect(parks()).toEqual([]);
    expect(w.calls).toEqual(committed);
  });
});
