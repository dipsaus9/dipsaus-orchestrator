// The feature modules of the engine (M0 review, DIPO-15). Each exports a `FeatureModule` whose
// `register(registry)` adds its commands and reads; a story that adds one lists its module here,
// in its own line, and never edits `commands/` or `reads/`.

import { backlogFeature } from "./backlog";
import { backlogPrDeskItems } from "./backlog/pr/desk";
import type { BacklogCli } from "./backlog/runner";
import { backlogStoryStore } from "./backlog/store";
import { buildRegistry, type FeatureModule, type Registry } from "./commands/registry";
import { systemSpawn } from "./platform/process";
import { describeFeature } from "./reads/describe";
import { statsFeature } from "./retention/stats";
import type { StoryStore } from "./story-store/store";
import type { DeskSources } from "./views/desk";
import { viewsFeatureWith } from "./views/feature";

export interface EngineFeatureOptions {
  /**
   * How the Backlog CLI starts: the daemon passes the absolute `backlog` it resolved on its
   * `PATH` at start (DIPO-74), so every office uses the same binary.
   */
  readonly backlog: BacklogCli;
  /** The story store the desk reads parks through (0010). */
  readonly stories: StoryStore;
  /** The desk's sources beyond the engine's own: the daemon's office starts paused (0020). */
  readonly desk?: Partial<DeskSources>;
}

/** The engine's own feature modules, with the daemon's tools. */
export function engineFeatures(options: EngineFeatureOptions): readonly FeatureModule[] {
  return [
    describeFeature,
    backlogFeature(options.backlog),
    // `office.stats` (DIPO-65). The retention load step needs the office manager, so the daemon
    // lists `Retention.feature` next to it.
    statsFeature,
    // `office.snapshot`, `office.switch`, `story.detail` and `work.outputRange` (DIPO-52); the
    // desk shows the backlog PRs whose check failed (0010).
    viewsFeatureWith({ prItems: backlogPrDeskItems, stories: options.stories, ...options.desk }),
  ];
}

/** The feature modules with `backlog` looked up on `PATH`, for tests and tools without a daemon. */
export const FEATURES: readonly FeatureModule[] = engineFeatures({
  backlog: { spawn: systemSpawn },
  stories: backlogStoryStore({ spawn: systemSpawn }),
});

/** The engine's registry; throws at startup when two modules register the same name. */
export function engineRegistry(features: readonly FeatureModule[] = FEATURES): Registry {
  return buildRegistry(features);
}
