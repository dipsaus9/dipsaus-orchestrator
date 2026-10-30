// The one factory between the daemon and the engine (0005, 0004, DIPO-318). `createEngine` builds
// every engine service in one written order: the core, the story services, the run services and
// those built on them, the office-wide services. A service that calls one built after it gets a
// partner, and every partner is connected in one step once all services exist. Then the feature
// list goes into the registry, in the order that is the office load order, and the recovery steps
// are listed in theirs. The daemon drives the result through `recover`, `drain` and `stop`, and
// serves its surface on the socket.

import { stopEngineCalls } from "../platform/deadline";
import { createUlid } from "../platform/ids";
import { recordTuiLeft } from "../views/digest";
import { DeskNotifier, watchDesk } from "../views/desk-notify";
import { MemoryRequestTable } from "../commands/requests";
import { buildCommandServices } from "./commands";
import { buildCore, type Core } from "./core";
import type { Engine, EngineDeps } from "./deps";
import { DEFAULT_DRAIN_CAPS, drain } from "./drain";
import { buildOfficeServices } from "./office-services";
import { connectEngine, enginePartners } from "./partners";
import { runRecovery, type RecoveryContext, type RecoverySteps } from "./recovery";
import { featureList, recoveryList, type Services } from "./steps";
import { buildStoryServices } from "./stories";
import { engineSurface, type EngineSurface } from "./surface";

/** Starts what runs only once the engine has recovered: in `running`. */
function startRunningJobs(core: Core, services: Services): void {
  const { lifecycle } = core;
  if (lifecycle.state !== "running") return;
  // Recovery loaded the registered offices: read their engine commits behind now, then on the
  // refresh interval; offices loaded later are read when status first sees them (DIPO-198).
  services.office.engineBehind?.start();
  services.office.maintenance.start();
  services.office.keepAwake.start();
}

/** Stops every service, timer and engine call, in the order they depend on each other. */
async function stopServices(core: Core, services: Services): Promise<void> {
  const { story, commands, office } = services;
  const { runs } = commands;
  office.engineBehind?.stop();
  await office.keepAwake.stop();
  story.storyIndex.stop();
  commands.teardown.stop();
  story.storyPrs.stop();
  commands.autoMerge.stop();
  core.prState.stop();
  // A scan fallback session waiting for the office's starts starts no more, and a running one
  // gets the stop, so its caps hold after the daemon is gone (DIPO-310).
  await commands.runProfiles.close();
  // Ingestion, the cap ticks of run control (DIPO-50), the starts paused timers (0020) and the
  // places' tick (DIPO-142) stop together.
  runs.startsPaused.close();
  runs.places.close();
  runs.control.close();
  runs.permissions.close();
  runs.ingest.close();
  runs.reattacher.close();
  runs.stopBoxPasses();
  runs.collisions?.stop();
  // Every box worker ends inside its box (DIPO-271); the forwarders of open tests stop, and their
  // test boxes keep running for the next daemon (DIPO-309).
  await runs.testBoxes?.stopForwarders();
  await runs.boxes?.close();
  // A Backlog CLI, gh or git call still running ends with its process group (DIPO-314).
  const ended = await stopEngineCalls();
  if (ended > 0) core.logger.info("engine calls stopped", { count: ended });
  // A retention pass or backup still running finishes before the database closes.
  await office.retention.stop();
  office.usageAlerts.stop();
  await office.maintenance.stop();
}

function recoveryContext(core: Core): RecoveryContext {
  return {
    logger: core.logger,
    clock: core.deps.clock,
    children: core.children,
  };
}

/**
 * The desk notices (DIPO-357): one notification per item an office's desk gains, when the daemon
 * has a way to post one and `config.yaml` keeps `notify.desk` on. Returns the call that stops them.
 */
function deskNoticesOf(core: Core, surface: EngineSurface): () => void {
  const { postNotification, settings } = core.deps;
  if (postNotification === undefined || !settings.notify.desk) return () => undefined;
  const logger = core.logger.child({ component: "desk" });
  return watchDesk({
    surface,
    notifier: new DeskNotifier({ post: postNotification, logger }),
    logger,
    nextId: createUlid(core.deps.clock),
  });
}

function engineOf(core: Core, services: Services, steps: RecoverySteps): Engine {
  const { lifecycle } = core;
  const surface = engineSurface({
    version: core.deps.daemon.version,
    registry: core.registry,
    offices: core.offices,
    clock: core.deps.clock,
    ids: core.ids,
    softwareRequests: new MemoryRequestTable(core.deps.clock),
    lifecycle,
    software: core.software,
    changes: core.changes,
    officeSummaries: services.office.summaries,
    officeSummary: services.office.summary,
    logger: core.logger.child({ component: "server" }),
    ...(core.deps.renderer === undefined ? {} : { renderer: core.deps.renderer }),
  });
  const stopDeskNotices = deskNoticesOf(core, surface);
  return {
    ...surface,
    state: () => lifecycle.state,
    recover: async () => {
      await runRecovery({ lifecycle, steps, context: recoveryContext(core) });
      startRunningJobs(core, services);
    },
    drain: (request, caps = DEFAULT_DRAIN_CAPS) => {
      void services.office.maintenance.stop().catch((error: unknown) => {
        core.logger.warn("stopping maintenance failed", { error });
      });
      return drain({
        lifecycle,
        children: core.children,
        clock: core.deps.clock,
        logger: core.logger,
        request,
        caps,
        // `daemon.stop { stopWorkers: true }` (0006 decision 7, DIPO-315): through run control.
        stopWorkers: () => services.commands.runs.control.stopAll(),
      });
    },
    busy: () => core.children.size > 0 || lifecycle.inFlight > 0,
    setTuiPresent: (connected) => core.presence.set(connected),
    tuiLeft: (office, at) => {
      const handle = core.offices.get(office);
      if (handle !== undefined) recordTuiLeft(handle, at);
    },
    stop: async () => {
      stopDeskNotices();
      await stopServices(core, services);
    },
    // Checkpoint (TRUNCATE) and close, so no dipo.db-wal or dipo.db-shm stays (DIPO-87).
    closeDatabase: () => core.database.get()?.shutdown(),
  };
}

/** Builds the engine from the daemon's process concerns; nothing runs until `recover`. */
export function createEngine(deps: EngineDeps): Engine {
  const core = buildCore(deps);
  const partners = enginePartners();
  const story = buildStoryServices(core, partners);
  const commands = buildCommandServices(core, story, partners);
  const office = buildOfficeServices(core);
  connectEngine(partners, {
    runs: commands.runs,
    autoMerge: commands.autoMerge,
    lane: story.lane,
    storyIndex: story.storyIndex,
  });
  const services: Services = { story, commands, office };
  for (const feature of featureList(core, services)) core.registry.load(feature);
  core.logger.info("office load steps", {
    steps: core.registry.loadSteps().map((step) => step.name),
  });
  // The last TUI closing ends every live question at once, so its story parks with it (0021,
  // DIPO-284).
  core.presence.listen(() => commands.runs.permissions.presenceChanged());
  return engineOf(core, services, recoveryList(core, services));
}
