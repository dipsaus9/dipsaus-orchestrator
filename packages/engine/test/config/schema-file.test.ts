// Contract test (0017 section 5): the committed office.schema.json equals a fresh export. Compared
// as parsed JSON, because the formatter owns the layout.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { officeJsonSchema } from "../../src/config";
import { OFFICE_SCHEMA_FILE } from "../../scripts/write-schema";

describe("office.schema.json", () => {
  it("equals a fresh export (run `bun packages/engine/scripts/write-schema.ts` and commit it)", () => {
    const committed: unknown = JSON.parse(readFileSync(OFFICE_SCHEMA_FILE, "utf8"));
    expect(committed).toEqual(officeJsonSchema());
  });

  it("rejects unknown keys and has no privacy or retention keys", () => {
    const schema = officeJsonSchema() as {
      additionalProperties: unknown;
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["version"]);
    expect(Object.keys(schema.properties)).not.toContain("privacy");
    expect(Object.keys(schema.properties)).not.toContain("retention");
  });
});
