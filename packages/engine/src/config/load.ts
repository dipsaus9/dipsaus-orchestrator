// Loads an office's configuration (0017): parse each file as one YAML document, check its version,
// migrate a file of versions 1 to 13 in memory to version 14 (`migrateOfficeDocument`), validate it
// strictly, merge defaults < `.dipo/office.yaml` < allowed keys of `.dipo/office.local.yaml` <
// command flags, and hash the result. Errors are values, never thrown, so the office can keep its
// previous configuration. A retired key that an older file still sets is dropped by the migration
// and returned as a warning; a moved key is read at its new place.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  checkConfigDocument,
  configError,
  configIssueErrors,
  NEWER_DIPO,
  type ConfigError,
} from "@dipsaus-orchestrator/contract";
import type { z } from "zod";

import { parseYamlDocument } from "../platform/yaml";
import { valueKeyPaths } from "./keys";
import { configHash, mergeLayer } from "./merge";
import {
  LOCAL_ALLOWED_KEYS,
  LOCAL_ONLY_KEYS,
  migrateOfficeDocument,
  MOVED_KEYS,
  OFFICE_CONFIG_VERSION,
  OFFICE_DEFAULTS,
  OfficeConfigSchema,
  OfficeFileSchema,
  OfficeLocalFileSchema,
  OfficeOverridesSchema,
  RETIRED_KEYS,
  type MigrationStep,
  type OfficeConfig,
} from "./schema";

export const OFFICE_FILE = ".dipo/office.yaml";
export const OFFICE_LOCAL_FILE = ".dipo/office.local.yaml";
export const FLAGS_SOURCE = "command flags";
const EFFECTIVE_SOURCE = "effective configuration";

/**
 * One configuration problem (the contract's shape, shared with software configuration). `file`
 * is `.dipo/office.yaml`, `.dipo/office.local.yaml` or `command flags`.
 */
export type { ConfigError };

/**
 * Something the maintainer should know about a configuration that still loads, such as a retired
 * key an older file sets. `message` starts with the file and the key path, like a `ConfigError`.
 */
export interface ConfigWarning {
  readonly file: string;
  readonly path: string;
  readonly message: string;
}

export type OfficeConfigResult =
  | {
      readonly ok: true;
      readonly config: OfficeConfig;
      /** sha256 over the canonical JSON of `config` (stored as `runs.config_hash`, 0007). */
      readonly configHash: string;
      /** Leaf key paths set by `.dipo/office.local.yaml`, sorted. */
      readonly localOverrideKeys: readonly string[];
      /** What loaded but deserves a look; the office shows each as an `engine.notice`. */
      readonly warnings: readonly ConfigWarning[];
    }
  | { readonly ok: false; readonly errors: readonly ConfigError[] };

/** The raw inputs of one load. An absent file is `undefined`. */
export interface OfficeConfigSources {
  readonly office?: string | undefined;
  readonly local?: string | undefined;
  /** Overrides from flags on a single command, shaped like `office.yaml` without `version`. */
  readonly flags?: unknown;
}

// Why a version 14 file may not set `path` that an earlier version had: it moved or was retired.
function formerKey(path: string): string | undefined {
  const moved = MOVED_KEYS.find((key) => key.from === path);
  if (moved !== undefined) return `version 14 moved it to ${moved.to}; set it there`;
  const retired = RETIRED_KEYS.find((key) => path === key.path || path.startsWith(`${key.path}.`));
  if (retired !== undefined) {
    return `version 14 removed ${retired.path}, because ${retired.reason}. Delete it`;
  }
  return undefined;
}

// The contract's wording, with the keys `office.local.yaml` accepts at its top level, and the
// reason for a key version 14 moved or retired.
function issueErrors(
  file: string,
  schema: z.ZodType,
  input: unknown,
  issues: readonly z.core.$ZodIssue[],
): ConfigError[] {
  const local = file === OFFICE_LOCAL_FILE;
  const accepted = LOCAL_ALLOWED_KEYS.map((key) => `${key}.*`).join(", ");
  const errors = configIssueErrors(file, schema, input, issues, {
    unknownKeyProblem: (parent) =>
      local && parent.length === 0
        ? `unknown key; ${OFFICE_LOCAL_FILE} accepts only version, ${accepted}; ${NEWER_DIPO}`
        : undefined,
  });
  return errors.map((error) => {
    if (!error.message.endsWith(NEWER_DIPO)) return error;
    const former = formerKey(error.path);
    return former === undefined
      ? error
      : configError(file, error.path, error.expected, `unknown key; ${former}`);
  });
}

export type Checked =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; errors: ConfigError[] };
export type Read =
  | { ok: true; value: Record<string, unknown>; version: number }
  | { ok: false; errors: ConfigError[] };
export type CheckedFile =
  | { ok: true; value: Record<string, unknown>; warnings: ConfigWarning[] }
  | { ok: false; errors: ConfigError[] };

export function validate(file: string, schema: z.ZodType, input: unknown): Checked {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data as Record<string, unknown> };
  return { ok: false, errors: issueErrors(file, schema, input, parsed.error.issues) };
}

// Parses one file and checks its version, the same way as software configuration. Returns the
// mapping and its version.
export function readDocument(file: string, text: string): Read {
  const checked = checkConfigDocument(file, parseYamlDocument(text), OFFICE_CONFIG_VERSION);
  if (!checked.ok) return checked;
  return { ok: true, value: checked.document, version: checked.version };
}

/** The warning of one migration step: where a key moved, or a dropped key by name and why. */
export function migrationWarning(file: string, step: MigrationStep): ConfigWarning {
  if (step.kind === "move") {
    const from = step.from.join(".");
    const to = step.to.join(".");
    return {
      file,
      path: from,
      message: `${file}: ${from}: read as ${to}, its place since version 14; dipo config migrate moves it`,
    };
  }
  const path = step.path.join(".");
  return {
    file,
    path,
    message: `${file}: ${path}: ignored; version 14 removed it, because ${step.reason}. dipo config migrate deletes it`,
  };
}

/**
 * A file's document validated as version 14: migrated first when it is older, with a warning for
 * each key the migration moved or dropped. The value has no `version`.
 */
export function checkedFile(
  file: string,
  schema: z.ZodType,
  read: { readonly value: Record<string, unknown>; readonly version: number },
): CheckedFile {
  const migration = migrateOfficeDocument(read.version, read.value);
  const checked = validate(file, schema, migration.document);
  if (!checked.ok) return checked;
  return {
    ok: true,
    value: withoutVersion(checked.value),
    warnings: migration.steps.map((step) => migrationWarning(file, step)),
  };
}

// `privacy.*` and `retention.*` are machine-local (0007): in `office.yaml` each key is an error
// pointing to the local file, and the rest of the file is still validated.
function splitLocalOnly(document: Record<string, unknown>): {
  rest: Record<string, unknown>;
  errors: ConfigError[];
} {
  const rest: Record<string, unknown> = { ...document };
  const errors: ConfigError[] = [];
  for (const key of LOCAL_ONLY_KEYS) {
    if (!(key in rest)) continue;
    const paths = valueKeyPaths(rest[key], key);
    for (const path of paths.length > 0 ? paths : [key]) {
      errors.push(
        configError(
          OFFICE_FILE,
          path,
          `key in ${OFFICE_LOCAL_FILE}`,
          `${key}.* is machine-local and accepted only in ${OFFICE_LOCAL_FILE}; move it there`,
        ),
      );
    }
    delete rest[key];
  }
  return { rest, errors };
}

function withoutVersion(value: Record<string, unknown>): Record<string, unknown> {
  const { version: _version, ...rest } = value;
  return rest;
}

/** Validates and merges configuration sources. Pure; never throws for bad input. */
export function resolveOfficeConfig(sources: OfficeConfigSources): OfficeConfigResult {
  const errors: ConfigError[] = [];
  const warnings: ConfigWarning[] = [];
  const layers: Record<string, unknown>[] = [];

  if (sources.office !== undefined) {
    const read = readDocument(OFFICE_FILE, sources.office);
    if (!read.ok) {
      errors.push(...read.errors);
    } else {
      const { rest, errors: localOnly } = splitLocalOnly(read.value);
      errors.push(...localOnly);
      const checked = checkedFile(OFFICE_FILE, OfficeFileSchema, { ...read, value: rest });
      if (checked.ok) {
        warnings.push(...checked.warnings);
        layers.push(checked.value);
      } else {
        errors.push(...checked.errors);
      }
    }
  }

  let localKeys: string[] = [];
  if (sources.local !== undefined) {
    const read = readDocument(OFFICE_LOCAL_FILE, sources.local);
    if (!read.ok) {
      errors.push(...read.errors);
    } else {
      const checked = checkedFile(OFFICE_LOCAL_FILE, OfficeLocalFileSchema, read);
      if (checked.ok) {
        warnings.push(...checked.warnings);
        layers.push(checked.value);
        localKeys = valueKeyPaths(checked.value).toSorted();
      } else {
        errors.push(...checked.errors);
      }
    }
  }

  if (sources.flags !== undefined) {
    const checked = validate(FLAGS_SOURCE, OfficeOverridesSchema, sources.flags);
    if (checked.ok) layers.push(checked.value);
    else errors.push(...checked.errors);
  }

  if (errors.length > 0) return { ok: false, errors };

  // Mappings merge per key; lists and scalars replace (`mergeLayer`).
  const merged = layers.reduce<unknown>((base, layer) => mergeLayer(base, layer), OFFICE_DEFAULTS);
  const effective = validate(EFFECTIVE_SOURCE, OfficeConfigSchema, merged);
  if (!effective.ok) return { ok: false, errors: effective.errors };
  const config = effective.value as OfficeConfig;
  return {
    ok: true,
    config,
    configHash: configHash(config),
    localOverrideKeys: localKeys,
    warnings,
  };
}

async function readOptional(dir: string, file: string): Promise<string | undefined | ConfigError> {
  try {
    return await readFile(join(dir, file), "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    const reason = error instanceof Error ? error.message : String(error);
    return configError(file, "(top level)", "readable file", `cannot read the file: ${reason}`);
  }
}

/**
 * Loads `<dir>/.dipo/office.yaml` and `<dir>/.dipo/office.local.yaml`. A missing file is no
 * layer (office init writes no `office.yaml`). Never throws for a bad file. `office` replaces the
 * `office.yaml` under `dir` with a text read elsewhere, such as the file as committed on the base;
 * its `text` is undefined when that file does not exist.
 */
export async function loadOfficeConfig(
  dir: string,
  options: {
    readonly flags?: unknown;
    readonly office?: { readonly text: string | undefined };
  } = {},
): Promise<OfficeConfigResult> {
  const [office, local] = await Promise.all([
    options.office === undefined ? readOptional(dir, OFFICE_FILE) : options.office.text,
    readOptional(dir, OFFICE_LOCAL_FILE),
  ]);
  const readErrors = [office, local].filter(
    (value): value is ConfigError => typeof value === "object",
  );
  if (readErrors.length > 0) return { ok: false, errors: readErrors };
  return resolveOfficeConfig({
    office: office as string | undefined,
    local: local as string | undefined,
    flags: options.flags,
  });
}
