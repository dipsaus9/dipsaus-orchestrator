// The engine's core (DIPO-318): what every service is built on and reaches from its first call.
// The lifecycle and the software stream, the office change notifier and the TUI presence, the
// command registry (empty until the feature list is loaded into it), the state database once
// recovery opened it, the office manager, git, the Backlog CLI and the story store, the code host
// and the one PR-state poll.

import type { CommandName, IdSource, OfficeId } from "@dipsaus-orchestrator/contract";

import type { BacklogCli } from "../backlog/runner";
import { backlogStoryStore } from "../backlog/store";
import { Registry } from "../commands/registry";
import type { StateDatabase } from "../db/database";
import { EngineGit } from "../git/feature";
import type { OfficeGit } from "../git/office";
import type { Logger } from "../log/logger";
import { OfficeManager } from "../office/manager";
import { trackEngineCalls } from "../platform/deadline";
import { GhHost } from "../platform/host";
import { createSystemIds } from "../platform/ids";
import { PrStatePoll } from "../platform/pr-state";
import { ChildProcesses } from "../platform/process";
import { SoftwareStream } from "../software-stream";
import type { StoryStore } from "../story-store/store";
import { emitDaemonStates } from "./control";
import type { EngineDeps } from "./deps";
import { DaemonLifecycle } from "./lifecycle";
import { backlogCliFor } from "./runs";
import { OfficeChanges, TuiPresence } from "./notify";

/** The state database: null until the migrations step opened it (0007 section 1). */
export class StateDatabaseHolder {
  #database: StateDatabase | null = null;

  get(): StateDatabase | null {
    return this.#database;
  }

  /** The open database; throws before the migrations step opened it. */
  open(): StateDatabase {
    if (this.#database === null) throw new Error("the state database is not open yet");
    return this.#database;
  }

  set(database: StateDatabase): void {
    this.#database = database;
  }
}

export interface Core {
  readonly deps: EngineDeps;
  readonly logger: Logger;
  readonly lifecycle: DaemonLifecycle;
  readonly software: SoftwareStream;
  readonly changes: OfficeChanges;
  readonly presence: TuiPresence;
  readonly registry: Registry;
  /** True when the engine serves a command; a park offers only those (DIPO-50). */
  readonly implemented: (name: CommandName) => boolean;
  readonly ids: IdSource;
  /** The child processes the engine starts itself; the drain waits for them. */
  readonly children: ChildProcesses;
  readonly database: StateDatabaseHolder;
  readonly offices: OfficeManager;
  readonly engineGit: EngineGit;
  readonly gitOf: (office: OfficeId) => OfficeGit | undefined;
  readonly backlogCli: BacklogCli;
  readonly stories: StoryStore;
  readonly host: GhHost;
  readonly prState: PrStatePoll;
  /** New entries in an office's change log reach its subscribers. */
  readonly onChanged: (office: OfficeId) => void;
}

/** The lifecycle, its log lines and its `daemon.state` events (0006 decision 7). */
function lifecycleOf(logger: Logger, software: SoftwareStream): DaemonLifecycle {
  const lifecycle = new DaemonLifecycle("daemon started");
  lifecycle.onTransition((change) => logger.info("daemon state", { ...change }));
  emitDaemonStates(lifecycle, software);
  logger.info("daemon state", { to: lifecycle.state, reason: lifecycle.reason });
  return lifecycle;
}

export function buildCore(deps: EngineDeps): Core {
  const { clock, logger, spawn, tools } = deps;
  // The software stream: a ring buffer with a new random epoch at every start (0006 decision 9).
  const software = new SoftwareStream({ clock });
  const lifecycle = lifecycleOf(logger, software);
  const changes = new OfficeChanges();
  const onChanged = (office: OfficeId) => changes.notify(office);
  const registry = new Registry();
  const ids = createSystemIds(clock);
  const database = new StateDatabaseHolder();
  const git = { spawn, ...(tools.git === undefined ? {} : { git: tools.git }) };
  // Office commands reach the database only once the migrations step opened it; until then the
  // lifecycle gate answers them with engine.recovering. Office engine instances load lazily on
  // first use (0006 decision 4, DIPO-27).
  const offices = new OfficeManager({
    database: () => database.get(),
    registry: () => registry,
    software,
    clock,
    ids,
    git,
    logger: logger.child({ component: "office" }),
    onOfficeChanged: onChanged,
  });
  // The engine's git (DIPO-31): one serial queue per loaded office, with the git the daemon
  // resolved from its PATH, so every office uses the same binary.
  const engineGit = new EngineGit(git);
  // Every Backlog CLI call runs the `backlog` the daemon resolved (DIPO-74). A status change the
  // runner refuses (DIPO-312) is an `engine.notice` on the software stream. Each call's deadline
  // runs on the engine clock (DIPO-314).
  const backlogCli: BacklogCli = {
    ...backlogCliFor(tools, spawn),
    clock,
    notify: (notice: { level: "error"; code: string; text: string }) =>
      software.append("engine.notice", notice),
  };
  // One `gh` host, on the daemon's PATH, for teardown, the story and backlog PRs and the merges.
  const host = new GhHost({
    spawn,
    clock,
    ...(tools.gh === undefined ? {} : { gh: tools.gh }),
    env: deps.env,
    logger: logger.child({ component: "gh" }),
  });
  // The engine's Backlog CLI, gh and git calls are tracked while they run, so the stop ends any
  // still running (DIPO-314).
  trackEngineCalls();
  return {
    deps,
    logger,
    lifecycle,
    software,
    changes,
    presence: new TuiPresence(),
    registry,
    implemented: (name) => registry.command(name) !== undefined,
    ids,
    children: new ChildProcesses(),
    database,
    offices,
    engineGit,
    gitOf: (office) => engineGit.forOffice(office),
    backlogCli,
    // Every story read and write goes through the StoryStore (0010), here Backlog.md.
    stories: backlogStoryStore(backlogCli),
    host,
    // One PR-state poll per office (DIPO-314): every `polling.prStateSeconds` one round runs the
    // story-PR poll, an auto-merge round and the Done poll, which read each open PR once.
    prState: new PrStatePoll({
      host,
      offices,
      clock,
      logger: logger.child({ component: "pr-state" }),
    }),
    onChanged,
  };
}
