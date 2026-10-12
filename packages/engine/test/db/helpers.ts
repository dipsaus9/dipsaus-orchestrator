// Shared helpers for the state database tests.

import type { DbLogger, MountReader } from "../../src/platform/sqlite";

export interface LogLine {
  readonly level: "info" | "warn";
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>> | undefined;
}

/** A logger that keeps every line for assertions. */
export function memoryLogger(): DbLogger & { readonly lines: LogLine[] } {
  const lines: LogLine[] = [];
  return {
    lines,
    info: (message, fields) => lines.push({ level: "info", message, fields }),
    warn: (message, fields) => lines.push({ level: "warn", message, fields }),
  };
}

/** A mount table with one local root, so tests never depend on the machine's mounts. */
export const localMounts: MountReader = async () => [{ mountPoint: "/", fsType: "apfs" }];
