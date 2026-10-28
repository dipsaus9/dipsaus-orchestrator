// The one feedback path (DIPO-361, 0002): every source of feedback reaches the developer session
// through `sendFeedback`, tagged with its source. A live session gets each as one message at once;
// otherwise each waits, in order, for the next developer session's first message. Fast and local,
// on a migrated state database with one story run.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { StoryId } from "@dipsaus-orchestrator/contract";

import {
  deliverHeld,
  type FeedbackSender,
  type FeedbackSource,
  feedbackIntents,
  findSteer,
  heldFeedback,
  parseFeedback,
  sendFeedback,
} from "../../src/run/feedback";
import { insertRun } from "../../src/run";
import { runIntents } from "../../src/run/intents";
import { addStory } from "../../src/stories/keys";
import { encode } from "../../src/workers/claude-cli/encode";
import type { HostOp } from "../../src/workers/types";
import { type IngestFixture, ingestFixture } from "../ingest/helpers";

/** Every source 0002 sends to the developer session, with the message dipo sends for it. */
const SOURCES: readonly (readonly [FeedbackSource, string])[] = [
  ["report", "Your last turn ended without a valid report."],
  ["report-gate", "Cover test-plan entry #1."],
  ["verify", "verify failed: 1 test."],
  ["conflict", "git could not merge main cleanly."],
  ["overlap", "DIPO-2 changes the same file."],
  ["review", "The review blocked criterion #2."],
  ["ci", "The required check test failed."],
  ["reject", "The maintainer rejected it."],
  ["resume", "Note from the maintainer: go on."],
  ["steer", "The maintainer says: use bun."],
  ["answer", "The maintainer answered: yes."],
];

let dir: string;
let f: IngestFixture;
let sent: { run: string; ops: HostOp[] }[];
let refuse: string | null;
let sender: FeedbackSender;

beforeEach(async () => {
  dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "feedback-"));
  f = await ingestFixture(dir);
  sent = [];
  refuse = null;
  sender = {
    clock: f.t.clock,
    encode,
    steering: {
      send: async (_office, run, ops) => {
        if (refuse !== null) return { ok: false, reason: refuse };
        sent.push({ run, ops: [...ops] });
        return { ok: true };
      },
    },
  };
  const { office } = f;
  office.immediate(() => {
    const { key } = addStory(office, f.t.ids, { story: StoryId.parse("DIPO-1") }, 0);
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
      worktree: join(dir, "trees", "DIPO-1"),
      slot: 1,
      budgetUnit: "tokens",
      budgetLimit: 1_000_000,
      loopCap: 3,
      reviewRoundCap: null,
      configHash: "h",
      overrideKeys: null,
      runProfileId: null,
      startedAt: 0,
    });
  });
});

afterEach(() => {
  f.t.state.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a live developer session (0002)", () => {
  it("gets every source as one message to the same session, through the one function", async () => {
    for (const [source, text] of SOURCES) {
      const out = sendFeedback(f.office, f.run, { source, text }, { sender });
      expect(out.delivered).toBe("now");
      expect(await out.done).toBeNull();
    }
    expect(sent).toEqual(
      SOURCES.map(([, text]) => ({ run: f.run, ops: encode({ kind: "steer", text }) })),
    );
    expect(
      feedbackIntents(f.office, f.run).map((item) => [item.source, item.text, item.state]),
    ).toEqual(SOURCES.map(([source, text]) => [source, text, "sent"]));
    // Nothing is left for a next session.
    expect(heldFeedback(f.office, f.run).texts).toEqual([]);
  });

  it("marks a message the host refused failed and returns why", async () => {
    refuse = "the host is gone";
    const out = sendFeedback(
      f.office,
      f.run,
      { source: "report-gate", text: "Cover #1." },
      { sender },
    );
    expect(await out.done).toBe("the host is gone");
    expect(runIntents(f.office, f.run).map((intent) => [intent.state, intent.error])).toEqual([
      ["failed", "the host is gone"],
    ]);
    expect(heldFeedback(f.office, f.run).texts).toEqual([]);
  });
});

describe("no live developer session (0020)", () => {
  it("holds every source, oldest first, for the next session's first message, delivered once", async () => {
    for (const [source, text] of SOURCES) {
      const out = sendFeedback(f.office, f.run, { source, text }, { at: 5 });
      expect(out.delivered).toBe("next-session");
      expect(await out.done).toBeNull();
    }
    expect(sent).toEqual([]);
    const held = heldFeedback(f.office, f.run);
    expect(held.texts).toEqual(SOURCES.map(([, text]) => text));
    f.office.immediate(() => deliverHeld(f.office, f.run, held.ids, 9));
    expect(heldFeedback(f.office, f.run).texts).toEqual([]);
    expect(
      runIntents(f.office, f.run).every(
        (intent) =>
          intent.state === "resolved" && intent.outcome === "resumed" && intent.sentAt === 9,
      ),
    ).toBe(true);
  });

  it("never replays a live message a stop left pending between its store and its send", async () => {
    // The daemon stopped after the store, before the host call: the row stays `pending`.
    const { promise: stopped, resolve: stop } = Promise.withResolvers<void>();
    const hung: FeedbackSender = {
      ...sender,
      steering: {
        send: async () => {
          stop();
          return await new Promise(() => undefined);
        },
      },
    };
    sendFeedback(f.office, f.run, { source: "report-gate", text: "Cover #1." }, { sender: hung });
    await stopped;
    expect(runIntents(f.office, f.run).map((intent) => intent.state)).toEqual(["pending"]);
    sendFeedback(f.office, f.run, { source: "resume", text: "Go on." }, { at: 2 });
    // Only the held message goes with the next session; the live one is never sent twice.
    expect(heldFeedback(f.office, f.run).texts).toEqual(["Go on."]);
  });

  it("stores inside the caller's transaction", () => {
    f.office.immediate(() => {
      sendFeedback(f.office, f.run, { source: "answer", text: "Yes." }, { at: 1 });
    });
    expect(heldFeedback(f.office, f.run).texts).toEqual(["Yes."]);
  });
});

describe("the stored message", () => {
  it("is keyed: a steer is found by its request, and a key holds no spaces", async () => {
    sendFeedback(f.office, f.run, { source: "steer", key: "01REQ", text: "Use bun." }, { at: 1 });
    expect(findSteer(f.office, "01REQ")).toEqual({ runId: f.run, held: true });
    sendFeedback(f.office, f.run, { source: "steer", key: "01LIVE", text: "Go." }, { sender });
    expect(findSteer(f.office, "01LIVE")).toEqual({ runId: f.run, held: false });
    expect(findSteer(f.office, "01OTHER")).toBeNull();
    expect(() =>
      sendFeedback(f.office, f.run, { source: "steer", key: "a b", text: "x" }, { at: 1 }),
    ).toThrow("no spaces");
  });

  it("reads back its source, key, delivery and text, and nothing of another detail", () => {
    expect(parseFeedback("feedback report agt_1 now Return the report.\nNow.")).toEqual({
      source: "report",
      key: "agt_1",
      via: "now",
      text: "Return the report.\nNow.",
    });
    expect(parseFeedback("feedback steer 01REQ next ")).toEqual({
      source: "steer",
      key: "01REQ",
      via: "next",
      text: "",
    });
    expect(parseFeedback("fix-round {}")).toBeNull();
    expect(parseFeedback("feedback report")).toBeNull();
    expect(parseFeedback("feedback report agt_1 Return the report.")).toBeNull();
  });
});
