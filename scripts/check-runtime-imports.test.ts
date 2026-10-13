// Decision 0016 rule 11: a devDependency must not slip into the `dipo` binary. Every import in
// `packages/*/src` (test files excepted) must name a runtime dependency of that package. This is a
// test script rather than an oxlint rule because oxlint support for the check is not confirmed
// (DIPO-15). Imports are read with Bun's own scanner, the one that builds the binary, so
// type-only imports, which never reach runtime, are not counted.
import { afterAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";

const PACKAGES = new URL("../packages", import.meta.url).pathname;

// Temp files only under DIPO_TMP (0017), falling back to /tmp.
const TMP_ROOT = process.env["DIPO_TMP"] || "/tmp";

const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST_FILE = /\.test\.(?:[cm]?[jt]s|[jt]sx)$/;
const BUILTINS = new Set(builtinModules);

// Each extension needs its own loader: `<T>(x)` is a generic in .ts and JSX in .tsx.
const SCANNERS = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
  js: new Bun.Transpiler({ loader: "js" }),
  jsx: new Bun.Transpiler({ loader: "jsx" }),
};

function scannerFor(file: string): Bun.Transpiler {
  if (file.endsWith(".tsx")) return SCANNERS.tsx;
  if (file.endsWith(".jsx")) return SCANNERS.jsx;
  return /\.[cm]?ts$/.test(file) ? SCANNERS.ts : SCANNERS.js;
}

interface Violation {
  file: string;
  specifier: string;
  pkg: string;
}

interface Report {
  files: number;
  violations: Violation[];
}

/** The package an import names, or undefined for relative paths and runtime builtins. */
function packageOf(specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return undefined;
  if (specifier === "bun" || specifier.startsWith("bun:") || specifier.startsWith("node:")) {
    return undefined;
  }
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
  return BUILTINS.has(name) ? undefined : name;
}

function checkRuntimeImports(packagesDir: string): Report {
  const report: Report = { files: 0, violations: [] };
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(packagesDir, entry.name);
    const src = join(dir, "src");
    if (!existsSync(join(dir, "package.json")) || !existsSync(src)) continue;
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const runtime = new Set<string>([manifest.name, ...Object.keys(manifest.dependencies ?? {})]);
    for (const rel of readdirSync(src, { recursive: true, encoding: "utf8" })) {
      if (!SOURCE.test(rel) || TEST_FILE.test(rel) || rel.endsWith(".d.ts")) continue;
      const file = join(src, rel);
      report.files++;
      const code = readFileSync(file, "utf8");
      for (const { path: specifier } of scannerFor(rel).scanImports(code)) {
        const pkg = packageOf(specifier);
        if (pkg !== undefined && !runtime.has(pkg)) {
          report.violations.push({ file: join(entry.name, "src", rel), specifier, pkg });
        }
      }
    }
  }
  return report;
}

describe("runtime imports in packages/*/src", () => {
  it("name only runtime dependencies of their own package", () => {
    const report = checkRuntimeImports(PACKAGES);
    // The check must have something to read, or it passes for nothing.
    expect(report.files).toBeGreaterThan(50);
    expect(report.violations).toEqual([]);
  });
});

describe("checkRuntimeImports on a fixture", () => {
  const root = mkdtempSync(join(TMP_ROOT, "dipo-runtime-imports-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function fixture(files: Record<string, string>): string {
    const packages = mkdtempSync(join(root, "packages-"));
    mkdirSync(join(packages, "pkg", "src", "nested"), { recursive: true });
    writeFileSync(
      join(packages, "pkg", "package.json"),
      JSON.stringify({
        name: "@fixture/pkg",
        dependencies: { zod: "4.6.5", "@scope/runtime": "1.0.0" },
        devDependencies: { "left-pad": "1.3.0", "@scope/dev": "1.0.0" },
      }),
    );
    for (const [path, code] of Object.entries(files)) {
      writeFileSync(join(packages, "pkg", "src", path), code);
    }
    return packages;
  }

  it("reports a source file that imports a devDependency", () => {
    const report = checkRuntimeImports(
      fixture({ "nested/pad.ts": 'import pad from "left-pad";\nexport const x = pad("a", 2);\n' }),
    );
    expect(report.violations).toEqual([
      { file: join("pkg", "src", "nested", "pad.ts"), specifier: "left-pad", pkg: "left-pad" },
    ]);
  });

  it("reports re-exports, dynamic imports, requires and undeclared packages", () => {
    const report = checkRuntimeImports(
      fixture({
        "a.ts": 'export * from "@scope/dev/sub";\n',
        "b.ts": 'export const m = await import("left-pad");\n',
        "c.ts": 'export const r = require("undeclared");\n',
      }),
    );
    expect(report.violations.map((v) => v.pkg).toSorted()).toEqual([
      "@scope/dev",
      "left-pad",
      "undeclared",
    ]);
  });

  it("accepts dependencies, subpaths, builtins, relative and type-only imports, and test files", () => {
    const report = checkRuntimeImports(
      fixture({
        "ok.ts": [
          'import { z } from "zod";',
          'import { r } from "@scope/runtime/sub";',
          'import { self } from "@fixture/pkg";',
          'import { join } from "node:path";',
          'import { readFileSync } from "fs";',
          'import { $ } from "bun";',
          'import { Database } from "bun:sqlite";',
          'import { local } from "./nested/local";',
          'import type { Pad } from "left-pad";',
          "export { z, r, self, join, readFileSync, $, Database, local };",
          "export type { Pad };",
          "",
        ].join("\n"),
        "ok.test.ts": 'import pad from "left-pad";\nexport const x = pad;\n',
        "ok.ci.test.ts": 'import pad from "left-pad";\nexport const x = pad;\n',
      }),
    );
    expect(report.files).toBe(1);
    expect(report.violations).toEqual([]);
  });
});
