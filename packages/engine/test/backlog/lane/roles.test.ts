// The role kinds of the planning lane (DIPO-474; 0010, 0022) against a real temporary repository
// and the pinned Backlog CLI: a confirmed role is added, edited and removed as `.dipo/roles/<name>.md`
// on dipo's backlog branch, an edit keeps the fields it does not name, the lane drops a change to
// any other path outside `backlog/`, and a removal whose role a story is labelled with after the
// confirm does not apply and says why.

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withBareRemote } from "@dipsaus-orchestrator/testkit";

import {
  allEntries,
  roleAddKind,
  roleEditKind,
  roleRemoveKind,
  ROLE_ADD_KIND,
  ROLE_EDIT_KIND,
  ROLE_REMOVE_KIND,
  type LaneOpKind,
} from "../../../src/backlog/lane";
import { parseRoleFile } from "../../../src/roles/parse";
import { BACKLOG_FIXTURE, laneSetup, publish, taskFile } from "./helpers";

const FIXTURE = { fixture: BACKLOG_FIXTURE };

const WRITER = [
  "---",
  "version: 1",
  "# keep this comment",
  "purpose: Writes the docs",
  "model: claude-sonnet-5-5",
  "---",
  "",
  "Write clearly.",
  "",
].join("\n");

const OLD = "---\nversion: 1\npurpose: Retired\n---\n\nOld.\n";

function seedRoles(dir: string): void {
  mkdirSync(join(dir, ".dipo", "roles"), { recursive: true });
  writeFileSync(join(dir, ".dipo", "roles", "writer.md"), WRITER);
  writeFileSync(join(dir, ".dipo", "roles", "old.md"), OLD);
}

// Allowed to write under .dipo/roles/, but it writes the office file.
const officeWriter: LaneOpKind = {
  kind: "probe",
  dirs: [".dipo/roles/"],
  async apply(ctx) {
    mkdirSync(join(ctx.cwd, ".dipo"), { recursive: true });
    writeFileSync(join(ctx.cwd, ".dipo", "office.yaml"), "x: 1\n");
    return { applies: true };
  },
};

const source = { run: "run_1", proposal: 1 };

describe("the role kinds of the planning lane", () => {
  it("adds, edits and removes role files on the backlog branch, an edit keeping the other fields", async () => {
    await withBareRemote(async (repo) => {
      seedRoles(repo.dir);
      await publish(repo);
      const s = await laneSetup(repo);
      for (const kind of [roleAddKind, roleEditKind, roleRemoveKind]) s.kinds.set(kind.kind, kind);
      const lane = s.lane();
      await lane.submit({
        kind: ROLE_ADD_KIND,
        subject: "tester",
        target: {
          ...source,
          name: "tester",
          purpose: "Writes the tests",
          effort: "high",
          instructions: "Test each criterion.",
        },
      });
      await lane.submit({
        kind: ROLE_EDIT_KIND,
        subject: "writer",
        target: { ...source, name: "writer", purpose: "Writes the docs well" },
      });
      await lane.submit({
        kind: ROLE_REMOVE_KIND,
        subject: "old",
        target: { ...source, name: "old" },
      });
      const worktree = lane.worktreePath();
      const roles = join(worktree, ".dipo", "roles");

      const added = readFileSync(join(roles, "tester.md"), "utf8");
      expect(parseRoleFile(".dipo/roles/tester.md", added)).toMatchObject({
        ok: true,
        role: { name: "tester", purpose: "Writes the tests", effort: "high" },
      });
      // Only the named field changed; the comment, the model and the body stayed.
      expect(readFileSync(join(roles, "writer.md"), "utf8")).toBe(
        WRITER.replace("purpose: Writes the docs", 'purpose: "Writes the docs well"'),
      );
      expect(existsSync(join(roles, "old.md"))).toBe(false);
      expect(allEntries(s.office).map((entry) => [entry.kind, entry.state])).toEqual([
        [ROLE_ADD_KIND, "pushed"],
        [ROLE_EDIT_KIND, "pushed"],
        [ROLE_REMOVE_KIND, "pushed"],
      ]);
    }, FIXTURE);
  });

  it("applies a change under .dipo/roles/ and drops one that writes another path outside backlog/", async () => {
    await withBareRemote(async (repo) => {
      await publish(repo);
      const s = await laneSetup(repo);
      s.kinds.set("probe", officeWriter);
      s.kinds.set(roleAddKind.kind, roleAddKind);
      const lane = s.lane();
      await lane.submit({ kind: "probe", subject: "office", target: {} });
      await lane.submit({
        kind: ROLE_ADD_KIND,
        subject: "tester",
        target: { ...source, name: "tester", purpose: "Writes", instructions: "Test." },
      });
      const entries = allEntries(s.office);
      expect(entries[0]).toMatchObject({ kind: "probe", state: "dropped" });
      expect(entries[0]?.notice).toContain("outside backlog/: .dipo/office.yaml");
      expect(entries[1]).toMatchObject({ kind: ROLE_ADD_KIND, state: "pushed" });
      expect(existsSync(join(lane.worktreePath(), ".dipo", "office.yaml"))).toBe(false);
      expect(existsSync(join(lane.worktreePath(), ".dipo", "roles", "tester.md"))).toBe(true);
    }, FIXTURE);
  });

  it("does not apply a removal whose role a story was labelled with after the confirm, and says why", async () => {
    await withBareRemote(async (repo) => {
      seedRoles(repo.dir);
      // TASK-1 is Ready and carries the label by the time the removal applies.
      const file = taskFile(repo.dir, "TASK-1");
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace("  - 'tier:S'", "  - 'tier:S'\n  - 'role:writer'"),
      );
      await publish(repo);
      const s = await laneSetup(repo);
      s.kinds.set(roleRemoveKind.kind, roleRemoveKind);
      s.kinds.set(roleAddKind.kind, roleAddKind);
      const lane = s.lane();
      await lane.submit({
        kind: ROLE_REMOVE_KIND,
        subject: "writer",
        target: { ...source, name: "writer" },
      });
      // An add of a role whose file exists does not apply either.
      await lane.submit({
        kind: ROLE_ADD_KIND,
        subject: "old",
        target: { ...source, name: "old", purpose: "Again", instructions: "Again." },
      });
      const [removal, add] = allEntries(s.office);
      expect(removal).toMatchObject({ kind: ROLE_REMOVE_KIND, state: "dropped" });
      expect(removal?.notice).toContain("TASK-1");
      expect(removal?.notice).toContain("role:writer");
      expect(add).toMatchObject({ kind: ROLE_ADD_KIND, state: "dropped" });
      expect(add?.notice).toContain("exists now");
      expect(existsSync(join(lane.worktreePath(), ".dipo", "roles", "writer.md"))).toBe(true);
    }, FIXTURE);
  });
});
