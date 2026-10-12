// `bun packages/engine/scripts/write-schema.ts`: writes packages/engine/schema/office.schema.json
// from the version 1 zod schema (0017 section 5). The committed file is checked by
// test/config/schema-file.test.ts.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { officeJsonSchema } from "../src/config";

export const SCHEMA_DIR = join(import.meta.dir, "..", "schema");
export const OFFICE_SCHEMA_FILE = join(SCHEMA_DIR, "office.schema.json");

if (import.meta.main) {
  mkdirSync(SCHEMA_DIR, { recursive: true });
  writeFileSync(OFFICE_SCHEMA_FILE, `${JSON.stringify(officeJsonSchema(), null, 2)}\n`);
  // Keep the file in the repository's format, so `format:check` passes without a second step.
  const bin = join(import.meta.dir, "..", "..", "..", "node_modules", ".bin", "oxfmt");
  const oxfmt = Bun.spawnSync([bin, OFFICE_SCHEMA_FILE], { stdout: "inherit", stderr: "inherit" });
  if (oxfmt.exitCode !== 0) process.exit(oxfmt.exitCode ?? 1);
  console.log(`wrote ${OFFICE_SCHEMA_FILE}`);
}
