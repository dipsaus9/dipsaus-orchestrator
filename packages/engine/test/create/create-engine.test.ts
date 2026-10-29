// The one factory (DIPO-318, 0005): `createEngine` starts from fakes for the daemon's process
// concerns (the manual clock, a quiet log, a spawn that runs git in an isolated home, a probe that
// finds no process, and a keep-awake, worker hosts, forwarders and a listener that never start),
// with no daemon package. It recovers into `running`, opens an office on a temporary repository,
// answers a read, and drains. A service whose partner the engine has not connected yet fails
// loudly when it is called.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { CONTRACT_VERSION, type CommandReply, type OfficeId } from "@dipsaus-orchestrator/contract";
import { withTempRepo } from "@dipsaus-orchestrator/testkit";

import { buildCore } from "../../src/create/core";
import { createEngine } from "../../src/create/create-engine";
import { enginePartners } from "../../src/create/partners";
import { buildStoryServices } from "../../src/create/stories";
import { PartnerNotConnectedError } from "../../src/wiring/partner";
import { BACKLOG_FIXTURE, fakeDeps, requestId } from "./engine-fixture";

function resultOf<T>(reply: CommandReply | { ok: boolean }): T {
  if (!("result" in reply) || !reply.ok) throw new Error(JSON.stringify(reply));
  return reply.result as T;
}

describe("createEngine", () => {
  it("starts with fakes, opens an office, runs a command and a read, and drains", () =>
    withTempRepo(
      async (repo) => {
        const { deps } = fakeDeps(repo.root, join(repo.root, "home"));
        const engine = createEngine(deps);
        try {
          expect(engine.state()).toBe("starting");
          await engine.recover({ crashLoop: false });
          expect(engine.state()).toBe("running");

          const opened = resultOf<{ office: OfficeId; registered: boolean }>(
            await engine.executeCommand({
              requestId: requestId(),
              name: "office.open",
              args: { path: repo.dir },
              origin: "cli",
              confirmed: false,
            }),
          );
          expect(opened.registered).toBe(true);

          const hello = resultOf<{ offices: readonly { office: OfficeId }[] }>(
            await engine.executeRead({
              requestId: requestId(),
              name: "engine.hello",
              args: { client: { name: "test", version: "0.0.0-test" }, contract: CONTRACT_VERSION },
            }),
          );
          expect(hello.offices.map((summary) => summary.office)).toEqual([opened.office]);

          const drained = await engine.drain({ reason: "test", stopWorkers: false });
          expect(drained).toEqual({ capped: false, killed: [] });
          expect(engine.state()).toBe("draining");
        } finally {
          await engine.stop();
          engine.closeDatabase();
        }
      },
      { fixture: BACKLOG_FIXTURE },
    ));

  it("fails loudly when a service calls a partner the engine has not connected", () =>
    withTempRepo(async (repo) => {
      const { deps } = fakeDeps(repo.root, join(repo.root, "home"));
      const story = buildStoryServices(buildCore(deps), enginePartners());
      // The auto-merge guard calls the auto-merge, which the engine builds later.
      expect(() =>
        story.autoMergeGuard("off_01J9ZK5Q8W3V4X6Y7Z00000001" as OfficeId, "DIPO-1/x", async () => {
          throw new Error("no write runs before the guard");
        }),
      ).toThrow(PartnerNotConnectedError);
    }));
});
