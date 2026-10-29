// `gate.approve` and `gate.reject` on merge gates (0002) on a migrated state database built from
// fixtures: approve decides a waiting gate approved by the maintainer and kicks the auto-merge;
// reject decides it rejected and starts a fix round with the note; both answer
// gate.notWaitingOnMaintainer for a gate decided by rule; approve answers gate.handMergeOnly for a
// PR labelled autorelease: pending and for one whose head on GitHub dipo did not push; on the override gate of a story parked
// review-blocked, approve needs a note and records the override, resolves the park as override and
// returns the story to In Review with no session. The branch write is a fake.

import { afterEach, describe, expect, it } from "bun:test";

import {
  type GateId,
  gateApprove,
  type OfficeId,
  type RequestId,
  type RunId,
} from "@dipsaus-orchestrator/contract";

import { insertPark } from "../run/park-fixture";
import { appendEntries, type NewEntry } from "../../src/changelog/log";
import { CommandError } from "../../src/commands/errors";
import type { AsyncCommandContext } from "../../src/commands/registry";
import { OFFICE_DEFAULTS } from "../../src/config";
import {
  decideMergeGate,
  MergeGates,
  type MergeGatesDeps,
  mergeGate,
  mergeGatesOfRun,
} from "../../src/merge";
import { reviewVerdictOfGate } from "../../src/review/store";
import type { ParkBranchRequest, UnparkBranchRequest } from "../../src/run/park";
import { findRun, runPhase, runSteps } from "../../src/run/records";
import { CAPABILITY_FLAGS } from "../../src/reads/hello";

import { APPROVED, C1, H1, PR, type StoryWorld, storyWorld } from "./story-helpers";

let s: StoryWorld;

afterEach(() => s?.close());

interface Gates {
  readonly gates: MergeGates;
  readonly kicks: OfficeId[];
  readonly rejects: { run: RunId; gateId: string; note: string }[];
  readonly lifts: UnparkBranchRequest[];
  readonly entries: NewEntry[];
  /** The parks the override put back on the branch. */
  readonly reparks: ParkBranchRequest[];
  /** The next commit throws, after the branch work. */
  failCommit: boolean;
  ctx(): AsyncCommandContext;
}

function gatesOf(world: StoryWorld, extra: Partial<MergeGatesDeps> = {}): Gates {
  const reparks: ParkBranchRequest[] = [];
  const kicks: OfficeId[] = [];
  const rejects: Gates["rejects"] = [];
  const lifts: UnparkBranchRequest[] = [];
  const entries: NewEntry[] = [];
  const gates = new MergeGates({
    labels: world.host,
    unpark: {
      lift: async (_office, request) => {
        lifts.push(request);
        return { commit: "u".repeat(40), pushed: true, pushError: null };
      },
    },
    reject: async (_office, run, reject) => {
      rejects.push({ run, ...reject });
      return true;
    },
    kick: (office) => kicks.push(office),
    holds: (office, gate, head) => world.merge.gateHolds(office, gate, head),
    view: world.host,
    repark: {
      write: async (_office, request) => {
        reparks.push(request);
        return {
          commit: "p".repeat(40),
          lastGoodCommit: "u".repeat(40),
          from: "In Review",
          pushed: true,
          pushError: null,
        };
      },
    },
    ...extra,
  });
  const self = { failCommit: false };
  const office = world.w.office;
  return {
    gates,
    kicks,
    rejects,
    lifts,
    entries,
    reparks,
    get failCommit() {
      return self.failCommit;
    },
    set failCommit(value) {
      self.failCommit = value;
    },
    ctx: () => {
      const now = world.w.t.clock.now();
      return {
        office,
        clock: world.w.t.clock,
        ids: world.w.t.ids,
        requestId: "req_1" as RequestId,
        origin: { kind: "cli" } as never,
        now,
        stories: new Map(),
        commit: (fn) => {
          if (self.failCommit) throw new Error("database is locked");
          office.immediate(() => {
            const made = [...(fn() ?? [])];
            entries.push(...made);
            appendEntries(office, made, { at: now });
          });
        },
      };
    },
  };
}

async function refused(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CommandError) return error.error.code;
    throw error;
  }
  throw new Error("expected a refusal");
}

/** A world whose merge gate waits for the maintainer (`mergeSlot.autoMerge` off). */
async function waiting(): Promise<GateId> {
  s = await storyWorld();
  s.config = { ...OFFICE_DEFAULTS, mergeSlot: { ...OFFICE_DEFAULTS.mergeSlot, autoMerge: false } };
  await s.tick();
  const gate = mergeGatesOfRun(s.w.office, s.run)[0];
  if (gate === undefined) throw new Error("no gate opened");
  return gate.gate;
}

describe("gate.approve", () => {
  it("decides the waiting merge gate approved by the maintainer, with the note, and kicks the auto-merge", async () => {
    const gate = await waiting();
    const g = gatesOf(s);
    const out = await g.gates.approve(g.ctx(), { gate, note: "tested by hand" });
    expect(out.result).toEqual({ gate, decision: "approved" });
    expect(mergeGate(s.w.office, gate)?.decision).toMatchObject({
      decision: "approved",
      by: "maintainer",
      note: "tested by hand",
    });
    expect(g.entries.map((entry) => entry.type)).toEqual(["gate.decided"]);
    expect(g.kicks).toEqual([s.officeId]);
    // Auto-merge goes on at the next round.
    await s.tick();
    expect(s.host.armedAt).toEqual([{ number: PR, head: C1 }]);
  });

  it("answers gate.handMergeOnly for a PR whose head on GitHub dipo did not push", async () => {
    const gate = await waiting();
    s.host.set(PR, { headSha: "9".repeat(40) });
    const g = gatesOf(s);
    expect(await refused(g.gates.approve(g.ctx(), { gate }))).toBe("gate.handMergeOnly");
    expect(mergeGate(s.w.office, gate)?.decision).toBeNull();
  });

  it("answers gate.handMergeOnly for a PR labelled autorelease: pending", async () => {
    const gate = await waiting();
    s.host.prLabelsOf.set(PR, ["autorelease: pending"]);
    const g = gatesOf(s);
    expect(await refused(g.gates.approve(g.ctx(), { gate }))).toBe("gate.handMergeOnly");
    expect(mergeGate(s.w.office, gate)?.decision).toBeNull();
  });

  it("answers gate.handMergeOnly for a gate whose PR changes the release path; reject still decides it (DIPO-331)", async () => {
    s = await storyWorld();
    s.git.release.set(H1, [".github/workflows/ci.yml"]);
    await s.tick();
    const gate = mergeGatesOfRun(s.w.office, s.run)[0]!.gate;
    const g = gatesOf(s);
    expect(await refused(g.gates.approve(g.ctx(), { gate, note: "looks fine" }))).toBe(
      "gate.handMergeOnly",
    );
    expect(mergeGate(s.w.office, gate)?.decision).toBeNull();
    expect(g.kicks).toEqual([]);
    const out = await g.gates.reject(g.ctx(), { gate, note: "leave CI alone" });
    expect(out.result).toEqual({ gate, decision: "rejected" });
    expect(g.rejects).toEqual([{ run: s.run, gateId: gate, note: "leave CI alone" }]);
  });

  it("answers gate.notWaitingOnMaintainer for a gate decided by rule, and for one decided already", async () => {
    s = await storyWorld();
    await s.tick();
    const rule = mergeGatesOfRun(s.w.office, s.run)[0]!.gate;
    const g = gatesOf(s);
    expect(await refused(g.gates.approve(g.ctx(), { gate: rule }))).toBe(
      "gate.notWaitingOnMaintainer",
    );
    expect(await refused(g.gates.reject(g.ctx(), { gate: rule, note: "no" }))).toBe(
      "gate.notWaitingOnMaintainer",
    );
    expect(await refused(g.gates.approve(g.ctx(), { gate: "gat_unknown" as GateId }))).toBe(
      "gate.notWaitingOnMaintainer",
    );
  });

  it("is shipped behind the capability flag review", () => {
    expect(CAPABILITY_FLAGS["review"]).toEqual(["gate.approve", "gate.reject"]);
    expect(gateApprove.since).toBeDefined();
  });
});

describe("gate.reject", () => {
  it("decides the gate rejected with the note and starts a fix round with it", async () => {
    const gate = await waiting();
    const g = gatesOf(s);
    const out = await g.gates.reject(g.ctx(), { gate, note: "The greeting is wrong." });
    expect(out.result).toEqual({ gate, decision: "rejected" });
    expect(mergeGate(s.w.office, gate)?.decision).toMatchObject({
      decision: "rejected",
      by: "maintainer",
      note: "The greeting is wrong.",
    });
    expect(g.rejects).toEqual([{ run: s.run, gateId: gate, note: "The greeting is wrong." }]);
    // A second decision on the same gate is refused.
    expect(await refused(g.gates.approve(g.ctx(), { gate }))).toBe("gate.notWaitingOnMaintainer");
  });
});

/** A world whose story parked review-blocked; the auto-merge opened its override gate. */
async function blocked(): Promise<GateId> {
  s = await storyWorld({
    judged: {
      ...APPROVED,
      verdict: "blocked",
      criteria: [
        { n: 1, status: "met", evidence: "fine" },
        { n: 2, status: "unmet", evidence: "nothing checks an empty name" },
      ],
    },
  });
  s.w.office.immediate(() => {
    insertPark(s.w.office, {
      parkId: 1,
      key: s.key,
      story: "DIPO-7",
      runId: s.run,
      reason: "review-blocked",
      from: "In Review",
      detail: "blocked",
      at: 0,
    });
    s.w.office.run(
      "update runs set end_kind = 'parked' where office_id = $office_id and run_id = $run",
      { run: s.run },
    );
  });
  await s.tick();
  return mergeGatesOfRun(s.w.office, s.run)[0]!.gate;
}

describe("approving past a blocked review", () => {
  it("answers gate.noteRequired without a note", async () => {
    const gate = await blocked();
    const g = gatesOf(s);
    expect(await refused(g.gates.approve(g.ctx(), { gate }))).toBe("gate.noteRequired");
    expect(await refused(g.gates.approve(g.ctx(), { gate, note: "  " }))).toBe("gate.noteRequired");
    expect(g.lifts).toEqual([]);
  });

  it("with a note records the override, resolves the park as override and returns the story to In Review", async () => {
    const gate = await blocked();
    const g = gatesOf(s);
    await g.gates.approve(g.ctx(), { gate, note: "The empty name cannot happen here." });
    // The park lifted on the branch, back to In Review.
    expect(g.lifts).toEqual([
      expect.objectContaining({ story: "DIPO-7", branch: "DIPO-7/a-story", to: "In Review" }),
    ]);
    expect(mergeGate(s.w.office, gate)?.decision).toMatchObject({
      decision: "approved",
      by: "maintainer",
      note: "The empty name cannot happen here.",
    });
    expect(reviewVerdictOfGate(s.w.office, s.verdict.gate)?.override).toMatchObject({
      note: "The empty name cannot happen here.",
    });
    expect(runSteps(s.w.office, s.run).filter((step) => step.kind === "override")).toHaveLength(1);
    const park = s.w.office.get<{ resolved_how: string | null }>(
      "select resolved_how from parks where office_id = $office_id and park_id = 1",
    );
    expect(park?.resolved_how).toBe("override");
    // In Review with no session: the run stands open again, in phase merge.
    expect(findRun(s.w.office, s.run)).toMatchObject({ ending: null });
    expect(findRun(s.w.office, s.run)?.endedAt).not.toBeNull();
    expect(runPhase(s.w.office, s.run)).toBe("merge");
    expect(
      s.w.office.get("select 1 from agents where office_id = $office_id and ended_at is null"),
    ).toBeNull();
    expect(g.entries.find((entry) => entry.type === "story.state")?.delta).toMatchObject({
      from: "Parked",
      to: "In Review",
    });
    expect(g.kicks).toEqual([s.officeId]);
    // The override gate is the merge decision: green checks on the head turn auto-merge on.
    await s.tick();
    expect(s.host.armedAt).toEqual([{ number: PR, head: C1 }]);
  });

  it("refuses the override of a story whose run is still open, before the branch changes", async () => {
    const gate = await blocked();
    // A crash, or a review-blocked park written by hand, left the run open beside the park.
    s.w.office.immediate(() =>
      s.w.office.run(
        "update runs set ended_at = null, end_kind = null where office_id = $office_id and run_id = $run",
        { run: s.run },
      ),
    );
    const g = gatesOf(s);
    expect(await refused(g.gates.approve(g.ctx(), { gate, note: "Merge it." }))).toBe(
      "gate.notWaitingOnMaintainer",
    );
    expect(g.lifts).toEqual([]);
    expect(mergeGate(s.w.office, gate)?.decision).toBeNull();
    expect(runSteps(s.w.office, s.run).filter((step) => step.kind === "override")).toEqual([]);
    const park = s.w.office.get<{ resolved_at: number | null }>(
      "select resolved_at from parks where office_id = $office_id and park_id = 1",
    );
    expect(park?.resolved_at).toBeNull();
    expect(findRun(s.w.office, s.run)).toMatchObject({ endedAt: null, ending: null });
  });

  it("leaves the story parked when the override is rejected", async () => {
    const gate = await blocked();
    const g = gatesOf(s);
    await g.gates.reject(g.ctx(), { gate, note: "Fix it first." });
    expect(g.rejects).toEqual([]);
    const park = s.w.office.get<{ resolved_at: number | null }>(
      "select resolved_at from parks where office_id = $office_id and park_id = 1",
    );
    expect(park?.resolved_at).toBeNull();
  });
});

describe("a gate decided only for the head it holds for", () => {
  it("refuses approve and reject when the story PR moved to a head the gate does not hold for", async () => {
    const gate = await waiting();
    // A push to the PR with new code that has no verdict.
    const H2 = "2".repeat(40);
    s.w.office.immediate(() =>
      s.w.office.run("update story_prs set head_sha = $head where office_id = $office_id", {
        head: H2,
      }),
    );
    const g = gatesOf(s);
    expect(await refused(g.gates.approve(g.ctx(), { gate }))).toBe("gate.notWaitingOnMaintainer");
    expect(await refused(g.gates.reject(g.ctx(), { gate, note: "x" }))).toBe(
      "gate.notWaitingOnMaintainer",
    );
    expect(mergeGate(s.w.office, gate)?.decision).toBeNull();
    expect(g.rejects).toEqual([]);
  });

  it("decides a gate for a later head its verdict holds for (a task-file commit on top)", async () => {
    const gate = await waiting();
    const C2 = "3".repeat(40);
    s.git.trees.set(C2, "tree-1");
    s.w.office.immediate(() =>
      s.w.office.run("update story_prs set head_sha = $head where office_id = $office_id", {
        head: C2,
      }),
    );
    // dipo pushed it: GitHub shows the same head.
    s.host.set(PR, { headSha: C2 });
    const g = gatesOf(s);
    expect((await g.gates.approve(g.ctx(), { gate })).result.decision).toBe("approved");
  });
});

describe("an override that cannot be recorded after its lift", () => {
  it("puts the park back on the branch and reports it", async () => {
    const gate = await blocked();
    const g = gatesOf(s);
    g.failCommit = true;
    await expect(g.gates.approve(g.ctx(), { gate, note: "fine" })).rejects.toThrow(
      "dipo put the park back on the branch",
    );
    expect(g.lifts).toHaveLength(1);
    expect(g.reparks).toEqual([
      expect.objectContaining({ story: "DIPO-7", reason: "review-blocked", note: "blocked" }),
    ]);
    expect(mergeGate(s.w.office, gate)?.decision).toBeNull();
  });

  it("lifts nothing when the gate was decided right before the lift", async () => {
    const gate = await blocked();
    const g = gatesOf(s, {
      // The PR moved on (the park commit); while its head is read, another client decides.
      holds: async (office, held) => {
        office.immediate(() =>
          decideMergeGate(office, held.gate, {
            decision: "rejected",
            by: "maintainer",
            note: "no",
            at: 1,
          }),
        );
        return true;
      },
    });
    s.w.office.immediate(() =>
      s.w.office.run("update story_prs set head_sha = $head where office_id = $office_id", {
        head: "4".repeat(40),
      }),
    );
    expect(await refused(g.gates.approve(g.ctx(), { gate, note: "fine" }))).toBe(
      "gate.notWaitingOnMaintainer",
    );
    expect(g.lifts).toEqual([]);
  });
});
