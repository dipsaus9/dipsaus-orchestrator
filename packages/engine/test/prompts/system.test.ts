// The rendered L1+L2 system file (DIPO-47 AC #2 and #9, 0014 sections 1 and 5).

import { describe, expect, it } from "bun:test";

import { measurePart, renderSystemFile } from "../../src/prompts";
import { expectGolden } from "./helpers";

describe("system file", () => {
  it("matches the golden file", async () => {
    await expectGolden("system-implement-developer.md", renderSystemFile("implement", "developer"));
  });

  it("is byte-identical on every render", () => {
    const first = renderSystemFile("implement", "developer");
    const again = renderSystemFile("implement", "developer");
    expect(again).toBe(first);
    expect(measurePart("system", again).sha256).toBe(measurePart("system", first).sha256);
  });

  it("holds no id, date, path or count", () => {
    const text = renderSystemFile("implement", "developer");
    // No digit at all rules out ids (`DIPO-47`, `run-…`), dates, line numbers and counts.
    expect(text).not.toMatch(/[0-9]/);
    // No path but /tmp: every token with a slash or a backslash must be that one fixed path.
    const paths = text
      .split(/\s+/)
      .map((token) => token.replace(/[`.,;:()]/g, ""))
      .filter((token) => /[/\\]/.test(token));
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((path) => path === "/tmp")).toBe(true);
    expect(text).not.toMatch(/\{\{/);
  });

  it("keeps DIPO_TMP and the sandbox TMPDIR as set and never falls back to /tmp", () => {
    const text = renderSystemFile("implement", "developer");
    expect(text).toContain("`DIPO_TMP`");
    expect(text).toContain("writable `TMPDIR`");
    expect(text).toContain("Never set `DIPO_TMP` or `TMPDIR` to another path");
    expect(text).toContain("never fall back to `/tmp`");
  });

  it("tells the worker that CI-only tests do not run in its sandbox and CI runs them", () => {
    const text = renderSystemFile("implement", "developer");
    expect(text).toContain(
      "Tests that the project runs only in CI, such as `*.ci.test.ts` files that run only when `DIPO_TEST_CI` is set, do not run in the worker sandbox",
    );
    expect(text).toContain("do not run them and do not set that variable");
    expect(text).toContain(
      "If the story asks for a CI-only test, write it and leave it to CI, which runs it.",
    );
  });

  it("tells the worker to run every command from the worktree root, never cd", () => {
    const text = renderSystemFile("implement", "developer");
    expect(text).toContain("Run every command from the worktree root.");
    expect(text).toContain("Never change directory with `cd`, also not inside a compound command");
    expect(text).toContain("Pass file paths relative to the worktree root");
  });

  it("puts the calls that need approval right after Working directory and says why they are denied", () => {
    const text = renderSystemFile("implement", "developer");
    const heading = text.indexOf("## Calls that need approval");
    expect(heading).toBeGreaterThan(text.indexOf("## Working directory"));
    expect(text.indexOf("## Temp files")).toBeGreaterThan(heading);
    expect(text).toContain(
      "Your tool layer asks for approval of some calls. Nobody answers that question in a run, so such a call is denied, and after one denial later calls that need approval can be denied too. Avoid these calls.",
    );
  });

  it("tells the worker to change files only with its file tools, and to run one command per shell call", () => {
    const text = renderSystemFile("implement", "developer");
    expect(text).toContain(
      "Change files only with your file editing and writing tools, never with `sed -i`, a heredoc, a shell redirection such as `>` or `>>` into a file, `tee`, or a script you write to change files.",
    );
    expect(text).toContain(
      "A project command that rewrites files (the formatter, a golden update, a code generator) is fine, and so is removing or moving a file; run each as one command.",
    );
    expect(text).toContain("Run one command per shell call: no chain with `&&`, `||` or `;`");
    expect(text).toContain(
      "no `cd` in front of a command, since it already runs in the directory it is in",
    );
    expect(text).toContain(
      "Pipe a command's output only into `head`, `tail` or `grep`, never into `sed`, `awk`, `xargs` or a shell.",
    );
  });

  it("states the boundary, the precedence and every report field once", () => {
    const text = renderSystemFile("implement", "developer");
    expect(text).toContain(
      "The engine handles git, Backlog.md, verify and review; report instead.",
    );
    expect(text).toContain("This contract (scope, no git writes, the report format) beats story");
    for (const field of [
      "status",
      "criteria",
      "summary",
      "commitSubject",
      "question",
      "needsPermission",
      "notes",
    ]) {
      expect(text).toContain(`- \`${field}\`:`);
    }
    expect(text.indexOf("# Worker contract")).toBe(0);
    expect(text.indexOf("# Role: developer")).toBeGreaterThan(0);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });
});

// The box worker's contract (DIPO-272 AC #4, 0021 section 7, 0014 amendment of 2026-10-21).
function box(): string {
  return renderSystemFile("implement-box", "developer");
}

describe("box worker system file", () => {
  it("matches the golden file and is byte-identical on every render", async () => {
    await expectGolden("system-implement-box-developer.md", box());
    expect(box()).toBe(box());
  });

  it("holds no id, date, path or count", () => {
    const text = box();
    expect(text).not.toMatch(/[0-9]/);
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
    ]) {
      expect(text).toContain(`- \`${field}\`:`);
    }
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
    // The Mac worker has git; the line belongs to the box contract only.
    expect(renderSystemFile("implement", "developer")).not.toContain("no git program");
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
      "needsPermission",
      "scope, no git writes",
    ]) {
      expect(text).not.toContain(gone);
    }
    // The Mac worker keeps its contract until DIPO-280 removes that path.
    const mac = renderSystemFile("implement", "developer");
    expect(mac).toContain("Write only the paths in `<scope>`.");
    expect(mac).toContain("Never change directory with `cd`");
    expect(box().indexOf("# Role: developer")).toBeGreaterThan(0);
  });
});
