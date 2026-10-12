// The committed JSON Schema files must equal a fresh export. Files are compared as parsed JSON,
// because the formatter owns their layout.

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { contractJsonSchemas } from "../src/index";
import { SCHEMA_DIR } from "./write-schema";

const FIX = "run `bun run contract:schema` and commit packages/contract/schema/";

describe("JSON Schema export", () => {
  const fresh = contractJsonSchemas();

  it(`has exactly the exported files (${FIX})`, () => {
    expect(readdirSync(SCHEMA_DIR).toSorted()).toEqual(Object.keys(fresh).toSorted());
  });

  for (const [name, document] of Object.entries(fresh)) {
    it(`${name} equals a fresh export (${FIX})`, () => {
      const committed: unknown = JSON.parse(readFileSync(join(SCHEMA_DIR, name), "utf8"));
      expect(committed).toEqual(document);
    });
  }
});
