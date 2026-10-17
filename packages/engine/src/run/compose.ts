// The one wiring of the run services (DIPO-129): ingestion, run control, worker outcomes, the
// resumer, the launcher and re-attach, built from injected ports. The daemon and the engine's run
// tests both build them here, so a test exercises the wiring the daemon runs. What differs between
// them is only which ports are injected.

import type { Clock, IdSource } from "@dipsaus-orchestrator/contract";

import type { WorkerPort } from "../workers/port";
import { RunControl, type RunControlDeps, type RunSteering } from "./control";
import { OfficeIngest, type OfficeIngestOptions, type OfficeRunListener } from "./hosts";
import { RunLauncher, type HostStarter, type RunIngest, type RunLauncherDeps } from "./launch";
import { RunOutcomes, type RunOutcomesDeps, type RunOutcomesPort } from "./outcomes";
import { RunReattacher, type RunReattacherDeps } from "./reattach";
import { RunResumer, type RunResumerDeps } from "./resume";
import { afterRunExits } from "./temp-dirs";

type Warn = (message: string, fields: Readonly<Record<string, unknown>>) => void;

export interface RunPorts {
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly offices: RunResumerDeps["offices"];
  readonly worker: WorkerPort;
  /** Sends host ops to a running worker (`hostSocketSteering` in the daemon). */
  readonly steering: RunSteering;
  readonly hosts: HostStarter;
  readonly git: RunLauncherDeps["git"];
  readonly runtimeDir: string;
  readonly tmpRoot: string;
  readonly tempOwner?: () => string | undefined;
  readonly onChanged?: (office: Parameters<NonNullable<RunControlDeps["onChanged"]>>[0]) => void;
  readonly warn?: Warn;
  readonly refreshStory?: RunControlDeps["refreshStory"];
  /** Ends a live claim whose worker did not start; the launcher's and the outcomes' release. */
  readonly release: RunLauncherDeps["release"];
  /** Runs after each worker exit decision of worker outcomes (the run temp directory sweep). */
  readonly afterExit?: () => void;
  readonly ingest: Pick<OfficeIngestOptions, "pricing" | "watchdog" | "onAppended" | "privacy"> & {
    /** Hears the worker events and the exit of every run (the permission wait and the nudges). */
    readonly hookEvents?: OfficeRunListener;
  };
  /** Run control; without it nothing is tracked, ended or decided (and no outcomes follow). */
  readonly control?: Pick<RunControlDeps, "writer" | "finisher" | "implemented" | "tickMs">;
  /** Worker outcomes and the run's next session; needs `control`. */
  readonly outcomes?: Pick<RunOutcomesDeps, "holds" | "holdsWork" | "caps" | "waits" | "unpark"> & {
    readonly story: RunResumerDeps["story"];
    /** The liveness of earlier hosts a next session waits for (DIPO-57). */
    readonly probe?: RunResumerDeps["probe"];
  };
  /** Replaces run control as the resumer's and the launcher's tracker (a test's caps override). */
  readonly tracker?: (control: RunControl) => NonNullable<RunLauncherDeps["control"]>;
  /** Replaces ingestion as the resumer's (a test recording each start). */
  readonly resumeIngest?: (ingest: OfficeIngest) => RunIngest;
  readonly launcher: Pick<RunLauncherDeps, "setup" | "dependencies" | "snapshot">;
  /** Re-attach after a restart; needs `control`. */
  readonly reattach?: Omit<
    RunReattacherDeps,
    "clock" | "offices" | "ingest" | "control" | "outcomes" | "onChanged" | "warn"
  >;
}

export interface ComposedRuns {
  readonly ingest: OfficeIngest;
  readonly control: RunControl | null;
  readonly outcomes: RunOutcomes | null;
  readonly resumer: RunResumer | null;
  readonly launcher: RunLauncher;
  readonly reattacher: RunReattacher | null;
}

/** Builds the run services from `ports`. */
export function composeRuns(ports: RunPorts): ComposedRuns {
  const { clock } = ports;
  const warn = ports.warn === undefined ? {} : { warn: ports.warn };
  const onChanged = ports.onChanged === undefined ? {} : { onChanged: ports.onChanged };
  const refreshStory = ports.refreshStory === undefined ? {} : { refreshStory: ports.refreshStory };
  // The ingestion hooks call the control, and the control flushes ingestion's output first.
  let ingest: OfficeIngest | null = null;
  let outcomes: RunOutcomes | null = null;
  let exitPort: RunOutcomesPort | null = null;
  const control =
    ports.control === undefined
      ? null
      : new RunControl({
          ...ports.control,
          clock,
          offices: ports.offices,
          ids: ports.ids,
          steering: ports.steering,
          encode: (op) => ports.worker.encode(op),
          flushOutput: (office, run) => ingest?.flushOutput(office, run),
          // Each exit decision may end the run after its worker exited (the temp directory goes).
          outcomes: () => exitPort ?? undefined,
          ...onChanged,
          ...refreshStory,
          ...warn,
        });
  ingest = new OfficeIngest({
    clock,
    pricing: ports.ingest.pricing,
    ...(control === null ? {} : { hooks: control.hooks }),
    ...(ports.ingest.hookEvents === undefined ? {} : { hookEvents: ports.ingest.hookEvents }),
    ...(ports.ingest.watchdog === undefined ? {} : { watchdog: ports.ingest.watchdog }),
    ...(ports.ingest.onAppended === undefined ? {} : { onAppended: ports.ingest.onAppended }),
    ...(ports.ingest.privacy === undefined ? {} : { privacy: ports.ingest.privacy }),
    ...warn,
  });
  const officeIngest = ingest;
  const tracker = (c: RunControl) => ports.tracker?.(c) ?? c;
  let resumer: RunResumer | null = null;
  if (control !== null && ports.outcomes !== undefined) {
    resumer = new RunResumer({
      clock,
      ids: ports.ids,
      offices: ports.offices,
      worker: ports.worker,
      git: ports.git,
      story: ports.outcomes.story,
      runtimeDir: ports.runtimeDir,
      tmpRoot: ports.tmpRoot,
      ...(ports.tempOwner === undefined ? {} : { tempOwner: ports.tempOwner }),
      hosts: ports.hosts,
      ingest: ports.resumeIngest?.(officeIngest) ?? officeIngest,
      control: tracker(control),
      ...(ports.outcomes.probe === undefined ? {} : { probe: ports.outcomes.probe }),
      ...onChanged,
    });
    const { story: _story, probe: _probe, ...outcomePorts } = ports.outcomes;
    outcomes = new RunOutcomes({
      ...outcomePorts,
      clock,
      offices: ports.offices,
      steering: ports.steering,
      encode: (op) => ports.worker.encode(op),
      worker: ports.worker,
      ender: () => control,
      resumer,
      release: ports.release,
      ...refreshStory,
      ...onChanged,
      ...warn,
    });
    exitPort = ports.afterExit === undefined ? outcomes : afterRunExits(outcomes, ports.afterExit);
  }
  const reattacher =
    control !== null && ports.reattach !== undefined
      ? new RunReattacher({
          ...ports.reattach,
          clock,
          offices: ports.offices,
          ingest,
          control,
          ...(outcomes === null ? {} : { outcomes }),
          ...onChanged,
          ...warn,
        })
      : null;
  const launcher = new RunLauncher({
    ...ports.launcher,
    worker: ports.worker,
    git: ports.git,
    runtimeDir: ports.runtimeDir,
    tmpRoot: ports.tmpRoot,
    ...(ports.tempOwner === undefined ? {} : { tempOwner: ports.tempOwner }),
    hosts: ports.hosts,
    ingest,
    ...(control === null ? {} : { control: tracker(control) }),
    release: ports.release,
    ...warn,
  });
  return { ingest, control, outcomes, resumer, launcher, reattacher };
}
