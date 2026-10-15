// The command executor (DIPO-22; 0005 sections 1, 3 and 9).

import { describe, expect, it } from "bun:test";

import {
  type CommandReply,
  type CommandRequest,
  OfficeId,
  RequestId,
  StoryId,
} from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { readLogState } from "../../src/changelog/log";
import { replay } from "../../src/changelog/replay";
import { CommandError } from "../../src/commands/errors";
import { executeCommand, type ExecutorDeps, STORY_REFRESH_MS } from "../../src/commands/execute";
import { stateOfficeDirectory } from "../../src/commands/offices";
import { buildRegistry, type FeatureModule } from "../../src/commands/registry";
import { MemoryRequestTable, REQUEST_TTL_MS } from "../../src/commands/requests";
import type { OfficeHandle } from "../../src/db/office";
import { addStory, removeStory, renumberStory } from "../../src/stories/keys";
import { type FixtureCalls, fixtureFeature } from "./fixtures";
import { addOffice, countRows, createFactTable, openTestState, type TestState } from "./helpers";

const REQUEST_IDS = [
  "01J9ZK5Q8W3V4X6Y7Z8A9B0C1D",
  "01J9ZK5Q8W3V4X6Y7Z8A9B0C2E",
  "01J9ZK5Q8W3V4X6Y7Z8A9B0C3F",
  "01J9ZK5Q8W3V4X6Y7Z8A9B0C4G",
].map((id) => RequestId.parse(id));
const [R1, R2, R3, R4] = REQUEST_IDS as [RequestId, RequestId, RequestId, RequestId];

interface Setup extends TestState {
  readonly office: OfficeHandle;
  readonly deps: ExecutorDeps;
  readonly calls: FixtureCalls;
}

async function setup(dir: string, features: readonly FeatureModule[] = []): Promise<Setup> {
  const t = await openTestState(dir);
  createFactTable(t);
  const office = addOffice(t);
  const calls: FixtureCalls = { touch: 0, peek: 0, level: 0 };
  const deps: ExecutorDeps = {
    registry: buildRegistry([fixtureFeature(calls), ...features]),
    offices: stateOfficeDirectory(t.state),
    clock: t.clock,
    ids: t.ids,
    softwareRequests: new MemoryRequestTable(t.clock),
  };
  return { ...t, office, deps, calls };
}

function touch(
  s: Setup,
  requestId: RequestId,
  args: unknown,
  extra: Partial<CommandRequest> = {},
): Promise<CommandReply> {
  return executeCommand(s.deps, {
    requestId,
    office: s.office.officeId,
    name: "fixture.touch",
    args,
    origin: "cli",
    confirmed: false,
    ...extra,
  });
}

function seedStory(s: Setup, story = "DIPO-7") {
  return s.office.immediate(() =>
    addStory(s.office, s.ids, { story: StoryId.parse(story) }, s.clock.now()),
  );
}

function errorCode(reply: CommandReply): string | undefined {
  return reply.ok ? undefined : reply.error.code;
}

describe("executeCommand", () => {
  it("writes the fact and its entry, replies with the last seq, and replay returns the entry", () =>
    withTempDir(async (dir) => {
      const s = await setup(dir);
      try {
        const story = seedStory(s);
        const reply = await touch(s, R1, { story: "DIPO-7", text: "first" });
        if (!reply.ok) throw new Error(reply.error.message);

        const log = readLogState(s.office);
        expect(reply.changed).toBe(true);
        expect(reply.cursor as unknown).toEqual({
          stream: `office:${s.office.officeId}`,
          epoch: log.epoch,
          seq: 1,
        });
        expect(log.nextSeq).toBe(2);
        expect(countRows(s.office, "facts")).toBe(1);
        expect(countRows(s.office, "requests")).toBe(1);

        const replayed = replay(s.office, { ...reply.cursor!, seq: 0 });
        if (!replayed.ok) throw new Error(replayed.error.message);
        expect(replayed.entries).toHaveLength(1);
        expect(replayed.entries[0]).toMatchObject({
          seq: 1,
          type: "story.state",
          tier: "S",
          key: story.key,
          causedBy: R1,
          delta: { story: "DIPO-7", key: story.key, from: "Refined", to: "Ready" },
          view: { key: story.key, story: "DIPO-7", lifecycle: "Ready" },
        });
        expect(replayed.head.seq).toBe(reply.cursor!.seq);
      } finally {
        s.state.close();
      }
    }));

  it("answers a retry with the same id and hash from the stored reply without running again", () =>
    withTempDir(async (dir) => {
      const s = await setup(dir);
      try {
        seedStory(s);
        const first = await touch(s, R1, { story: "DIPO-7", text: "once" });
        s.clock.advance(60_000);
        const again = await touch(s, R1, { text: "once", story: "DIPO-7" });
        expect(again).toEqual(first);
        expect(s.calls.touch).toBe(1);
        expect(countRows(s.office, "facts")).toBe(1);
        expect(readLogState(s.office).nextSeq).toBe(2);

        const changed = await touch(s, R1, { story: "DIPO-7", text: "twice" });
        expect(errorCode(changed)).toBe("request.reused");
        const otherCommand = await executeCommand(s.deps, {
          requestId: R1,
          office: s.office.officeId,
          name: "fixture.peek",
          args: { story: "DIPO-7", text: "once" },
          origin: "cli",
          confirmed: false,
        });
        expect(errorCode(otherCommand)).toBe("request.reused");
        expect(s.calls.touch).toBe(1);
        expect(s.calls.peek).toBe(0);
      } finally {
        s.state.close();
      }
    }));

  it("hashes after resolving story references, so a retry by the former DRAFT id matches", () =>
    withTempDir(async (dir) => {
      const s = await setup(dir);
      try {
        const draft = seedStory(s, "DRAFT-1");
        const first = await touch(s, R1, { story: "DRAFT-1", text: "draft" });
        expect(first.ok).toBe(true);
        s.office.immediate(() =>
          renumberStory(s.office, draft.key, StoryId.parse("DIPO-9"), s.clock.now()),
        );
        expect(await touch(s, R1, { story: "DIPO-9", text: "draft" })).toEqual(first);
        expect(await touch(s, R1, { story: draft.key, text: "draft" })).toEqual(first);
        expect(s.calls.touch).toBe(1);
      } finally {
        s.state.close();
      }
    }));

  it("runs a command again once its record is older than 24 hours", () =>
    withTempDir(async (dir) => {
      const s = await setup(dir);
      try {
        seedStory(s);
        await touch(s, R1, { story: "DIPO-7", text: "old" });
        s.clock.advance(REQUEST_TTL_MS);
        const again = await touch(s, R1, { story: "DIPO-7", text: "new" });
        expect(again.ok).toBe(true);
        expect(s.calls.touch).toBe(2);
        expect(countRows(s.office, "requests")).toBe(1);
      } finally {
        s.state.close();
      }
    }));

  it("leaves no rows and consumes no seq when the handler throws", () =>
    withTempDir(async (dir) => {
      const s = await setup(dir);
      try {
        seedStory(s);
        await touch(s, R1, { story: "DIPO-7", text: "kept" });

        s.calls.failWith = new Error("disk on fire");
        const failed = await touch(s, R2, { story: "DIPO-7", text: "lost" });
        expect(failed).toMatchObject({
          ok: false,
          requestId: R2,
          error: { code: "internal", retryable: false },
        });
        s.calls.failWith = new CommandError("story.notRunning", "Nothing runs.");
        const specific = await touch(s, R3, { story: "DIPO-7", text: "lost" });
        expect(errorCode(specific)).toBe("story.notRunning");

        expect(countRows(s.office, "facts")).toBe(1);
        expect(countRows(s.office, "change_log")).toBe(1);
        expect(countRows(s.office, "requests")).toBe(1);
        expect(readLogState(s.office).nextSeq).toBe(2);

        delete s.calls.failWith;
        const next = await touch(s, R4, { story: "DIPO-7", text: "after" });
        expect(next.ok && next.cursor?.seq).toBe(2);
        // A failed request is not recorded, so its id may run again.
        const retried = await touch(s, R2, { story: "DIPO-7", text: "lost" });
        expect(retried.ok && retried.cursor?.seq).toBe(3);
      } finally {
        s.state.close();
      }
    }));

  it("keeps seq gap-free per office", () =>
    withTempDir(async (dir) => {
      const s = await setup(dir);
      const other = addOffice(s, "other");
      try {
        seedStory(s);
        other.immediate(() => addStory(other, s.ids, { story: StoryId.parse("DIPO-7") }, 0));
        const seqs: number[] = [];
        for (const [i, id] of REQUEST_IDS.entries()) {
          const office = i % 2 === 0 ? s.office : other;
          const reply = await touch(
            s,
            id,
            { story: "DIPO-7", text: `n${i}` },
            {
              office: office.officeId,
            },
          );
          if (!reply.ok || reply.cursor === undefined) throw new Error("expected a cursor");
          seqs.push(reply.cursor.seq);
        }
        expect(seqs).toEqual([1, 1, 2, 2]);
        expect(readLogState(s.office).epoch).not.toBe(readLogState(other).epoch);
      } finally {
        s.state.close();
      }
    }));

  it("replies changed: false and no cursor when nothing was written", () =>
    withTempDir(async (dir) => {
      const s = await setup(dir);
      try {
        seedStory(s);
        const reply = await executeCommand(s.deps, {
          requestId: R1,
          office: s.office.officeId,
          name: "fixture.peek",
          args: { story: "DIPO-7", text: "look" },
          origin: "tui",
          confirmed: false,
        });
        expect(reply).toMatchObject({ ok: true, changed: false });
        expect(reply.ok && reply.cursor).toBeUndefined();
      } finally {
        s.state.close();
      }
    }));

  it("fails bad args with args.invalid and the zod issues", () =>
    withTempDir(async (dir) => {
      const s = await setup(dir);
      try {
        const reply = await touch(s, R1, { story: "DIPO-7" });
        expect(reply.ok).toBe(false);
        if (reply.ok) return;
        expect(reply.error.code).toBe("args.invalid");
        expect(reply.error.retryable).toBe(false);
        const { issues } = reply.error.details as { issues: { path: string[] }[] };
        expect(issues.map((issue) => issue.path)).toEqual([["text"]]);
        expect(s.calls.touch).toBe(0);
      } finally {
        s.state.close();
      }
    }));

  it("never falls back to a default office", () =>
    withTempDir(async (dir) => {
      const s = await setup(dir);
      try {
        seedStory(s);
        const args = { story: "DIPO-7", text: "x" };
        const missing = await touch(s, R1, args, { office: undefined });
        expect(errorCode(missing)).toBe("args.invalid");

        const unknown = await touch(s, R2, args, {
          office: OfficeId.parse(s.ids.next("off")),
        });
        expect(errorCode(unknown)).toBe("office.unknown");

        s.state.connection.immediate(() =>
          s.state.connection.run("update offices set forgotten_at = 1 where office_id = $office", {
            office: s.office.officeId,
          }),
        );
        const forgotten = await touch(s, R3, args);
        expect(errorCode(forgotten)).toBe("office.unknown");
        expect(s.calls.touch).toBe(0);
      } finally {
        s.state.close();
      }
    }));

  it("refuses a conversation command that was not confirmed", () =>
    withTempDir(async (dir) => {
      const s = await setup(dir);
      try {
        seedStory(s);
        const args = { story: "DIPO-7", text: "please" };
        const unconfirmed = await touch(s, R1, args, { origin: "conversation", confirmed: false });
        expect(unconfirmed).toMatchObject({
          ok: false,
          error: { code: "confirmation.required", retryable: false },
        });
        expect(s.calls.touch).toBe(0);
        const confirmed = await touch(s, R2, args, { origin: "conversation", confirmed: true });
        expect(confirmed.ok).toBe(true);
      } finally {
        s.state.close();
      }
    }));

  it("fails an unknown story and an unknown command", () =>
    withTempDir(async (dir) => {
      const s = await setup(dir);
      try {
        expect(errorCode(await touch(s, R1, { story: "DIPO-404", text: "x" }))).toBe(
          "story.unknown",
        );
        expect(
          errorCode(await touch(s, R2, { story: "DIPO-7", text: "x" }, { name: "work.nope" })),
        ).toBe("capability.missing");
      } finally {
        s.state.close();
      }
    }));

  it("refreshes the stories once before an unknown story reference fails (DIPO-104)", () =>
    withTempDir(async (dir) => {
      const refreshed: string[] = [];
      let merged: string | null = null;
      let failRefresh = false;
      let mergedKey: ReturnType<typeof seedStory>["key"] | null = null;
      const refreshFeature: FeatureModule = {
        name: "test/refresh",
        register: (registry) =>
          registry.registerStoryRefresh("test.refresh", async (office) => {
            refreshed.push(office);
            if (failRefresh) throw new Error("the remote does not answer");
            // The refresh reads a story merged to the base since the last poll.
            if (merged !== null) mergedKey = seedStory(s, merged).key;
          }),
      };
      const s = await setup(dir, [refreshFeature]);
      try {
        seedStory(s);
        // A known story resolves without a refresh.
        expect((await touch(s, R1, { story: "DIPO-7", text: "x" })).ok).toBe(true);
        expect(refreshed).toEqual([]);

        // A story the office does not know yet resolves after the refresh read it.
        merged = "DIPO-8";
        const reply = await touch(s, R2, { story: "DIPO-8", text: "x" });
        expect(reply.ok).toBe(true);
        expect(refreshed).toEqual([s.office.officeId]);
        expect(s.calls.touch).toBe(2);

        // Still unknown after one refresh, or a refresh that fails: story.unknown.
        merged = null;
        expect(errorCode(await touch(s, R3, { story: "DIPO-404", text: "x" }))).toBe(
          "story.unknown",
        );
        failRefresh = true;
        expect(errorCode(await touch(s, R4, { story: "DIPO-405", text: "x" }))).toBe(
          "story.unknown",
        );
        expect(refreshed).toHaveLength(3);
        expect(s.calls.touch).toBe(2);

        // A retry with a stored reply refreshes nothing, even when its story is gone.
        failRefresh = false;
        const story = mergedKey;
        if (story === null) throw new Error("DIPO-8 was not merged");
        s.office.immediate(() => removeStory(s.office, story, s.clock.now()));
        expect(await touch(s, R2, { story: "DIPO-8", text: "x" })).toEqual(reply);
        expect(refreshed).toHaveLength(3);
      } finally {
        s.state.close();
      }
    }));

  it("resolves with the state it has when the story refresh outlasts its deadline", () =>
    withTempDir(async (dir) => {
      let calls = 0;
      const hanging: FeatureModule = {
        name: "test/hanging-refresh",
        register: (registry) =>
          registry.registerStoryRefresh("test.hanging", () => {
            calls += 1;
            return new Promise<void>(() => undefined);
          }),
      };
      const s = await setup(dir, [hanging]);
      try {
        const pending = touch(s, R1, { story: "DIPO-404", text: "x" });
        let settled = false;
        void pending.then(() => {
          settled = true;
        });
        while (s.clock.pendingTimers === 0) await Bun.sleep(0);
        expect(calls).toBe(1);
        s.clock.advance(STORY_REFRESH_MS - 1);
        await Bun.sleep(0);
        expect(settled).toBe(false);
        s.clock.advance(1);
        expect(errorCode(await pending)).toBe("story.unknown");
        expect(s.clock.pendingTimers).toBe(0);
      } finally {
        s.state.close();
      }
    }));

  it("answers a retry from its record even after the story it named was removed", () =>
    withTempDir(async (dir) => {
      const s = await setup(dir);
      try {
        const story = seedStory(s);
        const first = await touch(s, R1, { story: "DIPO-7", text: "done" });
        expect(first.ok).toBe(true);
        s.office.immediate(() => removeStory(s.office, story.key, s.clock.now()));
        expect(await touch(s, R1, { story: "DIPO-7", text: "done" })).toEqual(first);
        expect(errorCode(await touch(s, R2, { story: "DIPO-7", text: "done" }))).toBe(
          "story.unknown",
        );
        expect(s.calls.touch).toBe(1);
      } finally {
        s.state.close();
      }
    }));

  it("gives a concurrent duplicate of a software-level command the same reply", () =>
    withTempDir(async (dir) => {
      const s = await setup(dir);
      try {
        const level = (value: string) =>
          executeCommand(s.deps, {
            requestId: R1,
            name: "fixture.level",
            args: { level: value },
            origin: "cli",
            confirmed: false,
          });
        const [a, b, c] = await Promise.all([level("debug"), level("debug"), level("info")]);
        expect(a).toMatchObject({ ok: true, result: { level: "debug" } });
        expect(b).toEqual(a);
        expect(errorCode(c)).toBe("request.reused");
        expect(s.calls.level).toBe(1);
        expect(s.deps.softwareRequests.inFlight(R1)).toBeUndefined();
      } finally {
        s.state.close();
      }
    }));

  it("keeps software-level records in memory for 24 hours", () =>
    withTempDir(async (dir) => {
      const s = await setup(dir);
      try {
        const level = (requestId: RequestId, value: string) =>
          executeCommand(s.deps, {
            requestId,
            name: "fixture.level",
            args: { level: value },
            origin: "cli",
            confirmed: false,
          });
        const first = await level(R1, "debug");
        expect(first).toMatchObject({ ok: true, changed: true, result: { level: "debug" } });
        expect(await level(R1, "debug")).toEqual(first);
        expect(errorCode(await level(R1, "info"))).toBe("request.reused");
        expect(s.calls.level).toBe(1);
        expect(errorCode(await level(R2, "trace"))).toBe("not.permitted");
        expect(s.deps.softwareRequests.size).toBe(1);

        s.clock.advance(REQUEST_TTL_MS);
        expect(s.deps.softwareRequests.size).toBe(0);
        expect((await level(R1, "info")).ok).toBe(true);
        expect(s.calls.level).toBe(3);
      } finally {
        s.state.close();
      }
    }));
});
