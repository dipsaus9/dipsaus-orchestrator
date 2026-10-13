// The Ready gate against an office on the pinned Backlog CLI and real git (DIPO-71 test plan): the
// read `story.gate` on a failing fixture story returns every failure message and stores nothing,
// and inputs that cannot be read answer contract codes. The pickup-mode decision on the CLI runs in
// CI only, in story-gate.ci.test.ts (DIPO-79); its fast local rules are in store.test.ts.

import { describe, expect, it } from "bun:test";

import { type OfficeId, StoryId } from "@dipsaus-orchestrator/contract";

import { CommandError } from "../../src/commands/errors";
import { GateStore } from "../../src/gate";
import { systemSpawn } from "../../src/platform/process";
import { countRows } from "../commands/helpers";
import { backlog, CLI, failed, key, publish, read, withGatedOffice } from "./gated-office";

describe("the Ready gate on the Backlog CLI", () => {
  it("story.gate returns every failure of a failing story and stores nothing", () =>
    withGatedOffice(async ({ s, office, officeId }) => {
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
    }));

  it("answers contract codes with clear messages when the inputs cannot be read", () =>
    withGatedOffice(async ({ repo, s, engineGit, office, officeId }) => {
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
      const deps = { git: engineGit, offices, clock: s.clock, ids: s.ids };
      const broken = new GateStore({
        ...deps,
        cli: { spawn: systemSpawn, command: ["false"], env: repo.env },
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
        cli: CLI(repo),
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
        cli: CLI(repo),
      });
      const gitError = await detached.checkReady(officeId, story).catch((error: unknown) => error);
      expect((gitError as CommandError).error).toMatchObject({
        code: "office.refused",
        details: { office: officeId, step: "git.version" },
      });
      expect(countRows(office, "gates")).toBe(0);
    }));
});
