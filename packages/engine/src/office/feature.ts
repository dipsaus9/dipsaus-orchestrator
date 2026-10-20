// The software-level office commands (0005 section 4): `office.open`, `office.forget`,
// `office.purge` (DIPO-76), `office.reloadConfig` and `office.setPrivacy` (DIPO-136), answered by the office manager. The daemon lists this module next to the
// engine's own features, because the manager needs the state database and the software stream.

import {
  officeForget,
  officeOpen,
  officePurge,
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
      // Software-level for idempotency: purge deletes the office's own `requests` rows, so its
      // record lives in the daemon's in-memory request table (0005 amendment of 2026-10-12).
      registry.addSoftwareCommand({
        definition: officePurge,
        handle: (_ctx, args) => manager.purge(args.office),
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
