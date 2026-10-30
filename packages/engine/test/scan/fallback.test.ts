// The scan fallback and the confirm command against a fixture-built test database (DIPO-310
// criteria 2, 4, 5 and 7), with a scripted session runner: no model is called.
//
// - `office.infer` names only what code left unresolved or in conflict, says `nothing` when that
//   is empty, and starts the session after the command; a second infer of the same office waits
//   for the running session; the office's starts paused makes it wait, never park, and a session
//   that meets the plan limit pauses the starts and waits for their lift (0020).
// - A valid answer is stored pending with confidence `low` and its evidence, never in the
//   effective profile, so `run` still refuses; a proposal that fails a check, and an answer that
//   fails the schema, are dropped with an `engine.notice` naming the check.
// - accept, edit, reject, set, pick, keep and nothing-to-start give the sources 0013 section 6
//   names, recompute the run refusal and emit `scan.finished` with the diff.

import { describe, expect, it } from "bun:test";

import type { ConfirmArgs, OfficeId } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { appendEntries } from "../../src/changelog/log";
import { CommandError } from "../../src/commands/errors";
import type { OfficeHandle } from "../../src/db/office";
import { activeRuns } from "../../src/run/records";
import { applyConfirm } from "../../src/scan/confirm-command";
import { detect, type Probe, type RunProfile } from "../../src/scan/detect";
import type { BaseEvidence } from "../../src/scan/evidence-read";
import {
  endLostScanSessions,
  SCAN_MAX_TURNS,
  SCAN_NOTICES,
  ScanFallback,
  type ScanSessionRequest,
  type ScanSessionResult,
} from "../../src/scan/fallback";
import { readMarks } from "../../src/scan/marks";
import { currentProfile, insertProfile, verifyResolved } from "../../src/scan/store";
import { addOffice, openTestState, type TestState } from "../commands/helpers";
import { entriesAfter, lastSeq } from "../stories/helpers";

const json = (value: unknown) => JSON.stringify(value);

function probe(texts: Record<string, string>, lockfiles = ["bun.lock"]): Probe {
  return { texts, lockfiles, workspaceDirs: [], envFiles: [] };
}

/** A repository code cannot get verify, test or dev from: only a Makefile does it. */
const MAKE_REPO = detect(probe({ "package.json": json({ name: "app", scripts: {} }) }));

/** Two sources that disagree on verify (the slaydoku case of 0013). */
const CONFLICT_REPO = detect(
  probe({
    "package.json": json({ scripts: { verify: "bun tools/verify.ts", test: "vitest run" } }),
    ".claude/backlog-workflow.json": json({ verify: ["bun run lint", "bun run test"] }),
  }),
);

const BASE: BaseEvidence = {
  files: ["package.json", "Makefile", "README.md"],
  texts: {
    "package.json": json({ name: "app", scripts: {} }),
    Makefile: "check:\n\tbun test\ndev:\n\tbun src/server.ts\n",
    "README.md": "## Running\n\nmake dev\n",
  },
  skipped: [],
};

const SETTINGS = { model: "sonnet", effort: "low", budgetTokens: 100_000, maxMinutes: 5 };

const ANSWER = {
  proposals: [
    {
      capability: "verify",
      commands: [["make", "check"]],
      cwd: ".",
      evidence: ["Makefile: target check runs bun test"],
      confidence: "medium",
    },
    {
      capability: "dev",
      commands: [["make", "serve"]],
      cwd: ".",
      evidence: ["README.md: make serve"],
      confidence: "low",
    },
  ],
};

interface Harness {
  readonly t: TestState;
  readonly office: OfficeHandle;
  readonly officeId: OfficeId;
  readonly requests: ScanSessionRequest[];
  readonly fallback: ScanFallback;
  /** The next results the scripted runner gives, in order; it waits on `gate` first when set. */
  readonly results: ScanSessionResult[];
  gate: Promise<void> | null;
  /** The office's starts paused, as the fallback reads it; null when not paused. */
  held: string | null;
  /** The plan limits the fallback paused the office's starts for, with their reset (ms). */
  readonly pauses: { resetsAt?: number; credits: boolean }[];
}

function harness(t: TestState, profile: RunProfile = MAKE_REPO): Harness {
  const office = addOffice(t);
  office.immediate(() =>
    insertProfile(office, profile, { scannedAt: t.clock.now(), commit: "c1" }),
  );
  const h: Harness = {
    t,
    office,
    officeId: office.officeId,
    requests: [],
    results: [],
    gate: null,
    held: null,
    pauses: [],
    fallback: undefined as unknown as ScanFallback,
  };
  (h as { fallback: ScanFallback }).fallback = new ScanFallback({
    runner: () => ({
      run: async (request) => {
        h.requests.push(request);
        if (h.gate !== null) await h.gate;
        return h.results.shift() ?? { kind: "answered", runId: "run_scripted", answer: ANSWER };
      },
    }),
    settings: () => SETTINGS,
    startsPaused: () => h.held,
    pausePlanLimit: (_office, limit) => {
      h.pauses.push(limit);
      h.held = "the office's starts are paused (plan limit)";
    },
    readBase: async () => BASE,
    pollMs: 1_000,
  });
  return h;
}

const withHarness = (fn: (h: Harness) => Promise<void>, profile?: RunProfile) =>
  withTempDir(async (dir) => {
    const t = await openTestState(dir);
    try {
      await fn(harness(t, profile));
    } finally {
      t.state.close();
    }
  });

/** Lets queued promise jobs run (the session starts after the command's transaction). */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function notices(office: OfficeHandle, after = 0) {
  return entriesAfter(office, after)
    .filter((entry) => entry.type === "engine.notice")
    .map((entry) => entry.delta as { code: string; text: string; level: string });
}

function finished(office: OfficeHandle, after = 0) {
  return entriesAfter(office, after)
    .filter((entry) => entry.type === "scan.finished")
    .map((entry) => entry.delta as { trigger: string; diff?: string[]; error?: string });
}

describe("office.infer", () => {
  it("asks only for the capabilities code left unresolved, with the scan block's settings", () =>
    withHarness(async (h) => {
      const reply = h.fallback.infer(h.officeId, h.office, h.t.clock);
      expect(reply.infer).toBe("started");
      expect(reply.capabilities).toEqual([
        "setup",
        "dev",
        "test",
        "lint",
        "typecheck",
        "verify",
        "build",
      ]);
      await h.fallback.whenIdle(h.officeId);
      expect(h.requests).toHaveLength(1);
      const request = h.requests[0];
      expect(request?.settings).toEqual({ ...SETTINGS, maxTurns: SCAN_MAX_TURNS });
      expect(SCAN_MAX_TURNS).toBe(2);
      expect(request?.taskMessage).toContain("- verify: unresolved");
      expect(request?.taskMessage).not.toContain("- install:");
      expect(request?.taskMessage).toContain('<scan_file path="Makefile">');
      expect(request?.systemFile).toContain("You have no tools");
      expect(request?.schema).toMatchObject({ type: "object" });
    }));

  it("says nothing to infer, and asks no model, when nothing is unresolved", () =>
    withHarness(async (h) => {
      for (const action of [
        { action: "set", capability: "setup", commands: [["true"]] },
        { action: "set", capability: "dev", commands: [["make", "dev"]] },
        { action: "set", capability: "test", commands: [["make", "check"]] },
        { action: "set", capability: "lint", commands: [["true"]] },
        { action: "set", capability: "typecheck", commands: [["true"]] },
        { action: "set", capability: "verify", commands: [["make", "check"]] },
        { action: "set", capability: "build", commands: [["true"]] },
      ] as ConfirmArgs[]) {
        h.office.immediate(() => applyConfirm(h.office, action, h.t.clock.now()));
      }
      expect(h.fallback.infer(h.officeId, h.office, h.t.clock)).toEqual({
        infer: "nothing",
        capabilities: [],
      });
      await h.fallback.whenIdle(h.officeId);
      expect(h.requests).toHaveLength(0);
    }));

  it("refuses an office with no profile", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const office = addOffice(t);
        const fallback = new ScanFallback({
          settings: () => SETTINGS,
          readBase: async () => BASE,
        });
        expect(() => fallback.infer(office.officeId, office, t.clock)).toThrow(CommandError);
      } finally {
        t.state.close();
      }
    }));

  it("stores a valid proposal pending, low, with its evidence, and run still refuses", () =>
    withHarness(async (h) => {
      const before = lastSeq(h.office);
      h.fallback.infer(h.officeId, h.office, h.t.clock);
      await h.fallback.whenIdle(h.officeId);
      const marks = readMarks(h.office);
      expect(marks.proposals.map((p) => p.capability)).toEqual(["verify"]);
      expect(marks.proposals[0]).toMatchObject({
        spec: { commands: [["make", "check"]], cwd: "." },
        modelConfidence: "medium",
        evidence: ["Makefile: target check runs bun test"],
        runId: "run_scripted",
      });
      expect(
        h.office.get<{ confidence: string }>(
          "select confidence from capability_proposals where office_id = $office_id",
        )?.confidence,
      ).toBe("low");
      const profile = currentProfile(h.office);
      expect(profile?.profile.capabilities.verify.status).toBe("unresolved");
      expect(profile?.marks.verify.pending).not.toBeNull();
      expect(verifyResolved(h.office)).toContain("`dipo office infer`");
      // The dev proposal names a Makefile target that is not there: dropped, the check named.
      const dropped = notices(h.office, before);
      expect(dropped).toEqual([
        {
          level: "warn",
          code: SCAN_NOTICES.proposalDropped,
          text: 'dipo dropped the proposed dev (check: existence): the target "serve" is not in Makefile',
        },
      ]);
      const [scan] = finished(h.office, before);
      expect(scan?.trigger).toBe("infer");
      expect(scan?.diff).toEqual([
        "+ verify proposal: make check [inferred, low; Makefile: target check runs bun test]",
      ]);
    }));

  it("drops an answer that fails the schema with a notice naming the check", () =>
    withHarness(async (h) => {
      h.results.push({ kind: "answered", runId: "run_x", answer: { proposals: [{ nope: 1 }] } });
      const before = lastSeq(h.office);
      h.fallback.infer(h.officeId, h.office, h.t.clock);
      await h.fallback.whenIdle(h.officeId);
      expect(readMarks(h.office).proposals).toEqual([]);
      const [notice] = notices(h.office, before);
      expect(notice?.code).toBe(SCAN_NOTICES.answerDropped);
      expect(notice?.text).toContain("(check: schema)");
    }));

  it("reports a failed session with a notice and scan.finished carrying the error", () =>
    withHarness(async (h) => {
      h.results.push({ kind: "failed", runId: "run_f", reason: "the launch plan refused it" });
      const before = lastSeq(h.office);
      h.fallback.infer(h.officeId, h.office, h.t.clock);
      await h.fallback.whenIdle(h.officeId);
      expect(notices(h.office, before)[0]?.code).toBe(SCAN_NOTICES.failed);
      expect(finished(h.office, before)[0]?.error).toContain("the launch plan refused it");
    }));

  it("runs one session per office at a time: a second infer waits for the first", () =>
    withHarness(async (h) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      h.gate = promise;
      expect(h.fallback.infer(h.officeId, h.office, h.t.clock).infer).toBe("started");
      await settle();
      expect(h.requests).toHaveLength(1);
      expect(h.fallback.infer(h.officeId, h.office, h.t.clock).infer).toBe("queued");
      expect(h.fallback.inferring(h.officeId)).toBe(true);
      await settle();
      expect(h.requests).toHaveLength(1);
      h.gate = null;
      resolve();
      await h.fallback.whenIdle(h.officeId);
      expect(h.requests).toHaveLength(2);
      expect(h.fallback.inferring(h.officeId)).toBe(false);
    }));

  it("waits while the office's starts are paused, with one notice, and never parks", () =>
    withHarness(async (h) => {
      h.held = "the office's starts are paused (plan limit until 14:00)";
      const before = lastSeq(h.office);
      h.fallback.infer(h.officeId, h.office, h.t.clock);
      await settle();
      h.t.clock.advance(1_000);
      await settle();
      expect(h.requests).toHaveLength(0);
      const waiting = notices(h.office, before);
      expect(waiting).toHaveLength(1);
      expect(waiting[0]).toMatchObject({ code: SCAN_NOTICES.waiting, level: "info" });
      expect(waiting[0]?.text).toContain("plan limit until 14:00");
      h.held = null;
      h.t.clock.advance(1_000);
      await h.fallback.whenIdle(h.officeId);
      expect(h.requests).toHaveLength(1);
      expect(h.office.get("select 1 as x from parks where office_id = $office_id")).toBeNull();
    }));

  it("passes credits_required on to the pause, so only a lift by hand ends it", () =>
    withHarness(async (h) => {
      h.results.push({ kind: "plan-limit", runId: "run_c", credits: true });
      h.fallback.infer(h.officeId, h.office, h.t.clock);
      await settle();
      expect(h.pauses).toEqual([{ credits: true }]);
      h.held = null;
      h.t.clock.advance(1_000);
      await h.fallback.whenIdle(h.officeId);
    }));

  it("pauses the office's starts when its session meets a plan limit, then starts a new session once they lift", () =>
    withHarness(async (h) => {
      const reset = h.t.clock.now() + 60_000;
      h.results.push({ kind: "plan-limit", runId: "run_l", resetsAt: reset });
      h.fallback.infer(h.officeId, h.office, h.t.clock);
      await settle();
      expect(h.requests).toHaveLength(1);
      expect(h.pauses).toEqual([{ resetsAt: reset, credits: false }]);
      h.t.clock.advance(60_000);
      await settle();
      expect(h.requests).toHaveLength(1);
      // The starts lift: the next poll starts a new session.
      h.held = null;
      h.t.clock.advance(1_000);
      await h.fallback.whenIdle(h.officeId);
      expect(h.requests).toHaveLength(2);
      expect(readMarks(h.office).proposals.map((p) => p.capability)).toEqual(["verify"]);
      expect(h.office.get("select 1 as x from parks where office_id = $office_id")).toBeNull();
    }));
});

/** The confirm command as the feature runs it: in a transaction, with its scan.finished. */
function confirm(h: Harness, args: ConfirmArgs) {
  return h.office.immediate(() => {
    const outcome = applyConfirm(h.office, args, h.t.clock.now());
    appendEntries(h.office, [outcome.entry], { at: h.t.clock.now() });
    return outcome.result;
  });
}

/** The error code a confirm is refused with, or null. */
function errorCode(h: Harness, args: ConfirmArgs): string | null {
  try {
    confirm(h, args);
  } catch (error) {
    if (error instanceof CommandError) return error.error.code;
    throw error;
  }
  return null;
}

/** One infer with the scripted answer, waited for. */
async function proposed(h: Harness): Promise<void> {
  h.fallback.infer(h.officeId, h.office, h.t.clock);
  await h.fallback.whenIdle(h.officeId);
}

describe("office.confirm", () => {
  it("accept confirms the proposal with source inferred and clears the run refusal", () =>
    withHarness(async (h) => {
      await proposed(h);
      const before = lastSeq(h.office);
      const result = confirm(h, { action: "accept", capability: "verify" });
      expect(result).toMatchObject({ capability: "verify", source: "inferred", confirmed: true });
      expect(result.runRefusal).toBeUndefined();
      expect(verifyResolved(h.office)).toBeNull();
      expect(readMarks(h.office).proposals).toEqual([]);
      const [scan] = finished(h.office, before);
      expect(scan?.trigger).toBe("confirm");
      expect(scan?.diff?.[0]).toContain("~ verify: unresolved -> make check [inferred");
    }));

  it("edit confirms the maintainer's command with source maintainer", () =>
    withHarness(async (h) => {
      await proposed(h);
      const result = confirm(h, {
        action: "edit",
        capability: "verify",
        commands: [["make", "check", "CI=1"]],
      });
      expect(result).toMatchObject({ source: "maintainer", confirmed: true });
      const verify = currentProfile(h.office)?.profile.capabilities.verify;
      expect(verify?.status === "resolved" && verify.value).toEqual({
        commands: [["make", "check", "CI=1"]],
        cwd: ".",
      });
      expect(verify?.status === "resolved" && verify.evidence).toContain(
        "edited from the proposal make check",
      );
    }));

  it("refuses to accept a proposal made at another fingerprint, and edit still confirms", () =>
    withHarness(async (h) => {
      await proposed(h);
      h.office.run(
        "update capability_proposals set fingerprint = 'sha256:older' where office_id = $office_id",
      );
      expect(errorCode(h, { action: "accept", capability: "verify" })).toBe("scan.staleProposal");
      expect(verifyResolved(h.office)).not.toBeNull();
      try {
        confirm(h, { action: "accept", capability: "verify" });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        expect(message).toContain("`dipo office infer`");
        expect(message).toContain("`dipo office confirm edit verify -- <command>`");
      }
      const edited = confirm(h, {
        action: "edit",
        capability: "verify",
        commands: [["make", "check"]],
      });
      expect(edited).toMatchObject({ source: "maintainer", confirmed: true });
    }));

  it("reject removes the proposal and leaves run refused", () =>
    withHarness(async (h) => {
      await proposed(h);
      const result = confirm(h, { action: "reject", capability: "verify" });
      expect(result.confirmed).toBe(false);
      expect(result.runRefusal).toContain("Verify is unresolved");
      expect(result.diff).toEqual(["- verify proposal: make check (rejected)"]);
      expect(readMarks(h.office).proposals).toEqual([]);
      expect(errorCode(h, { action: "accept", capability: "verify" })).toBe("scan.noProposal");
    }));

  it("set confirms a capability by hand without the model, source maintainer", () =>
    withHarness(async (h) => {
      const result = confirm(h, {
        action: "set",
        capability: "verify",
        commands: [
          ["make", "lint"],
          ["make", "test"],
        ],
        cwd: "./",
      });
      expect(result).toMatchObject({ source: "maintainer", confirmed: true });
      expect(result.runRefusal).toBeUndefined();
      expect(h.requests).toHaveLength(0);
      expect(
        errorCode(h, { action: "set", capability: "verify", commands: [["x"]], cwd: "../up" }),
      ).toBe("scan.invalidCommand");
    }));

  it("refuses to confirm a capability code resolves", () =>
    withHarness(async (h) => {
      expect(errorCode(h, { action: "set", capability: "install", commands: [["x"]] })).toBe(
        "scan.resolvedByCode",
      );
    }));

  it("pick confirms one candidate of a conflict, source maintainer", () =>
    withHarness(async (h) => {
      expect(verifyResolved(h.office)).toContain("Verify is in conflict");
      const result = confirm(h, { action: "pick", capability: "verify", candidate: 2 });
      expect(result).toMatchObject({ source: "maintainer", confirmed: true });
      const verify = currentProfile(h.office)?.profile.capabilities.verify;
      expect(verify?.status === "resolved" && verify.value.commands).toEqual([
        ["bun", "run", "lint"],
        ["bun", "run", "test"],
      ]);
      expect(errorCode(h, { action: "pick", capability: "verify", candidate: 3 })).toBe(
        "scan.noCandidate",
      );
      expect(errorCode(h, { action: "pick", capability: "dev", candidate: 1 })).toBe(
        "scan.notConflict",
      );
    }, CONFLICT_REPO));

  it("keep confirms a stale confirmation again at the current fingerprint", () =>
    withHarness(async (h) => {
      confirm(h, { action: "set", capability: "verify", commands: [["make", "check"]] });
      expect(errorCode(h, { action: "keep", capability: "dev" })).toBe("scan.notConfirmed");
      h.office.run(
        "update capability_confirmations set fingerprint = 'sha256:older' where office_id = $office_id",
      );
      expect(currentProfile(h.office)?.marks.verify.stale).toBe(true);
      const result = confirm(h, { action: "keep", capability: "verify" });
      expect(result.diff).toEqual(["~ verify confirmation: stale -> confirmed again"]);
      expect(currentProfile(h.office)?.marks.verify.stale).toBe(false);
    }));

  it("nothing-to-start drops the missing dev and its refusal, and --undo takes it back", () =>
    withHarness(async (h) => {
      expect(currentProfile(h.office)?.testRefusal).toContain('"dev" is unresolved');
      const result = confirm(h, { action: "nothing-to-start" });
      expect(result.confirmed).toBe(false);
      expect(result.diff).toContain(
        "+ nothing to start: the product has nothing to start (set by the maintainer)",
      );
      expect(result.diff.some((line) => line.startsWith("- deviation missing-dev"))).toBe(true);
      expect(currentProfile(h.office)?.nothingToStart).toBe(true);
      expect(currentProfile(h.office)?.testRefusal).toBeNull();
      const back = confirm(h, { action: "nothing-to-start", value: false });
      expect(back.diff).toContain("- nothing to start: taken back by the maintainer");
    }));
});

describe("ScanFallback.close", () => {
  it("stops waiting and sends the stop to the runner's running sessions", () =>
    withHarness(async (h) => {
      let stops = 0;
      const fallback = new ScanFallback({
        runner: () => ({
          run: async () => ({ kind: "failed", runId: null, reason: "unused" }),
          stopAll: async () => {
            stops += 1;
          },
        }),
        settings: () => SETTINGS,
        startsPaused: () => "the office's starts are paused (plan limit)",
        readBase: async () => BASE,
        pollMs: 1_000,
      });
      fallback.infer(h.officeId, h.office, h.t.clock);
      await fallback.close();
      expect(stops).toBe(1);
      // The held session starts no more.
      await fallback.whenIdle(h.officeId);
      expect(fallback.inferring(h.officeId)).toBe(false);
    }));
});

describe("endLostScanSessions", () => {
  it("ends only the scan session runs left open, so the office is not kept busy", () =>
    withHarness(async (h) => {
      for (const [run, role] of [
        ["run_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D", "scanner"],
        ["run_01J9ZK5Q8W3V4X6Y7Z8A9B0C2E", "planner"],
      ] as const) {
        h.office.run(
          `insert into runs (office_id, run_id, kind, role, model, budget_unit, budget_limit,
             loop_cap, config_hash, started_at)
           values ($office_id, $run, 'session', $role, 'sonnet', 'tokens', 1, 0, 'h', 0)`,
          { run, role },
        );
      }
      expect(endLostScanSessions(h.office, h.t.clock.now())).toEqual([
        "run_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D",
      ]);
      expect(activeRuns(h.office).map((run) => String(run.runId))).toEqual([
        "run_01J9ZK5Q8W3V4X6Y7Z8A9B0C2E",
      ]);
      expect(
        h.office.get<{ end_kind: string }>(
          "select end_kind from runs where office_id = $office_id and run_id = 'run_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D'",
        )?.end_kind,
      ).toBe("dropped");
      // Each end is on the office stream once, so a client sees it without polling (DIPO-397).
      expect(
        entriesAfter(h.office)
          .filter((entry) => entry.type === "run.ended")
          .map((entry) => entry.delta),
      ).toEqual([
        {
          run: "run_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D",
          kind: "session",
          ending: "dropped",
          endedAt: new Date(h.t.clock.now()).toISOString(),
        },
      ]);
      expect(endLostScanSessions(h.office, h.t.clock.now())).toEqual([]);
    }));
});
