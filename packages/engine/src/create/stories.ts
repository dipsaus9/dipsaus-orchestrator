// The engine's story services (DIPO-318), in the order `createEngine` builds them: the claims, the
// story PRs, the backlog PRs and the planning lane, office init, the story index, the Ready gate,
// the adapter holds, the run base and the story planning. A call to a service built later goes
// through its partner.

import type { OfficeId } from "@dipsaus-orchestrator/contract";

import { BacklogLane } from "../backlog/lane/feature";
import { initKind } from "../backlog/init/ops";
import { OfficeInit } from "../backlog/init/init";
import { BacklogPrs } from "../backlog/pr/feature";
import { boxTokenHoldPath, boxTokenStickyHolds } from "../box/token-hold";
import { GateStore } from "../gate-decisions/feature";
import type { AutoMergeGuard } from "../merge/guard";
import { gitParkWriter } from "../run/park";
import { officeHoldStore } from "../run/starts-paused";
import { storyRunBase, type RunBase } from "../run/work-run";
import { StoryIndex } from "../stories/feature";
import { StoryPlanning, type StoryPlanningDeps } from "../stories/planning";
import { gitStoryPrOps } from "../story-pr/git";
import { StoryPrs } from "../story-pr/prs";
import { guardedParkWriter } from "../merge/guard";
import type { ProcessProbe } from "../platform/process";
import { CLAUDE_CLI_ADAPTER_ID } from "../workers/claude-cli/plan";
import { AdapterHolds, RELEASE_NOTICE_CODE } from "../workers/hold";
import { StoryClaims } from "../worktree/feature";
import { hasLiveClaim } from "../worktree/records";
import type { Core } from "./core";
import type { EnginePartners } from "./partners";

export interface StoryServices {
  readonly claims: StoryClaims;
  readonly storyPrs: StoryPrs;
  readonly backlogPrs: BacklogPrs;
  readonly lane: BacklogLane;
  readonly officeInit: OfficeInit;
  readonly storyIndex: StoryIndex;
  readonly gates: GateStore;
  readonly holds: AdapterHolds;
  readonly runBase: RunBase;
  readonly planning: StoryPlanning;
  /** Turns auto-merge off for a story branch's PR before a park or a lift is written (0002). */
  readonly autoMergeGuard: AutoMergeGuard;
}

/**
 * The dependencies of `StoryPlanning` (DIPO-227): the process probe is passed in, so a test can
 * check that the engine's planning gets the probe it was given.
 */
export function storyPlanningDeps(
  parts: Omit<StoryPlanningDeps, "probe">,
  probe: ProcessProbe,
): StoryPlanningDeps {
  return { ...parts, probe };
}

/**
 * Story claims (DIPO-38): their load step pins live claims' worktree snapshots on the office git,
 * so it follows the git load step. The lane refuses a story with a live claim.
 */
function claimsOf(core: Core): StoryClaims {
  const { logger } = core;
  return new StoryClaims({
    stories: core.stories,
    git: core.gitOf,
    warn: (message, fields) => logger.warn(message, { component: "claims", ...fields }),
    info: (message, fields) => logger.info(message, { component: "claims", ...fields }),
    // Leftover `_branch-read-*` scratch directories older than this start are swept (DIPO-90).
    startedAt: core.deps.daemon.startedAt,
    onChanged: core.onChanged,
  });
}

/**
 * The story PR (DIPO-144): opened or updated right after each In Review push, and retried every
 * `polling.prStateSeconds` until it exists. CI on it (DIPO-147): the checks and job logs of a red
 * head, and the park at the run's CI cap. Whether a run is a box run comes from the run services,
 * a partner (DIPO-299: its head may be final with no CI).
 */
function storyPrsOf(core: Core, partners: EnginePartners, guard: AutoMergeGuard): StoryPrs {
  const { host, gitOf } = core;
  return new StoryPrs({
    stories: core.stories,
    host,
    prState: core.prState,
    git: gitStoryPrOps({ git: gitOf, stories: core.stories }),
    offices: core.offices,
    clock: core.deps.clock,
    onChanged: core.onChanged,
    logger: core.logger.child({ component: "story-pr" }),
    review: host,
    park: {
      writer: guardedParkWriter(gitParkWriter({ git: gitOf, stories: core.stories }), guard),
      implemented: core.implemented,
    },
    boxRun: (office, stored) => partners.runs.get().isBoxRun(office, stored),
    // The auto-merge merges story PRs, with the base's required checks from GitHub (0002).
    mergesStories: true,
    required: host,
    // The review comments redact the env files of the office's main checkout (0008).
    checkout: (office) => gitOf(office)?.mainWorktree,
  });
}

/**
 * The backlog PR (DIPO-35), opened or updated after each lane flush and looked up after each
 * story-index poll for a merge by hand, and the planning lane whose flushes open it; office init's
 * steps (DIPO-36) are lane operations of their own kind.
 */
function laneOf(
  core: Core,
  partners: EnginePartners,
): { readonly backlogPrs: BacklogPrs; readonly lane: BacklogLane } {
  const backlogPrs = new BacklogPrs({
    host: core.host,
    // Reconcile lists the open `dipo/backlog-*` PRs to adopt one after a lost database (DIPO-80).
    list: core.host,
    lane: (office) => partners.lane.get().forOffice(office),
    cli: core.backlogCli,
    offices: core.offices,
    clock: core.deps.clock,
    onChanged: core.onChanged,
    logger: core.logger.child({ component: "backlog-pr" }),
  });
  // A flush that ran while its office loaded (the replay step) opens its PR once the office has
  // loaded (DIPO-403).
  core.offices.onLoaded((office) => void backlogPrs.loaded(office));
  const lane = new BacklogLane({
    cli: core.backlogCli,
    git: core.gitOf,
    kinds: [initKind()],
    liveClaim: hasLiveClaim,
    onChanged: core.onChanged,
    onFlushed: async (office, report) => {
      await backlogPrs.afterFlush(office, report);
      partners.autoMerge.get().kick(office);
    },
    held: (office) => partners.autoMerge.get().holding(office),
    // A merged hold or resume stops counting as the story's park: the base's read replaces it.
    refreshStory: (office, key) => partners.storyIndex.get().refreshStory(office, key),
    // Each flush that holds, fails or leaves operations waiting says why (DIPO-401).
    logger: core.logger.child({ component: "backlog-lane" }),
  });
  return { backlogPrs, lane };
}

/**
 * The story index (DIPO-32): indexes each office at load, after the git load step and the lane's
 * replay, and polls its remote every `polling.fetchSeconds`; a change of `.dipo/office.yaml` that
 * reached the base is in force from the poll that reads it (DIPO-303).
 */
function storyIndexOf(core: Core, backlogPrs: BacklogPrs): StoryIndex {
  const { logger, offices, engineGit } = core;
  return new StoryIndex({
    git: engineGit,
    stories: core.stories,
    // A pass reads a story's view again only when a Backlog file it printed changed (DIPO-314).
    reuseViews: true,
    offices,
    onOfficeChanged: core.onChanged,
    onPolled: (office) => {
      void backlogPrs.sync(office).catch((error: unknown) => {
        logger.warn("checking the backlog PR failed", {
          office,
          reason: error instanceof Error ? error.message : String(error),
        });
      });
    },
    reloadConfig: (office) => offices.reloadIfChanged(office, engineGit.forOffice(office)),
    logger: logger.child({ component: "stories" }),
  });
}

/**
 * Adapter holds (DIPO-43): a failed launch check holds new runs on that adapter in every office,
 * with a notice on the software stream: the office's starts paused (0020). A lift resumes, through
 * the run services, the parks a plan limit left in an office no longer paused. The box-token hold
 * (DIPO-271) is sticky: kept in the state directory over a restart, and lifted only when
 * `dipo login box` replaces the token and removes its record.
 */
function holdsOf(core: Core, partners: EnginePartners): AdapterHolds {
  const { clock } = core.deps;
  const { offices } = core;
  return new AdapterHolds({
    clock,
    notify: (notice) => {
      core.software.append("engine.notice", notice);
      if (notice.code === RELEASE_NOTICE_CODE) {
        partners.runs.get().startsPaused.adapterReleased();
      }
    },
    // Kept for every registered office, loaded or not: one adapter runs them all (0001).
    store: officeHoldStore(clock, {
      get: (office) => offices.get(office),
      loaded: () => offices.loadedOffices(),
      connection: () => core.database.get()?.connection ?? null,
    }),
    sticky: boxTokenStickyHolds(boxTokenHoldPath(core.deps.paths.stateDir), CLAUDE_CLI_ADAPTER_ID),
    warn: (message, fields) => core.logger.warn(message, fields),
  });
}

/**
 * `story.park`, `story.drop` and the resume of a park with no run (DIPO-160, DIPO-344): lane
 * operations, the story PR closed through the code host and the claim released with the office
 * git; a story with a run parks through run control, in the run services.
 */
function planningOf(core: Core, partners: EnginePartners, lane: BacklogLane): StoryPlanning {
  return new StoryPlanning(
    storyPlanningDeps(
      {
        stories: core.stories,
        lane: (office) => lane.planning(office),
        git: core.gitOf,
        host: core.host,
        implemented: core.implemented,
        parkRun: (ctx, args) => partners.runs.get().control.parkByMaintainer(ctx, args),
      },
      core.deps.probe,
    ),
  );
}

export function buildStoryServices(core: Core, partners: EnginePartners): StoryServices {
  const claims = claimsOf(core);
  // No park or lift reaches a story branch while its PR has auto-merge on (0002).
  const autoMergeGuard: AutoMergeGuard = (office, branch, write) =>
    partners.autoMerge.get().guarded(office, branch, write);
  const storyPrs = storyPrsOf(core, partners, autoMergeGuard);
  const { backlogPrs, lane } = laneOf(core, partners);
  // Office init (DIPO-36): `office.init` reads the base and submits its steps to the lane, whose
  // flush opens the backlog PR and kicks the auto-merge.
  const officeInit = new OfficeInit({
    offices: core.offices,
    lane: (office: OfficeId) => lane.forOffice(office),
    git: core.gitOf,
    cli: core.backlogCli,
    clock: core.deps.clock,
    prWaiting: (office) => backlogPrs.waiting(office),
    onChanged: core.onChanged,
  });
  const storyIndex = storyIndexOf(core, backlogPrs);
  return {
    claims,
    storyPrs,
    backlogPrs,
    lane,
    officeInit,
    storyIndex,
    // The Ready gate (DIPO-71): the read `story.gate` and stored decisions, read on `_base`.
    gates: new GateStore({
      git: core.engineGit,
      stories: core.stories,
      offices: core.offices,
      clock: core.deps.clock,
      ids: core.ids,
      index: storyIndex,
    }),
    holds: holdsOf(core, partners),
    runBase: storyRunBase({ git: core.gitOf, stories: core.stories }),
    planning: planningOf(core, partners, lane),
    autoMergeGuard,
  };
}
