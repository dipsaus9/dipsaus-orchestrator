// Next up (DIPO-440, 0010), fast and local: a migrated state database, a fake base read and a fake
// start in place of `work.run` (which answers at its decision and claims after it, DIPO-456),
// through the one executor. One NEXT UP item per free run slot in
// next-up order (earliest open milestone, then priority, ordinal and id; no milestone last; a
// dependency not Done never offered); confirm starts the story and nothing else does; decline
// removes the item, offers the next story at once and keeps the story out until its task file
// changes or a run of it starts; each item lists the files its references share with running
// stories; the desk shows it and the notifier posts it once.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type CommandReply,
  type DeskItem,
  type OfficeId,
  RequestId,
  RunId,
  StoryId,
  type StoryKey,
} from "@dipsaus-orchestrator/contract";
import { ManualClock, withBareRemote } from "@dipsaus-orchestrator/testkit";

import { OfficeGit, spawnGitExec } from "../../src/git";
import { systemSpawn } from "../../src/platform/process";
import { createUlid } from "../../src/platform/ids";
import type { CommandContext } from "../../src/commands/registry";
import { executeCommand, type ExecutorDeps } from "../../src/commands/execute";
import { stateOfficeDirectory } from "../../src/commands/offices";
import { buildRegistry } from "../../src/commands/registry";
import { MemoryRequestTable } from "../../src/commands/requests";
import type { OfficeHandle } from "../../src/db/office";
import { createLogger } from "../../src/log/logger";
import { desk, DESK_CONSEQUENCES, DESK_SOURCES, type DeskSources } from "../../src/overview/desk";
import { DeskNotifier } from "../../src/overview/desk-notify";
import { systemClock } from "../../src/platform/clock";
import type { NotificationText } from "../../src/platform/notify";
import { insertRun } from "../../src/records";
import { addStory } from "../../src/records/story-keys";
import { insertStoryPr, setStoryPrState, type StoryPrState } from "../../src/records/story-prs";
import { freeSlots } from "../../src/run-state";
import type { BaseRead } from "../../src/run/work-run";
import {
  gitChangedFiles,
  milestoneNumber,
  NEXT_UP_NOTICE,
  NextUp,
  type NextUpDeps,
  nextUpOrder,
  recordDecline,
  storyHash,
  TIP_READ_MS,
} from "../../src/run/next-up";
import type { PlainTask } from "../../src/story-store/story";
import { insertClaim, releaseClaim } from "../../src/worktree/records";
import { DEVELOPER_FILE, DEVELOPER_LABEL } from "./test-roles";
import { addOffice, openTestState, type TestState } from "../commands/helpers";
import { backlogLayout } from "../story-store/backlog";

function task(id: string, overrides: Partial<PlainTask> = {}): PlainTask {
  return {
    file: `/base/backlog/tasks/${id.toLowerCase()} - Story.md`,
    id,
    title: `Story ${id}`,
    status: "Ready",
    assignee: [],
    created: "2026-11-04 12:24",
    labels: ["tier:S", DEVELOPER_LABEL],
    subtasks: [],
    references: [],
    documentation: [],
    dependencies: [],
    description: "Story: As maintainer I want it so that it works.",
    acceptanceCriteria: [],
    definitionOfDone: [],
    modifiedFiles: [],
    comments: [],
    unknown: [],
    ...overrides,
  };
}

interface World {
  readonly t: TestState;
  readonly office: OfficeHandle;
  readonly officeId: OfficeId;
  readonly tasks: PlainTask[];
  readonly keys: Map<string, StoryKey>;
  readonly started: string[];
  readonly changed: Map<string, readonly string[]>;
  readonly tips: Map<string, string>;
  /** Holds the changed-files read open when set. */
  changedGate: Promise<void> | null;
  changedReads: number;
  /** The start throws when set, as a failed `work.run` does. */
  startFails: boolean;
  /** Why the last start of a story did not go on, by key (`WorkRun.startFailure`). */
  failures: Map<string, string>;
  readonly nextUp: NextUp;
  readonly deps: ExecutorDeps;
  limit: number;
  /** Holds a start's claim open when set, until the promise resolves. */
  hold: Map<string, Promise<void>>;
  /** The keys of the stories whose start the fake decided and that have not claimed yet. */
  readonly starting: Set<string>;
  /** The fake starts after their answer, for `settled`. */
  readonly starts: Promise<void>[];
  notified: number;
  /** `nextUp.autoStart` of the office. */
  mode: "none" | "no-overlap";
  /** The office's starts paused (0020, a plan limit among them) when set. */
  paused: boolean;
  /** dipo updates itself, or the desk offers the update, when set. */
  updating: boolean;
  updateOffered: boolean;
  /** What each start got: the context `work.run` is handed. */
  readonly contexts: CommandContext[];
  /** The stories whose start the fake skips, with the skip reason, as `work.run` does. */
  readonly skips: Map<string, string>;
  /** The runs whose changed files the fake cannot read: it leaves them out, as git does. */
  readonly unreadable: Set<string>;
  /** Replaces the changed-files read, for the real one and for one that throws. */
  changedImpl: NonNullable<NextUpDeps["changedFiles"]> | null;
  readonly infos: { message: string; fields: Readonly<Record<string, unknown>> }[];
  /** The start sha the claims record. */
  startSha: string;
  /** False while the daemon schedules no work. */
  scheduling: boolean;
  /** The stories whose start the fake decides and then fails, as a start that fails later does. */
  readonly failLater: Set<string>;
}

let dir = "";
let w: World;

beforeEach(async () => {
  dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "next-up-"));
  const t = await openTestState(dir);
  const office = addOffice(t);
  const read = (): BaseRead => ({
    statuses: new Map(w.tasks.map((x) => [x.id, x.status])),
    views: w.tasks.filter((x) => x.status === "Ready"),
    unparsed: [],
    checkout: { path: "/base", base: "main" },
    roles: [DEVELOPER_FILE],
  });
  const nextRequest = createUlid(t.clock);
  const nextUp = new NextUp({
    clock: t.clock,
    offices: { get: () => office, configBlocksRuns: () => [] },
    base: {
      read: async () => read(),
      planningHold: (handle, key) => backlogLayout.planningHold(handle, key),
    },
    // A decided start holds its slot until its claim, as the places count it.
    freeSlots: () => freeSlots(office, { limit: w.limit, starting: [...w.starting] }),
    start: (ctx, key) => {
      const id = ctx.stories.get(key)?.story ?? key;
      w.started.push(id);
      w.contexts.push(ctx);
      const skip = w.skips.get(id);
      if (skip !== undefined) {
        return {
          result: { started: [], skipped: [{ story: StoryId.parse(id), key, reason: skip }] },
        };
      }
      if (w.startFails) throw new Error("the box could not be prepared");
      const run = RunId.parse(w.t.ids.next("run"));
      w.starting.add(key);
      if (w.failLater.has(id)) {
        w.starts.push(
          (async () => {
            await Promise.resolve();
            w.starting.delete(key);
            w.failures.set(key, `${id} was not started: setup failed`);
            void w.nextUp.refresh(office.officeId);
          })(),
        );
        return { result: { started: [{ story: id, key, run }], skipped: [] } };
      }
      // The claim after the answer, outside the command's transaction.
      w.starts.push(
        (async () => {
          await Promise.resolve();
          await w.hold.get(id);
          claim(id, w.tasks.find((one) => one.id === id)?.references ?? [], run);
          w.starting.delete(key);
          void w.nextUp.refresh(office.officeId);
        })(),
      );
      return { result: { started: [{ story: id, key, run }], skipped: [] } };
    },
    starting: () => [...w.starting],
    startFailure: (_office, key) => w.failures.get(key),
    changedFiles: async (officeId, runs) => {
      w.changedReads += 1;
      await w.changedGate;
      if (w.changedImpl !== null) return w.changedImpl(officeId, runs);
      return new Map(
        runs
          .filter((run) => !w.unreadable.has(run.runId))
          .map((run) => [run.runId, w.changed.get(run.runId) ?? []] as const),
      );
    },
    autoStart: () => w.mode,
    scheduling: () => w.scheduling,
    startsPaused: () => (w.paused ? { reason: "plan-limit" } : null),
    updatePending: () => w.updating,
    requestId: () => RequestId.parse(nextRequest()),
    ids: t.ids,
    info: (message, fields) => {
      w.infos.push({ message, fields });
    },
    branchTips: async () => w.tips,
    onChanged: () => {
      w.notified += 1;
    },
  });
  nextUp.holdForUpdate(() => (w.updateOffered ? { commits: 1 } : null));
  const registry = buildRegistry([nextUp.feature]);
  w = {
    t,
    office,
    officeId: office.officeId,
    tasks: [],
    keys: new Map(),
    started: [],
    changed: new Map(),
    tips: new Map(),
    changedGate: null,
    changedReads: 0,
    startFails: false,
    failures: new Map(),
    nextUp,
    deps: {
      registry,
      offices: stateOfficeDirectory(t.state),
      clock: t.clock,
      ids: t.ids,
      softwareRequests: new MemoryRequestTable(t.clock),
    },
    limit: 1,
    hold: new Map(),
    starting: new Set(),
    starts: [],
    notified: 0,
    mode: "none",
    paused: false,
    updating: false,
    updateOffered: false,
    contexts: [],
    skips: new Map(),
    unreadable: new Set(),
    changedImpl: null,
    infos: [],
    startSha: "a".repeat(40),
    scheduling: true,
    failLater: new Set(),
  };
});

afterEach(() => {
  w.t.state.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Adds a story to the base and to the office's index. */
function story(id: string, overrides: Partial<PlainTask> = {}): StoryKey {
  w.tasks.push(task(id, overrides));
  const identity = w.office.immediate(() =>
    addStory(w.office, w.t.ids, { story: StoryId.parse(id) }, w.t.clock.now()),
  );
  w.keys.set(id, identity.key);
  return identity.key;
}

/** A claimed run of `id`, holding a slot, as `work.run` records it. */
function claim(
  id: string,
  scope: readonly string[] = [],
  run: RunId = RunId.parse(w.t.ids.next("run")),
): RunId {
  const key = w.keys.get(id) as StoryKey;
  w.office.immediate(() => {
    insertRun(w.office, {
      runId: run,
      kind: "story",
      key,
      story: id,
      tier: "S",
      role: "developer",
      model: "haiku",
      startSha: w.startSha,
      branch: `${id}/a-story`,
      budgetUnit: "tokens",
      budgetLimit: 1_000,
      loopCap: 3,
      reviewRoundCap: null,
      configHash: "h",
      overrideKeys: null,
      runProfileId: null,
      startedAt: w.t.clock.now(),
      scope,
    });
    insertClaim(w.office, {
      runId: run,
      key,
      story: id,
      branch: `${id}/a-story`,
      base: "main",
      baseSha: "b".repeat(40),
      startSha: w.startSha,
      claimSha: "c".repeat(40),
      reused: false,
      claimedAt: w.t.clock.now(),
    });
  });
  return run;
}

/** The office's claim rows. */
function countClaims(): number {
  return (
    w.office.get<{ n: number }>("select count(*) as n from claims where office_id = $office_id")
      ?.n ?? 0
  );
}

/** The story PR of the run `run` of `id`, as the PR poll records it. */
function storyPr(id: string, run: RunId, state: StoryPrState): void {
  w.office.immediate(() =>
    insertStoryPr(w.office, {
      runId: run,
      key: w.keys.get(id) as StoryKey,
      number: 40,
      url: "https://github.com/o/r/pull/40",
      branch: `${id}/a-story`,
      base: "main",
      headSha: "d".repeat(40),
      state,
      title: `feat(${id}): x`,
      bodyHash: "h",
      openedAt: w.t.clock.now(),
      closedAt: state === "open" ? null : w.t.clock.now(),
    }),
  );
}

/** The Done poll's release of the claim of `run` at its merge. */
function release(run: RunId): void {
  w.office.immediate(() =>
    releaseClaim(w.office, run, {
      at: w.t.clock.now(),
      reason: "done",
      ending: "done",
      keepBranch: false,
    }),
  );
}

const offered = () => w.nextUp.offers(w.officeId).map((offer) => offer.story as string);

/** The story index's pass: the mirror holds each story's status and hash as the base reads. */
function indexPass(): void {
  w.office.immediate(() => {
    w.office.run("delete from backlog_mirror where office_id = $office_id");
    for (const x of w.tasks) {
      w.office.run(
        `insert into backlog_mirror (office_id, key, content_hash, kind, status, title, labels,
           read_at, source)
         values ($office_id, $key, $hash, 'task', $status, $title, '[]', $at, 'base')`,
        {
          key: w.keys.get(x.id) as string,
          hash: storyHash(x),
          status: x.status,
          title: x.title,
          at: w.t.clock.now(),
        },
      );
    }
  });
}

async function refresh(): Promise<string[]> {
  indexPass();
  await w.nextUp.refresh(w.officeId);
  return offered();
}

let requests = 0;
function command(name: string, args: Record<string, unknown>): Promise<CommandReply> {
  requests += 1;
  return executeCommand(w.deps, {
    requestId: RequestId.parse(`01J9ZK5Q8W3V4X6Y7Z${requests.toString().padStart(8, "0")}`),
    name,
    args,
    origin: "cli",
    confirmed: false,
    office: w.officeId,
  });
}

function resultOf<T>(reply: CommandReply): T {
  if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`);
  return reply.result as T;
}

describe("which story is next up", () => {
  it("offers one item for a free slot: the earliest open milestone first, then priority, ordinal and id; no milestone last", async () => {
    story("DIPO-1", { milestone: "m-2", priority: "high", ordinal: 1 });
    story("DIPO-2", { milestone: "m-1", priority: "low", ordinal: 5 });
    story("DIPO-3", { priority: "high", ordinal: 1 });
    story("DIPO-4", { milestone: "m-1", priority: "low", ordinal: 2 });
    story("DIPO-5", { milestone: "m-10", priority: "high" });
    expect(await refresh()).toEqual(["DIPO-4"]);
    const [offer] = w.nextUp.offers(w.officeId);
    expect(offer?.why).toBe(
      "m-1 is the earliest milestone with a Ready story that can start; priority low",
    );
    w.limit = 5;
    expect(await refresh()).toEqual(["DIPO-4", "DIPO-2", "DIPO-1", "DIPO-5", "DIPO-3"]);
    expect(w.nextUp.offers(w.officeId).map((one) => one.why)).toEqual([
      "m-1 is the earliest milestone with a Ready story that can start; priority low",
      "next Ready story by milestone (m-1); priority low",
      "next Ready story by milestone (m-2); priority high",
      "next Ready story by milestone (m-10); priority high",
      "no milestone has a Ready story that can start before it; priority high",
    ]);
  });

  it("carries why a story's last start did not go on on its offer (DIPO-488)", async () => {
    story("DIPO-1");
    expect(await refresh()).toEqual(["DIPO-1"]);
    expect(w.nextUp.offers(w.officeId)[0]?.failed).toBeUndefined();
    w.failures.set(w.keys.get("DIPO-1") as string, "DIPO-1 was not started: setup failed (x)");
    expect(w.nextUp.offers(w.officeId)[0]?.failed).toBe("DIPO-1 was not started: setup failed (x)");
  });

  it("never offers a story with a dependency not Done, a story not Ready or one already claimed", async () => {
    story("DIPO-1", {
      milestone: "m-1",
      dependencies: [{ id: "DIPO-9", state: "resolved", status: "In Progress" }],
    });
    story("DIPO-2", {
      milestone: "m-1",
      dependencies: [{ id: "DIPO-8", state: "missing" }],
    });
    story("DIPO-3", { milestone: "m-1", status: "Refined" });
    story("DIPO-4", { milestone: "m-1" });
    story("DIPO-5", {
      milestone: "m-2",
      dependencies: [{ id: "DIPO-7", state: "resolved", status: "Done" }],
    });
    w.limit = 3;
    claim("DIPO-4");
    expect(await refresh()).toEqual(["DIPO-5"]);
  });

  it("never offers a story whose story PR dipo recorded merged, while the mirror still says Ready", async () => {
    story("DIPO-1", { milestone: "m-1" });
    story("DIPO-2", { milestone: "m-2" });
    expect(await refresh()).toEqual(["DIPO-1"]);
    // Confirmed and run; the PR poll records the merge, then the Done poll releases the claim.
    const run = claim("DIPO-1");
    storyPr("DIPO-1", run, "open");
    expect(await refresh()).toEqual([]);
    w.office.immediate(() =>
      setStoryPrState(w.office, run, { state: "merged", closedAt: w.t.clock.now() }),
    );
    release(run);
    // The base and its mirror move only at the next fetch: they still say Ready.
    await w.nextUp.refresh(w.officeId);
    expect(offered()).toEqual(["DIPO-2"]);
    expect(await refresh()).toEqual(["DIPO-2"]);
  });

  for (const mirrored of ["In Review", "In Progress", "Done"]) {
    it(`never offers a merged story while the base still says Ready and the mirror says ${mirrored}`, async () => {
      story("DIPO-1", { milestone: "m-1" });
      story("DIPO-2", { milestone: "m-2" });
      const run = claim("DIPO-1");
      storyPr("DIPO-1", run, "open");
      // The mirror moved with the run on its branch; the base read still says Ready.
      indexPass();
      w.office.immediate(() =>
        w.office.run(
          "update backlog_mirror set status = $status where office_id = $office_id and key = $key",
          { status: mirrored, key: w.keys.get("DIPO-1") as string },
        ),
      );
      w.office.immediate(() =>
        setStoryPrState(w.office, run, { state: "merged", closedAt: w.t.clock.now() }),
      );
      release(run);
      await w.nextUp.refresh(w.officeId);
      expect(offered()).toEqual(["DIPO-2"]);
      expect(w.started).toEqual([]);
    });
  }

  it("withdraws an offer as soon as the story's PR is recorded merged, without a change of the mirror", async () => {
    story("DIPO-1", { milestone: "m-1" });
    story("DIPO-2", { milestone: "m-2" });
    // An open PR of the story that no claim holds; the PR poll records its merge on the host.
    const run = RunId.parse(w.t.ids.next("run"));
    storyPr("DIPO-1", run, "open");
    expect(await refresh()).toEqual(["DIPO-1"]);
    w.office.immediate(() =>
      setStoryPrState(w.office, run, { state: "merged", closedAt: w.t.clock.now() }),
    );
    await w.nextUp.refresh(w.officeId);
    expect(offered()).toEqual(["DIPO-2"]);
    expect(w.started).toEqual([]);
  });

  it("offers nothing without a free slot or without a startable Ready story, and starts nothing by itself", async () => {
    story("DIPO-1", { milestone: "m-1" });
    story("DIPO-2", { milestone: "m-1" });
    claim("DIPO-1");
    expect(await refresh()).toEqual([]);
    expect(desk(w.office, () => true, { ...DESK_SOURCES, stories: backlogLayout })).toEqual([]);
    w.limit = 2;
    expect(await refresh()).toEqual(["DIPO-2"]);
    w.tasks.splice(1, 1);
    expect(await refresh()).toEqual([]);
    expect(w.started).toEqual([]);
  });

  it("reads milestone numbers", () => {
    expect(milestoneNumber("m-2")).toBe(2);
    expect(milestoneNumber("M12 parallel")).toBe(12);
    expect(milestoneNumber("later")).toBeNull();
    expect(
      nextUpOrder([
        task("A-1", { milestone: "later" }),
        task("A-2"),
        task("A-3", { milestone: "m-3" }),
      ]).map((one) => one.id),
    ).toEqual(["A-3", "A-1", "A-2"]);
  });
});

describe("confirm and decline", () => {
  it("confirm starts the offered story through the start; a story not offered is refused", async () => {
    story("DIPO-1", { milestone: "m-1" });
    story("DIPO-2", { milestone: "m-2" });
    await refresh();
    const refused = await command("nextUp.confirm", { story: "DIPO-2" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("nextUp.notOffered");
    const result = resultOf<{ started: { story: string }[] }>(
      await command("nextUp.confirm", { story: "DIPO-1" }),
    );
    expect(result.started.map((one) => one.story)).toEqual(["DIPO-1"]);
    expect(w.started).toEqual(["DIPO-1"]);
    // Its slot is taken now: nothing else is offered.
    expect(await refresh()).toEqual([]);
  });

  it("confirms of two items start side by side: each answers at its decision, before any claim (DIPO-456)", async () => {
    story("DIPO-1", { milestone: "m-1" });
    story("DIPO-2", { milestone: "m-1" });
    w.limit = 2;
    expect(await refresh()).toEqual(["DIPO-1", "DIPO-2"]);
    const slow = Promise.withResolvers<void>();
    w.hold.set("DIPO-1", slow.promise);
    w.hold.set("DIPO-2", slow.promise);
    const first = await command("nextUp.confirm", { story: "DIPO-1" });
    const second = await command("nextUp.confirm", { story: "DIPO-2" });
    expect(resultOf<{ started: unknown[] }>(first).started).toHaveLength(1);
    expect(resultOf<{ started: unknown[] }>(second).started).toHaveLength(1);
    expect(w.started).toEqual(["DIPO-1", "DIPO-2"]);
    // Neither has claimed yet, and neither is offered again while its start runs.
    expect(countClaims()).toBe(0);
    expect(await refresh()).toEqual([]);
    slow.resolve();
    await Promise.all(w.starts);
    expect(countClaims()).toBe(2);
    expect(await refresh()).toEqual([]);
  });

  it("holds the slot of a confirmed start from its answer: nothing else is offered while it runs", async () => {
    story("DIPO-1", { milestone: "m-1" });
    expect(await refresh()).toEqual(["DIPO-1"]);
    const slow = Promise.withResolvers<void>();
    w.hold.set("DIPO-1", slow.promise);
    expect(
      resultOf<{ started: unknown[] }>(await command("nextUp.confirm", { story: "DIPO-1" }))
        .started,
    ).toHaveLength(1);
    // The one slot is held by the start still under way: nothing else is offered.
    story("DIPO-2", { milestone: "m-1" });
    expect(await refresh()).toEqual([]);
    slow.resolve();
    await Promise.all(w.starts);
  });

  it("is registered as a command that answers at once; decline still waits for its offers", () => {
    expect(w.deps.registry.command("nextUp.confirm")).toMatchObject({
      level: "office",
      waits: false,
    });
    expect(w.deps.registry.command("nextUp.decline")).toMatchObject({
      level: "office",
      waits: true,
    });
  });

  it("decline removes the item and offers the next story at once; the story comes back only after its task file changed", async () => {
    story("DIPO-1", { milestone: "m-1" });
    story("DIPO-2", { milestone: "m-2" });
    expect(await refresh()).toEqual(["DIPO-1"]);
    const declined = resultOf<{ story: string; offered: string[] }>(
      await command("nextUp.decline", { story: "DIPO-1" }),
    );
    expect(declined).toMatchObject({ story: "DIPO-1", offered: ["DIPO-2"] });
    expect(offered()).toEqual(["DIPO-2"]);
    // Declining the last one leaves nothing to offer.
    await command("nextUp.decline", { story: "DIPO-2" });
    expect(await refresh()).toEqual([]);
    // DIPO-1's task file changes: it is offered again.
    const at = w.tasks.findIndex((x) => x.id === "DIPO-1");
    w.tasks[at] = { ...w.tasks[at]!, title: "Story DIPO-1, sharpened" };
    expect(await refresh()).toEqual(["DIPO-1"]);
    expect(w.started).toEqual([]);
  });

  it("a declined story is offered again once the maintainer started it by hand", async () => {
    story("DIPO-1", { milestone: "m-1" });
    expect(await refresh()).toEqual(["DIPO-1"]);
    await command("nextUp.decline", { story: "DIPO-1" });
    expect(await refresh()).toEqual([]);
    // `dipo run DIPO-1` started it after the decline; it ended and is Ready again.
    w.limit = 2;
    w.t.clock.advance(1_000);
    const run = claim("DIPO-1");
    w.office.immediate(() =>
      w.office.run(
        "update claims set released_at = $at where office_id = $office_id and run_id = $run",
        { run, at: w.t.clock.now() },
      ),
    );
    expect(await refresh()).toEqual(["DIPO-1"]);
  });
});

describe("the item on the desk", () => {
  it("lists the files its references share with running stories' references and changed files, or says none", async () => {
    story("DIPO-1", { milestone: "m-1" });
    story("DIPO-2", {
      milestone: "m-2",
      references: ["packages/engine/src/run/", "docs/how-dipo-works.md", "README.md"],
    });
    story("DIPO-3", { milestone: "m-3", references: ["packages/tui/src/desk.tsx"] });
    w.limit = 3;
    const run = claim("DIPO-1", ["packages/engine/src/run/work-run.ts"]);
    w.changed.set(run, ["docs/how-dipo-works.md"]);
    await refresh();
    const sources: DeskSources = {
      ...DESK_SOURCES,
      stories: backlogLayout,
      nextUp: () => w.nextUp.offers(w.officeId),
    };
    const items = desk(w.office, () => true, sources).filter((one) => one.kind === "NEXT UP");
    expect(items.map((one) => one.story)).toEqual(["DIPO-2", "DIPO-3"] as never);
    expect(items[0]?.detail).toBe(
      '"Story DIPO-2" · m-2 is the earliest milestone with a Ready story that can start; priority none · its references share files with running stories: DIPO-1 (docs/how-dipo-works.md, packages/engine/src/run)',
    );
    expect(items[1]?.detail).toContain("its references share no files with running stories");
    expect(items[0]?.actions).toEqual([
      {
        command: "nextUp.confirm",
        cli: "dipo next confirm DIPO-2",
        consequence: DESK_CONSEQUENCES["nextUp.confirm"],
      },
      {
        command: "nextUp.decline",
        cli: "dipo next decline DIPO-2",
        consequence: DESK_CONSEQUENCES["nextUp.decline"],
      },
    ]);
  });

  it("puts a notice on the office stream for a newly offered story, and the desk notification posts it once", async () => {
    story("DIPO-1", { milestone: "m-1" });
    const posted: NotificationText[] = [];
    const notifier = new DeskNotifier({
      post: async (notice) => {
        posted.push(notice);
      },
      logger: createLogger({ clock: systemClock, sinks: [], level: "info", component: "test" }),
    });
    const sources: DeskSources = {
      ...DESK_SOURCES,
      stories: backlogLayout,
      nextUp: () => w.nextUp.offers(w.officeId),
    };
    const read = (): DeskItem[] => desk(w.office, () => true, sources);
    await notifier.observe(w.officeId, "demo", read());
    await refresh();
    expect(w.notified).toBeGreaterThan(0);
    const notices = w.office.all<{ text: string }>(
      `select json_extract(delta, '$.text') as text from change_log
        where office_id = $office_id and type = 'engine.notice'
          and json_extract(delta, '$.code') = $code`,
      { code: NEXT_UP_NOTICE },
    );
    expect(notices.map((one) => one.text)).toEqual([
      "Next up for a free run slot: DIPO-1; `dipo next confirm DIPO-1` starts it, `dipo next decline DIPO-1` offers another",
    ]);
    await notifier.observe(w.officeId, "demo", read());
    // A refresh with nothing changed adds no notice, and a second read posts nothing new.
    await refresh();
    await notifier.observe(w.officeId, "demo", read());
    expect(posted).toHaveLength(1);
    expect(posted[0]?.body).toStartWith("DIPO-1 · NEXT UP: ");
  });
});

/** The `run.nextUp` notices of the office, by story key. */
function nextUpNotices(): string[] {
  return w.office
    .all<{ key: string }>(
      `select key from change_log where office_id = $office_id and type = 'engine.notice'
          and json_extract(delta, '$.code') = $code order by seq`,
      { code: NEXT_UP_NOTICE },
    )
    .map((row) => row.key);
}

const deskSources = (): DeskSources => ({
  ...DESK_SOURCES,
  stories: backlogLayout,
  nextUp: () => w.nextUp.offers(w.officeId),
});

describe("review fixes", () => {
  it("notifies again for a story offered again after its offer was withdrawn", async () => {
    story("DIPO-1", { milestone: "m-1" });
    const posted: NotificationText[] = [];
    const notifier = new DeskNotifier({
      post: async (notice) => {
        posted.push(notice);
      },
      logger: createLogger({ clock: systemClock, sinks: [], level: "info", component: "test" }),
    });
    const read = () => desk(w.office, () => true, deskSources());
    await notifier.observe(w.officeId, "demo", read());
    expect(await refresh()).toEqual(["DIPO-1"]);
    await notifier.observe(w.officeId, "demo", read());
    // A slot fills: the offer is withdrawn; it frees again: the story is offered again.
    story("DIPO-9");
    const run = claim("DIPO-9");
    expect(await refresh()).toEqual([]);
    await notifier.observe(w.officeId, "demo", read());
    w.office.immediate(() =>
      w.office.run(
        "update claims set released_at = 1 where office_id = $office_id and run_id = $run",
        { run },
      ),
    );
    w.tasks.splice(
      w.tasks.findIndex((x) => x.id === "DIPO-9"),
      1,
    );
    expect(await refresh()).toEqual(["DIPO-1"]);
    await notifier.observe(w.officeId, "demo", read());
    expect(posted.map((one) => one.body.split(" · ")[0])).toEqual(["DIPO-1", "DIPO-1"]);
  });

  it("lets a decline or confirm made while the base is read win over that read", async () => {
    story("DIPO-1", { milestone: "m-1" });
    story("DIPO-2", { milestone: "m-1" });
    story("DIPO-3", { milestone: "m-1" });
    story("DIPO-9");
    w.limit = 3;
    claim("DIPO-9");
    expect(await refresh()).toEqual(["DIPO-1", "DIPO-2"]);
    // The next read waits on the running story's changed files.
    const gate = Promise.withResolvers<void>();
    w.changedGate = gate.promise;
    const at = w.tasks.findIndex((x) => x.id === "DIPO-3");
    w.tasks[at] = { ...w.tasks[at]!, title: "Story DIPO-3, edited" };
    indexPass();
    const reading = w.nextUp.refresh(w.officeId);
    await Bun.sleep(5);
    expect(w.changedReads).toBe(2);
    const confirmed = command("nextUp.confirm", { story: "DIPO-1" });
    const declined = command("nextUp.decline", { story: "DIPO-2" });
    await Bun.sleep(5);
    w.changedGate = null;
    gate.resolve();
    await reading;
    expect(resultOf<{ started: unknown[] }>(await confirmed).started).toHaveLength(1);
    expect(resultOf<{ offered: string[] }>(await declined).offered).toEqual(["DIPO-3"]);
    // The stale read never put DIPO-1 or DIPO-2 back: each was told once.
    expect(nextUpNotices().filter((key) => key !== w.keys.get("DIPO-3"))).toEqual([
      w.keys.get("DIPO-1") as string,
      w.keys.get("DIPO-2") as string,
    ]);
    expect(await refresh()).toEqual(["DIPO-3"]);
  });

  it("keeps a declined story out when only its parent's title or its subtasks change", async () => {
    story("DIPO-1", { milestone: "m-1", parent: { id: "DIPO-50", title: "Epic" } });
    expect(await refresh()).toEqual(["DIPO-1"]);
    await command("nextUp.decline", { story: "DIPO-1" });
    w.tasks[0] = {
      ...w.tasks[0]!,
      parent: { id: "DIPO-50", title: "Epic, renamed" },
      subtasks: [{ id: "DIPO-1.1", title: "A part" }],
    };
    expect(await refresh()).toEqual([]);
  });

  it("reads the shared files again once a running story's branch moved", async () => {
    story("DIPO-1", { milestone: "m-1", references: ["src/a.ts", "src/b.ts"] });
    story("DIPO-9");
    w.limit = 2;
    const run = claim("DIPO-9");
    w.tips.set(run, "t1");
    w.changed.set(run, ["src/a.ts"]);
    await refresh();
    expect(w.nextUp.offers(w.officeId)[0]?.shared).toEqual([
      { story: "DIPO-9", paths: ["src/a.ts"] },
    ]);
    // The branch moves and changes src/b.ts too; within 30 s of the last read nothing is read.
    w.tips.set(run, "t2");
    w.changed.set(run, ["src/a.ts", "src/b.ts"]);
    expect(w.changedReads).toBe(1);
    await refresh();
    expect(w.changedReads).toBe(1);
    w.t.clock.advance(TIP_READ_MS);
    await refresh();
    expect(w.changedReads).toBe(2);
    expect(w.nextUp.offers(w.officeId)[0]?.shared).toEqual([
      { story: "DIPO-9", paths: ["src/a.ts", "src/b.ts"] },
    ]);
    // Without a move, a later read of the tips reads no changed files.
    w.t.clock.advance(TIP_READ_MS);
    await refresh();
    expect(w.changedReads).toBe(2);
  });

  it("offers the story again when its confirmed start fails", async () => {
    story("DIPO-1", { milestone: "m-1" });
    expect(await refresh()).toEqual(["DIPO-1"]);
    w.startFails = true;
    const reply = await command("nextUp.confirm", { story: "DIPO-1" });
    expect(reply.ok).toBe(false);
    expect(await refresh()).toEqual(["DIPO-1"]);
  });
});

// ---- nextUp.autoStart (DIPO-499, 0010) -------------------------------------------------------

/** The notices with `code`, by story key. */
function noticeKeys(code: string): string[] {
  return w.office
    .all<{ key: string }>(
      `select key from change_log where office_id = $office_id and type = 'engine.notice'
          and json_extract(delta, '$.code') = $code order by seq`,
      { code },
    )
    .map((row) => row.key);
}

/** Refreshes and lets every start the fake decided finish its claim. */
async function settle(): Promise<string[]> {
  const found = await refresh();
  await Promise.all(w.starts);
  await w.nextUp.refresh(w.officeId);
  return found;
}

const whyOf = (id: string) =>
  w.nextUp.offers(w.officeId).find((offer) => offer.story === id)?.why ?? "";

/** A running story DIPO-9 whose references are \`scope\`, and room for \`free\` more runs. */
function running(scope: readonly string[], free = 1): RunId {
  story("DIPO-9", { references: [...scope], status: "In Progress" });
  const run = claim("DIPO-9", scope);
  w.limit = 1 + free;
  return run;
}

describe("nextUp.autoStart: none and no-overlap", () => {
  it("the desk's NEXT UP items say the office starts them by itself only with no-overlap", async () => {
    w.mode = "no-overlap";
    running(["src/a.ts"]);
    story("DIPO-1", { references: ["src"] });
    await settle();
    const read = (mode: "none" | "no-overlap") =>
      desk(w.office, () => true, {
        ...deskSources(),
        nextUpAutoStart: () => mode,
      }).filter((one) => one.kind === "NEXT UP");
    await settle();
    expect(read("no-overlap").map((one) => one.autoStart)).toEqual(["no-overlap"]);
    expect(read("no-overlap")[0]?.detail).toContain(
      "not started by itself: shares src with DIPO-9",
    );
    expect(read("none").map((one) => one.autoStart)).toEqual([undefined]);
  });

  it("none starts nothing by itself: the offer waits for a confirm", async () => {
    story("DIPO-1", { references: ["src/a.ts"] });
    expect(await settle()).toEqual(["DIPO-1"]);
    expect(w.started).toEqual([]);
    expect(offered()).toEqual(["DIPO-1"]);
  });

  it("no-overlap starts the first offer that shares no files through the confirm's start, once, with a notice and no item left", async () => {
    w.mode = "no-overlap";
    running(["src/a.ts"]);
    story("DIPO-1", { references: ["docs/b.md"] });
    await settle();
    expect(w.started).toEqual(["DIPO-1"]);
    expect(offered()).toEqual([]);
    expect(w.infos).toEqual([
      {
        message: "started a story by itself",
        fields: {
          office: w.officeId,
          story: "DIPO-1",
          why: expect.stringContaining("it shares no files with the running stories"),
        },
      },
    ]);
    // One notice that it started, none that it was offered.
    expect(noticeKeys("run.nextUpStarted")).toEqual([w.keys.get("DIPO-1") as string]);
    expect(noticeKeys(NEXT_UP_NOTICE)).toEqual([]);
    const text = w.office.get<{ text: string }>(
      `select json_extract(delta, '$.text') as text from change_log
        where office_id = $office_id and json_extract(delta, '$.code') = 'run.nextUpStarted'`,
    );
    expect(text?.text).toBe(
      "started DIPO-1 by itself: it shares no files with the running stories",
    );
  });

  it("starts through an engine-made request of origin other, which the run's entries record", async () => {
    w.mode = "no-overlap";
    running([]);
    story("DIPO-1", { references: ["docs/b.md"] });
    await settle();
    const [ctx] = w.contexts;
    expect(w.contexts).toHaveLength(1);
    expect(ctx?.origin).toBe("other");
    expect(ctx?.stories.get(w.keys.get("DIPO-1") as string)?.story).toBe("DIPO-1" as StoryId);
    const caused = w.office.get<{ caused_by: string }>(
      `select caused_by from change_log where office_id = $office_id
          and json_extract(delta, '$.code') = 'run.nextUpStarted'`,
    );
    expect(caused?.caused_by).toBe(ctx?.requestId as string);
    // A confirm's request carries the maintainer's origin, not this one.
    w.mode = "none";
    story("DIPO-2", { references: ["x"], milestone: "m-9" });
    w.limit = 3;
    await refresh();
    resultOf(await command("nextUp.confirm", { story: "DIPO-2" }));
    expect(w.contexts.at(-1)?.origin).toBe("cli");
  });
});

describe("what is never started by itself", () => {
  beforeEach(() => {
    w.mode = "no-overlap";
  });

  it("an offer whose references overlap a running story's references, naming the files and the story", async () => {
    running(["src/a.ts"]);
    story("DIPO-1", { references: ["src"] });
    await settle();
    expect(w.started).toEqual([]);
    expect(offered()).toEqual(["DIPO-1"]);
    expect(whyOf("DIPO-1")).toContain("not started by itself: shares src with DIPO-9");
    expect(w.nextUp.offers(w.officeId)[0]?.shared).toEqual([{ story: "DIPO-9", paths: ["src"] }]);
  });

  it("an offer whose references overlap a running story's changed files", async () => {
    const run = running([]);
    w.changed.set(run, ["packages/x/y.ts"]);
    story("DIPO-1", { references: ["packages/x"] });
    await settle();
    expect(w.started).toEqual([]);
    expect(whyOf("DIPO-1")).toContain("shares packages/x with DIPO-9");
  });

  it("a declined story", async () => {
    running([]);
    const key = story("DIPO-1", { references: ["a"] });
    w.office.immediate(() =>
      recordDecline(w.office, key, storyHash(w.tasks.at(-1) as PlainTask), w.t.clock.now()),
    );
    await settle();
    expect(w.started).toEqual([]);
    expect(offered()).toEqual([]);
  });

  it("a story whose dependency is not Done", async () => {
    running([]);
    story("DIPO-1", {
      references: ["a"],
      dependencies: [{ id: "DIPO-8", state: "resolved", status: "In Progress" }],
    });
    await settle();
    expect(w.started).toEqual([]);
  });

  it("a story without references: what it touches is not known", async () => {
    running([]);
    story("DIPO-1", { references: [] });
    await settle();
    expect(w.started).toEqual([]);
    expect(whyOf("DIPO-1")).toContain("not started by itself: it has no references");
  });

  it("while the office's starts are paused, at a plan limit included", async () => {
    running([]);
    story("DIPO-1", { references: ["a"] });
    w.paused = true;
    await settle();
    expect(w.started).toEqual([]);
    expect(offered()).toEqual([]);
  });

  it("while dipo updates itself", async () => {
    running([]);
    story("DIPO-1", { references: ["a"] });
    w.updating = true;
    await settle();
    expect(w.started).toEqual([]);
    expect(offered()).toEqual(["DIPO-1"]);
  });

  it("while the desk offers dipo update", async () => {
    running([]);
    story("DIPO-1", { references: ["a"] });
    w.updateOffered = true;
    await settle();
    expect(w.started).toEqual([]);
    expect(offered()).toEqual(["DIPO-1"]);
  });

  it("without a free slot, at caps.parallelRuns", async () => {
    running([], 0);
    story("DIPO-1", { references: ["a"] });
    await settle();
    expect(w.started).toEqual([]);
    expect(offered()).toEqual([]);
  });
});

describe("what the auto start counts", () => {
  beforeEach(() => {
    w.mode = "no-overlap";
  });

  it("with two slots free and two offers that overlap each other only the first starts, while it is still starting", async () => {
    running([], 2);
    story("DIPO-1", { references: ["src/shared.ts"], priority: "high" });
    story("DIPO-2", { references: ["src"], priority: "low" });
    let open!: () => void;
    w.hold.set("DIPO-1", new Promise<void>((resolve) => (open = resolve)));
    await refresh();
    expect(w.started).toEqual(["DIPO-1"]);
    expect(whyOf("DIPO-2")).toContain("shares src with DIPO-1");
    // Still starting on a later pass: the second still counts it.
    await refresh();
    expect(w.started).toEqual(["DIPO-1"]);
    open();
    await settle();
    expect(w.started).toEqual(["DIPO-1"]);
  });

  it("a story that becomes Ready while a run ends starts only after the changed files were read again", async () => {
    const run = running([], 1);
    const other = RunId.parse(w.t.ids.next("run"));
    story("DIPO-8", { references: [], status: "In Progress" });
    claim("DIPO-8", [], other);
    w.limit = 2;
    // DIPO-8's run ended with the slot: DIPO-1 became Ready, and the read of what DIPO-9 changed is open.
    release(other);
    w.changed.set(run, ["src/late.ts"]);
    let open!: () => void;
    w.changedGate = new Promise<void>((resolve) => (open = resolve));
    story("DIPO-1", { references: ["src/late.ts"] });
    const pending = refresh();
    await Promise.resolve();
    await Bun.sleep(5);
    expect(w.started).toEqual([]);
    open();
    await pending;
    await Promise.all(w.starts);
    // It overlaps what DIPO-9 changed: the fresh read keeps it from starting.
    expect(w.started).toEqual([]);
    expect(whyOf("DIPO-1")).toContain("shares src/late.ts with DIPO-9");
  });

  it("the first refresh after scheduling turns on starts nothing before the changed files are read", async () => {
    w.scheduling = false;
    const run = running([], 1);
    w.changed.set(run, []);
    story("DIPO-1", { references: ["docs/x.md"] });
    await refresh();
    expect(w.started).toEqual([]);
    let open!: () => void;
    w.changedGate = new Promise<void>((resolve) => (open = resolve));
    w.scheduling = true;
    w.nextUp.refreshAll();
    await Bun.sleep(5);
    expect(w.started).toEqual([]);
    expect(w.changedReads).toBeGreaterThan(0);
    open();
    await w.nextUp.refresh(w.officeId);
    await Promise.all(w.starts);
    expect(w.started).toEqual(["DIPO-1"]);
  });
});

const stays = () => {
  expect(w.started).toEqual([]);
  expect(offered()).toEqual(["DIPO-1"]);
  expect(whyOf("DIPO-1")).toContain("could not be read");
};

describe("fail closed", () => {
  beforeEach(() => {
    w.mode = "no-overlap";
  });

  it("a changed-files read that throws starts nothing", async () => {
    running(["src/a.ts"]);
    story("DIPO-1", { references: ["docs/b.md"] });
    w.changedImpl = async () => {
      throw new Error("git failed");
    };
    await settle();
    stays();
  });

  it("a running branch the read leaves out starts nothing", async () => {
    const run = running(["src/a.ts"]);
    story("DIPO-1", { references: ["docs/b.md"] });
    w.unreadable.add(run);
    await settle();
    stays();
  });

  it("with no office git, the real gitChangedFiles reads nothing and nothing starts", async () => {
    running(["src/a.ts"]);
    story("DIPO-1", { references: ["docs/b.md"] });
    w.changedImpl = gitChangedFiles({ git: () => undefined, stories: backlogLayout });
    await settle();
    stays();
  });

  it("the real gitChangedFiles on a repository whose running branch cannot be read starts nothing; a readable one lets it start", async () => {
    await withBareRemote(async (repo) => {
      writeFileSync(join(repo.dir, "README.md"), "# fixture\n");
      const start = await repo.commitAll("start");
      const real = realpathSync(repo.dir);
      const git = new OfficeGit({
        officeId: w.officeId,
        mainWorktree: real,
        commonDir: join(real, ".git"),
        settings: { remote: "origin", base: "main" },
        runner: { exec: spawnGitExec(systemSpawn), env: repo.env, sleep: async () => {} },
        clock: new ManualClock(),
      });
      w.changedImpl = gitChangedFiles({ git: () => git, stories: backlogLayout });
      w.startSha = start;
      running(["src/a.ts"]);
      story("DIPO-1", { references: ["docs/b.md"] });
      // The branch DIPO-9's run records does not exist in the repository.
      await settle();
      stays();
      // With the branch there, the read works and a story that shares nothing starts.
      await repo.git("branch", "DIPO-9/a-story", start);
      // The pass that could not read is tried again after a while.
      w.t.clock.advance(TIP_READ_MS);
      await settle();
      expect(w.started).toEqual(["DIPO-1"]);
    });
  });
});

/** Changes the story's task file: its hash differs. */
function touch(id: string): void {
  const found = w.tasks.find((one) => one.id === id) as PlainTask;
  w.tasks[w.tasks.indexOf(found)] = { ...found, description: `${found.description} More.` };
}

describe("no retry loop", () => {
  beforeEach(() => {
    w.mode = "no-overlap";
  });

  it("a story whose pickup check fails is tried once, keeps the refusal in its why and is tried again only when its task file changes", async () => {
    running([]);
    story("DIPO-1", { references: ["docs/b.md"] });
    w.skips.set("DIPO-1", "pickupCheckFailed");
    await settle();
    expect(w.started).toEqual(["DIPO-1"]);
    expect(offered()).toEqual(["DIPO-1"]);
    expect(whyOf("DIPO-1")).toContain(
      "not started by itself: work.run skipped it: pickupCheckFailed",
    );
    await settle();
    await settle();
    expect(w.started).toEqual(["DIPO-1"]);
    // The maintainer can still confirm it.
    resultOf(await command("nextUp.confirm", { story: "DIPO-1" }));
    expect(w.started).toEqual(["DIPO-1", "DIPO-1"]);
    touch("DIPO-1");
    await settle();
    expect(w.started).toHaveLength(3);
  });

  it("a start that throws is tried once", async () => {
    running([]);
    story("DIPO-1", { references: ["docs/b.md"] });
    w.startFails = true;
    await settle();
    await settle();
    expect(w.started).toEqual(["DIPO-1"]);
    expect(whyOf("DIPO-1")).toContain("its start failed: the box could not be prepared");
    touch("DIPO-1");
    await settle();
    expect(w.started).toEqual(["DIPO-1", "DIPO-1"]);
  });

  it("a start that fails later is tried once", async () => {
    running([]);
    story("DIPO-1", { references: ["docs/b.md"] });
    w.failLater.add("DIPO-1");
    await settle();
    await settle();
    await settle();
    expect(w.started).toEqual(["DIPO-1"]);
    expect(offered()).toEqual(["DIPO-1"]);
    expect(w.nextUp.offers(w.officeId)[0]?.failed).toContain("setup failed");
  });

  it("is tried again once the next-up signature changes", async () => {
    const run = running([]);
    story("DIPO-1", { references: ["docs/b.md"] });
    w.startFails = true;
    await settle();
    expect(w.started).toEqual(["DIPO-1"]);
    // The running story ends: the signature differs.
    release(run);
    await settle();
    expect(w.started).toEqual(["DIPO-1", "DIPO-1"]);
  });
});
