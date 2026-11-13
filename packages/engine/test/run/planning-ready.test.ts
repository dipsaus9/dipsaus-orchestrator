// `story.ready` (DIPO-482) on a planning session's filed stories, against a real temporary
// repository with a remote, the office git and the pinned Backlog CLI: the stories are checked
// against the Ready gate as filed and merged on the base; a passing one gets a stored gate decision
// and is set Ready in a second backlog PR, which the structural check passes; a failing one stays
// Refined and the result lists the gate's messages.

import { describe, expect, it } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type OfficeId, RequestId, type StoryKey } from "@dipsaus-orchestrator/contract";
import { git, withBareRemote } from "@dipsaus-orchestrator/testkit";

import {
  allEntries,
  FILE_KIND,
  fileKind,
  planningLane,
  READY_KIND,
  editKind,
  REVISE_KIND,
  reviseKind,
} from "../../src/backlog/lane";
import { backlogStoryStore } from "../../src/backlog/store";
import { executeCommand } from "../../src/commands/execute";
import { stateOfficeDirectory } from "../../src/commands/offices";
import { buildRegistry } from "../../src/commands/registry";
import { MemoryRequestTable } from "../../src/commands/requests";
import { StoryPlanning } from "../../src/run/planning";
import { backlogLayout } from "../story-store/backlog";
import { evaluateGate } from "../../src/gate";
import { gateContentHash } from "../../src/gate/hash";
import { gateDecisionsOf, readGateInput, storeGateDecision } from "../../src/gate-decisions";
import type { PlanningGate } from "../../src/run/ready-stories";
import { findStoryByKey } from "../../src/records/story-keys";
import { DEFAULT_CONFIG } from "../gate/fixtures";
import {
  BACKLOG_FIXTURE,
  laneSetup,
  publish,
  otherClone,
  squashMergeOnRemote,
} from "../backlog/lane/helpers";
import { pass, task } from "../stories/helpers";
import { blocksOf, commandContext, planningWorld, STORY_PROPOSAL, until } from "./planning-world";

const OTHER = { ...STORY_PROPOSAL, title: "Export the stories as XML" } as const;

describe("story.ready through the real gate and lane (DIPO-482)", () => {
  it("story.ready through the real command, gate and lane sets a passing story Ready and a failing one gets no Ready change (DIPO-482)", async () => {
    await withBareRemote(
      async (repo) => {
        mkdirSync(join(repo.dir, "backlog", "milestones"), { recursive: true });
        writeFileSync(
          join(repo.dir, "backlog", "milestones", "m-3 - rituals.md"),
          '---\nid: m-3\ntitle: "M3 Rituals"\n---\n',
        );
        await publish(repo);
        const s = await laneSetup(repo);
        s.kinds.set(FILE_KIND, fileKind);
        s.kinds.set(REVISE_KIND, reviseKind);
        s.kinds.set(READY_KIND, editKind(READY_KIND));
        const lane = s.lane();
        pass(s.t, s.office, [task("TASK-1", { title: "Add the CSV export command" })]);
        const w = planningWorld(s.t, repo.root, {
          office: s.office,
          lane: () => planningLane(lane),
        });
        w.answerText = (n) => (n === 1 ? blocksOf(STORY_PROPOSAL, OTHER) : "Noted.");
        await w.sessions.start(commandContext(w), { kind: "plan", goal: "Export" });
        await until(() => w.sessions.view(s.office.officeId as OfficeId)?.state === "waiting");
        const ctx = commandContext(w);
        await w.sessions.confirm(ctx, { proposal: 1 });
        const filing = await w.sessions.confirm(ctx, { proposal: 2 });
        const filingBranch =
          filing.result.flush?.state === "pushed" ? filing.result.flush.branch : "";
        await squashMergeOnRemote(repo, filingBranch);
        // TASK-5 moved on in another change, so the gate refuses it; the index still says Refined.
        const other = await otherClone(repo);
        const moved = fileOf(other, "TASK-5");
        writeFileSync(moved.path, moved.text.replace(/^status: .*$/m, "status: In Progress"));
        await git(other, repo.home, "commit", "--quiet", "-am", "move TASK-5 on");
        await git(other, repo.home, "push", "--quiet", "origin", "HEAD:main");
        await lane.flush();
        pass(s.t, s.office, [
          task("TASK-1", { title: "Add the CSV export command" }),
          task("TASK-4", { title: STORY_PROPOSAL.title }),
          task("TASK-5", { title: OTHER.title }),
        ]);

        // No session needed: the command is the maintainer's, for any story on the base.
        const planning = new StoryPlanning({
          stories: backlogLayout,
          lane: () => planningLane(lane),
          gate: () => realGate(s, lane),
        } as never);
        const reply = await executeCommand(
          {
            registry: buildRegistry([planning.feature]),
            offices: stateOfficeDirectory(s.t.state),
            clock: s.t.clock,
            ids: s.t.ids,
            softwareRequests: new MemoryRequestTable(s.t.clock),
          },
          {
            requestId: RequestId.parse("01J9ZK5Q8W3V4X6Y7Z00000001"),
            name: "story.ready",
            args: { stories: ["task-4", "TASK-5"] },
            origin: "cli",
            confirmed: true,
            office: s.office.officeId as OfficeId,
          },
        );
        if (!reply.ok) throw new Error(reply.error.message);
        const result = reply.result as {
          queued: string[];
          refused: { story: string; messages: string[] }[];
          flush?: { state: string; branch?: string };
        };
        expect(result.queued).toEqual(["TASK-4"]);
        expect(result.refused[0]?.story).toBe("TASK-5");
        expect(result.refused[0]?.messages.join(" ")).toContain("R01a");
        expect(result.flush).toMatchObject({ state: "pushed" });
        expect(result.flush?.branch).not.toBe(filingBranch);

        // Fail closed: the failing story has a failed decision and no Ready change in the journal.
        const readyEntries = allEntries(s.office).filter((e) => e.kind === READY_KIND);
        expect(readyEntries.map((e) => e.key)).toEqual([key(s, "TASK-4")]);
        expect(gateDecisionsOf(s.office, key(s, "TASK-4")).map((d) => d.passed)).toEqual([true]);
        expect(gateDecisionsOf(s.office, key(s, "TASK-5")).map((d) => d.passed)).toEqual([false]);
        expect(fileOf(lane.worktreePath(), "TASK-4").text).toContain("status: Ready");
        expect(fileOf(lane.worktreePath(), "TASK-5").text).toContain("status: In Progress");
      },
      { fixture: BACKLOG_FIXTURE },
    );
  }, 60_000);
});

/** The real Ready gate, reading the story in the lane's worktree, which sits on the merged base. */
function realGate(
  s: Awaited<ReturnType<typeof laneSetup>>,
  lane: ReturnType<Awaited<ReturnType<typeof laneSetup>>["lane"]>,
): PlanningGate {
  return {
    async recordGateDecision(_office, story, mode) {
      const identity = findStoryByKey(s.office, story);
      const input = await readGateInput(
        backlogStoryStore(s.cli),
        lane.worktreePath(),
        identity?.story ?? "",
        DEFAULT_CONFIG,
      );
      const result = evaluateGate(
        { ...input, roster: [{ name: "developer", code: true, kind: "code" }] },
        mode,
      );
      const stored = s.office.immediate(() =>
        storeGateDecision(s.office, s.t.ids, {
          key: story,
          result,
          contentHash: gateContentHash(input.story),
          at: s.t.clock.now(),
        }),
      );
      return { ...stored, story: input.story.id as never, result };
    },
  };
}

/** The key of the story `id`, as the office knows it. */
function key(s: { office: import("../../src/db/office").OfficeHandle }, id: string): StoryKey {
  const row = s.office.get<{ key: string }>(
    "select key from stories where office_id = $office_id and story_id = $id",
    { id },
  );
  if (row === null) throw new Error(`no story ${id}`);
  return row.key as StoryKey;
}

/** The task file of `id` in `dir`, by its id prefix. */
function fileOf(dir: string, id: string): { path: string; text: string } {
  const tasks = join(dir, "backlog", "tasks");
  const name = readdirSync(tasks).find((file) => file.startsWith(`${id.toLowerCase()} - `));
  if (name === undefined) throw new Error(`no task file of ${id}`);
  return { path: join(tasks, name), text: readFileSync(join(tasks, name), "utf8") };
}
