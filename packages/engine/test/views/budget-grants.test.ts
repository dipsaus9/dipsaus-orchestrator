// The budget limit of the usage views counts the run's budget grants (DIPO-206), as `runCaps` and
// the resumer do: the start budget plus the grant.

import { describe, expect, it } from "bun:test";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { recordGrant } from "../../src/run/grants";
import { detail } from "../../src/views/feature";
import { workView } from "../../src/views/work";
import { addOffice, openTestState } from "../commands/helpers";
import { pass, task } from "../stories/helpers";
import { keyOf, startRun } from "./helpers";

describe("budget grants in the usage views (DIPO-206)", () => {
  it("shows the start budget plus the budget grant as the limit in the work and feature views", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const office = addOffice(t);
        pass(t, office, [
          task("TASK-1", { status: "In Progress", criteria: { met: 1, total: 4 } }),
        ]);
        const started = startRun(t, office, "TASK-1", dir, { budget: 20_000 });
        const key = keyOf(office, "TASK-1");

        // No grant yet: the start snapshot is the limit.
        expect(workView(office, started.run)?.usage.budget.limit).toBe(20_000);
        expect(detail(office, key).work?.usage.budget.limit).toBe(20_000);

        office.immediate(() =>
          recordGrant(office, started.run, {
            kind: "budget",
            amount: { tokens: 5000, turns: 0, minutes: 0 },
            grantId: "grt_budget_1",
            note: null,
            origin: "maintainer",
            client: null,
            at: t.clock.now(),
          }),
        );

        expect(workView(office, started.run)?.usage.budget.limit).toBe(25_000);
        expect(detail(office, key).work?.usage.budget.limit).toBe(25_000);
      } finally {
        t.state.close();
      }
    }));
});
