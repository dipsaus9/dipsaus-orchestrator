// Loads an office's configuration (0017 section 5): parse each file as one YAML document, check
// its version, validate it strictly against that version's schema, migrate it in memory to the
// newest version (`migrateOfficeDocument`), merge defaults < `.dipo/office.yaml` < allowed keys of
// `.dipo/office.local.yaml` < command flags, and hash the result. A local
// `sandbox.toolchainReadPaths` adds to the list below it instead of replacing it (DIPO-172). Errors are values, never thrown,
// so the office (DIPO-27) can keep its previous configuration.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  checkConfigDocument,
  configError,
  configIssueErrors,
  type ConfigError,
} from "@dipsaus-orchestrator/contract";
import type { z } from "zod";

import { parseYamlDocument } from "../platform/yaml";
import { valueAt, valueKeyPaths } from "./keys";
import { configHash, mergeLayer } from "./merge";
import {
  LOCAL_ALLOWED_KEY_PATHS,
  LOCAL_ONLY_KEYS,
  migrateOfficeDocument,
  OFFICE_CONFIG_VERSION,
  OFFICE_DEFAULTS,
  OFFICE_FILE_SCHEMAS,
  OFFICE_LOCAL_FILE_SCHEMAS,
  OfficeConfigV5,
  OfficeOverridesV5,
  type OfficeConfig,
  type OfficeConfigVersion,
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

export type OfficeConfigResult =
  | {
      readonly ok: true;
      readonly config: OfficeConfig;
      /** sha256 over the canonical JSON of `config` (stored as `runs.config_hash`, 0007). */
      readonly configHash: string;
      /** Leaf key paths set by `.dipo/office.local.yaml`, sorted. */
      readonly localOverrideKeys: readonly string[];
    }
  | { readonly ok: false; readonly errors: readonly ConfigError[] };

/** The raw inputs of one load. An absent file is `undefined`. */
export interface OfficeConfigSources {
  readonly office?: string | undefined;
  readonly local?: string | undefined;
  /** Overrides from flags on a single command, shaped like `office.yaml` without `version`. */
  readonly flags?: unknown;
}

// The version that adds each key path, for the hint on an unknown key in an older office file.
const KEY_ADDED_IN: Readonly<Record<string, OfficeConfigVersion>> = {
  "worker.plugins": 2,
  mergeSlot: 3,
  review: 5,
  "mergeSlot.autoMerge": 5,
  "mergeSlot.conflictAttempts": 5,
  "mergeSlot.ciAttempts": 5,
  "mergeSlot.holdLabels": 5,
  "mergeSlot.checksWaitMinutes": 5,
};

// The same for `office.local.yaml`: version 4 lets it set `sandbox.toolchainReadPaths` (DIPO-172).
const LOCAL_SANDBOX_KEY = "sandbox.toolchainReadPaths";
const LOCAL_KEY_ADDED_IN: Readonly<Record<string, OfficeConfigVersion>> = { sandbox: 4 };
// What the hint says the version adds, for a key path whose name alone does not say it.
const ADDS: Readonly<Record<string, string>> = {
  sandbox: `${LOCAL_SANDBOX_KEY} to ${OFFICE_LOCAL_FILE}`,
};

// What `office.local.yaml` of `version` accepts besides `version`, as key paths.
function localAcceptedPaths(version: OfficeConfigVersion): readonly string[] {
  return version >= 4
    ? LOCAL_ALLOWED_KEY_PATHS
    : LOCAL_ALLOWED_KEY_PATHS.filter((path) => path !== LOCAL_SANDBOX_KEY);
}

// The wording of an unknown key in `office.local.yaml`: at the top level it names the keys the
// file accepts, and under `sandbox` that only `toolchainReadPaths` is accepted there.
function localUnknownKeyProblem(
  parent: readonly PropertyKey[],
  version: OfficeConfigVersion,
): string | undefined {
  if (parent.length === 0) {
    return `unknown key; ${OFFICE_LOCAL_FILE} accepts only version, ${localAcceptedPaths(version).join(", ")}`;
  }
  if (parent.length === 1 && parent[0] === "sandbox") {
    return `unknown key; ${OFFICE_LOCAL_FILE} accepts only ${LOCAL_SANDBOX_KEY} of the sandbox keys; set any other sandbox key in ${OFFICE_FILE}`;
  }
  return undefined;
}

// The contract's wording, except for an unknown key in `office.local.yaml`
// (`localUnknownKeyProblem`), and a key of `KEY_ADDED_IN` (or `LOCAL_KEY_ADDED_IN`) in a file
// older than that key, which says the version that adds it.
function issueErrors(
  file: string,
  schema: z.ZodType,
  input: unknown,
  issues: readonly z.core.$ZodIssue[],
  version: OfficeConfigVersion = OFFICE_CONFIG_VERSION,
): ConfigError[] {
  const local = file === OFFICE_LOCAL_FILE;
  const errors = configIssueErrors(file, schema, input, issues, {
    unknownKeyProblem: (parent) => (local ? localUnknownKeyProblem(parent, version) : undefined),
  });
  const addedIn = local ? LOCAL_KEY_ADDED_IN : KEY_ADDED_IN;
  return errors.map((error) => {
    const added = addedIn[error.path];
    if (added === undefined || version >= added) return error;
    const adds = ADDS[error.path] ?? error.path;
    return configError(
      file,
      error.path,
      error.expected,
      `unknown key in version ${version}; expected ${error.expected}. Version ${added} adds ${adds}: set version: ${added} to use it`,
    );
  });
}

type Checked = { ok: true; value: Record<string, unknown> } | { ok: false; errors: ConfigError[] };
type Read =
  | { ok: true; value: Record<string, unknown>; version: OfficeConfigVersion }
  | { ok: false; errors: ConfigError[] };

function validate(
  file: string,
  schema: z.ZodType,
  input: unknown,
  version?: OfficeConfigVersion,
): Checked {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data as Record<string, unknown> };
  return { ok: false, errors: issueErrors(file, schema, input, parsed.error.issues, version) };
}

// Parses one file and checks its version, the same way as software configuration. Returns the
// mapping to validate and its version.
function readDocument(file: string, text: string): Read {
  const checked = checkConfigDocument(file, parseYamlDocument(text), OFFICE_CONFIG_VERSION);
  if (!checked.ok) return checked;
  return { ok: true, value: checked.document, version: checked.version as OfficeConfigVersion };
}

// A file valid for its own version, migrated to the newest one, without `version`.
function migrated(version: OfficeConfigVersion, value: Record<string, unknown>) {
  return withoutVersion(migrateOfficeDocument(version, value));
}

// `privacy.*` and `retention.*` are machine-local (0007 amendment): in `office.yaml` each key is
// an error pointing to the local file, and the rest of the file is still validated.
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

// One layer of the merge: the configuration below it in, the configuration with it on top out.
type Layer = (base: unknown) => unknown;

// A layer whose mappings merge per key and whose lists and scalars replace (`mergeLayer`).
function over(value: Record<string, unknown>): Layer {
  return (base) => mergeLayer(base, value);
}

// The `office.local.yaml` layer: as `over`, except that `sandbox.toolchainReadPaths` adds its
// entries to the list below it (the committed list or the default), each path once, instead of
// replacing it (0017 amendment of 2026-10-18, maintainer decision 2026-10-17, option A).
function localLayer(local: Record<string, unknown>): Layer {
  const added = valueAt(local, ["sandbox", "toolchainReadPaths"]);
  if (!Array.isArray(added)) return over(local);
  const { sandbox: _sandbox, ...rest } = local;
  return (base) => {
    const merged = mergeLayer(base, rest);
    const below = valueAt(merged, ["sandbox", "toolchainReadPaths"]);
    const paths = [...new Set([...(Array.isArray(below) ? below : []), ...added])];
    return mergeLayer(merged, { sandbox: { toolchainReadPaths: paths } });
  };
}

/** Validates and merges configuration sources. Pure; never throws for bad input. */
export function resolveOfficeConfig(sources: OfficeConfigSources): OfficeConfigResult {
  const errors: ConfigError[] = [];
  const layers: Layer[] = [];

  if (sources.office !== undefined) {
    const read = readDocument(OFFICE_FILE, sources.office);
    if (!read.ok) {
      errors.push(...read.errors);
    } else {
      const { rest, errors: localOnly } = splitLocalOnly(read.value);
      errors.push(...localOnly);
      const checked = validate(OFFICE_FILE, OFFICE_FILE_SCHEMAS[read.version], rest, read.version);
      if (checked.ok) layers.push(over(migrated(read.version, checked.value)));
      else errors.push(...checked.errors);
    }
  }

  let localKeys: string[] = [];
  if (sources.local !== undefined) {
    const read = readDocument(OFFICE_LOCAL_FILE, sources.local);
    if (!read.ok) {
      errors.push(...read.errors);
    } else {
      const checked = validate(
        OFFICE_LOCAL_FILE,
        OFFICE_LOCAL_FILE_SCHEMAS[read.version],
        read.value,
        read.version,
      );
      if (checked.ok) {
        const local = migrated(read.version, checked.value);
        layers.push(localLayer(local));
        localKeys = valueKeyPaths(local).toSorted();
      } else {
        errors.push(...checked.errors);
      }
    }
  }

  if (sources.flags !== undefined) {
    const checked = validate(FLAGS_SOURCE, OfficeOverridesV5, sources.flags);
    if (checked.ok) layers.push(over(checked.value));
    else errors.push(...checked.errors);
  }

  if (errors.length > 0) return { ok: false, errors };

  const merged = layers.reduce<unknown>((base, layer) => layer(base), OFFICE_DEFAULTS);
  const effective = validate(EFFECTIVE_SOURCE, OfficeConfigV5, merged);
  if (!effective.ok) return { ok: false, errors: effective.errors };
  const config = effective.value as OfficeConfig;
  return { ok: true, config, configHash: configHash(config), localOverrideKeys: localKeys };
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
 * layer (office init writes no `office.yaml`, DIPO-15 D9). Never throws for a bad file.
 */
export async function loadOfficeConfig(
  dir: string,
  options: { readonly flags?: unknown } = {},
): Promise<OfficeConfigResult> {
  const [office, local] = await Promise.all([
    readOptional(dir, OFFICE_FILE),
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
