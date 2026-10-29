// Operations on the running daemon are contract messages (0006 decision 5): the `daemon.status`
// read and the `daemon.stop`, `daemon.setLogLevel` and `daemon.resumeScheduling` commands. They are
// software-level, so their idempotency records live in the daemon's in-memory request table
// (0005 section 9). Every lifecycle transition goes onto the software stream as `daemon.state`
// (0006 decision 7).

import {
  type Clock,
  daemonResumeScheduling,
  daemonSetLogLevel,
  daemonStatus,
  daemonStop,
  type OfficeId,
  type ToolPaths,
} from "@dipsaus-orchestrator/contract";
import type { FeatureModule } from "../commands/registry";
import type { Logger } from "../log/logger";
import type { SoftwareStream } from "../software-stream/stream";

import type { DrainRequest } from "./drain";
import type { DaemonLifecycle } from "./lifecycle";

/** One office's count of base commits after the build commit that change engine code. */
export interface EngineBehind {
  readonly office: OfficeId;
  readonly name?: string;
  readonly commits: number;
}

export interface ControlDeps {
  readonly lifecycle: DaemonLifecycle;
  readonly logger: Logger;
  readonly clock: Clock;
  /** When this daemon started, from the clock. */
  readonly startedAt: number;
  readonly pid: number;
  readonly version: string;
  /** The commit the binary was built from; absent when run from source (DIPO-198). */
  readonly buildCommit?: string;
  /**
   * Per loaded office whose repository holds the build commit, its engine commits behind, as last
   * read in the background: synchronous, so `daemon.status` never waits on git.
   */
  readonly engineBehind?: () => readonly EngineBehind[];
  readonly socket: string;
  /** The absolute tool paths resolved from the daemon's `PATH` at start (DIPO-70). */
  readonly tools: ToolPaths;
  /** True once the executable on disk changed (0006 decision 14, DIPO-70). */
  readonly upgradePending: () => boolean;
  /** Offices whose engine instance is loaded (DIPO-27). */
  readonly loadedOffices: () => readonly OfficeId[];
  /** Active runs over the loaded offices, for `daemon.status.activeRuns` (DIPO-48, DIPO-125). */
  readonly activeRuns?: () => number;
  /** `daemon.status.keepAwake` (0006 decision 12, DIPO-63); not held when absent. */
  readonly keepAwake?: () => { readonly held: boolean; readonly reason?: string };
  /**
   * Lifts every loaded office's starts paused (0020, `StartsPaused.liftAll`); answers how many
   * offices had something lifted. None without it.
   */
  readonly liftStartsPaused?: (why: string) => number;
  /** Starts the drain; the first request wins (`foreground.ts`). */
  readonly requestStop: (request: DrainRequest) => void;
}

/** The reason `daemon.state` carries when `daemon.stop` starts the drain. */
export const STOP_REASON = "daemon.stop";

/**
 * The active runs over `offices` (DIPO-125): the sum of each loaded office's count. An office with
 * no count (not loaded any more) adds nothing.
 */
export function sumActiveRuns(
  offices: readonly OfficeId[],
  countOf: (office: OfficeId) => number | undefined,
): number {
  return offices.reduce((sum, office) => sum + (countOf(office) ?? 0), 0);
}

/** Registers the `daemon.*` read and commands. */
export function controlFeature(deps: ControlDeps): FeatureModule {
  const { lifecycle, logger, clock } = deps;
  return {
    name: "daemon/control",
    register(registry) {
      registry.addRead({
        definition: daemonStatus,
        handle: () => ({
          state: lifecycle.state,
          stateReason: lifecycle.reason,
          pid: deps.pid,
          version: deps.version,
          uptimeMs: Math.max(0, Math.floor(clock.now() - deps.startedAt)),
          socket: deps.socket,
          loadedOffices: [...deps.loadedOffices()],
          activeRuns: deps.activeRuns?.() ?? 0,
          keepAwake: { ...(deps.keepAwake?.() ?? { held: false }) },
          upgradePending: deps.upgradePending(),
          tools: { ...deps.tools },
          ...(deps.buildCommit === undefined
            ? {}
            : {
                buildCommit: deps.buildCommit,
                engineBehind: [...(deps.engineBehind?.() ?? [])],
              }),
        }),
      });

      registry.addSoftwareCommand({
        definition: daemonStop,
        handle: (_ctx, args) => {
          // Target state: stopping a draining daemon changes nothing (0005 section 9).
          if (lifecycle.state === "draining") {
            return { result: { state: "draining" as const }, changed: false };
          }
          logger.info("daemon.stop received", { stopWorkers: args.stopWorkers });
          lifecycle.transition("draining", STOP_REASON);
          deps.requestStop({ reason: STOP_REASON, stopWorkers: args.stopWorkers });
          return { result: { state: "draining" as const }, changed: true };
        },
      });

      registry.addSoftwareCommand({
        definition: daemonSetLogLevel,
        handle: (_ctx, args) => {
          const previous = logger.level();
          logger.setLevel(args.level);
          if (previous !== args.level) {
            logger.info("log level changed", { from: previous, to: args.level });
          }
          return { result: { level: args.level }, changed: previous !== args.level };
        },
      });

      registry.addSoftwareCommand({
        definition: daemonResumeScheduling,
        handle: () => {
          // Every office's starts paused lifts too (0020), after `safe` is left, so the parks the
          // lift resumes find scheduling on. Outside `safe` the lift is all it does, and with
          // nothing paused either it answers `daemon.notSafe`.
          const why = "the maintainer ran dipo daemon resume-scheduling";
          if (lifecycle.state === "safe") {
            lifecycle.resumeScheduling();
            deps.liftStartsPaused?.(why);
            return { result: { state: lifecycle.state }, changed: true };
          }
          if ((deps.liftStartsPaused?.(why) ?? 0) === 0) lifecycle.resumeScheduling();
          return { result: { state: lifecycle.state }, changed: true };
        },
      });
    },
  };
}

/** Puts every lifecycle transition on the software stream; returns a function that stops it. */
export function emitDaemonStates(lifecycle: DaemonLifecycle, software: SoftwareStream): () => void {
  return lifecycle.onTransition((change) => {
    software.append("daemon.state", { from: change.from, to: change.to, reason: change.reason });
  });
}
