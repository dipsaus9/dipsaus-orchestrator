// `commands.describe` (0005 section 7, M0 review): every command and read this engine registered,
// with JSON Schemas of args and result and its `since`; provisional ones are left out. It is the
// conversation layer's tool list, so it shows only what the engine can actually run.

import { commandsDescribe, describeContract } from "@dipsaus-orchestrator/contract";

import type { FeatureModule } from "../commands/registry";

export const describeFeature: FeatureModule = {
  name: "reads/describe",
  register(registry) {
    registry.addRead({
      definition: commandsDescribe,
      handle: (ctx) =>
        describeContract(ctx.registry.commandDefinitions(), ctx.registry.readDefinitions()),
    });
  },
};
