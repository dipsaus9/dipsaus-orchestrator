// CI only (0017 section 1): the pickup-mode Ready gate against the pinned Backlog CLI and real git
// (DIPO-71 test plan), moved out of the local suite for its time budget (DIPO-79): a pickup-mode
// `recordGateDecision` stores one decision with every rule result and the content hash, found again
// by `findPassingDecision` once the story passes after a CLI edit pushed to the base; and the
// contract codes on their own office, with the story archived by `backlog task archive`. The fast
// local tests of the decision (stored decisions, the hash, the latest passing decision) are in
// store.test.ts; the read `story.gate` and the contract codes stay local in story-gate.test.ts.

import { describe, expect, it } from "bun:test";

import { type OfficeId, StoryId } from "@dipsaus-orchestrator/contract";

import { CommandError } from "../../src/commands/errors";
import { systemSpawn } from "../../src/platform/process";

import { gateContentHash } from "../../src/gate";
import {
  findPassingDecision,
  gateConfigOf,
  gateDecisionsOf,
  GateStore,
  readGateInput,
  ruleNamesFor,
} from "../../src/gate-decisions";
import { countRows } from "../commands/helpers";
import { backlog, CLI, key, publish, read, withGatedOffice } from "./gated-office";
import { backlogStoryStore } from "../../src/backlog/store";

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("the Ready gate on the Backlog CLI", () => {
    it("answers contract codes with clear messages when the inputs cannot be read", () =>
      withGatedOffice(async ({ repo, s, engineGit, index, office, officeId }) => {
        // Indexed, then archived on the base: the key resolves but the story is not there.
        await backlog(repo, ["task", "archive", "TASK-2"]);
        await publish(repo, "archive TASK-2");
        await engineGit.forOffice(officeId)?.fetch();
        const gone = await read(s, { office: officeId, story: "TASK-2" });
        if (gone.ok) throw new Error("expected story.unknown");
        expect(gone.error.code).toBe("story.unknown");
        expect(gone.error.message).toBe(
          "TASK-2 is not on the office's base branch main; the Ready gate reads the story as it is there, so push or merge it first.",
        );

        const offices = {
          get: (id: OfficeId) => s.manager.get(id),
          config: (id: OfficeId) => s.manager.config(id),
        };
        const deps = { git: engineGit, index, offices, clock: s.clock, ids: s.ids };
        const broken = new GateStore({
          ...deps,
          stories: backlogStoryStore({ spawn: systemSpawn, command: ["false"], env: repo.env }),
        });
        const story = StoryId.parse("TASK-1");
        const cliError = await broken.checkReady(officeId, story).catch((error: unknown) => error);
        expect(cliError).toBeInstanceOf(CommandError);
        expect((cliError as CommandError).error).toMatchObject({
          code: "backlog.unreadable",
          retryable: false,
          details: { office: officeId, story: "TASK-1" },
        });
        expect((cliError as CommandError).error.message).toStartWith(
          "The Ready gate cannot run: the Backlog CLI could not read TASK-1 on the office's base branch main (exited 1",
        );

        const unconfigured = new GateStore({
          ...deps,
          offices: { ...offices, config: () => undefined },
          stories: backlogStoryStore(CLI(repo)),
        });
        const configError = await unconfigured
          .checkReady(officeId, story)
          .catch((error: unknown) => error);
        expect((configError as CommandError).error).toMatchObject({
          code: "config.invalid",
          retryable: false,
          details: { office: officeId },
        });
        expect((configError as CommandError).error.message).toBe(
          `The Ready gate cannot run: office ${officeId} has no valid configuration yet. Fix .dipo/office.yaml and run \`dipo office reload-config\`.`,
        );

        const detached = new GateStore({
          ...deps,
          git: { forOffice: () => undefined },
          stories: backlogStoryStore(CLI(repo)),
        });
        const gitError = await detached
          .checkReady(officeId, story)
          .catch((error: unknown) => error);
        expect((gitError as CommandError).error).toMatchObject({
          code: "office.refused",
          details: { office: officeId, step: "git.version" },
        });
        expect(countRows(office, "gates")).toBe(0);
      }));

    // Its time goes to real Backlog CLI and git subprocesses. It hit bun's 5000 ms default once on
    // PR #159 (run 38942474480), so it gets 20 s. Measured over 5 CI runs of #192 at f0a67d3 (run
    // 39077260569): 3551 to 4775 ms, so the slowest run is under half of that (DIPO-171).
    it(
      "a pickup-mode evaluation stores one decision with every rule result and the hash",
      () =>
        withGatedOffice(async ({ repo, s, engineGit, index, gates, office, officeId }) => {
          const task1 = key(office, "TASK-1");
          const rejected = await gates.recordGateDecision(officeId, task1, "pickup");
          expect(rejected.passed).toBe(false);
          expect(rejected.mode).toBe("pickup");
          expect(rejected.result.failures.map((f) => f.rule)).toEqual(["R06", "R07", "R11"]);
          expect(rejected.ruleResults.map((r) => r.rule)).toEqual(ruleNamesFor("pickup"));
          expect(rejected.ruleResults.filter((r) => !r.passed).map((r) => r.rule)).toEqual([
            "R06",
            "R07",
            "R11",
          ]);
          expect(gateDecisionsOf(office, task1)).toEqual([
            {
              gate: rejected.gate,
              key: task1,
              mode: "pickup",
              passed: false,
              ruleResults: rejected.ruleResults,
              contentHash: rejected.contentHash,
              decidedAt: s.clock.now(),
            },
          ]);
          const git = engineGit.forOffice(officeId);
          const config = s.manager.config(officeId);
          if (git === undefined || config === undefined) throw new Error("office not loaded");
          const base = await git.ensureBaseWorktree();
          const input = await readGateInput(
            backlogStoryStore(CLI(repo)),
            base.path,
            "TASK-1",
            gateConfigOf(config),
          );
          expect(rejected.contentHash).toBe(gateContentHash(input.story));
          expect(findPassingDecision(office, task1, rejected.contentHash)).toBeUndefined();

          await backlog(repo, ["milestone", "add", "M0 Walking skeleton"]);
          await backlog(repo, [
            "task",
            "edit",
            "TASK-1",
            "--type",
            "feature",
            "-m",
            "m-0",
            "--ref",
            "packages/export/",
          ]);
          await publish(repo, "make TASK-1 pass the gate");
          await git.fetch();
          await index.indexStories(officeId);

          s.clock.advance(1000);
          const approved = await gates.recordGateDecision(officeId, task1, "pickup");
          expect(approved.result.failures).toEqual([]);
          expect(approved.passed).toBe(true);
          expect(approved.contentHash).not.toBe(rejected.contentHash);
          expect(countRows(office, "gate_decisions")).toBe(2);
          expect(findPassingDecision(office, task1, approved.contentHash)?.gate).toBe(
            approved.gate,
          );
        }),
      20_000,
    );
  });
}
