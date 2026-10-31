// The desk (DIPO-158; 0020 section 12): `office.desk` lists what waits on the maintainer from stored
// facts in the six groups, ordered within a group by the stories each item blocks and then by age,
// with the exact command line to type; a review-blocked park is one row with resume and approve,
// and a gate held by `autorelease: pending` offers a hand merge and no `dipo approve`.

import { describe, expect, it } from "bun:test";

import {
  type DeskItem,
  RequestId,
  RunId,
  StoryId,
  type StoryKey,
} from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { LANE_STUCK_MS, laneDeskItems } from "../../src/backlog/lane";
import { insertEntry } from "../../src/backlog/lane/journal";
import { backlogPrDeskItems } from "../../src/backlog/pr/desk";
import { insertPr, recordCheck } from "../../src/backlog/pr/records";
import type { OfficeDirectory } from "../../src/commands/offices";
import { buildRegistry } from "../../src/commands/registry";
import type { OfficeHandle } from "../../src/db/office";
import { insertWorkerQuestion } from "../../src/run-state/questions";
import { executeRead } from "../../src/reads/execute";
import { storeDecisionNotes, storeProposals } from "../../src/run/report-data";
import { insertTest } from "../../src/run/test-records";
import { StoryDiscard } from "../../src/stories/discard";
import {
  desk,
  DESK_DETAIL_MAX,
  deskLine,
  deskText,
  type DeskSources,
  DESK_SOURCES,
} from "../../src/views/desk";
import { viewsFeature } from "./views-feature";
import { addOffice, openTestState, type TestState } from "../commands/helpers";
import { pass, task } from "../stories/helpers";
import { insertPark as insertParkRow } from "../run/park-fixture";
import { keyOf, startRun } from "./helpers";
import { backlogLayout } from "../story-store/backlog";

const HOUR = 3_600_000;
const all = () => true;

/** The engine's sources with the planning lane's backlog PRs, as `engineFeatures` lists them. */
const ALL_SOURCES: DeskSources = {
  stories: backlogLayout,
  ...DESK_SOURCES,
  prItems: backlogPrDeskItems,
};

function insertPark(
  office: OfficeHandle,
  story: string,
  park: { reason: string; detail: string; at: number; run?: string },
): number {
  const key = keyOf(office, story);
  return office.immediate(() =>
    insertParkRow(office, {
      key,
      story,
      runId: park.run ?? null,
      reason: park.reason,
      detail: park.detail,
      at: park.at,
    }),
  );
}

function insertMergeGate(
  office: OfficeHandle,
  gate: { id: string; key: StoryKey; run: RunId; summary: string; at: number },
): void {
  office.immediate(() =>
    office.run(
      `insert into gates (office_id, gate_id, kind, key, run_id, opened_at, waiting_on, summary)
       values ($office_id, $gate, 'merge', $key, $run, $at, 'maintainer', $summary)`,
      { gate: gate.id, key: gate.key, run: gate.run, at: gate.at, summary: gate.summary },
    ),
  );
}

function insertStoryPr(
  office: OfficeHandle,
  pr: { key: StoryKey; run: RunId; number: number; at: number },
): void {
  office.immediate(() =>
    office.run(
      `insert into story_prs (office_id, run_id, key, pr_number, url, branch, base, head_sha, state,
         title, body_hash, opened_at)
       values ($office_id, $run, $key, $number, $url, 'b', 'main', 'abc', 'open', 't', 'h', $at)`,
      {
        run: pr.run,
        key: pr.key,
        number: pr.number,
        url: `https://github.com/o/r/pull/${pr.number}`,
        at: pr.at,
      },
    ),
  );
}

function rows(items: readonly DeskItem[]): string[] {
  return items.map((item) => `${item.kind} ${item.story ?? "-"}`);
}

describe("the desk order (0020 section 12)", () => {
  it("lists every group in order, with dependents breaking ties before age", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const office = addOffice(t);
        pass(t, office, [
          ...["DIPO-1", "DIPO-2", "DIPO-3"].map((id) => task(id, { status: "In Progress" })),
          ...["DIPO-4", "DIPO-5", "DIPO-6", "DIPO-7", "DIPO-8", "DIPO-9", "DIPO-10"].map((id) =>
            task(id, { status: "Parked" }),
          ),
          task("DIPO-11", { status: "In Progress" }),
          task("DIPO-12", { status: "Refined" }),
          // Two active stories wait on DIPO-7 and one on DIPO-6; a Done one on DIPO-4 counts none.
          task("DIPO-20", { status: "Ready", waitingOn: ["DIPO-7", "DIPO-6"] }),
          task("DIPO-21", { status: "Refined", waitingOn: ["DIPO-7"] }),
          task("DIPO-22", { status: "Done", waitingOn: ["DIPO-4"] }),
        ]);
        const base = t.clock.now();
        const q1 = startRun(t, office, "DIPO-1", dir);
        const q2 = startRun(t, office, "DIPO-2", dir);
        const merge = startRun(t, office, "DIPO-3", dir);
        const questionRun = startRun(t, office, "DIPO-4", dir);
        office.immediate(() => {
          insertWorkerQuestion(office, {
            questionId: "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1A",
            runId: q2.run,
            agentId: q2.agent,
            text: "Keep the old\nflag?",
            at: base + 2 * HOUR,
          });
          insertWorkerQuestion(office, {
            questionId: "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1B",
            runId: q1.run,
            agentId: q1.agent,
            text: "Which port?",
            at: base + 3 * HOUR,
          });
        });
        insertStoryPr(office, { key: merge.key, run: merge.run, number: 12, at: base });
        insertMergeGate(office, {
          id: "gat_01J9ZK5Q8W3V4X6Y7Z8A9B0C1C",
          key: merge.key,
          run: merge.run,
          summary: "merge.autoMerge is off: approve or reject the merge",
          at: base + HOUR,
        });
        // Group 3: by reason as 0020 lists them, whatever their age; group 4: the stories the
        // maintainer parked.
        insertPark(office, "DIPO-5", { reason: "by-maintainer", detail: "stopped", at: base });
        insertPark(office, "DIPO-6", {
          reason: "verify-failing",
          detail: "verify red three times",
          at: base + HOUR,
        });
        insertPark(office, "DIPO-7", {
          reason: "budget-exceeded",
          detail: "turn cap 61 of 60",
          at: base + 4 * HOUR,
        });
        insertPark(office, "DIPO-8", {
          reason: "conflict",
          detail: "conflicted: a.ts",
          at: base + 2 * HOUR,
        });
        const questionPark = insertPark(office, "DIPO-4", {
          reason: "ambiguous-spec",
          detail: "Which flag?",
          at: base + 5 * HOUR,
          run: questionRun.run,
        });
        office.immediate(() =>
          insertWorkerQuestion(office, {
            questionId: "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D",
            runId: questionRun.run,
            agentId: questionRun.agent,
            text: "Which flag?",
            at: base + 5 * HOUR,
            parkId: questionPark,
          }),
        );
        insertPark(office, "DIPO-9", { reason: "by-maintainer", detail: "after M2", at: base });
        // Group 4: a backlog PR whose check failed, and a hand item from a source.
        office.immediate(() => {
          insertPr(
            office,
            {
              number: 40,
              url: "https://github.com/o/r/pull/40",
              branch: "backlog/x",
              title: "chore: x",
            },
            base,
          );
          recordCheck(
            office,
            40,
            {
              head: "h",
              base: "b",
              passed: false,
              failures: [{ rule: "transition", message: "DIPO-12 changed a field by hand" }],
              touched: [],
            },
            base + 6 * HOUR,
          );
        });
        // Group 5: a follow-up, a spike and a decision note, oldest first by row; spike leads.
        const run = RunId.parse("run_01J9ZK5Q8W3V4X6Y7Z8A9B0C1E");
        const key11 = keyOf(office, "DIPO-11");
        office.immediate(() => {
          storeProposals(office, {
            key: key11,
            runId: run,
            proposals: [{ kind: "follow-up", title: "Split RunOutcomes", outcome: "o", why: "w" }],
            at: base,
          });
          storeProposals(office, {
            key: key11,
            runId: run,
            proposals: [{ kind: "spike", title: "Choose a queue", outcome: "o", why: "w" }],
            at: base + HOUR,
          });
          storeDecisionNotes(office, {
            key: key11,
            runId: run,
            notes: [{ file: "docs/decisions/0019-review-loop.md", section: "4", text: "Note." }],
            at: base - HOUR,
          });
        });
        const sources: DeskSources = {
          ...ALL_SOURCES,
          handItems: [
            () => [
              {
                kind: "LEFTOVERS",
                key: keyOf(office, "DIPO-10"),
                story: "DIPO-10",
                detail: "Done on main (a1b2c3d) · 3 commits not on main",
                since: base,
                actions: [{ command: "work.discard", cli: 'dipo discard DIPO-10 --note "<why>"' }],
              },
            ],
          ],
        };

        const items = desk(office, all, sources);
        expect(rows(items)).toEqual([
          "QUESTION DIPO-2",
          "QUESTION DIPO-1",
          "MERGE DIPO-3",
          "PARKED DIPO-4",
          "PARKED DIPO-7",
          "PARKED DIPO-6",
          "PARKED DIPO-8",
          "PARKED BY YOU DIPO-5",
          "PARKED BY YOU DIPO-9",
          "LEFTOVERS DIPO-10",
          "BACKLOG PR -",
          "PROPOSAL DIPO-11",
          "PROPOSAL DIPO-11",
          "PROPOSAL DIPO-11",
        ]);
        const byStory = (story: string, kind = "PARKED") =>
          items.find((item) => item.story === story && item.kind === kind);
        expect(byStory("DIPO-7")?.blocks).toEqual([
          StoryId.parse("DIPO-20"),
          StoryId.parse("DIPO-21"),
        ]);
        expect(byStory("DIPO-6")?.blocks).toEqual([StoryId.parse("DIPO-20")]);
        expect(byStory("DIPO-4")?.blocks).toEqual([]);
        expect(items[0]).toMatchObject({
          question: "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1A",
          detail: '"Keep the old flag?" · worker waiting',
          since: new Date(base + 2 * HOUR).toISOString(),
          actions: [
            {
              command: "work.answer",
              cli: 'dipo answer qst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1A --text "<answer>"',
            },
          ],
        });
        expect(byStory("DIPO-3", "MERGE")).toMatchObject({
          gate: "gat_01J9ZK5Q8W3V4X6Y7Z8A9B0C1C",
          pr: { number: 12, url: "https://github.com/o/r/pull/12", state: "open" },
          detail: "merge.autoMerge is off: approve or reject the merge",
          actions: [
            { command: "gate.approve", cli: "dipo approve DIPO-3" },
            { command: "gate.reject", cli: 'dipo reject DIPO-3 --note "<why>"' },
          ],
        });
        expect(byStory("DIPO-4")?.actions.map((action) => action.cli)).toEqual([
          'dipo answer qst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D --text "<answer>"',
          'dipo resume DIPO-4 --note "<answer>"',
        ]);
        expect(byStory("DIPO-7")).toMatchObject({
          reason: "budget-exceeded",
          actions: [
            { command: "work.resume", cli: 'dipo resume DIPO-7 --budget +50% --note "<why>"' },
          ],
        });
        expect(byStory("DIPO-5", "PARKED BY YOU")?.actions).toEqual([
          { command: "work.resume", cli: "dipo resume DIPO-5" },
        ]);
        expect(items.find((item) => item.kind === "BACKLOG PR")).toMatchObject({
          pr: { number: 40 },
          detail: '#40 "chore: x" · its check failed: DIPO-12 changed a field by hand',
          actions: [],
          hand: expect.stringContaining("by hand on GitHub"),
        });
        expect(
          items.filter((item) => item.kind === "PROPOSAL").map((item) => item.proposal?.kind),
        ).toEqual(["spike", "follow-up", "decision-note"]);
        expect(byStory("DIPO-9", "PARKED BY YOU")).toMatchObject({
          reason: "by-maintainer",
          detail: "after M2",
          actions: [{ command: "work.resume", cli: "dipo resume DIPO-9" }],
        });
      } finally {
        t.state.close();
      }
    }));
});

describe("review-blocked parks and hand-merge-only gates", () => {
  it("gives a review-blocked park one row with resume and approve, and its gate no MERGE row", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const office = addOffice(t);
        pass(t, office, [task("DIPO-1", { status: "In Progress" })]);
        const started = startRun(t, office, "DIPO-1", dir);
        const at = t.clock.now();
        insertPark(office, "DIPO-1", {
          reason: "review-blocked",
          detail: "round 3 blocked: scope finding in a.ts",
          at,
          run: started.run,
        });
        insertMergeGate(office, {
          id: "gat_01J9ZK5Q8W3V4X6Y7Z8A9B0C1C",
          key: started.key,
          run: started.run,
          summary: "blocking findings: scope finding in a.ts",
          at,
        });
        const items = desk(office, all, ALL_SOURCES);
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
          kind: "PARKED",
          story: "DIPO-1",
          reason: "review-blocked",
          gate: "gat_01J9ZK5Q8W3V4X6Y7Z8A9B0C1C",
          actions: [
            { command: "work.resume", cli: 'dipo resume DIPO-1 --note "<direction>"' },
            { command: "gate.approve", cli: 'dipo approve DIPO-1 --note "<why>"' },
          ],
        });
      } finally {
        t.state.close();
      }
    }));

  // DIPO-309: the desk row of a story waiting on its test offers `dipo test <ID>`, and the record
  // of its open test once one runs.
  it("offers dipo test on a gate that waits on the story's test, then pass and fail", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const office = addOffice(t);
        pass(t, office, [task("DIPO-1", { status: "In Review" })]);
        const started = startRun(t, office, "DIPO-1", dir);
        const at = t.clock.now();
        insertStoryPr(office, { key: started.key, run: started.run, number: 7, at });
        insertMergeGate(office, {
          id: "gat_01J9ZK5Q8W3V4X6Y7Z8A9B0C1C",
          key: started.key,
          run: started.run,
          summary: "No test is recorded for abc.",
          at,
        });
        office.immediate(() =>
          office.run(`update gates set waits = '["testBeforeMerge"]' where office_id = $office_id`),
        );
        const clis = () => desk(office, all, ALL_SOURCES)[0]?.actions.map((action) => action.cli);
        expect(clis()).toEqual([
          "dipo test DIPO-1",
          "dipo approve DIPO-1",
          'dipo reject DIPO-1 --note "<why>"',
        ]);
        office.immediate(() =>
          insertTest(office, {
            testId: "tst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D",
            key: started.key,
            runId: started.run,
            head: "abc",
            box: "dipo-tst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D",
            steps: [{ check: "Open it" }],
            at,
          }),
        );
        expect(clis()?.slice(0, 2)).toEqual([
          "dipo test pass DIPO-1",
          'dipo test fail DIPO-1 --note "<what failed>"',
        ]);
      } finally {
        t.state.close();
      }
    }));

  it("offers a gate whose PR is labelled autorelease: pending only a hand merge", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const office = addOffice(t);
        pass(t, office, [task("DIPO-1", { status: "In Review" })]);
        const started = startRun(t, office, "DIPO-1", dir);
        const at = t.clock.now();
        insertStoryPr(office, { key: started.key, run: started.run, number: 7, at });
        insertMergeGate(office, {
          id: "gat_01J9ZK5Q8W3V4X6Y7Z8A9B0C1C",
          key: started.key,
          run: started.run,
          summary: "the PR carries a hold label",
          at,
        });
        const seen: string[] = [];
        const items = desk(office, all, {
          ...ALL_SOURCES,
          handMergeOnly: (_office, gate) => {
            seen.push(gate.gate);
            return true;
          },
        });
        expect(seen).toEqual(["gat_01J9ZK5Q8W3V4X6Y7Z8A9B0C1C"]);
        expect(items).toHaveLength(1);
        expect(items[0]?.kind).toBe("MERGE");
        expect(items[0]?.actions).toEqual([]);
        expect(items[0]?.actions.some((action) => action.command === "gate.approve")).toBe(false);
        expect(items[0]?.hand).toBe(
          "merge PR #7 (https://github.com/o/r/pull/7) by hand on GitHub: it is labelled autorelease: pending, so dipo never approves it",
        );
      } finally {
        t.state.close();
      }
    }));

  it("offers discard for a park that is never resumable, and the resume the 0020 table allows", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const office = addOffice(t);
        pass(t, office, [
          task("DIPO-1", { status: "Parked" }),
          task("DIPO-2", { status: "Parked" }),
        ]);
        const at = t.clock.now();
        insertPark(office, "DIPO-1", {
          reason: "scope-violation",
          detail: "links",
          at,
        });
        insertPark(office, "DIPO-2", {
          reason: "verify-failing",
          detail: "red",
          at,
        });
        // verify-failing ranks before scope-violation (0020), and resumes with nothing more.
        expect(
          desk(office, all, { ...DESK_SOURCES, stories: backlogLayout }).map(
            (item) => item.actions,
          ),
        ).toEqual([
          [{ command: "work.resume", cli: "dipo resume DIPO-2" }],
          [{ command: "work.discard", cli: 'dipo discard DIPO-1 --note "<why>"' }],
        ]);
      } finally {
        t.state.close();
      }
    }));
});

// Terminal sequences in stored text (a worker's question, a park detail) never reach the desk.
const ESC_CLEAR = "\u001b[2J";
const OSC_TITLE = "\u001b]0;owned\u0007";
const OSC_LINK = "\u001b]8;;https://example.com\u001b\\";

describe("stored text on the desk", () => {
  it("removes escape and OSC sequences, controls and bidi overrides, and caps the detail", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const office = addOffice(t);
        pass(t, office, [
          task("DIPO-1", { status: "In Progress" }),
          task("DIPO-2", { status: "Parked" }),
          task("DIPO-3", { status: "Parked" }),
        ]);
        const started = startRun(t, office, "DIPO-1", dir);
        const at = t.clock.now();
        office.immediate(() =>
          office.run(
            `insert into questions (office_id, question_id, run_id, agent_id, kind, text, tool,
               input, asked_at)
             values ($office_id, 'qst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1A', $run, $agent, 'permission',
               $text, 'Bash', 'curl', $at)`,
            {
              run: started.run,
              agent: started.agent,
              text: `Bash(${ESC_CLEAR}curl${OSC_TITLE} ‮example.com\u0007)`,
              at,
            },
          ),
        );
        insertPark(office, "DIPO-2", {
          reason: "worker-failed",
          detail: `stopped${ESC_CLEAR} by${OSC_LINK} the\r\nmaintainer\u009b2J`,
          at,
        });
        insertPark(office, "DIPO-3", {
          reason: "worker-failed",
          detail: "x".repeat(1000),
          at: at + 1,
        });
        const items = desk(office, all, ALL_SOURCES);
        expect(items.map((item) => item.detail)).toEqual([
          '"Bash(curl example.com)" · worker waiting',
          "stopped by the maintainer",
          `${"x".repeat(DESK_DETAIL_MAX - 1)}…`,
        ]);
        for (const item of items) {
          // oxlint-disable-next-line no-control-regex -- the characters the desk must never show
          expect(item.detail).not.toMatch(/[\u0000-\u001f\u007f-\u009f‪-‮]/u);
          expect(Array.from(item.detail).length).toBeLessThanOrEqual(DESK_DETAIL_MAX);
        }
      } finally {
        t.state.close();
      }
    }));

  it("cleans and caps a text the same way when called alone", () => {
    expect(deskText(`a${ESC_CLEAR}\n\tb${OSC_TITLE}`)).toBe("a b");
    expect(deskLine("y".repeat(DESK_DETAIL_MAX))).toBe("y".repeat(DESK_DETAIL_MAX));
    expect(deskLine("y".repeat(DESK_DETAIL_MAX + 1))).toBe(`${"y".repeat(DESK_DETAIL_MAX - 1)}…`);
  });
});

describe("the parks the merge slot makes (DIPO-324, DIPO-344)", () => {
  it("offer dipo resume with nothing more for a conflict and a closed PR", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const office = addOffice(t);
        const parks = [
          ["DIPO-1", "conflict", "git cannot merge main cleanly in .github/ci.yml"],
          ["DIPO-2", "by-maintainer", "PR #7 closed on GitHub"],
        ] as const;
        pass(
          t,
          office,
          parks.map(([story]) => task(story, { status: "Parked" })),
        );
        const at = t.clock.now();
        for (const [story, reason, detail] of parks)
          insertPark(office, story, { reason, detail, at });
        const items = desk(office, all, { ...DESK_SOURCES, stories: backlogLayout });
        const itemOf = (story: string) => items.find((item) => item.story === story);
        expect(itemOf("DIPO-1")).toMatchObject({
          kind: "PARKED",
          detail: "git cannot merge main cleanly in .github/ci.yml",
          actions: [{ command: "work.resume", cli: "dipo resume DIPO-1" }],
        });
        expect(itemOf("DIPO-2")).toMatchObject({
          kind: "PARKED BY YOU",
          actions: [{ command: "work.resume", cli: "dipo resume DIPO-2" }],
        });
      } finally {
        t.state.close();
      }
    }));
});

function directory(office: OfficeHandle): OfficeDirectory {
  return {
    get: (id) => (id === office.officeId ? office : undefined),
    load: async () => ({ ok: true, office }),
  };
}

async function readDesk(t: TestState, office: OfficeHandle): Promise<DeskItem[]> {
  const reply = await executeRead(
    { registry: buildRegistry([viewsFeature]), offices: directory(office), clock: t.clock },
    {
      requestId: RequestId.parse("01J9ZK5Q8W3V4X6Y7Z00000001"),
      name: "office.desk",
      args: { office: office.officeId },
    },
  );
  if (!reply.ok) throw new Error(`office.desk failed: ${reply.error.code} ${reply.error.message}`);
  return reply.result as DeskItem[];
}

describe("the office.desk read", () => {
  it("returns an empty desk for an office with nothing waiting", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const office = addOffice(t);
        pass(t, office, [task("DIPO-1", { status: "Ready" })]);
        expect(await readDesk(t, office)).toEqual([]);
      } finally {
        t.state.close();
      }
    }));

  it("lists a decision note with its file, section and text, and offers only shipped commands", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const office = addOffice(t);
        pass(t, office, [task("DIPO-9", { status: "In Review" })]);
        const key = keyOf(office, "DIPO-9");
        const run = RunId.parse("run_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D");
        const at = t.clock.now();
        office.immediate(() => {
          storeDecisionNotes(office, {
            key,
            runId: run,
            notes: [
              {
                file: "docs/decisions/0019-review-loop.md",
                section: "4. The reviewer session",
                text: "The reviewer also reads the worker's deviations.",
              },
            ],
            at,
          });
          storeProposals(office, {
            key,
            runId: run,
            proposals: [{ kind: "follow-up", title: "Split it", outcome: "split", why: "size" }],
            at: at + 1,
          });
        });
        const items = await readDesk(t, office);
        expect(items).toEqual([
          {
            kind: "PROPOSAL",
            story: StoryId.parse("DIPO-9"),
            key,
            proposal: {
              id: expect.stringMatching(/^[0-9a-f]{64}$/),
              kind: "follow-up",
              title: "Split it",
              run,
            },
            detail: `follow-up "Split it" · split Why: size · from ${run}`,
            since: new Date(at + 1).toISOString(),
            blocks: [],
            // proposal.accept and proposal.dismiss are not registered in this engine yet.
            actions: [],
          },
          {
            kind: "PROPOSAL",
            story: StoryId.parse("DIPO-9"),
            key,
            proposal: {
              id: expect.stringMatching(/^[0-9a-f]{64}$/),
              kind: "decision-note",
              title: "Decision note for docs/decisions/0019-review-loop.md",
              run,
            },
            detail:
              'decision note · docs/decisions/0019-review-loop.md, section "4. The reviewer session": The reviewer also reads the worker\'s deviations.',
            since: new Date(at).toISOString(),
            blocks: [],
            actions: [],
            hand: "dipo never writes decision records: add the note by hand if you agree",
          },
        ]);
      } finally {
        t.state.close();
      }
    }));
});

describe("a review-blocked park whose PR is labelled autorelease: pending", () => {
  it("offers resume and the hand merge, and no dipo approve", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const office = addOffice(t);
        pass(t, office, [task("DIPO-1", { status: "In Progress" })]);
        const started = startRun(t, office, "DIPO-1", dir);
        const at = t.clock.now();
        insertPark(office, "DIPO-1", {
          reason: "review-blocked",
          detail: "round 3 blocked",
          at,
          run: started.run,
        });
        insertStoryPr(office, { key: started.key, run: started.run, number: 9, at });
        insertMergeGate(office, {
          id: "gat_01J9ZK5Q8W3V4X6Y7Z8A9B0C1C",
          key: started.key,
          run: started.run,
          summary: "blocking findings",
          at,
        });
        const seen: string[] = [];
        const items = desk(office, all, {
          ...ALL_SOURCES,
          handMergeOnly: (_office, gate) => {
            seen.push(gate.gate);
            return true;
          },
        });
        expect(seen).toEqual(["gat_01J9ZK5Q8W3V4X6Y7Z8A9B0C1C"]);
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
          kind: "PARKED",
          reason: "review-blocked",
          gate: "gat_01J9ZK5Q8W3V4X6Y7Z8A9B0C1C",
          actions: [{ command: "work.resume", cli: 'dipo resume DIPO-1 --note "<direction>"' }],
          hand: "merge PR #9 (https://github.com/o/r/pull/9) by hand on GitHub: it is labelled autorelease: pending, so dipo never approves it",
        });
      } finally {
        t.state.close();
      }
    }));
});

/** `office.desk` with `work.discard` registered, as the daemon's registry has it. */
async function readWithDiscard(t: TestState, office: OfficeHandle): Promise<DeskItem[]> {
  const discard = new StoryDiscard({
    lane: () => undefined,
    git: () => undefined,
    host: { closePr: async () => {} },
    probe: async () => null,
  });
  const reply = await executeRead(
    {
      registry: buildRegistry([viewsFeature, discard.feature]),
      offices: directory(office),
      clock: t.clock,
    },
    {
      requestId: RequestId.parse("01J9ZK5Q8W3V4X6Y7Z00000002"),
      name: "office.desk",
      args: { office: office.officeId },
    },
  );
  if (!reply.ok) throw new Error(`office.desk failed: ${reply.error.code}`);
  return reply.result as DeskItem[];
}

describe("the desk shows a story Done elsewhere (DIPO-161)", () => {
  it("lists a LEFTOVERS row with the dipo discard action, and a DONE ELSEWHERE row while the worker runs", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const office = addOffice(t);
        pass(t, office, [
          task("DIPO-105", { status: "Done" }),
          task("DIPO-106", { status: "Done" }),
        ]);
        office.immediate(() => {
          office.run(
            `insert into done_elsewhere (office_id, run_id, key, story_id, branch, base,
               base_commit, released_at, settled_at, branch_kept, commits)
             values ($office_id, 'run_1', $key, 'DIPO-105', 'DIPO-105/x', 'main',
               'a1b2c3d4e5f6a7b8', 2, 3, 1, '[{"sha":"abc1234","subject":"wip"}]')`,
            { key: keyOf(office, "DIPO-105") },
          );
          office.run(
            `insert into done_elsewhere (office_id, run_id, key, story_id, branch, base,
               flagged_at)
             values ($office_id, 'run_2', $key, 'DIPO-106', 'DIPO-106/x', 'main', 4)`,
            { key: keyOf(office, "DIPO-106") },
          );
        });

        const items = await readWithDiscard(t, office);

        expect(rows(items)).toEqual(["LEFTOVERS DIPO-105", "DONE ELSEWHERE DIPO-106"]);
        expect(items[0]?.actions).toEqual([
          { command: "work.discard", cli: 'dipo discard DIPO-105 --note "<why>"' },
        ]);
        expect(items[0]?.detail).toContain("1 commit not on main");
      } finally {
        t.state.close();
      }
    }));
});

describe("a worker question waiting on the desk (DIPO-159; 0020 section 7)", () => {
  const MINUTE = 60_000;

  it("shows the time left on its wait through office.desk, and its end", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const office = addOffice(t);
        pass(t, office, [task("DIPO-1", { status: "In Progress" })]);
        const started = startRun(t, office, "DIPO-1", dir);
        const at = t.clock.now();
        office.immediate(() =>
          insertWorkerQuestion(office, {
            questionId: "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1A",
            runId: started.run,
            agentId: started.agent,
            text: "Which port?",
            at,
            waitUntil: at + 15 * MINUTE,
          }),
        );
        t.clock.advance(3 * MINUTE + 30_000);
        expect((await readDesk(t, office)).map((item) => item.detail)).toEqual([
          '"Which port?" · worker waiting, 12 min left',
        ]);
        t.clock.advance(11 * MINUTE);
        expect((await readDesk(t, office))[0]?.detail).toBe(
          '"Which port?" · worker waiting, 1 min left',
        );
        t.clock.advance(MINUTE);
        expect((await readDesk(t, office))[0]?.detail).toBe(
          '"Which port?" · worker waiting, its wait is over',
        );
        // A desk built with no time shows none.
        expect(desk(office, all, ALL_SOURCES)[0]?.detail).toBe('"Which port?" · worker waiting');
      } finally {
        t.state.close();
      }
    }));

  it("keeps the time left whole when a long question is cut, and offers dipo answer --text", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const office = addOffice(t);
        pass(t, office, [task("DIPO-1", { status: "In Progress" })]);
        const started = startRun(t, office, "DIPO-1", dir);
        const at = t.clock.now();
        office.immediate(() =>
          insertWorkerQuestion(office, {
            questionId: "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1A",
            runId: started.run,
            agentId: started.agent,
            text: "q".repeat(1000),
            at,
            waitUntil: at + 15 * MINUTE,
          }),
        );
        const [item] = desk(office, all, ALL_SOURCES, at);
        expect(item?.detail.endsWith('…" · worker waiting, 15 min left')).toBe(true);
        expect(Array.from(item?.detail ?? "").length).toBeLessThanOrEqual(DESK_DETAIL_MAX);
        expect(item?.actions).toEqual([
          {
            command: "work.answer",
            cli: 'dipo answer qst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1A --text "<answer>"',
          },
        ]);
      } finally {
        t.state.close();
      }
    }));

  it("puts a question park's question on its PARKED row with dipo answer --text and dipo resume --note", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const office = addOffice(t);
        pass(t, office, [task("DIPO-2", { status: "Parked" })]);
        const started = startRun(t, office, "DIPO-2", dir);
        const at = t.clock.now();
        const parkId = insertPark(office, "DIPO-2", {
          reason: "ambiguous-spec",
          detail: "Which port?",
          at,
          run: started.run,
        });
        office.immediate(() =>
          insertWorkerQuestion(office, {
            questionId: "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1B",
            runId: started.run,
            agentId: started.agent,
            text: "Which port?",
            at,
            parkId,
          }),
        );
        const items = desk(office, all, { ...DESK_SOURCES, stories: backlogLayout }, at);
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
          kind: "PARKED",
          reason: "ambiguous-spec",
          actions: [
            {
              command: "work.answer",
              cli: 'dipo answer qst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1B --text "<answer>"',
            },
            { command: "work.resume", cli: 'dipo resume DIPO-2 --note "<answer>"' },
          ],
        });
      } finally {
        t.state.close();
      }
    }));
});

describe("the office's starts paused on the desk (0020, DIPO-359)", () => {
  it("comes first, with its reason, what lifts it and dipo daemon resume-scheduling", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const office = addOffice(t);
        pass(t, office, [task("DIPO-1", { status: "Parked" })]);
        const at = t.clock.now();
        insertPark(office, "DIPO-1", { reason: "worker-failed", detail: "plan limit until X", at });
        t.clock.advance(HOUR);
        const sources: DeskSources = {
          stories: backlogLayout,
          ...DESK_SOURCES,
          startsPaused: () => ({
            reason: "plan-limit",
            detail: "plan limit until 2026-10-28T12:00:00.000Z",
            since: at,
            until: at + 2 * HOUR,
            lifts:
              "It lifts by itself at 2026-10-28T12:02:00.000Z, or with `dipo daemon resume-scheduling`.",
          }),
        };
        const items = desk(office, all, sources);
        expect(items.map((item) => item.kind)).toEqual(["STARTS PAUSED", "PARKED"]);
        expect(items[0]).toEqual({
          kind: "STARTS PAUSED",
          detail: "no new session starts · plan limit until 2026-10-28T12:00:00.000Z",
          since: new Date(at).toISOString(),
          blocks: [],
          actions: [{ command: "daemon.resumeScheduling", cli: "dipo daemon resume-scheduling" }],
          hand: "It lifts by itself at 2026-10-28T12:02:00.000Z, or with `dipo daemon resume-scheduling`.",
        });

        const adapter = desk(office, all, {
          stories: backlogLayout,
          ...DESK_SOURCES,
          startsPaused: () => ({
            reason: "adapter",
            detail: "claude-cli: probe: claude is not logged in.",
            since: at,
            until: null,
            lifts: "Fix it, then name the story to repeat the launch checks (`dipo run <ID>`).",
          }),
        });
        expect(adapter[0]?.detail).toBe(
          "no new session starts · adapter check failed: claude-cli: probe: claude is not logged in.",
        );
        // The box token's hold: no command lifts it, so the row offers none (DIPO-271).
        const sticky = desk(office, all, {
          stories: backlogLayout,
          ...DESK_SOURCES,
          startsPaused: () => ({
            reason: "adapter",
            detail: "claude-cli: box-token: the token was found in a box.",
            since: at,
            until: null,
            lifts: "Replace the box login with dipo login box.",
            hold: {
              adapter: "claude-cli",
              check: "box-token",
              detail: "the token was found in a box",
              failures: [{ check: "box-token", detail: "the token was found in a box" }],
              since: at,
              liftedBy: "Replace the box login with dipo login box.",
            },
          }),
        });
        expect(sticky[0]).toMatchObject({
          actions: [],
          hand: "Replace the box login with dipo login box.",
        });
        // Nothing paused: no such item.
        expect(
          desk(office, all, { ...DESK_SOURCES, stories: backlogLayout }).map((item) => item.kind),
        ).toEqual(["PARKED"]);
      } finally {
        t.state.close();
      }
    }));
});

describe("a stuck planning lane on the desk (DIPO-401)", () => {
  it("is a hand action with the lane's reason once an operation waits 30 minutes, and none before", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const office = addOffice(t);
        const at = t.clock.now();
        office.immediate(() =>
          insertEntry(office, { kind: "propose", subject: "DIPO-300", target: {} }, at),
        );
        const sources: DeskSources = {
          stories: backlogLayout,
          ...DESK_SOURCES,
          officeItems: (handle, now) =>
            laneDeskItems(handle, { reason: "the backlog branch waits: push failed", at }, now),
        };
        expect(desk(office, all, sources, at + LANE_STUCK_MS - 1)).toEqual([]);
        // Without the time of the read there is no such item.
        expect(desk(office, all, sources)).toEqual([]);
        expect(desk(office, all, sources, at + LANE_STUCK_MS + 60_000)).toEqual([
          {
            kind: "PLANNING LANE",
            detail:
              "the planning lane is stuck: 1 backlog operation waits for a backlog PR, the oldest for 31 minutes · the backlog branch waits: push failed",
            since: new Date(at).toISOString(),
            blocks: [],
            actions: [],
            hand: "fix what the reason names; dipo applies the operations at the next backlog change or office load, and the daemon log has a line for each flush that stops",
          },
        ]);
      } finally {
        t.state.close();
      }
    }));
});
