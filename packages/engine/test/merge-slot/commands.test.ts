// `gate.approve` and `gate.reject` on merge gates (DIPO-150 with DIPO-151; 0019 section 11) on a
// migrated state database built from fixtures: approve decides a waiting gate approved by the
// maintainer and kicks the slot; reject decides it rejected and starts a fix round with the note;
// both answer gate.notWaitingOnMaintainer for a gate decided by rule; approve answers
// gate.handMergeOnly for a PR labelled autorelease: pending; on the override gate of a story parked
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

import { appendEntries, type NewEntry } from "../../src/changelog/log";
import { CommandError } from "../../src/commands/errors";
import type { AsyncCommandContext } from "../../src/commands/registry";
import { OFFICE_DEFAULTS } from "../../src/config";
import { MergeGates, mergeGate, mergeGatesOfRun } from "../../src/merge-slot";
import { reviewVerdictOfGate } from "../../src/review/store";
import type { UnparkBranchRequest } from "../../src/run/park";
import { findRun, REVIEWED_END, runSteps } from "../../src/run/records";
import { CAPABILITY_FLAGS } from "../../src/reads/hello";

import { APPROVED, PR, type StoryWorld, storyWorld } from "./story-helpers";

let s: StoryWorld;

afterEach(() => s?.close());

interface Gates {
  readonly gates: MergeGates;
  readonly kicks: OfficeId[];
  readonly rejects: { run: RunId; gateId: string; note: string }[];
  readonly lifts: UnparkBranchRequest[];
  readonly entries: NewEntry[];
  ctx(): AsyncCommandContext;
}

function gatesOf(world: StoryWorld): Gates {
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
  });
  const office = world.w.office;
  return {
    gates,
    kicks,
    rejects,
    lifts,
    entries,
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
  expect(await s.slot.tick(s.officeId)).toBe("idle");
  const gate = mergeGatesOfRun(s.w.office, s.run)[0];
  if (gate === undefined) throw new Error("no gate opened");
  return gate.gate;
}

describe("gate.approve", () => {
  it("decides the waiting merge gate approved by the maintainer, with the note, and kicks the slot", async () => {
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
    // The PR enters the slot at the next tick.
    expect(await s.slot.tick(s.officeId)).toBe("waiting");
  });

  it("answers gate.handMergeOnly for a PR labelled autorelease: pending", async () => {
    const gate = await waiting();
    s.host.labels.set(PR, ["autorelease: pending"]);
    const g = gatesOf(s);
    expect(await refused(g.gates.approve(g.ctx(), { gate }))).toBe("gate.handMergeOnly");
    expect(mergeGate(s.w.office, gate)?.decision).toBeNull();
  });

  it("answers gate.notWaitingOnMaintainer for a gate decided by rule, and for one decided already", async () => {
    s = await storyWorld();
    expect(await s.slot.tick(s.officeId)).toBe("waiting");
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

/** A world whose story parked review-blocked; the slot opened its override gate. */
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
    s.w.office.run(
      `insert into parks (office_id, park_id, key, story_id, run_id, reason, from_state, detail,
         at, cause)
       values ($office_id, 1, $key, 'DIPO-7', $run, 'review-blocked', 'In Review', 'blocked', 0,
         'rounds')`,
      { key: s.key, run: s.run },
    );
    s.w.office.run(
      "update runs set end_kind = 'review-blocked' where office_id = $office_id and run_id = $run",
      { run: s.run },
    );
  });
  expect(await s.slot.tick(s.officeId)).toBe("idle");
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
    // In Review with no session: the run waits as reviewed.
    expect(findRun(s.w.office, s.run)).toMatchObject({ endKind: REVIEWED_END });
    expect(
      s.w.office.get("select 1 from agents where office_id = $office_id and ended_at is null"),
    ).toBeNull();
    expect(g.entries.find((entry) => entry.type === "story.state")?.delta).toMatchObject({
      from: "Parked",
      to: "In Review",
    });
    expect(g.kicks).toEqual([s.officeId]);
    // The override gate is the merge decision: green checks on the head take it into the slot.
    expect(await s.slot.tick(s.officeId)).toBe("waiting");
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
