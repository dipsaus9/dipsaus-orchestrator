// A planning edit or split that sets a story's dependencies (DIPO-493), against a real temporary
// repository with a remote, the office git and the pinned Backlog CLI: a confirm refuses an unknown
// dependency, the task itself and a cycle, naming the dependency and journaling nothing; a story the
// session filed is accepted; the lane leaves exactly the given dependencies, and the same set runs
// no `task edit` call.

import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type OfficeId, StoryId } from "@dipsaus-orchestrator/contract";
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
import { BACKLOG_FIXTURE, laneSetup, publish, taskFile } from "../backlog/lane/helpers";
import { pass, task } from "../stories/helpers";
import { blocksOf, commandContext, planningWorld, STORY_PROPOSAL, until } from "./planning-world";

const edit = (id: string, fields: Record<string, unknown>) =>
  ({ kind: "edit", id, ...fields, why: "Order the stories." }) as const;

/** TASK-3 depends on TASK-1 and TASK-2 in the repository before it is published. */
function dependTask3(repo: TempRepoWithRemote): void {
  const file = taskFile(repo.dir, "TASK-3");
  writeFileSync(
    file,
    readFileSync(file, "utf8").replace(
      /^dependencies: .*$/m,
      "dependencies:\n  - TASK-1\n  - TASK-2",
    ),
  );
  mkdirSync(join(repo.dir, "backlog", "milestones"), { recursive: true });
}

async function setup(repo: TempRepoWithRemote, proposals: readonly unknown[]) {
  dependTask3(repo);
  await publish(repo);
  const s = await laneSetup(repo);
  s.kinds.set(FILE_KIND, fileKind);
  s.kinds.set(REVISE_KIND, reviseKind);
  const lane = s.lane();
  pass(s.t, s.office, [
    task("TASK-1", { title: "Add the CSV export command" }),
    task("TASK-2", { title: "Rename the export setting" }),
    task("TASK-3", {
      title: "Export stories as JSON",
      waitingOn: [StoryId.parse("TASK-1"), StoryId.parse("TASK-2")],
    }),
  ]);
  const w = planningWorld(s.t, repo.root, { office: s.office, lane: () => planningLane(lane) });
  w.answerText = () => blocksOf(...proposals);
  await w.sessions.start(commandContext(w), { kind: "plan", goal: "Order" });
  await until(() => w.sessions.view(s.office.officeId as OfficeId)?.state === "waiting");
  return { s, lane, w, ctx: commandContext(w) };
}

const dependenciesOf = (dir: string, id: string): string[] => {
  const text = readFileSync(taskFile(dir, id), "utf8");
  const block = /^dependencies:(?: \[\])?\n((?:\s+- .*\n)*)/m.exec(text)?.[1] ?? "";
  return [...block.matchAll(/- (\S+)/g)].map((m) => m[1] ?? "");
};

const { kind: _kind, why: _why, ...NEW_STORY } = STORY_PROPOSAL;

describe("a planning edit that sets dependencies (DIPO-493)", () => {
  it("refuses an unknown dependency, the task itself and a cycle, naming it, and journals nothing", async () => {
    await withBareRemote(
      async (repo) => {
        const { s, w, ctx } = await setup(repo, [
          edit("TASK-2", { dependencies: ["TASK-9"] }),
          edit("TASK-2", { dependencies: ["task-2"] }),
          edit("TASK-1", { dependencies: ["TASK-3"] }),
          {
            kind: "split",
            id: "TASK-2",
            edit: { dependencies: ["TASK-9"] },
            story: NEW_STORY,
            why: "w",
          },
        ]);
        const messages: string[] = [];
        for (const proposal of [1, 2, 3, 4]) {
          const refused = (await w.sessions
            .confirm(ctx, { proposal })
            .catch((error: unknown) => error)) as CommandError;
          messages.push(refused.error.message);
        }
        expect(messages[0]).toContain("depends on TASK-9");
        expect(messages[1]).toContain("TASK-2 depend on itself");
        expect(messages[2]).toContain("dependency cycle (TASK-1 -> TASK-3 -> TASK-1)");
        expect(messages[2]).toContain("TASK-3");
        expect(messages[3]).toContain("depends on TASK-9");
        expect(allEntries(s.office)).toEqual([]);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  }, 30_000);

  it("accepts a lower-case known id and a story this session filed whose PR has not merged", async () => {
    await withBareRemote(
      async (repo) => {
        const { s, w, ctx } = await setup(repo, [
          { ...STORY_PROPOSAL, title: "Export the stories as TSV" },
          edit("TASK-2", { dependencies: ["task-1", "TASK-4"] }),
        ]);
        await w.sessions.confirm(ctx, { proposal: 1 });
        await w.flushed();
        await w.sessions.confirm(ctx, { proposal: 2 });
        await w.flushed();
        expect(allEntries(s.office).map((entry) => entry.kind)).toEqual([FILE_KIND, REVISE_KIND]);
        expect(dependenciesOf(s.lane().worktreePath(), "TASK-2")).toEqual(["TASK-1", "TASK-4"]);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  }, 30_000);

  it("leaves exactly the given dependencies, none for an empty list, and edits nothing for the same set", async () => {
    await withBareRemote(
      async (repo) => {
        const { s, lane, w, ctx } = await setup(repo, [
          edit("TASK-3", { dependencies: ["TASK-2"] }),
          edit("TASK-3", { dependencies: ["TASK-2"] }),
          edit("TASK-3", { dependencies: [] }),
          edit("TASK-3", { title: "Export stories as JSON lines", dependencies: ["TASK-1"] }),
        ]);
        const worktree = lane.worktreePath();
        const edits = () => s.log.filter((line) => line.startsWith("cli task edit TASK-3")).length;

        await w.sessions.confirm(ctx, { proposal: 1 });
        await w.flushed();
        expect(dependenciesOf(worktree, "TASK-3")).toEqual(["TASK-2"]);

        const before = edits();
        await w.sessions.confirm(ctx, { proposal: 2 });
        await w.flushed();
        expect(edits()).toBe(before);
        expect(dependenciesOf(worktree, "TASK-3")).toEqual(["TASK-2"]);

        await w.sessions.confirm(ctx, { proposal: 3 });
        await w.flushed();
        expect(dependenciesOf(worktree, "TASK-3")).toEqual([]);

        const entries = allEntries(s.office).length;
        await w.sessions.confirm(ctx, { proposal: 4 });
        await w.flushed();
        expect(allEntries(s.office)).toHaveLength(entries + 1);
        expect(dependenciesOf(worktree, "TASK-3")).toEqual(["TASK-1"]);
        expect(readFileSync(taskFile(worktree, "TASK-3"), "utf8")).toContain(
          "title: Export stories as JSON lines",
        );
      },
      { fixture: BACKLOG_FIXTURE },
    );
  }, 60_000);
});
