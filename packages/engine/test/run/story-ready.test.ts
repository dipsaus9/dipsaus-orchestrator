// `story.ready` (DIPO-482, 0012): any Refined story on the base is set Ready through the planning
// lane when it passes the Ready gate, by the one function `planning.ready` shares. Fast and local:
// a migrated state database with stories mirrored from a pretend base, a lane that journals into
// the real journal, and a gate whose verdict per story the test sets. The real lane, gate and
// Backlog CLI run in planning-ready.test.ts.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { type OfficeId, RequestId, StoryId, type StoryKey } from "@dipsaus-orchestrator/contract";

import {
  allEntries,
  type LaneOp,
  type OfficeLane,
  planningLane,
  READY_KIND,
  REVISE_KIND,
} from "../../src/backlog/lane";
import { insertEntry } from "../../src/backlog/lane/journal";
import { executeCommand } from "../../src/commands/execute";
import { CommandError } from "../../src/commands/errors";
import { stateOfficeDirectory } from "../../src/commands/offices";
import { buildRegistry } from "../../src/commands/registry";
import { MemoryRequestTable } from "../../src/commands/requests";
import type { OfficeHandle } from "../../src/db/office";
import { addStory, removeStory } from "../../src/records/story-keys";
import { StoryPlanning } from "../../src/run/planning";
import { readyStory } from "../../src/run/ready-stories";
import { writeMirror } from "../../src/stories/apply";
import type { BacklogStory } from "../../src/stories/read";
import { addOffice, openTestState, type TestState } from "../commands/helpers";
import { backlogLayout } from "../story-store/backlog";

interface World {
  readonly dir: string;
  readonly t: TestState;
  readonly office: OfficeHandle;
  readonly ops: LaneOp[];
  readonly flushes: { n: number };
  readonly planning: StoryPlanning;
  readonly registry: ReturnType<typeof buildRegistry>;
  /** The gate's failures by story id; a story not listed passes; `null` is not on the base. */
  readonly verdicts: Map<string, string[] | null>;
  readonly evaluated: string[];
  readonly lane: ReturnType<typeof planningLane>;
}

let w: World;

const source = (path: string) => Bun.file(join(import.meta.dir, "../../src/run", path)).text();

beforeEach(async () => {
  const dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "story-ready-"));
  const t = await openTestState(dir);
  const office = addOffice(t);
  const ops: LaneOp[] = [];
  const flushes = { n: 0 };
  const fake = {
    journal: async (op: LaneOp) => {
      ops.push(op);
      return office.immediate(() => insertEntry(office, op, t.clock.now()));
    },
    flush: async () => {
      flushes.n += 1;
      return { branch: null, held: false, waiting: null };
    },
    stall: () => null,
    office,
    clock: t.clock,
  } as unknown as OfficeLane;
  const lane = planningLane(fake);
  const verdicts = new Map<string, string[] | null>();
  const evaluated: string[] = [];
  const planning = new StoryPlanning({
    stories: backlogLayout,
    lane: () => lane,
    gate: () => ({
      recordGateDecision: async (_office: unknown, key: StoryKey, mode: string) => {
        const id = office.get<{ story_id: string }>(
          "select story_id from stories where office_id = $office_id and key = $key",
          { key },
        )?.story_id;
        expect(mode).toBe("ready");
        evaluated.push(String(id));
        const failures = verdicts.get(String(id));
        if (failures === null) {
          throw new CommandError("story.unknown", `${id} is not on the base`, { story: id });
        }
        return {
          result: {
            passed: failures === undefined || failures.length === 0,
            failures: (failures ?? []).map((message) => ({ rule: "R01a", message })),
          },
        } as never;
      },
    }),
  } as never);
  const registry = buildRegistry([planning.feature]);
  w = { dir, t, office, ops, flushes, planning, registry, verdicts, evaluated, lane };
});

afterEach(() => {
  w.t.state.close();
  rmSync(w.dir, { recursive: true, force: true });
});

/** A story in the index and the mirror, as a pass over the base would leave it. */
function story(id: string, status: string, kind: "task" | "draft" = "task"): StoryKey {
  const { office, t } = w;
  return office.immediate(() => {
    const { key } = addStory(office, t.ids, { story: StoryId.parse(id) }, t.clock.now());
    const read: BacklogStory = {
      kind,
      story: StoryId.parse(id),
      title: `Title of ${id}`,
      status,
      labels: ["tier:M"],
      tier: "M",
      contentHash: `hash-${id}`,
      waitingOn: [],
    };
    writeMirror(office, key, read, t.clock.now(), "base");
    return key;
  });
}

let sequence = 0;
async function send(stories: string[]) {
  sequence += 1;
  return await executeCommand(
    {
      registry: w.registry,
      offices: stateOfficeDirectory(w.t.state),
      clock: w.t.clock,
      ids: w.t.ids,
      softwareRequests: new MemoryRequestTable(w.t.clock),
    },
    {
      requestId: RequestId.parse(`01J9ZK5Q8W3V4X6Y7Z${String(sequence).padStart(8, "0")}`),
      name: "story.ready",
      args: { stories },
      origin: "cli",
      confirmed: true,
      office: w.office.officeId as OfficeId,
    },
  );
}

const readyOps = () => allEntries(w.office).filter((entry) => entry.kind === READY_KIND);

describe("story.ready (DIPO-482)", () => {
  it("sets two passing Refined stories Ready in one flush, each with its decision evaluated", async () => {
    const a = story("DIPO-1", "Refined");
    const b = story("DIPO-2", "Refined");
    const reply = await send(["DIPO-1", "DIPO-2"]);
    expect(reply).toMatchObject({
      ok: true,
      changed: true,
      result: { queued: ["DIPO-1", "DIPO-2"], refused: [] },
    });
    expect(w.evaluated).toEqual(["DIPO-1", "DIPO-2"]);
    expect(readyOps().map((entry) => entry.key)).toEqual([a, b]);
    expect(w.flushes.n).toBe(1);
  });

  it("refuses a gate failure with the gate's messages and leaves the others going", async () => {
    story("DIPO-1", "Refined");
    story("DIPO-2", "Refined");
    w.verdicts.set("DIPO-1", ["no acceptance criteria"]);
    const reply = await send(["DIPO-1", "DIPO-2"]);
    expect(reply).toMatchObject({
      ok: true,
      result: {
        queued: ["DIPO-2"],
        refused: [{ story: "DIPO-1", messages: ["R01a: no acceptance criteria"] }],
      },
    });
    expect(readyOps()).toHaveLength(1);
  });

  it("refuses a story not on the base yet, and one with an edit still open in the lane", async () => {
    const gone = story("DIPO-1", "Refined");
    const edited = story("DIPO-2", "Refined");
    w.verdicts.set("DIPO-1", null);
    await w.lane.reviseStory({ key: edited, story: "DIPO-2" }, {
      title: "A new title",
    } as never);
    expect(gone).not.toBe(edited);
    const reply = await send(["DIPO-1", "DIPO-2"]);
    if (!reply.ok) throw new Error("expected a result");
    const result = reply.result as { queued: string[]; refused: { messages: string[] }[] };
    expect(result.queued).toEqual([]);
    expect(result.refused[0]?.messages.join()).toContain("not on the base branch");
    expect(result.refused[1]?.messages.join()).toContain("edit of it still waits");
    expect(readyOps()).toEqual([]);
    expect(allEntries(w.office).filter((e) => e.kind === REVISE_KIND)).toHaveLength(1);
    expect(w.flushes.n).toBe(0);
  });

  it("refuses a story that is not Refined, and never evaluates the gate for it", async () => {
    for (const [id, status] of [
      ["DIPO-1", "In Progress"],
      ["DIPO-2", "In Review"],
      ["DIPO-3", "Parked"],
      ["DIPO-4", "Done"],
      ["DIPO-5", "Ready"],
    ] as const) {
      story(id, status);
    }
    story("DIPO-6", "Draft", "draft");
    const reply = await send(["DIPO-1", "DIPO-2", "DIPO-3", "DIPO-4", "DIPO-5", "DIPO-6"]);
    if (!reply.ok) throw new Error("expected a result");
    const result = reply.result as { queued: string[]; refused: { messages: string[] }[] };
    expect(reply.changed).toBe(false);
    expect(result.queued).toEqual([]);
    expect(result.refused).toHaveLength(6);
    for (const refusal of result.refused) {
      expect(refusal.messages[0]).toContain("only a Refined story is set Ready");
    }
    expect(w.evaluated).toEqual([]);
    expect(readyOps()).toEqual([]);
  });

  it("resolves a lower-case id like its upper-case form and sets a repeated id once", async () => {
    story("DIPO-1", "Refined");
    const reply = await send(["dipo-1", "DIPO-1", "Dipo-1"]);
    expect(reply).toMatchObject({ ok: true, result: { queued: ["DIPO-1"], refused: [] } });
    expect(readyOps()).toHaveLength(1);
    expect(w.evaluated).toEqual(["DIPO-1"]);
  });

  it("refuses the whole command, changing nothing, for an unknown, draft or archived id", async () => {
    story("DIPO-1", "Refined");
    const archived = story("DIPO-3", "Refined");
    w.office.immediate(() => removeStory(w.office, archived, w.t.clock.now()));
    for (const [bad, code] of [
      ["DIPO-9", "story.unknown"],
      ["DRAFT-4", "story.draft"],
      ["draft-4", "story.draft"],
      ["DIPO-3", "story.unknown"],
    ] as const) {
      const reply = await send(["DIPO-1", bad]);
      expect(reply).toMatchObject({ ok: false, error: { code } });
    }
    expect(w.evaluated).toEqual([]);
    expect(readyOps()).toEqual([]);
    expect(w.flushes.n).toBe(0);
  });

  it("refuses with no lane or gate", async () => {
    const bare = new StoryPlanning({ stories: backlogLayout, lane: () => w.lane } as never);
    story("DIPO-1", "Refined");
    const ctx = { office: w.office } as never;
    const error = await bare.ready(ctx, { stories: ["DIPO-1"] }).catch((e: unknown) => e);
    expect((error as CommandError).error.code).toBe("planning.notFiled");
  });
});

describe("the one Ready function (DIPO-482)", () => {
  it("is what planning.ready and story.ready both call", async () => {
    const [session, planning] = await Promise.all([
      source("planning-session.ts"),
      source("planning.ts"),
    ]);
    expect(session).toContain("readyStories(");
    expect(planning).toContain("readyStories(");
    expect(session).not.toContain("recordGateDecision(open");
    expect(planning).not.toContain("recordGateDecision(");
  });

  it("answers a story with no key as not on the base, without touching the gate", async () => {
    const outcome = await readyStory(
      {
        office: w.office,
        lane: w.lane,
        gate: { recordGateDecision: async () => Promise.reject() } as never,
      },
      { story: "DIPO-7", key: null },
    );
    expect(outcome.change).toBeUndefined();
    expect(outcome.messages.join()).toContain("not on the base branch");
  });
});
