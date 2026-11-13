// A planning edit or split that moves a story to another role (DIPO-478), against a real temporary
// repository with a remote, the office git and the pinned Backlog CLI: the proposal schema takes a
// role alone, a confirm refuses a role outside the roster and journals nothing, the lane leaves one
// role label, a Ready story goes back to Refined, and the same role runs no `task edit` call.

import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type OfficeId } from "@dipsaus-orchestrator/contract";
import { type TempRepoWithRemote, withBareRemote } from "@dipsaus-orchestrator/testkit";

import {
  allEntries,
  FILE_KIND,
  fileKind,
  planningLane,
  REVISE_KIND,
  reviseKind,
} from "../../src/backlog/lane";
import { CommandError } from "../../src/commands/errors";
import { renderRoleFile } from "../../src/roles/file";
import { checkProposal } from "../../src/run/planning-proposals";
import { BACKLOG_FIXTURE, laneSetup, publish, taskFile } from "../backlog/lane/helpers";
import { pass, task } from "../stories/helpers";
import {
  blocksOf,
  commandContext,
  planningWorld,
  ROSTER_FILES,
  STORY_PROPOSAL,
  until,
} from "./planning-world";

const edit = (id: string, fields: Record<string, unknown>) =>
  ({ kind: "edit", id, ...fields, why: "Another role fits." }) as const;

let current: ReadonlyMap<string, string | undefined>;
const ROSTER = new Map([
  ...ROSTER_FILES,
  [".dipo/roles/writer.md", renderRoleFile({ purpose: "Writes docs", instructions: "Write." })],
]);
const roles = { files: ROSTER, openStories: () => [] };

/** Gives the three fixture tasks a `role:developer` label before the repository is published. */
function labelRoles(repo: TempRepoWithRemote): void {
  for (const id of ["TASK-1", "TASK-2", "TASK-3"]) {
    const file = taskFile(repo.dir, id);
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(/^(labels:\n  - '.*'\n)/m, "$1  - 'role:developer'\n"),
    );
  }
  mkdirSync(join(repo.dir, "backlog", "milestones"), { recursive: true });
}

async function setup(repo: TempRepoWithRemote, proposals: readonly unknown[]) {
  current = ROSTER;
  labelRoles(repo);
  await publish(repo);
  const s = await laneSetup(repo);
  s.kinds.set(FILE_KIND, fileKind);
  s.kinds.set(REVISE_KIND, reviseKind);
  const lane = s.lane();
  pass(s.t, s.office, [
    task("TASK-1", { title: "Add the CSV export command" }),
    task("TASK-2", { title: "Rename the export setting" }),
    task("TASK-3", { title: "Export stories as JSON" }),
  ]);
  const w = planningWorld(s.t, repo.root, {
    office: s.office,
    lane: () => planningLane(lane),
    roleFiles: () => current,
  });
  w.answerText = () => blocksOf(...proposals);
  await w.sessions.start(commandContext(w), { kind: "plan", goal: "Roles" });
  await until(() => w.sessions.view(s.office.officeId as OfficeId)?.state === "waiting");
  return { s, lane, w, ctx: commandContext(w) };
}

const text = (dir: string, id: string): string => readFileSync(taskFile(dir, id), "utf8");
const labelsOf = (dir: string, id: string): string[] =>
  [
    ...(/^labels:\n((?:  - .*\n)*)/m.exec(text(dir, id))?.[1] ?? "").matchAll(/- '?([^'\n]+)'?/g),
  ].map((m) => m[1] ?? "");
const statusOf = (dir: string, id: string): string =>
  /^status: (.*)$/m.exec(text(dir, id))?.[1] ?? "";

const { kind: _kind, why: _why, ...NEW_STORY } = STORY_PROPOSAL;

describe("a planning edit that changes the role (DIPO-478)", () => {
  it("accepts an edit and a split edit with only a role, and refuses an edit with no field", () => {
    expect(checkProposal(edit("TASK-2", { role: "writer" }), roles).ok).toBe(true);
    expect(
      checkProposal(
        { kind: "split", id: "TASK-2", edit: { role: "writer" }, story: NEW_STORY, why: "w" },
        roles,
      ).ok,
    ).toBe(true);
    expect(checkProposal(edit("TASK-2", {}), roles).ok).toBe(false);
  });

  it("refuses a role outside the roster at the confirm, naming it, and journals nothing", async () => {
    await withBareRemote(
      async (repo) => {
        const { s, w, ctx } = await setup(repo, [
          edit("TASK-2", { role: "writer" }),
          { kind: "split", id: "TASK-2", edit: { role: "writer" }, story: NEW_STORY, why: "w" },
        ]);
        // The roster loses the role between the proposal and the confirm.
        current = ROSTER_FILES;
        for (const proposal of [1, 2]) {
          const refused = (await w.sessions
            .confirm(ctx, { proposal })
            .catch((error: unknown) => error)) as CommandError;
          expect(refused).toBeInstanceOf(CommandError);
          expect(refused.error.message).toContain("`writer`");
        }
        expect(allEntries(s.office)).toEqual([]);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  }, 30_000);

  it("replaces the role label and keeps the others; Ready goes back to Refined, Refined and Parked keep their status", async () => {
    await withBareRemote(
      async (repo) => {
        const { lane, w, ctx } = await setup(repo, [
          edit("TASK-1", { role: "writer" }),
          edit("TASK-2", { role: "writer", title: "Rename the export option" }),
          edit("TASK-3", { role: "writer" }),
        ]);
        const dir = lane.worktreePath();
        for (const proposal of [1, 2, 3]) await w.sessions.confirm(ctx, { proposal });
        expect(labelsOf(dir, "TASK-1").toSorted()).toEqual(["role:writer", "tier:S"]);
        expect(statusOf(dir, "TASK-1")).toBe("Refined");
        expect(labelsOf(dir, "TASK-2").toSorted()).toEqual(["role:writer", "tier:S"]);
        expect(statusOf(dir, "TASK-2")).toBe("Refined");
        expect(text(dir, "TASK-2")).toContain("title: Rename the export option");
        expect(labelsOf(dir, "TASK-3").toSorted()).toEqual(["role:writer", "tier:M"]);
        expect(statusOf(dir, "TASK-3")).toBe("Parked");
      },
      { fixture: BACKLOG_FIXTURE },
    );
  }, 60_000);

  it("changes no label and no status, and runs no task edit, for the role the story has", async () => {
    await withBareRemote(
      async (repo) => {
        const { s, lane, w, ctx } = await setup(repo, [edit("TASK-1", { role: "developer" })]);
        const before = s.log.filter((line) => line.startsWith("cli task edit TASK-1")).length;
        await w.sessions.confirm(ctx, { proposal: 1 });
        expect(s.log.filter((line) => line.startsWith("cli task edit TASK-1")).length).toBe(before);
        expect(labelsOf(lane.worktreePath(), "TASK-1").toSorted()).toEqual([
          "role:developer",
          "tier:S",
        ]);
        expect(statusOf(lane.worktreePath(), "TASK-1")).toBe("Ready");
      },
      { fixture: BACKLOG_FIXTURE },
    );
  }, 30_000);
});
