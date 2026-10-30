// The registry of commands and reads (M0 review, DIPO-15). Each feature module exports
// `register(registry)`, which adds its handlers next to the contract definition they serve: args and
// result schemas, and for commands `confirm` and `irreversible`.
// `features.ts` lists the modules, so a later story adds a command or read in its own directory
// plus one line there, without editing `commands/` or `reads/`. Modules also add office load steps
// and active-work checks here (DIPO-27), which `office/` runs without knowing the modules, and
// config-reload listeners (DIPO-48), which `office.reloadConfig` calls with the new configuration,
// and story refreshes (DIPO-104), which the executor calls before an unknown story reference fails.

import {
  type Clock,
  type CommandDefinition,
  type IdSource,
  type OfficeId,
  type Origin,
  type ReadDefinition,
  type RequestId,
} from "@dipsaus-orchestrator/contract";
import type { z } from "zod";

import type { NewEntry } from "../changelog/log";
import type { OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import type {
  ActiveWorkCheck,
  LoadStep,
  RegisteredActiveWorkCheck,
  RegisteredLoadStep,
} from "../office/steps";
import type { StoryIdentity } from "../records/story-keys";

/** What an office-level command handler gets. It runs inside the command's write transaction. */
export interface CommandContext {
  readonly office: OfficeHandle;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly requestId: RequestId;
  readonly origin: Origin;
  /** The envelope's `confirmed` (0005 section 9): the client asked the maintainer first. */
  readonly confirmed?: boolean;
  /** The client name its connection gave in `engine.hello` (0005 section 9); absent without one. */
  readonly client?: string;
  /** The time of this command; the facts and entries it writes use it. */
  readonly now: number;
  /** The story references in the args, resolved, by key. The args carry the keys. */
  readonly stories: ReadonlyMap<string, StoryIdentity>;
  /** Appends a change-log entry in this transaction, after the entries emitted so far. */
  emit(entry: NewEntry): void;
}

/** What a software-level command handler gets; it has no office database (0005 section 9). */
export interface SoftwareCommandContext {
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly requestId: RequestId;
  readonly origin: Origin;
  readonly now: number;
}

/** A handler's answer. `changed` defaults to whether any entry was emitted. */
export interface CommandOutcome<R> {
  readonly result: R;
  readonly changed?: boolean;
}

/**
 * Office-level handlers are synchronous: they run inside one immediate transaction, and an await
 * would let other offices' writes interleave (0007 section 1). Effects that take time arrive later
 * as events (0005 section 1). Throw `CommandError` for a command-specific error.
 */
export type OfficeCommandHandler<A, R> = (ctx: CommandContext, args: A) => CommandOutcome<R>;

/**
 * What a waiting office-level handler gets (DIPO-48). Its story references resolve and its retry
 * check runs in one transaction first; the handler then runs outside any transaction and writes
 * each fact with its entries through `commit`, one immediate transaction per call.
 */
export interface AsyncCommandContext extends Omit<CommandContext, "emit"> {
  /** Runs `fn` in one immediate transaction and appends the entries it returns. */
  commit(fn: () => readonly NewEntry[] | void): void;
}

/**
 * An office-level handler that waits on git, the Backlog CLI or a claim (`work.run`). The command's
 * request record is written after it resolves; a handler that throws leaves no record, but the
 * facts it committed before the throw stay, so each must be idempotent under a re-run of the
 * handler (see `runAsyncOfficeCommand` in `execute.ts`).
 */
export type AsyncOfficeCommandHandler<A, R> = (
  ctx: AsyncCommandContext,
  args: A,
) => Promise<CommandOutcome<R>>;

export interface AsyncOfficeCommandRegistration<D extends CommandDefinition> {
  readonly definition: D;
  readonly handle: AsyncOfficeCommandHandler<z.output<D["args"]>, z.input<D["result"]>>;
}

/** What a config-reload listener gets after `office.reloadConfig` read a valid configuration. */
export interface ConfigReloadContext {
  readonly officeId: OfficeId;
  readonly office: OfficeHandle;
  readonly config: OfficeConfig;
}

export type ConfigReloadListener = (ctx: ConfigReloadContext) => void;

export interface RegisteredConfigReload {
  readonly module: string;
  readonly name: string;
  readonly listen: ConfigReloadListener;
}

/**
 * Brings an office's stories up to date with its remote base (DIPO-104): the executor calls it
 * once when an office command names a story the office does not know, then resolves again, so a
 * story merged to the base since the last poll is found. It never throws.
 */
export type StoryRefresh = (office: OfficeId) => Promise<void>;

export interface RegisteredStoryRefresh {
  readonly module: string;
  readonly name: string;
  readonly refresh: StoryRefresh;
}

/** Software-level handlers write no office facts, so they may wait (for git, for example). */
export type SoftwareCommandHandler<A, R> = (
  ctx: SoftwareCommandContext,
  args: A,
) => CommandOutcome<R> | Promise<CommandOutcome<R>>;

export interface OfficeCommandRegistration<D extends CommandDefinition> {
  readonly definition: D;
  readonly handle: OfficeCommandHandler<z.output<D["args"]>, z.input<D["result"]>>;
}

export interface SoftwareCommandRegistration<D extends CommandDefinition> {
  readonly definition: D;
  readonly handle: SoftwareCommandHandler<z.output<D["args"]>, z.input<D["result"]>>;
}

/** What a read handler gets (0005 section 7). */
export interface ReadContext {
  readonly clock: Clock;
  readonly requestId: RequestId;
  /**
   * Present when the args name an office. A synchronous read then runs in one deferred
   * transaction. An async read (`addAsyncRead`) gets the handle after that transaction, in which
   * only its story references resolved, so its own database reads are not one snapshot.
   */
  readonly office?: OfficeHandle;
  /** The story references in the args, resolved, by key. */
  readonly stories: ReadonlyMap<string, StoryIdentity>;
  /** Everything registered, for `commands.describe`. */
  readonly registry: Registry;
}

/** Synchronous: an office read runs inside one deferred transaction (0005 section 8). */
export type ReadHandler<A, R> = (ctx: ReadContext, args: A) => R;

export interface ReadRegistration<D extends ReadDefinition> {
  readonly definition: D;
  readonly handle: ReadHandler<z.output<D["args"]>, z.input<D["result"]>>;
  /**
   * The answer of an office read while its office is loading (DIPO-380): the executor gives it
   * instead of waiting for the load. Absent, the read waits for the load like any other.
   */
  readonly whileLoading?: (office: OfficeId, nowMs: number) => z.input<D["result"]>;
}

/**
 * A read that waits on something outside the database, such as the Backlog CLI (DIPO-71). It
 * changes no facts. Its story references resolve in one deferred transaction first; the handler
 * then runs outside any transaction, so two database reads it makes need not match one point in
 * time. A snapshot read stays synchronous.
 */
export type AsyncReadHandler<A, R> = (ctx: ReadContext, args: A) => Promise<R>;

export interface AsyncReadRegistration<D extends ReadDefinition> {
  readonly definition: D;
  readonly handle: AsyncReadHandler<z.output<D["args"]>, z.input<D["result"]>>;
}

/** The registry as a feature module's `register` sees it. */
export interface FeatureRegistry {
  addOfficeCommand<D extends CommandDefinition>(registration: OfficeCommandRegistration<D>): void;
  addSoftwareCommand<D extends CommandDefinition>(
    registration: SoftwareCommandRegistration<D>,
  ): void;
  addRead<D extends ReadDefinition>(registration: ReadRegistration<D>): void;
  /** A read whose handler waits; see `AsyncReadHandler`. */
  addAsyncRead<D extends ReadDefinition>(registration: AsyncReadRegistration<D>): void;
  /** A step every office load runs, after the steps registered before it (DIPO-27). */
  registerLoadStep(name: string, run: LoadStep): void;
  /** A check `office.forget` asks; any that reports work refuses with `office.busy`. */
  registerActiveWorkCheck(name: string, check: ActiveWorkCheck): void;
  /** An office-level command whose handler waits; see `AsyncOfficeCommandHandler`. */
  addAsyncOfficeCommand<D extends CommandDefinition>(
    registration: AsyncOfficeCommandRegistration<D>,
  ): void;
  /** Called after `office.reloadConfig` read a valid configuration of a loaded office (DIPO-48). */
  registerConfigReload(name: string, listen: ConfigReloadListener): void;
  /** Called when an office command names a story the office does not know (DIPO-104). */
  registerStoryRefresh(name: string, refresh: StoryRefresh): void;
}

/** A feature module listed in `features.ts`. */
export interface FeatureModule {
  /** Shown when two modules register the same name. */
  readonly name: string;
  register(registry: FeatureRegistry): void;
}

export type RegisteredCommand =
  | {
      readonly module: string;
      readonly level: "office";
      readonly definition: CommandDefinition;
      readonly waits: false;
      readonly handle: OfficeCommandHandler<unknown, unknown>;
    }
  | {
      readonly module: string;
      readonly level: "office";
      readonly definition: CommandDefinition;
      readonly waits: true;
      readonly handle: AsyncOfficeCommandHandler<unknown, unknown>;
    }
  | {
      readonly module: string;
      readonly level: "software";
      readonly definition: CommandDefinition;
      readonly handle: SoftwareCommandHandler<unknown, unknown>;
    };

export type RegisteredRead =
  | {
      readonly module: string;
      readonly definition: ReadDefinition;
      readonly waits: false;
      readonly handle: ReadHandler<unknown, unknown>;
      readonly whileLoading?: (office: OfficeId, nowMs: number) => unknown;
    }
  | {
      readonly module: string;
      readonly definition: ReadDefinition;
      readonly waits: true;
      readonly handle: AsyncReadHandler<unknown, unknown>;
      readonly whileLoading?: (office: OfficeId, nowMs: number) => unknown;
    };

/** A command or read name registered by two modules; startup fails naming both. */
export class DuplicateRegistrationError extends Error {
  constructor(
    readonly kind:
      | "command"
      | "read"
      | "load step"
      | "active-work check"
      | "config reload"
      | "story refresh",
    readonly registeredName: string,
    readonly modules: readonly [string, string],
  ) {
    super(
      `The ${kind} ${registeredName} is registered by both ${modules[0]} and ${modules[1]}; each name belongs to one feature module.`,
    );
    this.name = "DuplicateRegistrationError";
  }
}

/** A registration that breaks a contract rule; startup fails naming the module. */
export class InvalidRegistrationError extends Error {
  constructor(module: string, registeredName: string, problem: string) {
    super(`${module} registers ${registeredName}, which ${problem}.`);
    this.name = "InvalidRegistrationError";
  }
}

export class Registry {
  readonly #commands = new Map<string, RegisteredCommand>();
  readonly #reads = new Map<string, RegisteredRead>();
  readonly #loadSteps = new Map<string, RegisteredLoadStep>();
  readonly #activeWorkChecks = new Map<string, RegisteredActiveWorkCheck>();
  readonly #configReloads = new Map<string, RegisteredConfigReload>();
  readonly #storyRefreshes = new Map<string, RegisteredStoryRefresh>();

  /** Story refreshes, in registration order. */
  storyRefreshes(): RegisteredStoryRefresh[] {
    return [...this.#storyRefreshes.values()];
  }

  /** Config-reload listeners, in registration order. */
  configReloads(): RegisteredConfigReload[] {
    return [...this.#configReloads.values()];
  }

  /** Office load steps, in registration order. */
  loadSteps(): RegisteredLoadStep[] {
    return [...this.#loadSteps.values()];
  }

  /** Active-work checks, in registration order. */
  activeWorkChecks(): RegisteredActiveWorkCheck[] {
    return [...this.#activeWorkChecks.values()];
  }

  command(name: string): RegisteredCommand | undefined {
    return this.#commands.get(name);
  }

  read(name: string): RegisteredRead | undefined {
    return this.#reads.get(name);
  }

  /** Registered command definitions, in registration order. */
  commandDefinitions(): CommandDefinition[] {
    return [...this.#commands.values()].map((entry) => entry.definition);
  }

  /** Registered read definitions, in registration order. */
  readDefinitions(): ReadDefinition[] {
    return [...this.#reads.values()].map((entry) => entry.definition);
  }

  /** Runs `feature.register` with a view of this registry that records the module's name. */
  load(feature: FeatureModule): void {
    const module = feature.name;
    const addCommand = (entry: RegisteredCommand): void => {
      const { definition } = entry;
      if (definition.level !== entry.level) {
        throw new InvalidRegistrationError(
          module,
          definition.name,
          `is a ${definition.level}-level command registered as ${entry.level}-level`,
        );
      }
      const existing = this.#commands.get(definition.name);
      if (existing !== undefined) {
        throw new DuplicateRegistrationError("command", definition.name, [existing.module, module]);
      }
      this.#commands.set(definition.name, entry);
    };
    const addRead = (entry: RegisteredRead): void => {
      const { definition } = entry;
      const existing = this.#reads.get(definition.name);
      if (existing !== undefined) {
        throw new DuplicateRegistrationError("read", definition.name, [existing.module, module]);
      }
      this.#reads.set(definition.name, entry);
    };
    feature.register({
      addOfficeCommand: ({ definition, handle }) =>
        addCommand({
          module,
          level: "office",
          definition,
          waits: false,
          handle: handle as OfficeCommandHandler<unknown, unknown>,
        }),
      addAsyncOfficeCommand: ({ definition, handle }) =>
        addCommand({
          module,
          level: "office",
          definition,
          waits: true,
          handle: handle as AsyncOfficeCommandHandler<unknown, unknown>,
        }),
      addSoftwareCommand: ({ definition, handle }) =>
        addCommand({
          module,
          level: "software",
          definition,
          handle: handle as SoftwareCommandHandler<unknown, unknown>,
        }),
      addRead: ({ definition, handle, whileLoading }) =>
        addRead({
          module,
          definition,
          waits: false,
          handle: handle as ReadHandler<unknown, unknown>,
          ...(whileLoading === undefined
            ? {}
            : { whileLoading: whileLoading as (office: OfficeId, nowMs: number) => unknown }),
        }),
      addAsyncRead: ({ definition, handle }) =>
        addRead({
          module,
          definition,
          waits: true,
          handle: handle as AsyncReadHandler<unknown, unknown>,
        }),
      registerLoadStep: (name, run) => {
        const existing = this.#loadSteps.get(name);
        if (existing !== undefined) {
          throw new DuplicateRegistrationError("load step", name, [existing.module, module]);
        }
        this.#loadSteps.set(name, { module, name, run });
      },
      registerActiveWorkCheck: (name, check) => {
        const existing = this.#activeWorkChecks.get(name);
        if (existing !== undefined) {
          throw new DuplicateRegistrationError("active-work check", name, [
            existing.module,
            module,
          ]);
        }
        this.#activeWorkChecks.set(name, { module, name, check });
      },
      registerConfigReload: (name, listen) => {
        const existing = this.#configReloads.get(name);
        if (existing !== undefined) {
          throw new DuplicateRegistrationError("config reload", name, [existing.module, module]);
        }
        this.#configReloads.set(name, { module, name, listen });
      },
      registerStoryRefresh: (name, refresh) => {
        const existing = this.#storyRefreshes.get(name);
        if (existing !== undefined) {
          throw new DuplicateRegistrationError("story refresh", name, [existing.module, module]);
        }
        this.#storyRefreshes.set(name, { module, name, refresh });
      },
    });
  }
}

/** Builds the registry from feature modules, in order; throws on a duplicate or invalid name. */
export function buildRegistry(features: readonly FeatureModule[]): Registry {
  const registry = new Registry();
  for (const feature of features) registry.load(feature);
  return registry;
}
