// Shared setup of the sandbox integration tests (CI only, DIPO-37).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { systemClock } from "../../src/platform/clock";
import { currentPlatform } from "../../src/platform/paths";
import { systemSandboxHost } from "../../src/platform/sandbox";
import type { StepDeps, StepRequest } from "../../src/sandbox/step";

/** True when the CI-only tests run (0017 section 1). */
export const CI = process.env["DIPO_TEST_CI"] === "1";

/** Step temp roots under DIPO_TMP, so tests keep their files there (0017 section 3). */
export function stepDeps(): StepDeps {
  const root = process.env["DIPO_TMP"] || "/tmp";
  mkdirSync(root, { recursive: true });
  const platform = currentPlatform();
  return {
    clock: systemClock,
    platform,
    host: systemSandboxHost(platform, undefined, join(root, "dipo-s-")),
  };
}

/** A fake product: a main checkout with `.git`, a linked worktree and a home with a secret. */
export interface Layout {
  readonly home: string;
  readonly main: string;
  readonly worktree: string;
  readonly secret: string;
}

export function makeLayout(dir: string): Layout {
  const home = join(dir, "home");
  const main = join(dir, "main");
  const worktree = join(dir, "wt");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  mkdirSync(join(main, ".git"), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  const secret = join(home, ".ssh", "id_test");
  writeFileSync(secret, "not-a-real-key\n");
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);
  return { home, main, worktree, secret };
}

export function request(
  layout: Layout,
  command: readonly [string, ...string[]],
  kind: "install" | "verify" = "verify",
): StepRequest {
  return {
    kind,
    script: kind,
    command,
    worktree: layout.worktree,
    mainCheckout: layout.main,
    home: layout.home,
    sandbox: { toolchainPaths: [], registryHosts: [] },
    scriptMinutes: { install: 2, verify: 2 },
    env: { ...process.env, HOME: layout.home },
  };
}
