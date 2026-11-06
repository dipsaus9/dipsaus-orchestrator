// A planning session's confirmed proposals filed through the planning lane (DIPO-450), against a
// real temporary repository, the office git and the pinned Backlog CLI: a confirmed story is filed
// Refined to the story standard with its tier label (the Ready gate's structure rules pass it) and
// its id goes into the session's record; a confirmed edit changes the story's title, Story line,
// context, criteria and references and keeps its field block; a split files the new story and
// edits the old one; a decline files nothing. Every change is one `backlog:` commit on dipo's
// backlog branch, which the backlog PR's structural check passes.

import { describe, expect, it } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type OfficeId, PlanningView } from "@dipsaus-orchestrator/contract";
import { withBareRemote } from "@dipsaus-orchestrator/testkit";

import {
  allEntries,
  FILE_KIND,
  fileKind,
  planningLane,
  REVISE_KIND,
  reviseKind,
} from "../../src/backlog/lane";
import { checkBacklogPr } from "../../src/backlog/pr/check";
import { collectPrDiff } from "../../src/backlog/pr/diff";
import { backlogStoryStore } from "../../src/backlog/store";
import { CommandError } from "../../src/commands/errors";
import { evaluateGate } from "../../src/gate";
import { readGateInput } from "../../src/gate-decisions";
import { planningRecord } from "../../src/records/planning-record";
import { DEFAULT_CONFIG } from "../gate/fixtures";
import {
  BACKLOG_FIXTURE,
  inRemote,
  laneSetup,
  publish,
  subjects,
  taskFile,
} from "../backlog/lane/helpers";
import { pass, task } from "../stories/helpers";
import { blocksOf, commandContext, planningWorld, STORY_PROPOSAL, until } from "./planning-world";

const EDIT = {
  kind: "edit",
  id: "TASK-2",
  title: "Rename the export setting everywhere",
  storyLine:
    "As maintainer I want the export setting to have one name in every file so that I never guess which name applies.",
  context: "The setting is read in two places today.",
  criteria: ["The setting is called exportFormat in the CLI", "The old name is read once more"],
  references: ["packages/cli/src/export-command.ts"],
  why: "Two names confuse the maintainer.",
} as const;

const SPLIT = {
  kind: "split",
  id: "TASK-3",
  edit: { criteria: ["JSON export writes one object per story"] },
  story: {
    title: "Export the stories as JSON lines",
    type: "feature",
    milestone: "m-3",
    tier: "S",
    storyLine:
      "As maintainer I want the stories exported as JSON lines so that a script can read them one by one.",
    criteria: ["Each line holds one story as a JSON object"],
    references: ["packages/cli/src/export-command.ts"],
    dependencies: ["TASK-3"],
    testPlan: { notApplicable: "Covered by the JSON export's own tests" },
  },
  why: "The JSON export grew two outputs.",
} as const;

const DECLINED = { ...STORY_PROPOSAL, title: "Export the stories as XML" } as const;

/** The task file of `id` in `dir`, by its id prefix. */
function fileOf(dir: string, id: string): string {
  const tasks = join(dir, "backlog", "tasks");
  const name = readdirSync(tasks).find((file) => file.startsWith(`${id.toLowerCase()} - `));
  if (name === undefined) throw new Error(`no task file of ${id}`);
  return readFileSync(join(tasks, name), "utf8");
}

describe("filing a planning session's confirmed proposals through the lane (DIPO-450)", () => {
  // Real git and the Backlog CLI: a few seconds alone, more in a loaded shard.
  it("files a story Refined to the standard, edits, splits and declines, and records the ids", async () => {
    await withBareRemote(
      async (repo) => {
        // The milestone the stories name exists, as the Ready gate's R07 needs.
        mkdirSync(join(repo.dir, "backlog", "milestones"), { recursive: true });
        writeFileSync(
          join(repo.dir, "backlog", "milestones", "m-3 - rituals.md"),
          '---\nid: m-3\ntitle: "M3 Rituals"\n---\n',
        );
        await publish(repo);
        const s = await laneSetup(repo);
        s.kinds.set(FILE_KIND, fileKind);
        s.kinds.set(REVISE_KIND, reviseKind);
        const lane = s.lane();
        pass(s.t, s.office, [
          task("TASK-1", { title: "Add the CSV export command", status: "Ready" }),
          task("TASK-2", { title: "Rename the export setting" }),
          task("TASK-3", { title: "Export stories as JSON", status: "Parked" }),
        ]);
        const w = planningWorld(s.t, repo.root, {
          office: s.office,
          lane: () => planningLane(lane),
        });
        w.answerText = (n) =>
          n === 1
            ? blocksOf({ ...STORY_PROPOSAL, dependencies: ["TASK-1"] }, EDIT, SPLIT, DECLINED)
            : "Noted.";
        const { run } = (
          await w.sessions.start(commandContext(w), { kind: "plan", goal: "Export" })
        ).result;
        const officeId = s.office.officeId as OfficeId;
        await until(() => w.sessions.view(officeId)?.state === "waiting");
        const ctx = commandContext(w);
        expect(w.sessions.view(officeId)?.proposals?.map((p) => p.state)).toEqual([
          "open",
          "open",
          "open",
          "open",
        ]);

        // A decline files nothing: no journal entry, no task.
        expect((await w.sessions.decline(ctx, { proposal: 4 })).result.state).toBe("declined");
        expect(allEntries(s.office)).toEqual([]);
        const declined = await w.sessions
          .confirm(ctx, { proposal: 4 })
          .catch((error: unknown) => error);
        expect((declined as CommandError).error.code).toBe("planning.proposalClosed");

        // A confirmed story: filed Refined, with its tier label, type, milestone, criteria,
        // references, dependency and field block, on dipo's backlog branch.
        const filed = await w.sessions.confirm(ctx, { proposal: 1 });
        expect(filed.result).toMatchObject({
          run,
          proposal: 1,
          state: "filed",
          stories: ["TASK-4"],
        });
        expect(filed.result.flush).toMatchObject({ state: "pushed" });
        const worktree = lane.worktreePath();
        const text = fileOf(worktree, "TASK-4");
        expect(text).toContain("title: Export the stories as CSV");
        expect(text).toContain("status: Refined");
        expect(text).toContain("tier:M");
        expect(text).toContain("type: feature");
        expect(text).toContain("milestone: m-3");
        expect(text).toContain("- TASK-1");
        expect(text).toContain(`Story: ${STORY_PROPOSAL.storyLine}`);
        expect(text).toContain("The export reads the base, as the queue does.");
        expect(text).toContain("- [ ] #1 The export writes one CSV row per active story");
        expect(text).toContain("- [ ] #2 A Done story is left out of it");
        expect(text).toContain("packages/cli/src/export-command.ts");
        expect(text).toContain('branch: "TASK-4/export-stories-as-csv"');
        expect(text).toContain("unknowns: []");
        expect(text).toContain('check: "(unit) one CSV row per active story"');
        expect(text).toContain('expect: "One row per story opens in a spreadsheet"');
        // The story standard: every structure rule of the Ready gate passes but R01a's status, which
        // only the maintainer's Ready confirm changes (DIPO-451).
        const input = await readGateInput(
          backlogStoryStore(s.cli),
          worktree,
          "TASK-4",
          DEFAULT_CONFIG,
        );
        expect(evaluateGate(input, "ready").failures).toEqual([]);

        // A confirmed edit: title, Story line, context, criteria and references; the block stays.
        const edited = await w.sessions.confirm(ctx, { proposal: 2 });
        expect(edited.result).toMatchObject({ state: "filed", stories: ["TASK-2"] });
        const renamed = fileOf(worktree, "TASK-2");
        expect(renamed).toContain("title: Rename the export setting everywhere");
        expect(renamed).toContain(`Story: ${EDIT.storyLine}`);
        expect(renamed).toContain("The setting is read in two places today.");
        expect(renamed).not.toContain(
          "so that I never guess which name applies.\n\n```dipo\nunknowns",
        );
        expect(renamed).toContain("- [ ] #1 The setting is called exportFormat in the CLI");
        expect(renamed).toContain("- [ ] #2 The old name is read once more");
        expect(renamed).not.toContain("The setting is called exportFormat everywhere");
        expect(renamed).toContain("packages/cli/src/export-command.ts");
        expect(renamed).toContain(
          'not_applicable: "A pure rename; existing tests cover the behaviour unchanged"',
        );

        // A confirmed split: the new story is filed and the old one edited.
        const split = await w.sessions.confirm(ctx, { proposal: 3 });
        expect(split.result).toMatchObject({ state: "filed", stories: ["TASK-5", "TASK-3"] });
        expect(fileOf(worktree, "TASK-5")).toContain("title: Export the stories as JSON lines");
        expect(fileOf(worktree, "TASK-5")).toContain("tier:S");
        expect(fileOf(worktree, "TASK-3")).toContain(
          "- [ ] #1 JSON export writes one object per story",
        );

        // Confirming a filed proposal changes nothing.
        expect((await w.sessions.confirm(ctx, { proposal: 1 })).changed).toBe(false);

        // The session's record holds every filed and edited id.
        expect(
          planningRecord(s.office, run).map((entry) => [entry.proposal, entry.kind, entry.story]),
        ).toEqual([
          [1, "filed", "TASK-4"],
          [2, "edited", "TASK-2"],
          [3, "filed", "TASK-5"],
          [3, "edited", "TASK-3"],
        ]);
        const view = PlanningView.parse(w.sessions.view(officeId));
        expect(view.proposals?.map((p) => [p.n, p.state, p.stories ?? []])).toEqual([
          [1, "filed", ["TASK-4"]],
          [2, "filed", ["TASK-2"]],
          [3, "filed", ["TASK-5", "TASK-3"]],
          [4, "declined", []],
        ]);

        // One commit per change on one backlog branch, which the structural check passes.
        const branch = filed.result.flush?.state === "pushed" ? filed.result.flush.branch : "";
        expect(await subjects(repo.remote, repo.home, branch, "main")).toEqual([
          "backlog: file a new story",
          "backlog: revise TASK-2",
          "backlog: file a new story",
          "backlog: revise TASK-3",
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

        // The maintainer's next message tells the session what was filed and declined.
        await w.sessions.message(ctx, { text: "Next." });
        const last =
          w.sent
            .at(-1)
            ?.flatMap((op) => ("write" in op ? [op.write] : []))
            .join("") ?? "";
        expect(last).toContain("[dipo] The maintainer confirmed proposal 1: TASK-4");
        expect(last).toContain("[dipo] The maintainer declined proposal 4");
        expect(readFileSync(taskFile(repo.dir, "TASK-2"), "utf8")).toContain(
          "title: Rename the export setting\n",
        );
      },
      { fixture: BACKLOG_FIXTURE },
    );
  }, 30_000);

  it("refuses a duplicate title, an unknown dependency and an edit of a task that is not Refined, Ready or Parked", async () => {
    await withBareRemote(
      async (repo) => {
        await publish(repo);
        const s = await laneSetup(repo);
        s.kinds.set(FILE_KIND, fileKind);
        s.kinds.set(REVISE_KIND, reviseKind);
        const lane = s.lane();
        pass(s.t, s.office, [
          task("TASK-1", { title: "Add the CSV export command", status: "In Progress" }),
          task("TASK-2", { title: "Rename the export setting" }),
        ]);
        const w = planningWorld(s.t, repo.root, {
          office: s.office,
          lane: () => planningLane(lane),
        });
        w.answerText = () =>
          blocksOf(
            { ...STORY_PROPOSAL, title: "Rename the export setting" },
            { ...STORY_PROPOSAL, dependencies: ["TASK-9"] },
            { ...EDIT, id: "TASK-1" },
            { ...EDIT, id: "TASK-77" },
          );
        await w.sessions.start(commandContext(w), { kind: "plan", goal: "Export" });
        await until(() => w.sessions.view(s.office.officeId as OfficeId)?.state === "waiting");
        const ctx = commandContext(w);
        const codes = [];
        for (const proposal of [1, 2, 3, 4]) {
          const refused = await w.sessions
            .confirm(ctx, { proposal })
            .catch((error: unknown) => error);
          codes.push((refused as CommandError).error.code);
        }
        expect(codes).toEqual([
          "planning.duplicate",
          "planning.storyUnknown",
          "planning.storyUnknown",
          "planning.storyUnknown",
        ]);
        expect(allEntries(s.office)).toEqual([]);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  }, 30_000);
});
