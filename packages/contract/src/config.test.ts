import { describe, expect, it } from "bun:test";
import { z } from "zod";

import {
  configIssueErrors,
  parseSingleYamlDocument,
  resolveSoftwareConfig,
  SOFTWARE_CONFIG_DEFAULTS,
  SOFTWARE_CONFIG_SCHEMAS,
  SOFTWARE_CONFIG_VERSION,
  SoftwareConfigV1,
  softwareConfigJsonSchema,
} from "./config";
import { schemaKeyPaths } from "./config-keys";

const FILE = "/state/config.yaml";

const resolve = (text: string | undefined) =>
  resolveSoftwareConfig(
    FILE,
    text === undefined
      ? undefined
      : parseSingleYamlDocument((source) => Bun.YAML.parse(source), text),
  );

function errorsOf(text: string) {
  const result = resolve(text);
  if (result.ok) throw new Error("expected errors");
  return result.errors;
}

// The key paths of every `config.yaml` version. A key added to an existing version fails here: it
// needs a new version with a migration instead (0017 amendment of 2026-10-12).
const KEY_PATHS: Record<number, readonly string[]> = {
  1: ["daemon.autoRestartOnUpgrade", "daemon.autostart", "version"],
};

describe("config.yaml key paths", () => {
  it("lists every schema version", () => {
    expect(Object.keys(SOFTWARE_CONFIG_SCHEMAS).map(Number)).toEqual(
      Object.keys(KEY_PATHS).map(Number),
    );
    expect(Math.max(...Object.keys(SOFTWARE_CONFIG_SCHEMAS).map(Number))).toBe(
      SOFTWARE_CONFIG_VERSION,
    );
  });

  for (const [version, schema] of Object.entries(SOFTWARE_CONFIG_SCHEMAS)) {
    it(`version ${version} has exactly its listed keys`, () => {
      expect(schemaKeyPaths(schema)).toEqual([...(KEY_PATHS[Number(version)] ?? [])]);
    });
  }
});

describe("resolveSoftwareConfig", () => {
  it("gives the defaults when the file is absent", () => {
    expect(resolve(undefined)).toEqual({
      ok: true,
      config: { version: 1, daemon: { autostart: true, autoRestartOnUpgrade: false } },
      fromFile: false,
    });
    expect(SOFTWARE_CONFIG_DEFAULTS).toEqual({
      version: 1,
      daemon: { autostart: true, autoRestartOnUpgrade: false },
    });
  });

  it("parses a valid file and fills in missing keys", () => {
    expect(resolve("version: 1\ndaemon:\n  autostart: false\n")).toEqual({
      ok: true,
      config: { version: 1, daemon: { autostart: false, autoRestartOnUpgrade: false } },
      fromFile: true,
    });
    expect(resolve("# settings\nversion: 1\n")).toMatchObject({
      ok: true,
      config: SOFTWARE_CONFIG_DEFAULTS,
    });
    expect(resolve("version: 1\ndaemon: { autoRestartOnUpgrade: true }\n")).toMatchObject({
      ok: true,
      config: { daemon: { autostart: true, autoRestartOnUpgrade: true } },
    });
  });

  it("names the file, key path and known keys for a typo", () => {
    expect(errorsOf("version: 1\ndaemon:\n  autoStart: false\n")).toEqual([
      {
        file: FILE,
        path: "daemon.autoStart",
        expected: "one of the keys autostart, autoRestartOnUpgrade",
        message: `${FILE}: daemon.autoStart: unknown key; expected one of the keys autostart, autoRestartOnUpgrade`,
      },
    ]);
    expect(errorsOf("version: 1\nweb:\n  enabled: true\n")).toMatchObject([
      { path: "web", expected: "one of the keys version, daemon" },
    ]);
  });

  it("names the expected type for a wrong type", () => {
    expect(errorsOf('version: 1\ndaemon:\n  autostart: "no"\n')).toEqual([
      {
        file: FILE,
        path: "daemon.autostart",
        expected: "boolean",
        message: `${FILE}: daemon.autostart: expected boolean, got string`,
      },
    ]);
    expect(errorsOf("version: 1\ndaemon: true\n")).toMatchObject([
      { path: "daemon", expected: "mapping" },
    ]);
  });

  it("requires an integer version", () => {
    expect(errorsOf("daemon:\n  autostart: true\n")).toEqual([
      {
        file: FILE,
        path: "version",
        expected: "integer",
        message: `${FILE}: version: expected integer, got nothing; version is required`,
      },
    ]);
    expect(errorsOf("")).toMatchObject([{ path: "version", expected: "integer" }]);
    expect(errorsOf("version: one\n")).toMatchObject([{ path: "version", expected: "integer" }]);
    expect(errorsOf("version: 0\n")).toMatchObject([{ path: "version" }]);
  });

  it("refuses more than one YAML document", () => {
    expect(errorsOf("version: 1\n---\nversion: 1\n")).toEqual([
      {
        file: FILE,
        path: "(top level)",
        expected: "exactly one YAML document",
        message: `${FILE}: (top level): holds more than one YAML document; a configuration file holds exactly one`,
      },
    ]);
  });

  it("refuses a top level that is not a mapping, and invalid YAML", () => {
    expect(errorsOf("- 1\n")).toMatchObject([{ path: "(top level)", expected: "mapping" }]);
    expect(errorsOf("daemon: [\n")[0]?.message).toContain("invalid YAML");
  });

  it("refuses a newer version with upgrade dipo", () => {
    const [error] = errorsOf("version: 2\nweb:\n  enabled: true\n");
    expect(error).toMatchObject({ file: FILE, path: "version", expected: "integer from 1 to 1" });
    expect(error?.message).toContain("upgrade dipo");
  });
});

describe("config.yaml JSON Schema", () => {
  it("is strict, requires version and documents the defaults", () => {
    const schema = softwareConfigJsonSchema() as {
      additionalProperties: unknown;
      required: string[];
      properties: {
        daemon: { additionalProperties: unknown; properties: Record<string, unknown> };
      };
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["version"]);
    expect(schema.properties.daemon.additionalProperties).toBe(false);
    expect(schema.properties.daemon.properties).toMatchObject({
      autostart: { type: "boolean", default: true },
      autoRestartOnUpgrade: { type: "boolean", default: false },
    });
  });

  it("accepts what the zod schema accepts", () => {
    expect(SoftwareConfigV1.safeParse({ version: 1 }).success).toBe(true);
    expect(SoftwareConfigV1.safeParse({ version: 1, extra: 1 }).success).toBe(false);
  });
});

describe("configIssueErrors", () => {
  const schema = z.strictObject({
    version: z.literal(1),
    inner: z.strictObject({ a: z.boolean() }),
  });
  const issuesOf = (input: unknown) => {
    const result = schema.safeParse(input);
    if (result.success) throw new Error("expected issues");
    return result.error.issues;
  };

  it("lets a caller reword an unknown key and keeps the default otherwise", () => {
    const input = { version: 1, extra: 1, inner: { a: true, b: 1 } };
    const errors = configIssueErrors("f.yaml", schema, input, issuesOf(input), {
      unknownKeyProblem: (parent, expected) =>
        parent.length === 0 ? `unknown key; only ${expected}` : undefined,
    });
    expect(errors.map((error) => error.message).toSorted()).toEqual([
      "f.yaml: extra: unknown key; only one of the keys version, inner",
      "f.yaml: inner.b: unknown key; expected one of the keys a",
    ]);
  });
});
