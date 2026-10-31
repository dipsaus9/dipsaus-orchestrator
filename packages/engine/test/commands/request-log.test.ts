// The one log line of each command and read (DIPO-320): name, request id, office, outcome code
// and milliseconds, written by the executors, never with the args.

import { describe, expect, it } from "bun:test";

import {
  type EngineError,
  engineError,
  REQUEST_TIMED_OUT,
  RequestId,
  StoryId,
} from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { executeCommand, type ExecutorDeps } from "../../src/commands/execute";
import { stateOfficeDirectory } from "../../src/commands/offices";
import { buildRegistry, type FeatureModule } from "../../src/commands/registry";
import { MemoryRequestTable } from "../../src/commands/requests";
import { createLogger } from "../../src/log/logger";
import { executeRead } from "../../src/reads/execute";
import { addStory } from "../../src/records/story-keys";
import { fixtureFeature, levelCommand } from "./fixtures";
import { addOffice, createFactTable, openTestState, type TestState } from "./helpers";

const R1 = RequestId.parse("01J9ZK5Q8W3V4X6Y7Z8A9B0C1D");
const R2 = RequestId.parse("01J9ZK5Q8W3V4X6Y7Z8A9B0C2E");

/** A software command that takes 250 ms on the manual clock. */
const slowCommand = { ...levelCommand, name: "fixture.slow" };

function slowFeature(t: TestState): FeatureModule {
  return {
    name: "test/slow",
    register(registry) {
      registry.addSoftwareCommand({
        definition: slowCommand,
        handle: async (_ctx, args) => {
          t.clock.advance(250);
          return { result: { level: args.level } };
        },
      });
    },
  };
}

async function setup(dir: string) {
  const t = await openTestState(dir);
  createFactTable(t);
  const office = addOffice(t);
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    clock: t.clock,
    sinks: [(line) => lines.push(JSON.parse(line) as Record<string, unknown>)],
    component: "server",
  });
  const deps: ExecutorDeps = {
    registry: buildRegistry([fixtureFeature({ touch: 0, peek: 0, level: 0 }), slowFeature(t)]),
    offices: stateOfficeDirectory(t.state),
    clock: t.clock,
    ids: t.ids,
    softwareRequests: new MemoryRequestTable(t.clock),
    logger,
  };
  office.immediate(() =>
    addStory(office, t.ids, { story: StoryId.parse("DIPO-7") }, t.clock.now()),
  );
  return { t, office, deps, lines };
}

describe("the request log line", () => {
  it("writes one line per command with its outcome, and none of its args", () =>
    withTempDir(async (dir) => {
      const { t, office, deps, lines } = await setup(dir);
      try {
        const request = {
          office: office.officeId,
          name: "fixture.touch",
          origin: "cli",
          confirmed: false,
        } as const;
        await executeCommand(deps, {
          ...request,
          requestId: R1,
          args: { story: "DIPO-7", text: "a private note" },
        });
        await executeCommand(deps, {
          ...request,
          requestId: R2,
          args: { story: "DIPO-404", text: "a private note" },
        });
        expect(lines).toEqual([
          expect.objectContaining({
            level: "info",
            msg: "command answered",
            component: "server",
            name: "fixture.touch",
            requestId: R1,
            office: office.officeId,
            outcome: "ok",
            ms: 0,
          }),
          expect.objectContaining({ requestId: R2, outcome: "story.unknown" }),
        ]);
        expect(JSON.stringify(lines)).not.toContain("a private note");
      } finally {
        t.state.close();
      }
    }));

  it("counts the milliseconds a command took on the engine clock", () =>
    withTempDir(async (dir) => {
      const { t, deps, lines } = await setup(dir);
      try {
        await executeCommand(deps, {
          requestId: R1,
          name: "fixture.slow",
          args: { level: "debug" },
          origin: "cli",
          confirmed: false,
        });
        expect(lines).toEqual([
          expect.objectContaining({ name: "fixture.slow", outcome: "ok", ms: 250 }),
        ]);
        expect(lines[0]).not.toHaveProperty("office");
      } finally {
        t.state.close();
      }
    }));

  it("writes one line per read, with the office its args name", () =>
    withTempDir(async (dir) => {
      const { t, office, deps, lines } = await setup(dir);
      try {
        await executeRead(deps, {
          requestId: R1,
          name: "fixture.detail",
          args: { office: office.officeId, story: "DIPO-7" },
        });
        await executeRead(deps, { requestId: R2, name: "fixture.missing", args: {} });
        expect(lines).toEqual([
          expect.objectContaining({
            msg: "read answered",
            name: "fixture.detail",
            requestId: R1,
            office: office.officeId,
            outcome: "ok",
            ms: 0,
          }),
          expect.objectContaining({
            name: "fixture.missing",
            requestId: R2,
            outcome: "capability.missing",
          }),
        ]);
      } finally {
        t.state.close();
      }
    }));

  it("writes no line for the engine's own read", () =>
    withTempDir(async (dir) => {
      const { t, office, deps, lines } = await setup(dir);
      try {
        const reply = await executeRead(
          deps,
          {
            requestId: R1,
            name: "fixture.detail",
            args: { office: office.officeId, story: "DIPO-7" },
          },
          { internal: true },
        );
        expect(reply.ok).toBe(true);
        expect(lines).toEqual([]);
      } finally {
        t.state.close();
      }
    }));

  it("names the error the client got when the daemon answered first, and nothing for the late reply", () =>
    withTempDir(async (dir) => {
      const { t, office, deps, lines } = await setup(dir);
      try {
        const answeredWithout = Promise.withResolvers<EngineError>();
        const timedOut = engineError(REQUEST_TIMED_OUT, "past its deadline");
        // The client was answered before the engine's reply came back.
        answeredWithout.resolve(timedOut);
        await Promise.resolve();
        const reply = await executeRead(
          deps,
          {
            requestId: R1,
            name: "fixture.detail",
            args: { office: office.officeId, story: "DIPO-7" },
          },
          { answeredWithout: answeredWithout.promise },
        );
        expect(reply.ok).toBe(true);
        expect(lines).toEqual([
          expect.objectContaining({ requestId: R1, outcome: "request.timedOut" }),
        ]);
      } finally {
        t.state.close();
      }
    }));
});
