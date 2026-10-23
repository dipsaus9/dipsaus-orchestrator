export const packageName = "@dipsaus-orchestrator/testkit";

export { MANUAL_CLOCK_START, ManualClock } from "./clock";
export {
  FakeProcess,
  fakeSpawn,
  readRecording,
  recordedProcesses,
  stdoutText,
} from "./fake-process";
export type {
  FakeProcessOptions,
  FakeSpawn,
  FakeSpawnOptions,
  RecordedLine,
  RecordedSteer,
  Recording,
  RecordingMeta,
} from "./fake-process";
export {
  cleanEnv,
  daemonTestEnv,
  isRemovedEnvName,
  REMOVED_ENV_PREFIXES,
  withCleanEnv,
} from "./env";
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
export { guardRuns } from "./guard";
export { SequentialIds } from "./ids";
export {
  assertTestRuntimeDir,
  isolatedDaemonEnv,
  LONGEST_RUNTIME_ENTRY,
  longestTestSocketBytes,
  MAX_TEMP_ROOT_BYTES,
  RUNTIME_PATH_LIMIT,
  runtimeChoices,
  TEMP_DIR_TEMPLATE,
  TEST_MARKER,
  TEST_RUNTIME_SOURCE,
  testRuntimeCandidates,
  testRuntimeDir,
  testStateDir,
  testTmpDir,
} from "./runtime";
export type { RuntimeChoice } from "./runtime";
export {
  keepTempDirs,
  makeTempDir,
  removeTempDir,
  tempRoot,
  tempRootFits,
  withDaemonTempDir,
  withTempDir,
} from "./temp";
