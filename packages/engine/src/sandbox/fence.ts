// The worker's read fence for an engine step (DIPO-183). A worker session cannot read the home
// directory except the paths it needs: its worktree, the main checkout's `.git`, the git
// configuration and the office's toolchain read paths (`sandbox.toolchainReadPaths`,
// `sandbox.allowRead`). The usual step policy has no home-wide block, so a test that passes in
// verify can fail for the worker. A step run `under the fence` reads exactly what the worker reads.
//
// `srt` blocks a directory with `denyRead` and re-opens paths inside it with `allowRead`, but dipo's
// `sandbox-exec` refuses a step whose `denyRead` covers its working directory. So the fence never
// denies the home directory itself: it denies each child of home that lies on no path to a kept
// path, and descends into the ones that do, the same way at every level.

import { readdir } from "node:fs/promises";

import { expandHome, isAtOrUnder } from "./policy";

/** Lists the names inside a directory. */
export type ListDir = (dir: string) => Promise<readonly string[]>;

/** The default `ListDir`: the entries of a directory on disk, any kind. */
export const listDirOnDisk: ListDir = (dir) => readdir(dir);

const join = (dir: string, name: string): string => `${dir === "/" ? "" : dir}/${name}`;

/**
 * Paths inside `home` the fence blocks: everything under `home` except the kept paths and the
 * directories on the way to them. Kept paths outside `home` need no entry. A kept path at or above
 * `home` leaves nothing to block, and `[home]` is the answer when nothing under it is kept.
 */
export async function fenceDenyRead(input: {
  readonly home: string;
  readonly keep: readonly string[];
  readonly list: ListDir;
}): Promise<string[]> {
  const { home, list } = input;
  if (input.keep.some((path) => isAtOrUnder(home, path))) return [];
  const kept = [
    ...new Set(input.keep.filter((path) => path !== home && isAtOrUnder(path, home))),
  ].toSorted();
  if (kept.length === 0) return [home];
  const denied: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const name of await list(dir)) {
      const child = join(dir, name);
      if (kept.some((path) => isAtOrUnder(child, path))) continue;
      if (kept.some((path) => isAtOrUnder(path, child))) await walk(child);
      else denied.push(child);
    }
  };
  await walk(home);
  return denied.toSorted();
}

/** The paths of a worker's read fence for one step, beyond the toolchain list (absolute). */
export function workerReadPaths(input: {
  readonly home: string;
  readonly worktree: string;
  readonly mainCheckout: string;
  readonly tempRoot: string;
  /** `sandbox.toolchainReadPaths` and `sandbox.allowRead`: absolute or starting with `~/`. */
  readonly configured: readonly string[];
}): string[] {
  const { home } = input;
  return [
    ...new Set([
      input.worktree,
      input.tempRoot,
      join(input.mainCheckout, ".git"),
      join(home, ".gitconfig"),
      join(home, ".config/git"),
      ...input.configured.map((path) => expandHome(path, home)),
    ]),
  ];
}
