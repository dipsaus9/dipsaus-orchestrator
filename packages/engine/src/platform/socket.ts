// The daemon's Unix socket `<runtime>/dipo.sock` (0006 decisions 6 and 9). Binding is not a lock in
// Bun (a second bind takes the path over), so the PID lock in `<state>` guards the socket. Until
// DIPO-24 serves the contract here, the socket answers every HTTP request with the daemon's
// identity, which the lock's step 1 uses as its handshake.

import { rmSync } from "node:fs";

/** What the socket reports about the daemon behind it. */
export interface SocketIdentity {
  readonly pid: number;
  readonly startTimeMs: number;
  readonly version: string;
}

export interface BoundSocket {
  readonly path: string;
  /** Stops listening and, unless `removeFile` is false, removes the socket file. */
  stop(options?: { readonly removeFile?: boolean }): Promise<void>;
}

/** Removes a leftover socket file; a missing file is fine. */
export function removeSocketFile(path: string): void {
  rmSync(path, { force: true });
}

/** Binds `path` and answers each request with `identity` as JSON. */
export function bindDaemonSocket(path: string, identity: SocketIdentity): BoundSocket {
  const server = Bun.serve({
    unix: path,
    fetch: () => Response.json(identity),
  });
  return {
    path,
    stop: async (options = {}) => {
      await server.stop(true);
      if (options.removeFile !== false) removeSocketFile(path);
    },
  };
}

/** Asks the socket at `path` who it is; null when nothing answers within `timeoutMs`. */
export async function probeDaemonSocket(
  path: string,
  timeoutMs = 1000,
): Promise<SocketIdentity | null> {
  try {
    const response = await fetch("http://dipo/", {
      unix: path,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const value = (await response.json()) as Partial<SocketIdentity>;
    if (typeof value.pid !== "number" || typeof value.startTimeMs !== "number") return null;
    return {
      pid: value.pid,
      startTimeMs: value.startTimeMs,
      version: typeof value.version === "string" ? value.version : "unknown",
    };
  } catch {
    return null;
  }
}
