export const packageName = "@dipsaus-orchestrator/testkit";

export { MANUAL_CLOCK_START, ManualClock } from "./clock";
export { cleanEnv, isRemovedEnvName, REMOVED_ENV_PREFIXES, withCleanEnv } from "./env";
export {
  applyFixture,
  CommandError,
  git,
  GIT_DATE,
  GIT_IDENTITY,
  isolatedEnv,
  runCommand,
  withBareRemote,
  withTempRepo,
} from "./git";
export type { FixtureTree, RunResult, TempRepo, TempRepoOptions, TempRepoWithRemote } from "./git";
export { SequentialIds } from "./ids";
export { keepTempDirs, makeTempDir, removeTempDir, tempRoot, withTempDir } from "./temp";
