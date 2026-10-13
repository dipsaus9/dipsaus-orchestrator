// The command and read registry (DIPO-22, M0 review): feature modules register through
// `register(registry)`, duplicates fail at startup naming both modules, and `commands.describe`
// lists what was registered.

import { describe, expect, it } from "bun:test";

import { commandsDescribe, RequestId, StoryId } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { executeCommand } from "../../src/commands/execute";
import { stateOfficeDirectory } from "../../src/commands/offices";
import {
  buildRegistry,
  DuplicateRegistrationError,
  type FeatureModule,
  InvalidRegistrationError,
} from "../../src/commands/registry";
import { MemoryRequestTable } from "../../src/commands/requests";
import { engineRegistry, FEATURES } from "../../src/features";
import { executeRead } from "../../src/reads/execute";
import { describeFeature } from "../../src/reads/describe";
import { addStory } from "../../src/stories/keys";
import {
  detailRead,
  type FixtureCalls,
  fixtureFeature,
  fixtureView,
  touchCommand,
} from "./fixtures";
import { addOffice, createFactTable, openTestState } from "./helpers";

const R1 = RequestId.parse("01J9ZK5Q8W3V4X6Y7Z8A9B0C1D");
const newCalls = (): FixtureCalls => ({ touch: 0, peek: 0, level: 0 });

describe("registry", () => {
  it("reaches a registered feature module through executeCommand", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        createFactTable(t);
        const office = addOffice(t);
        office.immediate(() => addStory(office, t.ids, { story: StoryId.parse("DIPO-3") }, 0));
        const calls = newCalls();
        const registry = buildRegistry([describeFeature, fixtureFeature(calls)]);
        expect(registry.command("fixture.touch")?.module).toBe("test/fixture");

        const reply = await executeCommand(
          {
            registry,
            offices: stateOfficeDirectory(t.state),
            clock: t.clock,
            ids: t.ids,
            softwareRequests: new MemoryRequestTable(t.clock),
          },
          {
            requestId: R1,
            office: office.officeId,
            name: "fixture.touch",
            args: { story: "DIPO-3", text: "hi" },
            origin: "cli",
            confirmed: false,
          },
        );
        expect(reply.ok).toBe(true);
        expect(calls.touch).toBe(1);
      } finally {
        t.state.close();
      }
    }));

  it("fails at startup when two modules register the same command, naming both", () => {
    const twin: FeatureModule = {
      name: "test/twin",
      register(registry) {
        registry.addOfficeCommand({
          definition: touchCommand,
          handle: () => ({ result: { run: "unused", delivered: "next-turn" as const } }),
        });
      },
    };
    const build = () => buildRegistry([fixtureFeature(newCalls()), twin]);
    expect(build).toThrow(DuplicateRegistrationError);
    expect(build).toThrow(
      "The command fixture.touch is registered by both test/fixture and test/twin",
    );
  });

  it("fails at startup when two modules register the same read, naming both", () => {
    const twin: FeatureModule = {
      name: "test/twin",
      register(registry) {
        registry.addRead({
          definition: detailRead,
          handle: () => ({ view: {}, runs: [], verdicts: [] }) as never,
        });
      },
    };
    expect(() => buildRegistry([fixtureFeature(newCalls()), twin])).toThrow(
      "The read fixture.detail is registered by both test/fixture and test/twin",
    );
    expect(() => buildRegistry([describeFeature, describeFeature])).toThrow(
      "The read commands.describe is registered by both reads/describe and reads/describe",
    );
    const waiting: FeatureModule = {
      name: "test/waiting",
      register(registry) {
        registry.addAsyncRead({
          definition: detailRead,
          handle: async () => ({ view: {}, runs: [], verdicts: [] }) as never,
        });
      },
    };
    expect(() => buildRegistry([fixtureFeature(newCalls()), waiting])).toThrow(
      "The read fixture.detail is registered by both test/fixture and test/waiting",
    );
  });

  it("runs an async read after resolving its story references (DIPO-71)", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const office = addOffice(t);
        const story = office.immediate(() =>
          addStory(office, t.ids, { story: StoryId.parse("DIPO-3") }, 0),
        );
        const seen: unknown[] = [];
        const waiting: FeatureModule = {
          name: "test/waiting",
          register(registry) {
            registry.addAsyncRead({
              definition: detailRead,
              handle: async (ctx, args) => {
                await Promise.resolve();
                seen.push(ctx.stories.get(args.story), ctx.office?.officeId);
                return { view: fixtureView(story.key, story.story), runs: [], verdicts: [] };
              },
            });
          },
        };
        const registry = buildRegistry([waiting]);
        expect(registry.read("fixture.detail")?.waits).toBe(true);
        const deps = { registry, offices: stateOfficeDirectory(t.state), clock: t.clock };
        const args = { office: office.officeId, story: "DIPO-3" };
        const reply = await executeRead(deps, { requestId: R1, name: "fixture.detail", args });
        expect(reply.ok ? "ok" : reply.error.message).toBe("ok");
        expect(seen).toEqual([story, office.officeId]);
        const unknown = await executeRead(deps, {
          requestId: R1,
          name: "fixture.detail",
          args: { office: office.officeId, story: "DIPO-9" },
        });
        expect(unknown.ok ? "ok" : unknown.error.code).toBe("story.unknown");
        expect(seen).toHaveLength(2);
      } finally {
        t.state.close();
      }
    }));

  it("refuses a definition with a broken since/provisional pair or the wrong level", () => {
    const bad: FeatureModule = {
      name: "test/bad",
      register(registry) {
        registry.addOfficeCommand({
          definition: {
            ...touchCommand,
            name: "fixture.bad",
            since: 999,
          } as unknown as typeof touchCommand,
          handle: () => ({ result: { run: "unused", delivered: "next-turn" as const } }),
        });
      },
    };
    expect(() => buildRegistry([bad])).toThrow(InvalidRegistrationError);
    expect(() => buildRegistry([bad])).toThrow("test/bad registers fixture.bad");

    const wrongLevel: FeatureModule = {
      name: "test/level",
      register(registry) {
        registry.addSoftwareCommand({
          definition: touchCommand,
          handle: () => ({ result: { run: "unused", delivered: "next-turn" as const } }),
        });
      },
    };
    expect(() => buildRegistry([wrongLevel])).toThrow("office-level command registered as");
  });

  it("builds the engine registry from features.ts", () => {
    const registry = engineRegistry();
    expect(FEATURES.length).toBeGreaterThan(0);
    expect(registry.read("commands.describe")?.module).toBe("reads/describe");
  });

  it("describes the registered commands and reads, leaving out provisional ones", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const registry = buildRegistry([describeFeature, fixtureFeature(newCalls())]);
        const reply = await executeRead(
          { registry, offices: stateOfficeDirectory(t.state), clock: t.clock },
          { requestId: R1, name: "commands.describe", args: {} },
        );
        if (!reply.ok) throw new Error(reply.error.message);
        const result = commandsDescribe.result.parse(reply.result);
        expect(result.commands.map((c) => c.name)).toEqual([
          "fixture.touch",
          "fixture.peek",
          "fixture.level",
        ]);
        expect(result.reads.map((r) => r.name)).toEqual(["commands.describe", "fixture.detail"]);
        expect(result.commands[0]).toMatchObject({
          level: "office",
          confirm: false,
          irreversible: false,
          since: 0,
        });
      } finally {
        t.state.close();
      }
    }));
});
