// The structural check of a backlog PR as a pure function over fixture diffs (DIPO-35; 0010):
// each rule fails on its own fixture and names its rule and task, and a valid
// office-init diff passes. A Parked to Done passes only for a story whose own PR merged while it was
// parked (DIPO-468), with its facts gathered over a fake git and host: the old barrier and every
// bypass form still refuse.

import { describe, expect, it } from "bun:test";

import { StoryKey } from "@dipsaus-orchestrator/contract";

import {
  checkBacklogPr,
  type PrDiff,
  type PrFacts,
  type TaskSide,
} from "../../../src/backlog/pr/check";
import { parseRawDiff, taskOfPath } from "../../../src/backlog/pr/diff";
import { mergedWhileParkedFacts } from "../../../src/backlog/pr/merged";
import type { GitSession } from "../../../src/git/office";
import { CodeHostError, type HostPr, type MergeCommitHost } from "../../../src/platform/host";
import type { PlainTask } from "../../../src/story-store/story";
import { gateStoryFromView } from "../../../src/gate/input";
import { gateContentHash } from "../../../src/gate/hash";

const K1 = StoryKey.parse("sto_01HZZZZZZZZZZZZZZZZZZZZZZ1");
const K2 = StoryKey.parse("sto_01HZZZZZZZZZZZZZZZZZZZZZZ2");

const BLOCK = ["```dipo", 'branch: "TASK-1/add-csv"', "unknowns: []", "```"].join("\n");

function task(
  id: string,
  status: string,
  description = `Story: As maintainer I want a story that passes the gate so that the run can pick it up.\n\n${BLOCK}`,
): PlainTask {
  return {
    file: `/office/backlog/tasks/${id.toLowerCase()} - Story.md`,
    id,
    title: "Story",
    status,
    assignee: [],
    created: "2026-10-12 11:28 (UTC)",
    labels: ["tier:S"],
    subtasks: [],
    references: ["src/"],
    documentation: [],
    dependencies: [],
    description,
    acceptanceCriteria: [{ index: 1, checked: false, text: "It works as described." }],
    definitionOfDone: [],
    modifiedFiles: [],
    comments: [],
    unknown: [],
  };
}

function side(view: PlainTask): TaskSide {
  return { where: "task", view: { ok: true, task: view } };
}

function hashOf(view: PlainTask): string {
  return gateContentHash(gateStoryFromView(view, []));
}

const NO_FACTS: PrFacts = { keys: {}, claimed: [], passing: {} };

describe("taskOfPath", () => {
  it("maps Backlog.md task and draft files to ids and places", () => {
    expect(taskOfPath("backlog/tasks/task-1 - Add-it.md")).toEqual({ id: "TASK-1", where: "task" });
    expect(taskOfPath("backlog/drafts/draft-2 - Idea.md")).toEqual({
      id: "DRAFT-2",
      where: "draft",
    });
    expect(taskOfPath("backlog/archive/tasks/task-3 - Gone.md")).toEqual({
      id: "TASK-3",
      where: "archived",
    });
    expect(taskOfPath("backlog/config.yml")).toBeNull();
    expect(taskOfPath("backlog/docs/doc-1 - Notes.md")).toBeNull();
  });
});

const sha = (c: string) => c.repeat(40);

describe("parseRawDiff", () => {
  it("reads modes, status and paths with spaces and newlines", () => {
    const out = [
      `:000000 100644 ${sha("0")} ${sha("a")} A`,
      "backlog/tasks/task-1 - A b.md",
      `:100644 120000 ${sha("a")} ${sha("b")} T`,
      "backlog/odd\nname.md",
      "",
    ].join("\0");
    expect(parseRawDiff(out)).toEqual([
      { path: "backlog/tasks/task-1 - A b.md", from: "000000", to: "100644", status: "A" },
      { path: "backlog/odd\nname.md", from: "100644", to: "120000", status: "T" },
    ]);
    expect(parseRawDiff("")).toEqual([]);
  });

  it("throws on output of another shape", () => {
    expect(() => parseRawDiff("backlog/tasks/a.md\0")).toThrow(/unexpected git diff --raw/);
  });
});

describe("checkBacklogPr", () => {
  it("passes a valid office-init diff: config, To Do to Refined, a new draft, a gated Ready", () => {
    const ready = task("TASK-2", "Ready");
    const diff: PrDiff = {
      paths: [
        "backlog/config.yml",
        "backlog/tasks/task-1 - Story.md",
        "backlog/tasks/task-2 - Story.md",
        "backlog/drafts/draft-1 - Idea.md",
      ],
      tasks: [
        {
          id: "TASK-1",
          before: side(task("TASK-1", "To Do")),
          after: side(task("TASK-1", "Refined")),
        },
        { id: "TASK-2", before: side(task("TASK-2", "Refined")), after: side(ready) },
        {
          id: "DRAFT-1",
          before: { where: "absent" },
          after: { where: "draft", view: { ok: true, task: task("DRAFT-1", "Draft") } },
        },
      ],
    };
    const facts: PrFacts = {
      keys: { "TASK-1": K1, "TASK-2": K2 },
      claimed: [],
      passing: { [K2]: [hashOf(ready)] },
    };
    expect(checkBacklogPr(diff, facts)).toEqual({ passed: true, failures: [], touched: [K1, K2] });
  });

  it("fails a path outside backlog/", () => {
    const result = checkBacklogPr(
      { paths: ["backlog/config.yml", "src/index.ts"], tasks: [] },
      NO_FACTS,
    );
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual([
      {
        rule: "backlog-only",
        message:
          "the PR changes paths that are not Backlog files (a .md file under backlog/, backlog/config.yml, or a role file .dipo/roles/<name>.md): src/index.ts",
      },
    ]);
  });

  it("passes role files under .dipo/roles/ and fails other files under .dipo/ (DIPO-474)", () => {
    const roles = [".dipo/roles/tester.md", ".dipo/roles/old-role.md"];
    expect(checkBacklogPr({ paths: roles, tasks: [] }, NO_FACTS).passed).toBe(true);
    const others = [".dipo/office.yaml", ".dipo/roles/Bad Name.md", ".dipo/roles/sub/x.md"];
    expect(checkBacklogPr({ paths: others, tasks: [] }, NO_FACTS).failures[0]?.message).toContain(
      others.join(", "),
    );
  });

  it("fails a file under backlog/ that is not a .md file or backlog/config.yml (DIPO-341)", () => {
    const paths = ["backlog/x.test.ts", "backlog/tasks/task-1 - Story.md", "backlog/config.yaml"];
    expect(checkBacklogPr({ paths, tasks: [] }, NO_FACTS).failures).toEqual([
      {
        rule: "backlog-only",
        message:
          "the PR changes paths that are not Backlog files (a .md file under backlog/, backlog/config.yml, or a role file .dipo/roles/<name>.md): backlog/x.test.ts, backlog/config.yaml",
      },
    ]);
  });

  it("fails an entry that is not a regular file, under backlog/ too (DIPO-341)", () => {
    const paths = ["backlog/tasks/link.md", "backlog/docs/doc-1 - Notes.md"];
    expect(
      checkBacklogPr({ paths, irregular: ["backlog/tasks/link.md"], tasks: [] }, NO_FACTS).failures,
    ).toEqual([
      {
        rule: "backlog-only",
        message:
          "the PR changes entries that are not regular files (a symlink, a submodule or an executable): backlog/tasks/link.md",
      },
    ]);
    expect(checkBacklogPr({ paths, tasks: [] }, NO_FACTS).passed).toBe(true);
  });

  it("passes a new .dipo/.gitignore from office init, and fails one the PR changes (DIPO-36)", () => {
    const paths = ["backlog/config.yml", ".dipo/.gitignore"];
    expect(checkBacklogPr({ paths, added: [".dipo/.gitignore"], tasks: [] }, NO_FACTS).passed).toBe(
      true,
    );
    expect(checkBacklogPr({ paths, tasks: [] }, NO_FACTS).failures).toEqual([
      {
        rule: "backlog-only",
        message:
          "the PR changes paths that are not Backlog files (a .md file under backlog/, backlog/config.yml, or a role file .dipo/roles/<name>.md): .dipo/.gitignore",
      },
    ]);
    // Only that one file may be added outside backlog/.
    expect(
      checkBacklogPr(
        { paths: [".dipo/office.yaml"], added: [".dipo/office.yaml"], tasks: [] },
        NO_FACTS,
      ).passed,
    ).toBe(false);
  });

  it("fails a task that does not parse, and one whose field block is invalid (R02)", () => {
    const result = checkBacklogPr(
      {
        paths: ["backlog/tasks/task-1 - Story.md", "backlog/tasks/task-2 - Story.md"],
        tasks: [
          {
            id: "TASK-1",
            before: side(task("TASK-1", "Refined")),
            after: {
              where: "task",
              view: { ok: false, error: "R02: the Description section appears twice" },
            },
          },
          {
            id: "TASK-2",
            before: side(task("TASK-2", "Refined")),
            after: side(task("TASK-2", "Refined", "Story: x.\n\n```dipo\nbranch: 5\n```")),
          },
        ],
      },
      NO_FACTS,
    );
    expect(result.failures.map((f) => [f.rule, f.task])).toEqual([
      ["parses", "TASK-1"],
      ["parses", "TASK-2"],
    ]);
  });

  it("fails a status change lane b may not write", () => {
    const result = checkBacklogPr(
      {
        paths: ["backlog/tasks/task-1 - Story.md", "backlog/tasks/task-2 - Story.md"],
        tasks: [
          {
            id: "TASK-1",
            before: side(task("TASK-1", "Ready")),
            after: side(task("TASK-1", "In Progress")),
          },
          {
            id: "TASK-2",
            before: side(task("TASK-2", "Refined")),
            after: side(task("TASK-2", "Done")),
          },
        ],
      },
      NO_FACTS,
    );
    expect(result.failures.map((f) => [f.rule, f.task, f.message])).toEqual([
      [
        "transition",
        "TASK-1",
        "TASK-1 moves from Ready to In Progress, which a backlog PR may not do (0012)",
      ],
      [
        "transition",
        "TASK-2",
        "TASK-2 moves from Refined to Done, which a backlog PR may not do (0012)",
      ],
    ]);
  });

  it("fails a new Ready without a passing gate decision for its content", () => {
    const ready = task("TASK-1", "Ready");
    const edited = task(
      "TASK-1",
      "Ready",
      `Story: As maintainer I want another story in its place so that the edit shows in the check.\n\n${BLOCK}`,
    );
    const diff: PrDiff = {
      paths: ["backlog/tasks/task-1 - Story.md"],
      tasks: [{ id: "TASK-1", before: side(task("TASK-1", "Refined")), after: side(edited) }],
    };
    // A decision for the content before the edit does not count.
    const result = checkBacklogPr(diff, {
      keys: { "TASK-1": K1 },
      claimed: [],
      passing: { [K1]: [hashOf(ready)] },
    });
    expect(result.failures.map((f) => [f.rule, f.task, f.key])).toEqual([
      ["ready-decision", "TASK-1", K1],
    ]);
    // A story dipo does not know cannot match a decision either.
    expect(checkBacklogPr(diff, NO_FACTS).failures.map((f) => f.rule)).toEqual(["ready-decision"]);
  });

  it("fails a touched task with a live claim", () => {
    const result = checkBacklogPr(
      {
        paths: ["backlog/tasks/task-1 - Story.md"],
        tasks: [
          {
            id: "TASK-1",
            before: side(task("TASK-1", "Refined")),
            after: side(task("TASK-1", "Refined")),
          },
        ],
      },
      { keys: { "TASK-1": K1 }, claimed: [K1], passing: {} },
    );
    expect(result.failures.map((f) => [f.rule, f.task])).toEqual([["no-claim", "TASK-1"]]);
  });
});

// ---- A new task or a promoted draft at Ready (DIPO-495) ----------------------------------------

/** The failures of the check by rule and task. */
const rules = (diff: PrDiff, facts: PrFacts) =>
  checkBacklogPr(diff, facts).failures.map((failure) => [failure.rule, failure.task]);

describe("checkBacklogPr: a new task and a promoted draft at Ready (DIPO-495)", () => {
  const ready = task("TASK-7", "Ready");
  const other = task(
    "TASK-7",
    "Ready",
    `Story: As maintainer I want other content in its place so that the decision no longer matches.\n\n${BLOCK}`,
  );
  /** TASK-7 new at Ready; with `promoted`, the draft DRAFT-3 it was promoted from goes. */
  const diffOf = (after: PlainTask, promoted = false): PrDiff => ({
    paths: [
      "backlog/tasks/task-7 - Story.md",
      ...(promoted ? ["backlog/drafts/draft-3 - Story.md"] : []),
    ],
    tasks: [
      { id: "TASK-7", before: { where: "absent" }, after: side(after) },
      ...(promoted
        ? [
            {
              id: "DRAFT-3",
              before: { where: "draft", view: { ok: true, task: task("DRAFT-3", "Draft") } },
              after: { where: "absent" },
            } satisfies PrDiff["tasks"][number],
          ]
        : []),
    ],
  });
  it("passes a new task at Ready with the lane's passing decision for its content, under no key", () => {
    expect(rules(diffOf(ready), { ...NO_FACTS, unkeyed: [hashOf(ready)] })).toEqual([]);
  });

  it("passes a draft promoted to Ready with a passing decision for its content", () => {
    expect(rules(diffOf(ready, true), { ...NO_FACTS, unkeyed: [hashOf(ready)] })).toEqual([]);
    // CI and a renumbered key hold the decision under the task's own key.
    const keyed: PrFacts = {
      keys: { "TASK-7": K1 },
      claimed: [],
      passing: { [K1]: [hashOf(ready)] },
    };
    expect(rules(diffOf(ready, true), keyed)).toEqual([]);
    // The same id on both sides, from Draft to Ready, is a transition lane b may write too.
    const sameId: PrDiff = {
      paths: ["backlog/tasks/task-7 - Story.md"],
      tasks: [
        {
          id: "TASK-7",
          before: { where: "draft", view: { ok: true, task: task("TASK-7", "Draft") } },
          after: side(ready),
        },
      ],
    };
    expect(rules(sameId, keyed)).toEqual([]);
    expect(rules(sameId, { ...keyed, passing: {} })).toEqual([["ready-decision", "TASK-7"]]);
  });

  it("fails ready-decision without a decision, and with a decision for other content", () => {
    expect(rules(diffOf(ready), NO_FACTS)).toEqual([["ready-decision", "TASK-7"]]);
    expect(rules(diffOf(ready, true), NO_FACTS)).toEqual([["ready-decision", "TASK-7"]]);
    expect(rules(diffOf(other), { ...NO_FACTS, unkeyed: [hashOf(ready)] })).toEqual([
      ["ready-decision", "TASK-7"],
    ]);
    // A failing decision is no decision: only passing hashes are facts.
    const keyed: PrFacts = {
      keys: { "TASK-7": K1 },
      claimed: [],
      passing: { [K1]: [hashOf(ready)] },
    };
    expect(rules(diffOf(other), keyed)).toEqual([["ready-decision", "TASK-7"]]);
    // A decision held under no key never counts for a task dipo knows under a key.
    expect(rules(diffOf(ready), { ...keyed, passing: {}, unkeyed: [hashOf(ready)] })).toEqual([
      ["ready-decision", "TASK-7"],
    ]);
  });

  it("still refuses every other new-task transition from In Progress on", () => {
    for (const status of ["In Progress", "In Review", "Done", "Parked"]) {
      const result = checkBacklogPr(diffOf(task("TASK-7", status)), {
        ...NO_FACTS,
        unkeyed: [hashOf(ready)],
      });
      expect(result.failures.map((failure) => [failure.rule, failure.message])).toEqual([
        [
          "transition",
          `TASK-7 moves from no file to ${status}, which a backlog PR may not do (0012)`,
        ],
      ]);
    }
  });
});

// ---- Parked to Done for a story whose own PR merged while it was parked (DIPO-468) --------------

const MERGE = sha("m");
const BASE_COMMIT = sha("e");

/** A field block naming `branch`. */
function blockOf(branch: string): string {
  return `Story: As maintainer I want a story that passes the gate so that the run can pick it up.\n\n${[
    "```dipo",
    `branch: "${branch}"`,
    "unknowns: []",
    "```",
  ].join("\n")}`;
}

/** A Parked to Done change of `id`, its field block naming `before` on the base and `after` in the PR. */
function parkedToDone(
  id: string,
  before = `${id}/add-csv`,
  after = before,
): PrDiff["tasks"][number] {
  return {
    id,
    before: side(task(id, "Parked", blockOf(before))),
    after: side(task(id, "Done", blockOf(after))),
  };
}

/** A merged PR as the host names it. */
function hostPr(over: Partial<HostPr> = {}): HostPr {
  return {
    number: 634,
    url: "https://github.com/o/r/pull/634",
    state: "merged",
    head: "TASK-1/add-csv",
    headSha: sha("h"),
    base: "main",
    title: "feat(TASK-1): x",
    mergeCommit: MERGE,
    ...over,
  };
}

/**
 * The check as dipo and CI run it on `changes`: a fake git whose `git log -1 <base> -- <task file>`
 * names `last[id]`, and a fake host that names `prs[sha]` as the PR merged as that commit (or
 * throws it). Returns the transition failures by task.
 */
async function decide(
  changes: readonly PrDiff["tasks"][number][],
  options: {
    readonly last: Readonly<Record<string, string | null>>;
    readonly prs?: Readonly<Record<string, HostPr | Error | null>>;
    readonly prBase?: string | null;
    readonly host?: boolean;
    /** The base tip; null is one dipo could not read. */
    readonly base?: string | null;
  },
): Promise<{ readonly transitions: [string, string][]; readonly asked: string[] }> {
  const asked: string[] = [];
  const logs: string[] = [];
  const git = {
    repository: { kind: "repository", commonDir: "/repo/.git" },
    step: async (_location: unknown, args: readonly string[]) => {
      logs.push(args.join(" "));
      const glob = String(args.at(-1) ?? "");
      const id = /\*\*\/(.+) - \*\.md$/.exec(glob)?.[1] ?? "";
      const commit = options.last[id] ?? null;
      return { code: 0, stdout: commit === null ? "" : `${commit}\n`, stderr: "" };
    },
    ok: async () => "",
    base: async () => "main",
  } as unknown as GitSession;
  const host: MergeCommitHost = {
    mergedPrOfCommit: async (repo, commit) => {
      asked.push(`${repo} ${commit}`);
      const answer = options.prs?.[commit] ?? null;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  const diff: PrDiff = {
    paths: changes.map((change) => `backlog/tasks/${change.id.toLowerCase()} - Story.md`),
    tasks: changes,
  };
  const merged = await mergedWhileParkedFacts({
    git,
    diff,
    base: options.base === undefined ? BASE_COMMIT : options.base,
    host: options.host === false ? null : host,
    repo: "o/r",
  });
  // Every lookup is on the PR's base side, for the task's own file.
  for (const line of logs) expect(line).toStartWith(`log -1 --format=%H ${BASE_COMMIT} -- `);
  const result = checkBacklogPr(diff, {
    ...NO_FACTS,
    merged,
    prBase: options.prBase === undefined ? "main" : options.prBase,
  });
  return {
    transitions: result.failures
      .filter((failure) => failure.rule === "transition")
      .map((failure) => [failure.task ?? "", failure.message]),
    asked,
  };
}

const refusedIds = (outcome: { transitions: [string, string][] }) =>
  outcome.transitions.map(([id]) => id);

const refused = async (
  changes: readonly PrDiff["tasks"][number][],
  options: Parameters<typeof decide>[1],
) => refusedIds(await decide(changes, options));

describe("checkBacklogPr: Parked to Done of a story whose PR merged while it was parked (DIPO-468)", () => {
  it("passes when the one Done check answers merged for the story PR whose merge commit last touched the task file on the base", async () => {
    const outcome = await decide([parkedToDone("TASK-1")], {
      last: { "TASK-1": MERGE },
      prs: { [MERGE]: hostPr() },
    });
    expect(outcome.transitions).toEqual([]);
    expect(outcome.asked).toEqual([`o/r ${MERGE}`]);
  });

  it("still refuses every other transition the old barrier refused, merged PR or not", async () => {
    const changes = [
      { id: "TASK-1", from: "Ready", to: "In Progress" },
      { id: "TASK-2", from: "Refined", to: "Done" },
      { id: "TASK-3", from: "In Progress", to: "Done" },
      { id: "TASK-4", from: "In Review", to: "Done" },
    ].map(({ id, from, to }) => ({
      id,
      before: side(task(id, from, blockOf("TASK-1/add-csv"))),
      after: side(task(id, to, blockOf("TASK-1/add-csv"))),
    }));
    const outcome = await decide(changes, {
      last: { "TASK-1": MERGE, "TASK-2": MERGE, "TASK-3": MERGE, "TASK-4": MERGE },
      prs: { [MERGE]: hostPr() },
    });
    expect(outcome.transitions).toEqual([
      ["TASK-1", "TASK-1 moves from Ready to In Progress, which a backlog PR may not do (0012)"],
      ["TASK-2", "TASK-2 moves from Refined to Done, which a backlog PR may not do (0012)"],
      ["TASK-3", "TASK-3 moves from In Progress to Done, which a backlog PR may not do (0012)"],
      ["TASK-4", "TASK-4 moves from In Review to Done, which a backlog PR may not do (0012)"],
    ]);
    // Only a Parked to Done asks the host.
    expect(outcome.asked).toEqual([]);
  });

  it("refuses Parked to Done without a merged PR: no facts, no host, no commit, no PR", async () => {
    const change = parkedToDone("TASK-1");
    const plain = checkBacklogPr(
      { paths: ["backlog/tasks/task-1 - Story.md"], tasks: [change] },
      NO_FACTS,
    );
    expect(plain.failures.map((f) => [f.rule, f.message])).toEqual([
      [
        "transition",
        "TASK-1 moves from Parked to Done, which a backlog PR may not do (0012): only a story whose own PR merged while it was parked may, and dipo did not ask which PR merged it",
      ],
    ]);
    for (const outcome of [
      await decide([change], {
        last: { "TASK-1": MERGE },
        prs: { [MERGE]: hostPr() },
        host: false,
      }),
      await decide([change], { last: { "TASK-1": null } }),
      await decide([change], { last: { "TASK-1": MERGE }, prs: {} }),
      await decide([change], {
        last: { "TASK-1": MERGE },
        prs: { [MERGE]: hostPr() },
        prBase: null,
      }),
    ]) {
      expect(refusedIds(outcome)).toEqual(["TASK-1"]);
    }
  });

  it("refuses when dipo cannot read the base's tip, without asking git or the host", async () => {
    const outcome = await decide([parkedToDone("TASK-1")], {
      last: { "TASK-1": MERGE },
      prs: { [MERGE]: hostPr() },
      base: null,
    });
    expect(outcome.transitions).toEqual([
      [
        "TASK-1",
        "TASK-1 moves from Parked to Done, which a backlog PR may not do (0012): only a story whose own PR merged while it was parked may, and dipo could not read the commit the PR's base branch is at",
      ],
    ]);
    expect(outcome.asked).toEqual([]);
  });

  it("refuses when the base-side field block names another story's branch", async () => {
    // Story TASK-1's PR rewrote TASK-2's field block to TASK-1's branch and parked it: TASK-1's
    // merge must not count for TASK-2.
    const outcome = await decide([parkedToDone("TASK-2", "TASK-1/add-csv")], {
      last: { "TASK-2": MERGE },
      prs: { [MERGE]: hostPr() },
    });
    expect(outcome.transitions).toEqual([
      [
        "TASK-2",
        "TASK-2 moves from Parked to Done, which a backlog PR may not do (0012): only a story whose own PR merged while it was parked may, and its field block on the base names the branch TASK-1/add-csv, which is not one of TASK-2",
      ],
    ]);
  });

  it("refuses when the host fails or times out (fail closed)", async () => {
    for (const error of [
      new CodeHostError("failed", "HTTP 502"),
      new CodeHostError("timedOut", "gh api did not finish"),
      new CodeHostError("unauthenticated", "not logged in"),
    ]) {
      const outcome = await decide([parkedToDone("TASK-1")], {
        last: { "TASK-1": MERGE },
        prs: { [MERGE]: error },
      });
      expect(outcome.transitions).toEqual([
        [
          "TASK-1",
          `TASK-1 moves from Parked to Done, which a backlog PR may not do (0012): only a story whose own PR merged while it was parked may, and the code host could not say which PR merged as ${MERGE.slice(0, 12)}: ${error.message}`,
        ],
      ]);
    }
  });

  it("refuses each bypass form", async () => {
    // A PR merged from another branch.
    expect(
      await refused([parkedToDone("TASK-1")], {
        last: { "TASK-1": MERGE },
        prs: { [MERGE]: hostPr({ head: "TASK-7/other" }) },
      }),
    ).toEqual(["TASK-1"]);
    // A PR merged into another base.
    expect(
      await refused([parkedToDone("TASK-1")], {
        last: { "TASK-1": MERGE },
        prs: { [MERGE]: hostPr({ base: "release" }) },
      }),
    ).toEqual(["TASK-1"]);
    // A closed PR that never merged, even one whose merge commit names the commit.
    expect(
      await refused([parkedToDone("TASK-1")], {
        last: { "TASK-1": MERGE },
        prs: { [MERGE]: hostPr({ state: "closed" }) },
      }),
    ).toEqual(["TASK-1"]);
    // A merged PR whose merge commit is not the commit on the base.
    expect(
      await refused([parkedToDone("TASK-1")], {
        last: { "TASK-1": MERGE },
        prs: { [MERGE]: hostPr({ mergeCommit: sha("x") }) },
      }),
    ).toEqual(["TASK-1"]);
    // An old merged PR of a reused branch: a later commit touched the task file, and only the old
    // merge commit belongs to a PR of the branch.
    const later = sha("l");
    expect(
      await refused([parkedToDone("TASK-1")], {
        last: { "TASK-1": later },
        prs: { [MERGE]: hostPr({ number: 5 }), [later]: null },
      }),
    ).toEqual(["TASK-1"]);
    // The backlog PR changes the field block's branch to that of a merged PR and sets Done.
    expect(
      await refused([parkedToDone("TASK-1", "TASK-1/add-csv", "TASK-7/other")], {
        last: { "TASK-1": MERGE },
        prs: { [MERGE]: hostPr({ head: "TASK-7/other" }) },
      }),
    ).toEqual(["TASK-1"]);
    // A story id typo names another story: TASK-2's file last changed in TASK-1's merge.
    expect(
      await refused([parkedToDone("TASK-2")], {
        last: { "TASK-2": MERGE },
        prs: { [MERGE]: hostPr() },
      }),
    ).toEqual(["TASK-2"]);
    // A second story without its own merged PR in the same backlog PR: only it is refused.
    expect(
      await refused([parkedToDone("TASK-1"), parkedToDone("TASK-2")], {
        last: { "TASK-1": MERGE, "TASK-2": sha("2") },
        prs: { [MERGE]: hostPr(), [sha("2")]: null },
      }),
    ).toEqual(["TASK-2"]);
  });
});
