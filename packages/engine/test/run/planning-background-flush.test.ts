// Confirming a planning proposal answers once its changes are journaled and files in the background
// (DIPO-492, 0010, 0022): the answer comes before the lane's flush, the view says `filing` and then
// `filed` (or `failed` with the lane's reason), the session's `[dipo]` note comes when the flush
// ended, flushes go in journal order, and a held branch applies nothing. Fast and local: the real
// planning lane on a fake office lane whose flush waits on a promise the test holds.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { type OfficeId } from "@dipsaus-orchestrator/contract";

import { allEntries, type LaneOp, type OfficeLane, planningLane } from "../../src/backlog/lane";
import { insertEntry, updateEntry } from "../../src/backlog/lane/journal";
import { LaneFlushError } from "../../src/backlog/lane/lane";
import { FileTarget } from "../../src/story-store/planning";
import { addPlanningEntry } from "../../src/records/planning-record";
import { addOffice, openTestState, type TestState } from "../commands/helpers";
import {
  blocksOf,
  commandContext,
  planningWorld,
  proposalView,
  STORY_PROPOSAL,
  until,
} from "./planning-world";

const SECOND = { ...STORY_PROPOSAL, title: "Export the stories as XML" } as const;

let dir: string;
let t: TestState;

beforeEach(async () => {
  dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "planning-background-"));
  t = await openTestState(dir);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A lane whose flush waits on `gate` and then applies, fails or holds as the test says. */
async function world(options: { held?: boolean; fail?: boolean } = {}) {
  const office = addOffice(t);
  const { promise: gate, resolve: open } = Promise.withResolvers<void>();
  const applied: number[] = [];
  const ids = ["TASK-4", "TASK-5"];
  const fake = {
    journal: async (op: LaneOp) => office.immediate(() => insertEntry(office, op, t.clock.now())),
    flush: async () => {
      await gate;
      if (options.held === true) return { branch: "dipo/backlog-1", held: true, waiting: null };
      if (options.fail === true)
        throw new LaneFlushError("backlog.lane.flushFailed", "push failed", null);
      for (const entry of allEntries(office)) {
        if (entry.state !== "pending") continue;
        const target = FileTarget.parse(entry.target);
        office.immediate(() => {
          updateEntry(
            office,
            entry.opId,
            { state: "pushed", branch: "dipo/backlog-1" },
            t.clock.now(),
          );
          addPlanningEntry(office, target.run, {
            kind: "story",
            subject: ids[applied.length] ?? "TASK-9",
            proposal: target.proposal,
            text: "filed",
            at: t.clock.now(),
          });
        });
        applied.push(target.proposal);
      }
      return { branch: "dipo/backlog-1", held: false, waiting: null };
    },
    heldReason: () => "auto-merge is on",
    stall: () => null,
    office,
    clock: t.clock,
  } as unknown as OfficeLane;
  const w = planningWorld(t, dir, { office, lane: () => planningLane(fake) });
  w.answerText = (n) => (n === 1 ? blocksOf(STORY_PROPOSAL, SECOND) : "Noted.");
  await w.sessions.start(commandContext(w), { kind: "plan", goal: "Export" });
  await until(() => w.sessions.view(office.officeId as OfficeId)?.state === "waiting");
  return { w, office, open, applied, ctx: commandContext(w) };
}

const lastMessage = (w: Awaited<ReturnType<typeof world>>["w"]): string =>
  w.sent
    .at(-1)
    ?.flatMap((op) => ("write" in op ? [op.write] : []))
    .join("") ?? "";

describe("confirming a proposal files in the background (DIPO-492)", () => {
  it("answers before the push ends with no flush field, and the view shows the proposal filing", async () => {
    const { w, ctx, open, office } = await world();
    const confirmed = await w.sessions.confirm(ctx, { proposal: 1 });
    expect(confirmed.result).toEqual({
      run: confirmed.result.run,
      proposal: 1,
      state: "filing",
      stories: [],
    });
    expect("flush" in confirmed.result).toBe(false);
    expect(proposalView(w, 1)?.state).toBe("filing");
    expect(allEntries(office).map((entry) => entry.state)).toEqual(["pending"]);
    open();
    await w.flushed();
  });

  it("shows filed with its id when the flush applied it, and the next message carries the note", async () => {
    const { w, ctx, open } = await world();
    await w.sessions.confirm(ctx, { proposal: 1 });
    await w.sessions.message(ctx, { text: "Before." });
    expect(lastMessage(w)).not.toContain("confirmed proposal 1");
    open();
    await w.flushed();
    expect(proposalView(w, 1)).toMatchObject({ state: "filed", stories: ["TASK-4"] });
    await w.sessions.message(ctx, { text: "After." });
    expect(lastMessage(w)).toContain(
      "[dipo] The maintainer confirmed proposal 1: TASK-4 in dipo's backlog PR",
    );
  });

  it("leaves the proposal failed with the lane's reason and its operations journaled", async () => {
    const { w, ctx, open, office } = await world({ fail: true });
    const confirmed = await w.sessions.confirm(ctx, { proposal: 1 });
    expect(confirmed.result.state).toBe("filing");
    open();
    await w.flushed();
    expect(proposalView(w, 1)).toMatchObject({ state: "failed", detail: "push failed" });
    expect(allEntries(office).map((entry) => entry.state)).toEqual(["pending"]);
    await w.sessions.message(ctx, { text: "Next." });
    expect(lastMessage(w)).toContain("could not be filed: push failed");
    // A confirm again flushes the journaled change; it does not journal it twice.
    await w.sessions.confirm(ctx, { proposal: 1 });
    expect(allEntries(office)).toHaveLength(1);
  });

  it("flushes two quick confirms in confirm order", async () => {
    const { w, ctx, open, applied } = await world();
    await w.sessions.confirm(ctx, { proposal: 1 });
    await w.sessions.confirm(ctx, { proposal: 2 });
    expect(applied).toEqual([]);
    open();
    await w.flushed();
    expect(applied).toEqual([1, 2]);
    expect(proposalView(w, 2)?.state).toBe("filed");
  });

  it("answers at once on a held branch and applies nothing", async () => {
    const { w, ctx, open, applied, office } = await world({ held: true });
    const confirmed = await w.sessions.confirm(ctx, { proposal: 1 });
    expect(confirmed.result.state).toBe("filing");
    open();
    await w.flushed();
    expect(applied).toEqual([]);
    expect(proposalView(w, 1)?.state).toBe("filing");
    expect(allEntries(office).map((entry) => entry.state)).toEqual(["pending"]);
  });
});
