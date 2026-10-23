// Software-level configuration, `<state>/config.yaml` (0006 and 0017 amendments of 2026-10-12):
// one strict, versioned zod schema that the daemon and every client validate with. The contract
// has no I/O, so each side reads the file and hands its YAML parser in: the engine through
// `platform/yaml.ts`, clients through `client/node`.

import { z } from "zod";

import {
  describeSchema,
  describeValue,
  formatPath,
  isMapping,
  knownKeysAt,
  schemaAt,
  valueAt,
} from "./config-keys";

/** One configuration problem: where it is, what was expected, and a full message. */
export interface ConfigError {
  /** The file the problem is in, as the reader names it. */
  readonly file: string;
  /** Dotted key path, or `(top level)`. */
  readonly path: string;
  /** What the key accepts, for example `boolean` or `integer`. */
  readonly expected: string;
  /** `<file>: <path>: <problem>`, ready to show. */
  readonly message: string;
}

/** `ConfigError` as a schema, for replies that carry configuration problems. */
export const ConfigErrorData = z.object({
  file: z.string(),
  path: z.string(),
  expected: z.string(),
  message: z.string(),
}) satisfies z.ZodType<ConfigError>;

export function configError(
  file: string,
  path: string,
  expected: string,
  problem: string,
): ConfigError {
  return { file, path, expected, message: `${file}: ${path}: ${problem}` };
}

// YAML documents

export type YamlParseResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string };

/** A YAML 1.2 parser that throws on invalid input and returns an array for several documents. */
export type YamlParser = (text: string) => unknown;

// A line that starts a document (`---`) or ends one (`...`), with optional trailing content.
const DOCUMENT_START = /^---(?:\s|$)/;
const DOCUMENT_END = /^\.\.\.(?:\s|$)/;

function isContentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed !== "" && !trimmed.startsWith("#") && !line.startsWith("%");
}

// The parser returns an array both for a file with several documents and for one document whose
// top level is a sequence. Markers decide: a `---` after content or after another `---`, or
// content after `...`, starts a second document. Markers at column 0 are never part of a block
// scalar.
function hasSecondDocument(text: string): boolean {
  let seenContent = false;
  let seenStart = false;
  let ended = false;
  for (const line of text.split(/\r?\n/)) {
    if (DOCUMENT_START.test(line)) {
      if (seenContent || seenStart) return true;
      seenStart = true;
      continue;
    }
    if (DOCUMENT_END.test(line)) {
      if (seenContent) ended = true;
      continue;
    }
    if (isContentLine(line)) {
      if (ended) return true;
      seenContent = true;
    }
  }
  return false;
}

/**
 * Parses `text` as exactly one YAML document with `parse` (0017 section 5). Never throws. Each
 * side passes its own parser, so the one rule holds for the engine and for `client/node`.
 */
export function parseSingleYamlDocument(parse: YamlParser, text: string): YamlParseResult {
  let value: unknown;
  try {
    value = parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `invalid YAML: ${message}` };
  }
  if (Array.isArray(value) && hasSecondDocument(text)) {
    return {
      ok: false,
      message: "holds more than one YAML document; a configuration file holds exactly one",
    };
  }
  return { ok: true, value };
}

// Validation

/**
 * Words the problem of an unknown key. `parent` is the path of the mapping that holds the key and
 * `expected` the default wording's expected keys. Undefined keeps the default wording.
 */
export type UnknownKeyProblem = (
  parent: readonly PropertyKey[],
  expected: string,
) => string | undefined;

/** Turns zod issues into configuration errors that name the file, the key path and the type. */
export function configIssueErrors(
  file: string,
  schema: z.ZodType,
  input: unknown,
  issues: readonly z.core.$ZodIssue[],
  options: { readonly unknownKeyProblem?: UnknownKeyProblem } = {},
): ConfigError[] {
  const errors: ConfigError[] = [];
  for (const issue of issues) {
    if (issue.code === "unrecognized_keys") {
      const known = knownKeysAt(schema, issue.path);
      const expected = known.length > 0 ? `one of the keys ${known.join(", ")}` : "no other keys";
      const problem =
        options.unknownKeyProblem?.(issue.path, expected) ?? `unknown key; expected ${expected}`;
      for (const key of issue.keys) {
        errors.push(configError(file, formatPath([...issue.path, key]), expected, problem));
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

/**
 * Checks that a parsed configuration file is a mapping with an integer `version` this binary
 * knows. A newer `version` is refused with "upgrade dipo" (0017 section 5), never guessed.
 */
export function checkConfigDocument(
  file: string,
  parsed: YamlParseResult,
  latestVersion: number,
):
  | { ok: true; document: Record<string, unknown>; version: number }
  | { ok: false; errors: ConfigError[] } {
  if (!parsed.ok) {
    return {
      ok: false,
      errors: [configError(file, "(top level)", "exactly one YAML document", parsed.message)],
    };
  }
  const document = parsed.value ?? {};
  if (!isMapping(document)) {
    const problem = `expected mapping, got ${describeValue(document)}`;
    return { ok: false, errors: [configError(file, "(top level)", "mapping", problem)] };
  }
  const version = document["version"];
  if (version === undefined) {
    const problem = "expected integer, got nothing; version is required";
    return { ok: false, errors: [configError(file, "version", "integer", problem)] };
  }
  if (typeof version !== "number" || !Number.isInteger(version)) {
    const problem = `expected integer, got ${describeValue(version)}`;
    return { ok: false, errors: [configError(file, "version", "integer", problem)] };
  }
  const range = `integer from 1 to ${latestVersion}`;
  if (version > latestVersion) {
    const problem = `configuration version ${version} is newer than this dipo understands (up to ${latestVersion}); upgrade dipo`;
    return { ok: false, errors: [configError(file, "version", range, problem)] };
  }
  if (version < 1) {
    const problem = `unknown configuration version ${version}`;
    return { ok: false, errors: [configError(file, "version", range, problem)] };
  }
  return { ok: true, document, version };
}

// Software-level configuration

/**
 * The exit code of a daemon that refuses to start because `config.yaml` is invalid or newer than
 * it knows: `EX_CONFIG` from sysexits. A supervisor must not restart on it (launchd, systemd
 * `RestartPreventExitStatus=78`, DIPO-63), and a client that would autostart the daemon shows the
 * configuration error instead (DIPO-70), because a restart cannot fix the file.
 */
export const EXIT_CONFIG = 78;

/**
 * The installed autostart (0006 decision 15, DIPO-63): the launchd agent's label and the systemd
 * user unit. The client writes them (`dipo daemon install`); the daemon recognises its supervisor
 * by them. Shared here because `client` may not import `engine` (0004).
 */
export const LAUNCHD_LABEL = "dipo.daemon";
export const SYSTEMD_UNIT = "dipo.service";

/** The file name under `<state>`. */
export const SOFTWARE_CONFIG_FILE = "config.yaml";

/** The newest `config.yaml` version this binary knows. Every added key bumps it (0017). */
export const SOFTWARE_CONFIG_VERSION = 2;

/**
 * `config.yaml` version 1. `daemon.autostart` is 0006 decision 5, `daemon.autoRestartOnUpgrade`
 * 0006 decision 14. A key added later needs a version 2 schema and a migration from version 1
 * (0017 amendment of 2026-10-12), never an edit of this one.
 */
export const SoftwareConfigV1 = z.strictObject({
  version: z.literal(1),
  daemon: z
    .strictObject({
      autostart: z
        .boolean()
        .default(true)
        .describe(
          "A client command that needs the daemon starts it when none is running (0006 decision 5).",
        ),
      autoRestartOnUpgrade: z
        .boolean()
        .default(false)
        .describe(
          "When the dipo executable changed, the daemon drains and restarts itself once no run is in a step that cannot be detached (0006 decision 14).",
        ),
    })
    .default({ autostart: true, autoRestartOnUpgrade: false }),
});

/**
 * `config.yaml` version 2 (DIPO-311): adds `usage.alerts`, the daily and monthly token levels that
 * raise an alert over all offices together. `dayTokens` and `monthTokens` have no default, so the
 * alerts stay off until set; they count budget tokens (0008 section 4) in UTC calendar windows.
 */
export const SoftwareConfigV2 = z.strictObject({
  version: z.literal(2),
  daemon: SoftwareConfigV1.shape.daemon,
  usage: z
    .strictObject({
      alerts: z
        .strictObject({
          dayTokens: z
            .int()
            .positive()
            .optional()
            .describe(
              "Budget tokens (input, output and cache creation) of all offices together per UTC calendar day that raise the alert at the level and the limit. No default: unset keeps the day alert off.",
            ),
          monthTokens: z
            .int()
            .positive()
            .optional()
            .describe(
              "Budget tokens of all offices together per UTC calendar month that raise the alert at the level and the limit. No default: unset keeps the month alert off.",
            ),
          level: z
            .number()
            .gt(0)
            .max(1)
            .default(0.8)
            .describe("The share of a limit at which the alert starts, for example 0.8 for 80%."),
        })
        .default({ level: 0.8 }),
    })
    .default({ alerts: { level: 0.8 } }),
});

/** Every `config.yaml` version by number, oldest first. */
export const SOFTWARE_CONFIG_SCHEMAS = { 1: SoftwareConfigV1, 2: SoftwareConfigV2 } as const;

/** The effective software-level settings: the newest version with every default filled in. */
export type SoftwareConfig = z.output<typeof SoftwareConfigV2>;

/** The settings when `<state>/config.yaml` is absent. */
export const SOFTWARE_CONFIG_DEFAULTS: SoftwareConfig = SoftwareConfigV2.parse({
  version: SOFTWARE_CONFIG_VERSION,
});

export type SoftwareConfigResult =
  | {
      readonly ok: true;
      readonly config: SoftwareConfig;
      /** False when the file is absent and the defaults apply. */
      readonly fromFile: boolean;
    }
  | { readonly ok: false; readonly errors: readonly ConfigError[] };

/**
 * Validates `config.yaml` once the reader parsed it with `parseSingleYamlDocument`; `undefined`
 * means the file is absent and gives the defaults. `file` is how errors name the file. Pure;
 * never throws for bad input.
 */
export function resolveSoftwareConfig(
  file: string,
  parsed: YamlParseResult | undefined,
): SoftwareConfigResult {
  if (parsed === undefined) {
    return { ok: true, config: SOFTWARE_CONFIG_DEFAULTS, fromFile: false };
  }
  const checked = checkConfigDocument(file, parsed, SOFTWARE_CONFIG_VERSION);
  if (!checked.ok) return checked;
  // A version 1 file is validated against its own schema, then migrated in memory: version 2 only
  // adds keys, so the migration raises `version`. The file is never rewritten.
  if (checked.version === 1) {
    const old = SoftwareConfigV1.safeParse(checked.document);
    if (!old.success) {
      return {
        ok: false,
        errors: configIssueErrors(file, SoftwareConfigV1, checked.document, old.error.issues),
      };
    }
    return {
      ok: true,
      config: SoftwareConfigV2.parse({ ...old.data, version: 2 }),
      fromFile: true,
    };
  }
  const valid = SoftwareConfigV2.safeParse(checked.document);
  if (!valid.success) {
    return {
      ok: false,
      errors: configIssueErrors(file, SoftwareConfigV2, checked.document, valid.error.issues),
    };
  }
  return { ok: true, config: valid.data, fromFile: true };
}

/** The JSON Schema of `config.yaml`, for editor completion (0017 section 5). */
export function softwareConfigJsonSchema(): Record<string, unknown> {
  return {
    ...(z.toJSONSchema(SoftwareConfigV2, { io: "input" }) as Record<string, unknown>),
    title: "dipo software configuration (<state>/config.yaml)",
    $comment: "Generated by `bun run contract:schema`. Do not edit by hand.",
  };
}
