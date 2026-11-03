// "Since you left" (0009): `office.digest` counts what the change log holds after the `since` the
// client sends; the engine keeps no last-seen time of its own (0001).

import { describe, expect, it } from "bun:test";

import { RequestId, type StoryKey } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { appendEntries } from "../../src/changelog/log";
import type { OfficeDirectory } from "../../src/commands/offices";
import { buildRegistry } from "../../src/commands/registry";
import type { OfficeHandle } from "../../src/db/office";
import { executeRead } from "../../src/reads/execute";
import { DIGEST_COUNTS } from "../../src/overview/digest";
import { viewsFeature } from "./views-feature";
import { addOffice, openTestState, type TestState } from "../commands/helpers";
import { pass, task } from "../stories/helpers";
import { keyOf } from "../views/helpers";

const MINUTE = 60_000;

function directory(office: OfficeHandle): OfficeDirectory {
  return {
    get: (id) => (id === office.officeId ? office : undefined),
    load: async () => ({ ok: true, office }),
  };
}

interface Digest {
  readonly since: string;
  readonly counts: Record<string, number>;
  readonly lines: string[];
}

async function readDigest(t: TestState, office: OfficeHandle, since?: string): Promise<Digest> {
  const reply = await executeRead(
    { registry: buildRegistry([viewsFeature]), offices: directory(office), clock: t.clock },
    {
      requestId: RequestId.parse("01J9ZK5Q8W3V4X6Y7Z00000001"),
      name: "office.digest",
      args: { office: office.officeId, ...(since === undefined ? {} : { since }) },
    },
  );
  if (!reply.ok)
    throw new Error(`office.digest failed: ${reply.error.code} ${reply.error.message}`);
  return reply.result as Digest;
}

function view(key: StoryKey, story: string, lifecycle: string, column: string) {
  return { key, story, provisional: false, title: story, lifecycle, column };
}

/** A story moving to Done and one parking, as the engine stores them, at the clock's time. */
function storeFacts(t: TestState, office: OfficeHandle): void {
  const done = keyOf(office, "DIPO-1");
  const parked = keyOf(office, "DIPO-2");
  office.immediate(() =>
    appendEntries(
      office,
      [
        {
          type: "story.state",
          key: done,
          delta: { story: "DIPO-1", key: done, from: "In Review", to: "Done" },
          view: view(done, "DIPO-1", "Done", "done"),
        },
        {
          type: "story.parked",
          key: parked,
          delta: {
            story: "DIPO-2",
            key: parked,
            reason: "verify-failing",
            detail: "tests fail",
            from: "In Progress",
            actions: ["work.resume"],
          },
        },
        {
          type: "story.state",
          key: parked,
          delta: { story: "DIPO-2", key: parked, from: "In Progress", to: "Parked" },
          view: view(parked, "DIPO-2", "Parked", "parked"),
        },
      ],
      { at: t.clock.now() },
    ),
  );
}

async function withOffice(fn: (t: TestState, office: OfficeHandle) => Promise<void>) {
  await withTempDir(async (dir) => {
    const t = await openTestState(dir);
    try {
      const office = addOffice(t);
      pass(t, office, [task("DIPO-1", { status: "Done" }), task("DIPO-2", { status: "Ready" })]);
      await fn(t, office);
    } finally {
      t.state.close();
    }
  });
}

describe("office.digest", () => {
  it("counts from the since the client sends, each count present in order", () =>
    withOffice(async (t, office) => {
      t.clock.advance(5 * MINUTE);
      storeFacts(t, office); // before since: not counted
      t.clock.advance(MINUTE);
      const since = new Date(t.clock.now()).toISOString();
      t.clock.advance(MINUTE);
      storeFacts(t, office);
      t.clock.advance(MINUTE);

      const result = await readDigest(t, office, since);
      expect(result.since).toBe(since);
      expect(Object.keys(result.counts)).toEqual([...DIGEST_COUNTS]);
      expect(result.counts).toEqual({
        done: 1,
        parked: 1,
        parkedByYou: 0,
        questions: 0,
        merges: 0,
        proposals: 0,
      });
      expect(result.lines).toEqual(["DIPO-1 done", "DIPO-2 parked: verify-failing"]);
    }));

  it("counts a story the maintainer parked as parkedByYou", () =>
    withOffice(async (t, office) => {
      const since = new Date(t.clock.now()).toISOString();
      t.clock.advance(MINUTE);
      const key = keyOf(office, "DIPO-2");
      office.immediate(() =>
        appendEntries(
          office,
          [
            {
              type: "story.parked",
              key,
              delta: {
                story: "DIPO-2",
                key,
                reason: "by-maintainer",
                detail: "later",
                from: "Ready",
                actions: ["work.resume"],
              },
            },
          ],
          { at: t.clock.now() },
        ),
      );
      const result = await readDigest(t, office, since);
      expect(result.counts["parkedByYou"]).toBe(1);
      expect(result.counts["parked"]).toBe(0);
      expect(result.lines).toEqual(["DIPO-2 parked by you"]);
    }));

  it("refuses a read without since: the engine keeps no last-seen time of its own", () =>
    withOffice(async (t, office) => {
      await expect(readDigest(t, office)).rejects.toThrow(/office\.digest failed/);
    }));
});
