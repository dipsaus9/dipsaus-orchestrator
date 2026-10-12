// The office-scoped handle (0007 sections 1 and 3). Each office's engine instance gets one on the
// daemon's single connection. Every statement it runs binds that office's `office_id`, and it has
// no way to reach the connection or name another office.

import type { OfficeId } from "@dipsaus-orchestrator/contract";

import type { RunResult, SqliteConnection, SqlParams, SqlRow } from "../platform/sqlite";

const OFFICE_PLACEHOLDER = /\$office_id\b/;
const OFFICE_KEYS = ["office_id", "$office_id", ":office_id", "@office_id"];

export class OfficeHandle {
  readonly officeId: OfficeId;
  readonly #db: SqliteConnection;

  constructor(db: SqliteConnection, officeId: OfficeId) {
    this.#db = db;
    this.officeId = officeId;
  }

  #bind(sql: string, params: SqlParams): SqlParams {
    if (!OFFICE_PLACEHOLDER.test(sql)) {
      throw new Error(`An office statement must use $office_id: ${sql.trim().slice(0, 80)}`);
    }
    for (const key of OFFICE_KEYS) {
      if (key in params) throw new Error("An office statement may not bind office_id itself.");
    }
    return { ...params, office_id: this.officeId };
  }

  run(sql: string, params: SqlParams = {}): RunResult {
    return this.#db.run(sql, this.#bind(sql, params));
  }

  get<T = SqlRow>(sql: string, params: SqlParams = {}): T | null {
    return this.#db.get<T>(sql, this.#bind(sql, params));
  }

  all<T = SqlRow>(sql: string, params: SqlParams = {}): T[] {
    return this.#db.all<T>(sql, this.#bind(sql, params));
  }

  /** Every write runs in here; the callback must be synchronous. */
  immediate<T>(fn: () => T): T {
    return this.#db.immediate(fn);
  }

  /** A read that must match one point in time, such as a snapshot with its cursor. */
  deferred<T>(fn: () => T): T {
    return this.#db.deferred(fn);
  }
}
