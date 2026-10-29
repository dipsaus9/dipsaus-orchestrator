// The one wiring of the run services (DIPO-129): ingestion with the live question rule and the web
// call counts, run control, worker outcomes, the resumer, the office's starts paused, the office's session
// places (DIPO-142) with the pending reviews and their starter (DIPO-219), the fix rounds and
// their starter (DIPO-148), the launcher and re-attach, built from injected ports. The daemon and
// the engine's run tests both build them here, so a test exercises the wiring the daemon runs.
// What differs between them is only which ports are injected.

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Clock, IdSource, OfficeId } from "@dipsaus-orchestrator/contract";

import { BOX_RUN_FILE } from "../box/workers";
import type { BoxWorkers } from "../box/workers";

import { ABSENT, PermissionAsks, type Presence } from "../hooks/permissions";
import { CONTRACT_MAX_DEFAULT } from "../prompts/contract";
import { currentProfile } from "../scan/store";
import type { RunProfile } from "../scan/detect";
import type { WorkerPort } from "../workers/port";
import { RunControl, type RunControlDeps, type RunSteering } from "./control";
import { OfficeIngest, type OfficeIngestOptions, type OfficeRunListener } from "./hosts";
import { RunLauncher, type HostStarter, type RunIngest, type RunLauncherDeps } from "./launch";
import type { RunOutcomes, RunOutcomesDeps, RunOutcomesPort } from "./outcomes";
import { Places, type PlacesDeps } from "./places";
import { RunReattacher, type RunReattacherDeps } from "./reattach";
import { baseStoryFacts, RunResumer, type RunResumerDeps } from "./resume";
import { gitReviewOps, ReviewLauncher } from "./review-launch";
import { FixRounds, type FixRoundsDeps } from "./fix-rounds";
import { Reviews } from "./reviews";
import { createRunOutcomes, type Resumption } from "./resumption";
import { SessionRuns } from "./session-run";
import { StartsPaused, type StartsPausedDeps } from "./starts-paused";
import { afterRunExits } from "./temp-dirs";
import { WebCalls } from "./web-calls";
import { ConflictResumes, type ConflictResumesDeps } from "./conflicts";
import { resolveIntent, runIntents } from "./intents";
import type { MergeReentry, PrReplacement } from "./park-resume";
import { workRefOf } from "../views/work";
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
  /** False while no work is scheduled: the permission wait and the office's starts paused. */
  readonly scheduling?: () => boolean;
  /** Ingestion; every entry it appends reaches `onChanged` at once. */
  readonly ingest: Pick<OfficeIngestOptions, "pricing" | "watchdog"> & {
    /** Hears each run's worker exit after the live question rule did. */
    readonly onEnded?: OfficeRunListener["onEnded"];
  };
  /** Run control; without it nothing is tracked, ended or decided (and no outcomes follow). */
  readonly control?: Pick<RunControlDeps, "writer" | "finisher" | "implemented" | "tickMs">;
  /** Worker outcomes and the run's next session; needs `control`. */
  readonly outcomes?: Pick<RunOutcomesDeps, "holds" | "holdsWork" | "caps" | "unpark"> & {
    /** The liveness of earlier hosts a next session waits for (DIPO-57). */
    readonly probe?: RunResumerDeps["probe"];
  };
  /** The planning lane's resume of a park with no run (DIPO-160), read when `work.resume` runs. */
  readonly holdResumer?: () => HoldResumer | undefined;
  /** The auto-merge a story resumed to wait In Review goes back to (0002). */
  readonly mergeReentry?: () => MergeReentry | undefined;
  /**
   * What a resumed `conflict` park needs: the merge in its live run's box
   * (`BoxCollisions.mergeOnResume`, DIPO-324) and the story store it finds the story's own file
   * with. Without it no conflict park resumes (`resume.notResumable`).
   */
  readonly conflictResume?: Pick<ConflictResumesDeps, "merge" | "stories">;
  /** The new story PR of a story resumed with its PR closed (`StoryPrs.replace`, 0002). */
  readonly prReplacement?: () => PrReplacement | undefined;
  /**
   * The office's starts paused (0020): the loaded offices a plan limit pauses together and the
   * adapter holds of a failed adapter check; needs `outcomes`.
   */
  readonly startsPaused?: Pick<StartsPausedDeps, "loaded" | "holds">;
  /** The office's session places (DIPO-142): its pending reviews. */
  readonly places?: Pick<PlacesDeps, "pending">;
  /**
   * Where the CI of a run's pushed head stands (`StoryPrs.ciState`, DIPO-147): a fix round waits
   * for its checks (DIPO-148). Without it no CI is waited for.
   */
  readonly ci?: FixRoundsDeps["ci"];
  /** Whether a run's developer works in a box (DIPO-271): its fix round starts a new session. */
  readonly boxRun?: FixRoundsDeps["boxRun"];
  /** Replaces run control as the resumer's and the launcher's tracker (a test's caps override). */
  readonly tracker?: (control: RunControl) => NonNullable<RunLauncherDeps["control"]>;
  /** Replaces ingestion as the resumer's (a test recording each start). */
  readonly resumeIngest?: (ingest: OfficeIngest) => RunIngest;

  /**
   * The box workers (DIPO-271, DIPO-278): every developer works in its story's box, made at the
   * launch and made again before a later session when it was lost. No box runs without them.
   */
  readonly boxes?: RunLauncherDeps["boxes"];
  /** The reviewer boxes (0002): each review session runs in one. No reviewer runs without them. */
  readonly reviewBoxes?: Pick<BoxWorkers, "review" | "endReview">;
  /**
   * Copies into a run's box the merges dipo committed on its branch outside the box, before its
   * next developer session (DIPO-324); a failure parks the story instead of starting the worker.
   */
  readonly boxSync?: RunResumerDeps["boxSync"];
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
  readonly control: RunControl | null;
  readonly outcomes: RunOutcomes | null;
  /** Park resume and `work.resume` (DIPO-138), sharing the outcomes' facts. */
  readonly resumption: Resumption | null;
  readonly resumer: RunResumer | null;
  /** The office's starts paused (0020); needs `outcomes` and the `startsPaused` port. */
  readonly startsPaused: StartsPaused | null;
  /** The worker and reviewer places with their start orders (DIPO-142); needs `outcomes`. */
  readonly places: Places | null;
  /** The review rounds (DIPO-219): pending reviews, their starter and the reviewer's outcomes. */
  readonly reviews: Reviews | null;
  /**
   * The fix rounds (DIPO-148): review and CI feedback on a pushed head back to its worker, once per
   * head; `consider` is to be called when the CI of a head stops being pending.
   */
  readonly fixRounds: FixRounds | null;
  readonly launcher: RunLauncher;
  readonly reattacher: RunReattacher | null;
  /**
   * The scan fallback's `session` runs (DIPO-310): one model session outside a story, on the same
   * worker port, hosts and steering as the story runs, outside the worker and reviewer places.
   */
  readonly sessions: SessionRuns;
}

/** `{ [key]: value }`, or `{}` when `value` is undefined (an optional port left out). */
function given<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
}

/** The services built later that earlier ones call: each is read when called, never before. */
interface Late {
  ingest: OfficeIngest | null;
  permissions: PermissionAsks | null;
  outcomes: RunOutcomes | null;
  resumption: Resumption | null;
  exitPort: RunOutcomesPort | null;
  startsPaused: StartsPaused | null;
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
    // A blocked report's question goes through the live-question rule (DIPO-272).
    questions: () => late.permissions ?? undefined,
    // A park to resume on lift that lands while the office is not paused resumes then (0020).
    parkedToResume: (office) => late.startsPaused?.resumeLifted(office),
    ...given("onChanged", ports.onChanged),
    ...given("refreshStory", ports.refreshStory),
    ...given("warn", ports.warn),
  });
}

interface RunListeners {
  readonly permissions: PermissionAsks;
  readonly webCalls: WebCalls;
  readonly runEvents: OfficeRunListener;
}

/** The live question rule and the web calls, and the one listener per ingestion pass. */
function buildRunListeners(ports: RunPorts, control: RunControl | null, late: Late): RunListeners {
  const ending = (run: string) => control?.isEnding(run) ?? false;
  const permissions = new PermissionAsks({
    clock: ports.clock,
    ids: ports.ids,
    offices: ports.offices,
    steering: ports.steering,
    encode: (op) => ports.worker.encode(op),
    presence: ports.presence ?? ABSENT,
    ending,
    // A live worker question whose wait ended or whose last TUI closed parks its story (DIPO-272,
    // DIPO-284, DIPO-159).
    parkQuestion: (_office, run, question) => {
      control?.parkOnQuestion(run, question);
    },
    // An answer to a question park resumes it through work.resume's park path (DIPO-159).
    questionParks: () => late.resumption?.questionParks,
    // Worker outcomes decide every exit, and `afterExit` follows each decision (DIPO-159).
    exitDecides: control !== null && ports.outcomes !== undefined,
    ...given("scheduling", ports.scheduling),
    ...given("onChanged", ports.onChanged),
    ...given("warn", ports.warn),
  });
  const webCalls = new WebCalls({
    offices: ports.offices,
    checkout: (office) => ports.git(office)?.mainWorktree,
    ...given("warn", ports.warn),
  });
  const onEnded = ports.ingest.onEnded;
  const runEvents: OfficeRunListener = {
    onWorkerEvents: (office, run, agent, events) => {
      webCalls.onWorkerEvents(office, run, agent, events);
    },
    onEnded: (office, run) => {
      permissions.onEnded(office, run);
      onEnded?.(office, run);
    },
  };
  return { permissions, webCalls, runEvents };
}

function buildIngest(
  ports: RunPorts,
  control: RunControl | null,
  listeners: Pick<RunListeners, "runEvents" | "webCalls">,
): OfficeIngest {
  const { runEvents, webCalls } = listeners;
  return new OfficeIngest({
    clock: ports.clock,
    pricing: ports.ingest.pricing,
    ...(control === null ? {} : { hooks: control.hooks }),
    runEvents,
    // No env value of the listed files reaches the stored web lines (0020 section 11b, DIPO-164).
    redactOutput: (office, run, text) => webCalls.redactOutput(office, run, text),
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
  readonly startsPaused: StartsPaused | null;
  readonly places: Places;
  readonly reviews: Reviews;
  readonly fixRounds: FixRounds;
}

/**
 * The resumer, worker outcomes, the office's starts paused and the places; null without control or
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
  // Built after the resumption: a resumed review-blocked park queues its fix round (DIPO-155).
  let fixRounds: FixRounds | null = null;
  const resumer = new RunResumer({
    clock: ports.clock,
    ids: ports.ids,
    offices: ports.offices,
    worker: ports.worker,
    git: ports.git,
    story: baseStoryFacts(ports.base),
    runtimeDir: ports.runtimeDir,
    tmpRoot: ports.tmpRoot,
    hosts: ports.hosts,
    ingest: ports.resumeIngest?.(ingest) ?? ingest,
    control: trackerOf(ports, control),
    ...given("boxes", ports.boxes),
    ...given("boxSync", ports.boxSync),
    profile: profileOf(ports),
    ...given("probe", probe),
    ...given("onChanged", ports.onChanged),
  });
  const { outcomes, resumption } = createRunOutcomes(
    {
      ...outcomePorts,
      startsPaused: () => late.startsPaused ?? undefined,
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
      places: () => late.places ?? undefined,
      ...given("holds", ports.holdResumer),
      parks: {
        ...given("scheduling", ports.scheduling),
        ...given("boxRun", ports.boxRun),
        fixRounds: () => fixRounds ?? undefined,
        ...given("merge", ports.mergeReentry),
        // A conflict park resumes through the hand-off of its box run (DIPO-324).
        ...given("conflicts", conflictResumesOf(ports, control)),
        ...given("prs", ports.prReplacement),
        // A question park's answer is a resolved unknown while the contract stays within R26.
        contractMax: (office) =>
          ports.offices.config(office)?.prompt.contractMax ?? CONTRACT_MAX_DEFAULT,
        // No resume while the office's starts are paused (0020).
        startsPaused: (office) => late.startsPaused?.state(office) ?? null,
      },
    },
  );
  // A plan limit pauses the office's starts; its lift resumes the parks it made through the
  // resumption and starts what waited for a place (0020).
  const startsPaused =
    ports.startsPaused === undefined
      ? null
      : new StartsPaused({
          ...ports.startsPaused,
          clock: ports.clock,
          offices: ports.offices,
          resume: (office, park) => resumption.resumeLifted(office, park),
          onLifted: (office) => void late.places?.drain(office),
          ...given("scheduling", ports.scheduling),
          ...given("onChanged", ports.onChanged),
          ...given("warn", ports.warn),
        });
  // A fix round continues the developer's session through worker outcomes (DIPO-148).
  fixRounds = new FixRounds({
    clock: ports.clock,
    offices: ports.offices,
    story: baseStoryFacts(ports.base),
    ...given("ci", ports.ci),
    sessions: outcomes.parts.sessions,
    view: (officeId, office, run) => outcomes.parts.support.viewOf(officeId, office, run),
    ...given("unpark", outcomePorts.unpark),
    ...given("boxRun", ports.boxRun),
    places: () => late.places ?? undefined,
    guard: outcomes.parts.support.guard,
    // A round that cannot start and will not on its own parks the story (DIPO-148).
    park: (office, run, work, ending) => control.park(office, run, work, ending),
    // A verdict on another commit holds for a head with the same code tree (0019 section 6).
    treeKey: (office, run, taskFile, head) =>
      gitReviewOps(ports.git).codeTreeKey(office, taskFile, head),
    ...given("refreshStory", ports.refreshStory),
    ...given("onChanged", ports.onChanged),
    ...given("warn", ports.warn),
  });
  const reviews = buildReviews(ports, control, ingest, startsPaused, fixRounds);
  // The places wait while the office's starts are paused, start a queued resume through the
  // resumption and a pending review through the review rounds (0019 section 12).
  const places = new Places({
    ...ports.places,
    clock: ports.clock,
    offices: ports.offices,
    pending: ports.places?.pending ?? ((office) => reviews.pending(office)),
    ...(startsPaused === null
      ? {}
      : {
          startsPaused: (office: OfficeId) => {
            const paused = startsPaused.state(office);
            return paused === null ? null : `the office's starts are paused (${paused.detail})`;
          },
        }),
    park: (office, run, work, ending) => control.park(office, run, work, ending),
    starters: {
      resume: (office, run) => resumption.startQueued(office, run),
      review: (office, run, start) => reviews.start(office, run, start),
      // A maintainer resume that starts a fresh review of the same round (0020 section 2, DIPO-155).
      "review-resume": (office, run, start) => reviews.start(office, run, start),
      fix: (office, run, start) => fixRounds.start(office, run, start),
    },
    ...given("scheduling", ports.scheduling),
    ...given("onChanged", ports.onChanged),
    ...given("warn", ports.warn),
  });
  return { resumer, outcomes, resumption, startsPaused, places, reviews, fixRounds };
}

/**
 * The resume of a `conflict` park (DIPO-324): the office git, the box merge of the live run, and
 * run control to tell its worker or park it. Undefined without the box merge.
 */
function conflictResumesOf(
  ports: RunPorts,
  control: RunControl,
): (() => ConflictResumes) | undefined {
  const conflict = ports.conflictResume;
  if (conflict === undefined) return undefined;
  const { merge, stories } = conflict;
  const resumes = new ConflictResumes({
    stories,
    clock: ports.clock,
    offices: ports.offices,
    git: ports.git,
    merge,
    tmpRoot: ports.tmpRoot,
    // A merge that took the other side's task file gets the story's status back (In Progress).
    restoreStatus: async (office, run) => {
      const unpark = ports.outcomes?.unpark;
      if (unpark === undefined || run.story === null || run.branch === null) return;
      await unpark.lift(office, {
        story: run.story,
        branch: run.branch,
        to: "In Progress",
      });
    },
    tell: (runId, text) => control.tellWorker(runId, text, "conflict"),
    parkLive: (runId, park) => control.parkRun(runId, park),
    // An unwritable path that still conflicts parks again before any session (0020 section 2).
    park: async (office, run, park) => {
      await control.park(office, run, workRefOf(office, run.runId) ?? undefined, {
        intent: "park",
        ops: [],
        reason: park.reason,
        detail: park.detail,
        endKind: park.reason,
      });
      // No worker runs, so nothing else resolves the park's intent (as a stranded fix round's).
      const intent = runIntents(office, run.runId)
        .filter((candidate) => candidate.kind === "park" && candidate.resolvedAt === null)
        .at(-1);
      if (intent !== undefined) {
        const at = ports.clock.now();
        office.immediate(() => resolveIntent(office, run.runId, intent.intentId, "blocked", at));
      }
    },
    itemMax: (office, run) => {
      const budgets = ports.offices.config(office)?.prompt.budgets.feedbackItem;
      if (budgets === undefined) return 3_000;
      const tier = run.tier as keyof typeof budgets | null;
      return (tier === null ? undefined : budgets[tier]) ?? budgets.M;
    },
    ...given("warn", ports.warn),
  });
  return () => resumes;
}

/** The review rounds with the real reviewer launcher on the run ports (DIPO-219). */
function buildReviews(
  ports: RunPorts,
  control: RunControl,
  ingest: OfficeIngest,
  startsPaused: StartsPaused | null,
  fixRounds: FixRounds,
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
    ...given("boxes", ports.reviewBoxes),
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
    startsPaused: () => startsPaused ?? undefined,
    // Once the reviewer exited after its verdict, the head's fix round may decide (DIPO-148).
    onReviewed: (office, runId, agent) => {
      void fixRounds.consider(office, runId, agent === undefined ? {} : { exited: agent });
    },
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
    // A developer runs only in its box: a living Mac session of an earlier binary is stopped.
    boxRecord: (runDir) => existsSync(join(runDir, BOX_RUN_FILE)),
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
    dependencies: async (office, ids) =>
      ids.length === 0 ? [] : (await ports.base.read(office, ids)).views,
    runtimeDir: ports.runtimeDir,
    tmpRoot: ports.tmpRoot,
    hosts: ports.hosts,
    ingest,
    ...(control === null ? {} : { control: trackerOf(ports, control) }),
    release: ports.release,
    ...given("boxes", ports.boxes),
    // A run's box gets the install of the office's current run profile (DIPO-294).
    profile: profileOf(ports),
    ...given("warn", ports.warn),
  });
}

/** The office's current run profile, whose install a run's box gets (DIPO-294). */
function profileOf(ports: RunPorts): (office: OfficeId) => RunProfile | null {
  return (office) => {
    const handle = ports.offices.get(office);
    return handle === undefined ? null : (currentProfile(handle)?.profile ?? null);
  };
}

/** Builds the run services from `ports`. */
export function composeRuns(ports: RunPorts): ComposedRuns {
  const late: Late = {
    ingest: null,
    permissions: null,
    outcomes: null,
    resumption: null,
    exitPort: null,
    startsPaused: null,
    places: null,
  };
  const control = buildControl(ports, late);
  const listeners = buildRunListeners(ports, control, late);
  const { permissions } = listeners;
  late.permissions = permissions;
  const ingest = buildIngest(ports, control, listeners);
  late.ingest = ingest;
  const built = buildOutcomes(ports, control, ingest, late);
  const outcomes = built?.outcomes ?? null;
  late.outcomes = outcomes;
  late.resumption = built?.resumption ?? null;
  late.startsPaused = built?.startsPaused ?? null;
  late.places = built?.places ?? null;
  // Each exit decision of worker outcomes, then the run's worker questions no park carried
  // (DIPO-159), the places (a session ended, so its place may be free) and `afterExit` (the run
  // temp directory sweep).
  // A reviewer session's turns and exit go to the review rounds (DIPO-219).
  if (outcomes !== null) {
    const places = late.places;
    const afterExit = ports.afterExit;
    const routed = built?.reviews.route(outcomes) ?? outcomes;
    late.exitPort = afterRunExits(routed, (view) => {
      permissions.afterExit(view.office, view.runId);
      places?.drainAll();
      afterExit?.();
    });
  }
  const reattacher = buildReattacher(ports, control, ingest, outcomes);
  const launcher = buildLauncher(ports, control, ingest);
  return {
    ingest,
    permissions,
    control,
    outcomes,
    resumption: late.resumption,
    resumer: built?.resumer ?? null,
    startsPaused: late.startsPaused,
    places: late.places,
    reviews: built?.reviews ?? null,
    fixRounds: built?.fixRounds ?? null,
    launcher,
    reattacher,
    sessions: new SessionRuns({
      clock: ports.clock,
      ids: ports.ids,
      offices: ports.offices,
      worker: ports.worker,
      git: ports.git,
      hosts: ports.hosts,
      steering: ports.steering,
      pricing: ports.ingest.pricing,
      runtimeDir: ports.runtimeDir,
      tmpRoot: ports.tmpRoot,
      ...given("tempOwner", ports.tempOwner),
      ...given("onChanged", ports.onChanged),
      ...given("warn", ports.warn),
    }),
  };
}
