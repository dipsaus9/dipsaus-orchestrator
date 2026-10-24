// "Since you left" (DIPO-308; 0009 section 8): `office.digest` counts what the change log holds after
// `since`, and without `since` counts from when the office's last TUI client disconnected, as
// `recordTuiLeft` stored it in `offices.tui_left_at` (migration 55).

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { RequestId, type StoryKey } from "@dipsaus-orchestrator/contract";
import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { appendEntries } from "../../src/changelog/log";
import type { OfficeDirectory } from "../../src/commands/offices";
import { buildRegistry } from "../../src/commands/registry";
import { openStateDatabase } from "../../src/db/database";
import type { OfficeHandle } from "../../src/db/office";
import { MIGRATIONS } from "../../src/db/schema";
import { executeRead } from "../../src/reads/execute";
import { capabilityFlags } from "../../src/reads/hello";
import { DIGEST_COUNTS, recordTuiLeft, tuiLeftAt } from "../../src/views/digest";
import { viewsFeature } from "../../src/views/feature";
import { addOffice, openTestState, type TestState } from "../commands/helpers";
import { localMounts, memoryLogger } from "../db/helpers";
import { pass, task } from "../stories/helpers";
import { keyOf } from "./helpers";

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
  it("is shipped behind the capability flag digest", () => {
    expect(capabilityFlags(buildRegistry([viewsFeature]))).toContain("digest");
  });

  it("without since counts from the stored time the office's last TUI client disconnected", () =>
    withOffice(async (t, office) => {
      t.clock.advance(5 * MINUTE);
      storeFacts(t, office); // before the TUI left: not counted
      t.clock.advance(MINUTE);
      const left = t.clock.now();
      recordTuiLeft(office, left);
      expect(tuiLeftAt(office)).toBe(left);
      t.clock.advance(MINUTE);
      storeFacts(t, office);
      t.clock.advance(MINUTE);

      const result = await readDigest(t, office);
      expect(result.since).toBe(new Date(left).toISOString());
      expect(Object.keys(result.counts)).toEqual([...DIGEST_COUNTS]);
      expect(result.counts).toEqual({
        done: 1,
        parked: 1,
        held: 0,
        questions: 0,
        merges: 0,
        proposals: 0,
      });
      expect(result.lines).toEqual(["DIPO-1 done", "DIPO-2 parked: verify-failing"]);
    }));

  it("with since counts from that time instead", () =>
    withOffice(async (t, office) => {
      const start = t.clock.now();
      t.clock.advance(MINUTE);
      storeFacts(t, office);
      recordTuiLeft(office, t.clock.now() + MINUTE);
      t.clock.advance(2 * MINUTE);
      const result = await readDigest(t, office, new Date(start).toISOString());
      expect(result.counts["done"]).toBe(1);
      expect(result.lines).toHaveLength(2);
    }));

  it("counts from the time of the read while no TUI has left the office", () =>
    withOffice(async (t, office) => {
      storeFacts(t, office);
      t.clock.advance(MINUTE);
      expect(tuiLeftAt(office)).toBeNull();
      const result = await readDigest(t, office);
      expect(result.since).toBe(new Date(t.clock.now()).toISOString());
      expect(result.counts["done"]).toBe(0);
      expect(result.lines).toEqual([]);
    }));
});

describe("migration 55 on a database at version 54", () => {
  it("adds offices.tui_left_at, null for the offices it keeps", () =>
    withTempDir(async (dir) => {
      const open = (migrations?: typeof MIGRATIONS) =>
        openStateDatabase({
          stateDir: join(dir, "state"),
          logger: memoryLogger(),
          readMounts: localMounts,
          clock: new ManualClock(),
          engineVersion: "0.0.0-test",
          ...(migrations === undefined ? {} : { migrations }),
        });
      const old = await open(MIGRATIONS.filter((step) => step.version <= 54));
      try {
        old.connection.immediate(() =>
          old.connection.exec(`insert into offices (office_id, path, display_name, added_at, epoch,
            next_seq, replay_floor_seq) values ('off-1', '/repo', 'repo', 0, 'e', 1, 0)`),
        );
      } finally {
        old.close();
      }
      const state = await open();
      try {
        expect(MIGRATIONS.find((step) => step.version === 55)?.name).toBe("tui left");
        expect(state.connection.all("select office_id, tui_left_at from offices")).toEqual([
          { office_id: "off-1", tui_left_at: null },
        ]);
      } finally {
        state.close();
      }
    }));
});
