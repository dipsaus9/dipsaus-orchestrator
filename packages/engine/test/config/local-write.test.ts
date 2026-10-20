// Changing one privacy setting in `.dipo/office.local.yaml` (DIPO-136; 0007 section 8): the file
// keeps its other keys, gets dipo's header comment and block-style YAML, and a refused change
// returns errors that name the file and key.

import { describe, expect, it } from "bun:test";

import {
  LOCAL_FILE_HEADER,
  OFFICE_CONFIG_VERSION,
  OFFICE_LOCAL_FILE,
  resolveOfficeConfig,
  updateLocalPrivacy,
} from "../../src/config";
import { parseYamlDocument } from "../../src/platform/yaml";

function written(text: string | undefined, key: string, value: unknown): string {
  const update = updateLocalPrivacy(text, key, value);
  if (!update.ok) throw new Error(update.errors.map((error) => error.message).join("; "));
  return update.text;
}

function parsed(text: string): unknown {
  const result = parseYamlDocument(text);
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

describe("updateLocalPrivacy", () => {
  it("creates a missing file with the current version, the header and block-style YAML", () => {
    const text = written(undefined, "storeCommandBodies", false);
    expect(text.startsWith(LOCAL_FILE_HEADER)).toBe(true);
    expect(LOCAL_FILE_HEADER).toContain("comments are not kept");
    expect(text).not.toContain("{");
    expect(parsed(text)).toEqual({
      version: OFFICE_CONFIG_VERSION,
      privacy: { storeCommandBodies: false },
    });
  });

  it("keeps the other keys and the version of an existing file and drops its comments", () => {
    const before =
      "# my note\nversion: 4\ntimeouts:\n  workerStallMinutes: 9\nretention:\n  shortDays: 3\nprivacy:\n  keepRawEvents: true\n";
    const text = written(before, "storePrompts", false);
    expect(text).not.toContain("my note");
    expect(parsed(text)).toEqual({
      version: 4,
      timeouts: { workerStallMinutes: 9 },
      retention: { shortDays: 3 },
      privacy: { keepRawEvents: true, storePrompts: false },
    });
    const config = resolveOfficeConfig({ local: text });
    expect(config.ok && config.config.privacy).toEqual({
      storePrompts: false,
      storeCommandBodies: true,
      keepRawEvents: true,
    });
  });

  it("refuses an unknown key and a non-boolean value, naming the file and key", () => {
    for (const [key, value, path] of [
      ["storeEverything", true, "privacy.storeEverything"],
      ["storePrompts", "yes", "privacy.storePrompts"],
    ] as const) {
      const update = updateLocalPrivacy(undefined, key, value);
      expect(update.ok).toBe(false);
      if (update.ok) continue;
      expect(update.errors).toHaveLength(1);
      expect(update.errors[0]?.file).toBe(OFFICE_LOCAL_FILE);
      expect(update.errors[0]?.path).toBe(path);
      expect(update.errors[0]?.message).toContain(OFFICE_LOCAL_FILE);
    }
  });

  it("refuses a file that does not validate", () => {
    const update = updateLocalPrivacy(
      "version: 4\ntimeouts:\n  workerStallMinutes: soon\n",
      "storePrompts",
      true,
    );
    expect(update.ok).toBe(false);
    if (update.ok) return;
    expect(update.errors[0]?.file).toBe(OFFICE_LOCAL_FILE);
    expect(update.errors[0]?.path).toBe("timeouts.workerStallMinutes");
  });
});
