// CI only (0017 section 1; DIPO-37 AC #11): this repository's own verify passes under the verify
// policy, the way dipo will verify itself after cutover: writes only to the checkout and the step
// temp root, no network, `<main>/.git` read-only. The inner run gets `DIPO_SANDBOX_SELF_VERIFY=1`
// and no `DIPO_TEST_CI`, so this test never starts itself again.
//
// Linux only: on macOS `srt`'s Seatbelt profile refuses to exec the setuid `/bin/ps` that the
// process probe of DIPO-23 reads start times with, so four process and daemon tests fail there.

import { describe, expect, it } from "bun:test";
import { dirname, resolve } from "node:path";

import { runCommand } from "@dipsaus-orchestrator/testkit";

import { passwdHome } from "../../src/platform/paths";
import { runSandboxedStep } from "../../src/sandbox/step";
import { CI, stepDeps } from "./helpers";

const GUARD = "DIPO_SANDBOX_SELF_VERIFY";
const REPO = resolve(import.meta.dir, "../../../..");

if (CI && process.platform === "linux" && process.env[GUARD] !== "1") {
  describe("self-verify under the verify policy", () => {
    it(
      "passes bun run verify in this checkout",
      async () => {
        const common = (
          await runCommand(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
            cwd: REPO,
            env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
          })
        ).stdout.trim();
        const env = { ...process.env };
        delete env["DIPO_TEST_CI"];
        const result = await runSandboxedStep(stepDeps(), {
          kind: "verify",
          script: "verify",
          command: ["bun", "run", "verify"],
          worktree: REPO,
          mainCheckout: dirname(common),
          home: passwdHome(),
          sandbox: { toolchainPaths: [], registryHosts: [] },
          scriptMinutes: { verify: 10 },
          env,
          extraEnv: { [GUARD]: "1" },
        });
        if (result.outcome !== "exited") throw new Error(result.reason);
        if (result.code !== 0) {
          console.error(result.stdout.text.slice(-8000));
          console.error(result.stderr.text.slice(-8000));
        }
        expect(result.code).toBe(0);
        expect(result.timedOut).toBe(false);
      },
      11 * 60_000,
    );
  });
}
