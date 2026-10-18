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

  it("tells the worker to run every command from the worktree root, never cd", () => {
    const text = renderSystemFile("implement", "developer");
    expect(text).toContain("Run every command from the worktree root.");
    expect(text).toContain("Never change directory with `cd`, also not inside a compound command");
    expect(text).toContain("Pass file paths relative to the worktree root");
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
