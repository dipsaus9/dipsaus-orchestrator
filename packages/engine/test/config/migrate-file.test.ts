// `dipo config migrate` (0017): the same upgrades as the load, applied to the YAML document so
// comments stay. This binary carries none, so a current file comes back as it is and an older one
// is refused with the load's own message.

import { describe, expect, it } from "bun:test";

import {
  migrateOfficeFileText,
  OFFICE_FILE,
  OFFICE_LOCAL_FILE,
  resolveOfficeConfig,
  type MigratedFile,
} from "../../src/config";

function migrated(result: MigratedFile) {
  if (!result.ok) throw new Error(result.errors.map((error) => error.message).join("\n"));
  return result;
}

describe("migrateOfficeFileText", () => {
  it("returns a version 16 file unchanged, with its comments", () => {
    const text = "# mine\nversion: 16\nbase: main\n";
    expect(migrated(migrateOfficeFileText(OFFICE_FILE, text))).toEqual({
      ok: true,
      from: 16,
      text,
      changes: [],
    });
    const review = [
      "version: 16",
      "review:",
      "  effort: medium",
      "  tiers: # sonnet for small stories",
      "    S: { model: sonnet }",
      "",
    ].join("\n");
    expect(migrated(migrateOfficeFileText(OFFICE_FILE, review)).text).toBe(review);
  });

  it("refuses an older file with the same message the load gives, in either file", () => {
    for (const [file, text] of [
      [OFFICE_FILE, "# an old file\nversion: 14\nmerge: { holdLabels: [hold] }\n"],
      [OFFICE_LOCAL_FILE, "version: 15\nprivacy: { keepRawEvents: true }\n"],
    ] as const) {
      const result = migrateOfficeFileText(file, text);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      const loaded = resolveOfficeConfig(file === OFFICE_FILE ? { office: text } : { local: text });
      expect(loaded.ok).toBe(false);
      if (loaded.ok) continue;
      expect(result.errors).toEqual(loaded.errors);
      expect(result.errors[0]?.message).toContain("is older than this dipo reads (version 16)");
    }
  });

  it("refuses a current file that would not load, naming the key", () => {
    const result = migrateOfficeFileText(OFFICE_FILE, "version: 16\ntimeouts: { typo: 1 }\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.path)).toEqual(["timeouts.typo"]);
    expect(result.errors[0]?.message).toContain("this key may need a newer dipo");
    expect(migrateOfficeFileText(OFFICE_FILE, "version: 99\n").ok).toBe(false);
    expect(migrateOfficeFileText(OFFICE_LOCAL_FILE, "version: 16\ntiers: {}\n").ok).toBe(false);
  });
});
