// Runs the repository's oxlint config over fixture files placed inside a scratch copy of the
// package layout, and asserts that every boundary rule of decision 0004 is reported as an error.

import { describe, expect, it } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const FIXTURES = join(import.meta.dir, "fixtures");
const OXLINT = join(REPO, "node_modules", ".bin", "oxlint");
const RULE = "eslint(no-restricted-imports)";

// Temp files only under DIPO_TMP (0017), falling back to /tmp.
const TMP_ROOT = process.env["DIPO_TMP"] ?? "/tmp";

type Placement = { fixture: string; target: string };

const violations: Placement[] = [
  { fixture: "tui-imports-engine.ts", target: "packages/tui/src/fixture.ts" },
  { fixture: "tui-imports-daemon.ts", target: "packages/tui/src/fixture.ts" },
  { fixture: "client-imports-engine.ts", target: "packages/client/src/fixture.ts" },
  { fixture: "client-imports-daemon.ts", target: "packages/client/src/fixture.ts" },
  { fixture: "cli-imports-engine.ts", target: "packages/cli/src/fixture.ts" },
  // The deep-import ban holds in every package, including the ones with their own override.
  { fixture: "deep-import.ts", target: "packages/engine/src/fixture.ts" },
  { fixture: "deep-import.ts", target: "packages/tui/src/fixture.ts" },
  { fixture: "deep-import.ts", target: "packages/client/src/fixture.ts" },
  { fixture: "deep-import.ts", target: "packages/cli/src/fixture.ts" },
];

type Diagnostic = { code: string; severity: string; filename: string };

function lintPlaced(placement: Placement): { exitCode: number; diagnostics: Diagnostic[] } {
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TMP_ROOT, "dipo-lint-"));
  try {
    cpSync(join(REPO, ".oxlintrc.json"), join(dir, ".oxlintrc.json"));
    const target = join(dir, placement.target);
    mkdirSync(join(target, ".."), { recursive: true });
    cpSync(join(FIXTURES, placement.fixture), target);
    const result = Bun.spawnSync(
      [OXLINT, "--config", ".oxlintrc.json", "--deny-warnings", "--format", "json", "packages"],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    );
    const output = JSON.parse(result.stdout.toString()) as { diagnostics: Diagnostic[] };
    return { exitCode: result.exitCode, diagnostics: output.diagnostics };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("oxlint import boundaries", () => {
  for (const placement of violations) {
    it(`reports ${placement.fixture} in ${placement.target}`, () => {
      const { exitCode, diagnostics } = lintPlaced(placement);
      expect(exitCode).not.toBe(0);
      const hits = diagnostics.filter(
        (d) => d.code === RULE && d.severity === "error" && d.filename === placement.target,
      );
      expect(hits.length).toBeGreaterThan(0);
    });
  }

  it("allows cli to import client, contract and daemon", () => {
    const { exitCode, diagnostics } = lintPlaced({
      fixture: "cli-allowed.ts",
      target: "packages/cli/src/fixture.ts",
    });
    expect(diagnostics).toEqual([]);
    expect(exitCode).toBe(0);
  });
});
