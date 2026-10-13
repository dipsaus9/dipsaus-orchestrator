// The feature modules of the engine (M0 review, DIPO-15). Each exports a `FeatureModule` whose
// `register(registry)` adds its commands and reads; a story that adds one lists its module here,
// in its own line, and never edits `commands/` or `reads/`.

import { backlogFeature } from "./backlog";
import { buildRegistry, type FeatureModule, type Registry } from "./commands/registry";
import { systemSpawn } from "./platform/process";
import { describeFeature } from "./reads/describe";
import { statsFeature } from "./retention/stats";

export const FEATURES: readonly FeatureModule[] = [
  describeFeature,
  // The `backlog` found on the daemon's `PATH`, which the starting client kept (DIPO-70).
  backlogFeature({ spawn: systemSpawn }),
  // `office.stats` (DIPO-65). The retention load step needs the office manager, so the daemon
  // lists `Retention.feature` next to it.
  statsFeature,
];

/** The engine's registry; throws at startup when two modules register the same name. */
export function engineRegistry(features: readonly FeatureModule[] = FEATURES): Registry {
  return buildRegistry(features);
}
