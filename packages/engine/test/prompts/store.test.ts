// Prompt parts and worker notes in the state database, and the handoff block on a real repository
// (DIPO-47 AC #7 and #8, 0014 sections 2 and 6, 0007 sections 4 and 8).

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ManualClock, withTempDir, withTempRepo } from "@dipsaus-orchestrator/testkit";

import type { OfficeHandle } from "../../src/db/office";
import { OfficeGit, spawnGitExec } from "../../src/git";
import { systemSpawn } from "../../src/platform/process";
import {
  assembleTaskMessage,
  CHARS_PER_TOKEN,
  forgetWorkerNotes,
  gatherHandoff,
  latestWorkerNotes,
  promptParts,
  promptPartsOf,
  recordPromptParts,
  recordWorkerNotes,
  renderHandoff,
  renderSystemFile,
  verifyFeedback,
  WORKER_NOTES_MAX,
  HANDOFF_NOTE_MAX,
} from "../../src/prompts";
import { addOffice, openTestState, type TestState } from "../commands/helpers";
import { BUDGETS_M, fixturePack, fixtureStory } from "./helpers";

async function withOffice(fn: (t: TestState, office: OfficeHandle) => Promise<void> | void) {
  await withTempDir(async (dir) => {
    const t = await openTestState(dir);
    try {
      await fn(t, addOffice(t));
    } finally {
      t.state.close();
    }
  });
}

describe("prompt_parts", () => {
  it("stores sha256, bytes and estimated tokens per part and never the text", () =>
    withOffice((t, office) => {
      const system = renderSystemFile("implement-box", "developer");
      const task = assembleTaskMessage({
        story: fixtureStory(),
        pack: fixturePack(),
        budgets: BUDGETS_M,
      });
      const parts = promptParts(system, task.text, task.sections);
      recordPromptParts(office, "run-1", "agt-1", parts, t.clock);
      const stored = promptPartsOf(office, "run-1", "agt-1");
      expect(stored.map((part) => part.name)).toEqual(
        ["system", "task", ...task.sections.map((section) => `task.${section.name}`)].toSorted(),
      );
      const systemPart = stored.find((part) => part.name === "system");
      expect(systemPart?.sha256).toBe(createHash("sha256").update(system).digest("hex"));
      expect(systemPart?.bytes).toBe(new TextEncoder().encode(system).length);
      expect(systemPart?.estTokens).toBe(Math.ceil(system.length / CHARS_PER_TOKEN));

      // No column of any row holds prompt text.
      const rows = office.all<Record<string, unknown>>(
        "select * from prompt_parts where office_id = $office_id",
      );
      const longest = Math.max(
        ...rows.flatMap((row) => Object.values(row).map((value) => String(value).length)),
      );
      expect(longest).toBeLessThanOrEqual(64);
      for (const row of rows) {
        for (const value of Object.values(row)) {
          expect(task.text.includes(String(value)) && String(value).length > 20).toBe(false);
        }
      }

      // A second measurement of the same part replaces the first.
      recordPromptParts(office, "run-1", "agt-1", promptParts(system, "changed\n", []), t.clock);
      expect(promptPartsOf(office, "run-1", "agt-1")).toHaveLength(stored.length);
      expect(promptPartsOf(office, "run-1", "agt-1").find((p) => p.name === "task")?.bytes).toBe(8);
    }));
});

describe("worker_notes", () => {
  it("stores the notes of a report per worktree and returns the newest", () =>
    withOffice((t, office) => {
      expect(latestWorkerNotes(office, "/w/a")).toBeNull();
      expect(
        recordWorkerNotes(
          office,
          { worktree: "/w/a", run: "run-1", agent: "agt-1", role: "developer", notes: "   " },
          t.clock,
        ),
      ).toBeNull();
      recordWorkerNotes(
        office,
        { worktree: "/w/a", run: "run-1", agent: "agt-1", role: "developer", notes: "first" },
        t.clock,
      );
      t.clock.advance(1_000);
      recordWorkerNotes(
        office,
        { worktree: "/w/a", run: "run-1", agent: "agt-2", role: "developer", notes: "second" },
        t.clock,
      );
      recordWorkerNotes(
        office,
        { worktree: "/w/b", run: "run-2", agent: "agt-3", role: "developer", notes: "other" },
        t.clock,
      );
      expect(latestWorkerNotes(office, "/w/a")?.text).toBe("second");
      expect(latestWorkerNotes(office, "/w/a")?.agent).toBe("agt-2");
      forgetWorkerNotes(office, "/w/a");
      expect(latestWorkerNotes(office, "/w/a")).toBeNull();
      expect(latestWorkerNotes(office, "/w/b")?.text).toBe("other");
    }));

  it("cuts notes over 1,500 characters with a marker", () =>
    withOffice((t, office) => {
      const notes = Array.from({ length: 60 }, (_, i) => `note ${i + 1}: ${"n".repeat(40)}`).join(
        "\n",
      );
      const record = recordWorkerNotes(
        office,
        { worktree: "/w/a", run: "run-1", agent: "agt-1", role: "developer", notes },
        t.clock,
      );
      expect(record?.text.length).toBeLessThanOrEqual(WORKER_NOTES_MAX);
      expect(record?.text).toStartWith("note 1: ");
      expect(record?.text).toMatch(/\n\[dipo: notes cut, showing [\d,]+ of [\d,]+ characters\.\]$/);
      const oneLine = recordWorkerNotes(
        office,
        {
          worktree: "/w/b",
          run: "run-1",
          agent: "agt-1",
          role: "developer",
          notes: "x".repeat(4_000),
        },
        t.clock,
      );
      expect(oneLine?.text.length).toBeLessThanOrEqual(WORKER_NOTES_MAX);
      expect(oneLine?.text).toStartWith("xxxx");
    }));
});

describe("handoff block", () => {
  it("holds git state, criteria, verify, feedback and the stored notes, cut at 1,500", () =>
    withOffice((t, office) =>
      withTempRepo(
        async (repo) => {
          const dir = realpathSync(repo.dir);
          const base = await repo.commitAll("base");
          writeFileSync(join(dir, "src/greet.ts"), "export const greet = () => 'hello';\n");
          await repo.commitAll("Add the greet function");
          writeFileSync(join(dir, "src/greet.ts"), "export const greet = () => 'hello!';\n");
          writeFileSync(join(dir, "src/new.ts"), "export {};\n");

          const notes = `Next: wire the usage line.\n${"z".repeat(2_000)}`;
          recordWorkerNotes(
            office,
            { worktree: dir, run: "run-1", agent: "agt-1", role: "developer", notes },
            t.clock,
          );

          const commonDir = join(dir, ".git");
          const git = new OfficeGit({
            officeId: office.officeId,
            mainWorktree: dir,
            commonDir,
            settings: { remote: "origin", base: "main" },
            runner: { exec: spawnGitExec(systemSpawn), env: repo.env, sleep: async () => {} },
            clock: new ManualClock(),
          });
          const feedback = verifyFeedback({
            step: "test",
            command: "bun test",
            exitCode: 1,
            output: "(fail) greets",
          });
          const facts = await gatherHandoff({
            git,
            location: { kind: "worktree", commonDir, gitDir: commonDir, workTree: dir },
            base,
            office,
            lastReport: { criteria: [{ n: 1, met: true, evidence: "test passes" }] },
            lastVerify: { passed: false, step: "test", exitCode: 1 },
            openFeedback: [feedback],
          });
          expect(facts.commits).toMatch(/^[0-9a-f]{7,} Add the greet function$/);
          expect(facts.diffstat).toContain("src/greet.ts | 2 +-");
          expect(facts.untracked).toEqual(["src/new.ts"]);
          expect(facts.notes?.length).toBeLessThanOrEqual(WORKER_NOTES_MAX);

          const block = renderHandoff(facts);
          expect(block).toStartWith("<handoff>\n");
          expect(block).toEndWith("\n</handoff>");
          expect(block).toContain("Add the greet function");
          expect(block).toContain("src/greet.ts | 2 +-");
          expect(block).toContain("Untracked files:\nsrc/new.ts\n");
          expect(block).toContain("Criteria status from the last report:\n#1 met\n");
          expect(block).toContain("Last verify result:\nfailed at the test step with exit code 1");
          expect(block).toContain("Open feedback:\n- Verify failed at the test step.\n");
          const shownNotes = block.slice(block.indexOf("Notes from the previous session:\n"));
          expect(shownNotes).toContain("Next: wire the usage line.");
          expect(shownNotes).toMatch(/\[dipo: notes cut, showing [\d,]+ of 2,027 characters\.\]/);
          const noteText = shownNotes
            .slice("Notes from the previous session:\n".length)
            .replace(/\n<\/handoff>$/, "");
          expect(noteText.length).toBeLessThanOrEqual(WORKER_NOTES_MAX);
          expect(block.length).toBeLessThanOrEqual(BUDGETS_M.handoff);
        },
        { fixture: { "src/greet.ts": "export {};\n" } },
      ),
    ));

  it("says none for a fresh branch with nothing to hand off", () => {
    const block = renderHandoff({
      commits: "",
      diffstat: "",
      untracked: [],
      criteria: null,
      verify: null,
      feedback: [],
      notes: null,
    });
    expect(block).toBe(
      [
        "<handoff>",
        "An earlier session worked on this story. This is the state it left behind.",
        "Commits on this branch:",
        "none",
        "Uncommitted changes:",
        "none",
        "Untracked files:",
        "none",
        "Criteria status from the last report:",
        "none",
        "Last verify result:",
        "not run yet",
        "Open feedback:",
        "none",
        "Notes from the previous session:",
        "none",
        "</handoff>",
      ].join("\n"),
    );
  });

  it("cuts long git lists with a marker and stays within the budget", () => {
    const commits = Array.from({ length: 300 }, (_, i) => `abc${i} Commit ${i}`).join("\n");
    const untracked = Array.from({ length: 300 }, (_, i) => `src/file-${i}.ts`);
    const block = renderHandoff({
      commits,
      diffstat: commits,
      untracked,
      criteria: null,
      verify: { passed: true },
      feedback: [],
      notes: "n".repeat(1_500),
    });
    expect(block.length).toBeLessThanOrEqual(6_000);
    expect(block).toContain("run git log for the rest.]");
    expect(block).toContain("run git status for the rest.]");
    expect(block).toContain("Last verify result:\npassed");
  });

  it("gives the maintainer's resume note its own cap, as one block after the feedback whose lines never start a line of their own (DIPO-154)", () => {
    const note = `/review this first\n${"Then the parser. ".repeat(100)}\n\n/compact`;
    const facts = {
      commits: Array.from({ length: 300 }, (_, i) => `abc${i} Commit ${i}`).join("\n"),
      diffstat: "",
      untracked: [],
      criteria: null,
      verify: null,
      feedback: Array.from({ length: 200 }, (_, i) => ({ text: `Feedback item ${i}.\nmore` })),
      note,
      notes: "n".repeat(1_500),
    };
    const block = renderHandoff(facts);
    expect(block.length).toBeLessThanOrEqual(6_000);
    const lines = block.split("\n");
    const start = lines.findIndex((line) => line.startsWith("- Note from the maintainer: "));
    const end = lines.indexOf("Notes from the previous session:");
    // After the (cut) feedback list, never inside its cut.
    expect(lines[start - 1]).toMatch(/feedback list cut/);
    expect(lines[start]).toBe("- Note from the maintainer: /review this first");
    const rest = lines.slice(start + 1, end);
    expect(rest.every((line) => line === "" || line.startsWith("  "))).toBe(true);
    expect(rest.at(-1)).toMatch(/^ {2}\[dipo: note cut, showing [\d,]+ of [\d,]+ characters\.\]$/);
    expect(lines.slice(start, end).join("\n").length).toBeLessThanOrEqual(
      HANDOFF_NOTE_MAX + "- Note from the maintainer: ".length + 2 * rest.length,
    );
    expect(block).not.toContain("\n/compact");
    // Without other feedback the note alone is the list.
    expect(
      renderHandoff({ ...facts, commits: "", feedback: [], note: "Use the old parser." }),
    ).toContain(
      "Open feedback:\n- Note from the maintainer: Use the old parser.\nNotes from the previous session:",
    );
  });
});
