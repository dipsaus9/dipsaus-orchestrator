// The office list and the office engine instances (0006 decision 4, 0007 sections 2 and 3, 0011).
// `office.open` registers a repository explicitly and writes its marker; `office.forget` hides it
// from the list and keeps every row; an office's engine instance loads lazily on its first
// command, read or subscription, after checking that its marker still names it, reading its
// configuration and running the load steps feature modules registered, in order. An invalid
// configuration never refuses an office: it keeps the previous configuration for running work and
// `configBlocksRuns` reports the errors until a valid reload (0017 section 5).

import { existsSync } from "node:fs";
import { basename, isAbsolute } from "node:path";

import {
  type Clock,
  type ConfigError,
  engineError,
  type EngineError,
  type IdSource,
  OfficeId,
} from "@dipsaus-orchestrator/contract";

import { appendEntries, newLogState } from "../changelog/log";
import { CommandError } from "../commands/errors";
import { type OfficeAccess, type OfficeDirectory, officeUnknown } from "../commands/offices";
import type { CommandOutcome, Registry } from "../commands/registry";
import { loadOfficeConfig, type OfficeConfig } from "../config";
import type { StateDatabase } from "../db/database";
import type { OfficeHandle } from "../db/office";
import type { Logger } from "../log/logger";
import type { RandomFill } from "../platform/ids";
import type { MountReader } from "../platform/sqlite";
import type { SoftwareStream } from "../software-stream";

import { type OfficeMarker, readMarker, writeMarker } from "./marker";
import {
  type GitRunner,
  isBacklogProject,
  networkFsType,
  canonicalPath,
  type Repository,
  resolveRepository,
} from "./repository";
import type { LoadStepResult, OfficeLoadContext } from "./steps";

export interface OfficeManagerDeps {
  /** The state database once the migrations step opened it; null before. */
  readonly database: () => StateDatabase | null;
  /** The engine's registry, for the load steps and active-work checks feature modules added. */
  readonly registry: () => Registry;
  readonly software: SoftwareStream;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly git: GitRunner;
  readonly logger: Logger;
  /** Replaces the system mount table, for tests. */
  readonly readMounts?: MountReader;
  /** Randomness for new epochs; tests pass a fixed one. */
  readonly fill?: RandomFill;
  /** Entries were appended to an office's change log outside a command; subscribers catch up. */
  readonly onOfficeChanged?: (office: OfficeId) => void;
}

export interface OpenResult {
  readonly office: OfficeId;
  readonly registered: boolean;
  readonly warnings?: string[];
}

export interface ForgetResult {
  readonly office: OfficeId;
  /** The registered path of the forgotten office. */
  readonly path: string;
}

export interface ReloadConfigResult {
  readonly office: OfficeId;
  readonly valid: boolean;
  readonly errors: ConfigError[];
  readonly configHash?: string;
}

interface OfficeRow {
  readonly office_id: string;
  readonly path: string;
  readonly display_name: string;
  readonly added_at: number;
  readonly forgotten_at: number | null;
}

/** One loaded office: its handle, location and the configuration in force. */
class OfficeInstance {
  config: { readonly config: OfficeConfig; readonly configHash: string } | null = null;
  configErrors: readonly ConfigError[] = [];

  constructor(
    readonly officeId: OfficeId,
    readonly office: OfficeHandle,
    readonly path: string,
    readonly commonDir: string,
  ) {}
}

const ROW_COLUMNS = "office_id, path, display_name, added_at, forgotten_at";

export class OfficeManager implements OfficeDirectory {
  readonly #deps: OfficeManagerDeps;
  readonly #instances = new Map<OfficeId, OfficeInstance>();
  readonly #loading = new Map<OfficeId, Promise<OfficeAccess>>();
  /** `office.open`, `office.forget` and `office.reloadConfig` run one at a time. */
  #serial: Promise<unknown> = Promise.resolve();

  constructor(deps: OfficeManagerDeps) {
    this.#deps = deps;
  }

  // Reads of the loaded state

  get(office: OfficeId): OfficeHandle | undefined {
    return this.#instances.get(office)?.office;
  }

  /** Offices whose engine instance is loaded, in load order (`daemon.status`). */
  loadedOffices(): OfficeId[] {
    return [...this.#instances.keys()];
  }

  /**
   * The configuration errors that block new runs in `office` (0017 section 5): those of the last
   * read when it was invalid, empty after a valid one. `work.run` (DIPO-48) refuses while any
   * remain. An office that is not loaded has no runs and reports none.
   */
  configBlocksRuns(office: OfficeId): readonly ConfigError[] {
    return this.#instances.get(office)?.configErrors ?? [];
  }

  /** The configuration in force for `office`: the last valid one read, kept through invalid reloads. */
  config(office: OfficeId): OfficeConfig | undefined {
    return this.#instances.get(office)?.config?.config;
  }

  // Loading

  load(office: OfficeId): Promise<OfficeAccess> {
    const loaded = this.#instances.get(office);
    if (loaded !== undefined) return Promise.resolve({ ok: true, office: loaded.office });
    const pending = this.#loading.get(office);
    if (pending !== undefined) return pending;
    const loading = this.#load(office).finally(() => this.#loading.delete(office));
    this.#loading.set(office, loading);
    return loading;
  }

  async #load(officeId: OfficeId): Promise<OfficeAccess> {
    const db = this.#deps.database();
    if (db === null) return { ok: false, error: recovering() };
    const row = this.#row(db, officeId);
    if (row === null || row.forgotten_at !== null) {
      return { ok: false, error: officeUnknown(officeId) };
    }
    if (!existsSync(row.path)) {
      return this.#refuse(
        "office.pathMissing",
        `Office ${officeId} at ${row.path}: path missing; \`dipo office open\` the new path, or \`dipo office purge\`.`,
        { office: officeId, path: row.path },
      );
    }
    const resolved = await resolveRepository(this.#deps.git, row.path);
    if (!resolved.ok) {
      return this.#refuse(
        "office.refused",
        `Office ${officeId} at ${row.path} was not loaded: ${resolved.detail}.`,
        { office: officeId, path: row.path, step: "repository" },
      );
    }
    const { commonDir } = resolved.repository;
    const marker = readMarker(commonDir);
    const markerId = marker.kind === "marker" ? marker.marker.officeId : null;
    if (markerId !== officeId) {
      const found =
        marker.kind === "marker"
          ? `names office ${marker.marker.officeId}`
          : marker.kind === "none"
            ? "is missing"
            : "is not a valid marker";
      return this.#refuse(
        "office.refused",
        `Office ${officeId} at ${row.path} was not loaded: its office.json ${found}. Run \`dipo office open\` there to register it again.`,
        { office: officeId, path: row.path, step: "marker" },
      );
    }

    const instance = new OfficeInstance(officeId, db.office(officeId), row.path, commonDir);
    await this.#readConfig(instance);
    for (const step of this.#deps.registry().loadSteps()) {
      const outcome = await runStep(step.run, {
        officeId,
        office: instance.office,
        path: instance.path,
        commonDir,
        config: instance.config?.config,
        clock: this.#deps.clock,
        ids: this.#deps.ids,
      });
      if (!outcome.ok) {
        return this.#refuse(
          "office.refused",
          `Office ${officeId} at ${row.path} was not loaded: load step ${step.name} failed: ${outcome.reason}`,
          { office: officeId, path: row.path, step: step.name },
        );
      }
    }
    // Forgotten or moved while it loaded: this instance is stale.
    const now = this.#row(db, officeId);
    if (now === null || now.forgotten_at !== null || now.path !== row.path) {
      return { ok: false, error: officeUnknown(officeId) };
    }
    this.#instances.set(officeId, instance);
    this.#deps.logger.info("office loaded", { office: officeId, path: row.path });
    return { ok: true, office: instance.office };
  }

  /** Refuses an office with a notice on the software stream; the office stays unloaded. */
  #refuse(code: string, text: string, details: Record<string, unknown>): OfficeAccess {
    this.#deps.logger.warn("office refused", { code, ...details });
    this.#deps.software.append("engine.notice", { level: "error", code, text });
    return { ok: false, error: engineError(code, text, details) };
  }

  /**
   * Reads the office's configuration (DIPO-26). A valid result replaces the one in force and clears
   * the errors; an invalid one keeps it, records the errors and puts an `engine.notice` on the
   * office stream. Returns whether anything changed.
   */
  async #readConfig(instance: OfficeInstance): Promise<boolean> {
    const result = await loadOfficeConfig(instance.path);
    if (result.ok) {
      const changed =
        instance.config?.configHash !== result.configHash || instance.configErrors.length > 0;
      instance.config = { config: result.config, configHash: result.configHash };
      instance.configErrors = [];
      return changed;
    }
    const changed = JSON.stringify(instance.configErrors) !== JSON.stringify(result.errors);
    instance.configErrors = result.errors;
    const kept =
      instance.config === null
        ? "the office has no valid configuration yet"
        : "running work keeps the previous configuration";
    this.#officeNotice(instance, {
      level: "error",
      code: "config.invalid",
      text: `The office configuration is invalid; new runs are refused until \`dipo office reload-config\` reads a valid one, and ${kept}. ${result.errors.map((error) => error.message).join("; ")}`,
    });
    return changed;
  }

  #officeNotice(
    instance: OfficeInstance,
    notice: { level: "info" | "warn" | "error"; code: string; text: string },
  ): void {
    const { office } = instance;
    office.immediate(() =>
      appendEntries(office, [{ type: "engine.notice", delta: notice }], {
        at: this.#deps.clock.now(),
      }),
    );
    this.#deps.onOfficeChanged?.(instance.officeId);
  }

  // Commands

  /** `office.open { path }` (0005 section 4, 0007 section 2). */
  open(path: string): Promise<CommandOutcome<OpenResult>> {
    return this.#serialised(() => this.#open(path));
  }

  /**
   * `office.forget { office, from? }`: hides the office from the list and keeps every row. `from`
   * is the main worktree a client resolved the office from; see `#checkFrom`.
   */
  forget(office: OfficeId, from?: string): Promise<CommandOutcome<ForgetResult>> {
    return this.#serialised(async () => this.#forget(office, from));
  }

  /** `office.reloadConfig { office, from? }` (0017 section 5). */
  reloadConfig(office: OfficeId, from?: string): Promise<CommandOutcome<ReloadConfigResult>> {
    return this.#serialised(() => this.#reloadConfig(office, from));
  }

  /**
   * A client that resolved the office from its current directory names the main worktree it found
   * there. When that is not the office's registered path (canonical on both sides) the directory is
   * not this office, for example an unopened copy that still carries the original's marker, so the
   * command fails with `office.unknown` and acts on nothing.
   */
  #checkFrom(db: StateDatabase, officeId: OfficeId, from: string | undefined): OfficeRow {
    const row = this.#row(db, officeId);
    if (row === null) {
      const error = officeUnknown(officeId);
      throw new CommandError(error.code, error.message, error.details);
    }
    if (from !== undefined && canonicalPath(from) !== canonicalPath(row.path)) {
      throw new CommandError("office.unknown", ` is not office , which is registered at .`, {
        office: officeId,
        from,
        reason: "path",
      });
    }
    return row;
  }

  #serialised<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#serial.then(fn, fn);
    this.#serial = run.catch(() => undefined);
    return run;
  }

  async #open(path: string): Promise<CommandOutcome<OpenResult>> {
    if (!isAbsolute(path)) {
      throw new CommandError("args.invalid", `office.open needs an absolute path, got ${path}.`, {
        path,
      });
    }
    const resolved = await resolveRepository(this.#deps.git, path);
    if (!resolved.ok) {
      if (resolved.reason === "missing") {
        throw new CommandError("office.pathMissing", `${path} does not exist.`, { path });
      }
      throw new CommandError(
        "office.notProject",
        `${path} is not a git repository with Backlog.md (${resolved.detail}).`,
        { path },
      );
    }
    const repository = resolved.repository;
    const { mainWorktree, commonDir } = repository;
    if (!isBacklogProject(mainWorktree)) {
      throw new CommandError(
        "office.notProject",
        `${mainWorktree} is a git repository without Backlog.md (no backlog/config.yml); run \`backlog init\` there first.`,
        { path: mainWorktree },
      );
    }
    const db = this.#deps.database();
    if (db === null) throw new CommandError(recovering().code, recovering().message);

    const warnings: string[] = [];
    const fsType = await networkFsType(mainWorktree, this.#deps.readMounts);
    if (fsType !== null) {
      warnings.push(
        `${mainWorktree} is on a network filesystem (${fsType}); another machine opening it has its own state, and nothing guards its worktrees and branches.`,
      );
    }

    const marker = readMarker(commonDir);
    if (marker.kind === "invalid") {
      throw new CommandError(
        "office.markerInvalid",
        `${marker.detail}. Fix or remove it, then open the office again.`,
        { path: mainWorktree },
      );
    }
    const outcome = await this.#place(
      db,
      repository,
      marker.kind === "marker" ? marker.marker : null,
    );
    warnings.push(...outcome.warnings);
    for (const text of warnings) {
      this.#deps.software.append("engine.notice", { level: "warn", code: "office.open", text });
    }
    return {
      result: {
        office: outcome.office,
        registered: outcome.registered,
        ...(warnings.length > 0 ? { warnings } : {}),
      },
      changed: outcome.changed,
    };
  }

  /** Matches the repository to an office row by its marker: reopen, restore, move, copy or new. */
  async #place(
    db: StateDatabase,
    repository: Repository,
    marker: OfficeMarker | null,
  ): Promise<{ office: OfficeId; registered: boolean; changed: boolean; warnings: string[] }> {
    const { mainWorktree, commonDir } = repository;
    if (marker === null) {
      // No marker: a new office, unless a row already names this path (its `.git/dipo/` was
      // removed); that office keeps its id and gets its marker back.
      const atPath = db.connection.get<OfficeRow>(
        `select ${ROW_COLUMNS} from offices where path = $path order by forgotten_at is not null, added_at desc limit 1`,
        { path: mainWorktree },
      );
      if (atPath !== null) {
        const office = OfficeId.parse(atPath.office_id);
        writeMarker(commonDir, { officeId: office, createdAt: iso(atPath.added_at) });
        return { ...this.#reopen(db, atPath, mainWorktree), warnings: [] };
      }
      return { ...this.#register(db, repository, null), warnings: [] };
    }

    const row = this.#row(db, marker.officeId);
    // The database lost the office (0007 section 10): register it again under its marker's id.
    if (row === null) return { ...this.#register(db, repository, marker), warnings: [] };
    if (row.path === mainWorktree) return { ...this.#reopen(db, row, mainWorktree), warnings: [] };

    const other = await this.#markerAt(row.path);
    if (other?.mainWorktree === mainWorktree) {
      // The row's path is another spelling of this repository.
      return { ...this.#reopen(db, row, mainWorktree), warnings: [] };
    }
    if (other?.officeId === marker.officeId) {
      // The registered path still exists with the same id: this is a copy (0007 section 2).
      const placed = this.#register(db, repository, null);
      return {
        ...placed,
        warnings: [
          `${mainWorktree} carries the office id ${marker.officeId} of ${row.path}, which still exists, so it is a copy and became the new office ${placed.office}.`,
        ],
      };
    }
    // The registered path is gone or holds another office: the repository moved here.
    this.#deps.logger.info("office moved", {
      office: marker.officeId,
      from: row.path,
      to: mainWorktree,
    });
    return { ...this.#reopen(db, row, mainWorktree), warnings: [] };
  }

  /** The marker id and main worktree at a registered path, or null when it is gone. */
  async #markerAt(path: string): Promise<{ officeId: OfficeId; mainWorktree: string } | null> {
    if (!existsSync(path)) return null;
    const resolved = await resolveRepository(this.#deps.git, path);
    if (!resolved.ok) return null;
    const marker = readMarker(resolved.repository.commonDir);
    if (marker.kind !== "marker") return null;
    return { officeId: marker.marker.officeId, mainWorktree: resolved.repository.mainWorktree };
  }

  /** A new `offices` row with a random epoch and, unless the marker is kept, a new marker. */
  #register(
    db: StateDatabase,
    repository: Repository,
    keep: OfficeMarker | null,
  ): { office: OfficeId; registered: boolean; changed: boolean } {
    const now = this.#deps.clock.now();
    const office = keep?.officeId ?? OfficeId.parse(this.#deps.ids.next("off"));
    // The marker first: a crash before the row leaves a marker whose id the next open registers.
    if (keep === null) writeMarker(repository.commonDir, { officeId: office, createdAt: iso(now) });
    const log = newLogState(this.#deps.fill);
    const name = basename(repository.mainWorktree);
    db.connection.immediate(() =>
      db.connection.run(
        `insert into offices (office_id, path, display_name, added_at, epoch, next_seq, replay_floor_seq)
         values ($office, $path, $name, $at, $epoch, $next, $floor)`,
        {
          office,
          path: repository.mainWorktree,
          name,
          at: now,
          epoch: log.epoch,
          next: log.nextSeq,
          floor: log.replayFloorSeq,
        },
      ),
    );
    this.#deps.logger.info("office registered", { office, path: repository.mainWorktree });
    this.#deps.software.append("office.registered", {
      office,
      path: repository.mainWorktree,
      name,
    });
    return { office, registered: true, changed: true };
  }

  /**
   * An office that is already registered: unchanged when listed at this path, else restored from
   * forgotten and moved to this path with every row kept (0007 section 3).
   */
  #reopen(
    db: StateDatabase,
    row: OfficeRow,
    path: string,
  ): { office: OfficeId; registered: boolean; changed: boolean } {
    const office = OfficeId.parse(row.office_id);
    if (row.forgotten_at === null && row.path === path) {
      return { office, registered: false, changed: false };
    }
    const name = row.path === path ? row.display_name : basename(path);
    db.connection.immediate(() =>
      db.connection.run(
        "update offices set path = $path, display_name = $name, forgotten_at = null where office_id = $office",
        { office, path, name },
      ),
    );
    this.#instances.delete(office);
    this.#deps.logger.info("office restored", { office, path });
    this.#deps.software.append("office.registered", { office, path, name });
    return { office, registered: false, changed: true };
  }

  #forget(officeId: OfficeId, from: string | undefined): CommandOutcome<ForgetResult> {
    const db = this.#deps.database();
    if (db === null) throw new CommandError(recovering().code, recovering().message);
    const row = this.#checkFrom(db, officeId, from);
    // Target state: forgetting a forgotten office changes nothing (0005 section 9).
    if (row.forgotten_at !== null) {
      return { result: { office: officeId, path: row.path }, changed: false };
    }
    const handle = this.#instances.get(officeId)?.office ?? db.office(officeId);
    for (const { name, check } of this.#deps.registry().activeWorkChecks()) {
      if (check(handle)) {
        throw new CommandError(
          "office.busy",
          `Office ${officeId} has active work (${name}); stop it before forgetting the office.`,
          { office: officeId, check: name },
        );
      }
    }
    db.connection.immediate(() =>
      db.connection.run("update offices set forgotten_at = $at where office_id = $office", {
        office: officeId,
        at: this.#deps.clock.now(),
      }),
    );
    this.#instances.delete(officeId);
    this.#deps.logger.info("office forgotten", { office: officeId });
    this.#deps.software.append("office.forgotten", { office: officeId });
    return { result: { office: officeId, path: row.path }, changed: true };
  }

  async #reloadConfig(
    officeId: OfficeId,
    from: string | undefined,
  ): Promise<CommandOutcome<ReloadConfigResult>> {
    const db = this.#deps.database();
    if (db === null) throw new CommandError(recovering().code, recovering().message);
    this.#checkFrom(db, officeId, from);
    const wasLoaded = this.#instances.has(officeId);
    const access = await this.load(officeId);
    if (!access.ok)
      throw new CommandError(access.error.code, access.error.message, access.error.details);
    const instance = this.#instances.get(officeId);
    if (instance === undefined) {
      const error = officeUnknown(officeId);
      throw new CommandError(error.code, error.message, error.details);
    }
    // A load just read the configuration; only an office loaded before reads it again.
    const changed = wasLoaded ? await this.#readConfig(instance) : false;
    return {
      result: {
        office: officeId,
        valid: instance.configErrors.length === 0,
        errors: [...instance.configErrors],
        ...(instance.config === null ? {} : { configHash: instance.config.configHash }),
      },
      changed,
    };
  }

  #row(db: StateDatabase, office: string): OfficeRow | null {
    return db.connection.get<OfficeRow>(
      `select ${ROW_COLUMNS} from offices where office_id = $office`,
      { office },
    );
  }
}

async function runStep(
  run: (ctx: OfficeLoadContext) => LoadStepResult | void | Promise<LoadStepResult | void>,
  ctx: OfficeLoadContext,
): Promise<LoadStepResult> {
  try {
    return (await run(ctx)) ?? { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function recovering(): EngineError {
  return engineError(
    "engine.recovering",
    "The daemon has not opened its state database yet; try again shortly.",
  );
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
