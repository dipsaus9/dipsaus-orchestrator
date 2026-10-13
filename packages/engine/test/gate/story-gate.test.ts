// The Ready gate against an office on the pinned Backlog CLI and real git (DIPO-71 test plan): the
// read `story.gate` on a failing fixture story returns every failure message and stores nothing,
// and a pickup-mode `recordGateDecision` stores one decision with every rule result and the
// content hash, found again by `findPassingDecision` once the story passes.

import { describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { type OfficeId, type ReadReply, StoryId, StoryKey } from "@dipsaus-orchestrator/contract";
import { type TempRepoWithRemote, withBareRemote } from "@dipsaus-orchestrator/testkit";

import { CommandError } from "../../src/commands/errors";
import type { OfficeHandle } from "../../src/db/office";
import {
  findPassingDecision,
  gateConfigOf,
  gateContentHash,
  gateDecisionsOf,
  GateStore,
  readGateInput,
  ruleNamesFor,
} from "../../src/gate";
import { EngineGit } from "../../src/git";
import { systemSpawn } from "../../src/platform/process";
import { executeRead } from "../../src/reads/execute";
import { StoryIndex } from "../../src/stories/feature";
import { BACKLOG_CLI } from "../backlog/helpers";
import { countRows } from "../commands/helpers";
import {
  BACKLOG_FIXTURE,
  nextRequestId,
  type OfficeSetup,
  officeSetup,
  resultOf,
  send,
} from "../office/helpers";
import { keyOf } from "../stories/helpers";

interface Gated {
  readonly repo: TempRepoWithRemote;
  readonly s: OfficeSetup;
  readonly engineGit: EngineGit;
  readonly index: StoryIndex;
  readonly gates: GateStore;
  readonly officeId: OfficeId;
  readonly office: OfficeHandle;
}

const CLI = (repo: TempRepoWithRemote) => ({
  spawn: systemSpawn,
  command: BACKLOG_CLI,
  env: repo.env,
});

async function backlog(repo: TempRepoWithRemote, args: string[]): Promise<void> {
  const result = await repo.run([...BACKLOG_CLI, ...args], repo.dir);
  if (result.exitCode !== 0) {
    throw new Error(`backlog ${args.join(" ")} failed: ${result.stderr}${result.stdout}`);
  }
}

async function publish(repo: TempRepoWithRemote, message: string): Promise<void> {
  await repo.commitAll(message);
  await repo.git("push", "--quiet", "origin", "main");
}

/** The Backlog fixture on a bare `origin`, loaded as an office with the index and the gate. */
function withGatedOffice(fn: (o: Gated) => Promise<void>): Promise<void> {
  return withBareRemote(
    async (repo) => {
      mkdirSync(join(repo.dir, "backlog", "archive", "tasks"), { recursive: true });
      await repo.commitAll("fixture");
      await repo.git("push", "--quiet", "-u", "origin", "main");
      await repo.git("remote", "set-head", "origin", "main");

      const engineGit = new EngineGit({ spawn: systemSpawn, env: repo.env });
      let setup: OfficeSetup | undefined;
      const offices = {
        get: (office: OfficeId) => setup?.manager.get(office),
        config: (office: OfficeId) => setup?.manager.config(office),
      };
      const index = new StoryIndex({ git: engineGit, cli: CLI(repo), offices });
      const loaded = (): OfficeSetup => {
        if (setup === undefined) throw new Error("the office setup is not built yet");
        return setup;
      };
      // The setup builds its clock and ids; the store reads them when it runs.
      const gates = new GateStore({
        git: engineGit,
        cli: CLI(repo),
        offices,
        get clock() {
          return loaded().clock;
        },
        get ids() {
          return loaded().ids;
        },
      });
      const s = await officeSetup(repo.root, {
        features: [engineGit.feature, index.feature, gates.feature],
      });
      setup = s;
      try {
        const { office: officeId } = resultOf<{ office: OfficeId }>(
          await send(s, "office.open", { path: repo.dir }),
        );
        const access = await s.manager.load(officeId);
        if (!access.ok) throw new Error(`${access.error.code}: ${access.error.message}`);
        await fn({ repo, s, engineGit, index, gates, officeId, office: access.office });
      } finally {
        index.stop();
        s.state.close();
      }
    },
    { fixture: BACKLOG_FIXTURE },
  );
}

function read(s: OfficeSetup, args: unknown): Promise<ReadReply> {
  return executeRead(
    { registry: s.registry, offices: s.manager, clock: s.clock },
    { requestId: nextRequestId(), name: "story.gate", args },
  );
}

function key(office: OfficeHandle, id: string): StoryKey {
  return StoryKey.parse(keyOf(office, id));
}

const failed = (id: string, rule: string, message: string) => ({
  rule,
  message: `ready ${id} failed ${rule}: ${message}`,
});

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
