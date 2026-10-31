// `dipo config migrate` rewrites an office file at version 14 (0017): the same steps as the load,
// applied to the YAML document so comments stay, and a file that would not load is refused.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  migrateOfficeFileText,
  OFFICE_CONFIG_VERSION,
  OFFICE_FILE,
  OFFICE_LOCAL_FILE,
  resolveOfficeConfig,
  type MigratedFile,
} from "../../src/config";

function fixture(name: string): string {
  return readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
}

function migrated(result: MigratedFile) {
  if (!result.ok) throw new Error(result.errors.map((error) => error.message).join("\n"));
  return result;
}

function configOf(sources: Parameters<typeof resolveOfficeConfig>[0]) {
  const result = resolveOfficeConfig(sources);
  if (!result.ok) throw new Error(result.errors.map((error) => error.message).join("\n"));
  return result;
}

describe("migrateOfficeFileText", () => {
  it("keeps comments and the keys that stay, moves mergeSlot and names each change", () => {
    const result = migrated(migrateOfficeFileText(OFFICE_FILE, fixture("office-v5.yaml")));
    expect(result.from).toBe(5);
    expect(result.text).toBe(
      [
        "# A version 5 office file: version 5 adds review and the rest of mergeSlot (DIPO-139).",
        "version: 14",
        "review: { maxRounds: 2 }",
        "caps:",
        "  ciAttempts: 3",
        "  conflictAttempts: 4",
        "merge:",
        "  autoMerge: false # the maintainer approves every merge",
        "  holdLabels: [ hold ]",
        "  checksWaitMinutes: 45",
        "",
      ].join("\n"),
    );
    expect(result.changes).toEqual([
      "moved mergeSlot.ciAttempts to caps.ciAttempts",
      "moved mergeSlot.conflictAttempts to caps.conflictAttempts",
      "moved mergeSlot.autoMerge to merge.autoMerge",
      "moved mergeSlot.holdLabels to merge.holdLabels",
      "moved mergeSlot.checksWaitMinutes to merge.checksWaitMinutes",
      "deleted mergeSlot.requiredChecks, because the required checks are the ones GitHub requires on the base (0002)",
    ]);
  });

  for (let version = 1; version < OFFICE_CONFIG_VERSION; version += 1) {
    it(`writes the version ${version} fixture as a version 14 file that loads as the fixture does, with no warning`, () => {
      const text = fixture(`office-v${version}.yaml`);
      const result = migrated(migrateOfficeFileText(OFFICE_FILE, text));
      expect(result.text).toStartWith(`# A version ${version} `);
      const after = configOf({ office: result.text });
      expect(after.warnings).toEqual([]);
      expect(after.configHash).toBe(configOf({ office: text }).configHash);
      expect(result.changes).toHaveLength(configOf({ office: text }).warnings.length);
    });
  }

  it("migrates an older local file and drops its sandbox key", () => {
    const text = fixture("office-local-v4.yaml");
    const result = migrated(migrateOfficeFileText(OFFICE_LOCAL_FILE, text));
    expect(result.text).toContain("version: 14\n");
    expect(result.text).toContain(
      "# accepts. sandbox.toolchainReadPaths is retired in version 14.",
    );
    expect(result.text).not.toContain("sandbox:");
    expect(result.text).not.toContain("permissionWaitSeconds");
    expect(configOf({ local: result.text }).configHash).toBe(configOf({ local: text }).configHash);
  });

  // DIPO-405: review.tiers is a key with a default, so it needs no version bump (0017).
  it("keeps a version 13 review block and its comment, and leaves a version 14 review.tiers as it is", () => {
    const result = migrated(migrateOfficeFileText(OFFICE_FILE, fixture("office-v13.yaml")));
    expect(result.text).toContain(
      "# The reviewer at normal effort, for every tier.\nreview:\n  effort: medium\n",
    );
    expect(configOf({ office: result.text }).config.review.tiers).toEqual({});
    const text = [
      "version: 14",
      "review:",
      "  effort: medium",
      "  tiers: # sonnet for small stories",
      "    S: { model: sonnet }",
      "",
    ].join("\n");
    expect(migrated(migrateOfficeFileText(OFFICE_FILE, text)).text).toBe(text);
  });

  it("returns a version 14 file unchanged", () => {
    const text = "# mine\nversion: 14\nbase: main\n";
    expect(migrated(migrateOfficeFileText(OFFICE_FILE, text))).toEqual({
      ok: true,
      from: 14,
      text,
      changes: [],
    });
  });

  it("refuses a file that would not load as version 14, naming the key", () => {
    const result = migrateOfficeFileText(OFFICE_FILE, "version: 9\ntimeouts: { typo: 1 }\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.path)).toEqual(["timeouts.typo"]);
    expect(result.errors[0]?.message).toContain("this key may need a newer dipo");
    expect(migrateOfficeFileText(OFFICE_FILE, "version: 99\n").ok).toBe(false);
    expect(migrateOfficeFileText(OFFICE_LOCAL_FILE, "version: 4\ntiers: {}\n").ok).toBe(false);
  });
});
