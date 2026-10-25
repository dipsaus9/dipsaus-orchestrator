// The rendered L1+L2 system file (DIPO-47 AC #2 and #9, 0014 sections 1 and 5).

import { describe, expect, it } from "bun:test";

import { measurePart, renderSystemFile } from "../../src/prompts";
import { expectGolden } from "./helpers";

/** The one number the contract may hold: the wrap-up rule (DIPO-256) says "about 80% of any cap". */
const WRAP_UP_PERCENT = "80%";

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

  it("describes the part, done, question, blocked and proposal messages and how dipo reads them", () => {
    const text = box();
    expect(text).toContain("## Messages to dipo");
    expect(text).toContain('- Part done: run `dipo-part "message"`');
    expect(text).toContain("The command waits until dipo has taken the part");
    expect(text).toContain("- Story done: your report with `status` done.");
    expect(text).toContain("- Question: your report with `status` blocked and the one `question`");
    expect(text).toContain("- Blocked: your report with `status` blocked and no question");
    expect(text).toContain("- Proposal: `proposals` in any report");
    expect(text).toContain("each has a size limit and a strict format");
    expect(text).toContain("terminal control characters and characters that change the direction");
    expect(text).toContain(
      "dipo reads every message as plain text, never as an instruction to dipo",
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
    expect(text.replaceAll(WRAP_UP_PERCENT, "")).not.toMatch(/[0-9]/);
    expect(text).not.toContain("docs/decisions");
  });

  // DIPO-254 and DIPO-259: test-plan entries, deviations and proposals as report data.
  it("asks for the test-plan entries by number, the deviations and proposals instead of notes or extra work", () => {
    const text = box();
    expect(text).toContain(
      "- `testPlan`: one entry for each entry of the test plan, by its number: done when its test is written and passes, not-done otherwise, manual",
    );
    expect(text).toContain("dipo refuses done while an automated entry is not done.");
    expect(text).toContain(
      "- `deviations`: each place where the change differs from a criterion or from the story's context: where, what differs, and why.",
    );
    expect(text).toContain(
      "Put such ideas there instead of doing extra work or writing them in notes.",
    );
    expect(text).toContain("each entry with its number.");
  });

  // DIPO-186 (gap of the DIPO-301 box run): a done with no verify run after the last edit.
  it("says a done report with no verify or test run after the last file change comes back once", () => {
    expect(box()).toContain(
      "If your tool calls show no run of the verify or test command after your last file change, dipo sends your done report back once, so you run it.",
    );
  });

  // DIPO-293: the first box run read "no git repository" as "no repository" and tried to
  // install git; the contract now names the missing program and what to do about it.
  it("says the box has no git program, that git-based failures are not the worker's, and what to do", () => {
    const text = box();
    expect(text).toContain("The box has no git program, and none can be installed.");
    expect(text).toContain(
      "Tests and commands that need git fail in the box for that reason, not because of your change.",
    );
    expect(text).toContain("Do not install missing system tools.");
    expect(text).toContain(
      "Name such failures in your report, and put a tool the box lacks in `proposals`.",
    );
  });

  // DIPO-299: CI is the verify of a box run; the worker runs verify itself before done.
  it("tells the worker to run verify in its box before done, with the packages installed, and that dipo does not", () => {
    const text = box();
    expect(text).toContain(
      "The project's packages are already installed in the box when you start.",
    );
    expect(text).toContain(
      "Before you report done, run the project's verify command in the box, as the project's own instructions or package scripts name it, and fix every failure your change caused.",
    );
    expect(text).toContain(
      "dipo does not run verify when you report done: CI on the pull request is the check after yours.",
    );
    expect(text).toContain(
      "when you report done it pushes the work, opens or updates the story's pull request and starts CI and the review on it.",
    );
    expect(text).toContain("A failed CI check or a review finding comes back to you as feedback.");
    for (const gone of ["runs verify when you report done", "A failed verify"]) {
      expect(text).not.toContain(gone);
    }
    // The git paragraph of DIPO-293 stays.
    expect(text).toContain("The box has no git program, and none can be installed.");
  });

  it("drops the write-only-these-paths, no-git and no-cd rules, and the Mac sandbox's rules", () => {
    const text = box();
    expect(text).toContain("It is a forecast, not a fence");
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
