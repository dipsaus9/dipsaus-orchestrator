// `story.park`, `story.drop` and the `work.resume` of a park with no run (DIPO-160, DIPO-344; 0020), fast and
// local: a migrated state database with stories mirrored from a pretend base, a lane that journals
// into the real journal and records its flushes, a code host that records its PR closes and a git
// whose calls answer from the test. A claim has no worktree (DIPO-349). The real lane, git and
// Backlog CLI run in planning.ci.test.ts.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  type OfficeId,
  RequestId,
  type RunId,
  StoryId,
  type StoryKey,
} from "@dipsaus-orchestrator/contract";

import {
  allEntries,
  failedHoldDeskItems,
  LaneError,
  type LaneOp,
  type OfficeLane,
  pendingLaneOp,
  planningLane,
} from "../../src/backlog/lane";
import { insertPark, mirrorParked } from "./park-fixture";
import { insertEntry, updateEntry } from "../../src/backlog/lane/journal";
import { heldParkDeskItems } from "../../src/overview/desk";
import { executeCommand } from "../../src/commands/execute";
import { CRASH, crashAfterHandler } from "../commands/crash";
import { executeRead } from "../../src/reads/execute";
import { stateOfficeDirectory } from "../../src/commands/offices";
import { buildRegistry, type FeatureModule } from "../../src/commands/registry";
import { MemoryRequestTable } from "../../src/commands/requests";
import type { OfficeHandle } from "../../src/db/office";
import type { OfficeGit } from "../../src/git";
import { openPark } from "../../src/run";
import { insertRun } from "../../src/records";
import { WorkResumeCommand } from "../../src/run/work-resume";
import { insertStoryPr, latestStoryPr } from "../../src/records/story-prs";
import { addStory } from "../../src/records/story-keys";
import type { BacklogStory } from "../../src/stories/read";
import { writeMirror } from "../../src/stories/apply";
import { StoryPlanning } from "../../src/run/planning";
import { insertClaim, liveClaimOf, releasedBranchFor } from "../../src/worktree/records";
import { CodeHostError } from "../../src/platform/host";
import { addOffice, openTestState, type TestState } from "../commands/helpers";
import { backlogLayout } from "../story-store/backlog";

interface Closed {
  repo: string;
  number: number;
  comment: string;
}

interface World {
  readonly dir: string;
  readonly t: TestState;
  readonly office: OfficeHandle;
  readonly ops: LaneOp[];
  readonly flushes: { n: number };
  readonly closed: Closed[];
  readonly planning: StoryPlanning;
  readonly registry: ReturnType<typeof buildRegistry>;
  readonly hooks: {
    alive: number[];
    commits: string[];
    /** Why deleting a local branch fails, when set. */
    deleteFails: string | undefined;
    calls: string[][];
    goneBranches: string[];
    /** The `story.park` calls handed to run control for a story with a run. */
    parkedRuns: { story: string; note: string }[];
  };
}

let w: World;

/** The start time of the worker host the fake probe knows. */
const HOST_START = 1_767_225_600_000;

function fakeLane(office: OfficeHandle, t: TestState, ops: LaneOp[], flushes: { n: number }) {
  return {
    journal: async (op: LaneOp) => {
      // The real lane's refusal of a story with a live claim, unless the caller releases it.
      if (
        op.releasesClaim !== true &&
        op.key !== undefined &&
        liveClaimOf(office, op.key) !== null
      ) {
        throw new LaneError("backlog.lane.liveClaim", "live claim", { key: op.key });
      }
      ops.push(op);
      return office.immediate(() => insertEntry(office, op, t.clock.now()));
    },
    flush: async () => {
      flushes.n += 1;
      return {};
    },
    office,
    clock: t.clock,
  } as unknown as OfficeLane;
}

/** The tip `rev-parse` reports for every local branch the fake git has. */
const BRANCH_TIP = "7".repeat(40);

interface FakeGitOptions {
  /** The `sha<TAB>subject` lines `git log` lists (DIPO-228). */
  readonly commits?: readonly string[];
  /** Why `update-ref -d` of a local branch fails, when set. */
  readonly deleteFails?: string | undefined;
  /** Every step's arguments, in order. */
  readonly calls?: string[][];
  /** Local branches deleted by hand: `rev-parse --verify` of them fails. */
  readonly goneBranches?: readonly string[];
}

/**
 * A git whose calls answer from the test: `git log` lists the `commits`, `update-ref -d` fails with
 * `deleteFails` when set, and every other step succeeds with no output (`rev-parse` finds no remote
 * ref, so the base is local `main`).
 */
function fakeGit(options: FakeGitOptions = {}): OfficeGit {
  const session = {
    repository: { kind: "repository" },
    ok: async (_location: unknown, args: string[]) => {
      if (args[0] === "log") return options.commits?.map((line) => `${line}\n`).join("") ?? "";
      return "";
    },
    step: async (_location: unknown, args: string[]) => {
      options.calls?.push(args);
      if (args[0] === "update-ref" && args[1] === "-d" && options.deleteFails !== undefined) {
        return { code: 1, stdout: "", stderr: options.deleteFails };
      }
      // A local branch exists unless it is listed as gone; the remote base never does here.
      const ref = args.at(-1) ?? "";
      const branch = ref.startsWith("refs/heads/")
        ? ref.slice(11).replace(/\^\{commit\}$/, "")
        : null;
      const found = branch !== null && !(options.goneBranches ?? []).includes(branch);
      if (args[0] !== "rev-parse") return { code: 0, stdout: "", stderr: "" };
      return found
        ? { code: 0, stdout: `${BRANCH_TIP}\n`, stderr: "" }
        : { code: 1, stdout: "", stderr: "" };
    },
  };
  return {
    run: (item: (git: unknown) => Promise<unknown>) => item(session),
    resolveBaseIn: async () => "main",
    settings: { remote: "origin" },
  } as unknown as OfficeGit;
}

beforeEach(async () => {
  const dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "planning-"));
  const t = await openTestState(dir);
  const office = addOffice(t);
  const ops: LaneOp[] = [];
  const flushes = { n: 0 };
  const closed: Closed[] = [];
  const hooks = {
    alive: [] as number[],
    commits: [] as string[],
    deleteFails: undefined as string | undefined,
    calls: [] as string[][],
    goneBranches: [] as string[],
    parkedRuns: [] as { story: string; note: string }[],
  };
  const planning = new StoryPlanning({
    stories: backlogLayout,
    parkRun: async (_ctx, args) => {
      hooks.parkedRuns.push({ story: args.story, note: args.note });
      return { result: { run: "run_01J9ZK5Q8W3V4X6Y7Z8A9B0C5H" as RunId } };
    },
    lane: () => planningLane(fakeLane(office, t, ops, flushes)),
    git: () =>
      fakeGit({
        commits: hooks.commits,
        deleteFails: hooks.deleteFails,
        calls: hooks.calls,
        goneBranches: hooks.goneBranches,
      }),
    host: {
      closePr: async (repo, number, comment) => {
        closed.push({ repo, number, comment });
      },
    },
    implemented: () => true,
    probe: async (pid) =>
      hooks.alive.includes(pid)
        ? { pid, startTimeMs: HOST_START, zombie: false, command: "dipo daemon worker-host" }
        : null,
  });
  const resume = new WorkResumeCommand(backlogLayout, () => planning);
  const registry = buildRegistry([planning.feature, resume.feature as FeatureModule]);
  w = { dir, t, office, ops, flushes, closed, planning, registry, hooks };
});

afterEach(() => {
  w.t.state.close();
  rmSync(w.dir, { recursive: true, force: true });
});

interface StorySpec {
  readonly status: string;
  readonly kind?: "task" | "draft";
  readonly dependencies?: readonly string[];
  readonly park?: { reason: string; from: string; note: string };
}

/** A story in the index and the mirror, as a pass over the base would leave it. */
function story(id: string, spec: StorySpec): StoryKey {
  const { office, t } = w;
  return office.immediate(() => {
    const { key } = addStory(office, t.ids, { story: StoryId.parse(id) }, t.clock.now());
    const read: BacklogStory = {
      kind: spec.kind ?? "task",
      story: StoryId.parse(id),
      title: `Title of ${id}`,
      status: spec.status,
      labels: ["tier:M"],
      tier: "M",
      contentHash: `hash-${id}`,
      waitingOn: [],
      ...(spec.park === undefined ? {} : { park: spec.park as never }),
      ...(spec.dependencies === undefined
        ? {}
        : { gateTask: { id, dependencies: [...spec.dependencies] } }),
    };
    writeMirror(
      office,
      key,
      read,
      t.clock.now(),
      "base",
      spec.dependencies === undefined ? undefined : "sha",
    );
    return key;
  });
}

function activeRun(key: StoryKey, id: string): RunId {
  const { office, t } = w;
  const runId = t.ids.next("run") as RunId;
  office.immediate(() =>
    insertRun(office, {
      runId,
      kind: "story",
      key,
      story: id,
      tier: "M",
      role: "developer",
      model: "haiku",
      startSha: "b".repeat(40),
      branch: `${id}/work`,
      budgetUnit: "tokens",
      budgetLimit: 1000,
      loopCap: 3,
      reviewRoundCap: null,
      configHash: "h",
      overrideKeys: null,
      runProfileId: null,
      startedAt: t.clock.now(),
    }),
  );
  return runId;
}

function claim(key: StoryKey, id: string, runId: RunId): void {
  const { office, t } = w;
  office.immediate(() =>
    insertClaim(office, {
      runId,
      key,
      story: id,
      branch: `${id}/work`,
      base: "main",
      baseSha: "b".repeat(40),
      startSha: "b".repeat(40),
      claimSha: "d".repeat(40),
      reused: false,
      claimedAt: t.clock.now(),
    }),
  );
}

function park(key: StoryKey, id: string, reason: string, from: string, runId: RunId | null): void {
  const { office, t } = w;
  office.immediate(() =>
    insertPark(office, {
      key,
      story: id,
      runId,
      reason,
      from,
      detail: "detail",
      at: t.clock.now(),
    }),
  );
}

let sequence = 0;
async function send(
  name: string,
  args: Record<string, unknown>,
  retry?: { readonly id: string; readonly crash: boolean },
) {
  sequence += 1;
  const deps = {
    registry: w.registry,
    offices: stateOfficeDirectory(w.t.state),
    clock: w.t.clock,
    ids: w.t.ids,
    softwareRequests: new MemoryRequestTable(w.t.clock),
  };
  return await executeCommand(
    // A crash after the handler's commits and before the requests row (DIPO-168 in DIPO-155).
    retry?.crash === true ? crashAfterHandler(deps, name) : deps,
    {
      requestId: RequestId.parse(
        retry?.id ?? `01J9ZK5Q8W3V4X6Y7Z${String(sequence).padStart(8, "0")}`,
      ),
      name,
      args,
      origin: "cli",
      confirmed: true,
      office: w.office.officeId as OfficeId,
    },
  );
}

/** A parked story with a claim whose run has one worker host, PID 4242, recorded. */
function parkedClaim(id: string): StoryKey {
  const key = story(id, {
    status: "Parked",
    park: { reason: "by-maintainer", from: "In Progress", note: "stopped" },
  });
  const runId = w.t.ids.next("run") as RunId;
  claim(key, id, runId);
  park(key, id, "by-maintainer", "In Progress", null);
  w.office.immediate(() =>
    w.office.run(
      `insert into worker_hosts (office_id, run_id, agent_id, pid, start_time_ms, socket_path,
         protocol_version, run_dir, event_file, started_at)
       values ($office_id, $run, 'agent-1', 4242, $start, '/s', 1, '/d', '/e', 0)`,
      { run: runId, start: HOST_START },
    ),
  );
  return key;
}

function errorOf(reply: Awaited<ReturnType<typeof send>>): { code: string; message: string } {
  if (reply.ok) throw new Error(`expected an error, got ${JSON.stringify(reply)}`);
  return reply.error;
}

/** The change-log entries of a type, in order. */
function entries(type: string): { key: string | null; delta: Record<string, unknown> }[] {
  return w.office
    .all<{ key: string | null; delta: string }>(
      "select key, delta from change_log where office_id = $office_id and type = $type order by seq",
      { type },
    )
    .map((row) => ({ key: row.key, delta: JSON.parse(row.delta) as Record<string, unknown> }));
}

describe("story.park", () => {
  for (const status of ["Refined", "Ready"]) {
    it(`journals a lane-b park writing F16 by-maintainer and status Parked for a ${status} story`, async () => {
      const key = story("DIPO-7", { status });
      const reply = await send("story.park", { story: "DIPO-7", note: "after M2" });
      expect(reply).toMatchObject({ ok: true, changed: true, result: { story: "DIPO-7", key } });

      expect(w.ops).toEqual([
        {
          kind: "hold",
          key,
          subject: "DIPO-7",
          target: {
            from: ["Refined", "Ready", "To Do"],
            status: "Parked",
            fields: { park: { reason: "by-maintainer", from: status, note: "after M2" } },
          },
        },
      ]);
      // The pending-op skip applies at once, while the base still says the story is `status`.
      expect(pendingLaneOp(w.office, key)).not.toBeNull();
      expect(w.flushes.n).toBe(1);
      expect(openPark(backlogLayout, w.office, key)).toMatchObject({
        reason: "by-maintainer",
        from: status,
        detail: "after M2",
        runId: null,
      });
      expect(entries("story.state").at(-1)?.delta).toMatchObject({
        from: status,
        to: "Parked",
      });
      expect(entries("story.parked").at(-1)?.delta).toMatchObject({
        reason: "by-maintainer",
        detail: "after M2",
        from: status,
        actions: ["work.resume", "work.discard", "story.drop"],
      });
      expect(w.hooks.parkedRuns).toEqual([]);
    });
  }

  it("answers a park of a parked story as the target state and journals nothing again", async () => {
    story("DIPO-7", { status: "Ready" });
    await send("story.park", { story: "DIPO-7", note: "later" });
    const again = await send("story.park", { story: "DIPO-7", note: "later" });
    expect(again).toMatchObject({ ok: true, changed: false });
    const other = await send("story.park", { story: "DIPO-7", note: "other" });
    expect(other).toMatchObject({ ok: true, changed: false });
    expect(w.ops).toHaveLength(1);
  });

  it("journals one park when a crash before the requests row makes the retry run the handler again (DIPO-168)", async () => {
    story("DIPO-7", { status: "Ready" });
    const id = "01J9ZK5Q8W3V4X6Y7Z90000001";
    const crashed = await send(
      "story.park",
      { story: "DIPO-7", note: "later" },
      { id, crash: true },
    );
    expect(crashed.ok ? null : crashed.error.message).toContain(CRASH);
    expect(w.ops).toHaveLength(1);
    const retried = await send(
      "story.park",
      { story: "DIPO-7", note: "later" },
      { id, crash: false },
    );
    expect(retried).toMatchObject({ ok: true });
    expect(w.ops).toHaveLength(1);
    expect(entries("story.state")).toHaveLength(1);
  });

  it("hands a running story to run control, which stops its worker, and journals nothing", async () => {
    const key = story("DIPO-7", { status: "In Progress" });
    claim(key, "DIPO-7", activeRun(key, "DIPO-7"));
    const reply = await send("story.park", { story: "DIPO-7", note: "wrong approach" });
    expect(reply).toMatchObject({
      ok: true,
      result: { story: "DIPO-7", key, run: "run_01J9ZK5Q8W3V4X6Y7Z8A9B0C5H" },
    });
    expect(w.hooks.parkedRuns).toEqual([{ story: key, note: "wrong approach" }]);
    expect(w.ops).toEqual([]);
    expect(allEntries(w.office)).toEqual([]);
  });

  it("hands a story In Review with its claim to run control", async () => {
    const key = story("DIPO-7", { status: "In Review" });
    claim(key, "DIPO-7", w.t.ids.next("run") as RunId);
    await send("story.park", { story: "DIPO-7", note: "after the release" });
    expect(w.hooks.parkedRuns).toEqual([{ story: key, note: "after the release" }]);
    expect(w.ops).toEqual([]);
  });

  it("answers a parked story with a claim as parked already, changing nothing", async () => {
    const key = story("DIPO-7", {
      status: "Parked",
      park: { reason: "by-maintainer", from: "In Progress", note: "stopped" },
    });
    claim(key, "DIPO-7", w.t.ids.next("run") as RunId);
    park(key, "DIPO-7", "by-maintainer", "In Progress", null);
    const reply = await send("story.park", { story: "DIPO-7", note: "x" });
    expect(reply).toMatchObject({ ok: true, changed: false });
    expect(w.ops).toEqual([]);
    expect(w.hooks.parkedRuns).toEqual([]);
  });

  it("refuses a draft and a Done story", async () => {
    story("DRAFT-1", { status: "Draft", kind: "draft" });
    story("DIPO-8", { status: "Done" });
    expect(errorOf(await send("story.park", { story: "DRAFT-1", note: "x" })).code).toBe(
      "story.notParkable",
    );
    expect(errorOf(await send("story.park", { story: "DIPO-8", note: "x" })).code).toBe(
      "story.notParkable",
    );
  });
});

describe("work.resume of a story parked with no run", () => {
  it("lifts F16 in lane b, sets park.from, and a story back at Ready is not picked yet", async () => {
    const key = story("DIPO-7", { status: "Ready" });
    await send("story.park", { story: "DIPO-7", note: "later" });
    w.ops.length = 0;
    // Merged: the base now says Parked with the park's F16, as the index would read it.
    const entry = allEntries(w.office)[0];
    w.office.immediate(() => {
      w.office.run(
        "update backlog_journal set state = 'merged' where office_id = $office_id and op_id = $op",
        { op: entry?.opId ?? 0 },
      );
      mirrorParked(w.office, {
        key,
        story: "DIPO-7",
        reason: "by-maintainer",
        from: "Ready",
        detail: "later",
        at: w.t.clock.now(),
      });
    });
    expect(pendingLaneOp(w.office, key)).toBeNull();

    const reply = await send("work.resume", { story: "DIPO-7", note: "M2 is done" });
    expect(reply).toMatchObject({
      ok: true,
      result: { story: "DIPO-7", key, to: "Ready" },
    });
    expect(w.ops).toEqual([
      {
        kind: "resume",
        key,
        subject: "DIPO-7",
        target: { from: ["Parked"], status: "Ready", unset: ["park"] },
      },
    ]);
    // The pending-op skip covers the story until the resume merges, then the pickup re-check runs.
    expect(pendingLaneOp(w.office, key)).not.toBeNull();
    expect(w.flushes.n).toBe(2);
    expect(openPark(backlogLayout, w.office, key)).toBeNull();
    expect(
      w.office.get<{ how: string }>(
        "select resolved_how as how from parks where office_id = $office_id and key = $key",
        { key },
      )?.how,
    ).toBe("resume");
    expect(entries("story.state").at(-1)?.delta).toMatchObject({ from: "Parked", to: "Ready" });
  });

  it("returns a story parked at Refined to Refined", async () => {
    story("DIPO-7", { status: "Refined" });
    await send("story.park", { story: "DIPO-7", note: "later" });
    const reply = await send("work.resume", { story: "DIPO-7" });
    expect(reply).toMatchObject({ ok: true, result: { to: "Refined" } });
  });

  it("still answers story.notParked for a story that is not parked", async () => {
    story("DIPO-7", { status: "Ready" });
    expect(errorOf(await send("work.resume", { story: "DIPO-7" })).code).toBe("story.notParked");
  });
});

/** Parks DIPO-7 from Ready, then closes its hold as `failed`, as the lane does when the CLI fails. */
async function parkThatFails(): Promise<StoryKey> {
  const key = story("DIPO-7", { status: "Ready" });
  await send("story.park", { story: "DIPO-7", note: "later" });
  const hold = allEntries(w.office)[0];
  w.office.immediate(() =>
    updateEntry(
      w.office,
      hold?.opId ?? 0,
      {
        state: "failed",
        notice: "The backlog operation `backlog: hold DIPO-7` failed and is closed.",
      },
      w.t.clock.now(),
    ),
  );
  return key;
}

/** Journals a change of DIPO-7 of `kind` and moves it to `state`. */
function later(key: StoryKey, kind: string, state: "withdrawn" | "dropped" | "failed" | "merged") {
  w.office.immediate(() => {
    const entry = insertEntry(
      w.office,
      { kind, key, subject: "DIPO-7", target: {} },
      w.t.clock.now(),
    );
    updateEntry(w.office, entry.opId, { state }, w.t.clock.now());
  });
}

describe("a park whose hold failed to write (DIPO-401)", () => {
  it("keeps the story out of pickup and on the desk with dipo park and dipo resume", async () => {
    const key = await parkThatFails();
    // No operation is open, yet the story stays held: fail closed.
    expect(pendingLaneOp(w.office, key)).toBeNull();
    expect(backlogLayout.planningHold(w.office, key)).toBe("holdFailed");
    expect(failedHoldDeskItems(w.office)).toEqual([
      {
        kind: "PARK NOT WRITTEN",
        key,
        story: "DIPO-7",
        detail:
          "your park of DIPO-7 failed to write to Backlog.md, so dipo does not pick it: The backlog operation `backlog: hold DIPO-7` failed and is closed.",
        since: w.t.clock.now(),
        actions: [
          { command: "story.park", cli: `dipo park DIPO-7 --note "<why>"` },
          { command: "work.resume", cli: "dipo resume DIPO-7" },
        ],
      },
    ]);
    // Its open park row is not listed a second time as a park Backlog.md no longer holds.
    expect(heldParkDeskItems(w.office, backlogLayout)).toEqual([]);
  });

  it("is sent again by dipo park, which replaces the earlier park row", async () => {
    const key = await parkThatFails();
    const reply = await send("story.park", { story: "DIPO-7", note: "later, again" });
    expect(reply).toMatchObject({ ok: true, changed: true });
    expect(allEntries(w.office).map((entry) => [entry.kind, entry.state])).toEqual([
      ["hold", "failed"],
      ["hold", "pending"],
    ]);
    expect(backlogLayout.planningHold(w.office, key)).toBe("pending");
    expect(
      w.office.all<{ how: string | null; detail: string }>(
        "select resolved_how as how, detail from parks where office_id = $office_id and key = $key order by park_id",
        { key },
      ),
    ).toEqual([
      { how: "reconcile", detail: "later" },
      { how: null, detail: "later, again" },
    ]);
  });

  it("is dismissed by dipo resume: the hold is withdrawn and pickup may take the story again", async () => {
    const key = await parkThatFails();
    const reply = await send("work.resume", { story: "DIPO-7", note: "never mind" });
    expect(reply).toMatchObject({
      ok: true,
      changed: true,
      result: { story: "DIPO-7", key, to: "Ready" },
    });
    expect(allEntries(w.office)[0]?.state).toBe("withdrawn");
    expect(backlogLayout.planningHold(w.office, key)).toBeNull();
    expect(failedHoldDeskItems(w.office)).toEqual([]);
    expect(
      w.office.get<{ how: string }>(
        "select resolved_how as how from parks where office_id = $office_id and key = $key",
        { key },
      )?.how,
    ).toBe("resume");
    // Nothing is left to dismiss.
    expect(errorOf(await send("work.resume", { story: "DIPO-7" })).code).toBe("story.notParked");
  });

  it("stays in force when a later drop or discard of the story is withdrawn, dropped or fails", async () => {
    const key = await parkThatFails();
    later(key, "drop", "withdrawn");
    expect(backlogLayout.planningHold(w.office, key)).toBe("holdFailed");
    later(key, "discard", "dropped");
    expect(backlogLayout.planningHold(w.office, key)).toBe("holdFailed");
    later(key, "hold", "failed");
    later(key, "resume", "failed");
    expect(backlogLayout.planningHold(w.office, key)).toBe("holdFailed");
    expect(failedHoldDeskItems(w.office)).toHaveLength(1);
    // A change that is not the maintainer's answer to the park lifts nothing either.
    later(key, "edit", "merged");
    expect(backlogLayout.planningHold(w.office, key)).toBe("holdFailed");
    // The dismiss withdraws both failed holds: nothing older comes back in force.
    expect(await send("work.resume", { story: "DIPO-7" })).toMatchObject({
      ok: true,
      result: { dismissed: true },
    });
    expect(backlogLayout.planningHold(w.office, key)).toBeNull();
    expect(
      allEntries(w.office)
        .filter((entry) => entry.kind === "hold")
        .map((entry) => entry.state),
    ).toEqual(["withdrawn", "withdrawn"]);
  });

  it("is lifted by a later drop of the story that merged", async () => {
    const key = await parkThatFails();
    later(key, "drop", "merged");
    expect(backlogLayout.planningHold(w.office, key)).toBeNull();
    expect(failedHoldDeskItems(w.office)).toEqual([]);
  });

  it("is dismissed by dipo resume first, whatever status a hand edit gave the story", async () => {
    const key = await parkThatFails();
    w.office.immediate(() =>
      w.office.run(
        "update backlog_mirror set status = 'In Progress' where office_id = $office_id and key = $key",
        { key },
      ),
    );
    const reply = await send("work.resume", { story: "DIPO-7" });
    expect(reply).toMatchObject({
      ok: true,
      changed: true,
      result: { story: "DIPO-7", key, to: "In Progress", dismissed: true },
    });
    expect(backlogLayout.planningHold(w.office, key)).toBeNull();
  });
});

describe("story.drop", () => {
  it("journals a drop that releases the claim, and says Removed", async () => {
    const key = story("DIPO-7", { status: "Ready" });
    const reply = await send("story.drop", { story: "DIPO-7", deleteBranch: false });
    expect(reply).toMatchObject({ ok: true, changed: true, result: { story: "DIPO-7", key } });
    expect(w.ops).toEqual([
      { kind: "drop", key, subject: "DIPO-7", target: { kind: "task" }, releasesClaim: true },
    ]);
    expect(pendingLaneOp(w.office, key)).not.toBeNull();
    expect(w.flushes.n).toBe(1);
    expect(entries("story.state").at(-1)?.delta).toMatchObject({ from: "Ready", to: "Removed" });
    // A re-run finds the target state and writes nothing more.
    const again = await send("story.drop", { story: "DIPO-7", deleteBranch: false });
    expect(again).toMatchObject({ ok: true });
    expect(entries("story.state")).toHaveLength(1);
  });

  it("journals one drop when a crash before the requests row makes the retry run the handler again (DIPO-168)", async () => {
    story("DIPO-7", { status: "Ready" });
    const id = "01J9ZK5Q8W3V4X6Y7Z90000002";
    const args = { story: "DIPO-7", deleteBranch: false };
    const crashed = await send("story.drop", args, { id, crash: true });
    expect(crashed.ok ? null : crashed.error.message).toContain(CRASH);
    expect(w.ops).toHaveLength(1);
    const retried = await send("story.drop", args, { id, crash: false });
    expect(retried).toMatchObject({ ok: true });
    expect(w.ops).toHaveLength(1);
    expect(entries("story.state")).toHaveLength(1);
  });

  it("archives a draft as a draft", async () => {
    story("DRAFT-1", { status: "Draft", kind: "draft" });
    await send("story.drop", { story: "DRAFT-1", deleteBranch: false });
    expect(w.ops[0]?.target).toEqual({ kind: "draft" });
  });

  it("resolves the open park of a Parked story with resolved_how drop", async () => {
    const key = story("DIPO-7", {
      status: "Parked",
      park: { reason: "by-maintainer", from: "Ready", note: "later" },
    });
    park(key, "DIPO-7", "by-maintainer", "Ready", null);
    expect(openPark(backlogLayout, w.office, key)).not.toBeNull();
    const reply = await send("story.drop", { story: "DIPO-7", deleteBranch: false });
    expect(reply).toMatchObject({ ok: true });
    expect(openPark(backlogLayout, w.office, key)).toBeNull();
    expect(
      w.office.get<{ how: string }>(
        "select resolved_how as how from parks where office_id = $office_id and key = $key",
        { key },
      )?.how,
    ).toBe("drop");
    expect(entries("story.state").at(-1)?.delta).toMatchObject({ from: "Parked", to: "Removed" });
  });

  for (const status of ["In Progress", "In Review"]) {
    it(`refuses a story that is ${status}, naming dipo park`, async () => {
      story("DIPO-7", { status });
      const error = errorOf(await send("story.drop", { story: "DIPO-7", deleteBranch: false }));
      expect(error.code).toBe("story.active");
      expect(error.message).toContain("dipo park");
      expect(w.ops).toEqual([]);
    });
  }

  it("refuses a story with a running worker even when the base still says Ready", async () => {
    const key = story("DIPO-7", { status: "Ready" });
    claim(key, "DIPO-7", activeRun(key, "DIPO-7"));
    expect(errorOf(await send("story.drop", { story: "DIPO-7", deleteBranch: false })).code).toBe(
      "story.active",
    );
  });

  it("refuses a story another active story depends on, and lets it go once that is dropped or Done", async () => {
    story("DIPO-7", { status: "Ready" });
    story("DIPO-8", { status: "Ready", dependencies: ["DIPO-7"] });
    story("DIPO-9", { status: "Done", dependencies: ["DIPO-7"] });
    const error = errorOf(await send("story.drop", { story: "DIPO-7", deleteBranch: false }));
    expect(error.code).toBe("story.hasDependents");
    expect(error.message).toContain("DIPO-8");
    expect(error.message).not.toContain("DIPO-9");
    expect(w.ops).toEqual([]);
    // Dropping the dependent first (its drop is pending, not merged) lets the dependency go.
    expect(await send("story.drop", { story: "DIPO-8", deleteBranch: false })).toMatchObject({
      ok: true,
    });
    expect(await send("story.drop", { story: "DIPO-7", deleteBranch: false })).toMatchObject({
      ok: true,
    });
  });

  for (const deleteBranch of [false, true]) {
    it(`refuses a parked story whose worker host still runs, and changes nothing (deleteBranch ${deleteBranch})`, async () => {
      const key = parkedClaim("DIPO-7");
      w.hooks.alive.push(4242);
      const reply = await send("story.drop", { story: "DIPO-7", deleteBranch });
      expect(reply).toMatchObject({ ok: false, error: { code: "run.hostAlive", retryable: true } });
      const error = errorOf(reply);
      expect(error.message).toContain("DIPO-7");
      expect(error.message).toContain("4242");
      expect(error.message).toContain("in a moment");
      expect(w.ops).toEqual([]);
      expect(allEntries(w.office)).toEqual([]);
      expect(w.closed).toEqual([]);
      expect(w.flushes.n).toBe(0);
      // The claim is still live: nothing was released.
      expect(liveClaimOf(w.office, key)).not.toBeNull();
    });
  }

  it("drops a parked story once its worker host has exited", async () => {
    const key = parkedClaim("DIPO-7");
    w.hooks.alive.push(4242);
    expect(errorOf(await send("story.drop", { story: "DIPO-7", deleteBranch: false })).code).toBe(
      "run.hostAlive",
    );
    // The host has exited; the release keeps the branch and makes no git call.
    w.hooks.alive.length = 0;
    w.hooks.calls.length = 0;
    const reply = await send("story.drop", { story: "DIPO-7", deleteBranch: false });
    expect(reply).toMatchObject({ ok: true, changed: true });
    expect(liveClaimOf(w.office, key)).toBeNull();
    expect(w.hooks.calls).toEqual([]);
    expect(entries("story.state").at(-1)?.delta).toMatchObject({ from: "Parked", to: "Removed" });
  });

  it("closes the open story PR with a comment naming the drop", async () => {
    const key = story("DIPO-7", { status: "Ready" });
    const run = w.t.ids.next("run") as RunId;
    w.office.immediate(() =>
      insertStoryPr(w.office, {
        runId: run,
        key,
        number: 41,
        url: "https://github.com/acme/app/pull/41",
        branch: "DIPO-7/work",
        base: "main",
        headSha: "c".repeat(40),
        state: "open",
        title: "feat(DIPO-7): work",
        bodyHash: "h",
        openedAt: w.t.clock.now(),
        closedAt: null,
      }),
    );
    const reply = await send("story.drop", { story: "DIPO-7", deleteBranch: false });
    expect(reply).toMatchObject({ ok: true });
    expect(w.closed).toHaveLength(1);
    expect(w.closed[0]).toMatchObject({ repo: "acme/app", number: 41 });
    expect(w.closed[0]?.comment).toContain("DIPO-7");
    expect(w.closed[0]?.comment).toContain("dropped");
    expect(latestStoryPr(w.office, key)?.state).toBe("closed");
    expect(entries("story.pr").at(-1)?.delta).toMatchObject({
      pr: { number: 41, state: "closed" },
    });
  });

  it("does not close a PR that is not open, and withdraws its journal entry when the close fails", async () => {
    const key = story("DIPO-7", { status: "Ready" });
    w.office.immediate(() =>
      insertStoryPr(w.office, {
        runId: w.t.ids.next("run") as RunId,
        key,
        number: 41,
        url: "https://github.com/acme/app/pull/41",
        branch: "DIPO-7/work",
        base: "main",
        headSha: "c".repeat(40),
        state: "open",
        title: "t",
        bodyHash: "h",
        openedAt: w.t.clock.now(),
        closedAt: null,
      }),
    );
    const failing = new StoryPlanning({
      stories: backlogLayout,
      lane: () => planningLane(fakeLane(w.office, w.t, w.ops, w.flushes)),
      git: () => fakeGit(),
      host: {
        closePr: async () => {
          throw new CodeHostError("failed", "gh down");
        },
      },
      implemented: () => true,
      probe: async () => null,
    });
    const registry = buildRegistry([failing.feature]);
    const reply = await executeCommand(
      {
        registry,
        offices: stateOfficeDirectory(w.t.state),
        clock: w.t.clock,
        ids: w.t.ids,
        softwareRequests: new MemoryRequestTable(w.t.clock),
      },
      {
        requestId: RequestId.parse("01J9ZK5Q8W3V4X6Y7Z99999999"),
        name: "story.drop",
        args: { story: "DIPO-7", deleteBranch: false },
        origin: "cli",
        confirmed: true,
        office: w.office.officeId as OfficeId,
      },
    );
    expect(errorOf(reply).code).toBe("story.prNotClosed");
    // Nothing was archived, and the story is not held back by the failed drop.
    expect(allEntries(w.office).map((e) => e.state)).toEqual(["withdrawn"]);
    expect(pendingLaneOp(w.office, key)).toBeNull();
    expect(latestStoryPr(w.office, key)?.state).toBe("open");
  });

  it("names the closed PR and that the story was not archived when the release fails after the close (DIPO-228)", async () => {
    const key = story("DIPO-7", { status: "Ready" });
    const runId = w.t.ids.next("run") as RunId;
    claim(key, "DIPO-7", runId);
    w.office.immediate(() =>
      insertStoryPr(w.office, {
        runId,
        key,
        number: 41,
        url: "https://github.com/acme/app/pull/41",
        branch: "DIPO-7/work",
        base: "main",
        headSha: "c".repeat(40),
        state: "open",
        title: "t",
        bodyHash: "h",
        openedAt: w.t.clock.now(),
        closedAt: null,
      }),
    );
    // Deleting the branch fails, so the release refuses after the PR closed.
    w.hooks.deleteFails = "cannot lock ref";
    const reply = await send("story.drop", { story: "DIPO-7", deleteBranch: true });
    const message = errorOf(reply).message;
    expect(message).toContain("PR #41 was closed and the story was not archived");
    expect(message).toContain("cannot lock ref");
    expect(w.closed).toHaveLength(1);
    expect(liveClaimOf(w.office, key)).not.toBeNull();
    expect(allEntries(w.office).map((e) => e.state)).toEqual(["withdrawn"]);
  });
});

/** Records the branch a drop without a live claim keeps for the story (0010 section 2a). */
function keepBranch(key: StoryKey, branch: string): void {
  w.office.immediate(() =>
    w.office.run(
      `insert into released_branches (office_id, branch, released_at, key, reason)
       values ($office_id, $branch, $at, $key, 'drop')`,
      { branch, key, at: w.t.clock.now() },
    ),
  );
}

/** Reads `story.losses` for the story `id` through the read executor. */
async function losses(id: string) {
  sequence += 1;
  return await executeRead(
    { registry: w.registry, offices: stateOfficeDirectory(w.t.state), clock: w.t.clock },
    {
      requestId: RequestId.parse(`01J9ZK5Q8W3V4X6Y7Z${String(sequence).padStart(8, "0")}`),
      name: "story.losses",
      args: { office: w.office.officeId, story: id },
    },
  );
}

describe("story.losses and the kept branch of a story (DIPO-228)", () => {
  it("lists the commits not on the base of a live claim, and changes nothing", async () => {
    const key = story("DIPO-7", { status: "Ready" });
    claim(key, "DIPO-7", w.t.ids.next("run") as RunId);
    w.hooks.commits = ["3f9a1c2\tfeat(DIPO-7): retry", "9b2e4d0\tfix: lookup"];
    const reply = await losses("DIPO-7");
    expect(reply).toMatchObject({
      ok: true,
      result: {
        story: "DIPO-7",
        key,
        commits: [
          { sha: "3f9a1c2", subject: "feat(DIPO-7): retry" },
          { sha: "9b2e4d0", subject: "fix: lookup" },
        ],
      },
    });
    // A story has no worktree, so no file list (DIPO-349).
    expect(reply.ok && Object.keys(reply.result as object).toSorted()).toEqual([
      "commits",
      "key",
      "story",
    ]);
    expect(w.ops).toEqual([]);
    expect(w.flushes.n).toBe(0);
    expect(entries("story.state")).toEqual([]);
  });

  it("lists the commits of an open released branch", async () => {
    const key = story("DIPO-7", { status: "Ready" });
    keepBranch(key, "DIPO-7/work");
    w.hooks.commits = ["9b2e4d0\tfix: lookup"];
    expect(await losses("DIPO-7")).toMatchObject({
      ok: true,
      result: { commits: [{ sha: "9b2e4d0", subject: "fix: lookup" }] },
    });
  });

  it("skips a kept branch that was deleted by hand instead of failing the read", async () => {
    const key = story("DIPO-7", { status: "Ready" });
    keepBranch(key, "DIPO-7/work");
    w.hooks.commits = ["9b2e4d0\tfix: lookup"];
    w.hooks.goneBranches.push("DIPO-7/work");
    expect(await losses("DIPO-7")).toMatchObject({ ok: true, result: { commits: [] } });
  });

  it("answers empty lists for a story with neither a claim nor a kept branch, and changes nothing", async () => {
    story("DIPO-7", { status: "Ready" });
    w.hooks.commits = ["9b2e4d0\tfix: lookup"];
    expect(await losses("DIPO-7")).toMatchObject({ ok: true, result: { commits: [] } });
    expect(w.ops).toEqual([]);
    expect(w.flushes.n).toBe(0);
    expect(w.hooks.calls).toEqual([]);
  });

  it("deletes the kept branch of an unclaimed story with deleteBranch and reclaims its release", async () => {
    const key = story("DIPO-7", { status: "Ready" });
    keepBranch(key, "DIPO-7/work");
    const reply = await send("story.drop", { story: "DIPO-7", deleteBranch: true });
    expect(reply).toMatchObject({ ok: true, changed: true, result: { story: "DIPO-7", key } });
    expect(w.hooks.calls).toContainEqual([
      "update-ref",
      "-d",
      "refs/heads/DIPO-7/work",
      BRANCH_TIP,
    ]);
    expect(releasedBranchFor(w.office, key, "DIPO-7/work")).toBeNull();
    const row = w.office.get<{ reclaimed_at: number | null }>(
      "select reclaimed_at from released_branches where office_id = $office_id and key = $key",
      { key },
    );
    expect(row?.reclaimed_at).not.toBeNull();
  });
});
