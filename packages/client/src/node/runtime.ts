// Where a client finds the daemon (0006 decision 3): the state anchor `<state>` and the
// `<state>/runtime.json` the daemon writes after it holds the lock. The anchor rule is the same as
// the daemon's: `DIPO_HOME` (tests only), else a fixed path under the passwd home directory, never
// `$HOME`, `XDG_STATE_HOME` or `TMPDIR`, so every client finds the daemon's file. `client` may not
// import `engine` (0004), so the rule is repeated here; both sides are tested against the same
// paths. Telling a stale record from a live daemon (`dipo.pid`, start time) is the lifecycle
// module's job (DIPO-70); here a record whose socket does not answer means no daemon.

import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

export type Env = Readonly<Record<string, string | undefined>>;

export const RUNTIME_FILE = "runtime.json";

/** `<state>` for this user (0006 decision 3). */
export function stateDir(
  env: Env = process.env,
  platform: string = process.platform,
  home: string = userInfo().homedir,
): string {
  const override = env["DIPO_HOME"];
  if (override !== undefined && override !== "") return override;
  if (platform === "darwin") return join(home, "Library", "Application Support", "dipo");
  return join(home, ".local", "state", "dipo");
}

/** The fields of `<state>/runtime.json` a client uses. */
export interface RuntimeInfo {
  readonly runtimeDir: string;
  readonly socket: string;
  readonly pid: number;
  readonly startTimeMs: number;
  readonly version: string;
}

/** Reads `<state>/runtime.json`; null when it is missing or not a runtime record. */
export function readRuntimeInfo(state: string): RuntimeInfo | null {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(state, RUNTIME_FILE), "utf8"));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Partial<Record<keyof RuntimeInfo, unknown>>;
  if (
    typeof record.socket !== "string" ||
    !record.socket.startsWith("/") ||
    typeof record.runtimeDir !== "string" ||
    typeof record.pid !== "number" ||
    typeof record.startTimeMs !== "number" ||
    typeof record.version !== "string"
  ) {
    return null;
  }
  return {
    runtimeDir: record.runtimeDir,
    socket: record.socket,
    pid: record.pid,
    startTimeMs: record.startTimeMs,
    version: record.version,
  };
}
