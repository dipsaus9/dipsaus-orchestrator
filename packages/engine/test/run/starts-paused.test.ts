// The office's starts paused (0020, DIPO-359), fast and local on the manual clock: a plan limit
// pauses every loaded office with its reason and time and lifts by itself after the reset, a lift
// resumes exactly the parks a plan limit made and no other `worker-failed` park, a restart pauses
// again or lifts what came due, and a failed adapter check pauses through the adapter's hold until
// a passing check lifts it. Driven on a migrated state database with fake resumes.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { OfficeId } from "@dipsaus-orchestrator/contract";

import { OFFICE_DEFAULTS } from "../../src/config";
import type { OfficeHandle } from "../../src/db/office";
import {
  type LiftedPark,
  type LiftedResume,
  PLAN_LIMIT_RESUME_AFTER_MS,
  PLAN_LIMIT_UNKNOWN_RESET_MS,
  planLimitPause,
  STARTS_PAUSED_NOTICES,
  STARTS_PAUSED_RETRY_MS,
  StartsPaused,
} from "../../src/run";
import { AdapterHolds, gateLaunch, RELEASE_NOTICE_CODE } from "../../src/workers/hold";
import { addOffice } from "../commands/helpers";
import { entriesAfter } from "../stories/helpers";
import { type RoundsWorld, roundsWorld, storyRun } from "./rounds-helpers";

const ADAPTER = OFFICE_DEFAULTS.worker.adapter;
const HOUR = 60 * 60_000;

let w: RoundsWorld;
let other: OfficeHandle;
let holds: AdapterHolds;
/** Every resume the starts paused asked for, as office and park. */
let resumed: { office: OfficeId; park: LiftedPark }[];
/** What the fake resume answers next; `resumed` by default. */
let answer: LiftedResume;
let scheduling: boolean;
let lifted: OfficeId[];
let paused: StartsPaused;

const id = (office: OfficeHandle) => office.officeId as OfficeId;
const now = () => w.t.clock.now();

beforeEach(async () => {
  w = await roundsWorld("starts-paused-");
  other = addOffice(w.t, "other");
  resumed = [];
  answer = { outcome: "resumed" };
  scheduling = true;
  lifted = [];
  holds = new AdapterHolds({
    clock: w.t.clock,
    notify: (notice) => {
      if (notice.code === RELEASE_NOTICE_CODE) paused.adapterReleased();
    },
    sticky: {
      checks: new Set(["box-token"]),
      liftedBy: "Replace the box login with dipo login box.",
    },
  });
  paused = startsPaused();
});

afterEach(() => {
  paused.close();
  w.close();
});

function startsPaused(): StartsPaused {
  const offices = new Map([w.office, other].map((office) => [id(office), office]));
  return new StartsPaused({
    clock: w.t.clock,
    offices: { get: (office) => offices.get(office), config: () => OFFICE_DEFAULTS },
    loaded: () => [...offices.keys()],
    holds,
    resume: async (office, liftedPark) => {
      resumed.push({ office, park: liftedPark });
      return answer;
    },
    onLifted: (office) => lifted.push(office),
    scheduling: () => scheduling,
  });
}

/** A park of `story` for `reason`, made by a plan limit when `byLimit`; returns its id. */
function park(story: string, reason: string, byLimit: boolean, office = w.office): number {
  const run = storyRun({ ...w, office }, { story });
  office.immediate(() =>
    office.run(
      `insert into parks (office_id, park_id, key, story_id, run_id, reason, from_state, detail, at,
         resume_on_lift)
       values ($office_id, (select coalesce(max(park_id), 0) + 1 from parks
         where office_id = $office_id), $key, $story, $run, $reason, 'In Progress', 'x', $at, $lift)`,
      { key: run.key, story, run: run.run, reason, at: now(), lift: byLimit ? 1 : 0 },
    ),
  );
  return (
    office.get<{ id: number }>("select max(park_id) as id from parks where office_id = $office_id")
      ?.id ?? 0
  );
}

const resumedParks = () => resumed.map((entry) => entry.park.parkId);

const noticesOf = (office: OfficeHandle) =>
  entriesAfter(office)
    .filter((entry) => entry.type === "engine.notice")
    .map((entry) => entry.delta as { code: string; text: string });

describe("a plan limit (0020)", () => {
  it("pauses every loaded office with its reason, detail, time and what lifts it", () => {
    const reset = new Date(now() + HOUR).toISOString();
    paused.pausePlanLimit(id(w.office), planLimitPause({ credits: false, resetsAt: reset }, now()));
    for (const office of [w.office, other]) {
      expect(paused.state(id(office))).toEqual({
        reason: "plan-limit",
        detail: `plan limit until ${reset}`,
        since: now(),
        until: Date.parse(reset) + PLAN_LIMIT_RESUME_AFTER_MS,
        lifts: `It lifts by itself at ${new Date(Date.parse(reset) + PLAN_LIMIT_RESUME_AFTER_MS).toISOString()}, or with \`dipo daemon resume-scheduling\`.`,
      });
      expect(noticesOf(office).map((notice) => notice.code)).toEqual([
        STARTS_PAUSED_NOTICES.paused,
      ]);
    }
  });

  it("moves the lift only later when another limit comes, and keeps a credits pause until lifted by hand", () => {
    paused.pausePlanLimit(id(w.office), planLimitPause({ credits: false }, now()));
    const first = paused.state(id(w.office))?.until;
    expect(first).toBe(now() + PLAN_LIMIT_UNKNOWN_RESET_MS);
    const sooner = new Date(now() + 60_000).toISOString();
    paused.pausePlanLimit(
      id(w.office),
      planLimitPause({ credits: false, resetsAt: sooner }, now()),
    );
    expect(paused.state(id(w.office))?.until).toBe(first);
    paused.pausePlanLimit(id(w.office), planLimitPause({ credits: true }, now()));
    expect(paused.state(id(w.office))?.until).toBeNull();
    w.t.clock.advance(2 * PLAN_LIMIT_UNKNOWN_RESET_MS);
    expect(paused.state(id(w.office))?.reason).toBe("plan-limit");
    // One notice for the pause, not one per limit.
    expect(noticesOf(w.office).map((notice) => notice.code)).toEqual([
      STARTS_PAUSED_NOTICES.paused,
    ]);
  });

  it("lifts by itself after the reset and resumes exactly the parks a plan limit made", async () => {
    const limited = park("DIPO-1", "worker-failed", true);
    park("DIPO-2", "worker-failed", false);
    park("DIPO-3", "by-maintainer", false);
    const elsewhere = park("DIPO-4", "worker-failed", true, other);
    const reset = now() + HOUR;
    paused.pausePlanLimit(
      id(w.office),
      planLimitPause({ credits: false, resetsAt: new Date(reset).toISOString() }, now()),
    );
    w.t.clock.advanceTo(reset + PLAN_LIMIT_RESUME_AFTER_MS - 1);
    await paused.idle();
    expect(paused.state(id(w.office))).not.toBeNull();
    expect(resumed).toEqual([]);

    w.t.clock.advance(1);
    await paused.idle();
    expect(paused.state(id(w.office))).toBeNull();
    expect(paused.state(id(other))).toBeNull();
    expect(resumed.map((entry) => [entry.office, entry.park.parkId]).toSorted()).toEqual(
      [
        [id(w.office), limited],
        [id(other), elsewhere],
      ].toSorted(),
    );
    expect(lifted.toSorted()).toEqual([id(w.office), id(other)].toSorted());
    expect(noticesOf(w.office).map((notice) => notice.code)).toEqual([
      STARTS_PAUSED_NOTICES.paused,
      STARTS_PAUSED_NOTICES.lifted,
    ]);
  });

  it("tries the lift again a minute later while the daemon schedules no work", async () => {
    park("DIPO-1", "worker-failed", true);
    paused.pausePlanLimit(id(w.office), planLimitPause({ credits: false }, now()));
    scheduling = false;
    w.t.clock.advance(PLAN_LIMIT_UNKNOWN_RESET_MS);
    await paused.idle();
    expect(paused.state(id(w.office))).not.toBeNull();
    scheduling = true;
    w.t.clock.advance(STARTS_PAUSED_RETRY_MS);
    await paused.idle();
    expect(paused.state(id(w.office))).toBeNull();
    expect(resumedParks()).toHaveLength(1);
  });

  it("lifts by hand in every office, the credits pause too (dipo daemon resume-scheduling)", async () => {
    const limited = park("DIPO-1", "worker-failed", true);
    paused.pausePlanLimit(id(w.office), planLimitPause({ credits: true }, now()));
    expect(paused.liftAll("the maintainer ran dipo daemon resume-scheduling")).toBe(2);
    await paused.idle();
    expect(paused.state(id(w.office))).toBeNull();
    expect(resumedParks()).toEqual([limited]);
    expect(noticesOf(w.office).at(-1)?.text).toContain("dipo daemon resume-scheduling");
  });

  it("tries a resume that cannot run yet again a minute later", async () => {
    park("DIPO-1", "worker-failed", true);
    answer = { outcome: "retry", why: "the worker has not exited" };
    paused.lift(id(w.office), "a test");
    await paused.idle();
    expect(resumedParks()).toHaveLength(1);
    answer = { outcome: "resumed" };
    w.t.clock.advance(STARTS_PAUSED_RETRY_MS);
    await paused.idle();
    expect(resumedParks()).toHaveLength(2);
  });

  it("leaves a refused park to the maintainer, with a notice, and never resumes it by itself again", async () => {
    const limited = park("DIPO-1", "worker-failed", true);
    answer = { outcome: "refused", why: "its caps are used up" };
    paused.lift(id(w.office), "a test");
    await paused.idle();
    expect(resumedParks()).toEqual([limited]);
    expect(
      w.office.get<{ resume_on_lift: number }>(
        "select resume_on_lift from parks where office_id = $office_id",
      )?.resume_on_lift,
    ).toBe(0);
    const notice = noticesOf(w.office).find(
      (entry) => entry.code === STARTS_PAUSED_NOTICES.notResumed,
    );
    expect(notice?.text).toContain("its caps are used up");
    expect(notice?.text).toContain("dipo resume DIPO-1");
    paused.lift(id(w.office), "a test");
    await paused.idle();
    expect(resumedParks()).toEqual([limited]);
  });
});

describe("after a restart (0020)", () => {
  it("pauses again until the lift time, then lifts; a pause whose time passed lifts at once", async () => {
    const limited = park("DIPO-1", "worker-failed", true);
    paused.pausePlanLimit(id(w.office), planLimitPause({ credits: false }, now()));
    const until = paused.state(id(w.office))?.until ?? 0;
    paused.close();

    paused = startsPaused();
    paused.recover(id(w.office), w.office);
    expect(paused.state(id(w.office))?.reason).toBe("plan-limit");
    w.t.clock.advanceTo(until);
    await paused.idle();
    expect(paused.state(id(w.office))).toBeNull();
    expect(resumedParks()).toEqual([limited]);
  });

  it("resumes the parks a plan limit left when the office is no longer paused at load", async () => {
    const limited = park("DIPO-1", "worker-failed", true);
    paused.recover(id(w.office), w.office);
    // After the load, on the clock.
    expect(resumedParks()).toEqual([]);
    w.t.clock.advance(0);
    await paused.idle();
    expect(resumedParks()).toEqual([limited]);
  });
});

describe("a failed adapter check (0020, 0008)", () => {
  it("pauses the starts with the hold's detail and time, and a passing check lifts it and resumes", async () => {
    const limited = park("DIPO-1", "worker-failed", true);
    w.t.clock.advance(5_000);
    await gateLaunch(ADAPTER, holds, async () => ({
      ok: false,
      failures: [{ check: "probe", detail: "claude is not logged in" }],
    }));
    const state = paused.state(id(w.office));
    expect(state).toMatchObject({ reason: "adapter", since: now(), until: null });
    expect(state?.detail).toBe(`${ADAPTER}: probe: claude is not logged in.`);
    expect(state?.lifts).toContain("dipo run <ID>");
    expect(paused.state(id(other))?.reason).toBe("adapter");
    // While paused nothing resumes, not even when a plan limit's pause lifts by itself.
    paused.pausePlanLimit(id(w.office), planLimitPause({ credits: false }, now()));
    w.t.clock.advance(PLAN_LIMIT_UNKNOWN_RESET_MS);
    await paused.idle();
    expect(paused.state(id(w.office))?.reason).toBe("adapter");
    expect(resumed).toEqual([]);

    await gateLaunch(ADAPTER, holds, async () => ({ ok: true }));
    await paused.idle();
    expect(paused.state(id(w.office))).toBeNull();
    expect(resumedParks()).toEqual([limited]);
  });

  it("keeps a sticky hold paused through the command until its own lift", () => {
    holds.hold(ADAPTER, [{ check: "box-token", detail: "the token was found in a box" }]);
    expect(paused.liftAll("the maintainer ran dipo daemon resume-scheduling")).toBe(0);
    expect(paused.state(id(w.office))?.lifts).toContain("dipo login box");
    holds.liftSticky(ADAPTER);
    expect(paused.state(id(w.office))).toBeNull();
  });
});
