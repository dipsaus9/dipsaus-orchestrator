// The machine-wide port slot table (0010 section 9, 0007 section 2): all offices share
// `localhost`, so the daemon keeps one table in `<state>/slots.json`, outside the database. The
// main checkout is slot 0; a story worktree takes the lowest free slot from 1 to the office's
// `maxSlots` and keeps it while the worktree exists (parked worktrees keep theirs). Teardown
// (DIPO-58) and a failed setup free it. An entry whose worktree directory no longer exists is
// dropped when the table is next written, so a worktree removed by hand does not hold a slot.
//
// The daemon PID lock keeps out a second writer; inside the daemon every change is a synchronous
// read, change and write-to-temp-then-rename, so two setups never take the same slot.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The file name of the slot table under `<state>`. */
export const SLOTS_FILE = "slots.json";

/** The slot of the main checkout (0010 section 9); never handed out. */
export const MAIN_CHECKOUT_SLOT = 0;

export interface SlotEntry {
  readonly slot: number;
  readonly office: string;
  readonly story: string;
  /** The absolute worktree path; one slot per worktree. */
  readonly worktree: string;
  readonly takenAt: number;
}

interface SlotFile {
  readonly version: 1;
  readonly slots: readonly SlotEntry[];
}

/** A slot table that cannot be read; the engine never overwrites it. */
export class SlotTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlotTableError";
  }
}

export interface SlotTableOptions {
  /** Whether a worktree directory still exists; injectable for tests. */
  readonly exists?: (path: string) => boolean;
}

export class SlotTable {
  readonly path: string;
  readonly #exists: (path: string) => boolean;

  constructor(path: string, options: SlotTableOptions = {}) {
    this.path = path;
    this.#exists = options.exists ?? existsSync;
  }

  /** The table at `<state>/slots.json`. */
  static inState(stateDir: string, options?: SlotTableOptions): SlotTable {
    return new SlotTable(join(stateDir, SLOTS_FILE), options);
  }

  /** Every entry, by slot. */
  entries(): SlotEntry[] {
    return this.#read().toSorted((a, b) => a.slot - b.slot);
  }

  /**
   * The entries whose worktree directory exists, by slot. Reads only: an entry whose directory is
   * gone is left in the file until the next write drops it.
   */
  live(): SlotEntry[] {
    return this.entries().filter((entry) => this.#exists(entry.worktree));
  }

  /** The slot held by `worktree`, or null. */
  slotOf(worktree: string): number | null {
    return this.#read().find((entry) => entry.worktree === worktree)?.slot ?? null;
  }

  /**
   * Takes the lowest free slot from 1 to `maxSlots` for `owner.worktree` and returns it; a
   * worktree that already holds a slot keeps it. Returns null when every slot is taken.
   */
  take(owner: Omit<SlotEntry, "slot">, maxSlots: number): number | null {
    const live = this.#read().filter((entry) => this.#exists(entry.worktree));
    const held = live.find((entry) => entry.worktree === owner.worktree);
    if (held !== undefined) {
      this.#write(live);
      return held.slot;
    }
    const used = new Set(live.map((entry) => entry.slot));
    for (let slot = MAIN_CHECKOUT_SLOT + 1; slot <= maxSlots; slot += 1) {
      if (!used.has(slot)) {
        this.#write([...live, { ...owner, slot }]);
        return slot;
      }
    }
    this.#write(live);
    return null;
  }

  /** Frees the slot held by `worktree`; true when it held one. */
  free(worktree: string): boolean {
    const entries = this.#read();
    const kept = entries.filter((entry) => entry.worktree !== worktree);
    if (kept.length === entries.length) return false;
    this.#write(kept);
    return true;
  }

  #read(): SlotEntry[] {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return [];
      throw new SlotTableError(`The port slot table ${this.path} cannot be read: ${String(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new SlotTableError(
        `The port slot table ${this.path} is not valid JSON; dipo does not overwrite it. Fix or remove it.`,
      );
    }
    if (!isSlotFile(parsed)) {
      throw new SlotTableError(
        `The port slot table ${this.path} does not hold slot entries; dipo does not overwrite it. Fix or remove it.`,
      );
    }
    return [...parsed.slots];
  }

  #write(slots: readonly SlotEntry[]): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const file: SlotFile = { version: 1, slots: slots.toSorted((a, b) => a.slot - b.slot) };
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.path);
  }
}

/** Whether every slot from 1 to `maxSlots` is held by one of `live`. */
export function allSlotsHeld(live: readonly SlotEntry[], maxSlots: number): boolean {
  const used = new Set(live.map((entry) => entry.slot));
  for (let slot = MAIN_CHECKOUT_SLOT + 1; slot <= maxSlots; slot += 1) {
    if (!used.has(slot)) return false;
  }
  return true;
}

/** The message for a full table: each held slot with its office, story and worktree. */
export function slotsTakenMessage(live: readonly SlotEntry[], maxSlots: number): string {
  const held = live.map(
    (entry) =>
      `slot ${entry.slot}: office ${entry.office}, story ${entry.story}, worktree ${entry.worktree}`,
  );
  return `every port slot from 1 to ${maxSlots} is taken by another worktree: ${held.join("; ")}. dipo discard <id> frees a story's slot.`;
}

function isSlotFile(value: unknown): value is SlotFile {
  if (typeof value !== "object" || value === null) return false;
  const { version, slots } = value as { version?: unknown; slots?: unknown };
  return (
    version === 1 &&
    Array.isArray(slots) &&
    slots.every(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        Number.isInteger((entry as SlotEntry).slot) &&
        (entry as SlotEntry).slot > MAIN_CHECKOUT_SLOT &&
        typeof (entry as SlotEntry).office === "string" &&
        typeof (entry as SlotEntry).story === "string" &&
        typeof (entry as SlotEntry).worktree === "string" &&
        typeof (entry as SlotEntry).takenAt === "number",
    )
  );
}
