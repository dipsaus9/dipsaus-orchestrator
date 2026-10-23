// `commands.describe` lists `confirmWhen` (DIPO-155, 0020 section 4): `work.resume` declares
// `["budget"]`, so every client asks yes or no before a top-up; a command without it has no key.

import { describe, expect, it } from "bun:test";

import { commandsDescribe, RequestId, storyDrop, workResume } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { stateOfficeDirectory } from "../../src/commands/offices";
import { buildRegistry, type FeatureModule } from "../../src/commands/registry";
import { describeFeature } from "../../src/reads/describe";
import { executeRead } from "../../src/reads/execute";
import { openTestState } from "../commands/helpers";

/** `work.resume` and `story.drop` registered with handlers that never run here. */
const commands: FeatureModule = {
  name: "test/resume",
  register(registry) {
    registry.addAsyncOfficeCommand({
      definition: workResume,
      handle: async () => {
        throw new Error("work.resume must not run");
      },
    });
    registry.addAsyncOfficeCommand({
      definition: storyDrop,
      handle: async () => {
        throw new Error("story.drop must not run");
      },
    });
  },
};

describe("commands.describe", () => {
  it("lists confirmWhen budget for work.resume, and no confirmWhen for story.drop", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const reply = await executeRead(
          {
            registry: buildRegistry([describeFeature, commands]),
            offices: stateOfficeDirectory(t.state),
            clock: t.clock,
          },
          {
            requestId: RequestId.parse("01J9ZK5Q8W3V4X6Y7Z8A9B0C1D"),
            name: "commands.describe",
            args: {},
          },
        );
        if (!reply.ok) throw new Error(reply.error.message);
        const { commands: described } = commandsDescribe.result.parse(reply.result);
        const resume = described.find((command) => command.name === "work.resume");
        expect(resume).toMatchObject({ confirm: false, confirmWhen: ["budget"] });
        const args = resume?.args as { properties?: Record<string, unknown> } | undefined;
        expect(Object.keys(args?.properties ?? {})).toContain("budget");
        const drop = described.find((command) => command.name === "story.drop");
        expect(drop).not.toHaveProperty("confirmWhen");
      } finally {
        t.state.close();
      }
    }));
});
