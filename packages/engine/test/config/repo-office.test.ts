// This repository's own `.dipo/office.yaml`, migrated with `dipo config migrate` (DIPO-353): it is
// version 14, loads with the version 14 loader with no warning, and a second migrate leaves it alone.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { migrateOfficeFileText, OFFICE_FILE, resolveOfficeConfig } from "../../src/config";

const office = readFileSync(
  join(import.meta.dir, "..", "..", "..", "..", ".dipo", "office.yaml"),
  "utf8",
);

describe("this repository's .dipo/office.yaml", () => {
  it("is version 14 and loads with no warning", () => {
    expect(office.startsWith("version: 14\n")).toBe(true);
    const result = resolveOfficeConfig({ office });
    if (!result.ok) throw new Error(result.errors.map((error) => error.message).join("\n"));
    expect(result.warnings).toEqual([]);
  });

  it("is left as it is by dipo config migrate", () => {
    expect(migrateOfficeFileText(OFFICE_FILE, office)).toEqual({
      ok: true,
      from: 14,
      text: office,
      changes: [],
    });
  });

  // The ci-ok light-path tests run ci.yml's ci-ok step, which needs jq, so the box image has it
  // and bun run verify passes in the box (DIPO-372).
  it("gives the box image jq", () => {
    const result = resolveOfficeConfig({ office });
    if (!result.ok) throw new Error(result.errors.map((error) => error.message).join("\n"));
    expect(result.config.box.packages).toEqual(["jq"]);
  });
});
