// Starting the daemon process (0006 decisions 5 and 8): `dipo daemon --foreground` in its own
// session (`detached`, `setsid`), stdio ignored, so it outlives the client. The environment is the
// caller's, `PATH` included, so the daemon resolves the same tools as the maintainer's shell, minus
// the variables that carry Bun flags: `BUN_OPTIONS` and `BUN_FEATURE_FLAG_NO_ORPHANS`, which a Bun
// started with `--no-orphans` passes on (DIPO-44). Either one would end the daemon with this client.
// The caller builds it with the contract's `detachedEnv`, the daemon's own rule (DIPO-320).

/**
 * How this process runs `dipo` again: the compiled binary alone, or Bun with the entry script when
 * running from source.
 */
export function selfCommand(): [string, ...string[]] {
  const main = Bun.main;
  return main.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, main];
}

/** A daemon process the client started. */
export interface SpawnedDaemon {
  readonly pid: number;
}

export interface SpawnDaemonOptions {
  readonly cmd: readonly [string, ...string[]];
  readonly env: Readonly<Record<string, string>>;
}

/** Starts the daemon process; injectable so tests start nothing. */
export type SpawnDaemon = (options: SpawnDaemonOptions) => Promise<SpawnedDaemon>;

/**
 * The daemon must not stay a descendant of the client: a client that itself runs under
 * `--no-orphans` (inherited as `BUN_FEATURE_FLAG_NO_ORPHANS`, DIPO-44) SIGKILLs all its
 * descendants when it exits. So a short-lived `/bin/sh`, started in its own session with stdio
 * ignored, starts the daemon in the background, prints its PID and exits; the daemon is
 * re-parented to init or launchd and keeps the new session.
 */
export const systemSpawnDaemon: SpawnDaemon = async (options) => {
  const child = Bun.spawn({
    cmd: ["/bin/sh", "-c", '"$@" </dev/null >/dev/null 2>&1 & echo $!', "sh", ...options.cmd],
    env: { ...options.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    detached: true,
  });
  const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  const pid = Number(text.trim());
  if (code !== 0 || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`could not start ${options.cmd.join(" ")} (sh exited with ${code})`);
  }
  return { pid };
};
