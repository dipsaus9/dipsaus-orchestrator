// The one wiring of the run services (DIPO-129): ingestion with the permission wait and the
// nudges, run control, worker outcomes, the resumer, the plan-limit schedule, the office's session
// places (DIPO-142) with the pending reviews and their starter (DIPO-219), the launcher and
// re-attach, built from injected ports. The daemon and the engine's run tests both build them
// here, so a test exercises the wiring the daemon runs. What differs between them is only which
// ports are injected.

import type { Clock, IdSource, OfficeId } from "@dipsaus-orchestrator/contract";

import { type InputChangeReader, Nudges } from "../hooks/nudges";
import { ABSENT, PermissionAsks, type Presence } from "../hooks/permissions";
import { WebGuard } from "../hooks/web-guard";
import type { WorkerPort } from "../workers/port";
import { readBackstop } from "./backstop";
import { RunControl, type RunControlDeps, type RunSteering } from "./control";
import { OfficeIngest, type OfficeIngestOptions, type OfficeRunListener } from "./hosts";
import { RunLauncher, type HostStarter, type RunIngest, type RunLauncherDeps } from "./launch";
import type { RunOutcomes, RunOutcomesDeps, RunOutcomesPort } from "./outcomes";
import { Places, type PlacesDeps } from "./places";
import { PlanLimits, type PlanLimitsDeps } from "./plan-limit";
import { RunReattacher, type RunReattacherDeps } from "./reattach";
import { baseStoryFacts, RunResumer, type RunResumerDeps } from "./resume";
import { gitReviewOps, ReviewLauncher } from "./review-launch";
import { Reviews } from "./reviews";
import { createRunOutcomes, type Resumption } from "./resumption";
import { afterRunExits } from "./temp-dirs";
import type { HoldResumer } from "./work-resume";
import type { RunBase } from "./work-run";

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
  /** The stories on the base: a launch's dependencies and a next session's story (DIPO-51). */
  readonly base: Pick<RunBase, "read">;
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
  /** Whether the maintainer is at a client, for the permission wait (DIPO-59); absent by default. */
  readonly presence?: Presence;
  /** False while no work is scheduled: the permission wait and the plan-limit schedule (DIPO-61). */
  readonly scheduling?: () => boolean;
  /** Which input files the base changed, for the nudges (DIPO-60); no input nudge without it. */
  readonly inputChanges?: InputChangeReader;
  /** Ingestion; every entry it appends reaches `onChanged` at once. */
  readonly ingest: Pick<OfficeIngestOptions, "pricing" | "watchdog"> & {
    /** Hears each run's worker exit after the permission wait and the nudges did. */
    readonly onEnded?: OfficeRunListener["onEnded"];
  };
  /** Run control; without it nothing is tracked, ended or decided (and no outcomes follow). */
  readonly control?: Pick<RunControlDeps, "writer" | "finisher" | "implemented" | "tickMs">;
  /** Worker outcomes and the run's next session; needs `control`. */
  readonly outcomes?: Pick<RunOutcomesDeps, "holds" | "holdsWork" | "caps" | "unpark"> & {
    /** The liveness of earlier hosts a next session waits for (DIPO-57). */
    readonly probe?: RunResumerDeps["probe"];
  };
  /** The planning lane's resume of an on-hold park (DIPO-160), read when `work.resume` runs. */
  readonly holdResumer?: () => HoldResumer | undefined;
  /** The plan-limit schedule (DIPO-61) worker outcomes report waits to; needs `outcomes`. */
  readonly planLimits?: Pick<PlanLimitsDeps, "holds" | "notify">;
  /** The office's session places (DIPO-142): the reviewer's model and pending reviews. */
  readonly places?: Pick<PlacesDeps, "reviewModel" | "pending">;
  /** Replaces run control as the resumer's and the launcher's tracker (a test's caps override). */
  readonly tracker?: (control: RunControl) => NonNullable<RunLauncherDeps["control"]>;
  /** Replaces ingestion as the resumer's (a test recording each start). */
  readonly resumeIngest?: (ingest: OfficeIngest) => RunIngest;
  /** DIPO-39's worktree setup of a claimed story, before its worker starts. */
  readonly setup: RunLauncherDeps["setup"];
  /** Re-attach after a restart; needs `control`. */
  readonly reattach?: Omit<
    RunReattacherDeps,
    "clock" | "offices" | "ingest" | "control" | "outcomes" | "onChanged" | "warn" | "pricing"
  >;
}

export interface ComposedRuns {
  readonly ingest: OfficeIngest;
  /** The permission wait (DIPO-59), on every run's ingestion. */
  readonly permissions: PermissionAsks;
  /** The 0014 section 8 nudges (DIPO-60), on every run's ingestion. */
  readonly nudges: Nudges;
  readonly control: RunControl | null;
  readonly outcomes: RunOutcomes | null;
  /** Park resume and `work.resume` (DIPO-138), sharing the outcomes' facts. */
  readonly resumption: Resumption | null;
  readonly resumer: RunResumer | null;
  readonly planLimits: PlanLimits | null;
  /** The worker and reviewer places with their start orders (DIPO-142); needs `outcomes`. */
  readonly places: Places | null;
  /** The review rounds (DIPO-219): pending reviews, their starter and the reviewer's outcomes. */
  readonly reviews: Reviews | null;
  readonly launcher: RunLauncher;
  readonly reattacher: RunReattacher | null;
}

/** `{ [key]: value }`, or `{}` when `value` is undefined (an optional port left out). */
function given<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
}

/** The services built later that earlier ones call: each is read when called, never before. */
interface Late {
  ingest: OfficeIngest | null;
  outcomes: RunOutcomes | null;
  resumption: Resumption | null;
  exitPort: RunOutcomesPort | null;
  planLimits: PlanLimits | null;
  places: Places | null;
}

function buildControl(ports: RunPorts, late: Late): RunControl | null {
  if (ports.control === undefined) return null;
  return new RunControl({
    ...ports.control,
    clock: ports.clock,
    offices: ports.offices,
    ids: ports.ids,
    steering: ports.steering,
    encode: (op) => ports.worker.encode(op),
    // The ingestion hooks call the control, and the control flushes ingestion's output first.
    flushOutput: (office, run) => late.ingest?.flushOutput(office, run),
    // Each exit decision may end the run after its worker exited (the temp directory goes).
    outcomes: () => late.exitPort ?? undefined,
    ...given("onChanged", ports.onChanged),
    ...given("refreshStory", ports.refreshStory),
    ...given("warn", ports.warn),
  });
}

interface HookListeners {
  readonly permissions: PermissionAsks;
  readonly nudges: Nudges;
  readonly webGuard: WebGuard;
  readonly hookEvents: OfficeRunListener;
}

/** The permission wait and the nudges, and the one listener per ingestion pass that hears both. */
function buildHookListeners(
  ports: RunPorts,
  control: RunControl | null,
  late: Late,
): HookListeners {
  const ending = (run: string) => control?.isEnding(run) ?? false;
  const permissions = new PermissionAsks({
    clock: ports.clock,
    ids: ports.ids,
    offices: ports.offices,
    steering: ports.steering,
    encode: (op) => ports.worker.encode(op),
    presence: ports.presence ?? ABSENT,
    ending,
    // An answer to a `needs-permission` park resumes its run (DIPO-75).
    parks: {
      resume: (office, run, request) =>
        late.resumption?.resumePark(office, run, request) ??
        Promise.resolve({ kind: "failed", reason: "worker outcomes are not ready" }),
    },
    ...given("scheduling", ports.scheduling),
    ...given("onChanged", ports.onChanged),
    ...given("warn", ports.warn),
  });
  const nudges = new Nudges({
    clock: ports.clock,
    steering: ports.steering,
    encode: (op) => ports.worker.encode(op),
    ...given("inputChanges", ports.inputChanges),
    ending,
    ...given("warn", ports.warn),
  });
  const webGuard = new WebGuard({
    clock: ports.clock,
    offices: ports.offices,
    steering: ports.steering,
    encode: (op) => ports.worker.encode(op),
    ...given("warn", ports.warn),
  });
  const onEnded = ports.ingest.onEnded;
  const hookEvents: OfficeRunListener = {
    onWorkerEvents: (office, run, agent, events) => {
      permissions.onWorkerEvents(office, run, agent, events);
      nudges.onWorkerEvents(office, run, agent, events);
      webGuard.onWorkerEvents(office, run, agent, events);
    },
    onEnded: (office, run) => {
      permissions.onEnded(office, run);
      nudges.onEnded(office, run);
      onEnded?.(office, run);
    },
  };
  return { permissions, nudges, webGuard, hookEvents };
}

function buildIngest(
  ports: RunPorts,
  control: RunControl | null,
  listeners: Pick<HookListeners, "hookEvents" | "webGuard">,
): OfficeIngest {
  const { hookEvents, webGuard } = listeners;
  return new OfficeIngest({
    clock: ports.clock,
    pricing: ports.ingest.pricing,
    ...(control === null ? {} : { hooks: control.hooks }),
    hookEvents,
    // No env value of the worktree reaches the stored web lines (0020 section 11b, DIPO-164).
    redactOutput: (office, run, text) => webGuard.redactOutput(office, run, text),
    ...given("watchdog", ports.ingest.watchdog),
    ...given("onAppended", ports.onChanged),
    // `privacy.storeCommandBodies` of the configuration in force (0007 section 8, DIPO-83).
    privacy: (office) => ({
      storeCommandBodies: ports.offices.config(office)?.privacy.storeCommandBodies ?? false,
    }),
    ...given("warn", ports.warn),
  });
}

/** Run control as the resumer and the launcher track runs with it (or the test's override). */
function trackerOf(ports: RunPorts, control: RunControl): NonNullable<RunLauncherDeps["control"]> {
  return ports.tracker?.(control) ?? control;
}

interface Outcomes {
  readonly resumer: RunResumer;
  readonly outcomes: RunOutcomes;
  readonly resumption: Resumption;
  readonly planLimits: PlanLimits | null;
  readonly places: Places;
  readonly reviews: Reviews;
}

/**
 * The resumer, worker outcomes, the plan-limit schedule and the places; null without control or
 * outcomes.
 */
function buildOutcomes(
  ports: RunPorts,
  control: RunControl | null,
  ingest: OfficeIngest,
  late: Late,
): Outcomes | null {
  if (control === null || ports.outcomes === undefined) return null;
  const { probe, ...outcomePorts } = ports.outcomes;
  const resumer = new RunResumer({
    clock: ports.clock,
    ids: ports.ids,
    offices: ports.offices,
    worker: ports.worker,
    git: ports.git,
    story: baseStoryFacts(ports.base),
    runtimeDir: ports.runtimeDir,
    tmpRoot: ports.tmpRoot,
    ...given("tempOwner", ports.tempOwner),
    hosts: ports.hosts,
    ingest: ports.resumeIngest?.(ingest) ?? ingest,
    control: trackerOf(ports, control),
    ...given("probe", probe),
    ...given("onChanged", ports.onChanged),
  });
  const { outcomes, resumption } = createRunOutcomes(
    {
      ...outcomePorts,
      waits: () => late.planLimits ?? undefined,
      clock: ports.clock,
      offices: ports.offices,
      steering: ports.steering,
      encode: (op) => ports.worker.encode(op),
      worker: ports.worker,
      pricing: ports.ingest.pricing,
      ender: () => control,
      resumer,
      release: ports.release,
      ...given("refreshStory", ports.refreshStory),
      ...given("onChanged", ports.onChanged),
      ...given("warn", ports.warn),
    },
    {
      planLimits: () => late.planLimits ?? undefined,
      places: () => late.places ?? undefined,
      ...given("holds", ports.holdResumer),
    },
  );
  const planLimits =
    ports.planLimits === undefined
      ? null
      : new PlanLimits({
          ...ports.planLimits,
          clock: ports.clock,
          offices: ports.offices,
          resume: (office, run, why) => resumption.resumeWait(office, run, why),
          commands: resumption.feature,
          ...given("scheduling", ports.scheduling),
          ...given("warn", ports.warn),
        });
  const reviews = buildReviews(ports, control, ingest, planLimits);
  // The places pause by the plan-limit holds, start a queued resume through the resumption and a
  // pending review through the review rounds (0019 section 12).
  const places = new Places({
    ...ports.places,
    clock: ports.clock,
    offices: ports.offices,
    pending: ports.places?.pending ?? ((office) => reviews.pending(office)),
    ...(planLimits === null
      ? {}
      : { held: (adapter: string, model: string | null) => planLimits.held(adapter, model) }),
    park: (office, run, work, ending) => control.park(office, run, work, ending),
    starters: {
      resume: (office, run) => resumption.startQueued(office, run),
      review: (office, run, start) => reviews.start(office, run, start),
    },
    ...given("scheduling", ports.scheduling),
    ...given("onChanged", ports.onChanged),
    ...given("warn", ports.warn),
  });
  return { resumer, outcomes, resumption, planLimits, places, reviews };
}

/** The review rounds with the real reviewer launcher on the run ports (DIPO-219). */
function buildReviews(
  ports: RunPorts,
  control: RunControl,
  ingest: OfficeIngest,
  planLimits: PlanLimits | null,
): Reviews {
  const sessions = new ReviewLauncher({
    clock: ports.clock,
    ids: ports.ids,
    offices: ports.offices,
    worker: ports.worker,
    git: ports.git,
    runtimeDir: ports.runtimeDir,
    tmpRoot: ports.tmpRoot,
    ...given("tempOwner", ports.tempOwner),
    hosts: ports.hosts,
    ingest: ports.resumeIngest?.(ingest) ?? ingest,
    control: trackerOf(ports, control),
    // The backstop's snapshot before the review, which only the finisher reads.
    ...(ports.control?.finisher === undefined
      ? {}
      : { snapshot: (office: OfficeId, worktree: string) => snapshotOf(ports, office, worktree) }),
    ...given("onChanged", ports.onChanged),
    ...given("warn", ports.warn),
  });
  return new Reviews({
    clock: ports.clock,
    ids: ports.ids,
    offices: ports.offices,
    git: gitReviewOps(ports.git),
    story: baseStoryFacts(ports.base),
    sessions,
    steering: ports.steering,
    encode: (op) => ports.worker.encode(op),
    ender: () => control,
    adapter: ports.worker.id,
    ...given("holds", ports.outcomes?.holds),
    waits: () => planLimits ?? undefined,
    ...given("onChanged", ports.onChanged),
    ...given("warn", ports.warn),
  });
}

function buildReattacher(
  ports: RunPorts,
  control: RunControl | null,
  ingest: OfficeIngest,
  outcomes: RunOutcomes | null,
): RunReattacher | null {
  if (control === null || ports.reattach === undefined) return null;
  return new RunReattacher({
    ...ports.reattach,
    clock: ports.clock,
    offices: ports.offices,
    ingest,
    control,
    pricing: ports.ingest.pricing,
    ...given("outcomes", outcomes ?? undefined),
    ...given("onChanged", ports.onChanged),
    ...given("warn", ports.warn),
  });
}

function buildLauncher(
  ports: RunPorts,
  control: RunControl | null,
  ingest: OfficeIngest,
): RunLauncher {
  return new RunLauncher({
    worker: ports.worker,
    git: ports.git,
    setup: ports.setup,
    dependencies: async (office, ids) =>
      ids.length === 0 ? [] : (await ports.base.read(office, ids)).views,
    runtimeDir: ports.runtimeDir,
    tmpRoot: ports.tmpRoot,
    ...given("tempOwner", ports.tempOwner),
    hosts: ports.hosts,
    ingest,
    ...(control === null ? {} : { control: trackerOf(ports, control) }),
    release: ports.release,
    // The backstop's run-start snapshot (DIPO-49), which only the finisher reads.
    ...(ports.control?.finisher === undefined
      ? {}
      : { snapshot: (office: OfficeId, worktree: string) => snapshotOf(ports, office, worktree) }),
    ...given("warn", ports.warn),
  });
}

function snapshotOf(ports: RunPorts, office: OfficeId, worktree: string) {
  const git = ports.git(office);
  if (git === undefined) throw new Error(`Office ${office} has no git attached.`);
  return readBackstop(git, worktree);
}

/** Builds the run services from `ports`. */
export function composeRuns(ports: RunPorts): ComposedRuns {
  const late: Late = {
    ingest: null,
    outcomes: null,
    resumption: null,
    exitPort: null,
    planLimits: null,
    places: null,
  };
  const control = buildControl(ports, late);
  const listeners = buildHookListeners(ports, control, late);
  const { permissions, nudges } = listeners;
  const ingest = buildIngest(ports, control, listeners);
  late.ingest = ingest;
  const built = buildOutcomes(ports, control, ingest, late);
  const outcomes = built?.outcomes ?? null;
  late.outcomes = outcomes;
  late.resumption = built?.resumption ?? null;
  late.planLimits = built?.planLimits ?? null;
  late.places = built?.places ?? null;
  // Each exit decision of worker outcomes, then the places (a session ended, so its place may be
  // free) and `afterExit` (the run temp directory sweep).
  // A reviewer session's turns and exit go to the review rounds (DIPO-219).
  if (outcomes !== null) {
    const places = late.places;
    const afterExit = ports.afterExit;
    const routed = built?.reviews.route(outcomes) ?? outcomes;
    late.exitPort =
      places === null && afterExit === undefined
        ? routed
        : afterRunExits(routed, () => {
            places?.drainAll();
            afterExit?.();
          });
  }
  const reattacher = buildReattacher(ports, control, ingest, outcomes);
  const launcher = buildLauncher(ports, control, ingest);
  return {
    ingest,
    permissions,
    nudges,
    control,
    outcomes,
    resumption: late.resumption,
    resumer: built?.resumer ?? null,
    planLimits: late.planLimits,
    places: late.places,
    reviews: built?.reviews ?? null,
    launcher,
    reattacher,
  };
}
