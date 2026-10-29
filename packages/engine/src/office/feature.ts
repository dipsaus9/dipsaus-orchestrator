// The software-level office commands (0005): `office.open`, `office.forget`,
// `office.reloadConfig` and `office.setPrivacy` (DIPO-136), answered by the office manager. The daemon lists this module next to the
// engine's own features, because the manager needs the state database and the software stream.

import {
  officeForget,
  officeOpen,
  officeReloadConfig,
  officeSetPrivacy,
} from "@dipsaus-orchestrator/contract";

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
        handle: (_ctx, args) => manager.forget(args.office),
      });
      registry.addSoftwareCommand({
        definition: officeReloadConfig,
        handle: (_ctx, args) => manager.reloadConfig(args.office),
      });
      registry.addSoftwareCommand({
        definition: officeSetPrivacy,
        handle: (_ctx, args) => manager.setPrivacy(args.office, args.key, args.value),
      });
    },
  };
}
