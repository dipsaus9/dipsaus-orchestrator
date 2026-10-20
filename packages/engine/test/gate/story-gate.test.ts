// The Ready gate against an office on the pinned Backlog CLI and real git (DIPO-71 test plan): the
// read `story.gate` on a failing fixture story returns every failure message and stores nothing,
// and inputs that cannot be read answer contract codes, on one office. The pickup-mode decision on
// the CLI and the contract codes after `backlog task archive` run in CI only, in
// story-gate.ci.test.ts (DIPO-79); the fast local rules of the decision are in store.test.ts.
// The story.gate test runs real git and the pinned Backlog CLI several times: it took about 4 seconds
// on an idle machine and timed out at 5 seconds on a busy one, so it has its own 30 second limit
// (0017, Timeouts) and stays local.

import { describe, expect, it } from "bun:test";

import { type OfficeId, StoryId } from "@dipsaus-orchestrator/contract";

import { CommandError } from "../../src/commands/errors";
import { cachedGateTasks, GateStore } from "../../src/gate";
import { systemSpawn } from "../../src/platform/process";
import { countRows } from "../commands/helpers";
import { backlog, CLI, failed, key, publish, read, withGatedOffice } from "./gated-office";

describe("the Ready gate on the Backlog CLI", () => {
  it(
    "story.gate returns every failure of a failing story and stores nothing; unreadable inputs answer contract codes",
    () =>
      withGatedOffice(async ({ repo, s, engineGit, office, officeId }) => {
        const reply = await read(s, { office: officeId, story: "TASK-2" });
        if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`);
        expect(reply.result).toEqual({
          story: "TASK-2",
          key: key(office, "TASK-2"),
          passed: false,
          failures: [
            failed(
              "TASK-2",
              "R06",
              "type is missing or not one of feature, bug, enhancement, task, chore, docs, spike",
            ),
            failed("TASK-2", "R07", "milestone is missing or does not exist"),
            failed("TASK-2", "R11", "no declared scope; add at least one path with --ref"),
            failed(
              "TASK-2",
              "R18",
              'branch "" must be TASK-2/<slug> with a lowercase hyphenated slug',
            ),
          ],
        });
        // TASK-1 is Ready, not Refined: ready mode fails R01a.
        const ready = await read(s, { office: officeId, story: "TASK-1" });
        if (!ready.ok) throw new Error(`${ready.error.code}: ${ready.error.message}`);
        expect((ready.result as { failures: { rule: string }[] }).failures[0]).toEqual(
          failed("TASK-1", "R01a", "status is Ready; only Refined stories can be made Ready"),
        );
        expect(countRows(office, "gates")).toBe(0);
        expect(countRows(office, "gate_decisions")).toBe(0);

        const unknown = await read(s, { office: officeId, story: "TASK-99" });
        expect(unknown.ok ? "ok" : unknown.error.code).toBe("story.unknown");

        // The contract codes, on the same office (the fast local version; the full case with
        // `backlog task archive` is in story-gate.ci.test.ts, DIPO-79).
        const offices = {
          get: (id: OfficeId) => s.manager.get(id),
          config: (id: OfficeId) => s.manager.config(id),
        };
        const deps = { git: engineGit, offices, clock: s.clock, ids: s.ids };
        const story = StoryId.parse("TASK-1");
        const broken = new GateStore({
          ...deps,
          cli: { spawn: systemSpawn, command: ["false"], env: repo.env },
        });
        const cliError = await broken.checkReady(officeId, story).catch((error: unknown) => error);
        expect((cliError as CommandError).error).toMatchObject({
          code: "backlog.unreadable",
          details: { office: officeId, story: "TASK-1" },
        });
        const unconfigured = new GateStore({
          ...deps,
          offices: { ...offices, config: () => undefined },
          cli: CLI(repo),
        });
        const configError = await unconfigured
          .checkReady(officeId, story)
          .catch((error: unknown) => error);
        expect((configError as CommandError).error.code).toBe("config.invalid");
        const detached = new GateStore({
          ...deps,
          git: { forOffice: () => undefined },
          cli: CLI(repo),
        });
        const gitError = await detached
          .checkReady(officeId, story)
          .catch((error: unknown) => error);
        expect((gitError as CommandError).error).toMatchObject({
          code: "office.refused",
          details: { office: officeId, step: "git.version" },
        });

        // The tasks were mirrored at the base the office loaded. A commit that gives TASK-1 and
        // TASK-2 one branch moves `_base` on; the gate brings the mirror to that commit first, so
        // R19 sees the branch TASK-1 has there.
        const mirrored = (sha: string) => cachedGateTasks(office, sha)?.length;
        const before = (await repo.git("rev-parse", "HEAD")).trim();
        expect(mirrored(before)).toBeGreaterThan(0);
        const shared = '```dipo\nbranch: "TASK-2/shared-branch"\n```';
        await backlog(repo, ["task", "edit", "TASK-1", "-d", shared]);
        await backlog(repo, ["task", "edit", "TASK-2", "-d", shared]);
        const moved = await repo.commitAll("share a branch");
        await repo.git("push", "--quiet", "origin", "main");
        await engineGit.forOffice(officeId)?.fetch();
        expect(mirrored(moved)).toBeUndefined();
        const shareReply = await read(s, { office: officeId, story: "TASK-2" });
        if (!shareReply.ok)
          throw new Error(`${shareReply.error.code}: ${shareReply.error.message}`);
        expect(
          (shareReply.result as { failures: { message: string }[] }).failures.map((f) => f.message),
        ).toContain(
          failed("TASK-2", "R19", 'branch "TASK-2/shared-branch" is already used by TASK-1')
            .message,
        );
        expect(mirrored(moved)).toBeGreaterThan(0);
        expect(mirrored(before)).toBeUndefined();

        // Indexed, then removed on the base with git: the key resolves but the story is not there.
        await repo.git("rm", "--quiet", "-r", "backlog/tasks");
        await publish(repo, "remove the tasks");
        await engineGit.forOffice(officeId)?.fetch();
        const gone = await read(s, { office: officeId, story: "TASK-2" });
        expect(gone.ok ? "ok" : gone.error.message).toBe(
          "TASK-2 is not on the office's base branch main; the Ready gate reads the story as it is there, so push or merge it first.",
        );
        expect(countRows(office, "gates")).toBe(0);
      }),
    30000,
  );
});
