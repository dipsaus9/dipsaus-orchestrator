// `bun run test` (and the test step of `bun run verify`): runs `bun test` with the per-test timeout
// for where it runs. In CI (`DIPO_TEST_CI=1`) a test that sets no timeout of its own gets 30 s, since
// the CI runners (the macOS one most) are much slower than a developer machine; elsewhere Bun's own
// 5 s stays (DIPO-335). The timeout goes on the command line because a `setDefaultTimeout` in a
// preload reaches only the first test file of a run, and one in a test file only that file.

/** The per-test timeout in CI, for every test that sets none of its own. */
export const CI_TEST_TIMEOUT_MS = 30_000;

/** Bun's own default per-test timeout. */
export const LOCAL_TEST_TIMEOUT_MS = 5_000;

/** The per-test timeout `env` asks for: 30 s in CI, else Bun's 5 s. */
export function testTimeout(env: Record<string, string | undefined> = process.env): number {
  return env["DIPO_TEST_CI"] === "1" ? CI_TEST_TIMEOUT_MS : LOCAL_TEST_TIMEOUT_MS;
}

/** The `bun test` arguments for `args` (the caller's own, kept) under `env`. */
export function testArgs(
  args: readonly string[],
  env: Record<string, string | undefined> = process.env,
): string[] {
  return ["test", `--timeout=${testTimeout(env)}`, ...args];
}

if (import.meta.main) {
  const child = Bun.spawn([process.execPath, ...testArgs(Bun.argv.slice(2))], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.exit(await child.exited);
}
