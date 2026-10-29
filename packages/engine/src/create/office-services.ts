// The engine's office-wide services (DIPO-318): retention, the usage meter and its alerts, the
// office summaries, the engine commits behind the build, the keep-awake assertion and the daily
// maintenance.

import type { OfficeId, OfficeSummary } from "@dipsaus-orchestrator/contract";

import { MaintenanceScheduler } from "../backup/scheduler";
import { readEngineCommitsAfter } from "../git/build-commit";
import { KeepAwake } from "../keepawake/keepawake";
import { KeepAwakeHolder } from "../keepawake/holder";
import { readWorkActivity, WorkTracker } from "../keepawake/activity";
import { detachedEnv } from "../platform/process";
import type { OfficeSummarySource } from "../reads/hello";
import { Retention } from "../retention/feature";
import { UsageAlerts } from "../run/usage-alerts";
import { officeSummaryOfSource, officeSummarySource, summarySettings } from "../views/summary";
import { UsageMeter } from "../views/usage";
import type { Core } from "./core";
import { EngineBehindCache } from "./engine-behind";

export interface OfficeServices {
  readonly retention: Retention;
  readonly usageAlerts: UsageAlerts;
  readonly summaries: OfficeSummarySource;
  readonly summary: (office: OfficeId) => OfficeSummary | undefined;
  /** Null when the binary has no build commit (run from source). */
  readonly engineBehind: EngineBehindCache | null;
  readonly keepAwake: KeepAwake;
  readonly maintenance: MaintenanceScheduler;
}

/**
 * Office summaries for `engine.hello` and the software stream, from the office rows (DIPO-32):
 * the privacy opt-ins that are on (DIPO-83), the stored-output retention period (DIPO-97), and the
 * tokens of today and this month with the all-office limits (DIPO-311).
 */
function summariesOf(core: Core, usage: UsageMeter): Pick<OfficeServices, "summaries" | "summary"> {
  const { offices, database } = core;
  const settingsOf = (office: OfficeId) => {
    const usageOf = usage.of(office);
    return {
      ...summarySettings(offices.config(office), offices.localOverrideKeys(office)),
      ...(usageOf === undefined ? {} : { usage: usageOf }),
    };
  };
  return {
    summaries: officeSummarySource(() => database.get(), settingsOf),
    summary: officeSummaryOfSource(() => database.get(), settingsOf),
  };
}

/** The engine commits each office base has after the build commit (DIPO-198), read in the background. */
function engineBehindOf(core: Core): EngineBehindCache | null {
  const buildCommit = core.deps.daemon.buildCommit;
  if (buildCommit === undefined) return null;
  return new EngineBehindCache({
    clock: core.deps.clock,
    logger: core.logger.child({ component: "engine-behind" }),
    loadedOffices: () => core.offices.loadedOffices(),
    source: (office) => {
      const officeGit = core.engineGit.forOffice(office);
      if (officeGit === undefined) return undefined;
      return {
        mainWorktree: officeGit.mainWorktree,
        read: () => readEngineCommitsAfter(officeGit, buildCommit),
      };
    },
  });
}

/**
 * Keep-awake (0006 decision 12): one assertion for every office while work is active, read from the
 * state database once recovery opened it.
 */
function keepAwakeOf(core: Core): KeepAwake {
  const { deps } = core;
  const work = new WorkTracker();
  const logger = core.logger.child({ component: "keep-awake" });
  return new KeepAwake({
    holder: new KeepAwakeHolder({
      daemonPid: deps.daemon.pid,
      env: detachedEnv(deps.env),
      spawn: deps.spawnKeepAwake,
      clock: deps.clock,
      logger,
    }),
    read: () =>
      readWorkActivity(core.database.open().connection, deps.probe, work, deps.clock.now()),
    clock: deps.clock,
    logger,
  });
}

/**
 * The daily backup and maintenance (DIPO-65, 0007). Idle means no engine step is running and no
 * loaded office reports active work.
 */
function maintenanceOf(core: Core): MaintenanceScheduler {
  const { offices, registry } = core;
  return new MaintenanceScheduler({
    database: () => core.database.get(),
    clock: core.deps.clock,
    idle: () =>
      core.children.size === 0 &&
      offices.loadedOffices().every((office) => {
        const handle = offices.get(office);
        return (
          handle === undefined || registry.activeWorkChecks().every(({ check }) => !check(handle))
        );
      }),
    logger: core.logger.child({ component: "maintenance" }),
  });
}

export function buildOfficeServices(core: Core): OfficeServices {
  const { deps } = core;
  const alerts = deps.settings.usage.alerts;
  const usage = new UsageMeter({
    database: () => core.database.get(),
    clock: deps.clock,
    limits: {
      level: alerts.level,
      ...(alerts.dayTokens === undefined ? {} : { dayTokens: alerts.dayTokens }),
      ...(alerts.monthTokens === undefined ? {} : { monthTokens: alerts.monthTokens }),
    },
  });
  return {
    // Retention (DIPO-65): a load step runs it when an office loads, then hourly while it stays
    // loaded, with the `retention.*` periods of the configuration in force.
    retention: new Retention({
      offices: core.offices,
      onOfficeChanged: core.onChanged,
      logger: core.logger.child({ component: "retention" }),
    }),
    usageAlerts: new UsageAlerts({
      meter: usage,
      database: () => core.database.get(),
      software: core.software,
      clock: deps.clock,
      onOfficeChanged: core.onChanged,
      logger: core.logger.child({ component: "usage" }),
    }),
    ...summariesOf(core, usage),
    engineBehind: engineBehindOf(core),
    keepAwake: keepAwakeOf(core),
    maintenance: maintenanceOf(core),
  };
}
