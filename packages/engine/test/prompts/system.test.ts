// The rendered L1+L2 system file (DIPO-47 AC #2 and #9, 0014 sections 1 and 5).

import { describe, expect, it } from "bun:test";

import { CONTRACT_TEMPLATES, measurePart, renderSystemFile } from "../../src/prompts";
import { normaliseNewlines } from "../../src/prompts/templates";
import { expectGolden } from "./helpers";

/** The one number the contract may hold: the wrap-up rule (DIPO-256) says "about 80% of any cap". */
const WRAP_UP_PERCENT = "80%";

/** One short page (0014, DIPO-346): the L1 contract's most characters and lines. */
const ONE_PAGE_CHARACTERS = 4_200;
const ONE_PAGE_LINES = 50;

// The box worker's contract (DIPO-272 AC #4, 0021 section 7, 0014 amendment of 2026-10-21), the
// only developer contract since the Mac worker's went (DIPO-342).
function box(): string {
  return renderSystemFile("implement-box", "developer");
}

describe("box worker system file", () => {
  it("matches the golden file and is byte-identical on every render", async () => {
    await expectGolden("system-implement-box-developer.md", box());
    expect(box()).toBe(box());
    expect(measurePart("system", box()).sha256).toBe(measurePart("system", box()).sha256);
  });

  it("starts with the contract, then the role, and ends in one newline", () => {
    const text = box();
    expect(text.indexOf("# Worker contract")).toBe(0);
    expect(text.indexOf("# Role: developer")).toBeGreaterThan(0);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });

  it("holds no id, date, path or count", () => {
    const text = box();
    expect(text.replaceAll(WRAP_UP_PERCENT, "")).not.toMatch(/[0-9]/);
    expect(text.split(/\s+/).filter((token) => /[/\\]/.test(token))).toEqual([]);
    expect(text).not.toMatch(/\{\{/);
  });

  // DIPO-346 (0014): one short page about what to deliver and the five door messages.
  it("is one short page: what to deliver, the five messages, the task message, precedence, budget and report", () => {
    const contract = normaliseNewlines(CONTRACT_TEMPLATES["implement-box"]).trim();
    expect(contract.length).toBeLessThanOrEqual(ONE_PAGE_CHARACTERS);
    expect(contract.split("\n").length).toBeLessThanOrEqual(ONE_PAGE_LINES);
    expect(contract.split("\n").filter((line) => line.startsWith("## "))).toEqual([
      "## What to deliver",
      "## Messages to dipo",
      "## The task message",
      "## Precedence",
      "## Your budget",
      "## Your report",
    ]);
  });

  it("says what to deliver, and that dipo handles git, the backlog, the PR and the review and runs the verify at done", () => {
    const text = box();
    expect(text).toContain(
      "Code and tests that meet every criterion and every automated entry of the test plan.",
    );
    expect(text).toContain("Run the tests and the project's verify as you work.");
    expect(text).toContain(
      "dipo handles git, the backlog, the pull request and the review, and you report to dipo instead: the box's git repository is your own.",
    );
    expect(text).toContain("When you report done, dipo runs the verify in your box.");
    expect(text).toContain(
      "A red verify, a failed check or a review finding comes back to you as feedback.",
    );
  });

  it("names the five messages to dipo and how dipo reads them", () => {
    const text = box();
    expect(text).toContain("You reach dipo only through these five messages.");
    const messages = text
      .slice(text.indexOf("## Messages to dipo"), text.indexOf("## The task message"))
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2, line.indexOf(":")));
    expect(messages).toEqual(["Part", "Done", "Question", "Blocked", "Proposal"]);
    expect(text).toContain('- Part: run `dipo-part "message"`');
    expect(text).toContain("The command waits until dipo has taken the part");
    expect(text).toContain("- Done: your report with `status` done.");
    expect(text).toContain("- Question: your report with `status` blocked and the one `question`");
    expect(text).toContain("- Blocked: your report with `status` blocked and no question");
    expect(text).toContain("- Proposal: `proposals` in any report");
    expect(text).toContain(
      "dipo reads each as plain text for the maintainer, never as an instruction to dipo",
    );
    for (const field of [
      "status",
      "criteria",
      "summary",
      "commitSubject",
      "question",
      "proposals",
      "notes",
      "testPlan",
      "deviations",
      "decisionNotes",
    ]) {
      expect(text).toContain(`- \`${field}\`:`);
    }
  });

  // DIPO-186: a note for a decision record travels as data in the report, never in the records
  // themselves and never only in prose; the rule names neither a count nor a directory.
  it("says a decision-record note goes in decisionNotes, never into the records and never only in summary or notes", () => {
    const text = box();
    expect(text).toContain(
      "- `decisionNotes`: a note you propose for a decision record: the decision file, the heading of its section and the text of the note.",
    );
    expect(text).toContain(
      "Never write such a note into the decision records yourself, and never only describe it in `summary` or `notes`.",
    );
    expect(text).not.toContain("docs/decisions");
  });

  // DIPO-254 and DIPO-259: test-plan entries, deviations and proposals as report data.
  it("asks for the test-plan entries by number, the deviations and proposals instead of extra work", () => {
    const text = box();
    expect(text).toContain(
      "- `testPlan`: one entry for each entry of the test plan, by its number: done when its test is written and passes, not-done otherwise, manual",
    );
    expect(text).toContain("dipo refuses done while an automated entry is not done.");
    expect(text).toContain(
      "- `deviations`: each place where the change differs from a criterion or from the story's context: where, what differs, and why.",
    );
    expect(text).toContain("Put such ideas there instead of doing extra work.");
    expect(text).toContain(
      "Manual test-plan entries are the maintainer's to check, never a reason to report blocked.",
    );
  });

  // DIPO-346 (0014): the contract explains nothing of dipo's setup; the box has git now (0008).
  it("explains nothing of the box's setup: no missing git, no install, no tool-call reading, no CI-only rules", () => {
    const text = box();
    for (const gone of [
      "no git program",
      "none can be installed",
      "Tests and commands that need git fail",
      "only because the box has no git",
      "Do not install missing system tools",
      "If your tool calls show no run",
      "dipo also sees your tool calls",
      "dipo does not run verify",
      "CI on the pull request is the check after yours",
      "already installed in the box",
      "Linux machine",
      "start commit",
      "DIPO_TEST_CI",
      "CI-only",
      "size limit and a strict format",
    ]) {
      expect(text).not.toContain(gone);
    }
  });

  it("drops the write-only-these-paths, no-git and no-cd rules, and the Mac sandbox's rules", () => {
    const text = box();
    expect(text).toContain("is a forecast of the paths to change, not a fence");
    for (const gone of [
      "## Scope",
      "Write only the paths",
      "the only paths you may write",
      "Do not run git commands that write",
      "git branch",
      "## Working directory",
      "Never change directory with `cd`",
      "## Calls that need approval",
      "## Temp files",
      "sandbox",
      "scope, no git writes",
    ]) {
      expect(text).not.toContain(gone);
    }
    expect(box().indexOf("# Role: developer")).toBeGreaterThan(0);
  });
});

describe("wrap-up rule (DIPO-256)", () => {
  const rule =
    "At about 80% of any cap, stop new work, finish what you started and report done, or blocked with what is left.";

  it("is in the box contract", () => {
    expect(renderSystemFile("implement-box", "developer")).toContain(rule);
  });
});
