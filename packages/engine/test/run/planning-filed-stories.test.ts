// What a planning session knows of the stories it filed (DIPO-480), against a real temporary
// repository with a remote, the office git and the pinned Backlog CLI, and the real planning lane:
// a story that depends on one filed a moment ago is filed while that story's PR is open; the
// session's next message lists each filed story with its state and text, and the box copy is not
// refreshed; Ready on one confirm sets both stories Ready once their filing PRs merged.

import { describe, expect, it } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type OfficeId } from "@dipsaus-orchestrator/contract";
import { type TempRepoWithRemote, withBareRemote } from "@dipsaus-orchestrator/testkit";

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
import { CommandError } from "../../src/commands/errors";
import { evaluateGate } from "../../src/gate";
import { gateContentHash } from "../../src/gate/hash";
import { readGateInput, storeGateDecision } from "../../src/gate-decisions";
import { addPlanningEntry } from "../../src/records/planning-record";
import { checkProposal } from "../../src/run/planning-proposals";
import { findStoryByKey } from "../../src/records/story-keys";
import type { PlanningGate } from "../../src/run/planning-session";
import { DEFAULT_CONFIG } from "../gate/fixtures";
import { BACKLOG_FIXTURE, laneSetup, publish, squashMergeOnRemote } from "../backlog/lane/helpers";
import { draft, pass, task } from "../stories/helpers";
import {
  BASE_COMMIT,
  blocksOf,
  commandContext,
  planningWorld,
  STORY_PROPOSAL,
  until,
} from "./planning-world";

const SECOND = {
  ...STORY_PROPOSAL,
  title: "Export the stories as XML",
  dependencies: ["task-4"],
} as const;

/** The text of the last message sent to the session. */
const lastMessage = (w: ReturnType<typeof planningWorld>): string =>
  w.sent
    .at(-1)
    ?.flatMap((op) => ("write" in op ? [op.write] : []))
    .join("") ?? "";

async function setup(repo: TempRepoWithRemote, proposals: readonly unknown[]) {
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
  const indexed = [task("TASK-1", { title: "Add the CSV export command" })];
  pass(s.t, s.office, indexed);
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
      const result = evaluateGate({ ...input, roster: [{ name: "developer", code: true }] }, mode);
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
  w.answerText = (n) => (n === 1 ? blocksOf(...proposals) : "Noted.");
  await w.sessions.start(commandContext(w), { kind: "plan", goal: "Export" });
  const officeId = s.office.officeId as OfficeId;
  await until(() => w.sessions.view(officeId)?.state === "waiting");
  return { s, lane, w, ctx: commandContext(w), indexed };
}

function fileOf(dir: string, id: string): string {
  const tasks = join(dir, "backlog", "tasks");
  const name = readdirSync(tasks).find((file) => file.startsWith(`${id.toLowerCase()} - `));
  if (name === undefined) throw new Error(`no task file of ${id}`);
  return readFileSync(join(tasks, name), "utf8");
}

const deps = (...ids: string[]) => ({
  ...STORY_PROPOSAL,
  title: `Story of ${ids.join("-")}`,
  dependencies: ids,
});

describe("a planning session knows the stories it filed (DIPO-480)", () => {
  it("files a story that depends on one filed a moment ago, lists both to the session, and sets both Ready on one confirm", async () => {
    await withBareRemote(
      async (repo) => {
        const { s, lane, w, ctx, indexed } = await setup(repo, [STORY_PROPOSAL, SECOND]);

        const first = await w.sessions.confirm(ctx, { proposal: 1 });
        expect(first.result.stories).toEqual(["TASK-4"]);
        // The filing PR of TASK-4 is open; TASK-4 is not in the office's stories, and a lower-case
        // id of it resolves as its upper-case form.
        const second = await w.sessions.confirm(ctx, { proposal: 2 });
        expect(second.result.state).toBe("filed");
        expect(second.result.stories).toEqual(["TASK-5"]);
        expect(fileOf(lane.worktreePath(), "TASK-5")).toMatch(/dependencies:\n\s+- TASK-4/);
        const filingBranch =
          second.result.flush?.state === "pushed" ? second.result.flush.branch : "";

        // Before the next turn: both stories with state and full text; the copy is not refreshed.
        const commits = w.boxes.made.length;
        await w.sessions.message(ctx, { text: "Next." });
        const listed = lastMessage(w);
        expect(listed).toContain("- TASK-4: Export the stories as CSV");
        expect(listed).toContain("- TASK-5: Export the stories as XML");
        expect(listed.match(/state: filed, backlog PR open/g)).toHaveLength(2);
        expect(listed).toContain("dependencies: TASK-4");
        expect(listed).toContain(`Story: ${STORY_PROPOSAL.storyLine}`);
        expect(listed).toContain("1. The export writes one CSV row per active story");
        expect(w.boxes.made).toHaveLength(commits);

        // Nothing changed: the next message carries no list.
        await w.sessions.message(ctx, { text: "Again." });
        expect(lastMessage(w)).not.toContain("The stories this planning session filed");

        // The filing PR merges; the next message lists both as on the base since a commit.
        await squashMergeOnRemote(repo, filingBranch);
        await lane.flush();
        pass(s.t, s.office, [
          ...indexed,
          task("TASK-4", { title: STORY_PROPOSAL.title }),
          task("TASK-5", { title: SECOND.title }),
        ]);
        await w.sessions.message(ctx, { text: "Merged?" });
        const merged = lastMessage(w);
        expect(
          merged.match(new RegExp(`state: filed, on the base since commit ${BASE_COMMIT}`, "g")),
        ).toHaveLength(2);
        expect(merged).toContain("Story: As maintainer I want to export the stories as a CSV file");

        // Ready on one final confirm sets both Ready.
        const ready = await w.sessions.ready(ctx, { stories: ["TASK-4", "task-5"] });
        expect(ready.result.refused).toEqual([]);
        expect(ready.result.queued).toEqual(["TASK-4", "TASK-5"]);
        expect(allEntries(s.office).filter((entry) => entry.kind === READY_KIND)).toHaveLength(2);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  }, 60_000);

  it("a fresh model session's first message lists the same stories", async () => {
    await withBareRemote(
      async (repo) => {
        const { w, ctx } = await setup(repo, [STORY_PROPOSAL]);
        await w.sessions.confirm(ctx, { proposal: 1 });
        // A daemon restart: the proposals of the open session are gone, the record and the journal stay.
        await w.sessions.stopAll();
        await w.sessions.continue(commandContext(w));
        const first = JSON.parse(w.plans[1]?.stdin[0] ?? "{}") as { message: { content: string } };
        const text = first.message.content;
        expect(text).toContain("- TASK-4: Export the stories as CSV");
        expect(text).toContain("state: filed, backlog PR open");
        expect(text).toContain(`Story: ${STORY_PROPOSAL.storyLine}`);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  }, 60_000);

  it("still refuses an unknown id, a typo, a dropped draft, another session's story, a proposal number and a failed proposal", async () => {
    await withBareRemote(
      async (repo) => {
        const proposals = [
          STORY_PROPOSAL,
          deps("TASK-9"),
          deps("TASK-44"),
          { ...STORY_PROPOSAL, kind: "refine", draft: "DRAFT-1", title: "A dropped draft" },
          deps("TASK-77"),
          deps("task-9"),
          { ...STORY_PROPOSAL, title: "A story on the failed one", dependencies: ["TASK-4"] },
        ];
        const { s, lane, w, ctx, indexed } = await setup(repo, proposals);
        // A draft the office had and dropped, and a story another session filed.
        pass(s.t, s.office, [...indexed, draft("DRAFT-1", { title: "A dropped draft" })]);
        pass(s.t, s.office, indexed);
        s.office.immediate(() =>
          addPlanningEntry(s.office, "other-session", {
            kind: "story",
            subject: "TASK-77",
            proposal: 1,
            text: "filed",
            at: s.t.clock.now(),
          }),
        );
        const codes = async (n: number) =>
          (
            (await w.sessions
              .confirm(ctx, { proposal: n })
              .catch((e: unknown) => e)) as CommandError
          ).error.code;
        for (const n of [2, 3, 4, 5, 6]) expect(await codes(n)).toBe("planning.storyUnknown");
        expect(allEntries(s.office)).toEqual([]);
        // A proposal number is no id: the proposal schema refuses it before any confirm.
        for (const dependency of ["3", "#3"]) {
          expect(checkProposal(deps(dependency)).ok).toBe(false);
        }

        // A proposal confirmed and then failed: its story is no dependency.
        const filed = await w.sessions.confirm(ctx, { proposal: 1 });
        expect(filed.result.stories).toEqual(["TASK-4"]);
        const change = allEntries(s.office).find((entry) => entry.kind === FILE_KIND);
        planningLane(lane).withdraw({ opId: change?.opId ?? 0 });
        expect(await codes(7)).toBe("planning.storyUnknown");
      },
      { fixture: BACKLOG_FIXTURE },
    );
  }, 60_000);
});
