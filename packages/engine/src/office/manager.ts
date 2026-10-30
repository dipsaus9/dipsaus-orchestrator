// The office list and the office engine instances (0006 decision 4, 0007 sections 2 and 3, 0011).
// `office.open` registers a repository explicitly and writes its marker; `office.forget` hides it
// from the list and keeps every row, which age out under the one retention rule (0007); an
// office's engine instance loads lazily on its first
// command, read or subscription, after checking that its marker still names it, reading its
// configuration and running the load steps feature modules registered, in order. An invalid
// configuration never refuses an office: it keeps the previous configuration for running work and
// `configBlocksRuns` reports the errors until a valid reload (0017 section 5).

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

import {
  type Clock,
  configError,
  type ConfigError,
  engineError,
  type EngineError,
  type IdSource,
  OfficeId,
} from "@dipsaus-orchestrator/contract";

import { filesAt } from "../box/image";
import { appendEntries } from "../changelog/log";
import { CommandError } from "../commands/errors";
import {
  type OfficeAccess,
  type OfficeDirectory,
  type OfficePath,
  officeUnknown,
} from "../commands/offices";
import type { CommandOutcome, Registry } from "../commands/registry";
import {
  loadOfficeConfig,
  OFFICE_FILE,
  OFFICE_LOCAL_FILE,
  type OfficeConfig,
  type OfficeConfigResult,
  updateLocalPrivacy,
} from "../config";
import type { StateDatabase } from "../db/database";
import type { OfficeHandle } from "../db/office";
import type { OfficeGit } from "../git/office";
import type { Logger } from "../log/logger";
import type { MountReader } from "../platform/sqlite";
import type { SoftwareStream } from "../software-stream";
import { checkoutFiles } from "../story-store/folder";
import type { StoryStore } from "../story-store/store";

import { type OfficeMarker, readMarker, writeMarker } from "./marker";
import { type GitRunner, networkFsType, type Repository, resolveRepository } from "./repository";
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
  /** The story store: whether a repository holds a project of it (0006 decision 4). */
  readonly stories: Pick<StoryStore, "isProject">;
  /** Replaces the system mount table, for tests. */
  readonly readMounts?: MountReader;
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

export interface SetPrivacyResult extends ReloadConfigResult {
  readonly key: string;
  readonly value: boolean;
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
  config: {
    readonly config: OfficeConfig;
    readonly configHash: string;
    /** Leaf key paths `office.local.yaml` sets, for the summary's setting sources. */
    readonly localOverrideKeys: readonly string[];
  } | null = null;
  configErrors: readonly ConfigError[] = [];
  /**
   * The `.dipo/office.yaml` text the configuration was last read from, the checkout's or
   * the base's (DIPO-303); undefined when that file did not exist or could not be read.
   */
  officeText: string | undefined = undefined;
  /**
   * What `reloadIfChanged` last saw of `.dipo/office.yaml` on the base (DIPO-303), null before its
   * first read. Only a change of this reads the configuration again, so an explicit reload of the
   * checkout's file stays in force until the base changes.
   */
  seenOnBase: BaseOfficeFile | null = null;

  constructor(
    readonly officeId: OfficeId,
    readonly office: OfficeHandle,
    readonly path: string,
    readonly commonDir: string,
  ) {}
}

/** The text of `.dipo/office.yaml` under `dir`, or undefined when it is missing or unreadable. */
function readOfficeText(dir: string): string | undefined {
  try {
    return readFileSync(join(dir, OFFICE_FILE), "utf8");
  } catch {
    return undefined;
  }
}

/** `.dipo/office.yaml` as committed on `<remote>/<base>` (DIPO-303). */
export type BaseOfficeFile =
  /** `text` is undefined when the base has no such file. */
  | { readonly kind: "file"; readonly text: string | undefined }
  /** The path on the base is a directory, a link or a submodule. */
  | { readonly kind: "notRegular"; readonly base: string };

/**
 * Reads `.dipo/office.yaml` at the commit `<remote>/<base>` points at, from git's objects, never
 * from a checkout: a poll or `office.rescan` moves only the base, not the maintainer's checkout
 * (0010 section 2). One queue item of the office git. Null when the office has no base branch or
 * `<remote>/<base>` does not exist; the load and the scan report that already.
 */
export function readBaseOfficeFile(git: OfficeGit): Promise<BaseOfficeFile | null> {
  return git.run(async (session) => {
    const base = await git.resolveBaseIn(session).catch(() => null);
    if (base === null) return null;
    const ref = `refs/remotes/${git.settings.remote}/${base}^{commit}`;
    const resolved = await session.step(session.repository, [
      "rev-parse",
      "--verify",
      "--quiet",
      ref,
    ]);
    if (resolved.code !== 0) return null;
    const commit = resolved.stdout.trim();
    const file = (await filesAt(session, commit, [OFFICE_FILE])).get(OFFICE_FILE);
    if (file === undefined) return { kind: "file", text: undefined };
    if (file.text === undefined) return { kind: "notRegular", base };
    return { kind: "file", text: file.text };
  });
}

function sameBaseFile(a: BaseOfficeFile, b: BaseOfficeFile): boolean {
  return a.kind === "file" && b.kind === "file" ? a.text === b.text : a.kind === b.kind;
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

  /** Whether the office's load is running now (DIPO-380): its reads answer `whileLoading`. */
  loading(office: OfficeId): boolean {
    return !this.#instances.has(office) && this.#loading.has(office);
  }

  /**
   * Every registered office that is not forgotten, oldest first; empty before the database opened.
   * The daemon loads each of them in `recovering` (DIPO-56).
   */
  registeredOffices(): OfficeId[] {
    const db = this.#deps.database();
    if (db === null) return [];
    return db.connection
      .all<{ office_id: string }>(
        "select office_id from offices where forgotten_at is null order by added_at, office_id",
      )
      .map((row) => OfficeId.parse(row.office_id));
  }

  /**
   * Refuses a loaded office (reconcile on `office.rescan` found its `office.json` names another
   * office, DIPO-56): its engine instance is dropped and a notice goes on the software stream. The
   * next command loads it again, and the load refuses it while the marker still differs.
   */
  refuse(office: OfficeId, text: string): void {
    if (!this.#instances.delete(office)) return;
    this.#refuse("office.refused", text, { office, step: "reconcile" });
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

  /** The leaf keys `.dipo/office.local.yaml` sets in the configuration in force for `office`. */
  localOverrideKeys(office: OfficeId): readonly string[] {
    return this.#instances.get(office)?.config?.localOverrideKeys ?? [];
  }

  /** The hash of the configuration in force for `office` (0017), as `runs.config_hash` records it. */
  configHash(office: OfficeId): string | undefined {
    return this.#instances.get(office)?.config?.configHash;
  }

  /** The registered path of `office`, forgotten or not (see `OfficeDirectory.registeredPath`). */
  registeredPath(office: OfficeId): OfficePath {
    const db = this.#deps.database();
    if (db === null) return { ok: false, error: recovering() };
    const row = this.#row(db, office);
    return row === null
      ? { ok: false, error: officeUnknown(office) }
      : { ok: true, path: row.path };
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
        `Office ${officeId} at ${row.path}: path missing; \`dipo office open\` the new path, or \`dipo office forget\` it.`,
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
   * office stream. A valid result's warnings, such as a retired key it still sets (DIPO-285), each
   * become a `config.warning` notice there. Returns whether anything changed. Without `from` it
   * reads the checkout's files; with it, `office.yaml` as read from the base (DIPO-303) and the
   * checkout's machine-local `office.local.yaml`.
   */
  async #readConfig(instance: OfficeInstance, from?: BaseOfficeFile): Promise<boolean> {
    let result: OfficeConfigResult;
    if (from === undefined) {
      instance.officeText = readOfficeText(instance.path);
      result = await loadOfficeConfig(instance.path);
    } else if (from.kind === "file") {
      instance.officeText = from.text;
      result = await loadOfficeConfig(instance.path, { office: { text: from.text } });
    } else {
      result = {
        ok: false,
        errors: [
          configError(
            OFFICE_FILE,
            "(top level)",
            "regular file",
            `the file on ${from.base} is not a regular file`,
          ),
        ],
      };
    }
    if (result.ok) {
      const changed =
        instance.config?.configHash !== result.configHash || instance.configErrors.length > 0;
      instance.config = {
        config: result.config,
        configHash: result.configHash,
        localOverrideKeys: result.localOverrideKeys,
      };
      instance.configErrors = [];
      for (const warning of result.warnings) {
        this.#officeNotice(instance, {
          level: "warn",
          code: "config.warning",
          text: warning.message,
        });
      }
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

  /**
   * Reads the configuration again when `.dipo/office.yaml` on the base changed (DIPO-303). The poll
   * after a fetch and `office.rescan` call it with the office's git, so a change that reached the
   * base is in force without a daemon restart, whatever the maintainer's checkout holds. The file
   * is read at `<remote>/<base>` and compared with what the last call saw there; the first call
   * compares it with the text the configuration was read from at load. A valid change goes to the
   * config-reload listeners; a refused one keeps the configuration in force and raises the
   * `config.invalid` notice once. An office that is not loaded, has no office git or no base is
   * left alone.
   */
  reloadIfChanged(office: OfficeId, git: OfficeGit | undefined): Promise<void> {
    return this.#serialised(async () => {
      const instance = this.#instances.get(office);
      if (instance === undefined || git === undefined) return;
      const onBase = await readBaseOfficeFile(git);
      if (onBase === null) return;
      const seen = instance.seenOnBase;
      instance.seenOnBase = onBase;
      if (seen === null) {
        if (onBase.kind === "file" && onBase.text === instance.officeText) return;
      } else if (sameBaseFile(seen, onBase)) {
        return;
      }
      // Refused or loaded again while the base was read: only the instance in force reads it.
      if (this.#instances.get(office) !== instance) return;
      const changed = await this.#readConfig(instance, onBase);
      this.#deps.logger.info("office configuration read from the base", {
        office,
        valid: instance.configErrors.length === 0,
        changed,
      });
      if (changed) this.#listenConfigReload(instance);
    });
  }

  /** Tells every config-reload listener the configuration in force, when it is valid. */
  #listenConfigReload(instance: OfficeInstance): void {
    if (instance.config === null || instance.configErrors.length > 0) return;
    const config = instance.config.config;
    for (const { listen } of this.#deps.registry().configReloads()) {
      listen({ officeId: instance.officeId, office: instance.office, config });
    }
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
   * `office.forget { office, from? }`: hides the office from the list and keeps every row. The
   * executor has already checked `from` against the registered path (DIPO-48).
   */
  forget(office: OfficeId): Promise<CommandOutcome<ForgetResult>> {
    return this.#serialised(async () => this.#forget(office));
  }

  /**
   * `office.reloadConfig { office, from? }` (0017 section 5). A valid configuration of a loaded
   * office goes to every registered config-reload listener, for example the office's git (DIPO-48).
   */
  reloadConfig(office: OfficeId): Promise<CommandOutcome<ReloadConfigResult>> {
    return this.#serialised(() => this.#reloadConfig(office));
  }

  /**
   * `office.setPrivacy { office, key, value }` (0007 section 8, DIPO-136): writes one privacy
   * setting to `.dipo/office.local.yaml`, then reads the configuration again like
   * `office.reloadConfig`. A refused change leaves the file as it was.
   */
  setPrivacy(
    office: OfficeId,
    key: string,
    value: unknown,
  ): Promise<CommandOutcome<SetPrivacyResult>> {
    return this.#serialised(() => this.#setPrivacy(office, key, value));
  }

  /** The office's row; `office.unknown` for an id that was never registered. */
  #existing(db: StateDatabase, officeId: OfficeId): OfficeRow {
    const row = this.#row(db, officeId);
    if (row === null) {
      const error = officeUnknown(officeId);
      throw new CommandError(error.code, error.message, error.details);
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
    const project = await this.#deps.stories.isProject(checkoutFiles(mainWorktree)).then(
      (holds) => (holds ? null : "it holds no Backlog.md project"),
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    if (project !== null) {
      throw new CommandError(
        "office.notProject",
        `${mainWorktree} is a git repository without Backlog.md (${project}); run \`backlog init\` there first.`,
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

  /** A new `offices` row whose log starts at seq 1 and, unless the marker is kept, a new marker. */
  #register(
    db: StateDatabase,
    repository: Repository,
    keep: OfficeMarker | null,
  ): { office: OfficeId; registered: boolean; changed: boolean } {
    const now = this.#deps.clock.now();
    const office = keep?.officeId ?? OfficeId.parse(this.#deps.ids.next("off"));
    // The marker first: a crash before the row leaves a marker whose id the next open registers.
    if (keep === null) writeMarker(repository.commonDir, { officeId: office, createdAt: iso(now) });
    const name = basename(repository.mainWorktree);
    db.connection.immediate(() =>
      db.connection.run(
        `insert into offices (office_id, path, display_name, added_at, next_seq)
         values ($office, $path, $name, $at, 1)`,
        {
          office,
          path: repository.mainWorktree,
          name,
          at: now,
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

  #forget(officeId: OfficeId): CommandOutcome<ForgetResult> {
    const db = this.#deps.database();
    if (db === null) throw new CommandError(recovering().code, recovering().message);
    const row = this.#existing(db, officeId);
    // Target state: forgetting a forgotten office changes nothing (0005 section 9).
    if (row.forgotten_at !== null) {
      return { result: { office: officeId, path: row.path }, changed: false };
    }
    this.#refuseBusy(db, officeId, "forgetting");
    this.#hide(db, officeId);
    this.#deps.logger.info("office forgotten", { office: officeId });
    return { result: { office: officeId, path: row.path }, changed: true };
  }

  /** `office.busy` when any registered active-work check reports work in the office. */
  #refuseBusy(db: StateDatabase, officeId: OfficeId, doing: string): void {
    const handle = this.#instances.get(officeId)?.office ?? db.office(officeId);
    for (const { name, check } of this.#deps.registry().activeWorkChecks()) {
      if (check(handle)) {
        throw new CommandError(
          "office.busy",
          `Office ${officeId} has active work (${name}); stop it before ${doing} the office.`,
          { office: officeId, check: name },
        );
      }
    }
  }

  /** Sets `forgotten_at`, drops the engine instance and tells the software stream. */
  #hide(db: StateDatabase, officeId: OfficeId): void {
    db.connection.immediate(() =>
      db.connection.run("update offices set forgotten_at = $at where office_id = $office", {
        office: officeId,
        at: this.#deps.clock.now(),
      }),
    );
    this.#instances.delete(officeId);
    this.#deps.software.append("office.forgotten", { office: officeId });
  }

  async #reloadConfig(officeId: OfficeId): Promise<CommandOutcome<ReloadConfigResult>> {
    const db = this.#deps.database();
    if (db === null) throw new CommandError(recovering().code, recovering().message);
    this.#existing(db, officeId);
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
    if (wasLoaded) this.#listenConfigReload(instance);
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

  async #setPrivacy(
    officeId: OfficeId,
    key: string,
    value: unknown,
  ): Promise<CommandOutcome<SetPrivacyResult>> {
    const db = this.#deps.database();
    if (db === null) throw new CommandError(recovering().code, recovering().message);
    this.#existing(db, officeId);
    const access = await this.load(officeId);
    if (!access.ok)
      throw new CommandError(access.error.code, access.error.message, access.error.details);
    const instance = this.#instances.get(officeId);
    if (instance === undefined) {
      const error = officeUnknown(officeId);
      throw new CommandError(error.code, error.message, error.details);
    }
    const file = join(instance.path, OFFICE_LOCAL_FILE);
    let current: string | undefined;
    try {
      current = readFileSync(file, "utf8");
    } catch (error) {
      if ((error as { code?: unknown }).code !== "ENOENT") {
        const reason = error instanceof Error ? error.message : String(error);
        throw new CommandError("args.invalid", `${OFFICE_LOCAL_FILE} cannot be read: ${reason}`, {
          file: OFFICE_LOCAL_FILE,
        });
      }
    }
    const update = updateLocalPrivacy(current, key, value);
    if (!update.ok) {
      const first = update.errors[0];
      throw new CommandError(
        "args.invalid",
        update.errors.map((error) => error.message).join("; "),
        { file: OFFICE_LOCAL_FILE, ...(first === undefined ? {} : { key: first.path }) },
      );
    }
    const written = update.text !== current;
    if (written) {
      mkdirSync(dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      try {
        writeFileSync(temp, update.text);
        renameSync(temp, file);
      } catch (error) {
        // No temp file is left in the office repository, and the refusal names the file.
        rmSync(temp, { force: true });
        const reason = error instanceof Error ? error.message : String(error);
        throw new CommandError(
          "office.refused",
          `${OFFICE_LOCAL_FILE} cannot be written: ${reason}`,
          {
            office: officeId,
            file: OFFICE_LOCAL_FILE,
          },
        );
      }
    }
    const reloaded = await this.#reloadConfig(officeId);
    return {
      result: { ...reloaded.result, key, value: value as boolean },
      changed: written || (reloaded.changed ?? false),
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
