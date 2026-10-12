// Runs the repository's oxlint config over fixture files placed inside a scratch copy of the
// package layout, and returns oxlint's diagnostics with paths relative to the scratch root.

import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const FIXTURES = join(import.meta.dir, "fixtures");
const OXLINT = join(REPO, "node_modules", ".bin", "oxlint");
/** Files the config needs next to it: the config itself and its local JS plugin. */
const CONFIG_FILES = [".oxlintrc.json", "tools/lint/oxlint-plugin.js"];

// Temp files only under DIPO_TMP (0017), falling back to /tmp.
const TMP_ROOT = process.env["DIPO_TMP"] || "/tmp";

/**
 * Per-test timeout for the lint boundary tests. One oxlint run over a scratch tree takes about a
 * second, but under a loaded machine (CI, parallel agents) it has taken close to a minute, and a
 * shared run is paid by whichever test runs first in random order.
 */
export const LINT_TIMEOUT_MS = 180_000;

export type Placement = { fixture: string; target: string };
export type Diagnostic = { code: string; severity: string; filename: string };

export function lintTree(placements: readonly Placement[]): {
  exitCode: number;
  diagnostics: Diagnostic[];
} {
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TMP_ROOT, "dipo-lint-"));
  try {
    for (const file of CONFIG_FILES) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      cpSync(join(REPO, file), join(dir, file));
    }
    for (const placement of placements) {
      const target = join(dir, placement.target);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(FIXTURES, placement.fixture), target);
    }
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
