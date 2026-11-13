// The role proposals of a planning session (DIPO-474): checked against the role files on the base
// and the stories that carry a role's label, and turned into lane targets that keep what an edit
// does not name.

import { describe, expect, it } from "bun:test";

import { OfficeId } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import {
  checkProposal,
  type RoleFacts,
  roleAddTargetOf,
  roleEditTargetOf,
} from "../../src/run/planning-proposals";
import { editRoleFile, renderRoleFile } from "../../src/roles/file";
import { parseRoleFile } from "../../src/roles/parse";
import { readPlanningRecord } from "../../src/records/planning-record";
import type { PlanningLane } from "../../src/story-store/planning";
import { openTestState } from "../commands/helpers";
import { blocksOf, commandContext, planningWorld, until } from "./planning-world";

const WRITER = renderRoleFile({
  purpose: "Writes the docs",
  model: "claude-sonnet-5-5",
  instructions: "Write clearly.",
});
const BROKEN = "---\nversion: 1\n---\n\nNo purpose.\n";

function facts(openStories: Readonly<Record<string, readonly string[]>> = {}): RoleFacts {
  return {
    files: new Map([
      [".dipo/roles/writer.md", WRITER],
      [".dipo/roles/broken.md", BROKEN],
    ]),
    openStories: (name) => openStories[name] ?? [],
  };
}

const ROLE = {
  kind: "role",
  name: "tester",
  purpose: "Writes the tests",
  instructions: "Test each criterion.",
  why: "Stories need a tester.",
} as const;

const problemsOf = (value: unknown, roles: RoleFacts | null = facts()): string[] => {
  const read = checkProposal(value, roles ?? undefined);
  return read.ok ? [] : [...read.problems];
};

describe("checking role proposals", () => {
  it("accepts a valid role, role-edit and role-remove", () => {
    expect(checkProposal(ROLE, facts()).ok).toBe(true);
    expect(
      checkProposal(
        { kind: "role-edit", name: "writer", purpose: "Writes the docs well", why: "Sharper." },
        facts(),
      ).ok,
    ).toBe(true);
    expect(
      checkProposal({ kind: "role-remove", name: "writer", why: "Not used." }, facts()).ok,
    ).toBe(true);
  });

  it("refuses a reserved, an invalid and an existing name, each with its problem", () => {
    expect(problemsOf({ ...ROLE, name: "reviewer" }).join()).toContain("reserved role name");
    expect(problemsOf({ ...ROLE, name: "Not Valid" }).join()).toContain("not a valid role name");
    expect(problemsOf({ ...ROLE, name: "writer" }).join()).toContain("already has a file");
  });

  it("refuses an edit or removal of a role with no file, naming the role", () => {
    expect(
      problemsOf({ kind: "role-edit", name: "ghost", purpose: "Haunts", why: "Boo." }).join(),
    ).toContain("`ghost` has no file");
    expect(problemsOf({ kind: "role-remove", name: "ghost", why: "Gone." }).join()).toContain(
      "`ghost` has no file",
    );
  });

  it("refuses an edit whose result would not load, with the parser's problem", () => {
    const problems = problemsOf({
      kind: "role-edit",
      name: "broken",
      model: "claude-opus-5-5",
      why: "Tune it.",
    });
    expect(problems.join()).toContain(".dipo/roles/broken.md: key `purpose`");
  });

  it("refuses a role-remove while a Ready story has the role's label, naming the story", () => {
    const problems = problemsOf(
      { kind: "role-remove", name: "writer", why: "Not used." },
      facts({ writer: ["DIPO-77"] }),
    );
    expect(problems.join()).toContain("DIPO-77");
    expect(problems.join()).toContain("`writer`");
  });

  it("refuses role proposals while the role files are not loaded", () => {
    expect(problemsOf(ROLE, null).join()).toContain("not loaded");
  });
});

describe("role files and targets", () => {
  it("renders a file that loads as the role", () => {
    const parsed = parseRoleFile(
      ".dipo/roles/tester.md",
      renderRoleFile(roleAddTargetOf("run", 1, ROLE)),
    );
    expect(parsed).toMatchObject({
      ok: true,
      role: { name: "tester", purpose: "Writes the tests", instructions: "Test each criterion." },
    });
  });

  it("an edit rewrites only the fields it names and keeps every other line", () => {
    const original =
      "---\nversion: 1\n# keep this comment\npurpose: Old\nmodel: m1\n---\n\nBody.\n";
    const edited = editRoleFile(original, { purpose: "New" });
    expect(edited).toBe(
      '---\nversion: 1\n# keep this comment\npurpose: "New"\nmodel: m1\n---\n\nBody.\n',
    );
    expect(editRoleFile(original, { instructions: "Other." })).toBe(
      "---\nversion: 1\n# keep this comment\npurpose: Old\nmodel: m1\n---\n\nOther.\n",
    );
    expect(editRoleFile(original, { effort: "high" })).toContain('model: m1\neffort: "high"\n---');
  });

  it("a role-edit target names only the changed fields", () => {
    expect(
      roleEditTargetOf("run", 2, { kind: "role-edit", name: "writer", model: " m2 ", why: "x" }),
    ).toEqual({ run: "run", proposal: 2, name: "writer", model: "m2" });
  });
});

describe("confirming role proposals", () => {
  it("files each through the lane and tells the session and the record which role changed", async () => {
    await withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const targets: unknown[] = [];
        const journal = async (target: unknown) => {
          targets.push(target);
          return { opId: targets.length };
        };
        const lane = {
          addRole: journal,
          editRole: journal,
          removeRole: journal,
          outcomeOf: () => ({ outcome: "applied", notice: null, merged: false }),
          flush: async () => null,
        } as unknown as PlanningLane;
        const w = planningWorld(t, dir, { lane: () => lane, roleFiles: () => facts().files });
        w.answerText = (n) =>
          n === 1
            ? blocksOf(
                ROLE,
                { kind: "role-edit", name: "writer", purpose: "Writes well", why: "Sharper." },
                { kind: "role-remove", name: "writer", why: "Not used." },
              )
            : "Noted.";
        const { run } = (
          await w.sessions.start(commandContext(w), { kind: "roles", goal: "Roles" })
        ).result;
        const officeId = OfficeId.parse(w.office.officeId);
        await until(() => w.sessions.view(officeId)?.state === "waiting");
        expect(w.sessions.view(officeId)?.proposals?.map((p) => p.proposal.kind)).toEqual([
          "role",
          "role-edit",
          "role-remove",
        ]);
        const ctx = commandContext(w);
        for (const proposal of [1, 2, 3]) await w.sessions.confirm(ctx, { proposal });
        expect(targets).toEqual([
          expect.objectContaining({ name: "tester", purpose: "Writes the tests" }),
          { run, proposal: 2, name: "writer", purpose: "Writes well" },
          { run, proposal: 3, name: "writer" },
        ]);
        await w.sessions.message(ctx, { text: "Next." });
        const last =
          w.sent
            .at(-1)
            ?.flatMap((op) => ("write" in op ? [op.write] : []))
            .join("") ?? "";
        expect(last).toContain("role `tester` added");
        expect(last).toContain("role `writer` edited");
        expect(last).toContain("role `writer` removed");
        expect(
          readPlanningRecord(w.office, run)
            .filter((entry) => entry.subject?.includes(": role "))
            .map((entry) => [entry.subject, entry.text]),
        ).toEqual([
          ["Proposal 1: role tester", "added"],
          ["Proposal 2: role writer", "edited"],
          ["Proposal 3: role writer", "removed"],
        ]);
      } finally {
        t.state.close();
      }
    });
  });
});
