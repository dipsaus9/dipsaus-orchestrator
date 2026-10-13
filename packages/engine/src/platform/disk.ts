// Free disk space (M0 review, DIPO-15): before a claim, and again before install (DIPO-39), the
// engine checks the free space on the filesystem that holds the worktree root. The probe is
// injected, so tests can report any amount without filling a disk.

import { statfsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Reports the bytes an unprivileged process may still write on the filesystem holding `path`. */
export interface DiskProbe {
  freeBytes(path: string): Promise<number>;
}

/** The nearest existing ancestor of `path` (the path itself when it exists). */
function nearestExisting(path: string): string {
  let current = resolve(path);
  for (;;) {
    try {
      statfsSync(current);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

/**
 * The real probe: `statfs` on `path`, or on its nearest existing ancestor when it does not exist
 * yet (a worktree root before the first claim). Counts blocks available to unprivileged users.
 */
export const systemDiskProbe: DiskProbe = {
  freeBytes(path) {
    const stats = statfsSync(nearestExisting(path));
    return Promise.resolve(Number(stats.bavail) * Number(stats.bsize));
  },
};

/** A byte count in decimal gigabytes with one decimal, for notices: `1.0 GB`. */
export function formatGigabytes(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}
