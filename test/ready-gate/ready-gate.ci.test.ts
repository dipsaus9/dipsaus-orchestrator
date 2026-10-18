// CI only (DIPO-196, 0017 section 1): every Ready story of this repository's backlog passes the
// Ready gate on the checked-out commit, with the Backlog.md 1.53 devDependency. A PR that leaves a
// story Ready which fails the gate fails here with the gate's own messages.

import { describe, it } from "bun:test";

import { join } from "node:path";

import { checkReadyGate, REPO_BACKLOG_CLI } from "../../scripts/check-ready-gate";

const REPO_ROOT = join(import.meta.dir, "..", "..");

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("the Ready gate over the repository's backlog", () => {
    // Measured 14.1 s wall time on this repository (one Ready story, every task viewed once); the
    // timeout leaves room for a slower CI runner and for the backlog to grow.
    it("passes for every Ready story", async () => {
      const report = await checkReadyGate(REPO_ROOT, REPO_BACKLOG_CLI);
      if (report.failures.length > 0) {
        throw new Error(
          `${report.failures.length} Ready gate failure(s) of ${report.checked} Ready stories:\n${report.failures.join("\n")}`,
        );
      }
    }, 120_000);
  });
}
