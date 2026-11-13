// The structural check of a backlog-only PR in CI (0010, 0016), over a fixture repository with the
// real Backlog CLI: a story the PR makes Ready that passes the Ready gate passes, one that fails
// the gate fails `ready-decision`, a status change a backlog PR may not make fails `transition`,
// and a path outside `backlog/` fails `backlog-only`. The temporary worktree is gone afterwards.
// A Parked to Done (DIPO-468) passes only when `gh`, a fake executable run through the real spawn
// path, names the story's own PR as the one that merged as the last commit on the base that
// touched the task file; when gh fails, times out or names no merged PR it is refused (fail closed),
// in the script's own run too.

import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { type TempRepo, withTempRepo } from "../packages/testkit/src/index";

import { GhHost } from "../packages/engine/src/platform/host";
import { systemSpawn } from "../packages/engine/src/platform/process";
import { fakeGh, type FakeGhMode, restPr } from "../packages/engine/test/platform/fake-gh";

import { checkBacklogPrIn } from "./check-backlog-pr";
import { REPO_BACKLOG_CLI } from "./check-ready-gate";

const CONFIG = [
  'project_name: "fixture"',
  'default_status: "Refined"',
  'statuses: ["To Do", "Refined", "Ready", "In Progress", "In Review", "Parked", "Done"]',
  "labels: []",
  "date_format: yyyy-mm-dd",
  "remote_operations: false",
  "auto_commit: false",
  "check_active_branches: false",
  'task_prefix: "DIPO"',
  "",
].join("\n");

const MILESTONE = ["---", "id: m-0", 'title: "M0 Fixture"', "---", "", "## Description", "", "M0."];

const CLEAN_PLAN = ['    - kind: "automated"', '      check: "the export writes one line per row"'];
// R20: a manual entry needs an expected result.
const NO_EXPECT = ['    - kind: "manual"', '      check: "the export opens in a spreadsheet"'];

/** A task file as Backlog.md 1.53 writes it; `extra` lines go into its field block. */
function taskFile(
  id: number,
  status: string,
  plan: readonly string[],
  extra: readonly string[] = [],
): string {
  return [
    "---",
    `id: DIPO-${id}`,
    "title: Export the rows",
    `status: ${status}`,
    "assignee: []",
    "created_date: '2026-10-25 10:00'",
    "labels:",
    "  - 'tier:M'",
    "milestone: m-0",
    "dependencies: []",
    "references:",
    "  - packages/export/",
    "type: feature",
    "---",
    "",
    "## Description",
    "",
    "<!-- SECTION:DESCRIPTION:BEGIN -->",
    "Story: As maintainer I want the export to write every row of the table to a CSV file so that I can open the nightly data in a spreadsheet.",
    "",
    "```dipo",
    `branch: "DIPO-${id}/export-rows"`,
    "unknowns: []",
    ...extra,
    "test_plan:",
    "  entries:",
    ...plan,
    "```",
    "<!-- SECTION:DESCRIPTION:END -->",
    "",
    "## Acceptance Criteria",
    "<!-- AC:BEGIN -->",
    "- [ ] #1 Each row becomes one CSV line",
    "<!-- AC:END -->",
    "",
  ].join("\n");
}

const path = (id: number) => `backlog/tasks/dipo-${id} - Export-the-rows.md`;

/** A fixture whose base commit holds DIPO-1 and DIPO-2 as Refined; `change` makes the PR commit. */
async function pr(
  repo: TempRepo,
  change: Record<string, string>,
  more: () => Promise<unknown> = async () => {},
): Promise<[string, string]> {
  await Bun.write(`${repo.dir}/backlog/config.yml`, CONFIG);
  await Bun.write(`${repo.dir}/backlog/milestones/m-0 - m0-fixture.md`, MILESTONE.join("\n"));
  await Bun.write(`${repo.dir}/${path(1)}`, taskFile(1, "Refined", CLEAN_PLAN));
  await Bun.write(`${repo.dir}/${path(2)}`, taskFile(2, "Refined", NO_EXPECT));
  const base = await repo.commitAll("base");
  for (const [file, text] of Object.entries(change)) await Bun.write(`${repo.dir}/${file}`, text);
  await more();
  return [base, await repo.commitAll("pr")];
}

async function check(repo: TempRepo, base: string, head: string) {
  return checkBacklogPrIn({ repo: repo.dir, base, head, cli: REPO_BACKLOG_CLI, tmp: repo.root });
}

const rules = (result: { failures: readonly { rule: string; task?: string }[] }) =>
  result.failures.map((failure) => `${failure.rule} ${failure.task ?? ""}`.trim());

describe("the structural check of a backlog-only PR in CI", () => {
  it("passes a story made Ready that passes the Ready gate, and leaves no worktree", async () => {
    await withTempRepo(async (repo) => {
      const [base, head] = await pr(repo, { [path(1)]: taskFile(1, "Ready", CLEAN_PLAN) });
      const result = await check(repo, base, head);
      expect(result.failures).toEqual([]);
      expect(result.passed).toBe(true);
      expect(result.touched.map(String)).toEqual(["DIPO-1"]);
      expect(await repo.git("worktree", "list", "--porcelain")).not.toContain("dipo-backlog-pr-");
      expect(readdirSync(repo.root).some((name) => name.startsWith("dipo-backlog-pr-"))).toBe(
        false,
      );
    });
  }, 60_000);

  it("views only the changed tasks and the Ready stories (DIPO-494)", async () => {
    await withTempRepo(async (repo) => {
      const [base, head] = await pr(repo, { [path(1)]: taskFile(1, "Ready", CLEAN_PLAN) });
      const viewed: string[] = [];
      const cli = {
        ...REPO_BACKLOG_CLI,
        spawn: ((options) => {
          const at = options.cmd.indexOf("view");
          if (at >= 0) viewed.push(options.cmd[at + 1] ?? "");
          return REPO_BACKLOG_CLI.spawn(options);
        }) as typeof REPO_BACKLOG_CLI.spawn,
      };
      const result = await checkBacklogPrIn({ repo: repo.dir, base, head, cli, tmp: repo.root });
      expect(result.failures).toEqual([]);
      // DIPO-1 is the changed task, on both sides, and the one Ready story; DIPO-2 is read from its file.
      expect(viewed.length).toBeGreaterThan(0);
      expect(new Set(viewed)).toEqual(new Set(["DIPO-1"]));
    });
  }, 60_000);

  it("fails when an unchanged task's file does not parse, instead of counting it with no dependencies (DIPO-494)", async () => {
    await withTempRepo(async (repo) => {
      const [base, head] = await pr(
        repo,
        { [path(1)]: taskFile(1, "Ready", CLEAN_PLAN) },
        async () => {},
      );
      await repo.git("checkout", "--quiet", "--detach", base);
      await Bun.write(`${repo.dir}/${path(2)}`, "---\ntitle: no id\nstatus: Refined\n---\n");
      const broken = await repo.commitAll("break DIPO-2");
      await repo.git("checkout", "--quiet", "--detach", head);
      await Bun.write(`${repo.dir}/${path(2)}`, "---\ntitle: no id\nstatus: Refined\n---\n");
      const merged = await repo.commitAll("pr over the broken base");
      await expect(check(repo, broken, merged)).rejects.toThrow(/its front matter has no id/);
    });
  }, 60_000);

  it("fails a story made Ready that fails the Ready gate", async () => {
    await withTempRepo(async (repo) => {
      const [base, head] = await pr(repo, { [path(2)]: taskFile(2, "Ready", NO_EXPECT) });
      expect(rules(await check(repo, base, head))).toEqual(["ready-decision DIPO-2"]);
    });
  }, 60_000);

  it("fails a status change a backlog PR may not make, and a path outside backlog/", async () => {
    await withTempRepo(async (repo) => {
      const [base, head] = await pr(repo, {
        [path(1)]: taskFile(1, "Done", CLEAN_PLAN),
        "README.md": "outside\n",
      });
      expect(rules(await check(repo, base, head))).toEqual(["backlog-only", "transition DIPO-1"]);
    });
  }, 60_000);

  it("fails a symlink, an executable and a non-.md file under backlog/ (DIPO-341)", async () => {
    await withTempRepo(async (repo) => {
      const [base, head] = await pr(repo, { "backlog/x.test.ts": "x\n" }, async () => {
        symlinkSync("config.yml", `${repo.dir}/backlog/link.md`);
        chmodSync(`${repo.dir}/${path(2)}`, 0o755);
      });
      const result = await check(repo, base, head);
      expect(result.failures.map((failure) => failure.message)).toEqual([
        "the PR changes paths that are not Backlog files (a .md file under backlog/, backlog/config.yml, or a role file .dipo/roles/<name>.md): backlog/x.test.ts",
        `the PR changes entries that are not regular files (a symlink, a submodule or an executable): backlog/link.md, ${path(2)}`,
      ]);
    });
  }, 60_000);
});

// ---- Parked to Done of a story whose own PR merged while it was parked (DIPO-468) --------------

const PARK = [
  "park:",
  '  reason: "verify-failing"',
  '  from: "In Progress"',
  '  note: "verify red 5 times"',
];

/**
 * A base whose last commit is the story PR's merge that wrote DIPO-1 Parked, and a backlog PR that
 * sets it Done; returns the base, the head and the merge commit.
 */
async function parkedPr(repo: TempRepo): Promise<{ base: string; head: string; merge: string }> {
  await Bun.write(`${repo.dir}/backlog/config.yml`, CONFIG);
  await Bun.write(`${repo.dir}/backlog/milestones/m-0 - m0-fixture.md`, MILESTONE.join("\n"));
  await Bun.write(`${repo.dir}/${path(1)}`, taskFile(1, "In Progress", CLEAN_PLAN));
  await repo.commitAll("claim");
  await Bun.write(`${repo.dir}/${path(1)}`, taskFile(1, "Parked", CLEAN_PLAN, PARK));
  const merge = await repo.commitAll("feat(DIPO-1): export the rows (#634)");
  await Bun.write(`${repo.dir}/${path(1)}`, taskFile(1, "Done", CLEAN_PLAN));
  return { base: merge, head: await repo.commitAll("backlog: done DIPO-1"), merge };
}

/** The check through the real gh spawn path, with a fake gh in `mode` and a short deadline. */
async function checkWithGh(repo: TempRepo, mode: (merge: string) => FakeGhMode) {
  const { base, head, merge } = await parkedPr(repo);
  const bin = join(repo.root, "bin");
  mkdirSync(bin, { recursive: true });
  const gh = fakeGh(bin, mode(merge));
  const host = new GhHost({
    spawn: systemSpawn,
    gh: gh.path,
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: repo.home },
    deadlineMs: 500,
  });
  const result = await checkBacklogPrIn({
    repo: repo.dir,
    base,
    head,
    cli: REPO_BACKLOG_CLI,
    tmp: repo.root,
    host,
    hostRepo: "o/r",
    prBase: "main",
  });
  return { result, gh, merge };
}

const story = (merge: string, over: Record<string, unknown> | null = null) =>
  JSON.stringify([over ?? restPr({ number: 634, head: "DIPO-1/export-rows", merge })]);

describe("Parked to Done in the structural check (DIPO-468)", () => {
  it("passes when gh names the story's own PR as merged as the last commit that touched its task file", async () => {
    await withTempRepo(async (repo) => {
      const { result, gh, merge } = await checkWithGh(repo, (commit) => ({
        kind: "answer",
        body: story(commit),
      }));
      expect(result.failures).toEqual([]);
      expect(gh.calls()).toEqual([`api repos/o/r/commits/${merge}/pulls`]);
    });
  }, 60_000);

  it("refuses it when gh fails, times out or names no merged PR (fail closed)", async () => {
    const modes: ((merge: string) => FakeGhMode)[] = [
      () => ({ kind: "fail", code: 1, stderr: "HTTP 502: Bad Gateway" }),
      () => ({ kind: "fail", code: 4, stderr: "not logged in" }),
      () => ({ kind: "hang" }),
      () => ({ kind: "answer", body: "[]" }),
      (merge) => ({
        kind: "answer",
        body: story(
          merge,
          restPr({ number: 634, head: "DIPO-1/export-rows", merge, merged: false }),
        ),
      }),
      (merge) => ({
        kind: "answer",
        body: story(merge, restPr({ number: 7, head: "DIPO-9/other", merge })),
      }),
    ];
    for (const mode of modes) {
      await withTempRepo(async (repo) => {
        const { result } = await checkWithGh(repo, mode);
        expect(rules(result)).toEqual(["transition DIPO-1"]);
        expect(result.passed).toBe(false);
      });
    }
  }, 120_000);

  it("refuses it when a later commit on the base touched the task file, by design", async () => {
    await withTempRepo(async (repo) => {
      const { base, head, merge } = await parkedPr(repo);
      // A hand edit on the base after the merge: the last commit is no longer the story PR's.
      await repo.git("checkout", "--quiet", "-b", "edited", base);
      await Bun.write(
        `${repo.dir}/${path(1)}`,
        taskFile(1, "Parked", CLEAN_PLAN, PARK).replace("Export the rows", "Export every row"),
      );
      const edited = await repo.commitAll("edit the title by hand");
      await repo.git("checkout", "--quiet", "--detach", head);
      const bin = join(repo.root, "bin");
      mkdirSync(bin, { recursive: true });
      const gh = fakeGh(bin, { kind: "answer", body: story(merge) });
      const result = await checkBacklogPrIn({
        repo: repo.dir,
        base: edited,
        head,
        cli: REPO_BACKLOG_CLI,
        tmp: repo.root,
        host: new GhHost({ spawn: systemSpawn, gh: gh.path, env: { HOME: repo.home } }),
        hostRepo: "o/r",
        prBase: "main",
      });
      expect(rules(result)).toContain("transition DIPO-1");
    });
  }, 60_000);

  it("refuses it in the script's own run when gh fails, and passes it when gh names the PR", async () => {
    for (const fail of [true, false]) {
      await withTempRepo(async (repo) => {
        const { base, head, merge } = await parkedPr(repo);
        const bin = join(repo.root, "bin");
        mkdirSync(bin, { recursive: true });
        fakeGh(
          bin,
          fail
            ? { kind: "fail", code: 1, stderr: "HTTP 502: Bad Gateway" }
            : { kind: "answer", body: story(merge) },
        );
        const run = Bun.spawnSync(
          [process.execPath, join(import.meta.dir, "check-backlog-pr.ts"), base, head, repo.dir],
          {
            env: {
              ...repo.env,
              PATH: `${bin}:${repo.env["PATH"] ?? process.env["PATH"] ?? "/usr/bin:/bin"}`,
              GITHUB_REPOSITORY: "o/r",
              GITHUB_BASE_REF: "main",
              RUNNER_TEMP: repo.root,
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        if (fail) {
          expect(run.exitCode).toBe(1);
          expect(run.stderr.toString()).toContain(
            "[transition] DIPO-1 moves from Parked to Done, which a backlog PR may not do (0012)",
          );
          expect(run.stderr.toString()).toContain("HTTP 502: Bad Gateway");
        } else {
          expect(run.stderr.toString()).toBe("");
          expect(run.exitCode).toBe(0);
        }
      });
    }
  }, 120_000);
});
