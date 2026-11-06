// The final confirm of a planning session (DIPO-451), against a real temporary repository with a
// remote, the office git and the pinned Backlog CLI: the stories the maintainer chooses are
// checked against the Ready gate as filed and merged on the base; a passing one gets a stored gate
// decision and is set Ready in a second backlog PR, which the structural check passes; a failing
// one stays Refined and the planning view lists the gate's messages.

import { describe, expect, it } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type OfficeId, PlanningView, type StoryKey } from "@dipsaus-orchestrator/contract";
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
import { checkBacklogPr } from "../../src/backlog/pr/check";
import { collectPrDiff } from "../../src/backlog/pr/diff";
import { backlogStoryStore } from "../../src/backlog/store";
import { CommandError } from "../../src/commands/errors";
import { evaluateGate } from "../../src/gate";
import { gateContentHash } from "../../src/gate/hash";
import { gateDecisionsOf, readGateInput, storeGateDecision } from "../../src/gate-decisions";
import type { PlanningGate } from "../../src/run/planning-session";
import { findStoryByKey } from "../../src/records/story-keys";
import { DEFAULT_CONFIG } from "../gate/fixtures";
import {
  BACKLOG_FIXTURE,
  inRemote,
  laneSetup,
  publish,
  otherClone,
  squashMergeOnRemote,
  subjects,
} from "../backlog/lane/helpers";
import { pass, task } from "../stories/helpers";
import { blocksOf, commandContext, planningWorld, STORY_PROPOSAL, until } from "./planning-world";

const OTHER = { ...STORY_PROPOSAL, title: "Export the stories as XML" } as const;

describe("setting a planning session's stories Ready on one confirm (DIPO-451)", () => {
  it("stores a passing decision and sets a story Ready in a second backlog PR; a failing one stays Refined", async () => {
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
        // The gate reads the story in the lane's worktree, which sits on the merged base.
        const gate: PlanningGate = {
          async recordGateDecision(_office, story, mode) {
            const identity = findStoryByKey(s.office, story);
            const input = await readGateInput(
              backlogStoryStore(s.cli),
              lane.worktreePath(),
              identity?.story ?? "",
              DEFAULT_CONFIG,
            );
            const result = evaluateGate(input, mode);
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
        const w = planningWorld(s.t, repo.root, {
          office: s.office,
          lane: () => planningLane(lane),
          gate: () => gate,
        });
        w.answerText = (n) => (n === 1 ? blocksOf(STORY_PROPOSAL, OTHER) : "Noted.");
        await w.sessions.start(commandContext(w), { kind: "plan", goal: "Export" });
        const officeId = s.office.officeId as OfficeId;
        await until(() => w.sessions.view(officeId)?.state === "waiting");
        const ctx = commandContext(w);

        await w.sessions.confirm(ctx, { proposal: 1 });
        const filing = await w.sessions.confirm(ctx, { proposal: 2 });
        const filingBranch =
          filing.result.flush?.state === "pushed" ? filing.result.flush.branch : "";

        // A story the session did not file is refused before anything is evaluated.
        const unknown = await w.sessions
          .ready(ctx, { stories: ["TASK-1"] })
          .catch((error: unknown) => error);
        expect((unknown as CommandError).error.code).toBe("planning.storyUnknown");

        // The filing PR has not merged: the story is not on the base, so nothing is set Ready.
        const early = await w.sessions.ready(ctx, { stories: ["TASK-4"] });
        expect(early.result.queued).toEqual([]);
        expect(early.result.refused[0]?.messages.join(" ")).toContain("not on the base branch");
        expect(allEntries(s.office).filter((e) => e.kind === READY_KIND)).toEqual([]);

        // The filing PR merges.
        await squashMergeOnRemote(repo, filingBranch);
        // Another change moved TASK-5 on, so the gate refuses it: only a Refined story is made Ready.
        const other = await otherClone(repo);
        const moved = fileOf(other, "TASK-5");
        writeFileSync(moved.path, moved.text.replace(/^status: .*$/m, "status: In Progress"));
        await git(other, repo.home, "commit", "--quiet", "-am", "move TASK-5 on");
        await git(other, repo.home, "push", "--quiet", "origin", "HEAD:main");
        await lane.flush();
        // The index pass that follows a merge gives the filed stories their keys.
        pass(s.t, s.office, [
          task("TASK-1", { title: "Add the CSV export command" }),
          task("TASK-4", { title: STORY_PROPOSAL.title }),
          task("TASK-5", { title: OTHER.title }),
        ]);

        const ready = await w.sessions.ready(ctx, { stories: ["TASK-4", "TASK-5"] });
        expect(ready.result.queued).toEqual(["TASK-4"]);
        expect(ready.result.refused).toHaveLength(1);
        expect(ready.result.refused[0]?.story).toBe("TASK-5");
        expect(ready.result.refused[0]?.messages.join(" ")).toContain("R01a");
        expect(ready.result.flush).toMatchObject({ state: "pushed" });
        const branch = ready.result.flush?.state === "pushed" ? ready.result.flush.branch : "";
        expect(branch).not.toBe(filingBranch);

        // The decision for the passing story is stored, passing; the failing one is stored failed.
        expect(gateDecisionsOf(s.office, key(s, "TASK-4")).map((d) => d.passed)).toEqual([true]);
        expect(gateDecisionsOf(s.office, key(s, "TASK-5")).map((d) => d.passed)).toEqual([false]);

        // A second PR: one `ready` commit, TASK-4 Ready, TASK-5 still Refined.
        expect(await subjects(repo.remote, repo.home, branch, "main")).toEqual([
          "backlog: ready TASK-4",
        ]);
        const base = (await inRemote(repo, "rev-parse", "main")).trim();
        const head = (await inRemote(repo, "rev-parse", branch)).trim();
        const diff = await s.git.run(async (session) => {
          const location = s.git.worktreeLocation(lane.worktreePath());
          if (location.kind !== "worktree") throw new Error("expected the backlog worktree");
          return collectPrDiff({ git: session, worktree: location, cli: s.cli, base, head });
        });
        const passing: Record<string, string[]> = {};
        for (const id of ["TASK-4", "TASK-5"]) {
          passing[key(s, id)] = gateDecisionsOf(s.office, key(s, id))
            .filter((d) => d.passed)
            .map((d) => d.contentHash);
        }
        const keys = { "TASK-4": key(s, "TASK-4"), "TASK-5": key(s, "TASK-5") };
        expect(checkBacklogPr(diff, { keys, claimed: [], passing })).toMatchObject({
          passed: true,
          failures: [],
        });
        expect(allEntries(s.office).filter((e) => e.kind === READY_KIND)).toHaveLength(1);

        // The view lists both, with the gate's messages for the refused one.
        const view = PlanningView.parse(w.sessions.view(officeId));
        expect(view.ready?.map((r) => [r.story, r.state])).toEqual([
          ["TASK-4", "set"],
          ["TASK-5", "refused"],
        ]);
        expect(view.ready?.[1]?.messages?.join(" ")).toContain("R01a");

        // Choosing it again changes nothing; the file on the branch says Ready.
        const again = await w.sessions.ready(ctx, { stories: ["TASK-4"] });
        expect(again.result.queued).toEqual(["TASK-4"]);
        expect(allEntries(s.office).filter((e) => e.kind === READY_KIND)).toHaveLength(1);
        expect(fileOf(lane.worktreePath(), "TASK-4").text).toContain("status: Ready");
        expect(fileOf(lane.worktreePath(), "TASK-5").text).toContain("status: In Progress");
      },
      { fixture: BACKLOG_FIXTURE },
    );
  }, 60_000);
});

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
