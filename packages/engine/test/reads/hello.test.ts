// `engine.hello` (0005): the daemon's binary version, its state, the offices and the software
// cursor. It carries no contract version and no capability flags: client and daemon are one binary.

import { describe, expect, it } from "bun:test";

import { RequestId, StreamName } from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import { buildRegistry } from "../../src/commands/registry";
import { type OfficeDirectory, officeUnknown } from "../../src/commands/offices";
import { executeRead } from "../../src/reads/execute";
import { helloFeature } from "../../src/reads/hello";

const noOffices: OfficeDirectory = {
  get: () => undefined,
  load: async (office) => ({ ok: false, error: officeUnknown(office) }),
};

const hello = helloFeature({
  engineVersion: "1.2.3",
  daemonState: () => "running",
  softwareCursor: () => ({ stream: StreamName.parse("software"), seq: 7 }),
  officeSummaries: () => [],
});

const requestId = RequestId.parse("01J00000000000000000000000");

describe("engine.hello", () => {
  it("answers with the daemon's version, state, offices and cursor", async () => {
    const reply = await executeRead(
      { registry: buildRegistry([hello]), offices: noOffices, clock: new ManualClock() },
      { requestId, name: "engine.hello", args: { client: { name: "t", version: "0" } } },
    );
    expect(reply).toEqual({
      ok: true,
      requestId,
      result: {
        engine: "1.2.3",
        daemon: "running",
        offices: [],
        cursor: { stream: "software", seq: 7 },
      },
    });
  });

  it("answers a hello that still names a contract, as an older client sends it", async () => {
    const reply = await executeRead(
      { registry: buildRegistry([hello]), offices: noOffices, clock: new ManualClock() },
      {
        requestId,
        name: "engine.hello",
        args: { contract: { major: 1, minor: 1 }, client: { name: "t", version: "0" } },
      },
    );
    expect(reply).toMatchObject({ ok: true, result: { engine: "1.2.3" } });
  });
});
