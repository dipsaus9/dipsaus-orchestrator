// Reconcile closes a park Backlog.md no longer holds (DIPO-360). A run that stood open at In Review
// when it parked stands open at In Review again once the story is In Review (DIPO-373), so the
// review, the PR poll and the merge take it up; a run the park stopped stays parked.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { closePark } from "../../src/reconcile/reconcile";
import { endRun, findRun, openAtInReview, stopAtInReview } from "../../src/run";
import { reparkOpen } from "../../src/run/park-records";
import { insertPark } from "../run/park-fixture";
import {
  MINUTE,
  type RoundsWorld,
  roundsWorld,
  storyRun,
  type StoryRun,
} from "../run/rounds-helpers";

let w: RoundsWorld;
let s: StoryRun;

beforeEach(async () => {
  w = await roundsWorld("close-park-");
  s = storyRun(w, { story: "DIPO-7" });
});

afterEach(() => w.close());

const now = (): number => w.t.clock.now();

/** Parks the story now; its run waited at In Review since a minute before when `waited`. */
function park(waited: boolean): number {
  return w.office.immediate(() => {
    if (waited) stopAtInReview(w.office, s.run, now() - MINUTE);
    const parkId = insertPark(w.office, {
      key: s.key,
      story: "DIPO-7",
      runId: s.run,
      reason: "by-maintainer",
      from: "In Review",
      detail: "later",
      at: now(),
    });
    endRun(w.office, s.run, now(), "parked");
    return parkId;
  });
}

const close = (parkId: number, lifecycle: string) =>
  w.office.immediate(() => closePark(w.office, { lifecycle }, parkId, now() + MINUTE));

describe("closePark (DIPO-373)", () => {
  it("returns a run that waited at In Review to In Review when the story is In Review again", () => {
    const parkId = park(true);
    close(parkId, "In Review");
    const run = findRun(w.office, s.run)!;
    expect(run.ending).toBeNull();
    expect(openAtInReview(run)).toBe(true);
    expect(run.endedAt).toBe(now() - MINUTE);
  });

  it("leaves the run parked when the story is not In Review", () => {
    const parkId = park(true);
    close(parkId, "In Progress");
    expect(findRun(w.office, s.run)?.ending).toBe("parked");
  });

  it("leaves a run the park stopped parked", () => {
    const parkId = park(false);
    close(parkId, "In Review");
    expect(findRun(w.office, s.run)?.ending).toBe("parked");
  });

  it("reads a park written again at its first time, so a run it stopped stays parked", () => {
    const parkId = park(false);
    w.t.clock.advance(MINUTE);
    w.office.immediate(() =>
      reparkOpen(w.office, parkId, {
        reason: "by-maintainer",
        detail: "again",
        lastGoodCommit: null,
      }),
    );
    expect(
      w.office.get<{ at: number }>("select at from parks where office_id = $office_id", {})?.at,
    ).toBe(now() - MINUTE);
    close(parkId, "In Review");
    expect(findRun(w.office, s.run)?.ending).toBe("parked");
  });
});
