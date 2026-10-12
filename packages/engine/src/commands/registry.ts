// The registry of commands and reads (M0 review, DIPO-15). Each feature module exports
// `register(registry)`, which adds its handlers next to the contract definition they serve: args and
// result schemas, `since` or `provisional`, and for commands `confirm` and `irreversible`.
// `features.ts` lists the modules, so a later story adds a command or read in its own directory
// plus one line there, without editing `commands/` or `reads/`.

import {
  checkVersioning,
  type Clock,
  type CommandDefinition,
  type IdSource,
  type Origin,
  type ReadDefinition,
  type RequestId,
} from "@dipsaus-orchestrator/contract";

import type { NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import type { StoryIdentity } from "../stories/keys";

/** The parsed type of a contract schema (zod's `output`, without importing zod here). */
export type SchemaOutput<S> = S extends { _zod: { output: infer O } } ? O : unknown;
/** What a handler may return for a result schema (zod's `input`). */
export type SchemaInput<S> = S extends { _zod: { input: infer I } } ? I : unknown;

/** What an office-level command handler gets. It runs inside the command's write transaction. */
export interface CommandContext {
  readonly office: OfficeHandle;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly requestId: RequestId;
  readonly origin: Origin;
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

/** Software-level handlers write no office facts, so they may wait (for git, for example). */
export type SoftwareCommandHandler<A, R> = (
  ctx: SoftwareCommandContext,
  args: A,
) => CommandOutcome<R> | Promise<CommandOutcome<R>>;

export interface OfficeCommandRegistration<D extends CommandDefinition> {
  readonly definition: D;
  readonly handle: OfficeCommandHandler<SchemaOutput<D["args"]>, SchemaInput<D["result"]>>;
}

export interface SoftwareCommandRegistration<D extends CommandDefinition> {
  readonly definition: D;
  readonly handle: SoftwareCommandHandler<SchemaOutput<D["args"]>, SchemaInput<D["result"]>>;
}

/** What a read handler gets (0005 section 7). */
export interface ReadContext {
  readonly clock: Clock;
  readonly requestId: RequestId;
  /** Present when the args name an office; the read then runs in one deferred transaction. */
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
  readonly handle: ReadHandler<SchemaOutput<D["args"]>, SchemaInput<D["result"]>>;
}

/** The registry as a feature module's `register` sees it. */
export interface FeatureRegistry {
  addOfficeCommand<D extends CommandDefinition>(registration: OfficeCommandRegistration<D>): void;
  addSoftwareCommand<D extends CommandDefinition>(
    registration: SoftwareCommandRegistration<D>,
  ): void;
  addRead<D extends ReadDefinition>(registration: ReadRegistration<D>): void;
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
      readonly handle: OfficeCommandHandler<unknown, unknown>;
    }
  | {
      readonly module: string;
      readonly level: "software";
      readonly definition: CommandDefinition;
      readonly handle: SoftwareCommandHandler<unknown, unknown>;
    };

export interface RegisteredRead {
  readonly module: string;
  readonly definition: ReadDefinition;
  readonly handle: ReadHandler<unknown, unknown>;
}

/** A command or read name registered by two modules; startup fails naming both. */
export class DuplicateRegistrationError extends Error {
  constructor(
    readonly kind: "command" | "read",
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
      this.#checkVersioning(module, definition);
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
    feature.register({
      addOfficeCommand: ({ definition, handle }) =>
        addCommand({
          module,
          level: "office",
          definition,
          handle: handle as OfficeCommandHandler<unknown, unknown>,
        }),
      addSoftwareCommand: ({ definition, handle }) =>
        addCommand({
          module,
          level: "software",
          definition,
          handle: handle as SoftwareCommandHandler<unknown, unknown>,
        }),
      addRead: ({ definition, handle }) => {
        this.#checkVersioning(module, definition);
        const existing = this.#reads.get(definition.name);
        if (existing !== undefined) {
          throw new DuplicateRegistrationError("read", definition.name, [existing.module, module]);
        }
        this.#reads.set(definition.name, {
          module,
          definition,
          handle: handle as ReadHandler<unknown, unknown>,
        });
      },
    });
  }

  #checkVersioning(module: string, definition: CommandDefinition | ReadDefinition): void {
    const problem = checkVersioning(definition);
    if (problem !== undefined) throw new InvalidRegistrationError(module, definition.name, problem);
  }
}

/** Builds the registry from feature modules, in order; throws on a duplicate or invalid name. */
export function buildRegistry(features: readonly FeatureModule[]): Registry {
  const registry = new Registry();
  for (const feature of features) registry.load(feature);
  return registry;
}
