// This repository's own `.dipo/office.yaml`: it is at the current version, loads with no warning,
// and `dipo config migrate` leaves it as it is. A binary older than this version refuses it, so the
// pinned dipo binary is rebuilt once the version changes.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  migrateOfficeFileText,
  OFFICE_CONFIG_VERSION,
  OFFICE_FILE,
  resolveOfficeConfig,
} from "../../src/config";

const office = readFileSync(
  join(import.meta.dir, "..", "..", "..", "..", ".dipo", "office.yaml"),
  "utf8",
);

describe("this repository's .dipo/office.yaml", () => {
  it("is the current version and loads with no warning", () => {
    expect(office.startsWith(`version: ${OFFICE_CONFIG_VERSION}\n`)).toBe(true);
    const result = resolveOfficeConfig({ office });
    if (!result.ok) throw new Error(result.errors.map((error) => error.message).join("\n"));
    expect(result.warnings).toEqual([]);
  });

  it("is left as it is by dipo config migrate", () => {
    const migrated = migrateOfficeFileText(OFFICE_FILE, office);
    if (!migrated.ok) throw new Error(migrated.errors.map((error) => error.message).join("\n"));
    expect(migrated.from).toBe(OFFICE_CONFIG_VERSION);
    expect(migrated.changes).toEqual([]);
    expect(migrated.text).toBe(office);
  });

  // The ci-ok light-path tests run ci.yml's ci-ok step, which needs jq, so the box image has it
  // and bun run verify passes in the box (DIPO-372).
  it("gives the box image jq", () => {
    const result = resolveOfficeConfig({ office });
    if (!result.ok) throw new Error(result.errors.map((error) => error.message).join("\n"));
    expect(result.config.box.packages).toEqual(["jq"]);
  });
});
