// CI only (0017 section 1; DIPO-37 AC #11): this repository's own verify passes under the verify
// policy, the way dipo will verify itself after cutover: writes only to the checkout and the step
// temp root, no network, `<main>/.git` read-only. The inner run gets `DIPO_SANDBOX_SELF_VERIFY=1`
// and no `DIPO_TEST_CI`, so this test never starts itself again. It runs the compiled binary built
// into a temp directory: from source, `sandbox-exec` would run this checkout's own code, which the
// step can write, and is refused.
//
// macOS and Linux: the process probe reads `kinfo_proc` through `sysctl` instead of the setuid
// `/bin/ps`, which `srt`'s Seatbelt profile refuses to exec (DIPO-114). CI runs the verify job on
// Linux; on macOS this test runs with `DIPO_TEST_CI=1 bun test <this file>`.

import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { removeTempDir, runCommand, tempRoot } from "@dipsaus-orchestrator/testkit";

import { systemClock } from "../../src/platform/clock";
import { currentPlatform, passwdHome } from "../../src/platform/paths";
import { systemSandboxHost } from "../../src/platform/sandbox";
import { runSandboxedStep } from "../../src/sandbox/step";
import { CI } from "./helpers";

const GUARD = "DIPO_SANDBOX_SELF_VERIFY";
const REPO = resolve(import.meta.dir, "../../../..");

if (CI && process.env[GUARD] !== "1") {
  describe("self-verify under the verify policy", () => {
    it(
      "passes bun run verify in this checkout",
      async () => {
        const bin = mkdtempSync(join(tempRoot(), "dipo-bin-"));
        try {
          const pathEnv = { PATH: process.env["PATH"] ?? "/usr/bin:/bin" };
          const built = await runCommand(
            [process.execPath, "scripts/build.ts", "--outfile", join(bin, "dipo")],
            { cwd: REPO, env: pathEnv },
          );
          expect(built.exitCode).toBe(0);
          const platform = currentPlatform();
          const deps = {
            clock: systemClock,
            platform,
            host: systemSandboxHost(platform, [join(bin, "dipo")], join(tempRoot(), "dipo-s-")),
          };
          const common = (
            await runCommand(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
              cwd: REPO,
              env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
            })
          ).stdout.trim();
          const env = { ...process.env };
          delete env["DIPO_TEST_CI"];
          // `bun run verify` put this checkout's node_modules/.bin on PATH; a PATH directory the step
          // can write is refused, so drop those entries.
          env["PATH"] = (env["PATH"] ?? "")
            .split(":")
            .filter((entry) => entry !== REPO && !entry.startsWith(`${REPO}/`))
            .join(":");
          const result = await runSandboxedStep(deps, {
            kind: "verify",
            script: "verify",
            command: ["bun", "run", "verify"],
            worktree: REPO,
            mainCheckout: dirname(common),
            home: passwdHome(),
            uid: process.getuid?.() ?? 0,
            sandbox: { installCachePaths: [], registryHosts: [] },
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
        } finally {
          removeTempDir(bin);
        }
      },
      11 * 60_000,
    );
  });
}
