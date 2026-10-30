// `work.resume` of `resumption.ts` (DIPO-138, DIPO-344, DIPO-359): a story parked with no run gets
// its status back through the planning lane, every park with a run goes to the one resume path
// (test/run/resume-parks.test.ts), a story that already runs answers `changed: false` (0005), and
// any other story that is not parked answers story.notParked, also when a plan limit held its run
// before dipo paused starts instead. Driven on a migrated state database with one story run, a fake
// planning lane, a fake unpark writer and a fake next session.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { type Lifecycle, StoryId, type StoryKey } from "@dipsaus-orchestrator/contract";

import { insertPark, mirrorStory } from "./park-fixture";
import { CommandError } from "../../src/commands/errors";
import type { AsyncCommandContext } from "../../src/commands/registry";
import {
  createRunOutcomes,
  type Resumption,
  type RunEnder,
  type UnparkBranchRequest,
} from "../../src/run";
import { insertRun, raiseSignal, recordIntent } from "../../src/records";
import { type HeldSession, withHeld } from "./held-session";
import { addStory } from "../../src/stories/keys";
import { encode } from "../../src/workers/claude-cli/encode";
import type { Caps } from "../../src/workers/types";
import { insertClaim } from "../../src/worktree/records";
import { type IngestFixture, ingestFixture } from "../ingest/helpers";
import { backlogLayout } from "../story-store/backlog";

const CAPS: Caps = { budgetTokens: 1_000_000, maxTurns: 100, maxMinutes: 30 };

interface World {
  readonly dir: string;
  readonly f: IngestFixture;
  readonly key: StoryKey;
  readonly lifts: UnparkBranchRequest[];
  readonly sessions: HeldSession[];
  /** The fake planning lane's resumes of a park with no run. */
  readonly holds: { parkId: number; note: string | undefined }[];
}

let w: World;

beforeEach(async () => {
  const dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "resumption-"));
  const f = await ingestFixture(dir);
  const { office, run } = f;
  const { key } = office.immediate(() =>
    addStory(office, f.t.ids, { story: StoryId.parse("DIPO-1") }, f.t.clock.now()),
  );
  office.immediate(() => {
    insertRun(office, {
      runId: run,
      kind: "story",
      key,
      story: "DIPO-1",
      tier: "M",
      role: "developer",
      model: "haiku",
      startSha: "b".repeat(40),
      branch: "DIPO-1/add-a-greeting",
      budgetUnit: "tokens",
      budgetLimit: CAPS.budgetTokens,
      loopCap: 3,
      reviewRoundCap: null,
      configHash: "h",
      overrideKeys: null,
      runProfileId: null,
      startedAt: f.t.clock.now(),
    });
    insertClaim(office, {
      runId: run,
      key,
      story: "DIPO-1",
      branch: "DIPO-1/add-a-greeting",
      base: "main",
      baseSha: "b".repeat(40),
      startSha: "b".repeat(40),
      claimSha: "d".repeat(40),
      reused: false,
      claimedAt: f.t.clock.now(),
    });
    office.run(
      `insert into agents (office_id, agent_id, run_id, role, model, session_id, started_at,
         ended_at, end_reason)
       values ($office_id, $agent, $run, 'developer', 'haiku', 'session-1', $at, $at, 'exited')`,
      { agent: f.agent, run, at: f.t.clock.now() },
    );
  });
  w = { dir, f, key, lifts: [], sessions: [], holds: [] };
});

afterEach(() => {
  w.f.t.state.close();
  rmSync(w.dir, { recursive: true, force: true });
});

/** The resumption with fakes for everything that would reach git or a worker. */
function resumption(): Resumption {
  const { f } = w;
  const ender = { isTracked: () => false } as unknown as RunEnder;
  return createRunOutcomes(
    {
      stories: backlogLayout,
      clock: f.t.clock,
      offices: { get: () => f.office },
      steering: { send: async () => ({ ok: true }) },
      encode,
      worker: { id: "claude-cli", result: () => ({ outcome: "done", resumable: true }) as never },
      ender: () => ender,
      resumer: {
        next: async (request) => {
          w.sessions.push(withHeld(f.office, request, f.t.clock.now()));
          return { kind: "started", agent: "agt_x" as never, resumed: true };
        },
      },
      caps: () => CAPS,
      unpark: {
        lift: async (_office, request) => {
          w.lifts.push(request);
          return { commit: null, pushed: true, pushError: null };
        },
      },
    },
    {
      holds: () => ({
        resumeHold: async (_ctx, _identity, park, note): Promise<Lifecycle> => {
          w.holds.push({ parkId: park.parkId, note });
          return park.from === "Ready" ? "Ready" : "Refined";
        },
      }),
    },
  ).resumption;
}

/** Parks the story `reason` from Ready with no run, as `story.park` of a Ready story does. */
function parkWithoutRun(reason: string): number {
  const { office, t } = w.f;
  office.immediate(() =>
    insertPark(office, {
      key: w.key,
      story: "DIPO-1",
      runId: null,
      reason,
      from: "Ready",
      detail: "after M2",
      at: t.clock.now(),
    }),
  );
  return office.get<{ id: number }>(
    "select max(park_id) as id from parks where office_id = $office_id",
  )?.id as number;
}

/** The run as a plan-limit hold left it before DIPO-359: its `plan-limit` signal and wait fact. */
function legacyHold(): void {
  const { office, run, t } = w.f;
  const at = t.clock.now();
  office.immediate(() => {
    raiseSignal(office, run, "plan-limit", at);
    recordIntent(
      office,
      run,
      "pause",
      `plan-limit ${JSON.stringify({ scope: "credits", since: at })}`,
      at,
    );
  });
}

function ctx(): AsyncCommandContext {
  return {
    office: w.f.office,
    stories: { get: () => ({ story: "DIPO-1", key: w.key }) },
  } as unknown as AsyncCommandContext;
}

async function refusal(of: Resumption): Promise<CommandError | null> {
  try {
    await of.resumeCommand(ctx(), { story: StoryId.parse("DIPO-1") });
  } catch (error) {
    if (error instanceof CommandError) return error;
    throw error;
  }
  return null;
}

describe("work.resume", () => {
  it("returns a story parked with no run to its status through the planning lane", async () => {
    const parkId = parkWithoutRun("by-maintainer");
    const reply = await resumption().resumeCommand(
      { ...ctx(), stories: { get: () => ({ story: "DIPO-1", key: w.key }) } } as never,
      { story: StoryId.parse("DIPO-1"), note: "M2 is out" },
    );
    expect(reply.result).toEqual({ story: "DIPO-1", key: w.key, to: "Ready" });
    expect(w.holds).toEqual([{ parkId, note: "M2 is out" }]);
    expect(w.lifts).toEqual([]);
    expect(w.sessions).toEqual([]);
  });

  for (const status of ["In Progress", "In Review"] as const) {
    it(`answers changed: false and changes nothing for a story that already runs (${status})`, async () => {
      const { office } = w.f;
      office.immediate(() => mirrorStory(office, { key: w.key, story: "DIPO-1", status }));
      const before = office.get<{ seq: number }>(
        "select max(seq) as seq from change_log where office_id = $office_id",
      );
      const reply = await resumption().resumeCommand(ctx(), { story: StoryId.parse("DIPO-1") });
      expect(reply.changed).toBe(false);
      expect(reply.result).toEqual({ story: "DIPO-1", key: w.key, to: status, run: w.f.run });
      expect(
        office.get<{ seq: number }>(
          "select max(seq) as seq from change_log where office_id = $office_id",
        ),
      ).toEqual(before);
      expect(w.sessions).toEqual([]);
      expect(w.lifts).toEqual([]);
      expect(w.holds).toEqual([]);
    });
  }

  it("answers story.notParked for a Ready story", async () => {
    w.f.office.immediate(() =>
      mirrorStory(w.f.office, { key: w.key, story: "DIPO-1", status: "Ready" }),
    );
    const error = await refusal(resumption());
    expect(error?.error.code).toBe("story.notParked");
  });

  it("answers story.notParked for a story that is not parked", async () => {
    const error = await refusal(resumption());
    expect(error?.error.code).toBe("story.notParked");
    expect(error?.error.message).toBe("DIPO-1 is not parked, so there is nothing to resume.");
    expect(error?.error.details).toEqual({ story: "DIPO-1" });
  });

  it("no longer continues a run a plan limit held: work.resume resumes only parks (0020)", async () => {
    legacyHold();
    const error = await refusal(resumption());
    expect(error?.error.code).toBe("story.notParked");
    expect(w.sessions).toEqual([]);
    expect(w.lifts).toEqual([]);
  });
});
