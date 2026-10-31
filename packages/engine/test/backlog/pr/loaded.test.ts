// The backlog PR of a flush during office load (DIPO-403; gap G18): the replay step of the lane
// pushes its branch while the office has no handle yet, so the PR waits and opens once the office
// has loaded, with no further lane operation. Real temporary repositories and the in-memory host.

import { describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { type TempRepoWithRemote, withBareRemote } from "@dipsaus-orchestrator/testkit";

import { allEntries, BacklogLane } from "../../../src/backlog/lane";
import { findPr } from "../../../src/backlog/pr";
import { buildRegistry } from "../../../src/commands/registry";
import { EngineGit } from "../../../src/git";
import type { OfficeLoadContext } from "../../../src/office/steps";
import { systemSpawn } from "../../../src/platform/process";
import { BACKLOG_FIXTURE, publish, storyKey } from "../lane/helpers";

import { laneSetup, type PrSetup, prSetup } from "./helpers";

const FIXTURE = { fixture: BACKLOG_FIXTURE };

/** One daemon start: a fresh engine git and lane whose replay flush hands its report to the PRs. */
async function startLoad(
  ctx: OfficeLoadContext,
  env: Record<string, string>,
  s: PrSetup,
): Promise<BacklogLane> {
  const engineGit = new EngineGit({ spawn: systemSpawn, env });
  const lane = new BacklogLane({
    cli: s.cli,
    git: (office) => engineGit.forOffice(office),
    onFlushed: (office, report) => s.prs.afterFlush(office, report),
  });
  const registry = buildRegistry([engineGit.feature, lane.feature]);
  for (const step of registry.loadSteps()) {
    const outcome = await step.run(ctx);
    if (outcome !== undefined && !outcome.ok) throw new Error(`${step.name}: ${outcome.reason}`);
  }
  return lane;
}

/**
 * Journals an edit, then starts the office again while it loads: the replay step pushes the
 * branch and the office has no handle yet, so nothing opens. Returns the branch.
 */
async function pushedAtLoad(
  repo: TempRepoWithRemote,
  s: PrSetup,
  ctx: OfficeLoadContext,
  loading: { value: boolean },
): Promise<string> {
  const key = storyKey(s);
  const before = await startLoad(ctx, repo.env, s);
  const lane = before.forOffice(ctx.officeId);
  if (lane === undefined) throw new Error("lane not attached");
  await lane.journal({ kind: "edit", key, subject: "TASK-1", target: { status: "Refined" } });

  loading.value = true;
  await startLoad(ctx, repo.env, s);
  loading.value = false;
  const [entry] = allEntries(s.office);
  expect(entry?.state).toBe("pushed");
  expect(s.host.prs.size).toBe(0);
  return entry?.branch as string;
}

describe("the backlog PR of a flush during office load", () => {
  it("opens the PR once the office has loaded, without another lane operation", async () => {
    await withBareRemote(async (repo) => {
      await publish(repo);
      // No `base` configured: the lane follows `origin/HEAD`.
      await repo.git("remote", "set-head", "origin", "main");
      const loading = { value: false };
      const s = await prSetup(repo, await laneSetup(repo), { loading: () => loading.value });
      const ctx: OfficeLoadContext = {
        officeId: s.office.officeId as OfficeId,
        office: s.office,
        path: realpathSync(repo.dir),
        commonDir: realpathSync(join(repo.dir, ".git")),
        config: undefined,
        clock: s.t.clock,
        ids: s.t.ids,
      };
      const branch = await pushedAtLoad(repo, s, ctx, loading);

      // The office has loaded: the event starts the publication of the waiting flush.
      await s.prs.loaded(ctx.officeId);
      expect(s.host.calls.filter((call) => call.startsWith("create"))).toHaveLength(1);
      expect([...s.host.prs.values()].map((pr) => [pr.head, pr.title])).toEqual([
        [branch, "chore(backlog): edit TASK-1"],
      ]);
      expect(findPr(s.office, 1)).toMatchObject({ state: "open", branch, check: "passed" });

      // Once published, a later event has nothing left to do.
      await s.prs.loaded(ctx.officeId);
      expect(s.host.calls.filter((call) => call.startsWith("create"))).toHaveLength(1);
    }, FIXTURE);
  });

  it("says on the desk when the PR of a flush during office load did not open", async () => {
    await withBareRemote(async (repo) => {
      await publish(repo);
      await repo.git("remote", "set-head", "origin", "main");
      const loading = { value: false };
      const s = await prSetup(repo, await laneSetup(repo), { loading: () => loading.value });
      const ctx: OfficeLoadContext = {
        officeId: s.office.officeId as OfficeId,
        office: s.office,
        path: realpathSync(repo.dir),
        commonDir: realpathSync(join(repo.dir, ".git")),
        config: undefined,
        clock: s.t.clock,
        ids: s.t.ids,
      };
      const branch = await pushedAtLoad(repo, s, ctx, loading);

      // A host error is a waiting reason; a thrown error is what `loaded` reports (DIPO-403).
      s.host.createPr = () => Promise.reject(new Error("the host is down"));
      await s.prs.loaded(ctx.officeId);
      expect(s.host.prs.size).toBe(0);
      expect(s.prs.loadFailure(ctx.officeId)).toMatchObject({
        branch,
        reason: "the host is down",
      });
      expect(s.prs.loadFailureDeskItems(ctx.officeId)).toMatchObject([{ kind: "BACKLOG PR" }]);
    }, FIXTURE);
  });
});
