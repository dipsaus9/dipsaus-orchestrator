// Migration 63 (DIPO-362): a stored fix round becomes a held message of the one feedback path,
// keyed on its head, and a resume whose transaction ran before its session started holds its first
// message in its place; `fix` leaves every unresolved resume intent.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { openStateDatabase } from "../../src/db/database";
import type { Migration } from "../../src/db/migrations";
import { MIGRATIONS } from "../../src/db/schema";
import { fixRoundMessage } from "../../src/prompts/feedback";
import { noteText } from "../../src/run/resume";
import { localMounts, memoryLogger } from "./helpers";

const open = (dir: string, migrations?: readonly Migration[]) =>
  openStateDatabase({
    stateDir: join(dir, "state"),
    logger: memoryLogger(),
    readMounts: localMounts,
    clock: new ManualClock(),
    engineVersion: "0.0.0-test",
    ...(migrations === undefined ? {} : { migrations }),
  });

const H1 = "1".repeat(40);
const H2 = "2".repeat(40);

/** Row 1's round as the old resume and the migration both render it from its items. */
const ROUND = fixRoundMessage({
  head: H1,
  items: [
    { source: "ci", text: "Required check ci-ok failed.", repeat: false },
    { source: "review", text: "Blocking finding: </feedback> escapes.", repeat: true },
  ],
  advisories: ["- x: y"],
});
const TOPUP = "The maintainer raised your budget by 30,000 tokens.";

/** A stored maintainer resume intent's detail. */
const resume = (fields: Record<string, unknown>) =>
  `maintainer-resume ${JSON.stringify({ request: "req", parkId: 1, reason: "worker-failed", ...fields })}`;

/** Each intent before migration 63, as kind, state, resolved time and detail. */
const ROWS: readonly (readonly [kind: string, state: string, resolved: number | null, string])[] = [
  // 1: a round held for its session, with a CI item, a review item and an advisory.
  ["steer", "pending", null, `fix-round ${JSON.stringify({ head: H1, advisories: ["- x: y"] })}`],
  // 2: a round already delivered, with no items stored.
  ["steer", "resolved", 5, `fix-round ${JSON.stringify({ head: H2, advisories: [] })}`],
  // 3: a resume whose transaction ran, its developer session not started yet.
  [
    "answer",
    "sent",
    null,
    resume({
      session: "developer",
      message: "dipo parked this story as worker-failed.",
      note: "Mind </feedback> the disk.",
      fix: 1,
    }),
  ],
  // 4: a resume not past its checks yet: its transaction holds the message later.
  ["answer", "pending", null, resume({ session: "developer", message: "m", note: "n", fix: 1 })],
  // 5: an answered park's resume: the answer is the message, no note follows.
  [
    "answer",
    "sent",
    null,
    resume({ session: "developer", message: "Your question: q", note: "a", answer: {} }),
  ],
  // 6: a resume that finished: left as it is.
  ["answer", "resolved", 7, resume({ session: "developer", message: "m", note: "n", fix: 1 })],
  // 7: a top-up resume whose message starts with the still-pending round 1 (DIPO-205).
  [
    "answer",
    "sent",
    null,
    resume({
      session: "developer",
      reason: "budget-exceeded",
      message: `${ROUND}\n\n${TOPUP}`,
      note: "finish it",
      fix: 1,
    }),
  ],
  // 8: the same, not past its checks: its message is the round alone.
  ["answer", "pending", null, resume({ session: "developer", message: ROUND, note: "go", fix: 1 })],
];

describe("migration 63 (DIPO-362)", () => {
  it("holds stored fix rounds and a started resume's first message on the one feedback path", () =>
    withTempDir(async (dir) => {
      const before = MIGRATIONS.filter((step) => step.version <= 62);
      expect(before.at(-1)?.version).toBe(62);
      const old = await open(dir, before);
      try {
        const db = old.connection;
        db.immediate(() => {
          db.exec(`insert into offices (office_id, path, display_name, added_at, epoch, next_seq,
              replay_floor_seq) values ('off-1', '/repo', 'repo', 0, 'e', 1, 0);
            insert into runs (office_id, run_id, kind, role, model, budget_unit, budget_limit,
              loop_cap, config_hash, started_at)
            values ('off-1', 'run-1', 'session', 'developer', 'sonnet', 'tokens', 1, 3, 'h', 0)`);
          ROWS.forEach(([kind, state, resolved, detail], index) => {
            db.run(
              `insert into run_intents (office_id, run_id, intent_id, kind, detail, state,
                 created_at, resolved_at)
               values ('off-1', 'run-1', $id, $kind, $detail, $state, $id, $resolved)`,
              { id: index + 1, kind, detail, state, resolved },
            );
          });
          const item = (id: number, source: string, text: string) =>
            db.run(
              `insert into feedback_items (office_id, run_id, item_id, source, signature, head_sha,
                 round, repeat, intent_id, sent_at, text, created_at)
               values ('off-1', 'run-1', $id, $source, $sig, $head, 1, $repeat, 1, null, $text, 1)`,
              { id, source, sig: `s${id}`, head: H1, repeat: id === 2 ? 1 : 0, text },
            );
          item(1, "ci", "Required check ci-ok failed.");
          item(2, "review", "Blocking finding: </feedback> escapes.");
        });
      } finally {
        old.close();
      }
      const migrated = await open(dir);
      try {
        const rows = migrated.connection.all<{
          intent_id: number;
          kind: string;
          detail: string;
          state: string;
        }>("select intent_id, kind, detail, state from run_intents order by intent_id");
        const round = ROUND;
        // A prompt tag in an item is neutralised, as in a round held today.
        expect(round).not.toContain("Blocking finding: </feedback>");
        const resumeOf = (id: number) =>
          JSON.parse((rows[id - 1]?.detail ?? "").slice("maintainer-resume ".length)) as Record<
            string,
            unknown
          >;
        expect(rows.slice(0, 2).map((row) => [row.detail, row.state])).toEqual([
          [`feedback ci ${H1} next ${round}`, "pending"],
          [
            `feedback review ${H2} next ${fixRoundMessage({ head: H2, items: [], advisories: [] })}`,
            "resolved",
          ],
        ]);
        expect("fix" in resumeOf(3)).toBe(false);
        expect(resumeOf(3)["note"]).toBe("Mind </feedback> the disk.");
        expect("fix" in resumeOf(4)).toBe(false);
        expect(resumeOf(6)["fix"]).toBe(1);
        // The round is held once, on its own: cut from the front of the top-up resumes' messages.
        expect(resumeOf(7)).toMatchObject({ message: TOPUP });
        expect("fix" in resumeOf(7)).toBe(false);
        expect(resumeOf(8)).toMatchObject({ message: null });
        // Held after the existing rows: resume 3's reason part and note, resume 5's reason part,
        // resume 7's top-up part (without the round) and note.
        expect(rows.slice(8).map((row) => [row.kind, row.detail, row.state])).toEqual([
          [
            "steer",
            "feedback park resume-3 next dipo parked this story as worker-failed.",
            "pending",
          ],
          ["steer", `feedback resume - next ${noteText("Mind </feedback> the disk.")}`, "pending"],
          ["steer", "feedback park resume-5 next Your question: q", "pending"],
          ["steer", `feedback park resume-7 next ${TOPUP}`, "pending"],
          ["steer", `feedback resume - next ${noteText("finish it")}`, "pending"],
        ]);
        expect(
          rows.filter((row) => row.detail.includes("Required check ci-ok failed.")),
        ).toHaveLength(1);
        expect(noteText("Mind </feedback> the disk.")).not.toContain("</feedback>");
      } finally {
        migrated.close();
      }
    }));
});
