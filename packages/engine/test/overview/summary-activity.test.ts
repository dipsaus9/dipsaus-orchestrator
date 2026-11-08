// The office summary's engine additions for the TUI v2 header and Offices (DIPO-458): the last
// activity of each office, from its change log, and whether it starts paused.

import { describe, expect, it } from "bun:test";

import { OfficeId } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { deriveOfficeSummary } from "../../src/overview";
import { addOffice, openTestState } from "../commands/helpers";
import type { OfficeHandle } from "../../src/db/office";

function logAt(office: OfficeHandle, seq: number, at: number): void {
  office.immediate(() =>
    office.run(
      `insert into change_log (office_id, seq, at, type, delta)
       values ($office_id, $seq, $at, 'story.changed', 'null')`,
      { seq, at },
    ),
  );
}

function summary(office: OfficeHandle) {
  return deriveOfficeSummary(
    { office: OfficeId.parse(office.officeId), name: "x", path: "/repos/x" },
    office,
  );
}

describe("last activity in the office summary", () => {
  it("is the newest change-log time of the office, absent while its log is empty", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      const a = addOffice(t, "a");
      const b = addOffice(t, "b");
      expect(summary(a).lastActivityAt).toBeUndefined();
      logAt(a, 1, Date.UTC(2026, 10, 3, 9));
      logAt(a, 2, Date.UTC(2026, 10, 5, 14, 30));
      logAt(b, 1, Date.UTC(2026, 10, 7, 8));
      expect(summary(a).lastActivityAt).toBe("2026-11-05T14:30:00.000Z");
      expect(summary(b).lastActivityAt).toBe("2026-11-07T08:00:00.000Z");
      t.state.close();
    }));

  it("marks an office that starts paused, and no other", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      const a = addOffice(t, "a");
      const b = addOffice(t, "b");
      a.immediate(() =>
        a.run(
          `insert into starts_paused (office_id, reason, detail, since, until_at)
           values ($office_id, 'plan-limit', 'plan limit reached', 0, null)`,
        ),
      );
      expect(summary(a).startsPaused).toBe(true);
      expect(summary(b).startsPaused).toBeUndefined();
      t.state.close();
    }));
});
