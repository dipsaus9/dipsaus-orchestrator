// Loads an office's configuration (0017 section 5): parse each file as one YAML document, check
// its version, validate it strictly, merge defaults < `.dipo/office.yaml` < allowed keys of
// `.dipo/office.local.yaml` < command flags, and hash the result. Errors are values, never thrown,
// so the office (DIPO-27) can keep its previous configuration.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { z } from "zod";

import { parseYamlDocument } from "../platform/yaml";
import {
  describeSchema,
  describeValue,
  formatPath,
  isMapping,
  knownKeysAt,
  schemaAt,
  valueAt,
  valueKeyPaths,
} from "./keys";
import { configHash, mergeLayer } from "./merge";
import {
  LOCAL_ALLOWED_KEYS,
  LOCAL_ONLY_KEYS,
  OFFICE_CONFIG_VERSION,
  OFFICE_DEFAULTS,
  OfficeConfigV1,
  OfficeFileV1,
  OfficeLocalFileV1,
  OfficeOverridesV1,
  type OfficeConfig,
} from "./schema";

export const OFFICE_FILE = ".dipo/office.yaml";
export const OFFICE_LOCAL_FILE = ".dipo/office.local.yaml";
export const FLAGS_SOURCE = "command flags";
const EFFECTIVE_SOURCE = "effective configuration";

/** One configuration problem: where it is, what was expected, and a full message. */
export interface ConfigError {
  /** `.dipo/office.yaml`, `.dipo/office.local.yaml` or `command flags`. */
  readonly file: string;
  /** Dotted key path, or `(top level)`. */
  readonly path: string;
  /** What the key accepts, for example `integer` or `one of "when-present" | "never"`. */
  readonly expected: string;
  /** `<file>: <path>: <problem>`, ready to show. */
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
    }
  | { readonly ok: false; readonly errors: readonly ConfigError[] };

/** The raw inputs of one load. An absent file is `undefined`. */
export interface OfficeConfigSources {
  readonly office?: string | undefined;
  readonly local?: string | undefined;
  /** Overrides from flags on a single command, shaped like `office.yaml` without `version`. */
  readonly flags?: unknown;
}

function configError(file: string, path: string, expected: string, problem: string): ConfigError {
  return { file, path, expected, message: `${file}: ${path}: ${problem}` };
}

function issueErrors(
  file: string,
  schema: z.ZodType,
  input: unknown,
  issues: readonly z.core.$ZodIssue[],
): ConfigError[] {
  const errors: ConfigError[] = [];
  for (const issue of issues) {
    if (issue.code === "unrecognized_keys") {
      const known = knownKeysAt(schema, issue.path);
      const expected = known.length > 0 ? `one of the keys ${known.join(", ")}` : "no other keys";
      for (const key of issue.keys) {
        const keyPath = formatPath([...issue.path, key]);
        const problem =
          file === OFFICE_LOCAL_FILE && issue.path.length === 0
            ? `unknown key; ${OFFICE_LOCAL_FILE} accepts only version, ${LOCAL_ALLOWED_KEYS.map((k) => `${k}.*`).join(", ")}`
            : `unknown key; expected ${expected}`;
        errors.push(configError(file, keyPath, expected, problem));
      }
      continue;
    }
    const at = schemaAt(schema, issue.path);
    const expected = at === undefined ? issue.message : describeSchema(at);
    const value = valueAt(input, issue.path);
    const got =
      issue.code === "invalid_value" && value !== undefined
        ? JSON.stringify(value)
        : describeValue(value);
    const problem =
      issue.code === "invalid_type" || issue.code === "invalid_value"
        ? `expected ${expected}, got ${got}`
        : `${issue.message} (expected ${expected})`;
    errors.push(configError(file, formatPath(issue.path), expected, problem));
  }
  return errors;
}

type Checked = { ok: true; value: Record<string, unknown> } | { ok: false; errors: ConfigError[] };

function validate(file: string, schema: z.ZodType, input: unknown): Checked {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data as Record<string, unknown> };
  return { ok: false, errors: issueErrors(file, schema, input, parsed.error.issues) };
}

// Parses one file and checks its version. Returns the mapping to validate.
function readDocument(file: string, text: string): Checked {
  const parsed = parseYamlDocument(text);
  if (!parsed.ok) {
    return {
      ok: false,
      errors: [configError(file, "(top level)", "exactly one YAML document", parsed.message)],
    };
  }
  const document = parsed.value ?? {};
  if (!isMapping(document)) {
    return {
      ok: false,
      errors: [
        configError(
          file,
          "(top level)",
          "mapping",
          `expected mapping, got ${describeValue(document)}`,
        ),
      ],
    };
  }
  const version = document["version"];
  if (version === undefined) {
    return {
      ok: false,
      errors: [
        configError(
          file,
          "version",
          "integer",
          "expected integer, got nothing; version is required",
        ),
      ],
    };
  }
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return {
      ok: false,
      errors: [
        configError(file, "version", "integer", `expected integer, got ${describeValue(version)}`),
      ],
    };
  }
  if (version > OFFICE_CONFIG_VERSION) {
    return {
      ok: false,
      errors: [
        configError(
          file,
          "version",
          `integer from 1 to ${OFFICE_CONFIG_VERSION}`,
          `configuration version ${version} is newer than this dipo understands (up to ${OFFICE_CONFIG_VERSION}); upgrade dipo`,
        ),
      ],
    };
  }
  if (version < 1) {
    return {
      ok: false,
      errors: [
        configError(
          file,
          "version",
          `integer from 1 to ${OFFICE_CONFIG_VERSION}`,
          `unknown configuration version ${version}`,
        ),
      ],
    };
  }
  return { ok: true, value: document };
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
      const checked = validate(OFFICE_FILE, OfficeFileV1, rest);
      if (checked.ok) layers.push(withoutVersion(checked.value));
      else errors.push(...checked.errors);
    }
  }

  let localKeys: string[] = [];
  if (sources.local !== undefined) {
    const read = readDocument(OFFICE_LOCAL_FILE, sources.local);
    if (!read.ok) {
      errors.push(...read.errors);
    } else {
      const checked = validate(OFFICE_LOCAL_FILE, OfficeLocalFileV1, read.value);
      if (checked.ok) {
        const local = withoutVersion(checked.value);
        layers.push(local);
        localKeys = valueKeyPaths(local).toSorted();
      } else {
        errors.push(...checked.errors);
      }
    }
  }

  if (sources.flags !== undefined) {
    const checked = validate(FLAGS_SOURCE, OfficeOverridesV1, sources.flags);
    if (checked.ok) layers.push(checked.value);
    else errors.push(...checked.errors);
  }

  if (errors.length > 0) return { ok: false, errors };

  const merged = layers.reduce<unknown>((base, layer) => mergeLayer(base, layer), OFFICE_DEFAULTS);
  const effective = validate(EFFECTIVE_SOURCE, OfficeConfigV1, merged);
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
