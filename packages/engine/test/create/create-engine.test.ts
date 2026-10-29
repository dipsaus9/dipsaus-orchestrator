// The one factory (DIPO-318, 0005): `createEngine` starts from fakes for the daemon's process
// concerns (the manual clock, a quiet log, a spawn that runs git in an isolated home, a probe that
// finds no process, and a keep-awake, worker hosts, forwarders and a listener that never start),
// with no daemon package. It recovers into `running`, opens an office on a temporary repository,
// answers a read, and drains. A service whose partner the engine has not connected yet fails
// loudly when it is called.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import {
  CONTRACT_VERSION,
  type CommandReply,
  type OfficeId,
  RequestId,
  SOFTWARE_CONFIG_DEFAULTS,
  type Spawn,
} from "@dipsaus-orchestrator/contract";
import { isolatedEnv, ManualClock, withTempRepo } from "@dipsaus-orchestrator/testkit";

import { buildCore } from "../../src/create/core";
import { createEngine } from "../../src/create/create-engine";
import type { EngineDeps } from "../../src/create/deps";
import { enginePartners } from "../../src/create/partners";
import { buildStoryServices } from "../../src/create/stories";
import { createLogger } from "../../src/log/logger";
import { systemSpawn } from "../../src/platform/process";
import { PartnerNotConnectedError } from "../../src/wiring/partner";

const BACKLOG_FIXTURE = join(import.meta.dir, "..", "fixtures", "backlog");

let requests = 0;
function requestId(): RequestId {
  requests += 1;
  return RequestId.parse(`01J9ZK5Q8W3V4X6Y7Z${requests.toString().padStart(8, "0")}`);
}

/** The daemon's process concerns as fakes, in `root`; git runs with `home` as its home. */
function fakeDeps(root: string, home: string): { deps: EngineDeps; stops: unknown[] } {
  const clock = new ManualClock();
  const env = isolatedEnv(home);
  // Every process the engine starts gets the isolated environment; only git runs in this test.
  const spawn: Spawn = (options) => systemSpawn({ ...options, env: options.env ?? env });
  const stops: unknown[] = [];
  return {
    stops,
    deps: {
      clock,
      logger: createLogger({ clock, sinks: [], component: "test" }),
      spawn,
      probe: async () => null,
      spawnKeepAwake: () => {
        throw new Error("no keep-awake starts here");
      },
      hosts: {
        start: async () => {
          throw new Error("no worker host starts here");
        },
      },
      forwarders: {
        forward: async () => {
          throw new Error("no forwarder starts here");
        },
        reach: async () => false,
      },
      listenHttp: () => {
        throw new Error("no model proxy listens here");
      },
      env: { PATH: "/usr/bin:/bin", HOME: home },
      paths: {
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
        tmpRoot: join(root, "tmp"),
        home,
      },
      tools: {},
      settings: SOFTWARE_CONFIG_DEFAULTS,
      daemon: {
        pid: process.pid,
        uid: -1,
        version: "0.0.0-test",
        startedAt: clock.now(),
        socket: join(root, "run", "dipo.sock"),
        upgradePending: () => false,
        requestStop: (request) => stops.push(request),
      },
      databaseCheck: { because: null, needsCheck: () => {} },
    },
  };
}

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
