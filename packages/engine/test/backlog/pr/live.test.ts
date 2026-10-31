// The backlog PR against a real scratch GitHub repository (DIPO-35, manual test plan entry). It runs
// only when `DIPO_LIVE_REPO=<owner>/<name>` is set, with the maintainer's own `gh` login and git
// credentials, and is skipped otherwise. The scratch repository holds this repository's `ci.yml`
// and `pr-title.yml` with the required checks `ci-ok` and `pr-title`. When its default branch has no
// `backlog/` yet, the test pushes the Backlog fixture project there once.
//
// The test clones the repository under DIPO_TMP, journals one lane-b operation, lets the engine
// push the branch and open a `chore(backlog): ...` PR through `gh`, waits for `pr-title` to pass,
// and reports the structural check. It closes the PR and deletes the branch at the end.

import { describe, expect, it } from "bun:test";
import { cpSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { type OfficeId, StoryId } from "@dipsaus-orchestrator/contract";
import { makeTempDir } from "@dipsaus-orchestrator/testkit";

import { EDIT_KIND, editKind, OfficeLane } from "../../../src/backlog/lane";
import { BacklogPrs, findPr } from "../../../src/backlog/pr";
import { OfficeGit, spawnGitExec } from "../../../src/git";
import { GhHost } from "../../../src/platform/host";
import { systemSpawn } from "../../../src/platform/process";
import { addStory } from "../../../src/records/story-keys";
import { addOffice, openTestState } from "../../commands/helpers";
import { BACKLOG_CLI, BACKLOG_FIXTURE } from "../helpers";

const LIVE_REPO = process.env["DIPO_LIVE_REPO"];
const PR_TITLE_WAIT_MS = 300_000;

function realEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined) env[name] = value;
  return env;
}

async function run(cwd: string, ...cmd: [string, ...string[]]): Promise<string> {
  const child = systemSpawn({ cmd, cwd, env: realEnv() });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit.code !== 0)
    throw new Error(`${cmd.join(" ")} failed: ${stderr.trim() || stdout.trim()}`);
  return stdout.trim();
}

describe.skipIf(LIVE_REPO === undefined || LIVE_REPO === "")("the backlog PR on GitHub", () => {
  it(
    "opens a chore(backlog) PR whose pr-title check passes and whose structural check passes",
    async () => {
      const repo = LIVE_REPO as string;
      const root = makeTempDir();
      const clone = join(root, "clone");
      await run(root, "gh", "repo", "clone", repo, clone);
      const base = await run(clone, "git", "rev-parse", "--abbrev-ref", "HEAD");
      if (!existsSync(join(clone, "backlog"))) {
        cpSync(join(BACKLOG_FIXTURE, "backlog"), join(clone, "backlog"), { recursive: true });
        await run(clone, "git", "add", "backlog");
        await run(
          clone,
          "git",
          "commit",
          "--quiet",
          "-m",
          "chore(backlog): add the dipo fixture project",
        );
        await run(clone, "git", "push", "--quiet", "origin", `HEAD:${base}`);
      }

      const t = await openTestState(join(root, "state"));
      const office = addOffice(t);
      const officeId = office.officeId as OfficeId;
      const git = new OfficeGit({
        officeId,
        mainWorktree: realpathSync(clone),
        commonDir: realpathSync(join(clone, ".git")),
        settings: { remote: "origin", base, worktreeRoot: join(root, "worktrees") },
        runner: { exec: spawnGitExec(systemSpawn), env: realEnv(), sleep: (ms) => Bun.sleep(ms) },
        clock: t.clock,
      });
      const cli = { spawn: systemSpawn, command: BACKLOG_CLI, env: realEnv() };
      const host = new GhHost({ spawn: systemSpawn });
      let lane: OfficeLane | undefined;
      const prs = new BacklogPrs({
        host,
        lane: () => lane,
        cli,
        offices: { get: () => office },
        clock: t.clock,
      });
      lane = new OfficeLane({
        officeId,
        office,
        git,
        cli,
        clock: t.clock,
        kinds: new Map([[EDIT_KIND, editKind(EDIT_KIND)]]),
        onFlushed: (id, report) => prs.afterFlush(id, report),
      });

      const key = addStory(office, t.ids, { story: StoryId.parse("TASK-2") }, 0).key;
      const { report } = await lane.submit({
        kind: "edit",
        key,
        subject: "TASK-2",
        target: { labels: { add: ["dipo-live"] } },
      });
      const branch = report.branch as string;
      const record = findPr(office, (await host.findOpenPr(repo, branch))?.number ?? -1);
      try {
        expect(prs.waiting(officeId)).toBeNull();
        expect(record?.title).toBe("chore(backlog): edit TASK-2");
        expect(record?.check).toBe("passed");
        console.log(`opened ${record?.url}; structural check: ${record?.check}`);

        const deadline = performance.now() + PR_TITLE_WAIT_MS;
        let bucket = "pending";
        while (performance.now() < deadline) {
          const checks = await host.requiredChecks(repo, record?.number ?? -1);
          bucket = checks.find((check) => check.name === "pr-title")?.bucket ?? "pending";
          if (bucket !== "pending") break;
          await Bun.sleep(5000);
        }
        console.log(`pr-title: ${bucket}`);
        expect(bucket).toBe("pass");
      } finally {
        if (record !== null) await host.closePr(repo, record.number, "dipo live test done");
        await run(clone, "git", "push", "--quiet", "origin", "--delete", branch).catch(() => "");
      }
    },
    PR_TITLE_WAIT_MS + 120_000,
  );
});
