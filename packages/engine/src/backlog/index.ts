// The Backlog.md integration (0010): the StoryStore's one implementation, with the CLI runner and
// its never-run list, the version load step, the `--plain` parser, the field write path, the story
// lane's copies of a story's backlog, the task-file layout, the planning lane (with office init,
// `init/`, and the backlog PR and its auto-merge, `pr/`) and the branch slug. No other engine
// directory imports it; the composition root does (DIPO-356).

import type { FeatureModule } from "../commands/registry";

import type { BacklogCli } from "./runner";
import { VERSION_STEP, versionStep } from "./version";

export {
  BacklogParseError,
  hasSectionRule,
  KNOWN_HEADER_KEYS,
  KNOWN_SECTIONS,
  parseList,
  parseMilestones,
  parseView,
  plainLines,
  SECTION_RULE,
} from "./plain";
export type { KnownHeaderKey, KnownSection, ParseOptions } from "./plain";
export * from "./fields";
export { BacklogListIncompleteError, listAll, parseCount } from "./list";
export type { ListKind } from "./list";
export { BacklogCommandError, BacklogRefusedError, refusal, runBacklog } from "./runner";
export { branchFor, EMPTY_SLUG, SLUG_MAX, slug } from "./slug";
export { backlogStoryStore, isStoryNotFound } from "./store";
export type { BacklogCli, BacklogOutput } from "./runner";
export {
  checkVersion,
  INSTALL_COMMAND,
  SUPPORTED_VERSION,
  VERSION_STEP,
  versionStep,
} from "./version";

/** The backlog feature: the `backlog.version` office load step. */
export function backlogFeature(cli: BacklogCli): FeatureModule {
  return {
    name: "backlog",
    register(registry) {
      registry.registerLoadStep(VERSION_STEP, versionStep(cli));
    },
  };
}
