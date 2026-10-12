// `bun run contract:schema`: writes the contract's JSON Schema export to packages/contract/schema/.
// The contract itself has no I/O, so the writing lives here, outside `src`.

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { contractJsonSchemas } from "../src/index";

export const SCHEMA_DIR = join(import.meta.dir, "..", "schema");

export function renderSchemaFile(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

if (import.meta.main) {
  const files = contractJsonSchemas();
  mkdirSync(SCHEMA_DIR, { recursive: true });
  for (const name of readdirSync(SCHEMA_DIR)) {
    if (!(name in files)) rmSync(join(SCHEMA_DIR, name));
  }
  for (const [name, document] of Object.entries(files)) {
    writeFileSync(join(SCHEMA_DIR, name), renderSchemaFile(document));
  }
  // Keep the files in the repository's format, so `format:check` passes without a second step.
  const bin = join(import.meta.dir, "..", "..", "..", "node_modules", ".bin", "oxfmt");
  const oxfmt = Bun.spawnSync([bin, SCHEMA_DIR], { stdout: "inherit", stderr: "inherit" });
  if (oxfmt.exitCode !== 0) process.exit(oxfmt.exitCode ?? 1);
  console.log(`wrote ${Object.keys(files).length} files to ${SCHEMA_DIR}`);
}
