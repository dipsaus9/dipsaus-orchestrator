// A triage session (DIPO-454, 0022) against a real temporary repository, the office git and the
// pinned Backlog CLI: its first message lists the open drafts with their origin (the idea the
// maintainer accepted, with its source story, or none); a confirmed refine promotes a draft
// through the planning lane into a story Refined to the story standard, with a branch named for
// its new id, and the story index then renumbers the draft's story (`story.renumbered`) instead of
// closing it; a confirmed drop archives the draft. Every change is one `backlog:` commit on dipo's
// backlog branch, which the backlog PR's structural check passes.

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type OfficeId, StoryId } from "@dipsaus-orchestrator/contract";
import { withBareRemote } from "@dipsaus-orchestrator/testkit";

import { DROP_KIND, dropKind, REFINE_KIND, refineKind } from "../../src/backlog/lane";
import { planningLane } from "../../src/backlog/lane";
import { checkBacklogPr } from "../../src/backlog/pr/check";
import { collectPrDiff } from "../../src/backlog/pr/diff";
import { backlogStoryStore } from "../../src/backlog/store";
import { evaluateGate } from "../../src/gate";
import { readGateInput } from "../../src/gate-decisions";
import { decideIdea, recordIdeaDraft } from "../../src/records/ideas";
import { planningRecord } from "../../src/records/planning-record";
import { resolveStoryRef } from "../../src/records/story-keys";
import { DEFAULT_CONFIG } from "../gate/fixtures";
import { BACKLOG_FIXTURE, inRemote, laneSetup, publish, subjects } from "../backlog/lane/helpers";
import { draft, entriesAfter, pass, task } from "../stories/helpers";
import { passedIdea } from "./idea-fixture";
import { blocksOf, commandContext, planningWorld, STORY_PROPOSAL, until } from "./planning-world";

const REFINE = {
  ...STORY_PROPOSAL,
  kind: "refine",
  draft: "DRAFT-1",
  why: "The export idea is ready to be a story.",
} as const;

const DROP = { kind: "drop", draft: "DRAFT-2", why: "TASK-1 covers it." } as const;

/** The file of `id` under `dir`'s backlog `folder`, by its id prefix; null when there is none. */
function fileOf(dir: string, folder: string, id: string): string | null {
  const path = join(dir, "backlog", folder);
  if (!existsSync(path)) return null;
  const name = readdirSync(path).find((file) => file.startsWith(`${id.toLowerCase()} - `));
  return name === undefined ? null : readFileSync(join(path, name), "utf8");
}

describe("a triage session refines and drops drafts through the lane (DIPO-454)", () => {
  // Real git and the Backlog CLI: a few seconds alone, more in a loaded shard.
  it("lists the drafts with their origin, refines one into a Refined story with a branch of its new id, renumbers it, and drops one", async () => {
    await withBareRemote(
      async (repo) => {
        // The milestone the story names exists, as the Ready gate's R07 needs; a second draft
        // is the one an accepted idea filed.
        mkdirSync(join(repo.dir, "backlog", "milestones"), { recursive: true });
        writeFileSync(
          join(repo.dir, "backlog", "milestones", "m-3 - rituals.md"),
          '---\nid: m-3\ntitle: "M3 Rituals"\n---\n',
        );
        writeFileSync(
          join(repo.dir, "backlog", "drafts", "draft-2 - Cap-the-PR-poll-retry.md"),
          [
            "---",
            "id: DRAFT-2",
            "title: Cap the PR poll retry",
            "status: Draft",
            "assignee: []",
            "created_date: '2026-11-06 10:00'",
            "labels:",
            "  - tech-debt",
            "dependencies: []",
            "---",
            "",
            "## Description",
            "",
            "<!-- SECTION:DESCRIPTION:BEGIN -->",
            "An idea dipo's audit passed.",
            "<!-- SECTION:DESCRIPTION:END -->",
            "",
          ].join("\n"),
        );
        await publish(repo);
        const s = await laneSetup(repo);
        s.kinds.set(REFINE_KIND, refineKind);
        s.kinds.set(DROP_KIND, dropKind);
        const lane = s.lane();
        pass(s.t, s.office, [
          task("TASK-1", { title: "Add the CSV export command", status: "Ready" }),
          task("TASK-2", { title: "Rename the export setting" }),
          task("TASK-3", { title: "Export stories as JSON", status: "Parked" }),
          draft("DRAFT-1", { title: "Sketch the export format" }),
          draft("DRAFT-2", { title: "Cap the PR poll retry" }),
        ]);
        const draftKey = resolveStoryRef(s.office, "DRAFT-1");
        if (!draftKey.ok) throw new Error("DRAFT-1 is not indexed");
        // DRAFT-2 is the draft the maintainer's accept of an idea of TASK-3 filed.
        const task3 = resolveStoryRef(s.office, "TASK-3");
        const idea = passedIdea(s.office, {
          key: task3.ok ? task3.key : null,
          story: StoryId.parse("TASK-3"),
          title: "Cap the PR poll retry",
          at: 0,
          proposal: { serves: "tech-debt" },
        });
        s.office.immediate(() => {
          decideIdea(s.office, idea, "accepted", 1);
          recordIdeaDraft(s.office, idea, "DRAFT-2");
        });

        const w = planningWorld(s.t, repo.root, {
          office: s.office,
          lane: () => planningLane(lane),
        });
        w.answerText = (n) => (n === 1 ? blocksOf(REFINE, DROP) : "Noted.");
        const { run } = (
          await w.sessions.start(commandContext(w), { kind: "triage", goal: "The open drafts" })
        ).result;
        const officeId = s.office.officeId as OfficeId;
        await until(() => w.sessions.view(officeId)?.state === "waiting");

        // The first message lists each draft with its origin.
        const first = JSON.parse(w.plans[0]?.stdin[0] ?? "{}") as { message: { content: string } };
        expect(first.message.content).toContain(
          [
            "<drafts>",
            "- DRAFT-1: Sketch the export format (origin: filed without an idea of dipo's)",
            `- DRAFT-2: Cap the PR poll retry (origin: a worker's proposal of TASK-3 (idea ${idea.slice(0, 12)}))`,
            "</drafts>",
          ].join("\n"),
        );
        expect(w.sessions.view(officeId)?.proposals?.map((p) => p.proposal.kind)).toEqual([
          "refine",
          "drop",
        ]);

        // The confirmed refine: DRAFT-1 is promoted to TASK-4, Refined to the standard, with a
        // branch named for its new id.
        const ctx = commandContext(w);
        const refined = await w.sessions.confirm(ctx, { proposal: 1 });
        expect(refined.result).toMatchObject({
          run,
          proposal: 1,
          state: "filed",
          stories: ["TASK-4"],
        });
        const worktree = lane.worktreePath();
        expect(fileOf(worktree, "drafts", "DRAFT-1")).toBeNull();
        const text = fileOf(worktree, "tasks", "TASK-4") ?? "";
        expect(text).toContain("title: Export the stories as CSV");
        expect(text).toContain("status: Refined");
        expect(text).toContain("tier:M");
        expect(text).toContain("type: feature");
        expect(text).toContain("milestone: m-3");
        expect(text).toContain(`Story: ${STORY_PROPOSAL.storyLine}`);
        expect(text).toContain("The export reads the base, as the queue does.");
        expect(text).toContain("- [ ] #1 The export writes one CSV row per active story");
        expect(text).toContain("packages/cli/src/export-command.ts");
        expect(text).toContain('branch: "TASK-4/export-stories-as-csv"');
        expect(text).toContain("unknowns: []");
        // The story standard: every structure rule of the Ready gate passes.
        const input = await readGateInput(
          backlogStoryStore(s.cli),
          worktree,
          "TASK-4",
          DEFAULT_CONFIG,
        );
        expect(evaluateGate(input, "ready").failures).toEqual([]);
        expect(planningRecord(s.office, run).map((entry) => [entry.kind, entry.story])).toEqual([
          ["refined", "TASK-4"],
        ]);

        // The confirmed drop archives DRAFT-2.
        const dropped = await w.sessions.confirm(ctx, { proposal: 2 });
        expect(dropped.result).toMatchObject({ proposal: 2, state: "filed" });
        expect(fileOf(worktree, "drafts", "DRAFT-2")).toBeNull();
        expect(fileOf(worktree, "archive/drafts", "DRAFT-2")).toContain("Cap the PR poll retry");

        // One commit per change on one backlog branch, which the structural check passes.
        const branch = refined.result.flush?.state === "pushed" ? refined.result.flush.branch : "";
        expect(await subjects(repo.remote, repo.home, branch, "main")).toEqual([
          "backlog: refine DRAFT-1",
          "backlog: drop DRAFT-2",
        ]);
        const base = (await inRemote(repo, "rev-parse", "main")).trim();
        const head = (await inRemote(repo, "rev-parse", branch)).trim();
        const diff = await s.git.run(async (git) => {
          const location = s.git.worktreeLocation(worktree);
          if (location.kind !== "worktree") throw new Error("expected the backlog worktree");
          return collectPrDiff({ git, worktree: location, cli: s.cli, base, head });
        });
        expect(checkBacklogPr(diff, { keys: {}, claimed: [], passing: {} })).toMatchObject({
          passed: true,
          failures: [],
        });

        // Once the index reads the promotion, the draft's story is renumbered, not closed.
        const seq = entriesAfter(s.office).at(-1)?.seq ?? 0;
        pass(s.t, s.office, [
          task("TASK-1", { title: "Add the CSV export command", status: "Ready" }),
          task("TASK-2", { title: "Rename the export setting" }),
          task("TASK-3", { title: "Export stories as JSON", status: "Parked" }),
          task("TASK-4", { title: "Export the stories as CSV" }),
        ]);
        const after = entriesAfter(s.office, seq);
        expect(after.filter((entry) => entry.type === "story.renumbered")).toEqual([
          expect.objectContaining({
            key: draftKey.key,
            delta: { key: draftKey.key, from: "DRAFT-1", to: "TASK-4", detectedBy: "engine" },
          }),
        ]);
        expect(resolveStoryRef(s.office, "TASK-4")).toMatchObject({ ok: true, key: draftKey.key });
        // DRAFT-1 now names the same story, as a former id; the dropped draft is closed.
        expect(resolveStoryRef(s.office, "DRAFT-1")).toMatchObject({ ok: true, key: draftKey.key });
        const removed = after.filter(
          (entry) => entry.type === "engine.notice" && entry.delta["code"] === "story.removed",
        );
        expect(removed.map((entry) => entry.delta["text"])).toEqual([
          expect.stringMatching(/^DRAFT-2 is no longer an active task or draft/),
        ]);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  }, 30_000);
});
