// The Backlog.md integration (0010 section 1): the CLI runner with its never-run list, the version
// load step, and the `--plain` parser.

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
