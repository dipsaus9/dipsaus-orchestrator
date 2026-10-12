// Isolation by key (0007 section 3): every office-scoped table starts its primary key with
// `office_id`. Runs over the real migrated schema and over fixture tables that break the rule.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { openStateDatabase } from "../../src/db/database";
import { findOfficeKeyViolations } from "../../src/db/schema-check";
import { localMounts, memoryLogger } from "./helpers";

const open = (dir: string) =>
  openStateDatabase({
    stateDir: join(dir, "state"),
    logger: memoryLogger(),
    readMounts: localMounts,
    clock: new ManualClock(),
    engineVersion: "0.0.0-test",
  });

describe("schema", () => {
  it("keys every office-scoped table by office_id first", () =>
    withTempDir(async (dir) => {
      const state = await open(dir);
      try {
        expect(findOfficeKeyViolations(state.connection)).toEqual([]);
      } finally {
        state.close();
      }
    }));

  it("catches fixture tables without office_id first in the key", () =>
    withTempDir(async (dir) => {
      const state = await open(dir);
      const db = state.connection;
      try {
        db.immediate(() =>
          db.exec(`
            create table good (office_id text not null, id text not null, primary key (office_id, id)) strict;
            create table no_office (id text primary key) strict;
            create table office_second (id text not null, office_id text not null, primary key (id, office_id)) strict;
            create table no_key (office_id text not null, id text) strict;
          `),
        );
        expect(findOfficeKeyViolations(db)).toEqual([
          "no_key: no primary key; office-scoped tables start their key with office_id",
          "no_office: primary key starts with id, not office_id",
          "office_second: primary key starts with id, not office_id",
        ]);
      } finally {
        state.close();
      }
    }));
});
