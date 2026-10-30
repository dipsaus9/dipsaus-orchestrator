// The stored-intent helper (0008 sections 6 and 7, DIPO-126): the intent is stored before the
// first op is sent, marked sent or failed afterwards, and a failed store sends nothing. The kind
// -> outcome table is checked for every kind, so a new kind needs its row (and its migration: the
// `run_intents.kind` CHECK constraint refuses a kind it does not list).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { StoryId } from "@dipsaus-orchestrator/contract";

import { insertRun } from "../../src/records";
import {
  type IntentKind,
  type IntentSteering,
  outcomeOfIntent,
  recordIntent,
  runIntents,
  sendAsIntent,
} from "../../src/records/intents";
import { addStory } from "../../src/stories/keys";
import type { HostOp, WorkerOutcome } from "../../src/workers/types";
import { type IngestFixture, ingestFixture } from "../ingest/helpers";

const OPS: HostOp[] = [{ closeStdin: true }];

let dir: string;
let f: IngestFixture;
let calls: HostOp[][];

beforeEach(async () => {
  dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "run-intents-"));
  f = await ingestFixture(dir);
  const { office } = f;
  office.immediate(() => {
    const { key } = addStory(office, f.t.ids, { story: StoryId.parse("DIPO-1") }, f.t.clock.now());
    insertRun(office, {
      runId: f.run,
      kind: "story",
      key,
      story: "DIPO-1",
      tier: "M",
      role: "developer",
      model: "haiku",
      startSha: "b".repeat(40),
      branch: "DIPO-1/add-a-greeting",
      budgetUnit: "tokens",
      budgetLimit: 1_000_000,
      loopCap: 3,
      reviewRoundCap: null,
      configHash: "h",
      overrideKeys: null,
      runProfileId: null,
      startedAt: f.t.clock.now(),
    });
  });
  calls = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function steering(answer: () => ReturnType<IntentSteering["send"]>): IntentSteering {
  return {
    send: (_office, _run, ops) => {
      calls.push([...ops]);
      return answer();
    },
  };
}

describe("sendAsIntent", () => {
  it("stores the intent before the send and marks it sent", async () => {
    let storedAtSend: string[] = [];
    const s = steering(async () => {
      storedAtSend = runIntents(f.office, f.run).map((i) => `${i.kind}:${i.state}`);
      return { ok: true };
    });
    const { done } = sendAsIntent(f.office, s, f.run, {
      kind: "steer",
      detail: "d",
      ops: OPS,
      clock: f.t.clock,
    });
    const sent = await done;
    expect(storedAtSend).toEqual(["steer:pending"]);
    expect(sent.error).toBeNull();
    expect(calls).toEqual([OPS]);
    const [intent] = runIntents(f.office, f.run);
    expect(intent?.state).toBe("sent");
    expect(intent?.sentAt).not.toBeNull();
  });

  it("sends nothing and throws when the intent cannot be stored", () => {
    const s = steering(async () => ({ ok: true }));
    expect(() =>
      sendAsIntent(f.office, s, f.run, {
        kind: "nonsense" as IntentKind,
        detail: "d",
        ops: OPS,
        clock: f.t.clock,
      }),
    ).toThrow();
    expect(calls).toEqual([]);
    expect(runIntents(f.office, f.run)).toEqual([]);
  });

  it("marks the intent failed with the host's reason when the send is refused", async () => {
    const s = steering(async () => ({ ok: false, reason: "the worker host has exited" }));
    const sent = await sendAsIntent(f.office, s, f.run, {
      kind: "stop",
      detail: "d",
      ops: OPS,
      clock: f.t.clock,
    }).done;
    expect(sent.error).toBe("the worker host has exited");
    const [intent] = runIntents(f.office, f.run);
    expect(intent?.state).toBe("failed");
    expect(intent?.error).toBe("the worker host has exited");
  });

  it("marks the intent failed when the send throws", async () => {
    const s = steering(async () => {
      throw new Error("socket gone");
    });
    const sent = await sendAsIntent(f.office, s, f.run, {
      kind: "pause",
      detail: "d",
      ops: OPS,
      clock: f.t.clock,
    }).done;
    expect(sent.error).toBe("socket gone");
    expect(runIntents(f.office, f.run)[0]?.state).toBe("failed");
  });

  it("only marks an intent with no ops", async () => {
    const s = steering(async () => ({ ok: true }));
    const none = await sendAsIntent(f.office, s, f.run, {
      kind: "cap",
      detail: "d",
      ops: [],
      clock: f.t.clock,
    }).done;
    expect(none.error).toBeNull();
    expect(calls).toEqual([]);
    expect(runIntents(f.office, f.run).map((i) => i.state)).toEqual(["sent"]);
  });

  it("runs beforeSend after the store and sends nothing when it throws", async () => {
    const s = steering(async () => ({ ok: true }));
    const { done } = sendAsIntent(f.office, s, f.run, {
      kind: "park",
      detail: "d",
      ops: OPS,
      clock: f.t.clock,
      beforeSend: () => {
        throw new Error("notice write failed");
      },
    });
    await expect(done).rejects.toThrow("notice write failed");
    expect(calls).toEqual([]);
    expect(runIntents(f.office, f.run)[0]?.state).toBe("pending");
  });

  it("runs inMark in the transaction that marks the intent", async () => {
    const s = steering(async () => ({ ok: false, reason: "gone" }));
    const seen: (string | null)[] = [];
    const sent = await sendAsIntent(f.office, s, f.run, {
      kind: "stop",
      detail: "d",
      ops: OPS,
      clock: f.t.clock,
      inMark: (error) => {
        seen.push(error);
        return runIntents(f.office, f.run)[0]?.state;
      },
    }).done;
    expect(seen).toEqual(["gone"]);
    expect(sent.marked).toBe("failed");
  });
});

describe("outcomeOfIntent per kind", () => {
  const OUTCOMES: Record<IntentKind, WorkerOutcome | null> = {
    steer: null,
    answer: null,
    pause: null,
    stop: "stopped",
    reassign: "reassigned",
    cap: "capped",
    park: "blocked",
  };
  for (const [kind, outcome] of Object.entries(OUTCOMES)) {
    it(`reads ${kind} as ${outcome ?? "no outcome"}, and the table accepts the kind`, () => {
      f.office.immediate(() => recordIntent(f.office, f.run, kind as IntentKind, "d", 1));
      expect(outcomeOfIntent(f.office, f.run)?.outcome ?? null).toBe(outcome);
    });
  }
});
