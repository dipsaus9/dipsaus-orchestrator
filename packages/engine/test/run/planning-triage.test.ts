// A triage session (DIPO-454; 0022) against a real temporary repository, the office git and the
// pinned Backlog CLI: the first message lists the open drafts with their origin; a confirmed refine
// promotes a draft through the lane into a Refined story that passes the Ready gate's structure
// rules, with a branch named for its new id, and the index renumbers the draft's story to that id
// once the backlog PR merged (`story.renumbered`, same key); a confirmed drop archives a draft; a
// refine or drop of anything but an open draft is refused before anything is journaled.

import { describe, expect, it } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type OfficeId, StoryId, type StoryKey } from "@dipsaus-orchestrator/contract";
import { withBareRemote } from "@dipsaus-orchestrator/testkit";

import {
  allEntries,
  DROP_KIND,
  dropKind,
  planningLane,
  REFINE_KIND,
  refineKind,
} from "../../src/backlog/lane";
import { checkBacklogPr } from "../../src/backlog/pr/check";
import { collectPrDiff } from "../../src/backlog/pr/diff";
import { backlogStoryStore } from "../../src/backlog/store";
import { CommandError } from "../../src/commands/errors";
import { evaluateGate } from "../../src/gate";
import { readGateInput } from "../../src/gate-decisions";
import { holdIdea, passIdea, answerIdea } from "../../src/records/ideas";
import { readPlanningRecord } from "../../src/records/planning-record";
import { findStoryByKey } from "../../src/records/story-keys";
import { planningDrafts, planningFirstMessage } from "../../src/run/planning-session";
import { DEFAULT_CONFIG } from "../gate/fixtures";
import { BACKLOG_FIXTURE, inRemote, laneSetup, publish, subjects } from "../backlog/lane/helpers";
import { draft, entriesAfter, keyOf, lastSeq, pass, task } from "../stories/helpers";
import {
  blocksOf,
  commandContext,
  flushBranch,
  planningWorld,
  proposalView,
  until,
} from "./planning-world";

const STORY_LINE =
  "As maintainer I want a story list exported as CSV so that I can sort it in a spreadsheet.";

const REFINE = {
  kind: "refine",
  draft: "DRAFT-1",
  title: "Export the story list as CSV",
  type: "feature",
  milestone: "m-3",
  tier: "S",
  storyLine: STORY_LINE,
  context: "The export reads the base, as the queue does.",
  criteria: ["The export writes one CSV row per active story"],
  references: ["packages/cli/src/export-command.ts"],
  testPlan: { entries: [{ kind: "automated", check: "(unit) one CSV row per active story" }] },
  why: "The draft is ready to refine.",
} as const;

const DROP = { kind: "drop", draft: "DRAFT-2", why: "Covered by DIPO-4." } as const;

/** The task file of `id` in `dir`, by its id prefix. */
function fileOf(dir: string, id: string): string {
  const tasks = join(dir, "backlog", "tasks");
  const name = readdirSync(tasks).find((file) => file.startsWith(`${id.toLowerCase()} - `));
  if (name === undefined) throw new Error(`no task file of ${id}`);
  return readFileSync(join(tasks, name), "utf8");
}

describe("a triage session (DIPO-454)", () => {
  it("lists the drafts with their origin, refines one into a Refined story with its new id and drops another", async () => {
    await withBareRemote(
      async (repo) => {
        mkdirSync(join(repo.dir, "backlog", "milestones"), { recursive: true });
        writeFileSync(
          join(repo.dir, "backlog", "milestones", "m-3 - rituals.md"),
          '---\nid: m-3\ntitle: "M3 Rituals"\n---\n',
        );
        writeFileSync(
          join(repo.dir, "backlog", "drafts", "draft-2 - Cap-the-retries.md"),
          "---\nid: DRAFT-2\ntitle: Cap the retries\nstatus: Draft\nassignee: []\ncreated_date: '2026-10-12 11:28'\nlabels:\n  - tech-debt\ndependencies: []\n---\n\n## Description\n\n<!-- SECTION:DESCRIPTION:BEGIN -->\nStory: As maintainer I want the retries capped so that a dead host is not hammered.\n<!-- SECTION:DESCRIPTION:END -->\n",
        );
        // DRAFT-1 names a reference of its own, which the refinement keeps.
        const draftOne = join(
          repo.dir,
          "backlog",
          "drafts",
          "draft-1 - Sketch-the-export-format.md",
        );
        writeFileSync(
          draftOne,
          readFileSync(draftOne, "utf8").replace(
            "dependencies: []\n",
            "dependencies: []\nreferences:\n  - docs/export.md\n",
          ),
        );
        await publish(repo);
        const s = await laneSetup(repo);
        s.kinds.set(REFINE_KIND, refineKind);
        s.kinds.set(DROP_KIND, dropKind);
        const lane = s.lane();
        pass(s.t, s.office, [
          task("TASK-1", { title: "Add the CSV export command" }),
          draft("DRAFT-1", { title: "Sketch the export format" }),
          draft("DRAFT-2", { title: "Cap the retries" }),
        ]);
        // DRAFT-2 was filed from an idea the maintainer accepted: its origin is known.
        const key1 = keyOf(s.office, "TASK-1") as StoryKey;
        s.office.immediate(() => {
          const id = holdIdea(s.office, {
            origin: "finding",
            key: key1,
            runId: null,
            title: "Cap the retries",
            text: "They are not capped.",
            at: 0,
          });
          if (id === null) throw new Error("not held");
          passIdea(s.office, id, {
            proposal: {
              found: "f",
              evidence: [{ file: "src/a.ts", line: 1 }],
              sourceStory: StoryId.parse("TASK-1"),
              storyLine: STORY_LINE,
              proposed: "p",
              why: "w",
              serves: "tech-debt",
            },
            auditRun: "run_audit",
            at: 1,
          });
          answerIdea(s.office, id, "accepted", 2);
          s.office.run(
            "update ideas set draft_id = 'DRAFT-2' where office_id = $office_id and idea_id = $id",
            { id },
          );
        });
        expect(planningDrafts(s.office)).toEqual([
          {
            story: "DRAFT-1",
            title: "Sketch the export format",
            origin: "not recorded; filed by hand or before dipo kept it",
          },
          {
            story: "DRAFT-2",
            title: "Cap the retries",
            origin: "a reviewer's advisory finding, source story TASK-1",
          },
        ]);

        const w = planningWorld(s.t, repo.root, {
          office: s.office,
          lane: () => planningLane(lane),
        });
        w.answerText = (n) => (n === 1 ? blocksOf(REFINE, DROP) : "Noted.");
        const { run } = (
          await w.sessions.start(commandContext(w), { kind: "triage", goal: "The drafts" })
        ).result;
        const officeId = s.office.officeId as OfficeId;
        await until(() => w.sessions.view(officeId)?.state === "waiting");
        // The first message lists the drafts with their origin.
        const first = planningFirstMessage({
          kind: "triage",
          goal: "The drafts",
          record: "",
          drafts: planningDrafts(s.office),
          desk: [],
          runs: [],
          retro: "",
          commit: "c",
          preferences: null,
          proposalSchema: {},
        });
        expect(first).toContain(
          "- DRAFT-2: Cap the retries (origin: a reviewer's advisory finding, source story TASK-1)",
        );
        const ctx = commandContext(w);
        const draftKey = keyOf(s.office, "DRAFT-1") as StoryKey;

        // A confirmed refine: the draft becomes TASK-4, Refined to the standard, with its branch.
        await w.sessions.confirm(ctx, { proposal: 1 });
        await w.flushed();
        expect(proposalView(w, 1)).toMatchObject({ state: "filed", stories: ["TASK-4"] });
        const worktree = lane.worktreePath();
        const text = fileOf(worktree, "TASK-4");
        expect(text).toContain("title: Export the story list as CSV");
        expect(text).toContain("status: Refined");
        expect(text).toContain("tier:S");
        expect(text).toContain("type: feature");
        expect(text).toContain("milestone: m-3");
        expect(text).toContain(`Story: ${STORY_LINE}`);
        expect(text).toContain("- [ ] #1 The export writes one CSV row per active story");
        expect(text).toContain('branch: "TASK-4/export-story-list-as-csv"');
        expect(text).toContain("unknowns: []");
        // `--ref` replaces the list: the draft's reference stays next to the refinement's.
        expect(text).toContain("  - docs/export.md");
        expect(text).toContain("  - packages/cli/src/export-command.ts");
        expect(
          readdirSync(join(worktree, "backlog", "drafts")).filter((n) => n.startsWith("draft-1")),
        ).toEqual([]);
        const input = await readGateInput(
          backlogStoryStore(s.cli),
          worktree,
          "TASK-4",
          DEFAULT_CONFIG,
        );
        expect(evaluateGate(input, "ready").failures).toEqual([]);
        expect(
          s.office.get<{ promoted_to: string | null }>(
            "select promoted_to from stories where office_id = $office_id and key = $key",
            { key: draftKey },
          ),
        ).toEqual({ promoted_to: "TASK-4" });

        // A confirmed drop archives DRAFT-2.
        await w.sessions.confirm(ctx, { proposal: 2 });
        await w.flushed();
        expect(proposalView(w, 2)?.state).toBe("filed");
        expect(
          readdirSync(join(worktree, "backlog", "drafts")).filter((n) => n.startsWith("draft-2")),
        ).toEqual([]);

        expect(
          readPlanningRecord(s.office, run)
            .filter((entry) => entry.kind === "story")
            .map((entry) => [entry.proposal, entry.text, entry.subject]),
        ).toEqual([[1, "filed", "TASK-4"]]);
        const branch = flushBranch(w);
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

        // Once the backlog PR merged, the index sees TASK-4 and no DRAFT-1: the story keeps its key.
        const before = lastSeq(s.office);
        pass(s.t, s.office, [
          task("TASK-1", { title: "Add the CSV export command" }),
          task("TASK-4", { title: "Export the story list as CSV" }),
        ]);
        expect(String(findStoryByKey(s.office, draftKey)?.story)).toBe("TASK-4");
        const logged = entriesAfter(s.office, before);
        expect(logged.filter((entry) => entry.type === "story.renumbered")).toMatchObject([
          { delta: { key: draftKey, from: "DRAFT-1", to: "TASK-4", detectedBy: "engine" } },
        ]);
        expect(
          logged.filter(
            (entry) =>
              entry.type === "engine.notice" &&
              (entry.delta as { code?: string }).code === "story.removed" &&
              entry.key === draftKey,
          ),
        ).toEqual([]);
        expect(allEntries(s.office).map((entry) => entry.kind)).toEqual([REFINE_KIND, DROP_KIND]);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  }, 30_000);

  it("refuses a refine or drop of a task or of a draft the office does not have", async () => {
    await withBareRemote(
      async (repo) => {
        await publish(repo);
        const s = await laneSetup(repo);
        s.kinds.set(REFINE_KIND, refineKind);
        const lane = s.lane();
        pass(s.t, s.office, [
          task("TASK-1", { title: "Add the CSV export command" }),
          draft("DRAFT-1", { title: "Sketch the export format" }),
        ]);
        const w = planningWorld(s.t, repo.root, {
          office: s.office,
          lane: () => planningLane(lane),
        });
        w.answerText = () =>
          blocksOf(
            { ...REFINE, draft: "DRAFT-9" },
            { ...DROP, draft: "DRAFT-9" },
            { ...REFINE, title: "Add the CSV export command" },
          );
        await w.sessions.start(commandContext(w), { kind: "triage", goal: "Drafts" });
        await until(() => w.sessions.view(s.office.officeId as OfficeId)?.state === "waiting");
        const ctx = commandContext(w);
        const codes = [];
        for (const proposal of [1, 2, 3]) {
          const refused = await w.sessions
            .confirm(ctx, { proposal })
            .catch((error: unknown) => error);
          codes.push((refused as CommandError).error.code);
        }
        expect(codes).toEqual([
          "planning.storyUnknown",
          "planning.storyUnknown",
          "planning.duplicate",
        ]);
        expect(allEntries(s.office)).toEqual([]);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  }, 30_000);
});
