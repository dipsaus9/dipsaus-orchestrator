import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { parseYamlDocument } from "../../src/platform/yaml";

describe("parseYamlDocument", () => {
  it("parses one document", () => {
    expect(parseYamlDocument("version: 1\nno: no\n")).toEqual({
      ok: true,
      value: { version: 1, no: "no" },
    });
  });

  it("accepts a leading document marker and an end marker", () => {
    expect(parseYamlDocument("---\nversion: 1\n...\n")).toEqual({
      ok: true,
      value: { version: 1 },
    });
  });

  it("returns a top-level list as a value, not as several documents", () => {
    expect(parseYamlDocument("- 1\n- 2\n")).toEqual({ ok: true, value: [1, 2] });
  });

  it("refuses a file with two documents", () => {
    const result = parseYamlDocument("version: 1\n---\nversion: 1\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("more than one YAML document");
  });

  it("refuses two list documents", () => {
    expect(parseYamlDocument("- 1\n---\n- 2\n").ok).toBe(false);
  });

  it("returns a syntax error as a value", () => {
    const result = parseYamlDocument("tiers: [\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toStartWith("invalid YAML");
  });

  it("returns null for an empty file", () => {
    expect(parseYamlDocument("# only a comment\n")).toEqual({ ok: true, value: null });
  });
});

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(path);
  }
  return files;
}

describe("Bun.YAML boundary", () => {
  const packagesDir = join(import.meta.dir, "..", "..", "..");
  const allowed = "engine/src/platform/yaml.ts";

  it(`is reached only through ${allowed}`, () => {
    const offenders = readdirSync(packagesDir)
      .flatMap((name) => {
        const src = join(packagesDir, name, "src");
        try {
          return sourceFiles(src);
        } catch {
          return [];
        }
      })
      .filter((file) => readFileSync(file, "utf8").includes("Bun.YAML"))
      .map((file) => relative(packagesDir, file))
      .filter((file) => file !== allowed);
    expect(offenders).toEqual([]);
  });
});
