// CI only (0017 section 1; DIPO-200): a setup step whose package manager is a bash wrapper that
// calls `mktemp` with no arguments before it execs the real tool passes through the real step
// runner. On macOS the wrapper's `mktemp` would otherwise use /var/folders/<x>/T, which the step
// sandbox does not let it write; the shim keeps the file in the step's temp root.

import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { runSandboxedStep } from "../../src/sandbox/step";
import { CI, makeLayout, request, stepDeps } from "./helpers";

const TIMEOUT_MS = 60_000;

if (CI) {
  describe("a package manager that is a wrapper script", () => {
    it(
      "passes when the wrapper calls mktemp with no arguments before it execs the tool",
      () =>
        withTempDir(async (dir) => {
          const layout = makeLayout(dir);
          // Outside the worktree: the trust check refuses a PATH directory the step can write.
          const bin = join(dir, "pm-bin");
          mkdirSync(bin, { recursive: true });
          const tool = join(bin, "real-bun");
          writeFileSync(tool, "#!/bin/sh\necho tool ran\n");
          chmodSync(tool, 0o755);
          const wrapper = join(bin, "bun");
          writeFileSync(
            wrapper,
            `#!/bin/bash\nt=$(mktemp) || exit 1\necho "temp:$t"\nrm -f "$t"\nexec '${tool}' "$@"\n`,
          );
          chmodSync(wrapper, 0o755);

          const result = await runSandboxedStep(
            stepDeps(),
            request(layout, [wrapper, "install", "--frozen-lockfile"], "install", {
              PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
            }),
          );
          if (result.outcome !== "exited") throw new Error(`step did not run: ${result.reason}`);
          expect(result.stderr.text).not.toContain("Operation not permitted");
          expect(result.code).toBe(0);
          const lines = result.stdout.text.trim().split("\n");
          expect(lines.at(-1)).toBe("tool ran");
          expect(lines[0]).toContain("/dipo-s-");
        }),
      TIMEOUT_MS,
    );
  });
}
