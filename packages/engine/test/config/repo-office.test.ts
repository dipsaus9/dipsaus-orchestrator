// This repository's own `.dipo/office.yaml`, migrated with `dipo config migrate` (DIPO-353): it is
// version 14 and loads with no warning. It stays at 14 so the pinned dipo binary, which knows no
// version 15, still reads it until it is rebuilt (DIPO-428); `dipo config migrate` would change
// only its version line, since it sets no key version 15 retired.

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

  it("gets only its version raised by dipo config migrate", () => {
    const migrated = migrateOfficeFileText(OFFICE_FILE, office);
    if (!migrated.ok) throw new Error(migrated.errors.map((error) => error.message).join("\n"));
    expect(migrated.from).toBe(14);
    expect(migrated.changes).toEqual([]);
    expect(migrated.text.startsWith("version: 15\n")).toBe(true);
    const before = resolveOfficeConfig({ office });
    const after = resolveOfficeConfig({ office: migrated.text });
    expect(after.ok && after.configHash).toBe(before.ok && before.configHash);
  });

  // The ci-ok light-path tests run ci.yml's ci-ok step, which needs jq, so the box image has it
  // and bun run verify passes in the box (DIPO-372).
  it("gives the box image jq", () => {
    const result = resolveOfficeConfig({ office });
    if (!result.ok) throw new Error(result.errors.map((error) => error.message).join("\n"));
    expect(result.config.box.packages).toEqual(["jq"]);
  });
});
