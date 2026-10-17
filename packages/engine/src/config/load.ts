// Loads an office's configuration (0017 section 5): parse each file as one YAML document, check
// its version, validate it strictly against that version's schema, migrate it in memory to the
// newest version (`migrateOfficeDocument`), merge defaults < `.dipo/office.yaml` < allowed keys of
// `.dipo/office.local.yaml` < command flags, and hash the result. Errors are values, never thrown,
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
import { valueKeyPaths } from "./keys";
import { configHash, mergeLayer } from "./merge";
import {
  LOCAL_ALLOWED_KEYS,
  LOCAL_ONLY_KEYS,
  migrateOfficeDocument,
  OFFICE_CONFIG_VERSION,
  OFFICE_DEFAULTS,
  OFFICE_FILE_SCHEMAS,
  OFFICE_LOCAL_FILE_SCHEMAS,
  OfficeConfigV3,
  OfficeOverridesV3,
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
};

// The contract's wording, except for an unknown top-level key in `office.local.yaml`, which
// names the keys that file accepts, and a key of `KEY_ADDED_IN` in an office file older than
// that key, which says the version that adds it.
function issueErrors(
  file: string,
  schema: z.ZodType,
  input: unknown,
  issues: readonly z.core.$ZodIssue[],
  version: OfficeConfigVersion = OFFICE_CONFIG_VERSION,
): ConfigError[] {
  const errors = configIssueErrors(file, schema, input, issues, {
    unknownKeyProblem: (parent) =>
      file === OFFICE_LOCAL_FILE && parent.length === 0
        ? `unknown key; ${OFFICE_LOCAL_FILE} accepts only version, ${LOCAL_ALLOWED_KEYS.map((k) => `${k}.*`).join(", ")}`
        : undefined,
  });
  // `office.local.yaml` accepts none of these keys in any version, so it gets no hint.
  if (file === OFFICE_LOCAL_FILE) return errors;
  return errors.map((error) => {
    const added = KEY_ADDED_IN[error.path];
    if (added === undefined || version >= added) return error;
    return configError(
      file,
      error.path,
      error.expected,
      `unknown key in version ${version}; expected ${error.expected}. Version ${added} adds ${error.path}: set version: ${added} to use it`,
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

/** Validates and merges configuration sources. Pure; never throws for bad input. */
export function resolveOfficeConfig(sources: OfficeConfigSources): OfficeConfigResult {
  const errors: ConfigError[] = [];
  const layers: unknown[] = [];

  if (sources.office !== undefined) {
    const read = readDocument(OFFICE_FILE, sources.office);
    if (!read.ok) {
      errors.push(...read.errors);
    } else {
      const { rest, errors: localOnly } = splitLocalOnly(read.value);
      errors.push(...localOnly);
      const checked = validate(OFFICE_FILE, OFFICE_FILE_SCHEMAS[read.version], rest, read.version);
      if (checked.ok) layers.push(migrated(read.version, checked.value));
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
        layers.push(local);
        localKeys = valueKeyPaths(local).toSorted();
      } else {
        errors.push(...checked.errors);
      }
    }
  }

  if (sources.flags !== undefined) {
    const checked = validate(FLAGS_SOURCE, OfficeOverridesV3, sources.flags);
    if (checked.ok) layers.push(checked.value);
    else errors.push(...checked.errors);
  }

  if (errors.length > 0) return { ok: false, errors };

  const merged = layers.reduce<unknown>((base, layer) => mergeLayer(base, layer), OFFICE_DEFAULTS);
  const effective = validate(EFFECTIVE_SOURCE, OfficeConfigV3, merged);
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
