// The base commit's verify result (DIPO-183; 0014 section 2, note of 2026-10-20) inside worktree
// setup, against a real temporary repository and a fake step runner: verify runs once, last, in the
// worktree at the base commit under the worker's read fence; the result is stored per base commit
// and configuration and reused; a verify that cannot run gives a not-known result and setup still
// succeeds; a worktree a test run dirtied is restored.

import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withBareRemote } from "@dipsaus-orchestrator/testkit";

import { OFFICE_DEFAULTS } from "../../src/config/schema";
import type { StepRequest, StepResult } from "../../src/sandbox/step";
import type { ClaimRecord, SetupDone, SetupOutcome } from "../../src/worktree";
import type { RunProfile } from "../../src/scan/detect";
import type { OfficeHandle } from "../../src/db/office";
import type { BaseVerifyFacts } from "../../src/prompts/base-verify";
import {
  baseVerifyConfigHash,
  type BoxBaseKey,
  boxBaseVerifyConfigHash,
  boxBaseVerifyFactsOf,
  boxBaseVerifyOf,
  failingTests,
  outputEnd,
} from "../../src/worktree/base-verify";
import { addOffice, openTestState } from "../commands/helpers";
import { BACKLOG_FIXTURE, BRANCH_1, inRemote } from "./helpers";
import {
  exited,
  fakeSteps,
  type Harness,
  harness,
  localClaim,
  type Options,
  product,
  runProfile,
} from "./setup-harness";

const FIXTURE = { fixture: BACKLOG_FIXTURE };

type Exited = Extract<StepResult, { outcome: "exited" }>;

/** An exited step with fields changed. */
const exit = (code: number, over: Partial<Exited> = {}): StepResult => ({
  ...(exited(code) as Exited),
  ...over,
});
const text = (value: string) => ({ text: value, truncated: false });

function done(outcome: SetupOutcome): SetupDone {
  if (!outcome.ok) throw new Error(`setup failed: ${outcome.reason}\n${outcome.log}`);
  return outcome;
}

/** Setup of the same worktree again, as a later run on the same base would see it new. */
function again(h: Harness, claim: ClaimRecord, options: Options): Promise<SetupOutcome> {
  rmSync(join(claim.worktree, ".env"), { force: true });
  return h.setup(claim, options);
}

const verifyRequests = (requests: readonly StepRequest[]) =>
  requests.filter((r) => r.script === "verify");

const stored = (h: Harness) =>
  h.s.office.get<{ n: number }>(
    "select count(*) as n from base_verifies where office_id = $office_id",
  )?.n;

const BUN_FAILURES = [
  "bun test v1.4.2",
  "\u001b[31m(fail)\u001b[0m sandbox > a worker may not read the home directory [1.20ms]",
  "(fail) worktree > setup copies the env file [0.40ms]",
  "",
  "2 fail",
  "(fail) sandbox > a worker may not read the home directory [1.20ms]",
  "(fail) worktree > setup copies the env file [0.40ms]",
].join("\n");

/** A run profile whose verify resolves to `commands`. */
function profileWith(commands: string[][]): RunProfile {
  return {
    capabilities: { verify: { status: "resolved", value: { commands, cwd: "." } } },
  } as unknown as RunProfile;
}

describe("failingTests", () => {
  it("reads bun's (fail) lines once each, without colour or timing", () => {
    expect(failingTests(BUN_FAILURES)).toEqual([
      "sandbox > a worker may not read the home directory",
      "worktree > setup copies the env file",
    ]);
  });

  it("finds nothing in the output of another runner", () => {
    expect(failingTests("FAIL src/a.test.ts\n  ✕ adds\n")).toEqual([]);
  });

  it("keeps the end of an output, without colour", () => {
    expect(outputEnd("\u001b[31mabcdef\u001b[0m\n\n", 3)).toBe("def");
  });
});

describe("the base verify in a claim", () => {
  it("runs after the worktree and before the claim commit and the push, so before the worker starts", async () => {
    await withBareRemote(async (repo) => {
      await product(repo);
      const h = await harness(repo);
      const key = h.s.key();
      const at: { script: string; branch: string; remote: string }[] = [];
      const steps = fakeSteps({}, async () => undefined);
      const options = {
        steps: {
          requests: steps.requests,
          runStep: async (request: StepRequest): Promise<StepResult> => {
            if (request.script === "verify") {
              at.push({
                script: request.script,
                branch: (await repo.git("rev-parse", BRANCH_1)).trim(),
                remote: (await inRemote(repo, "branch", "--list", BRANCH_1)).trim(),
              });
            }
            return steps.runStep(request);
          },
        },
      };

      const outcome = await h.claim(key, options);
      if (!outcome.ok) throw new Error(outcome.notice ?? "skipped");

      // At the base verify the branch was still at its start commit, the base, and not pushed.
      expect(at).toEqual([{ script: "verify", branch: outcome.claim.baseSha, remote: "" }]);
      expect(outcome.claim.startSha).toBe(outcome.claim.baseSha);
      expect(outcome.setup?.baseVerify).toEqual({ kind: "green" });
      expect(outcome.claim.claimSha).not.toBeNull();
    }, FIXTURE);
  });
});

describe("the base verify in setup", () => {
  it("runs verify last, at the base commit, under the worker's read fence, and stores green", async () => {
    await withBareRemote(async (repo) => {
      await product(repo);
      const h = await harness(repo);
      const claim = await localClaim(repo, h.s);
      const steps = fakeSteps();

      const outcome = done(await h.setup(claim, { steps }));

      expect(outcome.baseVerify).toEqual({ kind: "green" });
      const last = steps.requests.at(-1) as StepRequest;
      expect(last.script).toBe("verify");
      expect(last.command).toEqual(["bun", "run", "verify"]);
      expect(last.worktree).toBe(claim.worktree);
      expect(last.readFence?.readPaths).toEqual([
        ...OFFICE_DEFAULTS.sandbox.toolchainReadPaths,
        ...OFFICE_DEFAULTS.sandbox.allowRead,
      ]);
      // Only the base verify has the fence; install and setup steps do not.
      expect(steps.requests.filter((r) => r.readFence !== undefined)).toEqual([last]);
      expect(
        h.s.office.get<Record<string, unknown>>(
          "select base_sha, passed, failing from base_verifies where office_id = $office_id",
        ),
      ).toEqual({ base_sha: claim.baseSha, passed: 1, failing: "[]" });
    }, FIXTURE);
  });

  it("stores the failing tests of a red base, and reuses the result without running verify again", async () => {
    await withBareRemote(async (repo) => {
      await product(repo);
      const h = await harness(repo);
      const claim = await localClaim(repo, h.s);
      const red = fakeSteps({ verify: exit(1, { stderr: text(BUN_FAILURES) }) });

      const first = done(await h.setup(claim, { steps: red }));
      expect(first.baseVerify).toEqual({
        kind: "red",
        failing: [
          "sandbox > a worker may not read the home directory",
          "worktree > setup copies the env file",
        ],
        tail: null,
      });
      expect(verifyRequests(red.requests)).toHaveLength(1);

      // A later run on the same base commit and configuration: the stored result, no verify.
      const second = fakeSteps();
      const reused = done(await again(h, claim, { steps: second }));
      expect(reused.baseVerify).toEqual(first.baseVerify);
      expect(verifyRequests(second.requests)).toEqual([]);
      expect(second.requests.length).toBeGreaterThan(0);
      expect(stored(h)).toBe(1);
    }, FIXTURE);
  });

  it("stores the end of the output when no test name can be read", async () => {
    await withBareRemote(async (repo) => {
      await product(repo);
      const h = await harness(repo);
      const claim = await localClaim(repo, h.s);
      const steps = fakeSteps({
        verify: exit(1, { stdout: text("$ bun run lint\n3 warnings\n") }),
      });
      const outcome = done(await h.setup(claim, { steps }));
      expect(outcome.baseVerify).toMatchObject({ kind: "red", failing: [] });
      expect(
        h.s.office.get<{ output_tail: string }>(
          "select output_tail from base_verifies where office_id = $office_id",
        )?.output_tail,
      ).toContain("3 warnings");
    }, FIXTURE);
  });

  it("keys the stored result by the verify commands of the run profile too", () => {
    const verify = baseVerifyConfigHash(OFFICE_DEFAULTS, profileWith([["bun", "run", "verify"]]));
    // The same commands give the same key; other commands, or none resolved, give another.
    expect(baseVerifyConfigHash(OFFICE_DEFAULTS, profileWith([["bun", "run", "verify"]]))).toBe(
      verify,
    );
    expect(baseVerifyConfigHash(OFFICE_DEFAULTS, profileWith([["bun", "test"]]))).not.toBe(verify);
    expect(baseVerifyConfigHash(OFFICE_DEFAULTS, null)).not.toBe(verify);
  });

  it("runs verify again for another configuration of the same base", async () => {
    await withBareRemote(async (repo) => {
      await product(repo);
      const h = await harness(repo);
      const claim = await localClaim(repo, h.s);
      done(await h.setup(claim, { steps: fakeSteps() }));
      const steps = fakeSteps();
      done(await again(h, claim, { steps, worktree: { env: { OTHER: "1" } } }));
      expect(verifyRequests(steps.requests)).toHaveLength(1);
      expect(stored(h)).toBe(2);
    }, FIXTURE);
  });

  it("gives the not-known result and still succeeds when verify cannot start, and stores nothing", async () => {
    await withBareRemote(async (repo) => {
      await product(repo);
      const h = await harness(repo);
      const claim = await localClaim(repo, h.s);
      const steps = fakeSteps({
        verify: { outcome: "startFailed", reason: "sandbox unavailable" },
      });
      const outcome = done(await h.setup(claim, { steps }));
      expect(outcome.baseVerify).toEqual({
        kind: "unknown",
        reason: "verify did not start: sandbox unavailable",
      });
      expect(stored(h)).toBe(0);
      // The next run on the base tries again.
      const next = fakeSteps();
      expect(done(await again(h, claim, { steps: next })).baseVerify).toEqual({ kind: "green" });
      expect(verifyRequests(next.requests)).toHaveLength(1);
    }, FIXTURE);
  });

  it("gives the not-known result when verify times out or is killed", async () => {
    await withBareRemote(async (repo) => {
      await product(repo);
      const h = await harness(repo);
      const claim = await localClaim(repo, h.s);
      const timedOut = fakeSteps({ verify: exit(1, { timedOut: true }) });
      expect(done(await h.setup(claim, { steps: timedOut })).baseVerify?.kind).toBe("unknown");
      const killed = fakeSteps({ verify: exit(1, { code: null, signal: "SIGKILL" }) });
      expect(done(await again(h, claim, { steps: killed })).baseVerify).toEqual({
        kind: "unknown",
        reason: "verify ended by SIGKILL",
      });
      expect(stored(h)).toBe(0);
    }, FIXTURE);
  });

  it("gives the not-known result without running verify when the run profile has none", async () => {
    await withBareRemote(async (repo) => {
      await product(repo);
      const h = await harness(repo);
      const claim = await localClaim(repo, h.s);
      const steps = fakeSteps();
      const base = runProfile();
      const profile = {
        ...base,
        capabilities: { ...base.capabilities, verify: { status: "unresolved" as const } },
      };
      const outcome = done(await h.setup(claim, { steps, profile }));
      expect(outcome.baseVerify).toEqual({
        kind: "unknown",
        reason: "the run profile has no resolved verify",
      });
      expect(verifyRequests(steps.requests)).toEqual([]);
    }, FIXTURE);
  });

  it("gives the not-known result without running verify when the worktree is not at its base commit", async () => {
    await withBareRemote(async (repo) => {
      await product(repo);
      const h = await harness(repo);
      const claim = await localClaim(repo, h.s);
      const other = { ...claim, baseSha: "0".repeat(40) };
      const steps = fakeSteps();
      const outcome = done(await h.setup(other, { steps }));
      expect(outcome.baseVerify).toMatchObject({
        kind: "unknown",
        reason: expect.stringContaining("not at the base commit"),
      });
      expect(verifyRequests(steps.requests)).toEqual([]);
      expect(stored(h)).toBe(0);
    }, FIXTURE);
  });

  it("uses a stored result for the base even when the worktree is not at it", async () => {
    await withBareRemote(async (repo) => {
      await product(repo);
      const h = await harness(repo);
      const claim = await localClaim(repo, h.s);
      done(await h.setup(claim, { steps: fakeSteps() }));
      // A reused branch is ahead of its base: the same base sha, a worktree at another commit.
      await repo.git("-C", claim.worktree, "commit", "--allow-empty", "-m", "earlier work");
      const steps = fakeSteps();
      const outcome = done(await again(h, claim, { steps }));
      expect(outcome.baseVerify).toEqual({ kind: "green" });
      expect(verifyRequests(steps.requests)).toEqual([]);
    }, FIXTURE);
  });

  it("restores the files a test run left in the worktree", async () => {
    await withBareRemote(async (repo) => {
      await product(repo);
      const h = await harness(repo);
      const claim = await localClaim(repo, h.s);
      const steps = fakeSteps();
      const options = {
        steps: {
          requests: steps.requests,
          runStep: async (request: StepRequest): Promise<StepResult> => {
            if (request.script === "verify") {
              writeFileSync(join(request.worktree, "test-output.log"), "x");
              writeFileSync(join(request.worktree, "bun.lock"), "{ changed }\n");
            }
            return steps.runStep(request);
          },
        },
      };
      const outcome = done(await h.setup(claim, options));
      expect(outcome.baseVerify).toEqual({ kind: "green" });
      expect(existsSync(join(claim.worktree, "test-output.log"))).toBe(false);
      expect((await repo.git("-C", claim.worktree, "status", "--porcelain")).trim()).toBe("");
      // The ignored env file setup placed stays.
      expect(existsSync(join(claim.worktree, ".env"))).toBe(true);
    }, FIXTURE);
  });
});

/** An office in a migrated test state database under DIPO_TMP, removed afterwards. */
async function inState(fn: (office: OfficeHandle) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "box-base-"));
  const t = await openTestState(dir);
  try {
    await fn(addOffice(t));
  } finally {
    t.state.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the base in the box (DIPO-294)", () => {
  const START = "s".repeat(40);
  const BOX: BoxBaseKey = { image: `dipo-box:${"1".repeat(64)}`, files: [".env"] };
  const PROFILE = profileWith([["bun", "run", "verify"]]);
  const RED: BaseVerifyFacts = { kind: "red", failing: ["git > reads the log"], tail: null };

  function once(
    office: OfficeHandle,
    over: { box?: BoxBaseKey; startSha?: string; result?: BaseVerifyFacts } = {},
  ) {
    let runs = 0;
    const result = boxBaseVerifyOf({
      office,
      startSha: over.startSha ?? START,
      box: over.box ?? BOX,
      config: OFFICE_DEFAULTS,
      profile: PROFILE,
      runId: "run_1",
      now: () => 1,
      run: async () => {
        runs += 1;
        return over.result ?? RED;
      },
    });
    return result.then((value) => ({ ...value, runs }));
  }

  it("runs verify once for a key and reuses the stored result without running it again", () =>
    inState(async (office) => {
      expect(await once(office)).toEqual({ facts: RED, reused: false, runs: 1 });
      expect(await once(office)).toEqual({ facts: RED, reused: true, runs: 0 });
      // The verdict at done and a resumed session read the same stored result.
      expect(
        boxBaseVerifyFactsOf(office, {
          startSha: START,
          box: BOX,
          config: OFFICE_DEFAULTS,
          profile: PROFILE,
        }),
      ).toEqual(RED);
    }));

  it("keys the result by start commit, image, listed files, install and verify configuration", () =>
    inState(async (office) => {
      await once(office);
      expect(
        (await once(office, { box: { ...BOX, image: `dipo-box:${"2".repeat(64)}` } })).runs,
      ).toBe(1);
      expect((await once(office, { box: { ...BOX, files: [] } })).runs).toBe(1);
      expect((await once(office, { startSha: "t".repeat(40) })).runs).toBe(1);
      const hash = boxBaseVerifyConfigHash(OFFICE_DEFAULTS, PROFILE, BOX);
      expect(
        boxBaseVerifyConfigHash(OFFICE_DEFAULTS, profileWith([["bun", "test"]]), BOX),
      ).not.toBe(hash);
      const installing = {
        capabilities: {
          ...PROFILE.capabilities,
          install: {
            status: "resolved",
            value: { commands: [["bun", "install", "--frozen-lockfile"]], cwd: "." },
          },
        },
      } as unknown as RunProfile;
      expect(boxBaseVerifyConfigHash(OFFICE_DEFAULTS, installing, BOX)).not.toBe(hash);
      const longer = {
        ...OFFICE_DEFAULTS,
        timeouts: {
          ...OFFICE_DEFAULTS.timeouts,
          scriptMinutes: { ...OFFICE_DEFAULTS.timeouts.scriptMinutes, install: 45 },
        },
      };
      expect(boxBaseVerifyConfigHash(longer, PROFILE, BOX)).not.toBe(hash);
      // Never the Mac result's key, so the two never meet.
      expect(baseVerifyConfigHash(OFFICE_DEFAULTS, PROFILE)).not.toBe(hash);
    }));

  it("stores no not-known result, so the next run tries again, and says not known without one", () =>
    inState(async (office) => {
      const first = await once(office, {
        result: { kind: "unknown", reason: "the box stopped while verify ran" },
      });
      expect(first.facts.kind).toBe("unknown");
      expect((await once(office)).runs).toBe(1);
      expect(
        boxBaseVerifyFactsOf(office, {
          startSha: START,
          box: null,
          config: OFFICE_DEFAULTS,
          profile: PROFILE,
        }).kind,
      ).toBe("unknown");
    }));

  it("never stores a red result without a named failing test: it is not known, and runs again", () =>
    inState(async (office) => {
      const nameless: BaseVerifyFacts = { kind: "red", failing: [], tail: "Cannot find module" };
      const first = await once(office, { result: nameless });
      expect(first.facts).toEqual({
        kind: "unknown",
        reason: "verify failed at the start commit in the box without a failing test name",
      });
      expect(
        office.get<{ n: number }>(
          "select count(*) as n from base_verifies where office_id = $office_id",
        )?.n,
      ).toBe(0);
      expect((await once(office, { result: nameless })).runs).toBe(1);
    }));
});
