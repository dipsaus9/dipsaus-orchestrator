// The Backlog.md integration (0010 section 1): the CLI runner with its never-run list, the version
// load step, the `--plain` parser, the story fields of section 3 and the branch slug of section 4.

import type { FeatureModule } from "../commands/registry";

import type { BacklogCli } from "./runner";
import { VERSION_STEP, versionStep } from "./version";

export {
  BacklogParseError,
  hasSectionRule,
  KNOWN_HEADER_KEYS,
  KNOWN_SECTIONS,
  PARSE_RULE,
  parseList,
  parseView,
  plainLines,
  SECTION_RULE,
} from "./plain";
export type {
  ChecklistItem,
  Comment,
  DependencyEntry,
  KnownHeaderKey,
  KnownSection,
  ParseOptions,
  PlainList,
  PlainListEntry,
  PlainTask,
  TaskRef,
  UnknownItem,
} from "./plain";
export { BacklogCommandError, BacklogRefusedError, refusal, runBacklog } from "./runner";
export { branchFor, EMPTY_SLUG, SLUG_MAX, slug } from "./slug";
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
