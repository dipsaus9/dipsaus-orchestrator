// The engine's two ordered lists (DIPO-318): the feature modules, whose registration order is the
// order of the office load steps, and the recovery steps. Each list is written here once; a test
// records both orders.

import type { OfficeId } from "@dipsaus-orchestrator/contract";

import type { FeatureModule } from "../commands/registry";
import { openStateDatabase } from "../db/database";
import { MIGRATIONS } from "../db/schema";
import { engineFeatures } from "../features";
import { officeFeature } from "../office/feature";
import { helloFeature } from "../reads/hello";
import { REATTACH_STEP } from "../run/reattach";
import { FIX_ROUNDS_RECOVERY_STEP } from "../run/fix-rounds";
import { TEST_RECOVERY_STEP } from "../run/tests";
import { RUN_TEMP_SWEEP_STEP } from "../run/temp-dirs";
import { RECONCILE_STEP } from "../reconcile/feature";
import { activeRunCount } from "../overview/summary";
import type { CommandServices } from "./commands";
import { controlFeature, sumActiveRuns } from "./control";
import type { Core } from "./core";
import { DATABASE_UNAVAILABLE } from "./lifecycle";
import type { OfficeServices } from "./office-services";
import { databaseFailure, MIGRATIONS_STEP, RecoverySteps, type RecoveryStep } from "./recovery";
import type { StoryServices } from "./stories";

/** Every service the lists are made of. */
export interface Services {
  readonly story: StoryServices;
  readonly commands: CommandServices;
  readonly office: OfficeServices;
}

/** The summary names the privacy opt-ins that are on (DIPO-83): sent again when they may change. */
function privacySummaryFeature(core: Core): FeatureModule {
  return {
    name: "privacy.summary",
    register: (features) => {
      features.registerLoadStep("privacy.summary", (ctx) => core.changes.notify(ctx.officeId));
      features.registerConfigReload("privacy.summary", (ctx) => core.changes.notify(ctx.officeId));
    },
  };
}

/** `engine.hello` and the `daemon.*` read and commands (0006 decision 5). */
function processFeatures(core: Core, services: Services): FeatureModule[] {
  const { deps, lifecycle, offices } = core;
  const { daemon } = deps;
  const { office, commands } = services;
  const engineBehind = office.engineBehind;
  return [
    helloFeature({
      engineVersion: daemon.version,
      daemonState: () => lifecycle.state,
      softwareCursor: () => core.software.head(),
      officeSummaries: office.summaries,
    }),
    controlFeature({
      lifecycle,
      logger: core.logger,
      clock: deps.clock,
      startedAt: daemon.startedAt,
      pid: daemon.pid,
      version: daemon.version,
      ...(daemon.buildCommit === undefined || engineBehind === null
        ? {}
        : { buildCommit: daemon.buildCommit, engineBehind: () => engineBehind.rows() }),
      socket: daemon.socket,
      tools: deps.tools,
      upgradePending: daemon.upgradePending,
      keepAwake: () => office.keepAwake.status(),
      loadedOffices: () => offices.loadedOffices(),
      // `daemon.resumeScheduling` lifts every office's starts paused too (0020).
      liftStartsPaused: (why) => commands.runs.startsPaused.liftAll(why),
      activeRuns: () =>
        sumActiveRuns(offices.loadedOffices(), (id: OfficeId) => {
          const handle = offices.get(id);
          return handle === undefined ? undefined : activeRunCount(handle);
        }),
      requestStop: daemon.requestStop,
    }),
  ];
}

/**
 * The feature modules in their one order; the order of their load steps is the order an office
 * loads in. Each comment says why a module stands where it does.
 */
export function featureList(core: Core, services: Services): FeatureModule[] {
  const { story, commands, office } = services;
  const { runs } = commands;
  return [
    // The desk shows the office's starts paused first (0020), and a stuck planning lane among
    // its hand actions (DIPO-401).
    ...engineFeatures({
      backlog: core.backlogCli,
      stories: core.stories,
      desk: {
        startsPaused: (handle) => runs.startsPaused.state(handle.officeId as OfficeId),
        // The stuck lane (DIPO-401), and a backlog PR that did not open after the office loaded (DIPO-403).
        officeItems: (handle, now) => [
          ...story.lane.deskItems(handle, now),
          ...story.backlogPrs.loadFailureDeskItems(handle.officeId as OfficeId),
        ],
      },
    }),
    core.engineGit.feature,
    // Claims pin their worktree snapshots on the office git, so after it.
    story.claims.feature,
    commands.teardown.feature,
    story.storyPrs.feature,
    // The lane's replay needs the office git.
    story.lane.feature,
    story.storyIndex.feature,
    commands.autoMerge.feature,
    // After its three consumers' load steps, so a round finds them tracked.
    core.prState.feature,
    // Its notice on missing statuses follows the story index's fetch.
    story.officeInit.feature,
    story.gates.feature,
    // Scanned after the story index fetched.
    commands.runProfiles.feature,
    commands.workRun.feature,
    story.planning.feature,
    commands.mergeGates.feature,
    commands.storyTests.feature,
    commands.discard.feature,
    commands.proposals.feature,
    runs.control.feature,
    runs.outcomes.feature,
    runs.permissions.feature,
    // The office's starts paused, armed again at load, and `work.resume` (0020).
    runs.startsPaused.feature,
    runs.resumption.feature,
    // After the outcomes' load step: what waited for a place starts once exits are decided.
    runs.places.feature,
    office.retention.feature,
    office.usageAlerts.feature,
    // The last office load step, so every office is reconciled before scheduling turns on.
    commands.reconciler.feature,
    officeFeature(core.offices),
    privacySummaryFeature(core),
    ...processFeatures(core, services),
    ...(core.deps.features ?? []),
  ];
}

/**
 * The first recovery step (0005, 0007): opens and migrates the state database. A database that
 * cannot be opened or migrated holds the engine in `recovering`: office commands and reads get
 * `database.unavailable`, the notice says what to do, and the daemon stays up.
 */
function migrationsStep(core: Core): RecoveryStep {
  const { deps, lifecycle } = core;
  return {
    name: MIGRATIONS_STEP,
    run: async (context) => {
      const dbLogger = context.logger.child({ component: "database" });
      try {
        core.database.set(
          await openStateDatabase({
            stateDir: deps.paths.stateDir,
            logger: dbLogger,
            clock: deps.clock,
            engineVersion: deps.daemon.version,
            ...(deps.extraMigrations === undefined
              ? {}
              : {
                  migrations: [
                    ...MIGRATIONS,
                    ...deps.extraMigrations.map((step, i) => ({
                      ...step,
                      version: MIGRATIONS.length + i + 1,
                    })),
                  ],
                }),
          }),
        );
      } catch (error) {
        const failure = databaseFailure(error, deps.paths.stateDir);
        dbLogger.error("the state database is unavailable; serving software commands only", {
          ...failure.details,
          error,
        });
        if (lifecycle.holdUnavailable(failure)) {
          core.software.append("engine.notice", {
            level: "error",
            code: DATABASE_UNAVAILABLE,
            text: failure.text,
          });
        }
      }
    },
  };
}

/**
 * Every registered office loads in `recovering` (DIPO-56): its load steps end with reconcile, so
 * scheduling stays off until each office is reconciled, and the auto-merge and Done detection
 * resume without waiting for an office command. An office that is refused stays unloaded with its
 * notice; the engine still starts.
 */
function loadOfficesStep(core: Core): RecoveryStep {
  const { offices, lifecycle } = core;
  return {
    name: RECONCILE_STEP,
    run: async (context) => {
      for (const office of offices.registeredOffices()) {
        if (lifecycle.state !== "recovering") return;
        const access = await offices.load(office);
        if (!access.ok) {
          context.logger.warn("office not loaded at start", {
            office,
            code: access.error.code,
            reason: access.error.message,
          });
        }
      }
    },
  };
}

/**
 * Re-attach (DIPO-57, 0006 decisions 7 and 8): after reconcile, every active run of a loaded
 * office follows its worker host again (or has its exit or lost host decided) before scheduling
 * turns on.
 */
function reattachStep(core: Core, services: Services): RecoveryStep {
  const { offices, lifecycle } = core;
  const { runs } = services.commands;
  return {
    name: REATTACH_STEP,
    run: async (context) => {
      for (const office of offices.loadedOffices()) {
        if (lifecycle.state !== "recovering") return;
        for (const done of await runs.reattacher.reattach(office)) {
          context.logger.info("worker host re-attached", { office, ...done });
        }
      }
    },
  };
}

/**
 * Run temp directories (DIPO-102): after re-attach, every `dipo-run-*` directory of a run that
 * ended, or that no database row names when this daemon made it, goes; then the boxes of box runs
 * that ended while no daemon ran (DIPO-271), the reviewer boxes a stopped daemon left (0002) and
 * the read-only reviewer folders of an earlier binary (DIPO-347).
 */
function tempSweepStep(services: Services): RecoveryStep {
  const { runs } = services.commands;
  return {
    name: RUN_TEMP_SWEEP_STEP,
    run: async (context) => {
      const removed = await runs.tempDirs.sweep("recovery");
      if (removed.length > 0) {
        context.logger.info("removed run temp directories of ended runs", { removed });
      }
      await runs.finishEndedBoxes({ listBoxes: true });
      const folders = await runs.sweepOldReviewFolders();
      if (folders.length > 0) {
        context.logger.info("removed reviewer folders an earlier binary left", {
          removed: folders,
        });
      }
    },
  };
}

/** The recovery steps in their one order; the migrations step is always first. */
export function recoveryList(core: Core, services: Services): RecoverySteps {
  const { runs, storyTests } = services.commands;
  const steps = new RecoverySteps(migrationsStep(core));
  for (const step of [
    loadOfficesStep(core),
    reattachStep(core, services),
    tempSweepStep(services),
    // Open tests (DIPO-309): each whose test box still runs gets its forwarder again; the others
    // close, and every test box no open test names is deleted.
    { name: TEST_RECOVERY_STEP, run: async () => storyTests.recover() },
    // Fix rounds (DIPO-148): a round delivered just before the stop is marked so, and a reviewed
    // head whose CI will not tell again gets its round decided.
    {
      name: FIX_ROUNDS_RECOVERY_STEP,
      run: async (context: Parameters<RecoveryStep["run"]>[0]) => {
        const queued = await runs.recoverFixRounds();
        if (queued > 0) context.logger.info("queued fix rounds a stopped daemon left", { queued });
      },
    },
    ...(core.deps.recoverySteps ?? []),
  ]) {
    steps.register(step);
  }
  return steps;
}
