// The software-level office commands (0005 section 4): `office.open`, `office.forget` and
// `office.reloadConfig`, answered by the office manager. The daemon lists this module next to the
// engine's own features, because the manager needs the state database and the software stream.

import { officeForget, officeOpen, officeReloadConfig } from "@dipsaus-orchestrator/contract";

import type { FeatureModule } from "../commands/registry";

import type { OfficeManager } from "./manager";

export function officeFeature(manager: OfficeManager): FeatureModule {
  return {
    name: "office",
    register(registry) {
      registry.addSoftwareCommand({
        definition: officeOpen,
        handle: (_ctx, args) => manager.open(args.path),
      });
      registry.addSoftwareCommand({
        definition: officeForget,
        handle: (_ctx, args) => manager.forget(args.office, args.from),
      });
      registry.addSoftwareCommand({
        definition: officeReloadConfig,
        handle: (_ctx, args) => manager.reloadConfig(args.office, args.from),
      });
    },
  };
}
