// CI only (0017 section 1): the pickup-mode Ready gate against the pinned Backlog CLI and real git
// (DIPO-71 test plan), moved out of the local suite for its time budget (DIPO-79): a pickup-mode
// `recordGateDecision` stores one decision with every rule result and the content hash, found again
// by `findPassingDecision` once the story passes after a CLI edit pushed to the base. The fast local
// tests of the same rules (stored decisions, the hash, the latest passing decision) are in
// store.test.ts; the read `story.gate` on the CLI stays local in story-gate.test.ts.

import { describe, expect, it } from "bun:test";

import {
  findPassingDecision,
  gateConfigOf,
  gateContentHash,
  gateDecisionsOf,
  readGateInput,
  ruleNamesFor,
} from "../../src/gate";
import { countRows } from "../commands/helpers";
import { backlog, CLI, key, publish, withGatedOffice } from "./gated-office";

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("the Ready gate on the Backlog CLI", () => {
    it("a pickup-mode evaluation stores one decision with every rule result and the hash", () =>
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
        const input = await readGateInput(CLI(repo), base.path, "TASK-1", gateConfigOf(config));
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
        expect(findPassingDecision(office, task1, approved.contentHash)?.gate).toBe(approved.gate);
      }));
  });
}
