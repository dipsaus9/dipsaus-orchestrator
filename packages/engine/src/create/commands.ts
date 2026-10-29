// The engine's run services and the services built on them (DIPO-318), in the order
// `createEngine` builds them: the runs, `work.discard`, the proposals, reconcile, the run profile,
// the story tests, `work.run`, the Done poll and teardown, the auto-merge and the merge gates.

import type { OfficeId } from "@dipsaus-orchestrator/contract";

import { BacklogMerges } from "../backlog/pr/merge";
import { writeCloseOutSummary } from "../merge/close-out";
import { MergeGates } from "../merge/commands";
import { guardedParkWriter, guardedUnparkWriter } from "../merge/guard";
import { AutoMerge } from "../merge/merger";
import { gitStoryMergeOps } from "../merge/story-git";
import { Reconciler } from "../reconcile/feature";
import { gitParkWriter, gitUnparkWriter } from "../run/park";
import { ProposalCommands } from "../run/proposals";
import { planLimitPause } from "../run/starts-paused";
import { StoryTests, TEST_BOX_DIR } from "../run/tests";
import { WorkRun } from "../run/work-run";
import { RunProfiles } from "../scan/feature";
import { StoryDiscard } from "../stories/discard";
import { StoryTeardown } from "../worktree/done";
import { join } from "node:path";
import type { Core } from "./core";
import type { EnginePartners } from "./partners";
import { buildRuns, type EngineRuns } from "./runs";
import type { StoryServices } from "./stories";

export interface CommandServices {
  readonly runs: EngineRuns;
  readonly discard: StoryDiscard;
  readonly proposals: ProposalCommands;
  readonly reconciler: Reconciler;
  readonly runProfiles: RunProfiles;
  readonly storyTests: StoryTests;
  readonly workRun: WorkRun;
  readonly teardown: StoryTeardown;
  readonly autoMerge: AutoMerge;
  readonly mergeGates: MergeGates;
}

/**
 * The worker start of a claimed run (DIPO-74): setup, prompts, launch checks, the worker host and
 * ingestion, with the `claude` the daemon resolved on its PATH.
 */
function runsOf(core: Core, story: StoryServices, partners: EnginePartners): EngineRuns {
  const { deps, offices } = core;
  return buildRuns({
    tools: deps.tools,
    probe: deps.probe,
    spawn: deps.spawn,
    hosts: deps.hosts,
    forwarders: deps.forwarders,
    listenHttp: deps.listenHttp,
    clock: deps.clock,
    ids: core.ids,
    env: deps.env,
    home: deps.paths.home,
    uid: deps.daemon.uid,
    runtimeDir: deps.paths.runtimeDir,
    tmpRoot: deps.paths.tmpRoot,
    stateDir: deps.paths.stateDir,
    holds: story.holds,
    engineGit: core.engineGit,
    claims: story.claims,
    offices,
    base: story.runBase,
    database: () => core.database.get(),
    onChanged: core.onChanged,
    logger: core.logger.child({ component: "runs" }),
    storyStore: core.stories,
    storyPr: story.storyPrs,
    holdResumer: () => story.planning,
    // A story resumed to wait In Review again goes back to the auto-merge (0002).
    mergeReentry: () => partners.autoMerge.get(),
    autoMergeGuard: story.autoMergeGuard,
    ...(deps.workerPort === undefined ? {} : { workerPort: deps.workerPort }),
    stories: story.storyIndex,
    implemented: core.implemented,
    // A question is live only while a TUI is connected at that moment (0021, DIPO-279).
    presence: core.presence,
    // The office's starts paused lifts, and its parks resume, only while the engine schedules
    // work (0020).
    scheduling: () => core.lifecycle.state === "running",
  });
}

/**
 * Reconcile (DIPO-56, 0007): the last office load step, so every office the engine loads in
 * `recovering` is reconciled before scheduling turns on; `office.rescan` runs it again. It stops
 * and parks runs through run control and releases orphaned claims.
 */
function reconcilerOf(core: Core, story: StoryServices, runs: EngineRuns): Reconciler {
  return new Reconciler({
    git: core.gitOf,
    stories: story.storyIndex,
    runs: runs.control,
    releaseClaim: (office, claim, reason) => story.claims.releaseUnstarted(office, claim, reason),
    // A story Done on the base through another branch has its open story PR closed and the box of
    // its ended run deleted (DIPO-161).
    host: core.host,
    // The one Done check reads the merged PR of a claim's branch here, as the Done poll does.
    prs: core.host,
    finishBoxes: () => runs.finishEndedBoxes(),
    adoptBacklogPr: (office) => story.backlogPrs.adopt(office),
    refuse: (office, text) => core.offices.refuse(office, text),
    onOfficeChanged: core.onChanged,
    logger: core.logger.child({ component: "reconcile" }),
  });
}

/**
 * The run profile (DIPO-72): scanned at load after the story index fetched, and on
 * `office.rescan`. The scan fallback (DIPO-310) runs its session through the run services, only
 * when the maintainer asks (`office.infer`); the office's starts paused makes it wait, and a plan
 * limit its session meets pauses them (0020).
 */
function runProfilesOf(
  core: Core,
  story: StoryServices,
  runs: EngineRuns,
  reconciler: Reconciler,
): RunProfiles {
  const { offices, engineGit, deps } = core;
  return new RunProfiles({
    git: engineGit,
    fallback: () => runs.sessions,
    scanSettings: (office) => offices.config(office)?.scan,
    startsPaused: (office) => {
      const paused = runs.startsPaused.state(office);
      return paused === null ? null : `the office's starts are paused (${paused.detail})`;
    },
    pausePlanLimit: (office, limit) =>
      runs.startsPaused.pausePlanLimit(
        office,
        planLimitPause(
          {
            credits: limit.credits,
            ...(limit.resetsAt === undefined
              ? {}
              : { resetsAt: new Date(limit.resetsAt).toISOString() }),
          },
          deps.clock.now(),
        ),
      ),
    stories: story.storyIndex,
    reconcile: (office) => reconciler.reconcile(office),
    reloadConfig: (office) => offices.reloadIfChanged(office, engineGit.forOffice(office)),
    onOfficeChanged: core.onChanged,
    logger: core.logger.child({ component: "scan" }),
  });
}

/**
 * The auto-merge (0002): turns GitHub's auto-merge on for the office's backlog PR once its
 * structural check passed, and for each story PR whose merge gate was approved after its review
 * and required checks, and off again when something stops the merge, in each PR-state round; it
 * holds new lane operations while a backlog PR has auto-merge on.
 */
function autoMergeOf(core: Core, story: StoryServices, runs: EngineRuns): AutoMerge {
  const { host, gitOf } = core;
  const { storyPrs, lane } = story;
  return new AutoMerge({
    host,
    prState: core.prState,
    // The office's backlog PR, merged by the StoryStore's planning lane (0010).
    backlog: new BacklogMerges({ host, labels: host, lane: (office) => lane.forOffice(office) }),
    offices: core.offices,
    clock: core.deps.clock,
    stories: {
      git: gitStoryMergeOps({ git: gitOf, stories: core.stories }),
      ids: core.ids,
      labels: host,
      ci: (office, runId) => storyPrs.ciState(office, runId),
      prSync: (office, runId) => storyPrs.sync(office, runId),
      story: (office, stored) => runs.merge.story(office, stored),
      summary: writeCloseOutSummary,
      recordMerge: (office, stored, merged) => runs.merge.recordMerge(office, stored, merged),
      conflict: (office, runId, input) => runs.merge.conflict(office, runId, input),
      park: {
        // Unguarded: the auto-merge parks inside its own round, after auto-merge is off.
        writer: gitParkWriter({ git: gitOf, stories: core.stories }),
        implemented: core.implemented,
      },
      itemMax: (office, stored) => runs.merge.itemMax(office, stored),
    },
    onChanged: core.onChanged,
    logger: core.logger.child({ component: "merge" }),
  });
}

/**
 * `gate.approve` and `gate.reject` on merge gates (DIPO-150 with DIPO-151): a decision kicks the
 * auto-merge, a reject's note goes to the worker in a fix round.
 */
function mergeGatesOf(
  core: Core,
  story: StoryServices,
  runs: EngineRuns,
  autoMerge: AutoMerge,
): MergeGates {
  const { host, gitOf } = core;
  const { storyPrs, storyIndex, autoMergeGuard } = story;
  return new MergeGates({
    labels: host,
    unpark: guardedUnparkWriter(
      gitUnparkWriter({ git: gitOf, stories: core.stories }),
      autoMergeGuard,
    ),
    reject: (office, runId, reject) => runs.merge.reject(office, runId, reject),
    kick: (office) => autoMerge.kick(office),
    view: host,
    prSync: (office, runId) => storyPrs.sync(office, runId),
    refreshStory: (office, key) => storyIndex.refreshStory(office, key, { quiet: true }),
    // A decision only for the head the gate holds for; the park put back when an override is not
    // recorded after its lift.
    holds: (office, gate, head) => autoMerge.gateHolds(office, gate, head),
    repark: guardedParkWriter(gitParkWriter({ git: gitOf, stories: core.stories }), autoMergeGuard),
  });
}

/**
 * Testing a story (DIPO-309): `test.start` runs the pushed head in a test box, `test.record`
 * records the maintainer's pass or fail; the box tick closes the tests nobody records.
 */
function storyTestsOf(
  core: Core,
  story: StoryServices,
  runs: EngineRuns,
  later: { readonly runProfiles: RunProfiles; readonly autoMerge: AutoMerge },
): StoryTests {
  const { runProfiles, autoMerge } = later;
  const storyTests = new StoryTests({
    offices: core.offices,
    clock: core.deps.clock,
    ids: core.ids,
    git: core.gitOf,
    freshProfile: (office, trigger) => runProfiles.ensureFreshProfile(office, trigger),
    story: (office, stored) => runs.merge.story(office, stored),
    boxes: runs.testBoxes,
    testDir: (testId) => join(core.deps.paths.stateDir, TEST_BOX_DIR, testId),
    testFail: (office, runId, test) => runs.merge.testFail(office, runId, test),
    kick: (office) => autoMerge.kick(office),
    prSync: (office, runId) => story.storyPrs.sync(office, runId),
    onChanged: core.onChanged,
    logger: core.logger.child({ component: "tests" }),
  });
  runs.onBoxTick(() => storyTests.sweep());
  return storyTests;
}

/**
 * `work.discard` (DIPO-161): a running story is stopped as `story.park` does, the story PR closed
 * through the code host, the claim released with the office git, a Refined write through the lane,
 * and the box of the ended run deleted (0021). A story Done in `_base` gets no Refined write.
 */
function discardOf(core: Core, story: StoryServices, runs: EngineRuns): StoryDiscard {
  return new StoryDiscard({
    lane: (office) => story.lane.planning(office),
    git: core.gitOf,
    host: core.host,
    probe: core.deps.probe,
    stop: (ctx, args) => runs.control.parkByMaintainer(ctx, args),
    finishBoxes: () => runs.finishEndedBoxes(),
    stories: core.stories,
  });
}

/**
 * `work.run` (DIPO-48): picks and claims one Ready story and records the run, through the story
 * index, the run profile, office init's statuses check, the claims, the Ready gate and the
 * planning lane; the worker place is decided and taken in the places' serialized steps (DIPO-208).
 */
function workRunOf(
  core: Core,
  story: StoryServices,
  runs: EngineRuns,
  runProfiles: RunProfiles,
): WorkRun {
  return new WorkRun({
    offices: core.offices,
    base: story.runBase,
    stories: story.storyIndex,
    profiles: runProfiles,
    statuses: (office) => story.officeInit.officeStatusesReady(office),
    startsPaused: (office) => runs.startsPaused.state(office),
    claims: story.claims,
    gates: story.gates,
    lane: (office) => story.lane.planning(office),
    launcher: runs.launcher,
    places: runs.places,
  });
}

/**
 * The Done poll and teardown (DIPO-58, DIPO-363): the one Done check reads the merged PR of each
 * finished claim and the story's status on the base; a Done story's worktree and branches are
 * removed and its slot freed. A story Done on the base through another branch has its open story
 * PR closed and the box of its ended run deleted (DIPO-161).
 */
function teardownOf(core: Core, runs: EngineRuns): StoryTeardown {
  return new StoryTeardown({
    prState: core.prState,
    git: core.gitOf,
    host: core.host,
    prCloser: core.host,
    finishBoxes: () => runs.finishEndedBoxes(),
    stories: core.stories,
    offices: core.offices,
    onChanged: core.onChanged,
    logger: core.logger.child({ component: "teardown" }),
  });
}

export function buildCommandServices(
  core: Core,
  story: StoryServices,
  partners: EnginePartners,
): CommandServices {
  const runs = runsOf(core, story, partners);
  const reconciler = reconcilerOf(core, story, runs);
  const runProfiles = runProfilesOf(core, story, runs, reconciler);
  const autoMerge = autoMergeOf(core, story, runs);
  return {
    runs,
    discard: discardOf(core, story, runs),
    // `proposal.accept` and `proposal.dismiss` (DIPO-166): an accepted worker proposal becomes a
    // Backlog draft through the planning lane.
    proposals: new ProposalCommands({
      lane: (office: OfficeId) => story.lane.planning(office),
    }),
    reconciler,
    runProfiles,
    storyTests: storyTestsOf(core, story, runs, { runProfiles, autoMerge }),
    workRun: workRunOf(core, story, runs, runProfiles),
    teardown: teardownOf(core, runs),
    autoMerge,
    mergeGates: mergeGatesOf(core, story, runs, autoMerge),
  };
}
