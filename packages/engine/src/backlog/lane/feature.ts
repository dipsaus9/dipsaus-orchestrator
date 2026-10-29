// The planning lane per office, and its office load step (DIPO-27 seam): after a crash, open
// journal entries are replayed while the office loads, before any other git queue item of the
// office (0007 section 6 step 2, 0010 section 2a step 3). The step must run after `git.version`,
// which attaches the office's git, so the daemon registers this feature after `EngineGit.feature`.

import type { OfficeId } from "@dipsaus-orchestrator/contract";

import { appendEntries } from "../../changelog/log";
import type { FeatureModule } from "../../commands/registry";
import type { OfficeLoadContext } from "../../office/steps";
import type { PlanningLane } from "../../story-store/planning";

import { openEntries } from "./journal";
import {
  type BacklogLaneDeps,
  LANE_NOTICES,
  LANE_REPLAY_STEP,
  LaneFlushError,
  OfficeLane,
} from "./lane";
import {
  DISCARD_KIND,
  dropKind,
  EDIT_KIND,
  editKind,
  HOLD_KIND,
  type LaneOpKind,
  RESUME_KIND,
} from "./ops";
import { planningLane } from "./planning";
import { proposeKind } from "./propose";

export class BacklogLane {
  readonly #deps: BacklogLaneDeps;
  readonly #kinds = new Map<string, LaneOpKind>();
  readonly #offices = new Map<OfficeId, OfficeLane>();

  constructor(deps: BacklogLaneDeps) {
    this.#deps = deps;
    this.register(editKind(EDIT_KIND));
    // Hold, resume of a hold and drop (0020 section 8, DIPO-160).
    this.register(editKind(HOLD_KIND));
    this.register(editKind(RESUME_KIND));
    this.register(dropKind);
    // Discard (0020 section 8, DIPO-161).
    this.register(editKind(DISCARD_KIND));
    // An accepted worker proposal filed as a Backlog draft (0020 section 11c, DIPO-166).
    this.register(proposeKind);
    for (const kind of deps.kinds ?? []) this.register(kind);
  }

  /** Adds an operation kind; a kind name belongs to one registration. */
  register(kind: LaneOpKind): void {
    if (this.#kinds.has(kind.kind)) {
      throw new Error(`The lane operation kind ${kind.kind} is registered twice.`);
    }
    this.#kinds.set(kind.kind, kind);
  }

  /** The office's lane once its office has loaded; undefined before. */
  forOffice(office: OfficeId): OfficeLane | undefined {
    return this.#offices.get(office);
  }

  /** The office's lane as the StoryStore seam offers it (`PlanningLane`); undefined before. */
  planning(office: OfficeId): PlanningLane | undefined {
    const lane = this.#offices.get(office);
    return lane === undefined ? undefined : planningLane(lane);
  }

  /** Creates the office's lane, or keeps the one it has when its handle and git are the same. */
  attach(ctx: OfficeLoadContext): OfficeLane | string {
    const git = this.#deps.git(ctx.officeId);
    if (git === undefined) {
      return "the office's git is not attached; the git.version load step must run before the backlog lane";
    }
    const existing = this.#offices.get(ctx.officeId);
    if (existing !== undefined && existing.git === git) return existing;
    const lane = new OfficeLane({
      officeId: ctx.officeId,
      office: ctx.office,
      git,
      cli: this.#deps.cli,
      clock: ctx.clock,
      kinds: this.#kinds,
      ...(this.#deps.liveClaim === undefined ? {} : { liveClaim: this.#deps.liveClaim }),
      ...(this.#deps.onChanged === undefined ? {} : { onChanged: this.#deps.onChanged }),
      ...(this.#deps.onFlushed === undefined ? {} : { onFlushed: this.#deps.onFlushed }),
      ...(this.#deps.held === undefined ? {} : { held: this.#deps.held }),
      ...(this.#deps.refreshStory === undefined ? {} : { refreshStory: this.#deps.refreshStory }),
    });
    this.#offices.set(ctx.officeId, lane);
    return lane;
  }

  /**
   * Attaches the lane and replays open journal entries. A replay that fails leaves the entries
   * open for the next flush and puts an `engine.notice` on the office; the office still loads.
   */
  async replay(ctx: OfficeLoadContext): Promise<string | null> {
    const lane = this.attach(ctx);
    if (typeof lane === "string") return lane;
    if (openEntries(ctx.office).length === 0) return null;
    try {
      await lane.flush({ replay: true });
    } catch (error) {
      // The flush put its own notice on the office.
      if (error instanceof LaneFlushError) return null;
      const text = `Replaying the open backlog operations failed: ${error instanceof Error ? error.message : String(error)}. They stay journaled and are applied at the next backlog change.`;
      ctx.office.immediate(() =>
        appendEntries(
          ctx.office,
          [
            {
              type: "engine.notice",
              delta: { level: "error", code: LANE_NOTICES.replayFailed, text },
            },
          ],
          { at: ctx.clock.now() },
        ),
      );
      this.#deps.onChanged?.(ctx.officeId);
    }
    return null;
  }

  /** The feature module that adds the replay load step. */
  get feature(): FeatureModule {
    return {
      name: "backlog/lane",
      register: (registry) => {
        registry.registerLoadStep(LANE_REPLAY_STEP, async (ctx) => {
          const reason = await this.replay(ctx);
          return reason === null ? { ok: true } : { ok: false, reason };
        });
      },
    };
  }
}
