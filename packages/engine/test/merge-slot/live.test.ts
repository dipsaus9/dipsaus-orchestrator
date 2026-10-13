// The merge slot against a real scratch GitHub repository (DIPO-73, manual test plan entry). It
// runs only when `DIPO_LIVE_REPO=<owner>/<name>` is set, with the maintainer's own `gh` login and
// git credentials, and is skipped otherwise. The scratch repository is public (a free-plan private
// repository cannot have required checks), protects its default branch with the required checks
// `ci-ok` and `pr-title` and "require branches to be up to date", and holds this repository's
// `pr-title.yml`.
//
// The test changes the repository's default branch, so it refuses to run unless that branch holds
// the marker file `.dipo-scratch` (`SCRATCH_MARKER`), which the maintainer adds by hand to a
// repository meant for this test. Without the marker nothing is pushed and no ci.yml is replaced.
//
// The scratch repository has no Bun workspace, so this repository's `ci.yml` cannot pass there.
// The test therefore keeps a stub `.github/workflows/ci.yml` on the default branch whose `ci-ok`
// job always passes (`STUB_CI`), pushing it once when it is missing. What the test proves does not
// depend on what `ci-ok` runs: that the engine waits for the required checks `ci-ok` and
// `pr-title` reported by GitHub, runs the structural check again, and squash-merges the backlog PR
// without a reviewer. `pr-title` stays the real check.
//
// The test journals one lane-b operation (a label unique to the run, so the operation always
// changes TASK-2), lets the engine push the branch and open the PR, and ticks the merge slot every
// `TICK_MS` until the PR merges. The PR is merged at the end (or closed when the test fails) and
// the branch is deleted, so the repository is left clean apart from the merged label on TASK-2.

import { describe, expect, it } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type OfficeId, StoryId } from "@dipsaus-orchestrator/contract";
import { makeTempDir } from "@dipsaus-orchestrator/testkit";

import { EDIT_KIND, editKind, OfficeLane } from "../../src/backlog/lane";
import { BacklogPrs, findPr } from "../../src/backlog/pr";
import { OfficeGit, spawnGitExec } from "../../src/git";
import { MergeSlot, type SlotOutcome } from "../../src/merge-slot";
import { GhHost } from "../../src/platform/host";
import { systemSpawn } from "../../src/platform/process";
import { addStory } from "../../src/stories/keys";
import { addOffice, openTestState } from "../commands/helpers";
import { BACKLOG_CLI, BACKLOG_FIXTURE } from "../backlog/helpers";

const LIVE_REPO = process.env["DIPO_LIVE_REPO"];
const MERGE_WAIT_MS = 900_000;
const TICK_MS = 10_000;

/** The scratch repository's `ci.yml`: a `ci-ok` that always passes (see the header). */
const STUB_CI = `# dipo live test stub (DIPO-73): this scratch repository has no Bun workspace, so its required
# check ci-ok always passes here. pr-title.yml is the real one.
name: ci

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  ci-ok:
    name: ci-ok
    runs-on: ubuntu-latest
    steps:
      - run: echo "dipo scratch repository"
`;

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

/** The file that marks a repository as a dipo scratch repository the live tests may change. */
const SCRATCH_MARKER = ".dipo-scratch";

/** Refuses a repository whose default branch lacks the scratch marker, saying how to add it. */
function assertScratch(clone: string, repo: string, base: string): void {
  if (existsSync(join(clone, SCRATCH_MARKER))) return;
  throw new Error(
    [
      `${repo} has no ${SCRATCH_MARKER} file on ${base}, so this test will not change it: it pushes to ${base} and replaces .github/workflows/ci.yml with a stub.`,
      `If ${repo} is a scratch repository meant for this test, add the marker once:`,
      `  gh repo clone ${repo} /tmp/dipo-scratch && cd /tmp/dipo-scratch`,
      `  echo "dipo live tests may change this repository" > ${SCRATCH_MARKER}`,
      `  git add ${SCRATCH_MARKER} && git commit -m "chore: mark as a dipo scratch repository" && git push origin HEAD:${base}`,
    ].join("\n"),
  );
}

/** Pushes the Backlog fixture and the stub `ci.yml` to the default branch when either is missing. */
async function prepare(clone: string, repo: string, base: string): Promise<void> {
  assertScratch(clone, repo, base);
  const paths: string[] = [];
  if (!existsSync(join(clone, "backlog"))) {
    cpSync(join(BACKLOG_FIXTURE, "backlog"), join(clone, "backlog"), { recursive: true });
    paths.push("backlog");
  }
  const ci = join(clone, ".github", "workflows", "ci.yml");
  if (!existsSync(ci) || readFileSync(ci, "utf8") !== STUB_CI) {
    mkdirSync(join(clone, ".github", "workflows"), { recursive: true });
    writeFileSync(ci, STUB_CI);
    paths.push(".github/workflows/ci.yml");
  }
  if (paths.length === 0) return;
  await run(clone, "git", "add", "--", ...paths);
  await run(clone, "git", "commit", "--quiet", "-m", "chore: prepare the dipo live test");
  try {
    await run(clone, "git", "push", "--quiet", "origin", `HEAD:${base}`);
  } catch (error) {
    throw new Error(
      `Could not push ${paths.join(" and ")} to ${base} of the scratch repository (${error instanceof Error ? error.message : String(error)}). Put them there by hand once; the stub ci.yml is STUB_CI in this file.`,
      { cause: error },
    );
  }
}

describe.skipIf(LIVE_REPO === undefined || LIVE_REPO === "")("the merge slot on GitHub", () => {
  it(
    "waits for ci-ok and pr-title, then squash-merges the backlog PR without a reviewer",
    async () => {
      const repo = LIVE_REPO as string;
      const root = makeTempDir();
      const clone = join(root, "clone");
      await run(root, "gh", "repo", "clone", repo, clone);
      const base = await run(clone, "git", "rev-parse", "--abbrev-ref", "HEAD");
      await prepare(clone, repo, base);

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
      const slot = new MergeSlot({
        host,
        prs,
        lane: () => lane,
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
        held: (id) => slot.holding(id),
      });

      const key = addStory(office, t.ids, { story: StoryId.parse("TASK-2") }, 0).key;
      // The base moves with every merged run, so its commit makes the label unique to the run.
      const label = `dipo-live-${await run(clone, "git", "rev-parse", "--short=10", "HEAD")}`;
      const { report } = await lane.submit({
        kind: "edit",
        key,
        subject: "TASK-2",
        target: { labels: { add: [label] } },
      });
      const branch = report.branch as string;
      const number = (await host.findOpenPr(repo, branch))?.number ?? -1;
      const outcomes: SlotOutcome[] = [];
      try {
        expect(findPr(office, number)?.check).toBe("passed");
        console.log(`opened ${findPr(office, number)?.url}; structural check passed`);

        const deadline = performance.now() + MERGE_WAIT_MS;
        while (performance.now() < deadline) {
          const outcome = await slot.tick(officeId);
          outcomes.push(outcome);
          console.log(`merge slot: ${outcome}`);
          if (outcome !== "waiting") break;
          await Bun.sleep(TICK_MS);
        }
        // It waited for the checks at least once, then merged.
        expect(outcomes[0]).toBe("waiting");
        expect(outcomes.at(-1)).toBe("merged");
        const merged = await host.viewPr(repo, number);
        expect(merged.state).toBe("merged");
        const checks = await host.requiredChecks(repo, number);
        console.log(`required checks: ${checks.map((c) => `${c.name}=${c.bucket}`).join(", ")}`);
        expect(checks.filter((c) => c.bucket === "pass").map((c) => c.name)).toEqual(
          expect.arrayContaining(["ci-ok", "pr-title"]),
        );
        expect(findPr(office, number)?.state).toBe("merged");
      } finally {
        const pr = number > 0 ? await host.viewPr(repo, number).catch(() => null) : null;
        if (pr?.state === "open") await host.closePr(repo, number, "dipo live test done");
        await run(clone, "git", "push", "--quiet", "origin", "--delete", branch).catch(() => "");
      }
    },
    MERGE_WAIT_MS + 180_000,
  );
});
