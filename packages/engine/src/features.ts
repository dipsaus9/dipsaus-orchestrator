// The feature modules of the engine (M0 review, DIPO-15). Each exports a `FeatureModule` whose
// `register(registry)` adds its commands and reads; a story that adds one lists its module here,
// in its own line, and never edits `commands/` or `reads/`.

import { buildRegistry, type FeatureModule, type Registry } from "./commands/registry";
import { describeFeature } from "./reads/describe";

export const FEATURES: readonly FeatureModule[] = [describeFeature];

/** The engine's registry; throws at startup when two modules register the same name. */
export function engineRegistry(features: readonly FeatureModule[] = FEATURES): Registry {
  return buildRegistry(features);
}
