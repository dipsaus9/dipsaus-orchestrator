// The structured summary on park, resume and close (DIPO-154; 0020 section 13), fast and local: a
// migrated state database built from fixtures with one story run, its steps, usage, grants, parks
// and web calls written as the engine writes them, and the texts built from those stored facts.
// The writes through the real Backlog CLI are in park-commit.ci.test.ts.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  appendRunStep,
  finalSummaryOf,
  insertRun,
  oneLine,
  recordGrant,
  renderParkBlock,
  resumeLine,
  runSummaryFacts,
  summaryDate,
} from "../../src/run";
import { recordReportedCriteria, recordRunCriteria } from "../../src/run/criteria";
import { findRun } from "../../src/run/records";
import { SECTION_RULE } from "../../src/backlog/plain";
import { type IngestFixture, ingestFixture } from "../ingest/helpers";

let dir: string;
let f: IngestFixture;

/** 2026-10-22 14:05 UTC. */
const AT = Date.UTC(2026, 9, 22, 14, 5);

beforeEach(async () => {
  dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "summary-"));
  f = await ingestFixture(dir);
  const { office, run, work } = f;
  office.immediate(() => {
    insertRun(office, {
      runId: run,
      kind: "story",
      key: work.key,
      story: "DIPO-1",
      tier: "S",
      role: "developer",
      model: "haiku",
      startSha: "b".repeat(40),
      branch: "DIPO-1/add-a-greeting",
      worktree: join(dir, "trees", "DIPO-1"),
      slot: 1,
      budgetUnit: "tokens",
      budgetLimit: 300_000,
      loopCap: 3,
      maxTurns: 60,
      maxMinutes: 90,
      reviewRoundCap: 3,
      ciCap: 2,
      configHash: "h",
      overrideKeys: null,
      runProfileId: null,
      startedAt: AT - 34 * 60_000,
    });
    // The first worker host started with the run.
    office.run(
      `update worker_hosts set started_at = $at where office_id = $office_id and run_id = $run`,
      { at: AT - 34 * 60_000, run },
    );
    recordRunCriteria(office, run, { known: [1, 2, 3, 4, 5, 6, 7, 8], checked: [1] });
    recordReportedCriteria(office, run, {
      status: "blocked",
      criteria: [
        { n: 1, met: true, evidence: "" },
        { n: 2, met: true, evidence: "" },
        { n: 3, met: true, evidence: "" },
        { n: 4, met: false, evidence: "" },
      ],
      summary: "",
      commitSubject: "",
    });
    appendRunStep(office, run, "loop", "1", AT - 20 * 60_000);
    appendRunStep(office, run, "ci", "c".repeat(40), AT - 15 * 60_000);
    appendRunStep(office, run, "review", "1", AT - 10 * 60_000);
    appendRunStep(office, run, "review-failed", "1", AT - 9 * 60_000);
    office.run(
      `insert into agents (office_id, agent_id, run_id, role, model, started_at)
       values ($office_id, $agent, $run, 'developer', 'haiku', $at)`,
      { agent: f.agent, run, at: AT - 34 * 60_000 },
    );
    office.run(
      `insert into usage_totals (office_id, run_id, agent_id, model, role, tier, input, output,
         turns, updated_at)
       values ($office_id, $run, $agent, 'haiku', 'developer', 'S', 400000, 12000, 61, $at)`,
      { run, agent: f.agent, at: AT },
    );
  });
});

afterEach(() => {
  f.t.state.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the park block", () => {
  it("writes each listed field from the stored facts", () => {
    const run = findRun(f.office, f.run);
    if (run === null) throw new Error("no run");
    const block = renderParkBlock({
      at: AT,
      reason: "budget-exceeded",
      detail: "turn cap (--max-turns) after 61 turns\nmore detail on a second line",
      runId: f.run,
      ...runSummaryFacts(f.office, run, AT),
      lastGoodCommit: "a".repeat(40),
      uncommitted: 7,
    });
    expect(block.split("\n")).toEqual([
      "Parked 2026-10-22 14:05 UTC: budget-exceeded",
      "- Detail: turn cap (--max-turns) after 61 turns",
      `- Run: ${f.run}`,
      "- Criteria met: 3 of 8 (as the worker reported them)",
      "- Loops: 1 of 3; CI attempts: 1 of 2",
      "- Review rounds: 1, failed 1 of 3",
      "- Budget used: 412,000 of 300,000 tokens; 61 of 60 turns; 34 of 90 minutes",
      `- Last good commit: ${"a".repeat(40)}`,
      "- Uncommitted files: 7",
    ]);
  });

  it("counts a budget grant in the limits and says a box run's files are in the box", () => {
    f.office.immediate(() =>
      recordGrant(f.office, f.run, {
        kind: "budget",
        amount: { tokens: 150_000, turns: 30, minutes: 45 },
        grantId: "grt_1",
        note: "more room",
        origin: "maintainer",
        client: null,
        at: AT - 60_000,
      }),
    );
    const run = findRun(f.office, f.run);
    if (run === null) throw new Error("no run");
    const block = renderParkBlock({
      at: AT,
      reason: "verify-failing",
      detail: "",
      runId: f.run,
      ...runSummaryFacts(f.office, run, AT),
      lastGoodCommit: "a".repeat(40),
      uncommitted: null,
    });
    expect(block).toContain("- Detail: none");
    expect(block).toContain(
      "- Budget used: 412,000 of 450,000 tokens; 61 of 90 turns; 34 of 135 minutes",
    );
    expect(block).toContain(
      "- Uncommitted files: not counted (a box run: undelivered work stays in the box)",
    );
  });

  it("never writes a line of 50 dashes, whatever the detail holds", () => {
    const run = findRun(f.office, f.run);
    if (run === null) throw new Error("no run");
    const block = renderParkBlock({
      at: AT,
      reason: "ambiguous-spec",
      detail: `${SECTION_RULE}\nWhich greeting?`,
      runId: f.run,
      ...runSummaryFacts(f.office, run, AT),
      lastGoodCommit: null,
      uncommitted: 0,
    });
    expect(block.split("\n").some((line) => line.trimEnd() === SECTION_RULE)).toBe(false);
    expect(block).toContain("- Detail: (a line of dashes)");
    expect(oneLine(`  ${"x".repeat(300)}  `)).toHaveLength(200);
    // A worker's text never closes the task file's section markers.
    const marker = oneLine("done <!-- SECTION:NOTES:END --> ## Final Summary");
    expect(marker).not.toContain("<!--");
    expect(marker).not.toContain("-->");
  });
});

describe("the resume line", () => {
  it("holds the date, resumed, the grants and the note's first line", () => {
    expect(
      resumeLine({
        at: AT,
        grants: [
          { kind: "budget", amount: { tokens: 150_000, turns: 30, minutes: 45 } },
          { kind: "loop", amount: 1 },
        ],
        note: "Try the other parser.\nIt handles the edge case.",
      }),
    ).toBe(
      "Resumed 2026-10-22 14:05 UTC; grants: budget +150,000 tokens, +30 turns, +45 minutes, +1 loop; note: Try the other parser.",
    );
    expect(resumeLine({ at: AT, grants: [], answer: "allow once of Bash", note: "" })).toBe(
      "Resumed 2026-10-22 14:05 UTC; answer: allow once of Bash; grants: none; note: none",
    );
  });
});

describe("the final summary", () => {
  it("sums every run of the story and lists each park and grant on one line", () => {
    const { office, run, work } = f;
    office.immediate(() => {
      office.run(
        `insert into parks (office_id, park_id, key, story_id, run_id, reason, from_state, detail,
           last_good_commit, at, resolved_at, resolved_how)
         values ($office_id, 1, $key, 'DIPO-1', $run, 'budget-exceeded', 'In Progress',
           'turn cap (--max-turns) after 61 turns', null, $at, $resolved, 'resume')`,
        { key: work.key, run, at: AT - 5 * 60_000, resolved: AT - 4 * 60_000 },
      );
      recordGrant(office, run, {
        kind: "budget",
        amount: { tokens: 150_000, turns: 30, minutes: 45 },
        grantId: "grt_1",
        note: "more room",
        origin: "maintainer",
        client: null,
        at: AT - 4 * 60_000,
      });
      office.run(
        `update runs set web_searches = 2, web_fetches = 5 where office_id = $office_id
          and run_id = $run`,
        { run },
      );
    });
    const text = finalSummaryOf(office, work.key, AT + 60 * 60_000);
    const lines = text.split("\n");
    expect(lines[0]).toBe(`Closed ${summaryDate(AT + 60 * 60_000)}`);
    expect(lines.slice(1, 6)).toEqual([
      "- Criteria met: 3 of 8 (as the worker reported them)",
      "- Loops: 1; CI attempts: 1",
      "- Review rounds: 1, failed 1",
      "- Budget used: 412,000 of 450,000 tokens",
      "- Runs: 1; resumes: 1",
    ]);
    expect(lines).toContain("- Parks: 1");
    expect(lines).toContain(
      "  - 2026-10-22 14:00 UTC budget-exceeded: turn cap (--max-turns) after 61 turns",
    );
    expect(lines).toContain("- Grants: 1");
    expect(lines).toContain(
      "  - 2026-10-22 14:01 UTC budget +150,000 tokens, +30 turns, +45 minutes",
    );
    expect(lines).toContain("- Web calls: 2 searches, 5 fetches");
    expect(lines.at(-1)).toMatch(/^- Proposals filed: (\d+|not recorded)$/);
    expect(lines.some((line) => line.trimEnd() === SECTION_RULE)).toBe(false);
  });
});
