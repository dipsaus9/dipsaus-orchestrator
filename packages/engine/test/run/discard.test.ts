// `work.discard` (DIPO-161; 0020 section 8), with real git and a bare remote (the reconcile
// harness, its scripted Backlog CLI), a lane that journals into the real journal and records its
// ops, and a code host that records its PR closes: a parked story with uncommitted files, a
// merged PR, a remote tip dipo did not push, the leftovers of a story Done on the base, a running
// story, and a story with nothing to discard.
//
// Local cases: a remote tip the loss list keeps, the refusal of a merged PR, and a worker host of the
// ended run that still runs, a real process (DIPO-418). The rest is in discard.ci.test.ts (CI only,
// DIPO-225).

import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  type CommandReply,
  type OfficeId,
  RequestId,
  type RunId,
  type Spawn,
  type StoryKey,
} from "@dipsaus-orchestrator/contract";

import { allEntries, type LaneOp, type OfficeLane, planningLane } from "../../src/backlog/lane";
import type { BacklogCli } from "../../src/backlog/runner";
import { insertEntry } from "../../src/backlog/lane/journal";
import { executeCommand } from "../../src/commands/execute";
import { crashAfterHandler } from "../commands/crash";
import type { FeatureModule } from "../../src/commands/registry";
import type { OfficeHandle } from "../../src/db/office";
import type { OfficeGit } from "../../src/git/office";
import { executeRead } from "../../src/reads/execute";
import { currentPlatform } from "../../src/platform/paths";
import {
  pidExists,
  type ProcessProbe,
  signalProcess,
  systemProcessProbe,
} from "../../src/platform/process";
import { insertStoryPr } from "../../src/records/story-prs";
import { recordWorkerHost } from "../../src/records/worker-hosts";
import { StoryDiscard } from "../../src/run/discard";
import { StoryPlanning } from "../../src/run/planning";
import { liveClaimOf } from "../../src/worktree/records";
import { lastSeq } from "../stories/helpers";
import {
  claim,
  type FakeTask,
  keyOf,
  noticesAfter,
  type ReconcileOffice,
  setBranch,
  withReconcileOffice,
} from "../reconcile/helpers";
import { backlogStoryStore } from "../../src/backlog/store";
import { backlogLayout } from "../story-store/backlog";
import { lateHostScript } from "../host/fixtures/late-host-script";

interface Closed {
  readonly repo: string;
  readonly number: number;
  readonly comment: string;
}

/** What a test sees of the discard's dependencies. */
interface Seen {
  office?: OfficeHandle;
  readonly ops: LaneOp[];
  readonly closed: Closed[];
  readonly stops: string[];
  boxes: number;
  /** PIDs the fake probe reports as running. */
  alive: number[];
  /** What the fake stop does to the run. */
  onStop?: () => void;
  /** The Backlog CLI the discard reads `_base` with; none by default. */
  spawn?: Spawn;
  /** The discard's process probe in place of the fake one (DIPO-418: the real process table). */
  probe?: ProcessProbe;
  /** Every signal the discard sent, passed on to the real one. */
  readonly signals: [number, string][];
}

const HOST_START = 1_767_225_600_000;

function features(seen: Seen) {
  const probe = async (pid: number) =>
    seen.alive.includes(pid)
      ? { pid, startTimeMs: HOST_START, zombie: false, command: "dipo daemon worker-host" }
      : null;
  return ({ engineGit }: { engineGit: { forOffice(o: OfficeId): OfficeGit | undefined } }) => {
    const lane = {
      journal: async (op: LaneOp) => {
        seen.ops.push(op);
        const office = seen.office;
        if (office === undefined) throw new Error("the office is not loaded");
        return office.immediate(() => insertEntry(office, op, 1));
      },
      flush: async () => ({}),
      get office() {
        return seen.office;
      },
      clock: { now: () => 1 },
    } as unknown as OfficeLane;
    const host = {
      closePr: async (repo: string, number: number, comment: string) => {
        seen.closed.push({ repo, number, comment });
      },
    };
    const discarder = new StoryDiscard({
      lane: () => planningLane(lane),
      git: (office) => engineGit.forOffice(office),
      host,
      probe: (pid) => (seen.probe ?? probe)(pid),
      signal: (pid, signal) => {
        seen.signals.push([pid, signal]);
        return signalProcess(pid, signal);
      },
      stop: async (_ctx, args) => {
        seen.stops.push(args.story);
        seen.onStop?.();
      },
      finishBoxes: async () => {
        seen.boxes += 1;
      },
      stories: backlogStoryStore({
        spawn: (options) => {
          if (seen.spawn === undefined) throw new Error("no CLI in this test");
          return seen.spawn(options);
        },
      } as BacklogCli),
    });
    const planning = new StoryPlanning({
      stories: backlogLayout,
      lane: () => planningLane(lane),
      git: (office) => engineGit.forOffice(office),
      host,
      implemented: () => true,
      probe,
      signal: () => false,
    });
    return [discarder.feature, planning.feature] as readonly FeatureModule[];
  };
}

function seenOf(): Seen {
  return { ops: [], closed: [], stops: [], boxes: 0, alive: [], signals: [] };
}

let sequence = 0;
function requestId(): RequestId {
  sequence += 1;
  return RequestId.parse(`01J9ZK5Q8W3V4X6Y7Z${String(sequence).padStart(8, "1")}`);
}

function discard(
  o: ReconcileOffice,
  story: string,
  note = "wrong approach",
  retry?: { readonly id: RequestId; readonly crash: boolean },
): Promise<CommandReply> {
  // A crash after the handler's commits and before the requests row (DIPO-168 in DIPO-155).
  const deps = retry?.crash === true ? crashAfterHandler(o.s.deps, "work.discard") : o.s.deps;
  return executeCommand(deps, {
    requestId: retry?.id ?? requestId(),
    name: "work.discard",
    args: { story, note },
    origin: "cli",
    confirmed: true,
    office: o.officeId,
  });
}

async function losses(
  o: ReconcileOffice,
  story: string,
  command: "story.drop" | "work.discard" = "work.discard",
) {
  const reply = await executeRead(
    { registry: o.s.registry, offices: o.s.manager, clock: o.s.clock },
    { requestId: requestId(), name: "story.losses", args: { office: o.officeId, story, command } },
  );
  if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`);
  return reply.result as { commits: { subject: string }[]; files: string[]; kept?: string[] };
}

function errorCode(reply: CommandReply): string {
  if (reply.ok) throw new Error(`expected an error, got ${JSON.stringify(reply)}`);
  return reply.error.code;
}

async function tipOf(o: ReconcileOffice, ref: string): Promise<string | null> {
  const result = await o.repo.run(["git", "rev-parse", "--verify", "--quiet", ref], o.repo.dir);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function remoteTip(o: ReconcileOffice, branch: string): Promise<string> {
  return (await o.repo.git("ls-remote", "origin", `refs/heads/${branch}`)).split("\t")[0] ?? "";
}

function openPr(office: OfficeHandle, key: StoryKey, runId: RunId, head: string, state = "open") {
  office.immediate(() =>
    insertStoryPr(office, {
      runId,
      key,
      number: 7,
      url: "https://github.com/o/r/pull/7",
      branch: "TASK-1/a-story",
      base: "main",
      headSha: head,
      state: state as "open",
      title: "feat(TASK-1): x",
      bodyHash: "h",
      openedAt: 1,
      closedAt: null,
    }),
  );
}

const PARKED: readonly FakeTask[] = [{ id: "TASK-1", status: "Ready" }];

describe("work.discard refusals and the remote branch (DIPO-161)", () => {
  it("refuses a story whose PR merged, changing nothing", async () => {
    const seen = seenOf();
    await withReconcileOffice({ base: PARKED, features: features(seen) }, async (o) => {
      seen.office = o.office;
      const key = keyOf(o.office, "TASK-1");
      const record = await claim(o, o.office, "TASK-1", key, { active: false });
      openPr(o.office, key, record.runId, record.claimSha ?? "", "merged");

      expect(errorCode(await discard(o, "TASK-1"))).toBe("story.prMerged");
      expect(existsSync(record.worktree)).toBe(true);
      expect(liveClaimOf(o.office, key)).not.toBeNull();
      expect(seen.ops).toEqual([]);
      expect(allEntries(o.office)).toEqual([]);
    });
  });
});

describe("work.discard removes nothing its loss list did not show (DIPO-161 review)", () => {
  it("keeps a remote tip dipo pushed but the local branch no longer holds, so its commits stay", async () => {
    const seen = seenOf();
    await withReconcileOffice({ base: PARKED, features: features(seen) }, async (o) => {
      seen.office = o.office;
      const key = keyOf(o.office, "TASK-1");
      const record = await claim(o, o.office, "TASK-1", key, { active: false });
      const pushed = await setBranch(o, record, { id: "TASK-1", status: "Parked" });
      await o.repo.git("push", "--quiet", "origin", record.branch);
      openPr(o.office, key, record.runId, pushed);
      // The local branch is moved back by hand: the PR's head is no longer on it.
      await o.repo.git("update-ref", `refs/heads/${record.branch}`, record.claimSha ?? "");
      expect((await losses(o, "TASK-1")).commits.map((c) => c.subject)).toEqual([
        "TASK-1: status In Progress",
      ]);
      const seq = lastSeq(o.office);

      expect(await discard(o, "TASK-1")).toMatchObject({ ok: true });

      expect(await remoteTip(o, record.branch)).toBe(pushed);
      expect(await tipOf(o, `refs/heads/${record.branch}`)).toBeNull();
      expect(
        noticesAfter(o.office, seq).filter((n) => n.code === "discard.remoteBranchKept"),
      ).toHaveLength(1);
    });
  });
});

/** True once `pid` exits, within 3 s. */
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 300 && pidExists(pid); i += 1) await Bun.sleep(10);
  return !pidExists(pid);
}

/** The error of a refused reply. */
function refusal(reply: CommandReply): { code: string; message: string; retryable: boolean } {
  if (reply.ok) throw new Error(`expected an error, got ${JSON.stringify(reply)}`);
  return {
    code: reply.error.code,
    message: reply.error.message,
    retryable: reply.error.retryable,
  };
}

describe("work.discard of a story whose ended run's worker host still runs (DIPO-418)", () => {
  // Real processes in the host's source form (`lateHostScript`), read through the real process
  // table, as in test/host/ended-run-hosts.test.ts; the signals go to the real `signalProcess`.
  const realProbe = systemProcessProbe(currentPlatform());
  const HOUR = 3_600_000;

  /** Runs `body` with a fresh folder for the stand-in host, killing what it started. */
  async function withHosts(
    body: (
      start: (words: string[]) => Promise<{ pid: number; startTimeMs: number }>,
      dir: string,
    ) => Promise<void>,
  ): Promise<void> {
    const dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "discard-hosts-"));
    const children: Bun.Subprocess[] = [];
    const standIn = lateHostScript(dir);
    const start = async (words: string[]) => {
      const child = Bun.spawn([process.execPath, standIn, ...words], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      children.push(child);
      const last = words.at(-1) ?? "";
      for (let i = 0; i < 200; i += 1) {
        const info = await realProbe(child.pid);
        if (info !== null && info.command.endsWith(last)) return info;
        await Bun.sleep(10);
      }
      throw new Error(`the stand-in ${words.join(" ")} did not come up`);
    };
    try {
      await body(start, dir);
    } finally {
      for (const child of children) child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Records a worker host row of `runId` for `pid`, with `startTimeMs` as its start time. */
  function recordHost(
    o: ReconcileOffice,
    runId: RunId,
    dir: string,
    pid: number,
    startTimeMs: number,
  ) {
    recordWorkerHost(
      o.office,
      {
        pid,
        startTimeMs,
        runId,
        agentId: "agt_01JZ0000000000000000000001",
        socketPath: join(dir, "host.sock"),
        protocolVersion: 3,
        runDir: dir,
        eventFile: join(dir, "events.ndjson"),
        launchDeadline: o.s.clock.now() + HOUR,
      },
      o.s.clock,
    );
  }

  it("sends a verified host one SIGTERM, refuses in drop's words, and discards once it exited", async () => {
    const seen = { ...seenOf(), probe: realProbe };
    await withReconcileOffice({ base: PARKED, features: features(seen) }, async (o) => {
      seen.office = o.office;
      const key = keyOf(o.office, "TASK-1");
      const record = await claim(o, o.office, "TASK-1", key, { active: false });
      await withHosts(async (start, dir) => {
        const host = await start(["daemon", "worker-host", record.runId]);
        recordHost(o, record.runId, dir, host.pid, host.startTimeMs);

        const busy = refusal(await discard(o, "TASK-1"));
        expect(busy.code).toBe("run.hostAlive");
        expect(busy.retryable).toBe(true);
        expect(busy.message).toBe(
          `A worker host of TASK-1 still runs, so its box is in use: its worker host (pid ${host.pid}) still ran, so dipo sent it SIGTERM to stop its worker. Send \`dipo discard TASK-1 --note <text>\` again in a moment, once the host has exited.`,
        );
        expect(seen.signals).toEqual([[host.pid, "SIGTERM"]]);
        // Nothing was journaled, closed or released.
        expect(seen.ops).toEqual([]);
        expect(liveClaimOf(o.office, key)).not.toBeNull();
        expect(await gone(host.pid)).toBe(true);

        expect(await discard(o, "TASK-1")).toMatchObject({ ok: true, changed: true });
        expect(liveClaimOf(o.office, key)).toBeNull();
        expect(await tipOf(o, `refs/heads/${record.branch}`)).toBeNull();
        expect(seen.signals).toHaveLength(1);
      });
    });
  });

  it("sends no signal to a process on the host's PID and start time that does not run the host, and says why", async () => {
    const seen = { ...seenOf(), probe: realProbe };
    await withReconcileOffice({ base: PARKED, features: features(seen) }, async (o) => {
      seen.office = o.office;
      const key = keyOf(o.office, "TASK-1");
      const record = await claim(o, o.office, "TASK-1", key, { active: false });
      await withHosts(async (start, dir) => {
        // The PID went to another program: Bun runs the stand-in with other words.
        const other = await start(["logs", record.runId]);
        recordHost(o, record.runId, dir, other.pid, other.startTimeMs);

        const busy = refusal(await discard(o, "TASK-1"));
        expect(busy.code).toBe("run.hostAlive");
        expect(busy.message).toContain(
          `its worker host (pid ${other.pid}) still runs, and dipo sent it no signal, because the process does not run \`dipo daemon worker-host ${record.runId}\``,
        );
        expect(busy.message).toContain("`dipo discard TASK-1 --note <text>`");
        expect(seen.signals).toEqual([]);
        expect(liveClaimOf(o.office, key)).not.toBeNull();
        await Bun.sleep(100);
        expect(pidExists(other.pid)).toBe(true);
      });
    });
  });

  it("sends no signal to a process whose start time is not the recorded host's: that host is gone", async () => {
    const seen = { ...seenOf(), probe: realProbe };
    await withReconcileOffice({ base: PARKED, features: features(seen) }, async (o) => {
      seen.office = o.office;
      const key = keyOf(o.office, "TASK-1");
      const record = await claim(o, o.office, "TASK-1", key, { active: false });
      await withHosts(async (start, dir) => {
        // A reused PID: the live process started an hour after the recorded host.
        const other = await start(["daemon", "worker-host", record.runId]);
        recordHost(o, record.runId, dir, other.pid, other.startTimeMs - HOUR);

        expect(await discard(o, "TASK-1")).toMatchObject({ ok: true, changed: true });
        expect(seen.signals).toEqual([]);
        await Bun.sleep(100);
        expect(pidExists(other.pid)).toBe(true);
      });
    });
  });

  it("sends no signal when the host's identity cannot be checked, and says why", async () => {
    const seen: Seen = { ...seenOf(), probe: realProbe };
    await withReconcileOffice({ base: PARKED, features: features(seen) }, async (o) => {
      seen.office = o.office;
      const key = keyOf(o.office, "TASK-1");
      const record = await claim(o, o.office, "TASK-1", key, { active: false });
      await withHosts(async (start, dir) => {
        const host = await start(["daemon", "worker-host", record.runId]);
        recordHost(o, record.runId, dir, host.pid, host.startTimeMs);
        // The liveness check answers, then the process table cannot be read.
        let calls = 0;
        seen.probe = async (pid) => {
          calls += 1;
          if (calls > 1) throw new Error("ps failed");
          return realProbe(pid);
        };

        const busy = refusal(await discard(o, "TASK-1"));
        expect(busy.code).toBe("run.hostAlive");
        expect(busy.message).toContain(
          `its worker host (pid ${host.pid}) still runs, and dipo sent it no signal, because checking it failed (ps failed)`,
        );
        expect(seen.signals).toEqual([]);
        expect(liveClaimOf(o.office, key)).not.toBeNull();
        expect(pidExists(host.pid)).toBe(true);
      });
    });
  });

  it("sends no signal to the host of a run that has not ended, and says why", async () => {
    // The stop of the running story leaves the run active (a park that did not end it).
    const seen = { ...seenOf(), probe: realProbe };
    await withReconcileOffice({ base: PARKED, features: features(seen) }, async (o) => {
      seen.office = o.office;
      const key = keyOf(o.office, "TASK-1");
      const record = await claim(o, o.office, "TASK-1", key);
      await withHosts(async (start, dir) => {
        const host = await start(["daemon", "worker-host", record.runId]);
        recordHost(o, record.runId, dir, host.pid, host.startTimeMs);

        const busy = refusal(await discard(o, "TASK-1"));
        expect(seen.stops).toEqual([key]);
        expect(busy.code).toBe("run.hostAlive");
        expect(busy.message).toContain(
          `its worker host (pid ${host.pid}) still runs, and dipo sent it no signal, because its run has not ended`,
        );
        expect(seen.signals).toEqual([]);
        expect(liveClaimOf(o.office, key)).not.toBeNull();
        await Bun.sleep(100);
        expect(pidExists(host.pid)).toBe(true);
      });
    });
  });
});
