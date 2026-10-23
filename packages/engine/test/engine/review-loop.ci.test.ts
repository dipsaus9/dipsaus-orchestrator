// CI only (0017 section 1): the review loop end to end at the engine layer (DIPO-153; 0019
// section 1 across sections 3 to 13, for box runs as 0021 and its amendment of 2026-10-22 have
// them). Each scenario claims TASK-1 with `work.run` on an office wired as the daemon wires it
// (`loop-office.ts`): a scripted developer and reviewer, the in-memory code host, real git with a
// bare remote under DIPO_TMP and the pinned Backlog CLI. CI is the verify of a box run, so dipo runs
// none: the host's required checks decide. The scenarios:
//
// - approve and merge: one review round approves the In Review head, CI is green, the merge gate
//   is decided by rule, and the merge slot closes out, pushes once and squash-merges at the head
//   it pushed, with the PR title as subject;
// - blocked then fixed: a blocking correctness finding at a changed line is one fix round; the
//   next head gets a second round, which approves;
// - a blocking security finding, the same way;
// - red CI then green: the failed job's log tail goes back to the worker in one fix round;
// - a conflict hand-off: the base moved with a conflicting change while the story waited, the
//   slot commits its merge as git left it and hands the conflict to the worker, whose resolution
//   gets a review round of its own before the merge;
// - a merge gate the maintainer approves: a criterion only the maintainer can check;
// - an override of a review-blocked park: a round cap of 1 parks the story, `gate.approve` needs a
//   note and records the override, and the PR merges with no session;
// - a review running next to a working developer session of another story (0019 section 12);
// - a daemon restart while the story is in the merge slot: the slot continues with the same
//   occupant and merges once, and after the restart's re-attach the Done poll ends the run done;
// - the park and resume path: red CI at a CI cap of 1 parks `verify-failing` (cause `ci`), and
//   `work.resume` with a note grants one CI attempt and sends the CI item to the worker.
//
// One scenario is `it.failing`: it states what 0019 and 0021 promise and the engine does not do
// yet, and becomes a plain `it` in the story that closes it:
//
// - the merge slot's conflict merge is made in dipo's repository and never reaches the box, so
//   the worker never sees the markers and its next part, taken against the merged tip, reverts what
//   the base changed (here a file the base added is gone from main after the merge); DIPO-324.
//
// The Done poll ending a merged story without a restart was such a scenario until DIPO-328.
//
// Each scenario needs many CLI calls, pushes and an office load: far over the local budget.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { type RunId, type StoryKey } from "@dipsaus-orchestrator/contract";
import { git } from "@dipsaus-orchestrator/testkit";

import { mergeGatesOfRun, slotOccupant } from "../../src/merge-slot";
import { reviewVerdictsOf } from "../../src/review/store";
import { findRun, openPark } from "../../src/run";
import { findStoryPr } from "../../src/story-pr";
import type { ReviewReport, WorkerReport } from "../../src/workers/types";
import { findClaim } from "../../src/worktree/records";
import { otherClone } from "../backlog/lane/helpers";
import { backlog, publish } from "../gate/gated-office";

import { GREEN_CHECKS, PENDING_CHECKS, RED_CHECKS } from "./loop-host";
import {
  APPROVE,
  BRANCH_1,
  devScript,
  type LoopWorld,
  reviewScript,
  type Session,
  startStory,
  TASK_1,
  TASK_FILE_1,
  withLoopOffice,
} from "./loop-office";

const CSV = "packages/export/csv.ts";
const CSV_V1 = 'export const header = "id,title";\nexport const row = (id: string) => id;\n';
const ROW_V1 = "export const row = (id: string) => id;";
const CSV_V2 =
  'export const header = "id,title";\nexport const row = (id: string, title: string) => `${id},${title}`;\n';
const ROW_V2 = "export const row = (id: string, title: string) => `${id},${title}`;";
const CSV_V3 =
  'export const header = "id,title";\nexport const row = (id: string, title: string) => `${id},${title.replace(/^[=+@-]/, "\'$&")}`;\n';
const TITLE = "feat(TASK-1): add the CSV export command";
const NOTES = "docs/export.md";
const NOTES_TEXT = "# Export\n\nThe export writes semicolons.\n";

const TASK_4 = "TASK-4";
const TSV = "packages/tsv/tsv.ts";
const TSV_DESCRIPTION = [
  "Outcome: maintainers can export the story list as TSV for a spreadsheet.",
  "",
  "```dipo",
  'branch: "TASK-4/add-the-tsv-export-command"',
  "unknowns: []",
  "test_plan:",
  "  entries:",
  '    - kind: "automated"',
  '      check: "(unit) one TSV row per story, header first"',
  "```",
].join("\n");
const TSV_DONE: WorkerReport = {
  status: "done",
  criteria: [{ n: 1, met: true, evidence: "packages/tsv/tsv.ts writes one row per story" }],
  summary: "The export command writes the stories as TSV.",
  commitSubject: "add the TSV export command",
  testPlan: [{ n: 1, status: "done", evidence: "packages/tsv/tsv.test.ts checks the rows" }],
};
const TSV_APPROVE: ReviewReport = {
  criteria: [{ n: 1, status: "met", evidence: "packages/tsv/tsv.ts:1 writes one row per story" }],
  findings: [],
  summary: "One TSV row per story.",
};

/** Criterion #2 is one only the maintainer can check; the review itself approves. */
const MAINTAINER_CHECK: ReviewReport = {
  ...APPROVE,
  criteria: [
    APPROVE.criteria[0] ?? { n: 1, status: "met", evidence: "" },
    { n: 2, status: "maintainer", evidence: "Opening the file in a spreadsheet is a hand check." },
  ],
};

function writeFile(session: Pick<Session, "cwd">, path: string, text: string): void {
  const file = join(session.cwd, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
}

/** A blocking finding of `kind` at line 2 of the CSV file, quoting `quote`, and an advisory one. */
function blocked(kind: "correctness" | "security", quote: string, text: string): ReviewReport {
  return {
    ...APPROVE,
    findings: [
      { severity: "blocking", kind, file: CSV, line: 2, quote, text },
      { severity: "advisory", kind: "maintainability", text: "name the row helper rowOf." },
    ],
    summary: `One blocking ${kind} finding.`,
  };
}

const keyOf = (w: LoopWorld, run: RunId): StoryKey => findRun(w.office, run)?.key as StoryKey;
const verdicts = (w: LoopWorld, run: RunId) =>
  reviewVerdictsOf(w.office, keyOf(w, run)).map((v) => [v.round, v.verdict]);
const merged = (w: LoopWorld, count = 1) => w.host.merges.length >= count;
const kinds = (w: LoopWorld) => w.sessions.map((s) => [s.kind, s.n]);

async function remoteFile(w: LoopWorld, ref: string, path: string): Promise<string> {
  return git(w.repo.remote, w.repo.home, "show", `${ref}:${path}`);
}

async function remoteSubjects(w: LoopWorld, ref: string, count: number): Promise<string[]> {
  const log = await git(w.repo.remote, w.repo.home, "log", "--format=%s", "-n", String(count), ref);
  return log.trim().split("\n");
}

/**
 * The PR of TASK-1 merged once by the slot: one squash merge at the branch's pushed tip with the
 * PR title as subject, the tip the close-out commit (status Done, the final summary), `csv` on
 * main, the slot free, and the PR poll sees the PR merged.
 */
async function expectMergedOnce(
  w: LoopWorld,
  run: RunId,
  csv: string,
  head?: string,
): Promise<void> {
  // The Done teardown deletes the branch after the merge, so its tip is read from the merge call.
  const tip = head ?? w.host.merges[0]?.headSha ?? "";
  expect(tip).not.toBe("");
  expect(w.host.merges).toEqual([{ number: 1, headSha: tip, subject: TITLE }]);
  expect((await remoteSubjects(w, tip, 1))[0]).toBe(`${TASK_1}: status Done`);
  expect(await remoteFile(w, "main", CSV)).toBe(csv);
  const task = await remoteFile(w, "main", TASK_FILE_1);
  expect(task).toContain("status: Done");
  expect(task).toContain("Final Summary");
  expect(slotOccupant(w.office)).toBeNull();
  await w.until("the PR poll sees the merge", () => findStoryPr(w.office, run)?.state === "merged");
}

/** The notice codes the office raised, in order. */
function noticeCodes(w: LoopWorld): string[] {
  return w.office
    .all<{ delta: string }>(
      "select delta from change_log where office_id = $office_id and type = 'engine.notice' order by seq",
    )
    .map((row) => (JSON.parse(row.delta) as { code: string }).code);
}

function parks(w: LoopWorld) {
  return w.office.all<{ reason: string; cause: string | null; resolved_how: string | null }>(
    "select reason, cause, resolved_how from parks where office_id = $office_id order by park_id",
  );
}

/** Lets the engine's polls run `count` more times. */
async function polls(w: LoopWorld, count: number): Promise<void> {
  let n = 0;
  await w.until(`${count} polls`, () => ++n > count);
}

/** The approve scenario's director: CSV_V1, then an approving review. */
function approving(w: LoopWorld): void {
  w.director = (session) => {
    if (session.kind === "review") return reviewScript(session.n, APPROVE);
    writeFile(session, CSV, CSV_V1);
    return devScript(session.n);
  };
}

/**
 * The conflict scenario up to the merge: while round 1 reviews, the base gets a conflicting change
 * to the CSV file and a new notes file; the worker's second session resolves the file.
 */
async function conflictHandOff(w: LoopWorld): Promise<{ run: RunId; markers: string }> {
  let markers = "";
  w.director = async (session) => {
    if (session.kind === "review") {
      if (session.n === 1) {
        const other = await otherClone(w.repo);
        writeFile({ cwd: other }, CSV, 'export const header = "id;title";\n');
        writeFile({ cwd: other }, NOTES, NOTES_TEXT);
        await git(other, w.repo.home, "add", CSV, NOTES);
        await git(other, w.repo.home, "commit", "--quiet", "-m", "semicolons");
        await git(other, w.repo.home, "push", "--quiet", "origin", "HEAD:main");
      }
      return reviewScript(session.n, APPROVE);
    }
    // What the worker finds in its box when its conflict fix round starts.
    if (session.n === 2) markers = readFileSync(join(session.cwd, CSV), "utf8");
    writeFile(session, CSV, session.n === 1 ? CSV_V1 : CSV_V2);
    return devScript(session.n);
  };
  const run = await startStory(w, TASK_1);
  await w.until("the merge", () => merged(w));
  return { run, markers };
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("the review loop end to end", () => {
    it(
      "approve and merge",
      () =>
        withLoopOffice({}, async (w) => {
          approving(w);
          const run = await startStory(w, TASK_1);
          await w.until("the merge", () => merged(w));

          expect(kinds(w)).toEqual([
            ["implement", 1],
            ["review", 1],
          ]);
          // The PR opened ready at the first In Review push, with the title built from the story.
          expect(w.host.calls.slice(0, 2)).toEqual([
            `find ${BRANCH_1}`,
            `create ${BRANCH_1}: ${TITLE}`,
          ]);
          // The reviewer reviewed the In Review head; its round's report is posted on the PR.
          const [verdict] = reviewVerdictsOf(w.office, keyOf(w, run));
          expect(verdict).toMatchObject({ round: 1, verdict: "approved" });
          expect((await remoteSubjects(w, verdict?.commit ?? "", 2)).toReversed()).toEqual([
            "add the CSV export command",
            `${TASK_1}: status In Review`,
          ]);
          await w.until("the round's comment", () => w.host.comments.length === 1);
          expect(w.host.comments[0]?.body).toContain(
            "### dipo review, round 1 of the story: approved",
          );
          // The merge gate of the head was decided by rule (autoMerge, nothing waits).
          expect(
            mergeGatesOfRun(w.office, run).map((g) => [
              g.waitingOn,
              g.decision?.decision,
              g.decision?.by,
            ]),
          ).toEqual([["rule", "approved", "rule"]]);
          await expectMergedOnce(w, run, CSV_V1);
          expect(parks(w)).toEqual([]);
        }),
      120_000,
    );

    it(
      "the Done poll ends a merged story's run without a daemon restart (DIPO-328)",
      () =>
        withLoopOffice({}, async (w) => {
          approving(w);
          const run = await startStory(w, TASK_1);
          await w.until("the merge", () => merged(w));
          await w.until("Done", () => findRun(w.office, run)?.endKind === "done", 40);
        }),
      120_000,
    );

    for (const [name, kind, quote, text, versions] of [
      [
        "blocked then fixed",
        "correctness",
        ROW_V1,
        "row drops the title, so each CSV row has one column of two.",
        [CSV_V1, CSV_V2],
      ],
      [
        "a blocking security finding",
        "security",
        ROW_V2,
        "a title that starts with = is written as is, so a spreadsheet runs it as a formula.",
        [CSV_V2, CSV_V3],
      ],
    ] as const) {
      it(
        name,
        () =>
          withLoopOffice({}, async (w) => {
            w.director = (session) => {
              if (session.kind === "review") {
                return reviewScript(
                  session.n,
                  session.n === 1 ? blocked(kind, quote, text) : APPROVE,
                );
              }
              writeFile(session, CSV, versions[session.n - 1] ?? "");
              return devScript(session.n);
            };
            const run = await startStory(w, TASK_1);
            await w.until("the merge", () => merged(w));

            expect(kinds(w)).toEqual([
              ["implement", 1],
              ["review", 1],
              ["implement", 2],
              ["review", 2],
            ]);
            expect(verdicts(w, run)).toEqual([
              [1, "blocked"],
              [2, "approved"],
            ]);
            // One fix round: the story went back to In Progress, and the developer's next session
            // got the blocking finding with its place and quote, the advisory one as optional.
            const fix = w.sessions[2]?.message ?? "";
            expect(fix).toContain(text);
            expect(fix).toContain(`${CSV}:2`);
            expect(fix).toContain(quote);
            expect(fix).toContain("name the row helper rowOf.");
            const [first, second] = reviewVerdictsOf(w.office, keyOf(w, run));
            expect(await remoteSubjects(w, second?.commit ?? "", 4)).toEqual([
              `${TASK_1}: status In Review`,
              "add the CSV export command",
              `${TASK_1}: status In Progress`,
              `${TASK_1}: status In Review`,
            ]);
            expect(second?.codeTreeKey).not.toBe(first?.codeTreeKey);
            // Each round's report is posted once, the blocked one with its finding.
            await w.until("both comments", () => w.host.comments.length === 2);
            expect(w.host.comments[0]?.body).toContain("round 1 of the story: blocked");
            expect(w.host.comments[0]?.body).toContain(`blocking · ${kind} · \`${CSV}:2\``);
            expect(w.host.comments[1]?.body).toContain("round 2 of the story: approved");
            // A blocked round is not a park: the cap of 3 failed rounds was not reached.
            expect(parks(w)).toEqual([]);
            await expectMergedOnce(w, run, versions[1]);
          }),
        120_000,
      );
    }

    it(
      "red CI then green",
      () =>
        withLoopOffice({}, async (w) => {
          // CI fails on every head until the worker's fix.
          // CI is still running when the review starts, and turns red while it runs.
          w.host.fallback = PENDING_CHECKS;
          w.director = (session) => {
            if (session.kind === "review") {
              if (session.n === 1) w.host.fallback = RED_CHECKS;
              return reviewScript(session.n, APPROVE);
            }
            if (session.n === 2) w.host.fallback = GREEN_CHECKS;
            writeFile(session, CSV, session.n === 1 ? CSV_V1 : CSV_V2);
            return devScript(session.n);
          };
          const run = await startStory(w, TASK_1);
          await w.until("the merge", () => merged(w));

          expect(kinds(w)).toEqual([
            ["implement", 1],
            ["review", 1],
            ["implement", 2],
            ["review", 2],
          ]);
          // The review approved the red head; its failed check went back to the worker in one fix
          // round, with the job's log tail and the failing location, the log read once.
          const fix = w.sessions[2]?.message ?? "";
          expect(fix).toContain("ci-ok");
          expect(fix).toContain("expected 2 rows, got 1");
          expect(fix).toContain("packages/export/csv.test.ts:3");
          expect(w.host.calls.filter((call) => call.startsWith("log "))).toHaveLength(1);
          // The fix changed the code, so its head got a review round of its own.
          expect(verdicts(w, run)).toEqual([
            [1, "approved"],
            [2, "approved"],
          ]);
          // The red head was one CI attempt of 2: no park.
          expect(parks(w)).toEqual([]);
          await expectMergedOnce(w, run, CSV_V2);
        }),
      120_000,
    );

    it(
      "a conflict hand-off",
      () =>
        withLoopOffice({}, async (w) => {
          const { run } = await conflictHandOff(w);
          expect(kinds(w)).toEqual([
            ["implement", 1],
            ["review", 1],
            ["implement", 2],
            ["review", 2],
          ]);
          // The slot found the conflict in its sync and handed it to the worker as one fix round,
          // the item naming the conflicted path.
          expect(noticeCodes(w)).toContain("mergeSlot.conflict");
          expect(w.sessions[2]?.message).toContain(CSV);
          // The resolution changed the code: a second review round, then one merge.
          expect(verdicts(w, run)).toEqual([
            [1, "approved"],
            [2, "approved"],
          ]);
          await expectMergedOnce(w, run, CSV_V2);
          // Main loses the file the base added here; the `it.failing` sibling pins that (DIPO-324).
          // The branch holds the slot's merge of the moved base (read from the merge call: the Done
          // teardown deleted the branch).
          const tip = w.host.merges[0]?.headSha ?? "";
          const merges = await git(w.repo.remote, w.repo.home, "rev-list", "--merges", tip);
          expect(merges.trim().split("\n")).toHaveLength(1);
          expect(parks(w)).toEqual([]);
        }),
      120_000,
    );

    it.failing(
      "a conflict hand-off gives the worker's box the slot's merge (open gap, DIPO-324)",
      () =>
        withLoopOffice({}, async (w) => {
          const { markers } = await conflictHandOff(w);
          // DIPO-149 and the DIPO-150 amendment: committed as git left it, markers included, and
          // the worker resolves it as an ordinary part, so what the base changed stays merged.
          expect(markers).toContain("<<<<<<< ");
          expect(await remoteFile(w, "main", NOTES)).toBe(NOTES_TEXT);
        }),
      120_000,
    );

    it(
      "a merge gate the maintainer approves",
      () =>
        withLoopOffice({}, async (w) => {
          w.director = (session) => {
            if (session.kind === "review") return reviewScript(session.n, MAINTAINER_CHECK);
            writeFile(session, CSV, CSV_V1);
            return devScript(session.n);
          };
          const run = await startStory(w, TASK_1);
          const waiting = () =>
            mergeGatesOfRun(w.office, run).find(
              (g) => g.waitingOn === "maintainer" && g.decision === null,
            );
          await w.until("the merge gate waits for the maintainer", () => waiting() !== undefined);
          const gate = waiting();
          expect(gate?.summary).toContain("#2");
          // Approved and green, but nothing merges while the gate waits.
          await polls(w, 3);
          expect(merged(w)).toBe(false);
          expect(slotOccupant(w.office)).toBeNull();
          expect(verdicts(w, run)).toEqual([[1, "approved"]]);

          const reply = await w.command("gate.approve", { gate: gate?.gate });
          expect(reply.ok).toBe(true);
          await w.until("the merge", () => merged(w));
          expect(mergeGatesOfRun(w.office, run).map((g) => g.decision)).toEqual([
            expect.objectContaining({ decision: "approved", by: "maintainer" }),
          ]);
          expect(kinds(w)).toEqual([
            ["implement", 1],
            ["review", 1],
          ]);
          await expectMergedOnce(w, run, CSV_V1);
        }),
      120_000,
    );

    it(
      "an override of a review-blocked park",
      () =>
        withLoopOffice({ officeYaml: "version: 7\nreview:\n  maxRounds: 1\n" }, async (w) => {
          w.director = (session) => {
            if (session.kind === "review") {
              return reviewScript(
                session.n,
                blocked("correctness", ROW_V1, "row drops the title."),
              );
            }
            writeFile(session, CSV, CSV_V1);
            return devScript(session.n);
          };
          const run = await startStory(w, TASK_1);
          const override = () =>
            mergeGatesOfRun(w.office, run).find(
              (g) => g.overrideOf !== null && g.decision === null,
            );
          await w.until("the override gate", () => override() !== undefined);
          // The first failed round reached the cap of 1: parked review-blocked, cause rounds.
          expect(parks(w)).toEqual([
            { reason: "review-blocked", cause: "rounds", resolved_how: null },
          ]);
          const gate = override();
          expect(gate?.summary).toContain("row drops the title.");
          expect(merged(w)).toBe(false);

          // An override needs a note.
          const bare = await w.command("gate.approve", { gate: gate?.gate });
          expect(bare.ok ? "ok" : bare.error.code).toBe("gate.noteRequired");
          const note = "The title column lands in the follow-up story.";
          const reply = await w.command("gate.approve", { gate: gate?.gate, note });
          expect(reply.ok).toBe(true);
          await w.until("the merge", () => merged(w));

          // The override is recorded on the verdict and resolves the park; no session ran again.
          const [verdict] = reviewVerdictsOf(w.office, keyOf(w, run));
          expect(verdict).toMatchObject({ verdict: "blocked", override: { note } });
          expect(parks(w)).toEqual([
            { reason: "review-blocked", cause: "rounds", resolved_how: "override" },
          ]);
          expect(kinds(w)).toEqual([
            ["implement", 1],
            ["review", 1],
          ]);
          await expectMergedOnce(w, run, CSV_V1);
          // The branch went Parked, then back In Review for the slot.
          const tip = w.host.merges[0]?.headSha ?? "";
          expect(await remoteSubjects(w, tip, 3)).toEqual([
            `${TASK_1}: status Done`,
            `${TASK_1}: status In Review`,
            `${TASK_1}: status Parked`,
          ]);
        }),
      120_000,
    );

    it(
      "a review running next to a working developer session",
      () =>
        withLoopOffice(
          {
            // A second Ready story, after TASK-1 in the queue.
            prepare: async (repo) => {
              await backlog(repo, [
                "task",
                "create",
                "Add the TSV export command",
                "-d",
                TSV_DESCRIPTION,
                "--ac",
                "The export command writes one TSV row per story",
                "-s",
                "Ready",
                "-l",
                "tier:S",
                "--type",
                "feature",
                "-m",
                "m-0",
                "--ref",
                "packages/tsv/",
                "--ordinal",
                "9000",
              ]);
              await publish(repo, "add TASK-4");
            },
          },
          async (w) => {
            const storyOf = (session: Session) => findRun(w.office, session.runId as RunId)?.story;
            w.director = (session) => {
              const story = storyOf(session);
              if (session.kind === "review") {
                return story === TASK_1 ? "hold" : reviewScript(session.n, TSV_APPROVE);
              }
              if (story === TASK_4) return "hold";
              writeFile(session, CSV, CSV_V1);
              return devScript(session.n);
            };
            const first = await startStory(w, TASK_1);
            const heldOf = (story: string, kind: Session["kind"]) =>
              [...w.held.values()].find(
                (h) => h.session.kind === kind && storyOf(h.session) === story,
              );
            await w.until("TASK-1's review runs", () => heldOf(TASK_1, "review") !== undefined);
            // The worker place is free while TASK-1 is reviewed: TASK-4's developer starts.
            const second = await startStory(w, TASK_4);
            await w.until(
              "TASK-4's developer runs",
              () => heldOf(TASK_4, "implement") !== undefined,
            );

            // Two live sessions in one office: TASK-1's reviewer and TASK-4's developer.
            const live = w.office.all<{ run_id: string; role: string }>(
              `select run_id, role from agents where office_id = $office_id and ended_at is null
                order by started_at, rowid`,
            );
            expect(live).toEqual([
              { run_id: first, role: "reviewer" },
              { run_id: second, role: "developer" },
            ]);

            const review = heldOf(TASK_1, "review");
            const developer = heldOf(TASK_4, "implement");
            w.release(review?.session.agentId ?? "", reviewScript(1, APPROVE).slice(1));
            await w.until("TASK-1's merge", () => merged(w));
            writeFile(developer?.session ?? { cwd: "" }, TSV, "export const tsv = 1;\n");
            w.release(
              developer?.session.agentId ?? "",
              devScript(developer?.session.n ?? 0, TSV_DONE).slice(1),
            );
            await w.until("TASK-4's merge", () => merged(w, 2));
            expect(verdicts(w, first)).toEqual([[1, "approved"]]);
            expect(verdicts(w, second)).toEqual([[1, "approved"]]);
            expect(w.host.merges.map((m) => m.number)).toEqual([1, 2]);
            expect(await remoteFile(w, "main", TSV)).toBe("export const tsv = 1;\n");
            expect(await remoteFile(w, "main", CSV)).toBe(CSV_V1);
          },
        ),
      120_000,
    );

    it(
      "a daemon restart while the story is in the merge slot",
      () =>
        withLoopOffice({}, async (w) => {
          approving(w);
          // Only the In Review head's checks are green: the slot's pushed head waits for its own.
          w.host.fallback = PENDING_CHECKS;
          const run = await startStory(w, TASK_1);
          await w.until("the PR", () => findStoryPr(w.office, run) !== null);
          w.host.checksOf.set(findStoryPr(w.office, run)?.headSha ?? "", GREEN_CHECKS);
          await w.until(
            "the slot waits for the checks",
            () => slotOccupant(w.office)?.phase === "checks",
          );
          const before = slotOccupant(w.office);
          const pushed = await w.host.tip(BRANCH_1);
          expect(before).toMatchObject({ kind: "story", number: 1, head: pushed });
          expect((await remoteSubjects(w, pushed, 1))[0]).toBe(`${TASK_1}: status Done`);

          await w.restart();
          // The new daemon continues with the same occupant at the same step and head.
          expect(slotOccupant(w.office)).toMatchObject({
            kind: "story",
            number: 1,
            phase: "checks",
            head: pushed,
          });
          await polls(w, 3);
          expect(merged(w)).toBe(false);

          w.host.fallback = GREEN_CHECKS;
          await w.until("the merge", () => merged(w));
          // Merged once, at the head pushed before the restart: no second close-out or push.
          expect(w.host.merges).toEqual([{ number: 1, headSha: pushed, subject: TITLE }]);
          expect(w.host.calls.filter((call) => call.startsWith("merge "))).toHaveLength(1);
          await expectMergedOnce(w, run, CSV_V1, pushed);
          // The restart's re-attach closed out the exited hosts, so the Done poll ends the run.
          await w.until("Done", () => findRun(w.office, run)?.endKind === "done");
          expect(findClaim(w.office, run)?.releasedAt).not.toBeNull();
          expect(kinds(w)).toEqual([
            ["implement", 1],
            ["review", 1],
          ]);
        }),
      120_000,
    );

    it(
      "the park and resume path",
      () =>
        withLoopOffice({ officeYaml: "version: 7\nmergeSlot:\n  ciAttempts: 1\n" }, async (w) => {
          w.host.fallback = RED_CHECKS;
          w.director = (session) => {
            if (session.kind === "review") return reviewScript(session.n, APPROVE);
            if (session.n === 2) w.host.fallback = GREEN_CHECKS;
            writeFile(session, CSV, session.n === 1 ? CSV_V1 : CSV_V2);
            return devScript(session.n);
          };
          const run = await startStory(w, TASK_1);
          await w.until("the park", () => openPark(w.office, keyOf(w, run)) !== null);
          // The review that ran meanwhile ends with its verdict; the run waits parked.
          await w.until(
            "the review's verdict",
            () => verdicts(w, run).length === 1 && findRun(w.office, run)?.endedAt !== null,
          );
          expect(verdicts(w, run)).toEqual([[1, "approved"]]);
          // The red head reached the CI cap of 1: parked verify-failing, cause ci.
          expect(parks(w)).toEqual([{ reason: "verify-failing", cause: "ci", resolved_how: null }]);
          expect(kinds(w)).toEqual([
            ["implement", 1],
            ["review", 1],
          ]);

          // The resume needs a note, grants one CI attempt and sends the CI item.
          const bare = await w.command("work.resume", { story: TASK_1 });
          expect(bare.ok ? "ok" : bare.error.code).toBe("resume.noteRequired");
          const note = "The row count test fails; fix it.";
          const reply = await w.command("work.resume", { story: TASK_1, note });
          expect(reply.ok).toBe(true);
          await w.until("the merge", () => merged(w));

          expect(kinds(w)).toEqual([
            ["implement", 1],
            ["review", 1],
            ["implement", 2],
            ["review", 2],
          ]);
          const resumed = w.sessions[2]?.message ?? "";
          expect(resumed).toContain(note);
          expect(resumed).toContain("expected 2 rows, got 1");
          expect(parks(w)).toEqual([
            { reason: "verify-failing", cause: "ci", resolved_how: "resume" },
          ]);
          expect(
            w.office.all<{ kind: string }>(
              "select kind from run_grants where office_id = $office_id and run_id = $run",
              { run },
            ),
          ).toEqual([{ kind: "ciAttempt" }]);
          await expectMergedOnce(w, run, CSV_V2);
        }),
      120_000,
    );
  });
}
