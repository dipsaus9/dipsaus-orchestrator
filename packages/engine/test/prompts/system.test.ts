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

  it("tells the worker to change files only with Edit and Write, and to run one command per shell call", () => {
    const text = renderSystemFile("implement", "developer");
    expect(text).toContain(
      "Change files only with the Edit and Write tools, never with `sed -i`, a heredoc, a shell redirection such as `>` or `>>` into a file, `tee`, or a script you write to change files.",
    );
    expect(text).toContain(
      "A project command that rewrites files (the formatter, a golden update, a code generator) is fine, and so is removing or moving a file; run each as one command.",
    );
    expect(text).toContain("Run one command per shell call: no chain with `&&`, `||` or `;`");
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
