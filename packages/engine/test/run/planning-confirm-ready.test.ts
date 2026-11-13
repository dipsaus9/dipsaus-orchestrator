// Confirm = Ready (DIPO-495, 0012, 0022) through a planning session, the real planning lane, the
// pinned Backlog CLI and the real Ready gate on a temporary repository, for each bypass form: a
// split whose new part passes and whose narrowed Ready part fails files the new part Ready and sets
// the narrowed one Refined with the gate's messages, and the reverse; a refine of a passing draft is
// filed Ready; an edit of a Ready story that keeps passing leaves it Ready, one that breaks a gated
// field sets it Refined with the gate's messages, and an edit of a Refined story keeps it Refined
// though it would pass now; a story whose content reads back other than the content the gate passed
// is not filed Ready. dipo's structural check passes the one backlog PR all of it lands in.

import { describe, expect, it } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type OfficeId, PlanningView } from "@dipsaus-orchestrator/contract";
import { withBareRemote } from "@dipsaus-orchestrator/testkit";

import {
  FILE_KIND,
  fileKind,
  planningLane,
  REFINE_KIND,
  refineKind,
  REVISE_KIND,
  reviseKind,
} from "../../src/backlog/lane";
import { checkBacklogPr } from "../../src/backlog/pr/check";
import { collectPrDiff } from "../../src/backlog/pr/diff";
import { factsFor } from "../../src/backlog/pr/feature";
import type { GateStore } from "../../src/gate-decisions";
import { BACKLOG_FIXTURE, inRemote, laneSetup, publish } from "../backlog/lane/helpers";
import { draft, pass, task } from "../stories/helpers";
import {
  blocksOf,
  commandContext,
  laneGate,
  planningWorld,
  STORY_PROPOSAL,
  until,
} from "./planning-world";

/** A criterion the gate fails for its vague phrase (R10). */
const VAGUE_CRITERION = "The export handles every story properly";

/** A Ready task file of `id` that passes the Ready gate, as Backlog.md 1.53 writes one. */
function readyTask(id: number, title: string, status = "Ready"): string {
  return [
    "---",
    `id: TASK-${id}`,
    `title: ${title}`,
    `status: ${status}`,
    "assignee: []",
    "created_date: '2026-10-12 11:28'",
    "labels:",
    "  - 'tier:M'",
    "milestone: m-3",
    "dependencies: []",
    "references:",
    "  - packages/cli/src/export-command.ts",
    "type: feature",
    "---",
    "",
    "## Description",
    "",
    "<!-- SECTION:DESCRIPTION:BEGIN -->",
    `Story: As maintainer I want ${title.toLowerCase()} so that I can share the backlog with people outside dipo.`,
    "",
    "```dipo",
    `branch: "TASK-${id}/story-${id}"`,
    "unknowns: []",
    "test_plan:",
    "  entries:",
    '    - kind: "automated"',
    '      check: "(unit) one row per active story"',
    "```",
    "<!-- SECTION:DESCRIPTION:END -->",
    "",
    "## Acceptance Criteria",
    "<!-- AC:BEGIN -->",
    "- [ ] #1 The export writes one row per active story",
    "<!-- AC:END -->",
    "",
  ].join("\n");
}

const NEW_PART = {
  title: "Export the stories as JSON lines",
  type: "feature",
  milestone: "m-3",
  tier: "S",
  storyLine:
    "As maintainer I want the stories exported as JSON lines so that a script can read them one by one.",
  criteria: ["Each line holds one story as a JSON object"],
  references: ["packages/cli/src/export-command.ts"],
  testPlan: { notApplicable: "Covered by the JSON export's own tests" },
} as const;

const PROPOSALS = [
  // 1. The new part passes, the narrowed Ready part fails.
  {
    kind: "split",
    id: "TASK-4",
    edit: { criteria: [VAGUE_CRITERION] },
    story: NEW_PART,
    why: "The export grew two outputs.",
  },
  // 2. The reverse: the narrowed Ready part passes, the new part fails.
  {
    kind: "split",
    id: "TASK-5",
    edit: { title: "Export the stories as TSV" },
    story: { ...NEW_PART, title: "Export the stories as YAML", criteria: [VAGUE_CRITERION] },
    why: "The export grew two outputs.",
  },
  // 3. An edit of a Ready story that breaks a gated field.
  { kind: "edit", id: "TASK-6", criteria: [VAGUE_CRITERION], why: "Say it shorter." },
  // 4. An edit of a Ready story that keeps it passing.
  { kind: "edit", id: "TASK-7", context: "The export reads the base.", why: "Say where it reads." },
  // 5. An edit of a Refined story: no Ready choice, though it would pass now.
  { kind: "edit", id: "TASK-8", title: "Export the archive as CSV", why: "A clearer name." },
  // 6. A refine of a draft that passes.
  {
    kind: "refine",
    draft: "DRAFT-1",
    title: "Export the story list as CSV",
    type: "feature",
    milestone: "m-3",
    tier: "S",
    storyLine:
      "As maintainer I want a story list exported as CSV so that I can sort it in a spreadsheet.",
    criteria: ["The export writes one CSV row per active story"],
    references: ["packages/cli/src/export-command.ts"],
    testPlan: { entries: [{ kind: "automated", check: "(unit) one CSV row per active story" }] },
    why: "The draft is ready to refine.",
  },
  // 7. A new story whose content changes between the gate and the read-back.
  { ...STORY_PROPOSAL, title: "Export the stories as HTML" },
];

/** The status line of the task file of `id` in `dir`. */
function statusOf(dir: string, id: string): string {
  const tasks = join(dir, "backlog", "tasks");
  const name = readdirSync(tasks).find((file) => file.startsWith(`${id.toLowerCase()} - `));
  if (name === undefined) throw new Error(`no task file of ${id}`);
  return /^status: (.*)$/m.exec(readFileSync(join(tasks, name), "utf8"))?.[1] ?? "";
}

describe("a confirm sets Ready only what the gate passes as filed (DIPO-495)", () => {
  it("gates each split part, a refine and each edit of a Ready story in the operation that files it", async () => {
    await withBareRemote(
      async (repo) => {
        mkdirSync(join(repo.dir, "backlog", "milestones"), { recursive: true });
        writeFileSync(
          join(repo.dir, "backlog", "milestones", "m-3 - rituals.md"),
          '---\nid: m-3\ntitle: "M3 Rituals"\n---\n',
        );
        const titles: Record<number, string> = {
          4: "Export the stories as CSV files",
          5: "Export the stories as text",
          6: "Export the stories as rows",
          7: "Export the stories as lines",
          8: "Export the archive",
        };
        for (const [id, title] of Object.entries(titles)) {
          writeFileSync(
            join(repo.dir, "backlog", "tasks", `task-${id} - Story-${id}.md`),
            readyTask(Number(id), title, id === "8" ? "Refined" : "Ready"),
          );
        }
        await publish(repo);
        const s = await laneSetup(repo);
        for (const kind of [fileKind, reviseKind, refineKind]) s.kinds.set(kind.kind, kind);
        expect([...s.kinds.keys()]).toEqual(
          expect.arrayContaining([FILE_KIND, REVISE_KIND, REFINE_KIND]),
        );
        // The gate as the lane runs it; for the HTML story the file changes after the gate passed it.
        const real = laneGate(s);
        const gate: Pick<GateStore, "recordLaneDecision"> = {
          recordLaneDecision: async (office, story, key, cwd) => {
            const decision = await real.recordLaneDecision(office, story, key, cwd);
            const tasks = join(cwd, "backlog", "tasks");
            for (const name of readdirSync(tasks).filter((file) =>
              file.startsWith(`${story.toLowerCase()} - `),
            )) {
              const text = readFileSync(join(tasks, name), "utf8");
              if (text.includes("title: Export the stories as HTML")) {
                writeFileSync(join(tasks, name), text.replace("as HTML", "as HTML pages"));
              }
            }
            return decision;
          },
        };
        const lane = s.lane({ gate });
        pass(s.t, s.office, [
          task("TASK-1", { title: "Add the CSV export command", status: "Ready" }),
          task("TASK-2", { title: "Rename the export setting" }),
          task("TASK-3", { title: "Export stories as JSON", status: "Parked" }),
          ...[4, 5, 6, 7, 8].map((id) =>
            task(`TASK-${id}`, { title: titles[id] ?? "", status: id === 8 ? "Refined" : "Ready" }),
          ),
          draft("DRAFT-1", { title: "Sketch the export format" }),
        ]);
        const w = planningWorld(s.t, repo.root, {
          office: s.office,
          lane: () => planningLane(lane),
        });
        w.answerText = (n) => (n === 1 ? blocksOf(...PROPOSALS) : "Noted.");
        await w.sessions.start(commandContext(w), { kind: "plan", goal: "Export" });
        const officeId = s.office.officeId as OfficeId;
        await until(() => w.sessions.view(officeId)?.state === "waiting");
        const ctx = commandContext(w);
        const filed: string[][] = [];
        for (const proposal of PROPOSALS.keys()) {
          const confirmed = await w.sessions.confirm(ctx, { proposal: proposal + 1 });
          expect(confirmed.result.state).toBe("filed");
          filed.push(confirmed.result.stories);
        }
        const [newPart, yaml, refined, html] = [
          filed[0]?.[0] ?? "",
          filed[1]?.[0] ?? "",
          filed[5]?.[0] ?? "",
          filed[6]?.[0] ?? "",
        ];
        const worktree = lane.worktreePath();
        expect(
          Object.fromEntries(
            [newPart, "TASK-4", yaml, "TASK-5", "TASK-6", "TASK-7", "TASK-8", refined, html].map(
              (id) => [id, statusOf(worktree, id)],
            ),
          ),
        ).toEqual({
          [newPart]: "Ready",
          "TASK-4": "Refined",
          [yaml]: "Refined",
          "TASK-5": "Ready",
          "TASK-6": "Refined",
          "TASK-7": "Ready",
          "TASK-8": "Refined",
          [refined]: "Ready",
          [html]: "Refined",
        });

        // The view says, per story, what the gate decided; a revision of a Refined story says nothing.
        const view = PlanningView.parse(w.sessions.view(officeId));
        const said = view.proposals?.map((p) => p.gate ?? []) ?? [];
        expect(said[0]).toEqual([
          `${newPart} is Ready: the Ready gate passed it`,
          expect.stringContaining(
            'TASK-4 is Refined: ready TASK-4 failed R10: criterion #1 contains vague phrase "properly"',
          ),
        ]);
        expect(said[1]).toEqual([
          expect.stringContaining(`${yaml} is Refined: ready ${yaml} failed R10: `),
          "TASK-5 is Ready: the Ready gate passed it",
        ]);
        expect(said[2]).toEqual([
          expect.stringContaining("TASK-6 is Refined: ready TASK-6 failed R10: "),
        ]);
        expect(said[3]).toEqual(["TASK-7 is Ready: the Ready gate passed it"]);
        expect(said[4]).toEqual([]);
        expect(said[5]).toEqual([`${refined} is Ready: the Ready gate passed it`]);
        expect(said[6]).toEqual([
          `${html} is Refined: it read back with other content than the Ready gate passed; set it Ready from the Queue once it is on the base`,
        ]);

        // All of it is one backlog PR that dipo's structural check passes.
        const branch = (
          await inRemote(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/dipo/")
        ).trim();
        expect(branch.split("\n")).toHaveLength(1);
        const base = (await inRemote(repo, "rev-parse", "main")).trim();
        const head = (await inRemote(repo, "rev-parse", branch)).trim();
        const diff = await s.git.run(async (session) => {
          const location = s.git.worktreeLocation(worktree);
          if (location.kind !== "worktree") throw new Error("expected the backlog worktree");
          return collectPrDiff({ git: session, worktree: location, cli: s.cli, base, head });
        });
        expect(checkBacklogPr(diff, factsFor(s.office, diff))).toMatchObject({
          passed: true,
          failures: [],
        });
      },
      { fixture: BACKLOG_FIXTURE },
    );
  }, 60_000);
});
