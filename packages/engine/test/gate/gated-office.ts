// The Ready gate on an office over the pinned Backlog CLI and real git (DIPO-71): the Backlog
// fixture on a bare `origin`, loaded as an office with the story index and the gate store. Shared by
// story-gate.test.ts and its CI-only sibling story-gate.ci.test.ts.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { type OfficeId, type ReadReply, StoryKey } from "@dipsaus-orchestrator/contract";
import { type TempRepoWithRemote, withBareRemote } from "@dipsaus-orchestrator/testkit";

import type { OfficeHandle } from "../../src/db/office";
import type { Logger } from "../../src/log/logger";
import { GateStore } from "../../src/gate-decisions";
import { EngineGit } from "../../src/git";
import { systemSpawn } from "../../src/platform/process";
import { executeRead } from "../../src/reads/execute";
import { StoryIndex } from "../../src/stories/feature";
import { BACKLOG_CLI } from "../backlog/helpers";
import {
  BACKLOG_FIXTURE,
  nextRequestId,
  type OfficeSetup,
  officeSetup,
  resultOf,
  send,
} from "../office/helpers";
import { keyOf } from "../stories/helpers";
import { backlogStoryStore } from "../../src/backlog/store";

export interface Warning {
  readonly message: string;
  readonly fields: unknown;
}

/** A logger that keeps what the index warns about. */
function recordingLogger(warnings: Warning[]): Logger {
  const logger: Logger = {
    error: () => {},
    warn: (message, fields) => void warnings.push({ message, fields }),
    info: () => {},
    debug: () => {},
    trace: () => {},
    child: () => logger,
    setLevel: () => {},
    level: () => "warn",
  };
  return logger;
}

export interface Gated {
  /** The offices the index reported as changed, one entry per call. */
  readonly changed: readonly OfficeId[];
  /** The warnings the index logged. */
  readonly warnings: readonly Warning[];
  readonly repo: TempRepoWithRemote;
  readonly s: OfficeSetup;
  readonly engineGit: EngineGit;
  readonly index: StoryIndex;
  readonly gates: GateStore;
  readonly officeId: OfficeId;
  readonly office: OfficeHandle;
}

export const CLI = (repo: TempRepoWithRemote) => ({
  spawn: systemSpawn,
  command: BACKLOG_CLI,
  env: repo.env,
});

export async function backlog(repo: TempRepoWithRemote, args: string[]): Promise<void> {
  const result = await repo.run([...BACKLOG_CLI, ...args], repo.dir);
  if (result.exitCode !== 0) {
    throw new Error(`backlog ${args.join(" ")} failed: ${result.stderr}${result.stdout}`);
  }
}

export async function publish(repo: TempRepoWithRemote, message: string): Promise<void> {
  await repo.commitAll(message);
  await repo.git("push", "--quiet", "origin", "main");
}

/** The Backlog fixture on a bare `origin`, loaded as an office with the index and the gate. */
export function withGatedOffice(fn: (o: Gated) => Promise<void>): Promise<void> {
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
      const changed: OfficeId[] = [];
      const warnings: Warning[] = [];
      const index = new StoryIndex({
        git: engineGit,
        stories: backlogStoryStore(CLI(repo)),
        offices,
        onOfficeChanged: (office) => changed.push(office),
        logger: recordingLogger(warnings),
      });
      const loaded = (): OfficeSetup => {
        if (setup === undefined) throw new Error("the office setup is not built yet");
        return setup;
      };
      // The setup builds its clock and ids; the store reads them when it runs.
      const gates = new GateStore({
        git: engineGit,
        stories: backlogStoryStore(CLI(repo)),
        offices,
        index,
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
        await fn({
          changed,
          warnings,
          repo,
          s,
          engineGit,
          index,
          gates,
          officeId,
          office: access.office,
        });
      } finally {
        index.stop();
        s.state.close();
      }
    },
    { fixture: BACKLOG_FIXTURE },
  );
}

export function read(s: OfficeSetup, args: unknown): Promise<ReadReply> {
  return executeRead(
    { registry: s.registry, offices: s.manager, clock: s.clock },
    { requestId: nextRequestId(), name: "story.gate", args },
  );
}

export function key(office: OfficeHandle, id: string): StoryKey {
  return StoryKey.parse(keyOf(office, id));
}

export const failed = (id: string, rule: string, message: string) => ({
  rule,
  message: `ready ${id} failed ${rule}: ${message}`,
});
