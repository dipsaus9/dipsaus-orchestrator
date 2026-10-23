// `engine.hello` and capability flags (0005 sections 7 and 11): a flag is offered only when every
// command and read it needs is registered and shipped; another contract major gets
// `contract.unsupported` with the daemon's contract and version.

import { describe, expect, it } from "bun:test";

import {
  CONTRACT_VERSION,
  type CommandDefinition,
  daemonSetLogLevel,
  defineCommand,
  RequestId,
  StreamName,
} from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import { buildRegistry, type FeatureModule } from "../../src/commands/registry";
import { type OfficeDirectory, officeUnknown } from "../../src/commands/offices";
import { executeRead } from "../../src/reads/execute";
import { capabilityFlags, helloFeature } from "../../src/reads/hello";

const noOffices: OfficeDirectory = {
  get: () => undefined,
  load: async (office) => ({ ok: false, error: officeUnknown(office) }),
};

function provisional<D extends CommandDefinition>(definition: D): CommandDefinition {
  const { since: _since, ...rest } = definition;
  return defineCommand({ ...rest, provisional: true });
}

function logLevelFeature(definition: CommandDefinition): FeatureModule {
  return {
    name: "test/log-level",
    register(registry) {
      registry.addSoftwareCommand({
        definition,
        handle: () => ({ result: { level: "info" } }),
      });
    },
  };
}

const hello = helloFeature({
  engineVersion: "1.2.3",
  daemonState: () => "running",
  softwareCursor: () => ({ stream: StreamName.parse("software"), epoch: "e", seq: 7 }),
  officeSummaries: () => [],
});

const requestId = RequestId.parse("01J00000000000000000000000");

describe("capabilityFlags", () => {
  it("offers a flag only when its commands are registered and shipped", () => {
    expect(capabilityFlags(buildRegistry([]))).toEqual(["replay", "usage.alerts"]);
    expect(capabilityFlags(buildRegistry([logLevelFeature(daemonSetLogLevel)]))).toEqual([
      "replay",
      "daemon.logLevel",
      "usage.alerts",
    ]);
    expect(
      capabilityFlags(buildRegistry([logLevelFeature(provisional(daemonSetLogLevel))])),
    ).toEqual(["replay", "usage.alerts"]);
  });
});

describe("engine.hello", () => {
  it("answers a client of the same major", async () => {
    const reply = await executeRead(
      { registry: buildRegistry([hello]), offices: noOffices, clock: new ManualClock() },
      {
        requestId,
        name: "engine.hello",
        args: {
          contract: { major: CONTRACT_VERSION.major, minor: 99 },
          client: { name: "t", version: "0" },
        },
      },
    );
    expect(reply).toEqual({
      ok: true,
      requestId,
      result: {
        engine: "1.2.3",
        contract: { ...CONTRACT_VERSION },
        capabilities: ["replay", "usage.alerts"],
        daemon: "running",
        offices: [],
        cursor: { stream: "software", epoch: "e", seq: 7 },
      },
    });
  });

  it("answers another major with contract.unsupported and the daemon's contract and version", async () => {
    const reply = await executeRead(
      { registry: buildRegistry([hello]), offices: noOffices, clock: new ManualClock() },
      {
        requestId,
        name: "engine.hello",
        args: {
          contract: { major: CONTRACT_VERSION.major + 1, minor: 0 },
          client: { name: "t", version: "0" },
        },
      },
    );
    expect(reply).toMatchObject({
      ok: false,
      error: {
        code: "contract.unsupported",
        retryable: false,
        details: { contract: { ...CONTRACT_VERSION }, version: "1.2.3" },
      },
    });
  });
});
