// Office-scoped handles (0007 sections 1 and 3): every statement binds the handle's office_id.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { ManualClock, SequentialIds, withTempDir } from "@dipsaus-orchestrator/testkit";

import { openStateDatabase } from "../../src/db/database";
import { OfficeHandle } from "../../src/db/office";
import { AsyncTransactionError } from "../../src/platform/sqlite";
import { localMounts, memoryLogger } from "./helpers";

describe("office handle", () => {
  it("binds its own office_id and refuses statements without it", () =>
    withTempDir(async (dir) => {
      const ids = new SequentialIds();
      const state = await openStateDatabase({
        stateDir: join(dir, "state"),
        logger: memoryLogger(),
        readMounts: localMounts,
        clock: new ManualClock(),
        engineVersion: "0.0.0-test",
      });
      try {
        const db = state.connection;
        db.immediate(() =>
          db.exec(
            "create table notes (office_id text not null, n integer not null, primary key (office_id, n)) strict",
          ),
        );
        const a = state.office(ids.next("off") as OfficeId);
        const b = state.office(ids.next("off") as OfficeId);
        expect(a).toBeInstanceOf(OfficeHandle);

        a.immediate(() =>
          a.run("insert into notes (office_id, n) values ($office_id, $n)", { n: 1 }),
        );
        b.immediate(() =>
          b.run("insert into notes (office_id, n) values ($office_id, $n)", { n: 2 }),
        );
        expect(a.all("select n from notes where office_id = $office_id")).toEqual([{ n: 1 }]);
        expect(b.get<{ n: number }>("select n from notes where office_id = $office_id")).toEqual({
          n: 2,
        });

        expect(() => a.all("select n from notes")).toThrow("$office_id");
        expect(() =>
          a.run("insert into notes (office_id, n) values ($office_id, 3)", {
            office_id: b.officeId,
          }),
        ).toThrow("office_id");
        expect(() => a.immediate(async () => undefined)).toThrow(AsyncTransactionError);
        expect(Object.keys(a)).toEqual(["officeId"]);
      } finally {
        state.close();
      }
    }));
});
