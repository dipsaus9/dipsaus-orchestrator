// The crash counter in `<state>` (0006 decision 7). A daemon that holds the lock writes a `running`
// marker with its PID and start time and clears it only on a clean exit. The next daemon that finds
// a marker of another process knows that process exited uncleanly, and records one crash at its own
// start time. Three crashes within 10 minutes start the daemon in `safe`; 10 minutes of stable
// running clear the list. Only the lock holder writes the file, by write-to-temp then rename.
//
// The file also keeps `needsCheck` (DIPO-111): the state database must get `PRAGMA quick_check` at
// the next open. It is set when an open after an unclean exit failed, or when the file was found
// damaged, and survives clean exits; only an open whose quick_check passed clears it. So a daemon
// held for damage and then restarted or upgraded without a restore still checks the file.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Clock } from "@dipsaus-orchestrator/contract";
import { type ProcessIdentity } from "@dipsaus-orchestrator/engine/platform";

export const CRASH_FILE = "crashes.json";
/** Crashes count when they fall within this window before the start. */
export const CRASH_WINDOW_MS = 10 * 60_000;
/** This many crashes within the window start the daemon in `safe`. */
export const CRASH_LOOP_COUNT = 3;
/** Running this long without a crash clears the counter. */
export const STABLE_RUN_MS = 10 * 60_000;

interface CrashFile {
  readonly version: 1;
  /** The daemon running now; a marker left by another process means it did not exit cleanly. */
  readonly running: ProcessIdentity | null;
  /** Times of recorded crashes, ms since the epoch, oldest first. */
  readonly crashes: readonly number[];
  /** Run `PRAGMA quick_check` at the next open; absent in files written before DIPO-111. */
  readonly needsCheck?: boolean;
}

const EMPTY: CrashFile = { version: 1, running: null, crashes: [] };

function parse(raw: string): CrashFile | null {
  try {
    const value = JSON.parse(raw) as Partial<CrashFile>;
    const running = value.running;
    const runningValid =
      running === null ||
      (typeof running === "object" &&
        typeof running?.pid === "number" &&
        typeof running.startTimeMs === "number");
    if (
      value.version !== 1 ||
      !runningValid ||
      !Array.isArray(value.crashes) ||
      !value.crashes.every((t) => typeof t === "number" && Number.isFinite(t)) ||
      (value.needsCheck !== undefined && typeof value.needsCheck !== "boolean")
    ) {
      return null;
    }
    return {
      version: 1,
      running: running ?? null,
      crashes: value.crashes,
      needsCheck: value.needsCheck === true,
    };
  } catch {
    return null;
  }
}

const sameIdentity = (a: ProcessIdentity, b: ProcessIdentity) =>
  a.pid === b.pid && a.startTimeMs === b.startTimeMs;

export interface CrashCounterOpen {
  readonly counter: CrashCounter;
  /** True when the previous daemon left its marker behind: it crashed. */
  readonly previousCrashed: boolean;
  /** True when the file could not be read as a crash file and was started afresh. */
  readonly damaged: boolean;
  /** True when an earlier daemon left `needsCheck` set: quick_check at this open. */
  readonly needsCheck: boolean;
}

export class CrashCounter {
  readonly path: string;
  readonly #self: ProcessIdentity;
  #crashes: readonly number[];
  #needsCheck: boolean;

  private constructor(
    path: string,
    self: ProcessIdentity,
    crashes: readonly number[],
    needsCheck: boolean,
  ) {
    this.path = path;
    this.#self = self;
    this.#crashes = crashes;
    this.#needsCheck = needsCheck;
  }

  /**
   * Reads the counter at start, records a crash when the previous daemon left its marker, keeps
   * only the crashes within the window, and writes this daemon's marker. Call it only while
   * holding the lock.
   */
  static open(stateDir: string, self: ProcessIdentity, clock: Clock): CrashCounterOpen {
    const path = join(stateDir, CRASH_FILE);
    let raw: string | null = null;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
    const parsed = raw === null ? EMPTY : parse(raw);
    const file = parsed ?? EMPTY;
    const now = clock.now();
    const previousCrashed = file.running !== null && !sameIdentity(file.running, self);
    const crashes = [...file.crashes, ...(previousCrashed ? [now] : [])].filter(
      (t) => t > now - CRASH_WINDOW_MS && t <= now,
    );
    const needsCheck = file.needsCheck === true;
    const counter = new CrashCounter(path, self, crashes, needsCheck);
    counter.#write(self);
    return { counter, previousCrashed, damaged: raw !== null && parsed === null, needsCheck };
  }

  /** The crashes within the window at start, this start's detected crash included. */
  get recentCrashes(): number {
    return this.#crashes.length;
  }

  /** True when the daemon must start in `safe` (0006 decision 7). */
  get crashLoop(): boolean {
    return this.#crashes.length >= CRASH_LOOP_COUNT;
  }

  /** Whether the next open must run quick_check (DIPO-111). */
  get needsCheck(): boolean {
    return this.#needsCheck;
  }

  /**
   * Sets or clears `needsCheck` (DIPO-111): set when an open that had to check failed or found
   * damage, cleared only after an open whose quick_check passed. Writes only on a change.
   */
  setNeedsCheck(needsCheck: boolean): void {
    if (this.#needsCheck === needsCheck) return;
    this.#needsCheck = needsCheck;
    this.#write(this.#self);
  }

  /** Clears the counter after 10 minutes of stable running. */
  reset(): void {
    this.#crashes = [];
    this.#write(this.#self);
  }

  /** Clears this daemon's marker on a clean exit, so the next start records no crash. */
  cleanExit(): void {
    let current: CrashFile | null = null;
    try {
      current = parse(readFileSync(this.path, "utf8"));
    } catch {
      return;
    }
    // Another daemon took over the file: leave it alone.
    if (current?.running == null || !sameIdentity(current.running, this.#self)) return;
    this.#write(null);
  }

  #write(running: ProcessIdentity | null): void {
    const file: CrashFile = {
      version: 1,
      running,
      crashes: this.#crashes,
      ...(this.#needsCheck ? { needsCheck: true } : {}),
    };
    const temp = `${this.path}.${this.#self.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(file)}\n`, { mode: 0o600 });
    renameSync(temp, this.path);
  }
}
